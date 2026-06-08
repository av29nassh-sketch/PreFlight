import { cookies, headers } from "next/headers";
import { DriftTimelineChart } from "../../components/dashboard/drift-timeline-chart";
import { SeverityDonutChart } from "../../components/dashboard/severity-donut-chart";
import { StatCard } from "../../components/dashboard/stat-card";
import { TopRulesTable } from "../../components/dashboard/top-rules-table";
import { prisma } from "../../lib/prisma";

type TelemetryRecord = {
  ruleId: string;
  severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  state: "RED" | "YELLOW" | "GREEN";
  repoName: string;
  createdAt: Date;
};

const severityColors = {
  Red: "#f43f5e",
  Yellow: "#f59e0b",
  Green: "#14b8a6"
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

export default async function DashboardPage() {
  const organizationId = await getCurrentOrganizationId();
  const today = startOfDay(new Date());
  const startDate = new Date(today);
  startDate.setDate(today.getDate() - 29);

  const [organization, telemetry] = organizationId
    ? await Promise.all([
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
      ])
    : [null, []];

  const records = telemetry as TelemetryRecord[];
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
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="border-b border-zinc-800 bg-zinc-950/90">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-8 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="text-xs font-medium uppercase tracking-[0.18em] text-teal-300">PreFlight Governance</div>
            <h1 className="mt-3 text-3xl font-semibold tracking-normal text-zinc-50">Security Drift Dashboard</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-400">
              Thirty-day visibility into AI-generated code drift intercepted across local terminals, CI pipelines, and MCP loops.
            </p>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
            <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Organization</div>
            <div className="mt-1 text-sm font-medium text-zinc-100">{organization?.name || "No organization selected"}</div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl space-y-6 px-6 py-6">
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

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(360px,0.75fr)]">
          <DriftTimelineChart data={timeline} />
          <SeverityDonutChart data={severityData} />
        </div>

        <TopRulesTable rows={topRules} />
      </div>
    </main>
  );
}
