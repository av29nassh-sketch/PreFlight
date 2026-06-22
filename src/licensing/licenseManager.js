const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const CONFIG_DIR = ".preflight";
const CONFIG_FILE = "config.json";
const FREE_FIX_LIMIT = 10;
const BETA_LICENSE_PREFIX = "PREFLIGHT-BETA-";
const BETA_LICENSE_WINDOW_DAYS = 14;
const BETA_LICENSE_WINDOW_MS = BETA_LICENSE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const BETA_LICENSE_ACTIVE_RECEIPT =
  "\u26a0\ufe0f Beta License Active \u2014 Unlocked Pro Auto-Fixes (Expires 14 days from issue date).";
const TRI_STATE_RISK_SCORE = Object.freeze({
  HARD_BLOCK: Object.freeze({
    icon: "\ud83d\udd34",
    label: "Hard Block",
    description: "Secrets, leaked roles, missing RLS"
  }),
  HIGH_RISK_DRIFT: Object.freeze({
    icon: "\ud83d\udfe1",
    label: "High-Risk Drift",
    description: "State leaks, un-idempotent webhooks"
  }),
  LIKELY_SAFE: Object.freeze({
    icon: "\ud83d\udfe2",
    label: "Likely Safe",
    description: "Standard local edits"
  })
});
const LEMON_SQUEEZY_ACTIVATE_URL = "https://api.lemonsqueezy.com/v1/licenses/activate";
const LEMON_SQUEEZY_VALIDATE_URL = "https://api.lemonsqueezy.com/v1/licenses/validate";
const FREE_FIXES_EXHAUSTED_MESSAGE =
  "You have used your 10 free AI/local fixes. To unlock unlimited deep reasoning remediation, upgrade to PreFlight Pro ($19/mo) at https://preflight-vibe.vercel.app/";
const INVALID_LICENSE_MESSAGE =
  "\u274c License is inactive or invalid. Please run 'preflight activate <key>' with a valid key.";
const EXPIRED_BETA_LICENSE_MESSAGE =
  "\u274c Beta license expired. Please request a fresh PreFlight beta key.";
const ORG_ACCOUNT_DETECTED_MESSAGE =
  "Org account detected: Enterprise repositories require a PreFlight Teams seat. Please upgrade your license or contact your administrator.";
const ACTIVATION_MESSAGE = "\u2705 PreFlight Pro activated successfully! Unlimited AI auto-fixes unlocked.";
const EMAIL_MISMATCH_MESSAGE = "\u274c Email does not match the purchase record.";
const OFFLINE_ERROR_CODES = new Set(["EAI_AGAIN", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "ENOTFOUND", "ECONNREFUSED"]);
const TEAM_TIER_PATTERN = /\b(teams?|enterprise|organization|organisation|org|seat)\b/i;
const SOLO_TIER_PATTERN = /\b(solo|pro|individual|personal|single)\b/i;
const ORG_OWNER_PATTERN = /(?:^|[-_])(org|team|teams|inc|corp|company|labs|studio|systems|solutions|technologies|engineering|enterprise|hq)(?:$|[-_])|(?:org|team|teams|inc|corp|company|labs|studio|systems|solutions|technologies|engineering|enterprise|hq)$/i;

function getDefaultHomeDir() {
  return process.env.PREFLIGHT_HOME && process.env.PREFLIGHT_HOME.trim()
    ? process.env.PREFLIGHT_HOME.trim()
    : os.homedir();
}

function getConfigPath(homeDir = getDefaultHomeDir()) {
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
  await fs.promises.chmod(configPath, 0o600).catch(() => {});
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

function parseBetaLicenseCreationDate(licenseKey) {
  const normalizedKey = typeof licenseKey === "string" ? licenseKey.trim() : "";
  if (!normalizedKey.startsWith(BETA_LICENSE_PREFIX)) {
    return null;
  }

  const parts = normalizedKey.split("-");
  if (parts.length !== 4 || parts[0] !== "PREFLIGHT" || parts[1] !== "BETA") {
    return null;
  }

  const dateString = parts[2];
  if (!/^\d{8}$/.test(dateString)) {
    return null;
  }

  const year = Number(dateString.slice(0, 4));
  const month = Number(dateString.slice(4, 6));
  const day = Number(dateString.slice(6, 8));
  const creationDate = new Date(Date.UTC(year, month - 1, day));

  if (
    Number.isNaN(creationDate.getTime()) ||
    creationDate.getUTCFullYear() !== year ||
    creationDate.getUTCMonth() !== month - 1 ||
    creationDate.getUTCDate() !== day
  ) {
    return null;
  }

  return creationDate;
}

function resolveBetaLicensePermission(licenseKey, repositoryContext, now = new Date()) {
  const creationDate = parseBetaLicenseCreationDate(licenseKey);
  if (!creationDate) {
    return null;
  }

  const evaluationDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const ageMs = evaluationDate.getTime() - creationDate.getTime();
  if (ageMs < 0 || ageMs > BETA_LICENSE_WINDOW_MS) {
    return {
      allowed: false,
      tier: "pro",
      message: EXPIRED_BETA_LICENSE_MESSAGE
    };
  }

  const boundary = validateRepositoryOwnershipBoundary({
    repositoryContext,
    tier: "pro"
  });

  return boundary || {
    allowed: true,
    tier: "pro",
    receipt: BETA_LICENSE_ACTIVE_RECEIPT
  };
}

function parseGitConfigOrigin(rawConfig) {
  if (typeof rawConfig !== "string") {
    return null;
  }

  let inOriginSection = false;
  for (const rawLine of rawConfig.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }

    const section = line.match(/^\[remote\s+"([^"]+)"\]$/i);
    if (section) {
      inOriginSection = section[1] === "origin";
      continue;
    }

    if (!inOriginSection) {
      continue;
    }

    const url = line.match(/^url\s*=\s*(.+)$/i);
    if (url) {
      return url[1].trim();
    }
  }

  return null;
}

