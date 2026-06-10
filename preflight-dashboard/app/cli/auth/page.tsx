import { randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { LicenseStatus } from "@prisma/client";
import { hashLicenseToken } from "../../../lib/control-plane";
import { prisma } from "../../../lib/prisma";

export const runtime = "nodejs";

type SearchParams = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function parseCallbackPort(value: string | string[] | undefined) {
  const port = Number(firstParam(value));
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

async function resolveAuthenticatedEmail() {
  const headerStore = await headers();
  const cookieStore = await cookies();

  return (
    headerStore.get("x-preflight-user-email") ||
    headerStore.get("x-user-email") ||
    cookieStore.get("preflight_user_email")?.value ||
    null
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-16 text-zinc-100">
      <section className="mx-auto max-w-xl rounded-lg border border-zinc-800 bg-zinc-900/80 p-8 shadow-2xl shadow-black/30">
        {children}
      </section>
    </main>
  );
}

function SecondaryLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      className="mt-6 inline-flex h-11 items-center justify-center rounded-md border border-zinc-700 px-4 text-sm font-medium text-zinc-100 transition hover:border-zinc-500 hover:bg-zinc-800"
      href={href}
    >
      {children}
    </a>
  );
}

export default async function CliAuthPage({
  searchParams
}: {
  searchParams?: Promise<SearchParams> | SearchParams;
}) {
  const params = await Promise.resolve(searchParams || {});
  const port = parseCallbackPort(params.port);
  const state = firstParam(params.state);

  if (!port) {
    return (
      <Shell>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-red-300">PreFlight CLI</p>
        <h1 className="mt-3 text-2xl font-semibold">Invalid callback port</h1>
        <p className="mt-3 text-sm leading-6 text-zinc-400">
          Run <span className="font-mono text-zinc-200">preflight login</span> again from your terminal.
        </p>
      </Shell>
    );
  }

  const email = await resolveAuthenticatedEmail();
  if (!email) {
    return (
      <Shell>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-400">PreFlight CLI</p>
        <h1 className="mt-3 text-2xl font-semibold">Sign in to authorize the CLI</h1>
        <p className="mt-3 text-sm leading-6 text-zinc-400">
          Your browser session needs an authenticated PreFlight dashboard account before this device can receive a license token.
        </p>
        <SecondaryLink href="/login">Sign in</SecondaryLink>
      </Shell>
    );
  }

  const user = await prisma.user.findUnique({
    where: { email },
    include: {
      licenseKeys: {
        where: { status: LicenseStatus.ACTIVE },
        orderBy: { createdAt: "desc" },
        take: 1
      },
      organization: {
        include: {
          licenseKeys: {
            where: { status: LicenseStatus.ACTIVE },
            orderBy: { createdAt: "desc" },
            take: 1
          }
        }
      }
    }
  });
  const activeLicense = user?.licenseKeys[0] || user?.organization?.licenseKeys[0] || null;

  if (!user || !activeLicense) {
    return (
      <Shell>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-300">PreFlight CLI</p>
        <h1 className="mt-3 text-2xl font-semibold">Upgrade required</h1>
        <p className="mt-3 text-sm leading-6 text-zinc-400">
          This account does not have an active PreFlight license. Upgrade through Polar, then run the CLI login flow again.
        </p>
        <SecondaryLink href="/dashboard/billing">View billing</SecondaryLink>
      </Shell>
    );
  }

  const token = `pf_${randomBytes(32).toString("hex")}`;
  await prisma.licenseKey.create({
    data: {
      label: "CLI browser login",
      organizationId: activeLicense.organizationId || user.organizationId,
      seats: activeLicense.seats,
      status: LicenseStatus.ACTIVE,
      tier: activeLicense.tier,
      tokenHash: hashLicenseToken(token),
      userId: user.id
    }
  });

  const callbackUrl = new URL("/callback", `http://localhost:${port}`);
  callbackUrl.searchParams.set("token", token);
  if (state) {
    callbackUrl.searchParams.set("state", state);
  }

  return (
    <Shell>
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-300">PreFlight CLI</p>
      <h1 className="mt-3 text-2xl font-semibold">Authorize this device</h1>
      <p className="mt-3 text-sm leading-6 text-zinc-400">
        This will save a local PreFlight license token for scans from your terminal. The CLI stores it in your home directory with restricted file permissions.
      </p>
      <a
        className="mt-6 inline-flex h-11 items-center justify-center rounded-md bg-emerald-400 px-4 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-300"
        href={callbackUrl.toString()}
      >
        Click here to authorize CLI
      </a>
    </Shell>
  );
}
