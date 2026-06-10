const fs = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");
const ParserBinding = require("web-tree-sitter");
const OpenAIImport = require("openai");

const Parser = ParserBinding.Parser || ParserBinding.default?.Parser || ParserBinding.default || ParserBinding;
const Language = ParserBinding.Language || ParserBinding.default?.Language;
const OpenAI = OpenAIImport.default || OpenAIImport;

const SQL_KEYWORD_PATTERN = /\b(?:SELECT|INSERT|UPDATE|DELETE)\b/i;
const SURGICAL_LLM_SYSTEM_PROMPT =
  "You are a specialized code refactoring utility. Convert the provided insecure JavaScript/TypeScript string concatenation into a completely secure, parameterized query format using standard placeholder symbols ($1, $2, etc.). Return ONLY the executable, corrected code fragment. Do not output markdown code blocks, backticks, or text explanations.";
const DEFAULT_GEMINI_MODEL = "gemini-1.5-flash";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_OPENROUTER_MODEL = "qwen/qwen3-coder:free";
const DEFAULT_LLM_TIMEOUT_MS = 15000;
const GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const MANUAL_REVIEW_REQUIRED = "MANUAL_REVIEW_REQUIRED";
const MANUAL_REVIEW_MESSAGE =
  "⚠️ Manual Review Recommended: This vulnerability requires specific architectural context to fix safely. PreFlight has skipped auto-remediation to protect your build logic.";
const FREE_SQL_REMEDIATION_MESSAGE = [
  "=========================================",
  "💡 SQL Remediation is available for FREE!",
  "=========================================",
  "To automatically fix SQL injections, get a free API key:",
  "1. Go to Google AI Studio (https://aistudio.google.com/)",
  "2. Generate a free API key.",
  "3. Add it to your IDE/Environment as: GEMINI_API_KEY",
  "=========================================",
  "[SKIP] Skipping LLM SQL remediation for this run."
].join("\n");

function formatProviderFailureMessage(error, provider) {
  const status = error?.status || error?.code || "unknown";
  const detail = error?.message || "Provider request failed";
  const providerLabel = provider?.provider || "custom";
  const modelLabel = provider?.model || "unknown-model";
  return [
    "=========================================",
    "[SKIP] SQL remediation provider failed.",
    `Provider: ${providerLabel}`,
    `Model: ${modelLabel}`,
    `Error: ${status} ${detail}`,
    "Local scan will continue without applying the SQL auto-fix.",
    "========================================="
  ].join("\n");
}

let parserReady;
let javascriptLanguage;

async function initializeParser() {
  if (!parserReady) {
    parserReady = Parser.init?.();
  }

  if (parserReady) {
    await parserReady;
  }

  if (!javascriptLanguage) {
    const wasmPath = require.resolve("tree-sitter-javascript/tree-sitter-javascript.wasm");
    javascriptLanguage = await Language.load(wasmPath);
  }
}

async function parseJavaScript(sourceCode) {
  await initializeParser();
  const parser = new Parser();
  parser.setLanguage(javascriptLanguage);
  return parser.parse(sourceCode);
}

function getNodeText(node, sourceCode) {
  return sourceCode.slice(node.startIndex, node.endIndex);
}

function toByteIndex(sourceCode, stringIndex) {
  return Buffer.byteLength(sourceCode.slice(0, stringIndex), "utf8");
}

function getOperator(node, sourceCode) {
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (!child.isNamed && getNodeText(child, sourceCode).trim() === "+") {
      return "+";
    }
  }

  return null;
}

function getFieldNode(node, fieldName) {
  if (typeof node.childForFieldName === "function") {
    return node.childForFieldName(fieldName);
  }

  return null;
}

function nodeContainsSqlKeyword(node, sourceCode) {
  return Boolean(node && SQL_KEYWORD_PATTERN.test(getNodeText(node, sourceCode)));
}

function makeMatch(node, sourceCode) {
  const rawSnippet = getNodeText(node, sourceCode);
  const startIndex = toByteIndex(sourceCode, node.startIndex);
  return {
    startIndex,
    endIndex: startIndex + Buffer.byteLength(rawSnippet, "utf8"),
    rawSnippet
  };
}

function findSqlConcatenations(node, sourceCode, matches = []) {
  if (!node) {
    return matches;
  }

  if (node.type === "binary_expression" && getOperator(node, sourceCode) === "+") {
    const left = getFieldNode(node, "left");
    const right = getFieldNode(node, "right");

    if (nodeContainsSqlKeyword(left, sourceCode) || nodeContainsSqlKeyword(right, sourceCode)) {
      matches.push(makeMatch(node, sourceCode));
    }
  }

  for (let index = 0; index < node.namedChildCount; index += 1) {
    findSqlConcatenations(node.namedChild(index), sourceCode, matches);
  }

  return matches;
}

