const crypto = require("node:crypto");
const https = require("node:https");
const os = require("node:os");
const OpenAIImport = require("openai");
const { parseMultiFileRemediationJson } = require("../../remediationEngine");
const {
  DEFAULT_PREFLIGHT_PROXY_ENDPOINT,
  extractPreflightProxyText,
  requestPreflightProxy
} = require("../proxy/client");
const { evaluateHardware } = require("./hardware");

const DEFAULT_CLOUD_ENDPOINT = DEFAULT_PREFLIGHT_PROXY_ENDPOINT;
const DEFAULT_CLOUD_MODEL = "gpt-4o-mini";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1/";
const DEFAULT_REASONING_MODEL = "claude-sonnet-4-6";
const DEFAULT_LOCAL_LLM_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_LOCAL_MICRO_MODEL = "qwen2.5-coder:0.5b";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_MICRO_MODEL = "qwen/qwen3-coder:free";
const DEFAULT_MICRO_ROUTER_TIMEOUT_MS = 5000;
const DEFAULT_MICRO_ROUTER_DIFF_BYTES = 12000;
const DEFAULT_MICRO_ROUTER_MAX_TOKENS = 200;
const DEFAULT_REASONING_TIMEOUT_MS = 30000;
const DEFAULT_REASONING_CONTEXT_BYTES = 60000;
const DEFAULT_CLOUD_VERDICT_MAX_TOKENS = 500;
const DEFAULT_REASONING_MAX_TOKENS = 2200;
const OpenAI = OpenAIImport.default || OpenAIImport;
const MANUAL_REVIEW_REQUIRED = "MANUAL_REVIEW_REQUIRED";
const PAYWALL_UPGRADE_MESSAGE = [
  "💡 You've hit the local trial limit!",
  "PreFlight fixed 5 complex vulnerabilities for free. To unlock unlimited deep-logic AI remediation, upgrade to the Pro tier:",
  "👉 https://your-dashboard-subdomain.vercel.app"
].join("\n");
const PRO_ENGINE_CONNECTION_ERROR =
  "🔴 PreFlight Pro Engine connection timed out or license invalid. Please verify your PREFLIGHT_PRO_KEY.";
const FREE_FIX_PROXY_TOKEN = "PREFLIGHT-FREE-FIX";
const MANUAL_REVIEW_MESSAGE =
  "⚠️ Manual Review Recommended: This vulnerability requires specific architectural context to fix safely. PreFlight has skipped auto-remediation to protect your build logic.";

class PreFlightPaymentRequiredError extends Error {
  constructor(message = PRO_ENGINE_CONNECTION_ERROR) {
    super(message);
    this.name = "PreFlightPaymentRequiredError";
    this.status = 402;
    this.code = "PREFLIGHT_PAYMENT_REQUIRED";
  }
}

class ManualReviewRequiredError extends Error {
  constructor(message = MANUAL_REVIEW_MESSAGE) {
    super(message);
    this.name = "ManualReviewRequiredError";
    this.code = "PREFLIGHT_MANUAL_REVIEW_REQUIRED";
  }
}

const PREFLIGHT_SYSTEM_PROMPT = `
You are PreFlight, a zero-tolerance AI security guardrail operating inside a developer's local pre-commit hook.
Your job is to analyze git diffs for structural and logical vulnerabilities silently injected by other AI coding agents.

You must evaluate the provided diff and output strictly in valid JSON format. No markdown blocks, no conversational text.
CRITICAL: Minimize internal reasoning steps. Generate the target JSON payload immediately. Do not append conversational preambles or post-analysis text.

{
  "state": "RED" | "YELLOW" | "GREEN",
  "reasoning": "A concise, 1-sentence technical explanation of the finding.",
  "manual_qa_line": "If YELLOW, provide a plain-English, actionable instruction for the developer to manually test this locally. If RED or GREEN, output null.",
  "auto_patch": "If RED, provide the strict Unified Diff code patch to fix the vulnerability. If YELLOW or GREEN, output null."
}

Evaluation Criteria:
- RED (Confirmed Finding): Exposed secrets, raw SQL injections, or blatantly missing authorization middleware.
- YELLOW (Needs Runtime Check): Fuzzy boundaries, multi-file tenant wrappers, or Row-Level Security (RLS) bypasses where data isolation cannot be traced natively.
- GREEN (Likely Safe): Clean syntax, safe primitives, and verified guards.
`;

