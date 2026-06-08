const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const packageJson = require("../../package.json");

const DEFAULT_CLOUD_URL = "https://api.preflight.dev";
const TELEMETRY_PATH = "/api/v1/telemetry/report";

function resolveLicenseKey(explicitLicenseKey, env = process.env) {
  const key = explicitLicenseKey || env.PREFLIGHT_TEAMS_KEY || env.PREFLIGHT_PRO_KEY;
  return typeof key === "string" && key.trim() ? key.trim() : null;
}

function resolveTelemetrySecret(licenseKey, env = process.env) {
  const secret = env.PREFLIGHT_TELEMETRY_SECRET || licenseKey;
  return typeof secret === "string" && secret.trim() ? secret.trim() : null;
}

function normalizeCloudBaseUrl(env = process.env) {
  const rawUrl = env.PREFLIGHT_CLOUD_URL || env.PREFLIGHT_API_URL || DEFAULT_CLOUD_URL;
  return String(rawUrl).replace(/\/+$/, "");
}

function normalizeSeverity(severity) {
  const normalized = String(severity || "").trim().toUpperCase();
  if (normalized === "WARNING" || normalized === "WARN") {
    return "MEDIUM";
  }
  if (["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(normalized)) {
    return normalized;
  }
  return "INFO";
}

function inferState(finding = {}) {
  const explicit = String(finding.state || finding.riskState || "").trim().toUpperCase();
  if (["RED", "YELLOW", "GREEN"].includes(explicit)) {
    return explicit;
  }

  const severity = normalizeSeverity(finding.severity);
  if (severity === "CRITICAL") {
    return "RED";
  }
  if (severity === "HIGH" || finding.requiresDeepRemediation) {
    return "YELLOW";
  }
  return "GREEN";
}

function normalizeWorkspace(repoMetadata = {}) {
  return {
    remoteUrl: repoMetadata.remoteUrl || repoMetadata.remote_url || null,
    host: repoMetadata.host || null,
    owner: repoMetadata.owner || repoMetadata.repoOwner || null,
    repo: repoMetadata.repo || repoMetadata.repoName || null,
    isOrganization: repoMetadata.isOrganization,
    personalGitOwner: repoMetadata.personalGitOwner || null
  };
}

function normalizeFinding(finding = {}) {
  return {
    ruleId: String(finding.ruleId || finding.rule_id || "unknown"),
    severity: normalizeSeverity(finding.severity),
    state: inferState(finding),
    filePath: String(finding.filePath || finding.file_path || finding.path || "unknown"),
    metadata: {}
  };
}

function buildTelemetryPayload(scanResults, repoMetadata, licenseKey, options = {}) {
  const findings = Array.isArray(scanResults) ? scanResults : [];
  return {
    licenseKey,
    timestamp: typeof options.now === "function" ? options.now() : Date.now(),
    workspace: normalizeWorkspace(repoMetadata),
    findings: findings.map(normalizeFinding),
    source: options.source || (options.ci ? "ci" : "cli"),
    cliVersion: options.cliVersion || packageJson.version,
    branch: options.branch,
    commitSha: options.commitSha
  };
}

function signPayload(body, secret) {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

function postJson({ url, body, headers = {}, timeoutMs = 2000 }) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === "http:" ? http : https;
    const request = transport.request(
      parsedUrl,
      {
        method: "POST",
        timeout: timeoutMs,
        headers: {
          ...headers,
          "Content-Length": Buffer.byteLength(body)
        }
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            statusCode: response.statusCode
          });
        });
      }
    );

    request.on("timeout", () => request.destroy(new Error("Telemetry request timed out.")));
    request.on("socket", (socket) => {
      socket.unref?.();
    });
    request.on("error", reject);
    request.unref?.();
    request.write(body);
    request.end();
  });
}

async function reportTelemetry(scanResults, repoMetadata, licenseKey, options = {}) {
  const env = options.env || process.env;
  const resolvedLicenseKey = resolveLicenseKey(licenseKey, env);
  if (!resolvedLicenseKey) {
    return { skipped: true, reason: "missing_license_key" };
  }

  const findings = Array.isArray(scanResults) ? scanResults : [];
  if (findings.length === 0) {
    return { skipped: true, reason: "empty_findings" };
  }

  const secret = resolveTelemetrySecret(resolvedLicenseKey, env);
  if (!secret) {
    return { skipped: true, reason: "missing_telemetry_secret" };
  }

  const payload = buildTelemetryPayload(findings, repoMetadata, resolvedLicenseKey, options);
  const body = JSON.stringify(payload);
  const request = options.request || postJson;
  const url = `${normalizeCloudBaseUrl(env)}${TELEMETRY_PATH}`;
  const headers = {
    "Content-Type": "application/json",
    "X-PreFlight-Signature": signPayload(body, secret)
  };

  const response = await request({
    url,
    body,
    headers,
    timeoutMs: options.timeoutMs || 2000
  });

  return {
    reported: Boolean(response?.ok),
    statusCode: response?.statusCode || null
  };
}

function reportTelemetryFireAndForget(scanResults, repoMetadata, licenseKey, options = {}) {
  Promise.resolve()
    .then(() => reportTelemetry(scanResults, repoMetadata, licenseKey, options))
    .catch(() => {});
}

module.exports = {
  TELEMETRY_PATH,
  buildTelemetryPayload,
  inferState,
  normalizeFinding,
  normalizeWorkspace,
  reportTelemetry,
  reportTelemetryFireAndForget,
  resolveLicenseKey,
  signPayload
};
