const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");

const PORT = Number(process.env.PORT) || 3000;
const MODEL_NAME = "claude-sonnet-4-5-20250929";
const MAX_REQUEST_BODY = "512kb";
const MAX_MESSAGE_COUNT = 8;
const MAX_MESSAGE_CHARS = 120000;
const MAX_SYSTEM_CHARS = 12000;
const MAX_ALLOWED_TOKENS = 2500;
const DEFAULT_REMEDIATION_MAX_TOKENS = 1800;
const ANTHROPIC_TIMEOUT_MS = 55000;
const BETA_KEY_TTL_DAYS = 14;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REMEDIATION_REQUESTS_PER_WINDOW = 10;
const SUPABASE_BETA_KEYS_TABLE = "preflight_beta_keys";
const PREFLIGHT_BETA_KEY_PATTERN = /^PREFLIGHT-BETA-\d{8}-[A-Z0-9]+$/i;
const FREE_FIX_PROXY_TOKEN = "PREFLIGHT-FREE-FIX";
const FUZZER_REMEDIATION_SYSTEM_PROMPT =
  [
    "You are a surgical code patcher.",
    "Remediate the reported vulnerability in the provided source file.",
    "",
    "Rules:",
    "1. ONLY modify the specific lines required to fix the vulnerability.",
    "2. PRESERVE surrounding architecture, imports, exports, routing style, formatting, and module boundaries.",
    "3. PRESERVE existing semantic names and user-facing language. If the code uses targetIp, keep IP-related validation/messages. If it uses domain, keep domain-related validation/messages.",
    "4. Do NOT redefine existing modules, routers, apps, clients, or variables unless they already exist in the file.",
    "5. If the file uses an Express router, keep using that router. Do not introduce const app = express().",
    "6. Choose the safest framework-appropriate mitigation for the vulnerability type and code context.",
    "7. Return ONLY the complete patched source file. No markdown, no backticks, no headings, no explanations."
  ].join("\n");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: MAX_REQUEST_BODY }));

const remediationRateLimit = new Map();

function createAnthropicClient() {
  return new Anthropic({
    apiKey: process.env.ANTHROPIC_KEY
  });
}

function extractPreflightActivationToken(req) {
  const authorizationHeader = req.get("Authorization");
  if (typeof authorizationHeader === "string") {
    const bearerMatch = authorizationHeader.trim().match(/^Bearer\s+(.+)$/i);
    if (bearerMatch?.[1]?.trim()) {
      return bearerMatch[1].trim();
    }
  }

  const legacyHeader = req.get("X-PreFlight-Pro-Key");
  return typeof legacyHeader === "string" ? legacyHeader.trim() : "";
}

function isFreeFixEntitlementRequest(req, token) {
  return token === FREE_FIX_PROXY_TOKEN && req.get("X-PreFlight-Free-Fix") === "1";
}

function getSupabaseRestConfig() {
  const supabaseUrl = typeof process.env.SUPABASE_URL === "string" ? process.env.SUPABASE_URL.trim() : "";
  const serviceRoleKey =
    typeof process.env.SUPABASE_SERVICE_ROLE_KEY === "string"
      ? process.env.SUPABASE_SERVICE_ROLE_KEY.trim()
      : "";
  const tableName =
    typeof process.env.PREFLIGHT_BETA_KEYS_TABLE === "string" && process.env.PREFLIGHT_BETA_KEYS_TABLE.trim()
      ? process.env.PREFLIGHT_BETA_KEYS_TABLE.trim()
      : SUPABASE_BETA_KEYS_TABLE;

  if (!supabaseUrl || !serviceRoleKey) {
    return null;
  }

  return {
    supabaseUrl: supabaseUrl.replace(/\/+$/, ""),
    serviceRoleKey,
    tableName
  };
}

function createSupabaseHeaders(config, extraHeaders = {}) {
  return {
    apikey: config.serviceRoleKey,
    Authorization: `Bearer ${config.serviceRoleKey}`,
    "Content-Type": "application/json",
    ...extraHeaders
  };
}

function createSupabaseTableUrl(config, searchParams) {
  const query = searchParams.toString();
  const tablePath = encodeURIComponent(config.tableName);
  return `${config.supabaseUrl}/rest/v1/${tablePath}${query ? `?${query}` : ""}`;
}

async function parseSupabaseError(response) {
  const rawText = await response.text();
  if (!rawText) {
    return response.statusText || "Unknown Supabase error";
  }

  try {
    const parsed = JSON.parse(rawText);
    return parsed?.message || parsed?.error_description || parsed?.error || rawText;
  } catch {
    return rawText;
  }
}