const MICRO_ROUTER_SYSTEM_PROMPT = [
  "You are PreFlight's fast micro-model router.",
  "Evaluate only whether this git diff requires a deeper architectural security scan.",
  "Return strict JSON only: {\"requires_deep_scan\":true} or {\"requires_deep_scan\":false}.",
  "CRITICAL: Minimize internal reasoning steps. Generate the target JSON payload immediately. Do not append conversational preambles or post-analysis text.",
  "Return true ONLY for structural, architectural, authorization, authentication, tenant isolation, RLS, middleware, webhook, billing, database policy, RPC, or security boundary changes.",
  "Return false for cosmetic edits, copy changes, simple type fixes, formatting, comments, tests without production security impact, and ordinary local variable changes."
].join("\n");

const REASONING_ENGINE_SYSTEM_PROMPT = [
  "You are PreFlight's high-tier Reasoning Engine for deep multi-file remediation.",
  "Analyze the unified diff and touched file contents for architectural drift, auth regressions, tenant isolation bugs, RLS bypasses, middleware bypasses, webhook idempotency regressions, and unsafe cross-file wrapper changes.",
  "Return strict valid JSON only. No markdown, no backticks, no prose outside JSON.",
  "CRITICAL: Minimize internal reasoning steps. Generate the target JSON payload immediately. Do not append conversational preambles or post-analysis text.",
  "The JSON shape must be exactly:",
  "{\"patches\":[{\"file_path\":\"...\",\"action\":\"update|create|delete\",\"new_content\":\"...\"}],\"explanation\":\"Plain-English QA explanation\"}",
  "Use action update to replace an existing file with new_content, create to create a new file with new_content, and delete to remove a file. For delete, new_content must be an empty string.",
  "Keep file_path relative to the repository root. Never use absolute paths or parent-directory traversal.",
  "The explanation must tell the developer what changed and what manual QA should verify after applying the architectural patch.",
  "Keep explanation extremely short: at most 3 sentences and under 120 words total.",
  "CRITICAL UX CONSTRAINT: The 'explanation' field in your JSON output MUST be a single, short sentence (maximum 20 words) focused strictly on the core fix. Do not provide background commentary, validation checklists, or instructions to manually verify the code. Keep it brief and immediate."
].join("\n");

const MICRO_ROUTER_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    requires_deep_scan: { type: "boolean" }
  },
  required: ["requires_deep_scan"]
};

const CLOUD_VERDICT_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    state: { type: "string", enum: ["RED", "YELLOW", "GREEN"] },
    reasoning: { type: "string" },
    manual_qa_line: { type: ["string", "null"] },
    auto_patch: { type: ["string", "null"] }
  },
  required: ["state", "reasoning", "manual_qa_line", "auto_patch"]
};

const REASONING_PATCH_SET_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    patches: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          file_path: { type: "string" },
          action: { type: "string", enum: ["update", "create", "delete"] },
          new_content: { type: "string" }
        },
        required: ["file_path", "action", "new_content"]
      }
    },
    explanation: { type: "string" }
  },
  required: ["patches", "explanation"]
};

function assertDiff(diff) {
  if (typeof diff !== "string") {
    throw new TypeError("Cloud fallback requires a diff string.");
  }

  if (Buffer.byteLength(diff, "utf8") === 0) {
    throw new Error("Cloud fallback received an empty diff.");
  }
}

