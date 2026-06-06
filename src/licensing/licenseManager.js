const fs = require("node:fs");
const { execSync: defaultExecSync } = require("node:child_process");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const chalk = require("chalk");

const CONFIG_DIR = ".preflight";
const CONFIG_FILE = "config.json";
const FREE_FIX_LIMIT = 5;
const LEMON_SQUEEZY_ACTIVATE_URL = "https://api.lemonsqueezy.com/v1/licenses/activate";
const LEMON_SQUEEZY_VALIDATE_URL = "https://api.lemonsqueezy.com/v1/licenses/validate";
const FREE_FIXES_EXHAUSTED_MESSAGE =
  "\u26a0\ufe0f Free fixes exhausted (5/5). Upgrade to PreFlight Pro for unlimited AI auto-fixes for a one-time payment of $49 / \u20b91999: https://yourwebsite.com/buy";
const INVALID_LICENSE_MESSAGE =
  "\u274c License is inactive or invalid. Please run 'preflight activate <key>' with a valid key.";
const ACTIVATION_MESSAGE = "\u2705 PreFlight Pro activated successfully! Unlimited AI auto-fixes unlocked.";
const EMAIL_MISMATCH_MESSAGE = "\u274c Email does not match the purchase record.";
const ENTERPRISE_CONTEXT_WARNING =
  "🟡 Enterprise Context Detected. This repository belongs to an organization workspace but is running via a Solo/Free seat. Please run 'preflight upgrade' or contact your administrator to provision a Team license.";
const OFFLINE_ERROR_CODES = new Set(["EAI_AGAIN", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "ENOTFOUND", "ECONNREFUSED"]);
const TEAM_LICENSE_TIERS = new Set(["team", "teams", "enterprise", "organization", "org"]);
const SOLO_LICENSE_TIERS = new Set(["free", "solo", "pro", "personal", "individual"]);
const ENTERPRISE_OWNER_PATTERNS = [
  /(?:^|[-_])(corp|company|enterprise|eng|engineering|team|teams|platform|labs|studio|agency|systems)(?:$|[-_])/i,
  /(?:inc|llc|ltd|gmbh|plc)$/i
];

function getConfigPath(homeDir = os.homedir()) {
  return path.join(homeDir, CONFIG_DIR, CONFIG_FILE);
}

function defaultConfig() {
  return {
    freeFixesUsed: 0,
    licenseKey: null,
    instanceId: null
  };
}

function normalizeConfig(config = {}) {
  const freeFixesUsed = Number.isInteger(config.freeFixesUsed) && config.freeFixesUsed > 0 ? config.freeFixesUsed : 0;
  const licenseKey = typeof config.licenseKey === "string" && config.licenseKey.trim() ? config.licenseKey.trim() : null;
  const instanceId = typeof config.instanceId === "string" && config.instanceId.trim() ? config.instanceId.trim() : null;

  return {
    freeFixesUsed,
    licenseKey,
    instanceId
  };
}

async function readConfig(options = {}) {
  const configPath = getConfigPath(options.homeDir);

  try {
    const raw = await fs.promises.readFile(configPath, "utf8");
    return normalizeConfig(JSON.parse(raw));
  } catch (error) {
    if (error.code === "ENOENT") {
      return defaultConfig();
    }

    throw error;
  }
}

async function writeConfig(config, options = {}) {
  const configPath = getConfigPath(options.homeDir);
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  await fs.promises.writeFile(configPath, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

function postFormUrlEncoded(request) {
  const body = request.body || "";
  const url = new URL(request.url || LEMON_SQUEEZY_VALIDATE_URL);

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body)
        }
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(responseBody || "{}"));
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function isOfflineError(error) {
  return OFFLINE_ERROR_CODES.has(error?.code);
}

function freePermission(config) {
  if (config.freeFixesUsed < FREE_FIX_LIMIT) {
    return {
      allowed: true,
      tier: "free",
      remaining: FREE_FIX_LIMIT - config.freeFixesUsed
    };
  }

  return {
    allowed: false,
    tier: "free",
    message: FREE_FIXES_EXHAUSTED_MESSAGE
  };
}

async function verifyFixPermission(options = {}) {
  const config = await readConfig(options);

  if (config.licenseKey) {
    const payload = {
      license_key: config.licenseKey
    };
    if (config.instanceId) {
      payload.instance_id = config.instanceId;
    }
    const body = new URLSearchParams(payload).toString();
    const requestLicenseValidation = options.requestLicenseValidation || postFormUrlEncoded;

    try {
      const result = await requestLicenseValidation({
        url: LEMON_SQUEEZY_VALIDATE_URL,
        body
      });

      if (result?.valid) {
        return { allowed: true, tier: "pro" };
      }

      await writeConfig(
        {
          ...config,
          licenseKey: null,
          instanceId: null
        },
        options
      );
      return {
        allowed: false,
        tier: "pro",
        message: INVALID_LICENSE_MESSAGE
      };
    } catch (error) {
      if (isOfflineError(error)) {
        return { allowed: true, tier: "pro", offline: true };
      }

      throw error;
    }
  }

  return freePermission(config);
}

