const path = require("node:path");
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
const GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
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

function logTokenUsage(response, log) {
  const usage = response.usage || {};
  const promptTokens = usage.prompt_tokens || 0;
  const completionTokens = usage.completion_tokens || 0;
  const totalTokens = usage.total_tokens || promptTokens + completionTokens;
  log(`\u001b[36m[LLM] Fix completed. Tokens used: ${totalTokens} (Prompt: ${promptTokens}, Completion: ${completionTokens})\u001b[0m`);
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
      ...(provider.baseURL ? { baseURL: provider.baseURL } : {})
    });

  const response = await client.chat.completions.create({
    model: provider.model,
    messages: [
      { role: "system", content: SURGICAL_LLM_SYSTEM_PROMPT },
      { role: "user", content: rawSnippet }
    ],
    temperature: 0
  });
  logTokenUsage(response, log);
  const proposedFix = extractChatCompletionText(response);

  await verifySyntaxSafety(proposedFix);
  return proposedFix;
}

module.exports = {
  FREE_SQL_REMEDIATION_MESSAGE,
  findSqlConcatenations,
  generateParameterizedFix,
  parseJavaScript,
  resolveLlmProvider,
  SURGICAL_LLM_SYSTEM_PROMPT,
  verifySyntaxSafety
};
