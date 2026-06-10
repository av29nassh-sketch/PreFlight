import { cookies, headers } from "next/headers";
import { DriftTimelineChart } from "../../components/dashboard/drift-timeline-chart";
import { SeverityDonutChart } from "../../components/dashboard/severity-donut-chart";
import { StatCard } from "../../components/dashboard/stat-card";
import { TopRulesTable } from "../../components/dashboard/top-rules-table";
import { prisma } from "../../lib/prisma";

export const dynamic = "force-dynamic";

type TelemetryRecord = {
  ruleId: string;
  severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  state: "RED" | "YELLOW" | "GREEN";
  repoName: string;
  createdAt: Date;
};

type DashboardDatabaseState = {
  organization: { id: string; name: string; slug: string } | null;
  telemetry: TelemetryRecord[];
  databaseError: string | null;
};

const severityColors = {
  Red: "#fb7185",
  Yellow: "#fbbf24",
  Green: "#67e8f9"
};

async function getCurrentOrganizationId() {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const authenticatedEmail =
    headerStore.get("x-preflight-user-email") ||
    headerStore.get("x-user-email") ||
    cookieStore.get("preflight_user_email")?.value ||
    null;

  if (authenticatedEmail) {
    const user = await prisma.user.findUnique({
      where: { email: authenticatedEmail },
      select: { organizationId: true }
    });

    if (user?.organizationId) {
      return user.organizationId;
    }
  }

  return (
    cookieStore.get("preflight_org_id")?.value ||
    headerStore.get("x-preflight-org-id") ||
    null
  );
}

function startOfDay(date: Date) {
  const nextDate = new Date(date);
  nextDate.setHours(0, 0, 0, 0);
  return nextDate;
}

function formatDayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function formatDayLabel(date: Date) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric"
  }).format(date);
}

function stateFor(record: TelemetryRecord) {
  if (record.state === "RED" || record.severity === "CRITICAL") {
    return "RED";
  }

  if (record.state === "YELLOW" || record.severity === "HIGH" || record.severity === "MEDIUM") {
    return "YELLOW";
  }

  return "GREEN";
}

function buildTimeline(records: TelemetryRecord[], startDate: Date) {
  const buckets = new Map<string, { date: string; label: string; red: number; yellow: number; total: number }>();

  for (let offset = 0; offset < 30; offset += 1) {
    const date = new Date(startDate);
    date.setDate(startDate.getDate() + offset);
    const key = formatDayKey(date);
    buckets.set(key, {
      date: key,
      label: formatDayLabel(date),
      red: 0,
      yellow: 0,
      total: 0
    });
  }

  for (const record of records) {
    const key = formatDayKey(record.createdAt);
    const bucket = buckets.get(key);
    if (!bucket) {
      continue;
    }

    const state = stateFor(record);
    if (state === "RED") {
      bucket.red += 1;
      bucket.total += 1;
    } else if (state === "YELLOW") {
      bucket.yellow += 1;
      bucket.total += 1;
    }
  }

  return Array.from(buckets.values());
}

function buildTopRules(records: TelemetryRecord[]) {
  const rows = new Map<string, { ruleId: string; count: number; red: number; yellow: number; lastSeen: Date }>();

  for (const record of records) {
    const state = stateFor(record);
    if (state === "GREEN") {
      continue;
    }

    const current = rows.get(record.ruleId) || {
      ruleId: record.ruleId,
      count: 0,
      red: 0,
      yellow: 0,
      lastSeen: record.createdAt
    };

    current.count += 1;
    current.red += state === "RED" ? 1 : 0;
    current.yellow += state === "YELLOW" ? 1 : 0;
    current.lastSeen = record.createdAt > current.lastSeen ? record.createdAt : current.lastSeen;
    rows.set(record.ruleId, current);
  }

  return Array.from(rows.values())
    .sort((a, b) => b.count - a.count || b.lastSeen.getTime() - a.lastSeen.getTime())
    .slice(0, 8)
    .map((row) => ({
      ...row,
      lastSeen: formatDayLabel(row.lastSeen)
    }));
}

function dashboardDatabaseError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "Dashboard database connection failed.";
}

async function loadDashboardData(organizationId: string | null, startDate: Date): Promise<DashboardDatabaseState> {
  if (!organizationId) {
    return {
      organization: null,
      telemetry: [],
      databaseError: null
    };
  }

  try {
    const [organization, telemetry] = await Promise.all([
      prisma.organization.findUnique({
        where: { id: organizationId },
        select: { id: true, name: true, slug: true }
      }),
      prisma.vulnerabilityTelemetry.findMany({
        where: {
          organizationId,
          createdAt: {
            gte: startDate
          }
        },
        select: {
          ruleId: true,
          severity: true,
          state: true,
          repoName: true,
          createdAt: true
        },
        orderBy: {
          createdAt: "asc"
        }
      })
    ]);

    return {
      organization,
      telemetry: telemetry as TelemetryRecord[],
      databaseError: null
    };
  } catch (error) {
    console.error("PreFlight dashboard database query failed", error);

    return {
      organization: null,
      telemetry: [],
      databaseError: dashboardDatabaseError(error)
    };
  }
}