function compactDiffForMicroRouter(diff, options = {}) {
  assertDiff(diff);
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : DEFAULT_MICRO_ROUTER_DIFF_BYTES;
  const keptLines = [];

  for (const line of diff.split(/\r?\n/)) {
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("@@ ") ||
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---"))
    ) {
      keptLines.push(line);
    }
  }

  const compacted = keptLines.join("\n").trim() || diff.trim();
  const bytes = Buffer.from(compacted, "utf8");
  if (bytes.length <= maxBytes) {
    return compacted;
  }

  return Buffer.from(bytes.subarray(0, maxBytes)).toString("utf8");
}

function truncateUtf8(value, maxBytes) {
  const text = String(value || "");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return text;
  }

  return `${Buffer.from(bytes.subarray(0, maxBytes)).toString("utf8")}\n[PreFlight truncated context]`;
}

function normalizeTouchedFiles(files = [], options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : DEFAULT_REASONING_CONTEXT_BYTES;
  const normalized = [];
  let remainingBytes = maxBytes;

  for (const file of Array.isArray(files) ? files : []) {
    const filePath = file.filePath || file.path || file.relativePath || file.file_path;
    if (typeof filePath !== "string" || !filePath.trim()) {
      continue;
    }

    const content = typeof file.content === "string"
      ? file.content
      : typeof file.sourceCode === "string"
        ? file.sourceCode
        : "";
    const sliceBytes = Math.max(0, Math.min(remainingBytes, Buffer.byteLength(content, "utf8")));
    normalized.push({
      file_path: filePath.trim().replace(/\\/g, "/"),
      content: truncateUtf8(content, sliceBytes)
    });
    remainingBytes -= sliceBytes;

    if (remainingBytes <= 0) {
      break;
    }
  }

  return normalized;
}

function buildReasoningContextPrompt({ diff, files = [] }, options = {}) {
  assertDiff(diff);
  const maxContextBytes = options.maxContextBytes || DEFAULT_REASONING_CONTEXT_BYTES;

  return JSON.stringify({
    unified_diff: truncateUtf8(diff, maxContextBytes),
    touched_files: normalizeTouchedFiles(files, { maxBytes: maxContextBytes })
  });
}

function normalizeAction(mode = "manual-qa") {
  if (mode !== "manual-qa" && mode !== "auto-heal") {
    throw new Error("Cloud fallback mode must be manual-qa or auto-heal.");
  }

  return mode;
}

function assertLicenseKey(licenseKey) {
  if (typeof licenseKey !== "string" || licenseKey.trim().length < 12) {
    throw new PreFlightPaymentRequiredError(PRO_ENGINE_CONNECTION_ERROR);
  }

  return licenseKey.trim();
}

