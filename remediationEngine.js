const fs = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");
const ParserBinding = require("web-tree-sitter");
const OpenAIImport = require("openai");
const {
  DEFAULT_PREFLIGHT_PROXY_ENDPOINT,
  extractPreflightProxyText,
  requestPreflightProxy
} = require("./src/proxy/client");

const Parser = ParserBinding.Parser || ParserBinding.default?.Parser || ParserBinding.default || ParserBinding;
const Language = ParserBinding.Language || ParserBinding.default?.Language;
const OpenAI = OpenAIImport.default || OpenAIImport;

const SQL_KEYWORD_PATTERN = /\b(?:SELECT|INSERT|UPDATE|DELETE)\b/i;
const SURGICAL_LLM_SYSTEM_PROMPT =
  "You are a specialized code refactoring utility. Convert the provided insecure JavaScript/TypeScript string concatenation into a completely secure, parameterized query format using standard placeholder symbols ($1, $2, etc.). Return ONLY the executable, corrected code fragment. Do not output markdown code blocks, backticks, or text explanations. CRITICAL: Minimize internal reasoning steps. Generate the target payload immediately. Do not append conversational preambles or post-analysis text.";
const DEFAULT_GEMINI_MODEL = "gemini-1.5-flash";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_OPENROUTER_MODEL = "qwen/qwen3-coder:free";
const DEFAULT_PREFLIGHT_PROXY_BASE_URL = DEFAULT_PREFLIGHT_PROXY_ENDPOINT;
const DEFAULT_LLM_TIMEOUT_MS = 15000;
const DEFAULT_LLM_MAX_TOKENS = 900;
const TREE_SITTER_WASM_PATHS = {
  javascript: path.join(__dirname, "wasm", "tree-sitter-javascript.wasm"),
  typescript: path.join(__dirname, "wasm", "tree-sitter-typescript.wasm"),
  tsx: path.join(__dirname, "wasm", "tree-sitter-tsx.wasm")
};
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
const ADVANCED_REMEDIATION_REQUIRES_PRO_MESSAGE =
  "⚠️ Advanced structural flaws detected. The free tier handles basic safety fixes. To unlock deep reasoning remediation and fix everything, join the invite-only beta at our website to get your PREFLIGHT_PRO_KEY.";
const PRO_ENGINE_CONNECTION_ERROR =
  "🔴 PreFlight Pro Engine connection timed out or license invalid. Please verify your PREFLIGHT_PRO_KEY.";

function formatProviderFailureMessage(error, provider) {
  if (!provider) {
    return ADVANCED_REMEDIATION_REQUIRES_PRO_MESSAGE;
  }

  return PRO_ENGINE_CONNECTION_ERROR;
}

let parserReady;
let syntaxLanguages;

async function initializeParser() {
  if (!parserReady) {
    parserReady = Parser.init?.();
  }

  if (parserReady) {
    await parserReady;
  }

  if (!syntaxLanguages) {
    syntaxLanguages = {
      javascript: await Language.load(TREE_SITTER_WASM_PATHS.javascript),
      typescript: await Language.load(TREE_SITTER_WASM_PATHS.typescript),
      tsx: await Language.load(TREE_SITTER_WASM_PATHS.tsx)
    };
  }
}

async function parseJavaScript(sourceCode) {
  await initializeParser();
  const parser = new Parser();
  parser.setLanguage(syntaxLanguages.javascript);
  return parser.parse(sourceCode);
}

function getSyntaxLanguageKeyForFile(filePath) {
  const extension = path.extname(filePath || "").toLowerCase();
  if (extension === ".tsx" || extension === ".jsx") {
    return "tsx";
  }

  if (extension === ".ts" || extension === ".mts" || extension === ".cts") {
    return "typescript";
  }

  return "javascript";
}

function shouldSyntaxValidatePatch(filePath) {
  return /\.(?:[cm]?[jt]sx?)$/i.test(filePath || "");
}

async function parseSourceForValidation(sourceCode, filePath) {
  await initializeParser();
  const parser = new Parser();
  parser.setLanguage(syntaxLanguages[getSyntaxLanguageKeyForFile(filePath)]);
  return parser.parse(sourceCode);
}

function getNodeText(node, sourceCode) {
  return sourceCode.slice(node.startIndex, node.endIndex);
}