function normalizeHandle(value) {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

function normalizeLicenseTier(config = {}) {
  const rawTier = config.licenseTier || config.tier || config.plan || config.planName;
  const tier = normalizeHandle(rawTier);
  if (tier) {
    return tier;
  }

  return config.licenseKey ? "solo" : "free";
}

function extractConfiguredPersonalHandle(config = {}) {
  return normalizeHandle(
    config.githubHandle ||
      config.githubUsername ||
      config.personalGitHubHandle ||
      config.personalHandle ||
      config.owner
  );
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map(normalizeHandle).filter(Boolean);
}

function extractGitRemoteOwner(remoteUrl) {
  const value = typeof remoteUrl === "string" || Buffer.isBuffer(remoteUrl)
    ? String(remoteUrl).trim()
    : "";
  if (!value) {
    return null;
  }

  const scpLike = /^[^@\s]+@[^:\s]+:([^/\s]+)\/[^/\s]+(?:\.git)?$/i.exec(value);
  if (scpLike) {
    return scpLike[1];
  }

  try {
    const parsed = new URL(value);
    const parts = parsed.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
    return parts[0] || null;
  } catch (_error) {
    return null;
  }
}

function inspectGitRemoteOwner(options = {}) {
  const execSync = options.execSync || defaultExecSync;

  try {
    const remoteUrl = execSync("git remote get-url origin", {
      cwd: options.cwd || process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000
    });
    return extractGitRemoteOwner(remoteUrl);
  } catch (_error) {
    return null;
  }
}

function isTeamTier(tier) {
  return TEAM_LICENSE_TIERS.has(normalizeHandle(tier));
}

function isSoloOrFreeTier(tier) {
  return SOLO_LICENSE_TIERS.has(normalizeHandle(tier));
}

function isEnterpriseOwner(owner, config = {}) {
  const normalizedOwner = normalizeHandle(owner);
  if (!normalizedOwner) {
    return false;
  }

  const personalHandle = extractConfiguredPersonalHandle(config);
  const personalAllowList = normalizeStringList(config.personalOwnerAllowList || config.personalOwners);
  if (personalHandle === normalizedOwner || personalAllowList.includes(normalizedOwner)) {
    return false;
  }

  const organizationAllowList = normalizeStringList(config.enterpriseOwnerAllowList || config.organizationOwners || config.organizations);
  if (organizationAllowList.includes(normalizedOwner)) {
    return true;
  }

  if (personalHandle && personalHandle !== normalizedOwner) {
    return true;
  }

  return ENTERPRISE_OWNER_PATTERNS.some((pattern) => pattern.test(normalizedOwner));
}

function renderEnterpriseContextWarning(options = {}) {
  if (options.color === false) {
    return ENTERPRISE_CONTEXT_WARNING;
  }

  return chalk.yellow.bold(ENTERPRISE_CONTEXT_WARNING);
}

function readCommercialConfigSync(options = {}) {
  if (options.config && typeof options.config === "object") {
    return options.config;
  }

  try {
    const raw = fs.readFileSync(getConfigPath(options.homeDir), "utf8");
    return JSON.parse(raw);
  } catch (_error) {
    return defaultConfig();
  }
}

function evaluateCommercialContext(options = {}) {
  const config = readCommercialConfigSync(options);
  const owner = inspectGitRemoteOwner(options);
  const tier = normalizeLicenseTier(config);
  const enterprise = isEnterpriseOwner(owner, config);
  const shouldWarn = enterprise && !isTeamTier(tier) && isSoloOrFreeTier(tier);

  return {
    enterprise,
    owner,
    shouldWarn,
    tier,
    ...(shouldWarn ? { message: renderEnterpriseContextWarning(options) } : {})
  };
}

async function activateLicenseKey(key, userEmail, options = {}) {
  if (typeof userEmail === "object" && userEmail !== null) {
    options = userEmail;
    userEmail = undefined;
  }

  const licenseKey = typeof key === "string" ? key.trim() : "";
  if (!licenseKey) {
    throw new Error("A license key is required.");
  }

  const requestLicenseActivation = options.requestLicenseActivation || postFormUrlEncoded;
  const hostname = options.hostname || os.hostname;
  const body = new URLSearchParams({
    license_key: licenseKey,
    instance_name: hostname()
  }).toString();
  const result = await requestLicenseActivation({
    url: LEMON_SQUEEZY_ACTIVATE_URL,
    body
  });
  const instanceId = result?.instance?.id || null;

  if (!result?.activated || !instanceId) {
    throw new Error(result?.error || "License activation failed.");
  }

  if (result.meta?.customer_email && result.meta.customer_email !== userEmail) {
    return {
      success: false,
      message: EMAIL_MISMATCH_MESSAGE
    };
  }

  const config = await readConfig(options);
  await writeConfig(
    {
      ...config,
      licenseKey,
      instanceId
    },
    options
  );

  return {
    success: true,
    activated: true,
    message: ACTIVATION_MESSAGE,
    instanceId
  };
}

async function recordFreeFixUsage(options = {}) {
  const config = await readConfig(options);
  const nextConfig = {
    ...config,
    freeFixesUsed: config.freeFixesUsed + 1
  };
  await writeConfig(nextConfig, options);
  return nextConfig;
}

module.exports = {
  ACTIVATION_MESSAGE,
  EMAIL_MISMATCH_MESSAGE,
  ENTERPRISE_CONTEXT_WARNING,
  FREE_FIXES_EXHAUSTED_MESSAGE,
  FREE_FIX_LIMIT,
  INVALID_LICENSE_MESSAGE,
  LEMON_SQUEEZY_ACTIVATE_URL,
  LEMON_SQUEEZY_VALIDATE_URL,
  activateLicenseKey,
  evaluateCommercialContext,
  extractGitRemoteOwner,
  getConfigPath,
  inspectGitRemoteOwner,
  readConfig,
  recordFreeFixUsage,
  renderEnterpriseContextWarning,
  verifyFixPermission,
  writeConfig
};