export default async function DashboardPage() {
  const today = startOfDay(new Date());
  const startDate = new Date(today);
  startDate.setDate(today.getDate() - 29);
  let organizationId: string | null = null;
  let databaseError: string | null = null;

  try {
    organizationId = await getCurrentOrganizationId();
  } catch (error) {
    console.error("PreFlight dashboard organization lookup failed", error);
    databaseError = dashboardDatabaseError(error);
  }

  const dashboardData = await loadDashboardData(organizationId, startDate);
  const organization = dashboardData.organization;
  const records = dashboardData.telemetry;
  databaseError = databaseError || dashboardData.databaseError;
  const redCount = records.filter((record) => stateFor(record) === "RED").length;
  const yellowCount = records.filter((record) => stateFor(record) === "YELLOW").length;
  const greenCount = records.filter((record) => stateFor(record) === "GREEN").length;
  const totalIntercepts = redCount + yellowCount;
  const activeRepos = new Set(records.map((record) => record.repoName).filter(Boolean)).size;
  const timeline = buildTimeline(records, startDate);
  const topRules = buildTopRules(records);
  const severityData = [
    { name: "Red" as const, value: redCount, color: severityColors.Red },
    { name: "Yellow" as const, value: yellowCount, color: severityColors.Yellow },
    { name: "Green" as const, value: greenCount, color: severityColors.Green }
  ];

  return (
    <main className="relative min-h-screen overflow-hidden bg-neutral-950 text-zinc-100">
      <div className="technical-grid pointer-events-none fixed inset-0" />
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(34,211,238,0.13),transparent_34%),linear-gradient(to_bottom,rgba(9,9,11,0.52),#09090b_68%)]" />

      <div className="relative z-10 border-b border-zinc-800/80 bg-zinc-950/55 backdrop-blur-xl">
        <nav className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
          <a className="font-mono text-sm font-semibold uppercase tracking-[0.2em] text-cyan-300" href="/">
            PreFlight
          </a>
          <div className="flex items-center gap-3 text-sm text-zinc-400">
            <a className="rounded-md px-3 py-2 transition-colors duration-200 hover:bg-zinc-900 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300" href="/">
              Home
            </a>
            <a className="rounded-md border border-cyan-300/30 bg-cyan-300/10 px-3 py-2 text-cyan-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300" href="/dashboard" aria-current="page">
              Dashboard
            </a>
          </div>
        </nav>

        <div className="mx-auto flex max-w-7xl flex-col gap-5 px-6 pb-8 pt-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">
              PreFlight Governance
            </div>
            <h1 className="mt-5 text-4xl font-semibold leading-tight tracking-normal text-zinc-50 md:text-5xl">Security Drift Dashboard</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-400">
              Thirty-day visibility into AI-generated code drift intercepted across local terminals, CI pipelines, and MCP loops.
            </p>
          </div>
          <div className="rounded-lg border border-cyan-300/20 bg-zinc-900/75 px-4 py-3 shadow-[0_20px_80px_rgba(34,211,238,0.08)]">
            <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Organization</div>
            <div className="mt-1 text-sm font-medium text-zinc-100">{organization?.name || "No organization selected"}</div>
          </div>
        </div>
      </div>

      <div className="relative z-10 mx-auto max-w-7xl space-y-6 px-6 py-6">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Total Intercepts" value={totalIntercepts.toLocaleString()} helper="Red and yellow findings stopped before merge." />
          <StatCard label="Red Blocks" value={redCount.toLocaleString()} helper="Confirmed flaws requiring remediation." tone="red" />
          <StatCard label="Yellow Reviews" value={yellowCount.toLocaleString()} helper="Runtime-sensitive drift requiring QA." tone="yellow" />
          <StatCard label="Active Repos" value={activeRepos.toLocaleString()} helper="Repositories reporting telemetry this month." tone="green" />
        </div>

        {!organizationId ? (
          <section className="rounded-lg border border-amber-900/60 bg-amber-950/20 p-5 text-sm leading-6 text-amber-100">
            Connect an authenticated organization context to load governance telemetry.
          </section>
        ) : null}

        {databaseError ? (
          <section className="rounded-lg border border-rose-900/60 bg-rose-950/25 p-5 text-sm leading-6 text-rose-100">
            <div className="font-semibold text-rose-200">Dashboard database is not reachable.</div>
            <p className="mt-2 text-rose-100/85">
              PreFlight could not load telemetry from the server database. Verify the Vercel `DATABASE_URL` points to the Supabase pooled
              connection string for this project and that the schema has been migrated.
            </p>
          </section>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(360px,0.75fr)]">
          <DriftTimelineChart data={timeline} />
          <SeverityDonutChart data={severityData} />
        </div>

        <TopRulesTable rows={topRules} />
      </div>
    </main>
  );
}
