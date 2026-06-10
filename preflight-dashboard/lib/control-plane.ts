import { createHash } from "node:crypto";
import type { LicenseKey, Organization } from "@prisma/client";
import { LicenseStatus, LicenseTier } from "@prisma/client";
import { z } from "zod";
import { prisma } from "./prisma";

export const ORG_ACCOUNT_DETECTED_MESSAGE =
  "🔴 Org Account Detected: Enterprise repositories require a PreFlight Teams seat. Please upgrade your license or contact your administrator.";

export const RepositoryMetadataSchema = z.object({
  remoteUrl: z.string().trim().max(500).optional(),
  host: z.string().trim().max(120).optional(),
  owner: z.string().trim().max(160).optional(),
  repo: z.string().trim().max(220).optional(),
  isOrganization: z.boolean().optional(),
  personalGitOwner: z.string().trim().max(160).optional()
}).default({});

export type RepositoryMetadata = z.infer<typeof RepositoryMetadataSchema>;

export function hashLicenseToken(token: string): string {
  return createHash("sha256").update(token.trim(), "utf8").digest("hex");
}

export function parseRepositoryRemote(remoteUrl?: string | null) {
  const normalizedRemote = typeof remoteUrl === "string" ? remoteUrl.trim() : "";
  if (!normalizedRemote) {
    return null;
  }

  const scpLike = normalizedRemote.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/i);
  if (scpLike) {
    return {
      host: scpLike[1].toLowerCase(),
      owner: scpLike[2],
      repo: scpLike[3].replace(/\.git$/i, ""),
      remoteUrl: normalizedRemote
    };
  }

  try {
    const parsed = new URL(normalizedRemote);
    const segments = parsed.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
    if (segments.length < 2) {
      return null;
    }

    return {
      host: parsed.hostname.toLowerCase(),
      owner: segments[0],
      repo: segments[segments.length - 1].replace(/\.git$/i, ""),
      remoteUrl: normalizedRemote
    };
  } catch {
    return null;
  }
}

export function normalizeRepositoryMetadata(workspace: RepositoryMetadata = {}) {
  const parsedRemote = parseRepositoryRemote(workspace.remoteUrl);
  const owner = workspace.owner || parsedRemote?.owner || null;
  const repo = workspace.repo || parsedRemote?.repo || null;
  const host = workspace.host || parsedRemote?.host || null;
  const personalOwner = workspace.personalGitOwner || null;
  const ownerIsPersonal =
    owner && personalOwner && owner.toLowerCase() === personalOwner.toLowerCase();

  return {
    host,
    owner,
    repo,
    remoteUrl: workspace.remoteUrl || parsedRemote?.remoteUrl || null,
    personalGitOwner: personalOwner,
    isOrganization: Boolean(workspace.isOrganization || (owner && personalOwner && !ownerIsPersonal))
  };
}

export async function findOrganizationForRepository(workspace: RepositoryMetadata = {}) {
  const repository = normalizeRepositoryMetadata(workspace);
  const owner = repository.owner?.toLowerCase();
  if (!owner) {
    return { repository, organization: null as Organization | null };
  }

  const organization = await prisma.organization.findFirst({
    where: {
      OR: [
        { githubOrgs: { has: owner } },
        { githubOrgs: { has: repository.owner || owner } },
        { gitlabGroups: { has: owner } },
        { gitlabGroups: { has: repository.owner || owner } },
        { slug: owner }
      ]
    }
  });

  return {
    repository: {
      ...repository,
      isOrganization: repository.isOrganization || Boolean(organization)
    },
    organization
  };
}

export async function resolveActiveLicenseKey(licenseKey: string) {
  const token = licenseKey.trim();
  if (!token) {
    return null;
  }

  return prisma.licenseKey.findUnique({
    where: { tokenHash: hashLicenseToken(token) },
    include: { organization: true, user: true }
  });
}

export function isActiveLicense(
  license: (LicenseKey & { organization?: Organization | null }) | null
) {
  return Boolean(license && license.status === LicenseStatus.ACTIVE);
}

export function licenseAllowsRepository({
  license,
  repository,
  organization
}: {
  license: LicenseKey & { organization?: Organization | null };
  repository: ReturnType<typeof normalizeRepositoryMetadata>;
  organization: Organization | null;
}) {
  if (repository.isOrganization && license.tier === LicenseTier.SOLO) {
    return {
      allowed: false,
      status: 403,
      reason: ORG_ACCOUNT_DETECTED_MESSAGE
    };
  }

  if (
    repository.isOrganization &&
    license.tier !== LicenseTier.SOLO &&
    license.organizationId &&
    organization?.id &&
    license.organizationId !== organization.id
  ) {
    return {
      allowed: false,
      status: 403,
      reason: "License does not belong to the organization that owns this repository."
    };
  }

  return {
    allowed: true,
    status: 200,
    reason: "License verified."
  };
}
