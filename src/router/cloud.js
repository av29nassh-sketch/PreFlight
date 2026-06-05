const crypto = require("node:crypto");
const os = require("node:os");
const OpenAIImport = require("openai");
const { evaluateHardware } = require("./hardware");

const DEFAULT_CLOUD_ENDPOINT = "https://api.preflight.dev/v1/scan";
const DEFAULT_CLOUD_MODEL = "gpt-4o-mini";
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

function assertDiff(diff) {
  if (typeof diff !== "string") {
    throw new TypeError("Cloud fallback requires a diff string.");
  }

  if (Buffer.byteLength(diff, "utf8") === 0) {
    throw new Error("Cloud fallback received an empty diff.");
  }
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
  createCloudClient,
  DEFAULT_CLOUD_ENDPOINT,
  DEFAULT_CLOUD_MODEL,
  prepareCloudFallback,
  PREFLIGHT_SYSTEM_PROMPT,
  requestCloudScan
};