function resolveProxyLicenseKey(env = process.env, options = {}) {
  const configuredKey = options.licenseKey || env.PREFLIGHT_PRO_KEY || env.PREFLIGHT_PRO_LICENSE_KEY;
  if (configuredKey) {
    return {
      licenseKey: assertLicenseKey(configuredKey),
      freeFix: false
    };
  }

  if (options.allowFreeProxy === true || options.freeFix === true) {
    return {
      licenseKey: FREE_FIX_PROXY_TOKEN,
      freeFix: true
    };
  }

  return {
    licenseKey: assertLicenseKey(configuredKey),
    freeFix: false
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function buildCloudPayload(diff, options = {}) {
  assertDiff(diff);
  const requestedAction = normalizeAction(options.mode);
  const files = normalizeTouchedFiles(options.files || [], {
    maxBytes: options.maxContextBytes || DEFAULT_REASONING_CONTEXT_BYTES
  });

  const payload = {
    diff,
    diffSha256: sha256(diff),
    metadata: {
      hostnameHash: sha256(os.hostname()),
      platform: os.platform(),
      repoId: options.repoId || null,
      timestamp: new Date().toISOString()
    },
    requestedAction
  };

  if (files.length > 0) {
    payload.files = files;
  }

  return payload;
}

function buildDiffAnalysisPrompt(diff, options = {}) {
  assertDiff(diff);
  const payload = buildCloudPayload(diff, options);
  return [
    "Analyze this git diff using the required JSON schema.",
    "",
    `Diff SHA-256: ${payload.diffSha256}`,
    `Requested action: ${payload.requestedAction}`,
    "",
    "```diff",
    diff,
    "```"
  ].join("\n");
}

function extractCloudMessageText(response) {
  const text = response?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || text.trim() === "") {
    throw new Error("Cloud API response did not include message content.");
  }

  return text.trim();
}

function statusCodeFromError(error) {
  const status = error?.status ?? error?.response?.status ?? error?.code;
  const numericStatus = Number(status);
  return Number.isFinite(numericStatus) ? numericStatus : null;
}

function isPaymentRequiredError(error) {
  return error instanceof PreFlightPaymentRequiredError || statusCodeFromError(error) === 402;
}

function isManualReviewRequiredError(error) {
  return error instanceof ManualReviewRequiredError || error?.code === "PREFLIGHT_MANUAL_REVIEW_REQUIRED";
}

function stripMarkdownFenceText(value) {
  const text = String(value || "").trim();
  const fenced = text.match(/^```[A-Za-z0-9_-]*\s*\r?\n([\s\S]*?)\r?\n```$/);
  return (fenced ? fenced[1] : text).trim();
}

function assertCloudPayloadCanAutoApply(value) {
  if (stripMarkdownFenceText(value) === MANUAL_REVIEW_REQUIRED) {
    throw new ManualReviewRequiredError();
  }
}

function parseJsonObject(text) {
  const normalized = stripMarkdownFenceText(text);
  const candidates = [normalized];
  const firstBrace = normalized.indexOf("{");
  const lastBrace = normalized.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(normalized.slice(firstBrace, lastBrace + 1));
  }

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("JSON root must be an object.");
      }
      return parsed;
    } catch (error) {
      lastError = error;
    }
  }

  try {
    throw new Error(`Cloud API returned invalid JSON: ${lastError?.message || "Unknown parse failure"}`);
  } catch (error) {
    throw error;
  }
}

function buildStructuredResponseFormat(provider, name, schema) {
  if (provider?.provider === "anthropic") {
    return {
      type: "json_schema",
      json_schema: {
        name,
        strict: true,
        schema
      }
    };
  }

  return { type: "json_object" };
}

function validateMicroRouterVerdict(verdict) {
  const allowedKeys = new Set(["requires_deep_scan"]);
  for (const key of Object.keys(verdict)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Micro-router verdict included unexpected key: ${key}`);
    }
  }

  if (typeof verdict.requires_deep_scan !== "boolean") {
    throw new Error("Micro-router verdict must include boolean requires_deep_scan.");
  }

  return {
    requires_deep_scan: verdict.requires_deep_scan
  };
}

function validateCloudVerdict(verdict) {
  const allowedKeys = new Set(["state", "reasoning", "manual_qa_line", "auto_patch"]);
  for (const key of Object.keys(verdict)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Cloud verdict included unexpected key: ${key}`);
    }
  }

  for (const key of allowedKeys) {
    if (!Object.prototype.hasOwnProperty.call(verdict, key)) {
      throw new Error(`Cloud verdict must include ${key}.`);
    }
  }

  if (!["RED", "YELLOW", "GREEN"].includes(verdict.state)) {
    throw new Error("Cloud verdict state must be RED, YELLOW, or GREEN.");
  }

  if (typeof verdict.reasoning !== "string" || verdict.reasoning.trim() === "") {
    throw new Error("Cloud verdict reasoning must be a non-empty string.");
  }

  if (verdict.state === "YELLOW") {
    if (typeof verdict.manual_qa_line !== "string" || verdict.manual_qa_line.trim() === "") {
      throw new Error("Cloud verdict manual_qa_line must be a non-empty string for YELLOW.");
    }
  } else if (verdict.manual_qa_line !== null) {
    throw new Error("Cloud verdict manual_qa_line must be null for RED or GREEN.");
  }

  if (verdict.state === "RED") {
    if (typeof verdict.auto_patch !== "string" || verdict.auto_patch.trim() === "") {
      throw new Error("Cloud verdict auto_patch must be a non-empty unified diff for RED.");
    }
  } else if (verdict.auto_patch !== null) {
    throw new Error("Cloud verdict auto_patch must be null for YELLOW or GREEN.");
  }

  return {
    state: verdict.state,
    reasoning: verdict.reasoning,
    manual_qa_line: verdict.manual_qa_line,
    auto_patch: verdict.auto_patch
  };
}