function unquoteTreeString(value) {
  const source = String(value || "");
  if (source.length >= 2) {
    const first = source[0];
    const last = source[source.length - 1];
    if ((first === "\"" || first === "'" || first === "`") && last === first) {
      return source.slice(1, -1);
    }
  }

  return source;
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

function nodeContainsTemplateInterpolation(node) {
  if (!node || node.type !== "template_string") {
    return false;
  }

  for (let index = 0; index < node.namedChildCount; index += 1) {
    if (node.namedChild(index).type === "template_substitution") {
      return true;
    }
  }

  return false;
}

function nodeRepresentsDynamicSqlSegment(node) {
  if (!node) {
    return false;
  }

  if (node.type === "identifier") {
    return true;
  }

  if (node.type === "template_string") {
    return nodeContainsTemplateInterpolation(node);
  }

  return node.type !== "string";
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

    if (
      (nodeContainsSqlKeyword(left, sourceCode) && nodeRepresentsDynamicSqlSegment(right)) ||
      (nodeContainsSqlKeyword(right, sourceCode) && nodeRepresentsDynamicSqlSegment(left))
    ) {
      matches.push(makeMatch(node, sourceCode));
    }
  }

  if (
    node.type === "template_string" &&
    nodeContainsSqlKeyword(node, sourceCode) &&
    nodeContainsTemplateInterpolation(node)
  ) {
    matches.push(makeMatch(node, sourceCode));
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

async function verifyPatchedSourceSyntax(filePath, proposedSource) {
  const tree = await parseSourceForValidation(proposedSource, filePath);
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
  const proKey = options.licenseKey || env.PREFLIGHT_PRO_KEY || env.PREFLIGHT_PRO_LICENSE_KEY;
  if (proKey) {
    return {
      apiKey: proKey,
      baseURL: options.baseURL || options.endpoint || env.PREFLIGHT_PRO_PROXY_BASE_URL || env.PREFLIGHT_CLOUD_BASE_URL || DEFAULT_PREFLIGHT_PROXY_BASE_URL,
      endpoint: options.endpoint || options.baseURL || env.PREFLIGHT_PRO_PROXY_BASE_URL || env.PREFLIGHT_CLOUD_BASE_URL || DEFAULT_PREFLIGHT_PROXY_BASE_URL,
      model: modelOverride || DEFAULT_ANTHROPIC_MODEL,
      provider: "preflight-pro"
    };
  }

  return null;
}

function extractChatCompletionText(response) {
  return (response.choices?.[0]?.message?.content || "").trim();
}

function extractProxyCodeFragment(text) {
  const normalized = String(text || "").trim();
  const codeBlockMatch = normalized.match(/```(?:[A-Za-z0-9_-]+)?\r?\n([\s\S]*?)```/);
  if (codeBlockMatch?.[1]?.trim()) {
    return codeBlockMatch[1].trim();
  }

  const withoutRootCause = normalized.replace(/^Root Cause:\s*[^\r\n]*\r?\n?/i, "").trim();
  const fencedOrPlain = stripMarkdownFenceText(withoutRootCause);
  return fencedOrPlain.trim();
}

function extractStandaloneSqlText(proposedFix) {
  const trimmed = String(proposedFix || "").trim();
  if (!trimmed) {
    return null;
  }

  const quotedMatch = trimmed.match(/^(['"`])([\s\S]*)\1$/);
  if (quotedMatch && SQL_KEYWORD_PATTERN.test(quotedMatch[2])) {
    return quotedMatch[2].trim().replace(/;+\s*$/, "");
  }

  if (/^(?:SELECT|INSERT|UPDATE|DELETE)\b/i.test(trimmed)) {
    return trimmed.replace(/;+\s*$/, "");
  }

  return null;
}

function findExpressionNode(node) {
  if (!node) {
    return null;
  }

  if (node.type === "program" || node.type === "expression_statement") {
    return findExpressionNode(node.namedChild(0));
  }

  return node;
}

function flattenConcatenationNodes(node, sourceCode, parts = []) {
  if (!node) {
    return parts;
  }

  if (node.type === "binary_expression" && getOperator(node, sourceCode) === "+") {
    flattenConcatenationNodes(getFieldNode(node, "left"), sourceCode, parts);
    flattenConcatenationNodes(getFieldNode(node, "right"), sourceCode, parts);
    return parts;
  }

  parts.push(node);
  return parts;
}

function collectSqlExpressionParts(node, sourceCode, parts = []) {
  if (!node) {
    return parts;
  }

  if (node.type === "parenthesized_expression" && node.namedChildCount === 1) {
    return collectSqlExpressionParts(node.namedChild(0), sourceCode, parts);
  }

  if (node.type === "binary_expression" && getOperator(node, sourceCode) === "+") {
    collectSqlExpressionParts(getFieldNode(node, "left"), sourceCode, parts);
    collectSqlExpressionParts(getFieldNode(node, "right"), sourceCode, parts);
    return parts;
  }

  if (node.type === "template_string") {
    for (let index = 0; index < node.namedChildCount; index += 1) {
      const child = node.namedChild(index);
      if (child.type === "string_fragment") {
        parts.push({ kind: "text", value: getNodeText(child, sourceCode) });
        continue;
      }

      if (child.type === "template_substitution" && child.namedChildCount > 0) {
        parts.push({ kind: "expression", value: getNodeText(child.namedChild(0), sourceCode).trim() });
      }
    }
    return parts;
  }

  if (node.type === "string") {
    parts.push({ kind: "text", value: unquoteTreeString(getNodeText(node, sourceCode)) });
    return parts;
  }

  parts.push({ kind: "expression", value: getNodeText(node, sourceCode).trim() });
  return parts;
}

function isSqlLiteralSegment(node, sourceCode) {
  const text = getNodeText(node, sourceCode).trim();
  return /^['"`]/.test(text) || SQL_KEYWORD_PATTERN.test(text);
}

async function extractSqlBindingsFromSnippet(rawSnippet) {
  const tree = await parseJavaScript(rawSnippet);
  try {
    const expressionNode = findExpressionNode(tree.rootNode);
    const parts = collectSqlExpressionParts(expressionNode, rawSnippet);
    return parts
      .filter((part) => part?.kind === "expression" && part.value)
      .map((part) => part.value);
  } finally {
    tree.delete?.();
  }
}

async function buildLocalSqlParameterizedFix(rawSnippet) {
  const tree = await parseJavaScript(rawSnippet);
  try {
    const expressionNode = findExpressionNode(tree.rootNode);
    const parts = collectSqlExpressionParts(expressionNode, rawSnippet);
    if (parts.length === 0) {
      return null;
    }

    let sqlText = "";
    const bindings = [];
    for (const part of parts) {
      if (part.kind === "text") {
        sqlText += part.value;
        continue;
      }

      if (!part.value) {
        return null;
      }

      bindings.push(part.value);
      sqlText += `$${bindings.length}`;
    }

    const normalizedSqlText = sqlText.trim().replace(/;+\s*$/, "");
    if (!normalizedSqlText || !SQL_KEYWORD_PATTERN.test(normalizedSqlText) || bindings.length === 0) {
      return null;
    }

    return `({ text: ${JSON.stringify(normalizedSqlText)}, values: [${bindings.join(", ")}] })`;
  } finally {
    tree.delete?.();
  }
}

async function normalizeProxySqlFix(rawSnippet, proposedFix) {
  const sqlText = extractStandaloneSqlText(proposedFix);
  if (!sqlText) {
    return String(proposedFix || "").trim();
  }

  const bindings = await extractSqlBindingsFromSnippet(rawSnippet);
  if (bindings.length === 0) {
    return JSON.stringify(sqlText);
  }

  return `({ text: ${JSON.stringify(sqlText)}, values: [${bindings.join(", ")}] })`;
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

async function snapshotPatchTarget(targetPath) {
  try {
    return {
      existed: true,
      contents: await fs.readFile(targetPath, "utf8")
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        existed: false,
        contents: null
      };
    }
    throw error;
  }
}

async function restorePatchTarget(targetPath, snapshot) {
  if (!snapshot?.existed) {
    await fs.rm(targetPath, { force: true });
    return;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, snapshot.contents, "utf8");
}

async function validatePatchSetBeforeWrite(normalizedPatchSet) {
  for (const patch of normalizedPatchSet.patches) {
    if (patch.action === "delete" || !shouldSyntaxValidatePatch(patch.filePath)) {
      continue;
    }

    await verifyPatchedSourceSyntax(patch.filePath, patch.newContent);
  }
}

function logTokenUsage(response, log) {
  const usage = response.usage || {};
  const promptTokens = usage.prompt_tokens || 0;
  const completionTokens = usage.completion_tokens || 0;
  const totalTokens = usage.total_tokens || promptTokens + completionTokens;
  log(`\u001b[36m[PRO] Pro Engine fix generated. Tokens used: ${totalTokens} (Prompt: ${promptTokens}, Completion: ${completionTokens})\u001b[0m`);
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
    "🚀 [PRO] Deep reasoning patch generated by PreFlight Pro Engine",
    "",
    "Deep Multi-File Remediation",
    "",
    patchSet.explanation,
    "",
    "Planned file modifications:"
  ];

  for (const patch of patchSet.patches) {
    lines.push(`- ${patch.action.toUpperCase()} ${patch.filePath}`);
    if (patch.action === "delete") {
      lines.push("  [delete file]");
      continue;
    }

    lines.push("  Proposed content:");
    for (const line of patch.newContent.split(/\r?\n/)) {
      lines.push(`  ${line}`);
    }
  }

  lines.push("");

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

  const answer = await askDeepPatchQuestion(options.question || "[y/n] Apply entire multi-file architectural patch? ", options);
  const attempted = normalizedPatchSet.patches.length;
  if (String(answer || "").trim().toLowerCase() !== "y") {
    output.write("Multi-file architectural patch declined. No files were changed.\n");
    return { attempted, applied: 0, skipped: attempted };
  }

  const rootDir = path.resolve(options.rootDir || process.cwd());
  try {
    await validatePatchSetBeforeWrite(normalizedPatchSet);
  } catch (error) {
    output.write(`${MANUAL_REVIEW_MESSAGE}\n`);
    output.write(`Deep patch validation failed before write: ${error.message}\n`);
    return {
      attempted,
      applied: 0,
      skipped: 0,
      manualReviewRequired: true
    };
  }

  const snapshots = new Map();
  for (const patch of normalizedPatchSet.patches) {
    const targetPath = resolveWorkspacePatchPath(rootDir, patch.filePath);
    snapshots.set(targetPath, await snapshotPatchTarget(targetPath));
  }

  let applied = 0;
  try {
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
  } catch (error) {
    const rollbackErrors = [];
    for (const [targetPath, snapshot] of Array.from(snapshots.entries()).reverse()) {
      try {
        await restorePatchTarget(targetPath, snapshot);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      error.rollbackErrors = rollbackErrors;
    }
    throw error;
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
  const localFix = await buildLocalSqlParameterizedFix(rawSnippet);
  if (localFix) {
    if (typeof options.onResolution === "function") {
      options.onResolution({ engine: "local" });
    }
    return localFix;
  }

  if (options.localOnly === true) {
    return rawSnippet;
  }
  const provider = options.client
    ? { client: options.client, model: options.model || process.env.MODEL_NAME || DEFAULT_OPENAI_MODEL }
    : resolveLlmProvider(process.env, options);

  if (!provider) {
    const activationError = new Error(ADVANCED_REMEDIATION_REQUIRES_PRO_MESSAGE);
    if (typeof options.onProviderFailure === "function") {
      options.onProviderFailure(activationError, null);
    }
    warn(activationError.message);
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
    if (!options.client && provider.provider === "preflight-pro") {
      response = await requestPreflightProxy({
        endpoint: provider.endpoint,
        licenseKey: provider.apiKey,
        system: SURGICAL_LLM_SYSTEM_PROMPT,
        userContent: rawSnippet,
        maxTokens: options.maxTokens || DEFAULT_LLM_MAX_TOKENS,
        temperature: 0,
        timeoutMs: resolveLlmTimeoutMs(process.env, options),
        transport: options.transport
      });
    } else {
      response = await client.chat.completions.create(
        {
          model: provider.model,
          messages: [
            { role: "system", content: SURGICAL_LLM_SYSTEM_PROMPT },
            { role: "user", content: rawSnippet }
          ],
          max_tokens: options.maxTokens || DEFAULT_LLM_MAX_TOKENS,
          temperature: 0
        },
        { timeout: resolveLlmTimeoutMs(process.env, options) }
      );
    }
  } catch (error) {
    warn(formatProviderFailureMessage(error, provider));
    if (typeof options.onProviderFailure === "function") {
      options.onProviderFailure(error, provider);
    }
    return rawSnippet;
  }
  if (response?.usage) {
    logTokenUsage(response, log);
  }
  if (typeof options.onResolution === "function") {
    options.onResolution({ engine: "pro" });
  }
  const proposedFix = !options.client && provider.provider === "preflight-pro"
    ? extractProxyCodeFragment(extractPreflightProxyText(response))
    : extractChatCompletionText(response);
  const normalizedFix = !options.client && provider.provider === "preflight-pro"
    ? await normalizeProxySqlFix(rawSnippet, proposedFix)
    : proposedFix;

  await verifySyntaxSafety(normalizedFix);
  return normalizedFix;
}

module.exports = {
  ADVANCED_REMEDIATION_REQUIRES_PRO_MESSAGE,
  applyMultiFilePatchSet,
  findSqlConcatenations,
  formatProviderFailureMessage,
  generateParameterizedFix,
  buildLocalSqlParameterizedFix,
  MANUAL_REVIEW_MESSAGE,
  MANUAL_REVIEW_REQUIRED,
  PRO_ENGINE_CONNECTION_ERROR,
  parseMultiFileRemediationJson,
  parseJavaScript,
  resolveLlmProvider,
  resolveLlmTimeoutMs,
  renderMultiFilePatchPreview,
  SURGICAL_LLM_SYSTEM_PROMPT,
  verifyPatchedSourceSyntax,
  verifySyntaxSafety
};
