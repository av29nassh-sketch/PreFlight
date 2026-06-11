const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");

const PORT = Number(process.env.PORT) || 3000;
const MODEL_NAME = "claude-sonnet-4-5-20250929";
const MAX_REQUEST_BODY = "512kb";
const MAX_MESSAGE_COUNT = 8;
const MAX_MESSAGE_CHARS = 120000;
const MAX_SYSTEM_CHARS = 12000;
const MAX_ALLOWED_TOKENS = 2500;
const ANTHROPIC_TIMEOUT_MS = 55000;
const PREFLIGHT_BETA_KEY_PATTERN = /^PREFLIGHT-BETA-\d{8}-[A-Z0-9]+$/i;

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

function requirePreflightActivation(req, res, next) {
  const token = extractPreflightActivationToken(req);
  if (!PREFLIGHT_BETA_KEY_PATTERN.test(token)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  req.preflightActivationToken = token;
  next();
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

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "healthy" });
});

async function handleRemediationRequest(req, res) {
  if (!process.env.ANTHROPIC_KEY) {
    console.error("Anthropic proxy misconfigured: missing ANTHROPIC_KEY");
    return res.status(500).json({ error: "Deep reasoning engine communication failed." });
  }

  const bodyError = validateRequestBody(req.body);
  if (bodyError) {
    return res.status(400).json({ error: bodyError });
  }

  const { max_tokens, messages, system, temperature } = req.body;

  try {
    const anthropic = createAnthropicClient();
    const requestPayload = {
      model: MODEL_NAME,
      max_tokens,
      system,
      messages
    };

    if (temperature !== undefined) {
      requestPayload.temperature = temperature;
    }

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