function resolveCloudProvider(env = process.env, options = {}) {
  const resolvedAuth = resolveProxyLicenseKey(env, options);
  return {
    endpoint: options.endpoint || env.PREFLIGHT_CLOUD_ENDPOINT || DEFAULT_CLOUD_ENDPOINT,
    licenseKey: resolvedAuth.licenseKey,
    freeFix: resolvedAuth.freeFix,
    provider: "preflight-proxy"
  };
}

function createCloudClient(options = {}) {
  return options.client || null;
}

function resolveMicroRouterTimeoutMs(env = process.env, options = {}) {
  const configuredTimeout = options.timeoutMs ?? env.PREFLIGHT_MICRO_TIMEOUT_MS;
  const timeoutMs = Number(configuredTimeout);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_MICRO_ROUTER_TIMEOUT_MS;
}

function resolveMicroRouterProvider(env = process.env, options = {}) {
  const timeoutMs = resolveMicroRouterTimeoutMs(env, options);
  const explicitBaseURL = options.baseURL || env.PREFLIGHT_LOCAL_LLM_URL;
  const explicitApiKey = options.apiKey || env.PREFLIGHT_LOCAL_LLM_API_KEY;

  return {
    apiKey: explicitApiKey || "ollama",
    baseURL: explicitBaseURL || DEFAULT_LOCAL_LLM_BASE_URL,
    model: options.model || env.PREFLIGHT_MICRO_MODEL || DEFAULT_LOCAL_MICRO_MODEL,
    provider: "ollama",
    timeoutMs
  };
}

function createMicroRouterClient(provider, options = {}) {
  if (options.client) {
    return options.client;
  }

  return new OpenAI({
    apiKey: provider.apiKey,
    baseURL: provider.baseURL,
    maxRetries: 0
  });
}

function resolveReasoningEngineProvider(env = process.env, options = {}) {
  const timeoutMs = Number(options.timeoutMs || env.PREFLIGHT_REASONING_TIMEOUT_MS);
  const resolvedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_REASONING_TIMEOUT_MS;
  const resolvedAuth = resolveProxyLicenseKey(env, options);
  return {
    endpoint: options.endpoint || env.PREFLIGHT_CLOUD_ENDPOINT || DEFAULT_CLOUD_ENDPOINT,
    licenseKey: resolvedAuth.licenseKey,
    freeFix: resolvedAuth.freeFix,
    provider: "preflight-proxy",
    timeoutMs: resolvedTimeout
  };
}

function createReasoningEngineClient(provider, options = {}) {
  return options.client || null;
}

