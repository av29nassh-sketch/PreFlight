import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CONFIG_DIR = ".preflight";
const CONFIG_FILE = "config.json";
const DEFAULT_AUTH_VALIDATE_ENDPOINT = "https://preflight-vibe.vercel.app/api/v1/remediation";

interface PreFlightAuthConfig {
  licenseKey?: string | null;
  activatedAt?: string;
}

export function getPreflightHome(): string {
  return process.env.PREFLIGHT_HOME && process.env.PREFLIGHT_HOME.trim()
    ? process.env.PREFLIGHT_HOME.trim()
    : os.homedir();
}

export function getConfigPath(homeDir = getPreflightHome()): string {
  return path.join(homeDir, CONFIG_DIR, CONFIG_FILE);
}

async function readAuthConfig(): Promise<PreFlightAuthConfig> {
  try {
    const raw = await fs.readFile(getConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as PreFlightAuthConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

async function writeAuthConfig(config: PreFlightAuthConfig): Promise<void> {
  const configPath = getConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await fs.chmod(configPath, 0o600).catch(() => {});
}

export async function readStoredLicenseKey(): Promise<string | null> {
  const config = await readAuthConfig();
  const key = typeof config.licenseKey === "string" ? config.licenseKey.trim() : "";
  return key || null;
}

export async function saveLicenseKey(licenseKey: string): Promise<void> {
  const normalizedKey = licenseKey.trim();
  if (!normalizedKey) {
    throw new Error("A PreFlight Pro license key is required.");
  }

  const currentConfig = await readAuthConfig();
  await writeAuthConfig({
    ...currentConfig,
    licenseKey: normalizedKey,
    activatedAt: new Date().toISOString()
  });
}

export async function resolveLicenseKey(): Promise<string | null> {
  const envKey = (process.env.PREFLIGHT_PRO_KEY || process.env.PREFLIGHT_PRO_LICENSE_KEY || "").trim();
  return envKey || (await readStoredLicenseKey());
}

export function getAuthValidateEndpoint(): string {
  return (
    process.env.PREFLIGHT_AUTH_VALIDATE_ENDPOINT ||
    process.env.PREFLIGHT_REMEDIATION_ENDPOINT ||
    process.env.PREFLIGHT_PROXY_ENDPOINT ||
    DEFAULT_AUTH_VALIDATE_ENDPOINT
  ).trim();
}

export async function validateLicenseKey(licenseKey: string): Promise<boolean> {
  const normalizedKey = licenseKey.trim();
  if (!normalizedKey) {
    return false;
  }

  const response = await fetch(getAuthValidateEndpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${normalizedKey}`,
      "X-PreFlight-Pro-Key": normalizedKey
    },
    body: JSON.stringify({
      validationOnly: true,
      filePath: "__preflight_auth_check__",
      sourceCode: "",
      vulnerabilityType: "LICENSE_VALIDATION",
      breakingPayload: "",
      executionTrail: []
    })
  });

  return response.ok;
}
