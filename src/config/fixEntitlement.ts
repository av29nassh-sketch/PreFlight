import { resolveLicenseKey as resolveStoredOrEnvLicenseKey } from "./auth";

const {
  recordFreeFixUsage,
  verifyFixPermission
} = require("../licensing/licenseManager");

export const FREE_FIX_PROXY_TOKEN = "PREFLIGHT-FREE-FIX";

export interface FixEntitlement {
  tier: string;
  isFree: boolean;
  remaining?: number;
  licenseKey: string;
}

export async function resolveFixEntitlement(cwd = process.cwd()): Promise<FixEntitlement> {
  const permission = await verifyFixPermission({ cwd });
  if (!permission?.allowed) {
    throw new Error(permission?.message || "PreFlight fix permission denied.");
  }

  const configuredKey = await resolveStoredOrEnvLicenseKey();
  if (configuredKey) {
    return {
      tier: permission.tier || "pro",
      isFree: false,
      remaining: permission.remaining,
      licenseKey: configuredKey
    };
  }

  return {
    tier: "free",
    isFree: true,
    remaining: permission.remaining,
    licenseKey: FREE_FIX_PROXY_TOKEN
  };
}

export async function recordFreeFixUsageIfNeeded(entitlement: FixEntitlement): Promise<void> {
  if (entitlement.isFree) {
    await recordFreeFixUsage();
  }
}

export function buildFixAuthHeaders(entitlement: FixEntitlement): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${entitlement.licenseKey}`
  };

  if (entitlement.isFree) {
    headers["X-PreFlight-Free-Fix"] = "1";
    return headers;
  }

  headers["X-PreFlight-Pro-Key"] = entitlement.licenseKey;
  return headers;
}