class MicroRouter {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.provider = resolveMicroRouterProvider(this.env, options);
    this.client = createMicroRouterClient(this.provider, options);
    this.maxDiffBytes = options.maxDiffBytes || DEFAULT_MICRO_ROUTER_DIFF_BYTES;
  }

  async evaluate(diff, options = {}) {
    try {
      assertDiff(diff);
      const compactDiff = compactDiffForMicroRouter(diff, {
        maxBytes: options.maxDiffBytes || this.maxDiffBytes
      });
      const response = await this.client.chat.completions.create(
        {
          model: options.model || this.provider.model,
          messages: [
            {
              role: "system",
              content: MICRO_ROUTER_SYSTEM_PROMPT
            },
            {
              role: "user",
              content: [
                "Decide whether this compact git diff needs deep security tracing.",
                "",
                "```diff",
                compactDiff,
                "```"
              ].join("\n")
            }
          ],
          response_format: buildStructuredResponseFormat(
            this.provider,
            "preflight_micro_router_verdict",
            MICRO_ROUTER_RESPONSE_SCHEMA
          ),
          max_tokens: options.maxTokens || DEFAULT_MICRO_ROUTER_MAX_TOKENS,
          temperature: 0
        },
        { timeout: options.timeoutMs || this.provider.timeoutMs }
      );

      return {
        ...validateMicroRouterVerdict(parseJsonObject(extractCloudMessageText(response))),
        routed: "micro",
        fallback: false
      };
    } catch (error) {
      return {
        requires_deep_scan: true,
        routed: "micro",
        fallback: true,
        reason: error.message || "Micro-router failed closed."
      };
    }
  }
}

class ReasoningEngine {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.provider = resolveReasoningEngineProvider(this.env, options);
    this.transport = typeof options.transport === "function" ? options.transport : createProxyTransport(this.provider);
    this.maxContextBytes = options.maxContextBytes || DEFAULT_REASONING_CONTEXT_BYTES;
  }

  async generatePatchSet(context, options = {}) {
    try {
      const response = await requestCloudScan(context.diff, {
        endpoint: options.endpoint || this.provider.endpoint,
        files: context.files || [],
        licenseKey: options.licenseKey || this.provider.licenseKey,
        freeFix: options.freeFix === true || this.provider.freeFix === true,
        maxContextBytes: options.maxContextBytes || this.maxContextBytes,
        mode: "auto-heal",
        timeoutMs: options.timeoutMs || this.provider.timeoutMs,
        transport: this.transport
      });
      const patchPayload = response?.patchSet || response;
      if (typeof patchPayload === "string") {
        assertCloudPayloadCanAutoApply(patchPayload);
        return parseMultiFileRemediationJson(patchPayload);
      }
      return parseMultiFileRemediationJson(patchPayload);
    } catch (error) {
      if (isManualReviewRequiredError(error)) {
        throw error;
      }

      throw new PreFlightPaymentRequiredError(PRO_ENGINE_CONNECTION_ERROR);
    }
  }
}

async function routeDeepRemediation(options = {}) {
  const diff = options.diff;
  const files = options.files || [];
  assertDiff(diff);

  const microRouter = options.microRouter || new MicroRouter(options.microRouterOptions || options);
  const microDecision = await microRouter.evaluate(diff);
  if (!microDecision.requires_deep_scan) {
    return {
      routed: "micro",
      requires_deep_scan: false,
      patchSet: null
    };
  }

  const reasoningEngine = options.reasoningEngine || new ReasoningEngine(options.reasoningOptions || options);
  const patchSet = await reasoningEngine.generatePatchSet({ diff, files });
  return {
    routed: "reasoning",
    requires_deep_scan: true,
    microDecision,
    patchSet
  };
}

async function callCloudDiffAnalyzer(diff, options = {}) {
  assertDiff(diff);
  try {
    const provider = options.provider || resolveCloudProvider(process.env, options);
    const response = await requestCloudScan(diff, {
      endpoint: options.endpoint || provider.endpoint,
      files: options.files || [],
      licenseKey: options.licenseKey || provider.licenseKey,
      freeFix: options.freeFix === true || provider.freeFix === true,
      mode: options.mode || "manual-qa",
      timeoutMs: options.timeoutMs,
      transport: options.transport
    });
    return validateCloudVerdict(response?.verdict || response);
  } catch (error) {
    if (isManualReviewRequiredError(error)) {
      throw error;
    }

    throw new PreFlightPaymentRequiredError(PRO_ENGINE_CONNECTION_ERROR);
  }
}