function findGitConfigPath(cwd = process.cwd()) {
  let currentDir = path.resolve(cwd);

  while (true) {
    const gitPath = path.join(currentDir, ".git");

    try {
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory()) {
        return path.join(gitPath, "config");
      }
      if (stat.isFile()) {
        const gitFile = fs.readFileSync(gitPath, "utf8");
        const gitDirMatch = gitFile.match(/^gitdir:\s*(.+)$/im);
        if (gitDirMatch) {
          const gitDir = gitDirMatch[1].trim();
          return path.join(path.isAbsolute(gitDir) ? gitDir : path.resolve(currentDir, gitDir), "config");
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        return null;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

function readGitRemoteOriginUrl(options = {}) {
  const configPath = options.gitConfigPath || findGitConfigPath(options.cwd);
  if (!configPath) {
    return null;
  }

  try {
    return parseGitConfigOrigin(fs.readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

function parseRepositoryRemote(remoteUrl) {
  const normalizedRemote = typeof remoteUrl === "string" ? remoteUrl.trim() : "";
  if (!normalizedRemote) {
    return null;
  }

  const scpLike = normalizedRemote.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/i);
  if (scpLike) {
    return {
      host: scpLike[1],
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
      host: parsed.hostname,
      owner: segments[0],
      repo: segments[segments.length - 1].replace(/\.git$/i, ""),
      remoteUrl: normalizedRemote
    };
  } catch {
    return null;
  }
}

function normalizeOwner(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function resolvePersonalGitOwner(config = {}, env = process.env, options = {}) {
  return (
    options.personalGitOwner ||
    config.personalGitOwner ||
    env.PREFLIGHT_PERSONAL_GIT_OWNER ||
    env.PREFLIGHT_PERSONAL_GITHUB_HANDLE ||
    env.GITHUB_USERNAME ||
    null
  );
}

function isLikelyOrganizationOwner(owner, personalGitOwner) {
  const normalizedOwner = normalizeOwner(owner);
  const normalizedPersonalOwner = normalizeOwner(personalGitOwner);
  if (!normalizedOwner) {
    return false;
  }

  if (normalizedPersonalOwner) {
    return normalizedOwner !== normalizedPersonalOwner;
  }

  return ORG_OWNER_PATTERN.test(owner);
}

function getRepositoryContext(options = {}) {
  const remoteUrl = options.remoteOriginUrl || readGitRemoteOriginUrl(options);
  const repository = parseRepositoryRemote(remoteUrl);
  if (!repository) {
    return {
      isOrganization: false,
      remoteUrl: remoteUrl || null,
      repository: null
    };
  }

  return {
    isOrganization: isLikelyOrganizationOwner(repository.owner, options.personalGitOwner),
    remoteUrl: repository.remoteUrl,
    repository
  };
}

function normalizeLicenseTier(value) {
  const tier = typeof value === "string" ? value.trim() : "";
  if (!tier) {
    return null;
  }

  if (TEAM_TIER_PATTERN.test(tier)) {
    return "teams";
  }

  if (SOLO_TIER_PATTERN.test(tier)) {
    return "solo";
  }

  return tier.toLowerCase();
}

function readNestedValue(source, pathSegments) {
  return pathSegments.reduce((current, key) => {
    if (current && typeof current === "object") {
      return current[key];
    }
    return undefined;
  }, source);
}

function resolveLicenseTier(validationResult, config = {}, env = process.env, options = {}) {
  const candidates = [
    options.licenseTier,
    config.licenseTier,
    env.PREFLIGHT_LICENSE_TIER,
    env.PREFLIGHT_PRO_TIER,
    readNestedValue(validationResult, ["tier"]),
    readNestedValue(validationResult, ["licenseTier"]),
    readNestedValue(validationResult, ["license_tier"]),
    readNestedValue(validationResult, ["meta", "tier"]),
    readNestedValue(validationResult, ["meta", "license_tier"]),
    readNestedValue(validationResult, ["meta", "variant_name"]),
    readNestedValue(validationResult, ["meta", "product_name"]),
    readNestedValue(validationResult, ["meta", "custom_data", "tier"]),
    readNestedValue(validationResult, ["meta", "custom_data", "plan"]),
    readNestedValue(validationResult, ["license_key", "tier"]),
    readNestedValue(validationResult, ["license_key", "variant_name"])
  ];

  for (const candidate of candidates) {
    const tier = normalizeLicenseTier(candidate);
    if (tier) {
      return tier;
    }
  }

  return "pro";
}

function resolveConfiguredLicenseKey(config = {}, env = process.env) {
  return (
    env.PREFLIGHT_PRO_KEY ||
    env.PREFLIGHT_TEAMS_KEY ||
    env.PREFLIGHT_PRO_LICENSE_KEY ||
    config.licenseKey ||
    null
  );
}

async function resolveStoredLicenseKey(options = {}) {
  const env = options.env || process.env;
  const config = options.config || await readConfig(options);
  return resolveConfiguredLicenseKey(config, env);
}

function repositoryOwnershipBlock(repository, tier) {
  return {
    allowed: false,
    tier,
    message: ORG_ACCOUNT_DETECTED_MESSAGE,
    repository
  };
}

function validateRepositoryOwnershipBoundary({ repositoryContext, tier }) {
  if (!repositoryContext?.isOrganization) {
    return null;
  }

  if (tier !== "teams") {
    return repositoryOwnershipBlock(repositoryContext.repository, tier);
  }

  return null;
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
  const env = options.env || process.env;
  const config = await readConfig(options);
  const personalGitOwner = resolvePersonalGitOwner(config, env, options);
  const repositoryContext = getRepositoryContext({
    cwd: options.cwd,
    gitConfigPath: options.gitConfigPath,
    personalGitOwner,
    remoteOriginUrl: options.remoteOriginUrl
  });
  const configuredLicenseKey = resolveConfiguredLicenseKey(config, env);

  if (!configuredLicenseKey) {
    const freeBoundary = validateRepositoryOwnershipBoundary({
      repositoryContext,
      tier: "free"
    });
    return freeBoundary || freePermission(config);
  }

  const betaPermission = resolveBetaLicensePermission(configuredLicenseKey, repositoryContext, new Date());
  if (betaPermission) {
    return betaPermission;
  }

  const explicitTier = resolveLicenseTier(null, config, env, options);
  const explicitBoundary = validateRepositoryOwnershipBoundary({
    repositoryContext,
    tier: explicitTier
  });
  if (explicitBoundary && explicitTier !== "solo") {
    return explicitBoundary;
  }
  if (explicitBoundary && (options.licenseTier || config.licenseTier || env.PREFLIGHT_LICENSE_TIER || env.PREFLIGHT_PRO_TIER)) {
    return explicitBoundary;
  }

  if (configuredLicenseKey) {
    const payload = {
      license_key: configuredLicenseKey
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
        const validatedTier = resolveLicenseTier(result, config, env, options);
        const validatedBoundary = validateRepositoryOwnershipBoundary({
          repositoryContext,
          tier: validatedTier
        });
        return validatedBoundary || { allowed: true, tier: validatedTier };
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
        const offlineBoundary = validateRepositoryOwnershipBoundary({
          repositoryContext,
          tier: explicitTier
        });
        return offlineBoundary || { allowed: true, tier: explicitTier, offline: true };
      }

      throw error;
    }
  }

  return freePermission(config);
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
  FREE_FIXES_EXHAUSTED_MESSAGE,
  FREE_FIX_LIMIT,
  INVALID_LICENSE_MESSAGE,
  LEMON_SQUEEZY_ACTIVATE_URL,
  LEMON_SQUEEZY_VALIDATE_URL,
  ORG_ACCOUNT_DETECTED_MESSAGE,
  TRI_STATE_RISK_SCORE,
  activateLicenseKey,
  getRepositoryContext,
  getConfigPath,
  parseGitConfigOrigin,
  parseRepositoryRemote,
  readConfig,
  readGitRemoteOriginUrl,
  recordFreeFixUsage,
  resolveConfiguredLicenseKey,
  resolveStoredLicenseKey,
  resolveLicenseTier,
  verifyFixPermission,
  writeConfig
};