function treeContainsUnsafeNode(node) {
  if (!node) {
    return false;
  }

  const isMissing = typeof node.isMissing === "function" ? node.isMissing() : node.isMissing === true;
  if (node.type === "ERROR" || node.type === "MISSING" || isMissing) {
    return true;
  }

  for (let index = 0; index < node.childCount; index += 1) {
    if (treeContainsUnsafeNode(node.child(index))) {
      return true;
    }
  }

  return false;
}

async function verifySyntaxSafety(proposedFix) {
  const tree = await parseJavaScript(proposedFix);
  try {
    if (treeContainsUnsafeNode(tree.rootNode)) {
      throw new Error("Remediation Syntax Violation");
    }
  } finally {
    tree.delete?.();
  }

  return true;
}

function resolveLlmProvider(env = process.env, options = {}) {
  const modelOverride = options.model || env.MODEL_NAME;

  if (env.GEMINI_API_KEY) {
    return {
      apiKey: env.GEMINI_API_KEY,
      baseURL: GEMINI_OPENAI_BASE_URL,
      model: modelOverride || DEFAULT_GEMINI_MODEL,
      provider: "gemini"
    };
  }

  if (env.OPENROUTER_API_KEY) {
    return {
      apiKey: env.OPENROUTER_API_KEY,
      baseURL: OPENROUTER_BASE_URL,
      model: modelOverride || DEFAULT_OPENROUTER_MODEL,
      provider: "openrouter"
    };
  }

  if (env.OPENAI_API_KEY) {
    return {
      apiKey: env.OPENAI_API_KEY,
      baseURL: undefined,
      model: modelOverride || DEFAULT_OPENAI_MODEL,
      provider: "openai"
    };
  }

  return null;
}

function extractChatCompletionText(response) {
  return (response.choices?.[0]?.message?.content || "").trim();
}