async function analyzeDiffWithCloud(diff, options = {}) {
  const canRunLocal = typeof options.canRunLocal === "boolean"
    ? options.canRunLocal
    : evaluateHardware(options.hardware || {});

  if (canRunLocal) {
    return {
      routed: "local",
      verdict: null
    };
  }

  const verdict = await callCloudDiffAnalyzer(diff, options);
  return {
    routed: "cloud",
    verdict
  };
}

function prepareCloudFallback(diff, options = {}) {
  const resolvedAuth = resolveProxyLicenseKey(process.env, options);
  const licenseKey = resolvedAuth.licenseKey;
  const endpoint = options.endpoint || process.env.PREFLIGHT_CLOUD_ENDPOINT || DEFAULT_CLOUD_ENDPOINT;
  const payload = buildCloudPayload(diff, options);

  return {
    endpoint,
    headers: {
      Authorization: `Bearer ${licenseKey}`,
      ...(resolvedAuth.freeFix ? { "X-PreFlight-Free-Fix": "1" } : { "X-PreFlight-Pro-Key": licenseKey }),
      "Content-Type": "application/json",
      "X-PreFlight-Diff-SHA256": payload.diffSha256
    },
    logSafeSummary:
      `Cloud fallback prepared for ${payload.requestedAction}; ` +
      `diff=${payload.diffSha256.slice(0, 12)}; endpoint=${endpoint}`,
    method: "POST",
    payload
  };
}

function isDirectPreflightProxyEndpoint(endpoint) {
  return typeof endpoint === "string" && /\/api\/v1\/(?:remediation|remediate)\/?$/i.test(endpoint.trim());
}

function extractPreflightProxyLicenseKey(headers = {}) {
  const authorizationHeader = headers.Authorization || headers.authorization;
  if (typeof authorizationHeader === "string") {
    const match = authorizationHeader.trim().match(/^Bearer\s+(.+)$/i);
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }

  const legacyHeader = headers["X-PreFlight-Pro-Key"] || headers["x-preflight-pro-key"];
  return typeof legacyHeader === "string" ? legacyHeader.trim() : "";
}

function createProxyTransport(options = {}) {
  return async (request) => new Promise((resolve, reject) => {
    const url = new URL(request.endpoint);
    const body = JSON.stringify(request.payload);
    const req = https.request(
      url,
      {
        method: request.method || "POST",
        headers: {
          ...request.headers,
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
          const status = response.statusCode || 500;
          if (status === 401 || status === 402 || status === 403) {
            reject(new PreFlightPaymentRequiredError(PRO_ENGINE_CONNECTION_ERROR));
            return;
          }
          if (status < 200 || status >= 300) {
            reject(new PreFlightPaymentRequiredError(PRO_ENGINE_CONNECTION_ERROR));
            return;
          }

          const trimmed = responseBody.trim();
          if (!trimmed) {
            resolve({});
            return;
          }

          if (stripMarkdownFenceText(trimmed) === MANUAL_REVIEW_REQUIRED) {
            resolve(trimmed);
            return;
          }

          try {
            resolve(JSON.parse(trimmed));
          } catch {
            reject(new PreFlightPaymentRequiredError(PRO_ENGINE_CONNECTION_ERROR));
          }
        });
      }
    );

    req.setTimeout(options.timeoutMs || DEFAULT_REASONING_TIMEOUT_MS, () => {
      req.destroy(new PreFlightPaymentRequiredError(PRO_ENGINE_CONNECTION_ERROR));
    });
    req.on("error", () => {
      reject(new PreFlightPaymentRequiredError(PRO_ENGINE_CONNECTION_ERROR));
    });
    req.write(body);
    req.end();
  });
}

