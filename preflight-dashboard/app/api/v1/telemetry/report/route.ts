import { NextRequest, NextResponse } from "next/server";
import { FindingSeverity, FindingState, Prisma } from "@prisma/client";
import { z } from "zod";
import {
  RepositoryMetadataSchema,
  findOrganizationForRepository,
  isActiveLicense,
  resolveActiveLicenseKey
} from "../../../../../lib/control-plane";
import { prisma } from "../../../../../lib/prisma";

export const runtime = "nodejs";

const TelemetryFindingSchema = z.object({
  ruleId: z.string().trim().min(1).max(160),
  severity: z.string().trim().min(1).max(40),
  state: z.string().trim().min(1).max(40),
  filePath: z.string().trim().min(1).max(600),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const TelemetryReportRequestSchema = z.object({
  licenseKey: z.string().trim().min(1).max(512),
  workspace: RepositoryMetadataSchema,
  findings: z.array(TelemetryFindingSchema).min(1).max(100),
  source: z.enum(["cli", "ci", "mcp"]).default("cli"),
  cliVersion: z.string().trim().max(80).optional(),
  branch: z.string().trim().max(200).optional(),
  commitSha: z.string().trim().max(80).optional()
});

function normalizeSeverity(value: string): FindingSeverity {
  const normalized = value.trim().toUpperCase();
  if (normalized === "WARNING" || normalized === "WARN") {
    return FindingSeverity.MEDIUM;
  }
  if (normalized in FindingSeverity) {
    return FindingSeverity[normalized as keyof typeof FindingSeverity];
  }
  return FindingSeverity.INFO;
}

function normalizeState(value: string): FindingState {
  const normalized = value.trim().toUpperCase();
  if (normalized in FindingState) {
    return FindingState[normalized as keyof typeof FindingState];
  }
  return FindingState.YELLOW;
}

function normalizeMetadata(value: Record<string, unknown> | undefined): Prisma.InputJsonValue | undefined {
  if (!value) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function POST(req: NextRequest) {
  let body: unknown;

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ accepted: false, reason: "Invalid JSON request body." }, { status: 400 });
  }

  const parsed = TelemetryReportRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { accepted: false, reason: "Invalid telemetry payload." },
      { status: 400 }
    );
  }

  const license = await resolveActiveLicenseKey(parsed.data.licenseKey);
  if (!isActiveLicense(license)) {
    return NextResponse.json(
      { accepted: false, reason: "Telemetry requires an active license key." },
      { status: 401 }
    );
  }

  const { repository, organization } = await findOrganizationForRepository(parsed.data.workspace);
  const organizationId = license!.organizationId || organization?.id || null;
  const repoName = repository.repo || "unknown";

  await prisma.vulnerabilityTelemetry.createMany({
    data: parsed.data.findings.map((finding) => ({
      repoName,
      repoOwner: repository.owner,
      remoteHost: repository.host,
      ruleId: finding.ruleId,
      severity: normalizeSeverity(finding.severity),
      filePath: finding.filePath,
      state: normalizeState(finding.state),
      source: parsed.data.source,
      cliVersion: parsed.data.cliVersion,
      branch: parsed.data.branch,
      commitSha: parsed.data.commitSha,
      metadata: normalizeMetadata(finding.metadata),
      licenseKeyId: license!.id,
      organizationId
    }))
  });

  await prisma.licenseKey.update({
    where: { id: license!.id },
    data: {
      usageCount: { increment: 1 },
      lastUsedAt: new Date()
    }
  });

  return NextResponse.json({
    accepted: true,
    count: parsed.data.findings.length,
    repository,
    organizationId
  });
}
