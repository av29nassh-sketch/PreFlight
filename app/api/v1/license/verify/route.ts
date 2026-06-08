import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  RepositoryMetadataSchema,
  findOrganizationForRepository,
  isActiveLicense,
  licenseAllowsRepository,
  resolveActiveLicenseKey
} from "../../../../../lib/control-plane";
import { prisma } from "../../../../../lib/prisma";

export const runtime = "nodejs";

const LicenseVerifyRequestSchema = z.object({
  licenseKey: z.string().trim().min(1).max(512),
  workspace: RepositoryMetadataSchema,
  cliVersion: z.string().trim().max(80).optional(),
  machineId: z.string().trim().max(160).optional()
});

export async function POST(req: NextRequest) {
  let body: unknown;

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ allowed: false, reason: "Invalid JSON request body." }, { status: 400 });
  }

  const parsed = LicenseVerifyRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { allowed: false, reason: "Invalid license verification payload." },
      { status: 400 }
    );
  }

  const license = await resolveActiveLicenseKey(parsed.data.licenseKey);
  if (!isActiveLicense(license)) {
    return NextResponse.json(
      { allowed: false, status: "invalid", reason: "License key is inactive, revoked, or unknown." },
      { status: 401 }
    );
  }

  const { repository, organization } = await findOrganizationForRepository(parsed.data.workspace);
  const guardrail = licenseAllowsRepository({ license: license!, repository, organization });

  if (!guardrail.allowed) {
    return NextResponse.json(
      {
        allowed: false,
        status: "blocked",
        reason: guardrail.reason,
        tier: license!.tier.toLowerCase(),
        repository
      },
      { status: guardrail.status }
    );
  }

  const updatedLicense = await prisma.licenseKey.update({
    where: { id: license!.id },
    data: {
      usageCount: { increment: 1 },
      lastUsedAt: new Date()
    },
    select: {
      id: true,
      tier: true,
      status: true,
      usageCount: true,
      seats: true,
      organizationId: true,
      expiresAt: true
    }
  });

  return NextResponse.json({
    allowed: true,
    status: "active",
    reason: guardrail.reason,
    tier: updatedLicense.tier.toLowerCase(),
    license: {
      id: updatedLicense.id,
      status: updatedLicense.status.toLowerCase(),
      usageCount: updatedLicense.usageCount,
      seats: updatedLicense.seats,
      organizationId: updatedLicense.organizationId,
      expiresAt: updatedLicense.expiresAt
    },
    repository,
    organization: organization
      ? {
          id: organization.id,
          name: organization.name,
          slug: organization.slug
        }
      : null
  });
}
