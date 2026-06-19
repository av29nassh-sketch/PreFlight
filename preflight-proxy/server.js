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
const SUPABASE_BETA_KEYS_TABLE = "preflight_beta_keys";
const PREFLIGHT_BETA_KEY_PATTERN = /^PREFLIGHT-BETA-\d{8}-[A-Z0-9]+$/i;
const FUZZER_REMEDIATION_SYSTEM_PROMPT =
  "You are an expert security engineer. Given a vulnerable code snippet, execution trail, and breaking payload, return ONLY the raw, patched source code. Do not use markdown formatting. Fix the vulnerability by parameterizing the input.";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: MAX_REQUEST_BODY }));

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

async function requirePreflightActivation(req, res, next) {
  const token = extractPreflightActivationToken(req);
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
    "Fix this vulnerability.",
    `File: ${filePath}`,
    `Type: ${vulnerabilityType}`,
    `Payload: ${breakingPayload}`,
    "Trail:",
    executionTrail.length > 0 ? executionTrail.join("\n") : "No execution trail provided.",
    "",
    "Code:",
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

app.post(["/api/v1/remediation", "/api/v1/remediate"], requirePreflightActivation, handleRemediationRequest);

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