function parseMultiFileRemediationJson(text) {
  let parsed;
  try {
    parsed = typeof text === "string" ? JSON.parse(text) : text;
  } catch (error) {
    throw new Error(`Deep remediation returned invalid JSON: ${error.message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Deep remediation JSON root must be an object.");
  }

  const keys = Object.keys(parsed);
  for (const key of keys) {
    if (key !== "patches" && key !== "explanation") {
      throw new Error(`Deep remediation JSON included unexpected key: ${key}`);
    }
  }

  if (!Array.isArray(parsed.patches)) {
    throw new Error("Deep remediation JSON must include patches array.");
  }

  if (typeof parsed.explanation !== "string" || parsed.explanation.trim() === "") {
    throw new Error("Deep remediation JSON must include explanation.");
  }

  return {
    patches: parsed.patches.map((patch, index) => normalizeMultiFilePatch(patch, index)),
    explanation: parsed.explanation.trim()
  };
}

function normalizePatchRelativePath(filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new Error("Patch file_path must be a non-empty string.");
  }

  const normalized = filePath.trim().replace(/\\/g, "/");
  if (path.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error("Patch file_path must stay inside the workspace.");
  }

  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "..")) {
    throw new Error("Patch file_path must stay inside the workspace.");
  }

  return parts.join("/");
}

function normalizeMultiFilePatch(patch, index) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error(`Patch ${index} must be an object.`);
  }

  const keys = Object.keys(patch);
  for (const key of keys) {
    if (key !== "file_path" && key !== "action" && key !== "new_content") {
      throw new Error(`Patch ${index} included unexpected key: ${key}`);
    }
  }

  if (!["update", "create", "delete"].includes(patch.action)) {
    throw new Error(`Patch ${index} action must be update, create, or delete.`);
  }

  if (typeof patch.new_content !== "string") {
    throw new Error(`Patch ${index} new_content must be a string.`);
  }

  return {
    filePath: normalizePatchRelativePath(patch.file_path),
    action: patch.action,
    newContent: patch.new_content
  };
}

function resolveWorkspacePatchPath(rootDir, filePath) {
  const resolvedRoot = path.resolve(rootDir || process.cwd());
  const resolvedPath = path.resolve(resolvedRoot, filePath);
  const relativePath = path.relative(resolvedRoot, resolvedPath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Patch file_path must stay inside the workspace.");
  }

  return resolvedPath;
}

function logTokenUsage(response, log) {
  const usage = response.usage || {};
  const promptTokens = usage.prompt_tokens || 0;
  const completionTokens = usage.completion_tokens || 0;
  const totalTokens = usage.total_tokens || promptTokens + completionTokens;
  log(`\u001b[36m[LLM] Fix completed. Tokens used: ${totalTokens} (Prompt: ${promptTokens}, Completion: ${completionTokens})\u001b[0m`);
}

async function askDeepPatchQuestion(question, options = {}) {
  if (typeof options.ask === "function") {
    return options.ask(question);
  }

  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const interfaceHandle = readline.createInterface({ input, output });
  try {
    return await new Promise((resolve) => {
      interfaceHandle.question(question, (answer) => resolve(answer || ""));
    });
  } finally {
    interfaceHandle.close();
  }
}

function renderMultiFilePatchPreview(patchSet) {
  const lines = [
    "Deep Multi-File Remediation",
    "",
    patchSet.explanation,
    "",
    "Planned file modifications:",
    ...patchSet.patches.map((patch) => `- ${patch.action.toUpperCase()} ${patch.filePath}`),
    ""
  ];

  return lines.join("\n");
}

function stripMarkdownFenceText(value) {
  const text = String(value || "").trim();
  const fenced = text.match(/^```[A-Za-z0-9_-]*\s*\r?\n([\s\S]*?)\r?\n```$/);
  return (fenced ? fenced[1] : text).trim();
}

function isManualReviewPayload(value) {
  return stripMarkdownFenceText(value) === MANUAL_REVIEW_REQUIRED;
}

async function applyMultiFilePatchSet(patchSet, options = {}) {
  const output = options.output || process.stdout;
  if (typeof patchSet === "string" && isManualReviewPayload(patchSet)) {
    output.write(`${MANUAL_REVIEW_MESSAGE}\n`);
    return {
      attempted: 0,
      applied: 0,
      skipped: 0,
      manualReviewRequired: true
    };
  }

  const normalizedPatchSet = patchSet?.patches
    ? {
        patches: patchSet.patches.map((patch, index) => normalizeMultiFilePatch({
          file_path: patch.filePath || patch.file_path,
          action: patch.action,
          new_content: typeof patch.newContent === "string" ? patch.newContent : patch.new_content
        }, index)),
        explanation: patchSet.explanation
      }
    : parseMultiFileRemediationJson(patchSet);
  output.write(`${renderMultiFilePatchPreview(normalizedPatchSet)}\n`);

  const answer = await askDeepPatchQuestion("[y/n] Apply entire multi-file architectural patch? ", options);
  const attempted = normalizedPatchSet.patches.length;
  if (String(answer || "").trim().toLowerCase() !== "y") {
    output.write("Multi-file architectural patch declined. No files were changed.\n");
    return { attempted, applied: 0, skipped: attempted };
  }

  const rootDir = path.resolve(options.rootDir || process.cwd());
  let applied = 0;
  for (const patch of normalizedPatchSet.patches) {
    const targetPath = resolveWorkspacePatchPath(rootDir, patch.filePath);
    if (patch.action === "delete") {
      await fs.rm(targetPath, { force: true });
      applied += 1;
      continue;
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, patch.newContent, "utf8");
    applied += 1;
  }

  output.write(`Multi-file architectural patch applied: ${applied}/${attempted} file(s).\n`);
  return { attempted, applied, skipped: attempted - applied };
}

function resolveLlmTimeoutMs(env = process.env, options = {}) {
  const configuredTimeout = options.timeoutMs ?? env.PREFLIGHT_LLM_TIMEOUT_MS;
  const timeoutMs = Number(configuredTimeout);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_LLM_TIMEOUT_MS;
}

async function generateParameterizedFix(rawSnippet, options = {}) {
  const warn =
    options.warn ||
    ((message) => {
      console.warn(message);
    });
  const log =
    options.log ||
    ((message) => {
      console.log(message);
    });
  const provider = options.client
    ? { client: options.client, model: options.model || process.env.MODEL_NAME || DEFAULT_OPENAI_MODEL }
    : resolveLlmProvider(process.env, options);

  if (!provider) {
    warn(FREE_SQL_REMEDIATION_MESSAGE);
    return rawSnippet;
  }

  const client =
    provider.client ||
    new OpenAI({
      apiKey: provider.apiKey,
      maxRetries: 0,
      ...(provider.baseURL ? { baseURL: provider.baseURL } : {})
    });

  let response;
  try {
    response = await client.chat.completions.create(
      {
        model: provider.model,
        messages: [
          { role: "system", content: SURGICAL_LLM_SYSTEM_PROMPT },
          { role: "user", content: rawSnippet }
        ],
        temperature: 0
      },
      { timeout: resolveLlmTimeoutMs(process.env, options) }
    );
  } catch (error) {
    warn(formatProviderFailureMessage(error, provider));
    if (typeof options.onProviderFailure === "function") {
      options.onProviderFailure(error, provider);
    }
    return rawSnippet;
  }
  logTokenUsage(response, log);
  const proposedFix = extractChatCompletionText(response);

  await verifySyntaxSafety(proposedFix);
  return proposedFix;
}

module.exports = {
  applyMultiFilePatchSet,
  FREE_SQL_REMEDIATION_MESSAGE,
  findSqlConcatenations,
  formatProviderFailureMessage,
  generateParameterizedFix,
  MANUAL_REVIEW_MESSAGE,
  MANUAL_REVIEW_REQUIRED,
  parseMultiFileRemediationJson,
  parseJavaScript,
  resolveLlmProvider,
  resolveLlmTimeoutMs,
  renderMultiFilePatchPreview,
  SURGICAL_LLM_SYSTEM_PROMPT,
  verifySyntaxSafety
};