async function requestCloudScan(diff, options = {}) {
  const request = prepareCloudFallback(diff, options);
  if (isDirectPreflightProxyEndpoint(request.endpoint)) {
    const requestedAction = normalizeAction(options.mode);
    const response = await requestPreflightProxy({
      endpoint: request.endpoint,
      licenseKey: options.licenseKey || extractPreflightProxyLicenseKey(request.headers),
      freeFix: options.freeFix === true || request.headers["X-PreFlight-Free-Fix"] === "1",
      system: requestedAction === "auto-heal"
        ? REASONING_ENGINE_SYSTEM_PROMPT
        : PREFLIGHT_SYSTEM_PROMPT,
      userContent: requestedAction === "auto-heal"
        ? buildReasoningContextPrompt({ diff, files: options.files || [] }, {
            maxContextBytes: options.maxContextBytes || DEFAULT_REASONING_CONTEXT_BYTES
          })
        : buildDiffAnalysisPrompt(diff, options),
      maxTokens: requestedAction === "auto-heal"
        ? options.maxTokens || DEFAULT_REASONING_MAX_TOKENS
        : options.maxTokens || DEFAULT_CLOUD_VERDICT_MAX_TOKENS,
      temperature: 0,
      timeoutMs: options.timeoutMs,
      transport: options.transport
    });
    if (typeof response === "string") {
      if (requestedAction === "auto-heal" && stripMarkdownFenceText(response) === MANUAL_REVIEW_REQUIRED) {
        return response;
      }
      return parseJsonObject(response);
    }
    if (response && typeof response === "object" && !Array.isArray(response) && !Array.isArray(response.content)) {
      return response;
    }
    const text = extractPreflightProxyText(response);
    if (requestedAction === "auto-heal" && stripMarkdownFenceText(text) === MANUAL_REVIEW_REQUIRED) {
      return text;
    }
    return parseJsonObject(text);
  }

  if (typeof options.transport === "function") {
    return options.transport(request);
  }

  const transport = createProxyTransport(options);
  return transport(request);
}

module.exports = {
  analyzeDiffWithCloud,
  buildCloudPayload,
  buildDiffAnalysisPrompt,
  buildReasoningContextPrompt,
  callCloudDiffAnalyzer,
  compactDiffForMicroRouter,
  createCloudClient,
  createMicroRouterClient,
  createReasoningEngineClient,
  DEFAULT_CLOUD_ENDPOINT,
  DEFAULT_CLOUD_MODEL,
  DEFAULT_REASONING_MODEL,
  DEFAULT_LOCAL_LLM_BASE_URL,
  DEFAULT_LOCAL_MICRO_MODEL,
  DEFAULT_MICRO_ROUTER_DIFF_BYTES,
  DEFAULT_MICRO_ROUTER_TIMEOUT_MS,
  DEFAULT_OPENROUTER_BASE_URL,
  DEFAULT_OPENROUTER_MICRO_MODEL,
  DEFAULT_REASONING_CONTEXT_BYTES,
  DEFAULT_REASONING_TIMEOUT_MS,
  assertCloudPayloadCanAutoApply,
  isManualReviewRequiredError,
  isPaymentRequiredError,
  MANUAL_REVIEW_MESSAGE,
  MANUAL_REVIEW_REQUIRED,
  ManualReviewRequiredError,
  MicroRouter,
  MICRO_ROUTER_SYSTEM_PROMPT,
  prepareCloudFallback,
  parseJsonObject,
  PREFLIGHT_SYSTEM_PROMPT,
  PreFlightPaymentRequiredError,
  PRO_ENGINE_CONNECTION_ERROR,
  ReasoningEngine,
  REASONING_ENGINE_SYSTEM_PROMPT,
  resolveReasoningEngineProvider,
  resolveMicroRouterProvider,
  resolveMicroRouterTimeoutMs,
  routeDeepRemediation,
  requestCloudScan
};
