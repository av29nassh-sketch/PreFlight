const crypto = require("node:crypto");
const os = require("node:os");
const OpenAIImport = require("openai");
const { evaluateHardware } = require("./hardware");

const DEFAULT_CLOUD_ENDPOINT = "https://api.preflight.dev/v1/scan";
const DEFAULT_CLOUD_MODEL = "gpt-4o-mini";
const DEFAULT_LOCAL_LLM_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_LOCAL_MICRO_MODEL = "qwen2.5-coder:0.5b";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_MICRO_MODEL = "qwen/qwen3-coder:free";
const DEFAULT_MICRO_ROUTER_TIMEOUT_MS = 5000;
const DEFAULT_MICRO_ROUTER_DIFF_BYTES = 12000;
const OpenAI = OpenAIImport.default || OpenAIImport;

const PREFLIGHT_SYSTEM_PROMPT = `
You are PreFlight, a zero-tolerance AI security guardrail operating inside a developer's local pre-commit hook.
Your job is to analyze git diffs for structural and logical vulnerabilities silently injected by other AI coding agents.

You must evaluate the provided diff and output strictly in valid JSON format. No markdown blocks, no conversational text.

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
  "Return true ONLY for structural, architectural, authorization, authentication, tenant isolation, RLS, middleware, webhook, billing, database policy, RPC, or security boundary changes.",
  "Return false for cosmetic edits, copy changes, simple type fixes, formatting, comments, tests without production security impact, and ordinary local variable changes."
].join("\n");

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

function normalizeAction(mode = "manual-qa") {
  if (mode !== "manual-qa" && mode !== "auto-heal") {
    throw new Error("Cloud fallback mode must be manual-qa or auto-heal.");
  }

  return mode;
}

function assertLicenseKey(licenseKey) {
  if (typeof licenseKey !== "string" || licenseKey.trim().length < 12) {
    throw new Error("A valid PreFlight Pro license key is required for cloud fallback.");
  }

  return licenseKey.trim();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function buildCloudPayload(diff, options = {}) {
  assertDiff(diff);
  const requestedAction = normalizeAction(options.mode);

  return {
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

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON root must be an object.");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Cloud API returned invalid JSON: ${error.message}`);
  }
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

function createCloudClient(options = {}) {
  if (options.client) {
    return options.client;
  }

  const apiKey = options.apiKey || process.env.PREFLIGHT_CLOUD_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Cloud fallback requires PREFLIGHT_CLOUD_API_KEY or OPENAI_API_KEY.");
  }

  return new OpenAI({
    apiKey,
    ...(options.baseURL || process.env.PREFLIGHT_CLOUD_BASE_URL
      ? { baseURL: options.baseURL || process.env.PREFLIGHT_CLOUD_BASE_URL }
      : {})
  });
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

  if (!explicitBaseURL && !explicitApiKey && env.OPENROUTER_API_KEY) {
    return {
      apiKey: env.OPENROUTER_API_KEY,
      baseURL: options.openRouterBaseURL || env.OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE_URL,
      model: options.model || env.PREFLIGHT_MICRO_MODEL || DEFAULT_OPENROUTER_MICRO_MODEL,
      provider: "openrouter",
      timeoutMs
    };
  }

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
          response_format: { type: "json_object" },
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

async function callCloudDiffAnalyzer(diff, options = {}) {
  assertDiff(diff);
  const client = createCloudClient(options);
  const response = await client.chat.completions.create({
    model: options.model || process.env.PREFLIGHT_CLOUD_MODEL || DEFAULT_CLOUD_MODEL,
    messages: [
      {
        role: "system",
        content: PREFLIGHT_SYSTEM_PROMPT
      },
      {
        role: "user",
        content: buildDiffAnalysisPrompt(diff, options)
      }
    ],
    response_format: { type: "json_object" },
    temperature: 0
  });

  return validateCloudVerdict(parseJsonObject(extractCloudMessageText(response)));
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
  const licenseKey = assertLicenseKey(options.licenseKey || process.env.PREFLIGHT_PRO_LICENSE_KEY);
  const endpoint = options.endpoint || DEFAULT_CLOUD_ENDPOINT;
  const payload = buildCloudPayload(diff, options);

  return {
    endpoint,
    headers: {
      Authorization: `Bearer ${licenseKey}`,
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

async function requestCloudScan(diff, options = {}) {
  const transport = options.transport;
  if (typeof transport !== "function") {
    throw new Error("Cloud API transport is not configured. Pass a transport function to requestCloudScan.");
  }

  const request = prepareCloudFallback(diff, options);
  return transport(request);
}

module.exports = {
  analyzeDiffWithCloud,
  buildCloudPayload,
  buildDiffAnalysisPrompt,
  callCloudDiffAnalyzer,
  compactDiffForMicroRouter,
  createCloudClient,
  createMicroRouterClient,
  DEFAULT_CLOUD_ENDPOINT,
  DEFAULT_CLOUD_MODEL,
  DEFAULT_LOCAL_LLM_BASE_URL,
  DEFAULT_LOCAL_MICRO_MODEL,
  DEFAULT_MICRO_ROUTER_DIFF_BYTES,
  DEFAULT_MICRO_ROUTER_TIMEOUT_MS,
  DEFAULT_OPENROUTER_BASE_URL,
  DEFAULT_OPENROUTER_MICRO_MODEL,
  MicroRouter,
  MICRO_ROUTER_SYSTEM_PROMPT,
  prepareCloudFallback,
  PREFLIGHT_SYSTEM_PROMPT,
  resolveMicroRouterProvider,
  resolveMicroRouterTimeoutMs,
  requestCloudScan
};