async function fetchSupabaseJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const errorMessage = await parseSupabaseError(response);
    throw new Error(`Supabase beta key request failed (${response.status}): ${errorMessage}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function getBetaKeyRecord(config, token) {
  const searchParams = new URLSearchParams({
    key_string: `eq.${token}`,
    select: "key_string,activated_at,expires_at",
    limit: "1"
  });
  const payload = await fetchSupabaseJson(createSupabaseTableUrl(config, searchParams), {
    method: "GET",
    headers: createSupabaseHeaders(config)
  });

  return Array.isArray(payload) && payload.length > 0 ? payload[0] : null;
}

async function activateBetaKeyRecord(config, token, now = new Date()) {
  const activatedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + BETA_KEY_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const searchParams = new URLSearchParams({
    key_string: `eq.${token}`,
    activated_at: "is.null",
    select: "key_string,activated_at,expires_at"
  });
  const payload = await fetchSupabaseJson(createSupabaseTableUrl(config, searchParams), {
    method: "PATCH",
    headers: createSupabaseHeaders(config, {
      Prefer: "return=representation"
    }),
    body: JSON.stringify({
      activated_at: activatedAt,
      expires_at: expiresAt
    })
  });

  return Array.isArray(payload) && payload.length > 0 ? payload[0] : null;
}

function isBetaKeyExpired(record, now = new Date()) {
  if (!record?.expires_at) {
    return true;
  }

  const expiresAt = new Date(record.expires_at);
  if (!Number.isFinite(expiresAt.getTime())) {
    return true;
  }

  return now.getTime() > expiresAt.getTime();
}

async function validateOrActivateBetaKey(token, now = new Date()) {
  const config = getSupabaseRestConfig();
  if (!config) {
    throw new Error("Beta key validation backend is not configured.");
  }

  let record = await getBetaKeyRecord(config, token);
  if (!record) {
    return {
      allowed: false,
      status: 401,
      error: "Unauthorized"
    };
  }

  if (record.activated_at == null) {
    const activatedRecord = await activateBetaKeyRecord(config, token, now);
    if (activatedRecord) {
      return {
        allowed: true,
        record: activatedRecord
      };
    }

    record = await getBetaKeyRecord(config, token);
    if (!record) {
      return {
        allowed: false,
        status: 401,
        error: "Unauthorized"
      };
    }
  }

  if (isBetaKeyExpired(record, now)) {
    return {
      allowed: false,
      status: 401,
      error: "Beta License Expired"
    };
  }

  return {
    allowed: true,
    record
  };
}

async function validateBetaKeyOnly(token, now = new Date()) {
  const config = getSupabaseRestConfig();
  if (!config) {
    throw new Error("Beta key validation backend is not configured.");
  }

  const record = await getBetaKeyRecord(config, token);
  if (!record) {
    return {
      allowed: false,
      status: 401,
      error: "Unauthorized"
    };
  }

  if (record.expires_at && isBetaKeyExpired(record, now)) {
    return {
      allowed: false,
      status: 401,
      error: "Beta License Expired"
    };
  }

  return {
    allowed: true,
    record
  };
}

async function requirePreflightActivation(req, res, next) {
  const token = extractPreflightActivationToken(req);
  if (isFreeFixEntitlementRequest(req, token)) {
    req.preflightActivationToken = FREE_FIX_PROXY_TOKEN;
    req.preflightActivationRecord = {
      tier: "free",
      activated_at: null,
      expires_at: null
    };
    return next();
  }

  if (!PREFLIGHT_BETA_KEY_PATTERN.test(token)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const validation = await validateOrActivateBetaKey(token);
    if (!validation.allowed) {
      return res.status(validation.status || 401).json({ error: validation.error || "Unauthorized" });
    }

    req.preflightActivationToken = token;
    req.preflightActivationRecord = validation.record;
    return next();
  } catch (error) {
    console.error("PreFlight proxy key validation failed", {
      message: error instanceof Error ? error.message : "Unknown validation error"
    });
    return res.status(500).json({ error: "Deep reasoning engine communication failed." });
  }
}

function getRateLimitKey(req) {
  const token = typeof req.preflightActivationToken === "string" ? req.preflightActivationToken : "anonymous";
  const forwardedFor = req.get("x-forwarded-for");
  const ip = typeof forwardedFor === "string" && forwardedFor.trim()
    ? forwardedFor.split(",")[0].trim()
    : req.ip || "unknown";

  return `${token}:${ip}`;
}

function requireRemediationRateLimit(req, res, next) {
  const now = Date.now();
  if (remediationRateLimit.size > 1000) {
    for (const [key, value] of remediationRateLimit.entries()) {
      if (value.resetAt <= now) {
        remediationRateLimit.delete(key);
      }
    }
  }

  const rateLimitKey = getRateLimitKey(req);
  const existing = remediationRateLimit.get(rateLimitKey);

  if (!existing || existing.resetAt <= now) {
    remediationRateLimit.set(rateLimitKey, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS
    });
    return next();
  }

  if (existing.count >= MAX_REMEDIATION_REQUESTS_PER_WINDOW) {
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    res.set("Retry-After", String(retryAfterSeconds));
    return res.status(429).json({ error: "Too many remediation requests. Please retry shortly." });
  }

  existing.count += 1;
  return next();
}

async function handleLicenseValidateRequest(req, res) {
  const token = extractPreflightActivationToken(req);
  if (!PREFLIGHT_BETA_KEY_PATTERN.test(token)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const validation = await validateBetaKeyOnly(token);
    if (!validation.allowed) {
      return res.status(validation.status || 401).json({ error: validation.error || "Unauthorized" });
    }

    return res.status(200).json({ valid: true });
  } catch (error) {
    console.error("PreFlight proxy license validation failed", {
      message: error instanceof Error ? error.message : "Unknown validation error"
    });
    return res.status(500).json({ error: "License validation failed." });
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "messages must be a non-empty array.";
  }

  if (messages.length > MAX_MESSAGE_COUNT) {
    return `messages cannot contain more than ${MAX_MESSAGE_COUNT} items.`;
  }

  for (const message of messages) {
    if (!isPlainObject(message)) {
      return "Each message must be an object.";
    }

    if (message.role !== "user") {
      return "Each message role must be 'user'.";
    }

    if (typeof message.content !== "string" || !message.content.trim()) {
      return "Each message content must be a non-empty string.";
    }

    if (message.content.length > MAX_MESSAGE_CHARS) {
      return `Each message content must be ${MAX_MESSAGE_CHARS} characters or fewer.`;
    }
  }

  return null;
}

function validateRequestBody(body) {
  if (!isPlainObject(body)) {
    return "Request body must be a JSON object.";
  }

  const { messages, max_tokens, system, temperature } = body;

  if (typeof system !== "string" || !system.trim()) {
    return "system must be a non-empty string.";
  }

  if (system.length > MAX_SYSTEM_CHARS) {
    return `system must be ${MAX_SYSTEM_CHARS} characters or fewer.`;
  }

  const messagesError = validateMessages(messages);
  if (messagesError) {
    return messagesError;
  }

  if (!Number.isInteger(max_tokens)) {
    return "max_tokens must be an integer.";
  }

  if (max_tokens < 1 || max_tokens > MAX_ALLOWED_TOKENS) {
    return `max_tokens must be between 1 and ${MAX_ALLOWED_TOKENS}.`;
  }

  if (temperature !== undefined) {
    if (typeof temperature !== "number" || Number.isNaN(temperature)) {
      return "temperature must be a number if provided.";
    }

    if (temperature < 0 || temperature > 1) {
      return "temperature must be between 0 and 1.";
    }
  }

  return null;
}

function validateStringField(body, fieldName, maxLength) {
  const value = body[fieldName];
  if (typeof value !== "string" || !value.trim()) {
    return `${fieldName} must be a non-empty string.`;
  }

  if (value.length > maxLength) {
    return `${fieldName} must be ${maxLength} characters or fewer.`;
  }

  return null;
}

function normalizeExecutionTrail(executionTrail) {
  if (!Array.isArray(executionTrail)) {
    return null;
  }

  if (executionTrail.length > 64) {
    return null;
  }

  const normalizedTrail = [];
  for (const item of executionTrail) {
    if (typeof item !== "string") {
      return null;
    }

    normalizedTrail.push(item.slice(0, 2000));
  }

  return normalizedTrail;
}

function buildFuzzerRemediationPrompt({ filePath, sourceCode, vulnerabilityType, breakingPayload, executionTrail }) {
  return [
    "Patch this source file surgically.",
    `File: ${filePath}`,
    `Vulnerability type: ${vulnerabilityType}`,
    `Breaking payload: ${breakingPayload}`,
    "Execution trail:",
    executionTrail.length > 0 ? executionTrail.join("\n") : "No execution trail provided.",
    "",
    "Mitigation guide:",
    "- SQL injection: use parameterized queries without changing database client architecture.",
    "- Command injection: replace shell execution with argument-array APIs such as execFile/spawn and validate the same input concept already present in the code.",
    "- SSRF: use protocol/domain allowlists while preserving URL/domain terminology already used in the route.",
    "- Path traversal: use strict path normalization and base-directory allowlists.",
    "- Auth bypass: add explicit authorization checks without replacing the route/module structure.",
    "",
    "Preservation requirements:",
    "- Keep the same Express router/app pattern already present in the file.",
    "- Keep route names, request field names, response messages, and validation labels semantically aligned with the existing variables.",
    "- Do not add unrelated setup code, new apps, duplicate routers, or broad rewrites.",
    "",
    "Source file:",
    sourceCode
  ].join("\n");
}

function normalizeRemediationRequestBody(body) {
  const legacyBodyError = validateRequestBody(body);
  if (!legacyBodyError) {
    const { max_tokens, messages, system, temperature } = body;
    return {
      requestPayload: {
        model: MODEL_NAME,
        max_tokens,
        system,
        messages,
        ...(temperature !== undefined ? { temperature } : {})
      }
    };
  }

  if (!isPlainObject(body)) {
    return { error: "Request body must be a JSON object." };
  }

  const filePathError = validateStringField(body, "filePath", 600);
  if (filePathError) {
    return { error: filePathError };
  }

  const sourceCodeError = validateStringField(body, "sourceCode", MAX_MESSAGE_CHARS);
  if (sourceCodeError) {
    return { error: sourceCodeError };
  }

  const vulnerabilityTypeError = validateStringField(body, "vulnerabilityType", 120);
  if (vulnerabilityTypeError) {
    return { error: vulnerabilityTypeError };
  }

  const breakingPayloadError = validateStringField(body, "breakingPayload", 4000);
  if (breakingPayloadError) {
    return { error: breakingPayloadError };
  }

  const executionTrail = normalizeExecutionTrail(body.executionTrail);
  if (!executionTrail) {
    return { error: "executionTrail must be an array of strings." };
  }

  return {
    requestPayload: {
      model: MODEL_NAME,
      max_tokens: DEFAULT_REMEDIATION_MAX_TOKENS,
      system: FUZZER_REMEDIATION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: buildFuzzerRemediationPrompt({
            filePath: body.filePath,
            sourceCode: body.sourceCode,
            vulnerabilityType: body.vulnerabilityType,
            breakingPayload: body.breakingPayload,
            executionTrail
          })
        }
      ],
      temperature: 0
    }
  };
}

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "healthy" });
});

app.post("/api/v1/license/validate", handleLicenseValidateRequest);

async function handleRemediationRequest(req, res) {
  if (!process.env.ANTHROPIC_KEY) {
    console.error("Anthropic proxy misconfigured: missing ANTHROPIC_KEY");
    return res.status(500).json({ error: "Deep reasoning engine communication failed." });
  }

  const normalized = normalizeRemediationRequestBody(req.body);
  if (normalized.error) {
    return res.status(400).json({ error: normalized.error });
  }

  try {
    const anthropic = createAnthropicClient();
    const requestPayload = normalized.requestPayload;

    const response = await anthropic.messages.create(requestPayload, {
      timeout: ANTHROPIC_TIMEOUT_MS
    });

    return res.status(200).json(response);
  } catch (error) {
    console.error("Anthropic proxy request failed", {
      message: error instanceof Error ? error.message : "Unknown error",
      name: error instanceof Error ? error.name : "UnknownError",
      status: typeof error?.status === "number" ? error.status : undefined
    });

    if (error instanceof Error && /timeout/i.test(error.message)) {
      return res.status(504).json({ error: "Deep reasoning engine communication failed." });
    }

    return res.status(500).json({ error: "Deep reasoning engine communication failed." });
  }
}

app.post(
  ["/api/v1/remediation", "/api/v1/remediate"],
  requirePreflightActivation,
  requireRemediationRateLimit,
  handleRemediationRequest
);

app.use((error, _req, res, _next) => {
  if (error?.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body is too large." });
  }

  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({ error: "Invalid JSON request body." });
  }

  console.error("Anthropic proxy middleware failure", {
    message: error instanceof Error ? error.message : "Unknown middleware error"
  });
  return res.status(500).json({ error: "Deep reasoning engine communication failed." });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`PreFlight proxy listening on port ${PORT}`);
  });
}

module.exports = app;
