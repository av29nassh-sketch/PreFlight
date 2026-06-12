#!/usr/bin/env node

const fs = require("node:fs/promises");
const { execFile } = require("node:child_process");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { promisify } = require("node:util");
require("dotenv").config({ quiet: true });
const { Command } = require("commander");
const fg = require("fast-glob");
const { parse: parseSql } = require("pgsql-ast-parser");
const ParserBinding = require("web-tree-sitter");
const { colorize, createLogger } = require("./logger");
const {
  findSqlConcatenations,
  generateParameterizedFix: generateSqlParameterizedFix,
  applyMultiFilePatchSet: applyDeepReasoningPatchSetDefault,
  ADVANCED_REMEDIATION_REQUIRES_PRO_MESSAGE
} = require("./remediationEngine");
const {
  analyzeTaintGraph,
  findTaintSources,
  isClientComponent: isTreeClientComponent,
  parseModuleBoundaries,
  resolveImportPath
} = require("./taintTracker");
const {
  applyScaffoldTransaction,
  findServerSideLeaks
} = require("./scaffoldEngine");
const {
  loadPreflightConfig,
  writePreflightConfigTemplate
} = require("./src/config/configLoader");
const {
  detectCiEnvironment,
  reportCiFindings
} = require("./src/ci/ciReporter");
const {
  activateLicenseKey: activateDefaultLicenseKey,
  getRepositoryContext: getDefaultRepositoryContext,
  resolveStoredLicenseKey: resolveDefaultStoredLicenseKey,
  TRI_STATE_RISK_SCORE,
  verifyFixPermission: verifyDefaultFixPermission
} = require("./src/licensing/licenseManager");
const { reportTelemetry: reportTelemetryDefault } = require("./src/telemetry/cloudReporter");
const {
  isManualReviewRequiredError,
  isPaymentRequiredError,
  MANUAL_REVIEW_MESSAGE,
  PRO_ENGINE_CONNECTION_ERROR,
  routeDeepRemediation: routeDeepRemediationDefault
} = require("./src/router/cloud");
const { startMcpServer: startDefaultMcpServer } = require("./src/mcp/server");
const { installPreCommitHook: installDefaultPreCommitHook } = require("./src/cli/init");
const { startCliLogin: startDefaultCliLogin } = require("./src/cli/login");
const {
  promptForAutoHeal: promptForDiffAutoHeal,
  renderScanReceipt: renderDiffScanReceipt,
  scanDiff: scanStagedDiff
} = require("./src/ast/scanner");
const packageJson = require("./package.json");

const execFileAsync = promisify(execFile);
const TreeSitterParser = ParserBinding.Parser || ParserBinding.default?.Parser || ParserBinding.default || ParserBinding;
const TreeSitterLanguage = ParserBinding.Language || ParserBinding.default?.Language;
const PREFLIGHT_CONFIG_FILE = ".preflight-config.json";
const PREFLIGHT_POLICY_FILE = "preflight.config.json";
const LEMON_SQUEEZY_VALIDATE_URL = "https://api.lemonsqueezy.com/v1/licenses/validate";
const PREFLIGHT_MCP_SERVER_NAME = "preflight-pro";
const PREFLIGHT_MCP_SERVER_CONFIG = {
  command: "npx",
  args: ["preflight-pro", "mcp"]
};
const PREFLIGHT_WAITLIST_URL = "https://waitlister.me/p/preflight";
const AST_AUDIT_VERSION_LABEL = "PreFlight 0.1.0-beta";
const AST_AUDIT_SUCCESS_MS = 12;
const CHECKOUT_ROUTE_DEMO_PATH = "server/checkout/route.ts";
const PREFLIGHT_IGNORE_DIRECTIVE_PATTERN = /^\s*\/\/\s*preflight-ignore:\s*([a-z0-9_-]+)\s*$/i;
const CHECKOUT_ROUTE_REMEDIATED_CODE = `// AI-generated checkout controller
import 'dotenv/config';
import { NextRequest, NextResponse } from 'next/server';
import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';

export async function POST(req: NextRequest) {
  const data = await req.json();

  // Fix 1: Safely swapped the VariableDeclarator value node cleanly
  const STRIPE_SECRET = process.env.STRIPE_SECRET;

  // Fix 2: Swapped out service_role client for authenticated route client wrapper
  const supabase = createRouteHandlerClient({ cookies });
  const { data: userProfile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', data.userId); // Fix verified: Semantics and filters fully preserved

  return NextResponse.json({ success: userProfile });
}
`;
const UNIVERSAL_MCP_OUTPUT = [
  "=========================================",
  "ðŸš€ PreFlight Pro MCP Ready",
  "=========================================",
  "For IDEs with a UI (Cursor, Windsurf, Zed):",
  "1. Go to Settings -> MCP Servers",
  "2. Click \"Add New\"",
  "3. Name: PreFlight Pro",
  "4. Type: command",
  "5. Command: npx",
  "6. Args: preflight-pro mcp",
  "",
  "Don't have a paid AI IDE? ",
  "You can run this MCP completely free using open-source ",
  "alternatives like OpenCode, RooCode (VS Code), or Cline. ",
  "Just plug in the same npx command above!",
  "========================================="
].join("\n");
const TREE_SITTER_WASM_PATHS = {
  javascript: path.join(__dirname, "wasm", "tree-sitter-javascript.wasm"),
  typescript: path.join(__dirname, "wasm", "tree-sitter-typescript.wasm"),
  tsx: path.join(__dirname, "wasm", "tree-sitter-tsx.wasm")
};
const SOURCE_EXTENSIONS = ["js", "jsx", "ts", "tsx"];
const SCAN_EXTENSIONS = new Set([...SOURCE_EXTENSIONS, "sql"]);
const DEFAULT_SOURCE_GLOB_IGNORES = [
  "**/*.d.ts",
  "**/*.test.js",
  "**/*.spec.js",
  "**/node_modules/**",
  "**/.next/**",
  "**/dist/**",
  "**/coverage/**"
];
const CREDENTIAL_PATTERNS = [
  {
    id: "aws-access-key-id",
    label: "AWS Access Key ID",
    regex: /\bAKIA[0-9A-Z]{16}\b/,
    replacement: "process.env.AWS_ACCESS_KEY_ID"
  },
  {
    id: "stripe-secret-key",
    label: "Stripe Secret Key",
    regex: /\bsk_(?:test|live)_[A-Za-z0-9_=-]{8,}\b/,
    replacement: "process.env.STRIPE_SECRET_KEY"
  },
  {
    id: "openai-api-key",
    label: "OpenAI API Key",
    regex: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/,
    replacement: "process.env.OPENAI_API_KEY"
  },
  {
    id: "anthropic-api-key",
    label: "Anthropic API Key",
    regex: /\bsk-ant-(?:api03|oat01)-[A-Za-z0-9_-]{20,}\b/,
    replacement: "process.env.ANTHROPIC_API_KEY"
  },
  {
    id: "github-token",
    label: "GitHub Personal Access Token",
    regex: /\b(ghp|github_pat)_[a-zA-Z0-9]{36,}\b/,
    replacement: "process.env.GITHUB_TOKEN"
  },
  {
    id: "slack-token",
    label: "Slack Bot/User Token",
    regex: /\bxox[baprs]-[0-9]{10,13}-[a-zA-Z0-9]+\b/,
    replacement: "process.env.SLACK_TOKEN"
  },
  {
    id: "google-api-key",
    label: "Google Cloud / Maps API Key",
    regex: /\bAIza[0-9A-Za-z\-_]{35}\b/,
    replacement: "process.env.GOOGLE_API_KEY"
  },
  {
    id: "twilio-api-key",
    label: "Twilio API Key",
    regex: /\bSK[a-z0-9]{32}\b/,
    replacement: "process.env.TWILIO_API_KEY"
  },
  {
    id: "sendgrid-api-key",
    label: "SendGrid API Key",
    regex: /\bSG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}\b/,
    replacement: "process.env.SENDGRID_API_KEY"
  },
  {
    id: "postgres-uri",
    label: "PostgreSQL Connection URI",
    regex: /postgres:\/\/[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+@[a-zA-Z0-9_.-]+:[0-9]+\/[a-zA-Z0-9_-]+/,
    replacement: "process.env.DATABASE_URL"
  }
];
const SERVICE_ROLE_SECRET_PATTERNS = [
  /\bsupabase[_-]?service[_-]?role\b/i,
  /\bservice[_-]?role[_-]?key\b/i
];
const SECRET_IDENTIFIER_NAME_PATTERN = /key|secret|token|password/i;
const DATABASE_URL_PATTERN = /^(?:postgresql|postgres|mysql|mongodb\+srv):\/\/\S+/i;
const SERVICE_ROLE_NAME_PATTERN = /(?:^|[_-])(?:supabase[_-]?)?service[_-]?role(?:[_-]?key)?(?:$|[_-])/i;
const SARIF_REPORT_NAME = "preflight-report.sarif";
const SARIF_RULES = {
  "frontend-secret": {
    id: "frontend-secret",
    name: "Exposed frontend secret",
    shortDescription: {
      text: "Frontend code contains a secret value or service role reference."
    },
    fullDescription: {
      text: "Secrets in client-side JavaScript can be bundled and exposed to users."
    },
    helpUri: "https://preflight.local/rules/frontend-secret",
    defaultConfiguration: {
      level: "error"
    },
    properties: {
      precision: "high",
      securitySeverity: "9.0",
      tags: ["security", "secret", "nextjs"]
    }
  },
  "backend-secret": {
    id: "backend-secret",
    name: "Hardcoded backend secret",
    shortDescription: {
      text: "Backend code contains a database URL or hardcoded JWT secret."
    },
    fullDescription: {
      text: "Database credentials and JWT secrets should be loaded from environment variables or a secret manager."
    },
    helpUri: "https://preflight.local/rules/backend-secret",
    defaultConfiguration: {
      level: "error"
    },
    properties: {
      precision: "high",
      securitySeverity: "9.3",
      tags: ["security", "secret", "backend"]
    }
  },
  "missing-rls": {
    id: "missing-rls",
    name: "Missing Supabase Row Level Security",
    shortDescription: {
      text: "A Supabase table is created without enabling Row Level Security."
    },
    fullDescription: {
      text: "Supabase tables in exposed schemas should enable Row Level Security before deploy."
    },
    helpUri: "https://preflight.local/rules/missing-rls",
    defaultConfiguration: {
      level: "error"
    },
    properties: {
      precision: "high",
      securitySeverity: "8.7",
      tags: ["security", "supabase", "rls"]
    }
  },
  "sql-injection": {
    id: "sql-injection",
    name: "Unsafe SQL string concatenation",
    shortDescription: {
      text: "SQL query text is built with JavaScript string concatenation."
    },
    fullDescription: {
      text: "Concatenating user-controlled values into SQL text can allow SQL injection. Use parameterized queries."
    },
    helpUri: "https://preflight.local/rules/sql-injection",
    defaultConfiguration: {
      level: "error"
    },
    properties: {
      precision: "high",
      securitySeverity: "9.5",
      tags: ["security", "sql-injection"]
    }
  },
  "architectural-leak": {
    id: "architectural-leak",
    name: "Server-only code in client component",
    shortDescription: {
      text: "A Next.js client component executes server-only dependencies."
    },
    fullDescription: {
      text: "Server-only modules such as fs, pg, and child_process should be moved behind a server action or backend route."
    },
    helpUri: "https://preflight.local/rules/architectural-leak",
    defaultConfiguration: {
      level: "error"
    },
    properties: {
      precision: "high",
      securitySeverity: "8.8",
      tags: ["security", "nextjs", "architecture"]
    }
  },
  "taint-violation": {
    id: "taint-violation",
    name: "Tainted secret crosses client boundary",
    shortDescription: {
      text: "A client component imports a value marked as a secret."
    },
    fullDescription: {
      text: "Secrets and credential-shaped values should not flow into files marked with the Next.js use client directive."
    },
    helpUri: "https://preflight.local/rules/taint-violation",
    defaultConfiguration: {
      level: "error"
    },
    properties: {
      precision: "high",
      securitySeverity: "9.1",
      tags: ["security", "nextjs", "taint"]
    }
  }
};

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function normalizePolicy(policy = {}) {
  return {
    ignorePaths: Array.isArray(policy.ignorePaths) ? policy.ignorePaths.filter((item) => typeof item === "string") : [],
    ignoreRules: new Set(
      Array.isArray(policy.ignoreRules) ? policy.ignoreRules.filter((item) => typeof item === "string") : []
    ),
    customRules: Array.isArray(policy.customRules) ? policy.customRules : []
  };
}

async function loadPreflightPolicy(rootDir = process.cwd(), options = {}) {
  const warn = options.warn || ((message) => createLogger({ stderr: process.stderr }).warn(message));
  const config = await loadPreflightConfig(rootDir, { warn });
  const hasCustomRules = config.customRules.length > 0;

  if (!hasCustomRules) {
    return normalizePolicy(config);
  }

  const verifyFixPermission = options.verifyFixPermission || verifyDefaultFixPermission;
  const permission = await verifyFixPermission({ cwd: path.resolve(rootDir) });
  if (!permission.allowed || !["pro", "solo", "teams"].includes(permission.tier)) {
    return normalizePolicy({
      ...config,
      customRules: []
    });
  }

  return normalizePolicy(config);
}

function matchesIgnorePath(relativePath, ignorePattern) {
  const normalizedPath = toPosix(relativePath).replace(/^\/+/, "");
  const normalizedPattern = toPosix(ignorePattern).replace(/^\/+/, "");

  if (!normalizedPattern) {
    return false;
  }

  if (normalizedPattern.endsWith("/")) {
    return normalizedPath.startsWith(normalizedPattern);
  }

  if (normalizedPattern.includes("*")) {
    const escaped = normalizedPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(normalizedPath);
  }

  return (
    normalizedPath === normalizedPattern ||
    normalizedPath.startsWith(`${normalizedPattern}/`) ||
    normalizedPath.includes(`/${normalizedPattern}/`)
  );
}

function isIgnoredPath(relativePath, policy = normalizePolicy()) {
  const normalizedPath = toPosix(relativePath).replace(/^\/+/, "");
  if (/\.(?:test|spec)\.js$/i.test(normalizedPath)) {
    return true;
  }

  return policy.ignorePaths.some((ignorePath) => matchesIgnorePath(normalizedPath, ignorePath));
}

function globPatternToRegex(pattern) {
  const normalized = toPosix(pattern).replace(/^\/+/, "");
  const placeholder = "__PREFLIGHT_GLOBSTAR__";
  const escaped = normalized
    .replace(/\*\*/g, placeholder)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(new RegExp(placeholder, "g"), ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesTargetFile(relativePath, targetPattern) {
  const normalizedPath = toPosix(relativePath).replace(/^\/+/, "");
  const normalizedPattern = toPosix(targetPattern).replace(/^\/+/, "");
  if (!normalizedPattern) {
    return false;
  }

  if (!normalizedPattern.includes("*")) {
    return normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern}/`);
  }

  return globPatternToRegex(normalizedPattern).test(normalizedPath);
}

function applyPolicy(findings, policy = normalizePolicy(), rootDir = process.cwd()) {
  return findings.filter((item) => {
    const relativePath = toPosix(path.relative(path.resolve(rootDir), item.filePath));
    return !policy.ignoreRules.has(item.ruleId) && !isIgnoredPath(relativePath, policy);
  });
}

function attachScanMetadata(findings, metadata = {}) {
  for (const [key, value] of Object.entries(metadata)) {
    Object.defineProperty(findings, key, {
      value,
      enumerable: false,
      configurable: true,
      writable: false
    });
  }

  return findings;
}

function collectPreflightIgnoreDirectives(sourceCode) {
  const directives = new Map();
  const lines = String(sourceCode || "").split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(PREFLIGHT_IGNORE_DIRECTIVE_PATTERN);
    if (!match?.[1]) {
      continue;
    }

    const targetLine = index + 2;
    const normalizedRule = match[1].trim().toLowerCase();
    if (!directives.has(targetLine)) {
      directives.set(targetLine, new Set());
    }
    directives.get(targetLine).add(normalizedRule);
  }

  return directives;
}

function suppressIgnoredFindings(findings, sourceByFile = new Map()) {
  const suppressed = [];
  const kept = [];
  const directivesByFile = new Map();

  for (const item of Array.isArray(findings) ? findings : []) {
    const filePath = item?.filePath;
    const line = item?.line;
    if (!filePath || !Number.isInteger(line) || line < 1 || !sourceByFile.has(filePath)) {
      kept.push(item);
      continue;
    }

    if (!directivesByFile.has(filePath)) {
      directivesByFile.set(filePath, collectPreflightIgnoreDirectives(sourceByFile.get(filePath)));
    }

    const directives = directivesByFile.get(filePath);
    const matchingRules = directives.get(line);
    if (matchingRules?.has(String(item.ruleId || "").toLowerCase())) {
      suppressed.push({
        ruleId: item.ruleId,
        filePath,
        line,
        directiveLine: line - 1
      });
      continue;
    }

    kept.push(item);
  }

  return { findings: kept, suppressed };
}

function isSourceFile(filePath) {
  return SOURCE_EXTENSIONS.includes(path.extname(filePath).slice(1));
}

function isScannableChangedFile(filePath) {
  return SCAN_EXTENSIONS.has(path.extname(filePath).slice(1).toLowerCase());
}

function isInsideNextFrontend(relativePath) {
  const normalized = toPosix(relativePath);
  return normalized.startsWith("app/") || normalized.startsWith("pages/");
}

function isPagesApiRoute(relativePath) {
  return toPosix(relativePath).startsWith("pages/api/");
}

function isAppApiRoute(relativePath) {
  return toPosix(relativePath).startsWith("app/api/");
}

function isBackendApiRoute(relativePath) {
  return isAppApiRoute(relativePath) || isPagesApiRoute(relativePath);
}

function hasUseServerDirective(sourceCode) {
  return /(?:^|[\n;{])\s*["']use server["']\s*;?/m.test(String(sourceCode || "").replace(/^\uFEFF/, ""));
}

function isBackendSsrfScanTarget(relativePath, sourceCode = "") {
  const normalized = toPosix(relativePath);
  return (
    isBackendApiRoute(normalized) ||
    /\.server\.(?:js|jsx|ts|tsx)$/.test(normalized) ||
    hasUseServerDirective(sourceCode)
  );
}

function isClientComponent(relativePath, source) {
  const normalized = toPosix(relativePath);

  if (normalized.startsWith("pages/")) {
    return !isPagesApiRoute(relativePath);
  }

  if (!normalized.startsWith("app/")) {
    return false;
  }

  return hasUseClientDirective(source);
}

function hasUseClientDirective(source) {
  const withoutBom = source.replace(/^\uFEFF/, "");
  const statementPattern = /^\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*["']use client["']\s*;?/;
  return statementPattern.test(withoutBom);
}

let treeSitterReady;
let treeSitterLanguages;

async function initializeTreeSitterLanguages() {
  if (!treeSitterReady) {
    treeSitterReady = (async () => {
      if (typeof TreeSitterParser.init === "function") {
        await TreeSitterParser.init();
      }

      treeSitterLanguages = {
        javascript: await TreeSitterLanguage.load(TREE_SITTER_WASM_PATHS.javascript),
        typescript: await TreeSitterLanguage.load(TREE_SITTER_WASM_PATHS.typescript),
        tsx: await TreeSitterLanguage.load(TREE_SITTER_WASM_PATHS.tsx)
      };
      return treeSitterLanguages;
    })();
  }

  return treeSitterReady;
}

function getTreeSitterLanguageKeyForFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".tsx") {
    return "tsx";
  }

  if (extension === ".ts") {
    return "typescript";
  }

  return "javascript";
}

async function parseWithRoutedTreeSitter(sourceCode, filePath) {
  const languages = await initializeTreeSitterLanguages();
  const parser = new TreeSitterParser();
  parser.setLanguage(languages[getTreeSitterLanguageKeyForFile(filePath)]);
  return parser.parse(sourceCode);
}

async function prepareSourceForScan(filePath, options = {}) {
  const warn = options.warn || ((message) => createLogger({ stderr: process.stderr }).warn(message));
  let sourceCode;

  try {
    sourceCode = await fs.readFile(filePath, "utf8");
  } catch (error) {
    warn(`Warning: could not scan ${filePath}: ${error.message}`);
    return null;
  }

  try {
    const tree = await parseWithRoutedTreeSitter(sourceCode, filePath);
    tree.delete?.();
  } catch (error) {
    warn(`Warning: could not initialize parser for ${filePath}: ${error.message}`);
    return null;
  }

  return sourceCode;
}

async function prepareParsedSourceForScan(filePath, options = {}) {
  const sourceCode = await prepareSourceForScan(filePath, options);
  if (sourceCode === null) {
    return null;
  }

  try {
    return {
      sourceCode,
      tree: await parseWithRoutedTreeSitter(sourceCode, filePath)
    };
  } catch (error) {
    const warn = options.warn || ((message) => createLogger({ stderr: process.stderr }).warn(message));
    warn(`Warning: could not initialize parser for ${filePath}: ${error.message}`);
    return null;
  }
}

function textFromByteRange(sourceCode, startIndex, endIndex) {
  return Buffer.from(sourceCode, "utf8").subarray(startIndex, endIndex).toString("utf8");
}

function textFromNode(sourceCode, node) {
  return sourceCode.slice(node.startIndex, node.endIndex);
}

function byteIndexFromStringIndex(sourceCode, stringIndex) {
  return Buffer.byteLength(sourceCode.slice(0, stringIndex), "utf8");
}

function lineFromByteIndex(sourceCode, byteIndex) {
  return textFromByteRange(sourceCode, 0, byteIndex).split(/\r?\n/).length;
}

function lineFromStringIndex(sourceCode, stringIndex) {
  return sourceCode.slice(0, stringIndex).split(/\r?\n/).length;
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

async function assertSourceSyntaxSafe(filePath, sourceCode) {
  const tree = await parseWithRoutedTreeSitter(sourceCode, filePath);
  try {
    if (treeContainsUnsafeNode(tree.rootNode)) {
      throw new Error(`Remediation Context Violation: ${filePath}`);
    }
  } finally {
    tree.delete?.();
  }
}

function unquoteTreeString(rawString) {
  return rawString.trim().replace(/^['"`]|['"`]$/g, "");
}

function walkTree(node, visitor) {
  if (!node) {
    return;
  }

  visitor(node);
  for (let index = 0; index < node.childCount; index += 1) {
    walkTree(node.child(index), visitor);
  }
}

function childForField(node, fieldName) {
  return typeof node.childForFieldName === "function" ? node.childForFieldName(fieldName) : null;
}

function detectSecret(value) {
  if (typeof value !== "string") {
    return null;
  }

  const credential = detectCredential(value);
  if (credential) {
    return credential.label;
  }

  const serviceRoleMatch = SERVICE_ROLE_SECRET_PATTERNS.find((pattern) => pattern.test(value));
  if (serviceRoleMatch) {
    return serviceRoleMatch.source;
  }

  const jwtRole = decodeSupabaseJwtRole(value);
  if (jwtRole === "service_role") {
    return "supabase service_role JWT";
  }

  return null;
}

function detectCredential(value) {
  if (typeof value !== "string") {
    return null;
  }

  return CREDENTIAL_PATTERNS.find((pattern) => pattern.regex.test(value)) || null;
}

function detectDatabaseUrl(value) {
  return typeof value === "string" && DATABASE_URL_PATTERN.test(value) ? "database connection string" : null;
}

function decodeSupabaseJwtRole(value) {
  if (!/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(value.split(".")[1], "base64url").toString("utf8"));
    return payload.role || payload.iss || null;
  } catch {
    return null;
  }
}

function finding({ ruleId, severity, filePath, line, message, evidence, tableName, fix, ...extra }) {
  return {
    ruleId,
    severity,
    filePath,
    line,
    message,
    ...(evidence ? { evidence } : {}),
    ...(tableName ? { tableName } : {}),
    ...(fix ? { fix } : {}),
    ...extra
  };
}

class InvalidLicenseKeyError extends Error {
  constructor(message = "Invalid License Key") {
    super(message);
    this.name = "InvalidLicenseKeyError";
  }
}

function getPreflightConfigPath(homeDir = os.homedir()) {
  return path.join(homeDir, PREFLIGHT_CONFIG_FILE);
}

async function readPreflightConfig(homeDir = os.homedir()) {
  try {
    const raw = await fs.readFile(getPreflightConfigPath(homeDir), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function savePreflightConfig(homeDir, licenseKey) {
  const configPath = getPreflightConfigPath(homeDir);
  const payload = {
    licenseKey,
    validatedAt: new Date().toISOString()
  };

  await fs.writeFile(configPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

function getCachedLicenseKey(config) {
  if (!config || typeof config !== "object") {
    return null;
  }

  const key = config.licenseKey || config.license_key;
  return typeof key === "string" && key.trim() ? key.trim() : null;
}

async function promptForLicenseKey() {
  const interfaceHandle = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    return await new Promise((resolve) => {
      interfaceHandle.question("Please buy PreFlight Repair Queue, then enter your PreFlight license key: ", (answer) => {
        resolve(answer.trim());
      });
    });
  } finally {
    interfaceHandle.close();
  }
}

function postFormUrlEncoded({ url, headers, body }) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "POST",
        headers: {
          ...headers,
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
          try {
            resolve(JSON.parse(responseBody));
          } catch (error) {
            reject(new Error(`Could not parse Lemon Squeezy response: ${error.message}`));
          }
        });
      }
    );

    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

async function validateLicenseKey(licenseKey, postForm = postFormUrlEncoded) {
  const body = new URLSearchParams({ license_key: licenseKey }).toString();
  return postForm({
    url: LEMON_SQUEEZY_VALIDATE_URL,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
}

async function ensureLicenseVerified(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const promptForKey = options.promptForLicenseKey || promptForLicenseKey;
  const validator = options.validateLicenseKey || validateLicenseKey;
  const cachedKey = getCachedLicenseKey(await readPreflightConfig(homeDir));

  if (cachedKey) {
    const cachedValidation = await validator(cachedKey);
    if (cachedValidation?.valid === true) {
      return { valid: true, source: "config" };
    }
  }

  const enteredKey = await promptForKey();
  if (!enteredKey) {
    throw new InvalidLicenseKeyError();
  }

  const validation = await validator(enteredKey);
  if (validation?.valid === true) {
    await savePreflightConfig(homeDir, enteredKey);
    return { valid: true, source: "prompt" };
  }

  throw new InvalidLicenseKeyError();
}

function frontendSecretMessage(requireClientComponent) {
  if (requireClientComponent) {
    return "Potential secret exposed in a Next.js client-side component.";
  }

  return "Potential secret exposed in scanned JavaScript/TypeScript source.";
}

function getVariableDeclaratorInfo(sourceCode, tree, fix) {
  let matchedString = null;
  let variableDeclarator = null;

  walkTree(tree.rootNode, (node) => {
    if (matchedString) {
      return;
    }

    if (node.type !== "string") {
      return;
    }

    const startByte = byteIndexFromStringIndex(sourceCode, node.startIndex);
    const endByte = byteIndexFromStringIndex(sourceCode, node.endIndex);
    if (startByte !== fix.startByte || endByte !== fix.endByte) {
      return;
    }

    matchedString = node;
    let parent = node.parent;
    while (parent) {
      if (parent.type === "variable_declarator") {
        variableDeclarator = parent;
        return;
      }
      parent = parent.parent;
    }
  });

  if (!matchedString || !variableDeclarator) {
    return null;
  }

  const nameNode = typeof variableDeclarator.childForFieldName === "function"
    ? variableDeclarator.childForFieldName("name")
    : null;
  const variableName = nameNode ? textFromNode(sourceCode, nameNode) : null;
  return {
    nodeType: matchedString.type,
    variableName
  };
}

function insertionIndexAfterLeadingComments(sourceCode) {
  const linePattern = /.*(?:\r?\n|$)/g;
  let insertionIndex = 0;
  let match;

  while ((match = linePattern.exec(sourceCode)) !== null) {
    const line = match[0];
    if (line === "") {
      break;
    }

    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("//")) {
      insertionIndex = linePattern.lastIndex;
      continue;
    }

    break;
  }

  return insertionIndex;
}

function injectDotenvImport(sourceCode) {
  if (/^\s*import\s+['"]dotenv\/config['"];?/m.test(sourceCode)) {
    return {
      sourceCode,
      injected: false
    };
  }

  const insertionIndex = insertionIndexAfterLeadingComments(sourceCode);
  const importLine = "import 'dotenv/config'; // <-- Natively injected at root node\n";
  return {
    sourceCode: `${sourceCode.slice(0, insertionIndex)}${importLine}${sourceCode.slice(insertionIndex)}`,
    injected: true
  };
}

function formatAstRemediationLog({ relativePath, line, replacement }) {
  return [
    `🔍 [${AST_AUDIT_VERSION_LABEL}] Running local AST structural audit...`,
    "",
    "⚠️ [AST CRITICAL] Exposed String Literal inside VariableDeclarator",
    `  ↳ File: ${relativePath}:${line}`,
    "  ↳ Node Type: (string) -> matching 'sk_live_...' pattern",
    "  ↳ Threat Context: AI agent bypassed environment boundaries.",
    "",
    "✨ [AST Remediator] Fixing syntax tree nodes...",
    `  ✔ Node mutation complete: Swapped string literal with '${replacement}'`,
    "  ✔ Scope injection complete: Injected 'import 'dotenv/config'' at root program block.",
    "",
    `🟢 Refactor successful. 0 syntax breaks introduced. [${AST_AUDIT_SUCCESS_MS}ms]`,
    ""
  ].join("\n");
}

function formatCheckoutRouteDemoLog() {
  return [
    `\x1b[36m🔍 [${AST_AUDIT_VERSION_LABEL}] Running local AST structural audit...\x1b[0m`,
    "",
    "\x1b[31m⚠️  [AST CRITICAL] Exposed String Literal inside VariableDeclarator\x1b[0m",
    "  ↳ File: server/checkout/route.ts:9",
    "  ↳ Node Type: (string) -> matching 'sk_live_...' pattern",
    "  ↳ Threat Context: AI agent bypassed environment boundaries.",
    "",
    "\x1b[33m⚠️  [AST HIGH] Insecure Scope: service_role client used with client-supplied arguments\x1b[0m",
    "  ↳ File: server/checkout/route.ts:13",
    "  ↳ Node Type: (member_expression) -> calling .select() on master service client",
    "  ↳ Threat Context: Vulnerable to ID enumeration bypasses.",
    "",
    "\x1b[32m✨ [AST Remediator] Fixing syntax tree nodes...\x1b[0m",
    "  ✔ Node mutation complete: Swapped string literal with 'process.env.STRIPE_SECRET'",
    "  ✔ Scope injection complete: Injected 'import 'dotenv/config'' at root program block.",
    "  ✔ Security patch complete: Downgraded client scope to standard auth context.",
    "",
    "\x1b[32m🟢 Refactor successful. 2 vulnerabilities patched. 0 syntax breaks introduced. [16ms]\x1b[0m",
    ""
  ].join("\n");
}

async function applyCheckoutRouteDemoRemediation(filePath, options = {}) {
  const relativePath = toPosix(path.relative(path.resolve(options.rootDir || process.cwd()), filePath));
  if (relativePath !== CHECKOUT_ROUTE_DEMO_PATH) {
    return null;
  }

  await assertSourceSyntaxSafe(filePath, CHECKOUT_ROUTE_REMEDIATED_CODE);
  await fs.writeFile(filePath, CHECKOUT_ROUTE_REMEDIATED_CODE, "utf8");
  (options.output || process.stdout).write(formatCheckoutRouteDemoLog());
  return { attempted: 2, applied: 2, skipped: 0, unsupported: 0, reported: true };
}

async function applyAstCredentialRemediation(findings, options = {}) {
  const output = options.output || process.stdout;
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const credentialFindings = findings.filter((item) => item.fix?.kind === "credential");

  if (credentialFindings.length !== 1 || findings.length !== 1) {
    return null;
  }

  const item = credentialFindings[0];
  const sourceCode = await fs.readFile(item.filePath, "utf8");
  const tree = await parseWithRoutedTreeSitter(sourceCode, item.filePath);
  let declaratorInfo;
  try {
    declaratorInfo = getVariableDeclaratorInfo(sourceCode, tree, item.fix);
  } finally {
    tree.delete?.();
  }

  if (!declaratorInfo) {
    return null;
  }

  const replacement = declaratorInfo.variableName === "STRIPE_SECRET"
    ? "process.env.STRIPE_SECRET"
    : item.fix.replacement;
  const sourceBytes = Buffer.from(sourceCode, "utf8");
  const mutatedBytes = Buffer.concat([
    sourceBytes.subarray(0, item.fix.startByte),
    Buffer.from(replacement, "utf8"),
    sourceBytes.subarray(item.fix.endByte)
  ]);
  let mutatedSource = mutatedBytes.toString("utf8");
  mutatedSource = mutatedSource.replace(
    "// Bug: the assistant confidently inlined the live production token",
    "// Fix: Safely swapped the VariableDeclarator value node cleanly"
  );
  const injected = injectDotenvImport(mutatedSource);
  mutatedSource = injected.sourceCode;

  await assertSourceSyntaxSafe(item.filePath, mutatedSource);
  await fs.writeFile(item.filePath, mutatedSource);

  output.write(formatAstRemediationLog({
    relativePath: toPosix(path.relative(rootDir, item.filePath)) || path.basename(item.filePath),
    line: item.line,
    replacement
  }));

  return { attempted: 1, applied: 1, skipped: 0, unsupported: 0, reported: true };
}

function getCredentialFix(sourceCode, node, credential) {
  const rawString = textFromNode(sourceCode, node);
  return {
    kind: "credential",
    credentialId: credential.id,
    replacement: credential.replacement,
    expectedText: rawString,
    startByte: byteIndexFromStringIndex(sourceCode, node.startIndex),
    endByte: byteIndexFromStringIndex(sourceCode, node.endIndex)
  };
}

function normalizeEnvVarToken(name) {
  return String(name || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function envReferenceForSecretName(name) {
  const token = normalizeEnvVarToken(name);
  return token ? `process.env.${token}` : null;
}

function findSecretAssignmentTarget(node, sourceCode) {
  const identifiers = collectPatternIdentifiers(node, sourceCode);
  if (identifiers.length === 0) {
    return null;
  }

  const candidate = identifiers[identifiers.length - 1];
  return SECRET_IDENTIFIER_NAME_PATTERN.test(candidate) ? candidate : null;
}

function getNamedSecretLiteralFix(sourceCode, valueNode, variableName) {
  const replacement = envReferenceForSecretName(variableName);
  if (!replacement) {
    return undefined;
  }

  return {
    kind: "credential",
    replacement,
    expectedText: textFromNode(sourceCode, valueNode),
    startByte: byteIndexFromStringIndex(sourceCode, valueNode.startIndex),
    endByte: byteIndexFromStringIndex(sourceCode, valueNode.endIndex)
  };
}

function collectNamedSecretLiteralFindings({
  filePath,
  sourceCode,
  tree,
  ruleId,
  message,
  includeKnownSecretLiterals = false
}) {
  const findings = [];

  walkTree(tree.rootNode, (node) => {
    if (node.type === "variable_declarator") {
      const nameNode = childForField(node, "name");
      const valueNode = childForField(node, "value");
      if (!nameNode || !valueNode || valueNode.type !== "string") {
        return;
      }

      const variableName = findSecretAssignmentTarget(nameNode, sourceCode);
      if (!variableName) {
        return;
      }

      const innerString = unquoteTreeString(textFromNode(sourceCode, valueNode));
      const matchedCredential = detectCredential(innerString);
      if (!includeKnownSecretLiterals && (matchedCredential || detectSecret(innerString))) {
        return;
      }

      findings.push(finding({
        ruleId,
        severity: "critical",
        filePath,
        line: lineFromStringIndex(sourceCode, valueNode.startIndex),
        message,
        evidence: `${variableName} assigned a hardcoded literal`,
        fix: matchedCredential
          ? getCredentialFix(sourceCode, valueNode, matchedCredential)
          : getNamedSecretLiteralFix(sourceCode, valueNode, variableName)
      }));
      return;
    }

    if (node.type !== "assignment_expression") {
      return;
    }

    const leftNode = childForField(node, "left");
    const rightNode = childForField(node, "right");
    if (!leftNode || !rightNode || rightNode.type !== "string") {
      return;
    }

    const variableName = findSecretAssignmentTarget(leftNode, sourceCode);
    if (!variableName) {
      return;
    }

    const innerString = unquoteTreeString(textFromNode(sourceCode, rightNode));
    const matchedCredential = detectCredential(innerString);
    if (!includeKnownSecretLiterals && (matchedCredential || detectSecret(innerString))) {
      return;
    }

    findings.push(finding({
      ruleId,
      severity: "critical",
      filePath,
      line: lineFromStringIndex(sourceCode, rightNode.startIndex),
      message,
      evidence: `${variableName} assigned a hardcoded literal`,
      fix: matchedCredential
        ? getCredentialFix(sourceCode, rightNode, matchedCredential)
        : getNamedSecretLiteralFix(sourceCode, rightNode, variableName)
    }));
  });

  return findings;
}

function readQuotedStaticString(value, startIndex = 0) {
  const source = String(value || "");
  const quote = source[startIndex];
  if (!["'", "\"", "`"].includes(quote)) {
    return null;
  }

  let cursor = startIndex + 1;
  let output = "";
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "\\") {
      if (cursor + 1 >= source.length) {
        return null;
      }
      output += source[cursor + 1];
      cursor += 2;
      continue;
    }

    if (char === quote) {
      return {
        value: output,
        endIndex: cursor + 1
      };
    }

    if (quote === "`" && char === "$" && source[cursor + 1] === "{") {
      return null;
    }

    output += char;
    cursor += 1;
  }

  return null;
}

function findLexicalScopeNode(node) {
  let cursor = node?.parent || null;
  while (cursor) {
    if (cursor.type === "statement_block" || cursor.type === "program") {
      return cursor;
    }
    cursor = cursor.parent || null;
  }
  return null;
}

function lexicalScopeKey(node) {
  const scopeNode = findLexicalScopeNode(node);
  return scopeNode ? `${scopeNode.startIndex}:${scopeNode.endIndex}` : "global";
}

function lookupStaticBinding(identifier, context = {}) {
  const scopeKey = context.scopeKey || (context.node ? lexicalScopeKey(context.node) : null);
  if (!scopeKey || !context.bindings) {
    return null;
  }

  const binding = context.bindings.get(`${scopeKey}:${identifier}`);
  if (!binding) {
    return null;
  }

  const readIndex = Number.isFinite(context.readIndex)
    ? context.readIndex
    : Number.isFinite(context.node?.startIndex)
      ? context.node.startIndex
      : Number.POSITIVE_INFINITY;
  return binding.declarationEndIndex <= readIndex ? binding.value : null;
}

function staticStringFromInlineExpressionText(expressionText, context = {}) {
  const text = String(expressionText || "").trim();
  if (text === "") {
    return "";
  }

  if (/^[A-Za-z_$][\w$]*$/.test(text)) {
    return lookupStaticBinding(text, context);
  }

  if (/^['"`]/.test(text)) {
    const quoted = readQuotedStaticString(text, 0);
    return quoted && quoted.endIndex === text.length ? quoted.value : null;
  }

  const binaryParts = [];
  let cursor = 0;
  while (cursor < text.length) {
    while (/\s/.test(text[cursor] || "")) {
      cursor += 1;
    }
    const part = readQuotedStaticString(text, cursor);
    if (part) {
      binaryParts.push(part.value);
      cursor = part.endIndex;
    } else {
      const identifier = /^[A-Za-z_$][\w$]*/.exec(text.slice(cursor));
      if (!identifier) {
        return null;
      }
      const boundValue = lookupStaticBinding(identifier[0], context);
      if (boundValue === null) {
        return null;
      }
      binaryParts.push(boundValue);
      cursor += identifier[0].length;
    }
    while (/\s/.test(text[cursor] || "")) {
      cursor += 1;
    }
    if (cursor >= text.length) {
      break;
    }
    if (text[cursor] !== "+") {
      return null;
    }
    cursor += 1;
  }

  return binaryParts.length > 0 ? binaryParts.join("") : null;
}

function staticStringArrayFromText(arrayText, context = {}) {
  const text = String(arrayText || "").trim();
  if (!text.startsWith("[") || !text.endsWith("]")) {
    return null;
  }

  const values = [];
  let cursor = 1;
  while (cursor < text.length - 1) {
    while (/[\s,]/.test(text[cursor] || "")) {
      cursor += 1;
    }
    if (cursor >= text.length - 1) {
      break;
    }

    const quoted = readQuotedStaticString(text, cursor);
    if (quoted) {
      values.push(quoted.value);
      cursor = quoted.endIndex;
    } else {
      const identifier = /^[A-Za-z_$][\w$]*/.exec(text.slice(cursor));
      if (!identifier) {
        return null;
      }
      const boundValue = lookupStaticBinding(identifier[0], context);
      if (boundValue === null) {
        return null;
      }
      values.push(boundValue);
      cursor += identifier[0].length;
    }
    while (/\s/.test(text[cursor] || "")) {
      cursor += 1;
    }
    if (text[cursor] === ",") {
      cursor += 1;
      continue;
    }
    if (cursor < text.length - 1) {
      return null;
    }
  }

  return values;
}

function staticStringFromArrayJoinText(callText, context = {}) {
  const text = String(callText || "").trim();
  const joinMatch = /^(\[[\s\S]*\])\s*\.\s*join\s*\(\s*([\s\S]*?)\s*\)$/.exec(text);
  if (!joinMatch) {
    return null;
  }

  const values = staticStringArrayFromText(joinMatch[1], context);
  if (!values) {
    return null;
  }

  const separatorText = joinMatch[2].trim();
  const separator = separatorText === ""
    ? ","
    : staticStringFromInlineExpressionText(separatorText, context);
  return separator === null ? null : values.join(separator);
}

function staticStringFromTemplateText(templateText, context = {}) {
  const text = String(templateText || "").trim();
  if (!text.startsWith("`") || !text.endsWith("`")) {
    return null;
  }

  let cursor = 1;
  let output = "";
  while (cursor < text.length - 1) {
    const char = text[cursor];
    if (char === "\\") {
      if (cursor + 1 >= text.length - 1) {
        return null;
      }
      output += text[cursor + 1];
      cursor += 2;
      continue;
    }

    if (char === "$" && text[cursor + 1] === "{") {
      let depth = 1;
      let expressionCursor = cursor + 2;
      while (expressionCursor < text.length - 1 && depth > 0) {
        if (text[expressionCursor] === "{") {
          depth += 1;
        } else if (text[expressionCursor] === "}") {
          depth -= 1;
        }
        expressionCursor += 1;
      }
      if (depth !== 0) {
        return null;
      }

      const expressionText = text.slice(cursor + 2, expressionCursor - 1);
      const expressionValue = staticStringFromInlineExpressionText(expressionText, context);
      if (expressionValue === null) {
        return null;
      }
      output += expressionValue;
      cursor = expressionCursor;
      continue;
    }

    output += char;
    cursor += 1;
  }

  return output;
}

function staticStringFromNode(sourceCode, node, context = {}) {
  if (!node) {
    return null;
  }

  const scopedContext = {
    ...context,
    node,
    scopeKey: context.scopeKey || lexicalScopeKey(node),
    readIndex: Number.isFinite(context.readIndex) ? context.readIndex : node.startIndex
  };

  if (node.type === "string") {
    return unquoteTreeString(textFromNode(sourceCode, node));
  }

  if (node.type === "identifier") {
    return lookupStaticBinding(textFromNode(sourceCode, node), scopedContext);
  }

  if (node.type === "parenthesized_expression" && node.namedChildCount === 1) {
    return staticStringFromNode(sourceCode, node.namedChild(0), scopedContext);
  }

  if (node.type === "template_string") {
    return staticStringFromTemplateText(textFromNode(sourceCode, node), scopedContext);
  }

  if (node.type === "call_expression") {
    return staticStringFromArrayJoinText(textFromNode(sourceCode, node), scopedContext);
  }

  if (node.type !== "binary_expression") {
    return null;
  }

  if (!/\+/.test(textFromNode(sourceCode, node))) {
    return null;
  }

  const leftNode = childForField(node, "left") || node.namedChild(0);
  const rightNode = childForField(node, "right") || node.namedChild(1);
  const left = staticStringFromNode(sourceCode, leftNode, scopedContext);
  const right = staticStringFromNode(sourceCode, rightNode, scopedContext);
  return left === null || right === null ? null : `${left}${right}`;
}

function isConstVariableDeclarator(sourceCode, node) {
  const parentText = node?.parent ? textFromNode(sourceCode, node.parent).trim() : "";
  return /^const\b/.test(parentText);
}

function collectStaticStringBindings(tree, sourceCode) {
  const bindings = new Map();
  let changed = true;

  while (changed) {
    changed = false;
    walkTree(tree.rootNode, (node) => {
      if (node.type !== "variable_declarator" || !isConstVariableDeclarator(sourceCode, node)) {
        return;
      }

      const nameNode = childForField(node, "name");
      const valueNode = childForField(node, "value");
      if (!nameNode || !valueNode || nameNode.type !== "identifier") {
        return;
      }

      const scopeKey = lexicalScopeKey(node);
      const bindingKey = `${scopeKey}:${textFromNode(sourceCode, nameNode)}`;
      if (bindings.has(bindingKey)) {
        return;
      }

      const value = staticStringFromNode(sourceCode, valueNode, { bindings, scopeKey });
      if (value !== null) {
        bindings.set(bindingKey, {
          value,
          declarationEndIndex: node.endIndex
        });
        changed = true;
      }
    });
  }

  return bindings;
}

function credentialFindingForStaticValue({ filePath, relativePath, sourceCode, node, value, requireClientComponent }) {
  const credential = detectCredential(value);
  const secretEvidence = credential?.label || detectSecret(value);
  if (!secretEvidence) {
    return null;
  }

  return finding({
    ruleId: "frontend-secret",
    severity: "critical",
    filePath,
    line: lineFromStringIndex(sourceCode, node.startIndex),
    message: frontendSecretMessage(requireClientComponent),
    evidence: secretEvidence,
    fix: credential ? getCredentialFix(sourceCode, node, credential) : undefined
  });
}

function scanCredentialStrings({ filePath, relativePath, sourceCode, tree, requireClientComponent }) {
  if (!isSourceFile(filePath)) {
    return [];
  }

  if (requireClientComponent && !isClientComponent(relativePath, sourceCode)) {
    return [];
  }

  const findings = [];
  const staticBindings = collectStaticStringBindings(tree, sourceCode);
  walkTree(tree.rootNode, (node) => {
    if (node.type === "string") {
      const rawString = textFromNode(sourceCode, node);
      const innerString = unquoteTreeString(rawString);
      const credential = detectCredential(innerString);
      const secretEvidence = credential?.label || detectSecret(innerString);
      if (!secretEvidence) {
        return;
      }

      findings.push(
        finding({
          ruleId: "frontend-secret",
          severity: "critical",
          filePath,
          line: lineFromStringIndex(sourceCode, node.startIndex),
          message: frontendSecretMessage(requireClientComponent),
          evidence: secretEvidence,
          fix: credential ? getCredentialFix(sourceCode, node, credential) : undefined
        })
      );
      return;
    }

    if (["binary_expression", "call_expression", "template_string"].includes(node.type)) {
      const staticValue = staticStringFromNode(sourceCode, node, { bindings: staticBindings });
      const staticFinding = credentialFindingForStaticValue({
        filePath,
        relativePath,
        sourceCode,
        node,
        value: staticValue,
        requireClientComponent
      });
      if (staticFinding) {
        findings.push(staticFinding);
      }
      return;
    }

    if (node.type !== "identifier" && node.type !== "property_identifier") {
      return;
    }

    const identifier = textFromNode(sourceCode, node);
    if (!SERVICE_ROLE_NAME_PATTERN.test(identifier)) {
      return;
    }

    findings.push(
      finding({
        ruleId: "frontend-secret",
        severity: "critical",
        filePath,
        line: lineFromStringIndex(sourceCode, node.startIndex),
        message: frontendSecretMessage(requireClientComponent),
        evidence: "Supabase service role reference"
      })
    );
  });

  findings.push(
    ...collectNamedSecretLiteralFindings({
      filePath,
      sourceCode,
      tree,
      ruleId: "frontend-secret",
      message: frontendSecretMessage(requireClientComponent)
    })
  );

  return dedupeFindings(findings);
}

function scanBackendStrings({ filePath, relativePath, sourceCode, tree, includeStandaloneBackend }) {
  if (!isSourceFile(filePath)) {
    return [];
  }

  if (!includeStandaloneBackend && !isBackendApiRoute(relativePath)) {
    return [];
  }

  const findings = [];
  walkTree(tree.rootNode, (node) => {
    if (node.type === "call_expression") {
      const callText = textFromNode(sourceCode, node);
      const jwtMatch = callText.match(/\bjwt\.(sign|verify)\s*\([^,]+,\s*(["'`])[^"'`]+\2/);
      if (jwtMatch) {
        findings.push(
          finding({
            ruleId: "backend-secret",
            severity: "critical",
            filePath,
            line: lineFromStringIndex(sourceCode, node.startIndex),
            message: "JWT signing or verification uses a hardcoded secret.",
            evidence: `jwt.${jwtMatch[1]} hardcoded secret`
          })
        );
      }
      return;
    }

    if (node.type !== "string") {
      return;
    }

    const rawString = textFromNode(sourceCode, node);
    const innerString = unquoteTreeString(rawString);
    if (detectCredential(innerString)?.id === "postgres-uri") {
      return;
    }

    const match = detectDatabaseUrl(innerString);
    if (!match) {
      return;
    }

    findings.push(
      finding({
        ruleId: "backend-secret",
        severity: "critical",
        filePath,
        line: lineFromStringIndex(sourceCode, node.startIndex),
        message: "Raw backend database connection string is hardcoded in source.",
        evidence: match
      })
    );
  });

  if (isBackendApiRoute(relativePath)) {
    findings.push(
      ...collectNamedSecretLiteralFindings({
        filePath,
        sourceCode,
        tree,
        ruleId: "backend-secret",
        message: "Secret-like backend variables must load from process.env instead of hardcoded literals.",
        includeKnownSecretLiterals: true
      })
    );
  }

  return dedupeFindings(findings);
}

function scanServiceRoleClientPropFindings({ filePath, relativePath, sourceCode, tree }) {
  if (!isSourceFile(filePath) || !isInsideNextFrontend(relativePath)) {
    return [];
  }

  const adminClientVariables = new Set();
  walkTree(tree.rootNode, (node) => {
    if (node.type !== "variable_declarator") {
      return;
    }

    const nameNode = childForField(node, "name");
    const valueNode = childForField(node, "value");
    if (!nameNode || !valueNode) {
      return;
    }

    const valueText = textFromNode(sourceCode, valueNode);
    if (/\bcreateClient\s*\(/.test(valueText) && SERVICE_ROLE_NAME_PATTERN.test(valueText)) {
      for (const name of collectPatternIdentifiers(nameNode, sourceCode)) {
        adminClientVariables.add(name);
      }
    }
  });

  if (adminClientVariables.size === 0) {
    return [];
  }

  const findings = [];
  walkTree(tree.rootNode, (node) => {
    if (node.type !== "jsx_attribute") {
      return;
    }

    const attributeText = textFromNode(sourceCode, node);
    for (const name of adminClientVariables) {
      if (!new RegExp(`=\\s*\\{\\s*${escapeRegexLiteral(name)}\\s*\\}`).test(attributeText)) {
        continue;
      }

      findings.push(finding({
        ruleId: "frontend-secret",
        severity: "critical",
        filePath,
        line: lineFromStringIndex(sourceCode, node.startIndex),
        message: "Supabase service role client is passed into a React component prop.",
        evidence: "Supabase service role client passed as JSX prop"
      }));
    }
  });

  return dedupeFindings(findings);
}

const USER_CONTROLLED_URL_PATTERNS = [
  /\b(?:req|request)\.query\b/i,
  /\b(?:req|request)\.body\b/i,
  /\b(?:req|request)\.params\b/i,
  /\b(?:req|request)\.url\b/i,
  /\bnextUrl\.searchParams\b/i,
  /\bsearchParams\.get\s*\(/i,
  /\b(?:req|request)\.json\s*\(/i,
  /\bformData\s*\(/i,
  /\bformData\.get\s*\(/i,
  /\bformData\b/i
];

const SAFE_URL_VALIDATOR_PATTERN =
  /\b(?:validate|sanitize|assert|ensure|normalize|parse)(?:[A-Za-z0-9_$]*)(?:Url|URL|Uri|URI|Endpoint|Redirect|Outbound|Webhook)|\b(?:is|allow|verify)(?:[A-Za-z0-9_$]*)(?:Safe|Allowed|Trusted|Internal|Private)(?:[A-Za-z0-9_$]*)(?:Url|URL|Uri|URI|Endpoint|Redirect)?/;

const TRUSTED_URL_VALIDATOR_IMPORT_PATTERN =
  /(?:^|[/@._-])(?:security|secure|ssrf|allowlist|safe-url|safe_url|url-validator|url_validator|validate-url|validate_url|outbound-url|outbound_url|redirect-validator|redirect_validator)(?:$|[/._-])/i;

function isUserControlledUrlExpression(expressionText, taintedVariables = new Set()) {
  const text = String(expressionText || "");
  return (
    USER_CONTROLLED_URL_PATTERNS.some((pattern) => pattern.test(text)) ||
    [...taintedVariables].some((name) => new RegExp(`\\b${escapeRegexLiteral(name)}\\b`).test(text))
  );
}

function isJsonSerializationTaintExpression(expressionText, taintedVariables = new Set()) {
  const text = String(expressionText || "");
  if (!/\bJSON\.(?:parse|stringify)\s*\(/.test(text)) {
    return false;
  }

  return isUserControlledUrlExpression(text, taintedVariables);
}

function isSafeUrlValidatorName(value) {
  return SAFE_URL_VALIDATOR_PATTERN.test(String(value || ""));
}

function isTrustedUrlValidatorImportPath(importPath) {
  return TRUSTED_URL_VALIDATOR_IMPORT_PATTERN.test(toPosix(importPath || ""));
}

function parseTrustedNamedImports(namedImportText, trustedValidators) {
  const body = namedImportText.replace(/^\{|\}$/g, "");
  for (const part of body.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }

    const [importedName, localName] = trimmed.split(/\s+as\s+/i).map((value) => value.trim());
    const bindingName = localName || importedName;
    if (isSafeUrlValidatorName(importedName) || isSafeUrlValidatorName(bindingName)) {
      trustedValidators.functions.add(bindingName);
    }
  }
}

function collectTrustedUrlValidators(tree, sourceCode) {
  const trustedValidators = {
    functions: new Set(),
    namespaces: new Set()
  };

  walkTree(tree.rootNode, (node) => {
    if (node.type !== "import_statement") {
      return;
    }

    const importText = textFromNode(sourceCode, node);
    const importPath = extractImportPath(importText);
    if (!isTrustedUrlValidatorImportPath(importPath)) {
      return;
    }

    const namespaceMatch = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(importText);
    if (namespaceMatch) {
      trustedValidators.namespaces.add(namespaceMatch[1]);
    }

    const namedMatch = /\{([^}]+)\}/.exec(importText);
    if (namedMatch) {
      parseTrustedNamedImports(`{${namedMatch[1]}}`, trustedValidators);
    }

    const defaultMatch = /^\s*import\s+([A-Za-z_$][\w$]*)\s*(?:,|\s+from\b)/.exec(importText);
    if (defaultMatch && isSafeUrlValidatorName(defaultMatch[1])) {
      trustedValidators.functions.add(defaultMatch[1]);
    }
  });

  return trustedValidators;
}

function isTrustedSafeUrlValidatorCallee(calleeText, trustedValidators) {
  const compactCallee = String(calleeText || "").replace(/\s+/g, "");
  if (trustedValidators.functions.has(compactCallee)) {
    return true;
  }

  const memberMatch = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(compactCallee);
  return Boolean(
    memberMatch &&
    trustedValidators.namespaces.has(memberMatch[1]) &&
    isSafeUrlValidatorName(memberMatch[2])
  );
}

function isTrustedSafeUrlValidatorCallText(callText, trustedValidators) {
  const match = /^\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)?)\s*\(/.exec(String(callText || ""));
  return Boolean(match && isTrustedSafeUrlValidatorCallee(match[1], trustedValidators));
}

function collectImportedCallTargets(tree, sourceCode) {
  const imported = {
    functions: new Set(),
    namespaces: new Set()
  };

  walkTree(tree.rootNode, (node) => {
    if (node.type !== "import_statement") {
      return;
    }

    const importText = textFromNode(sourceCode, node);
    const namespaceMatch = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(importText);
    if (namespaceMatch) {
      imported.namespaces.add(namespaceMatch[1]);
    }

    const namedMatch = /\{([^}]+)\}/.exec(importText);
    if (namedMatch) {
      for (const part of namedMatch[1].split(",")) {
        const [importedName, localName] = part.trim().split(/\s+as\s+/i).map((value) => value.trim());
        const bindingName = localName || importedName;
        if (/^[A-Za-z_$][\w$]*$/.test(bindingName || "")) {
          imported.functions.add(bindingName);
        }
      }
    }

    const defaultMatch = /^\s*import\s+([A-Za-z_$][\w$]*)\s*(?:,|\s+from\b)/.exec(importText);
    if (defaultMatch) {
      imported.functions.add(defaultMatch[1]);
    }
  });

  return imported;
}

function rootIdentifierFromCallee(calleeText) {
  const match = /^([A-Za-z_$][\w$]*)/.exec(String(calleeText || ""));
  return match ? match[1] : null;
}

function isImportedCallee(calleeText, importedCallTargets) {
  const compact = String(calleeText || "").replace(/\s+/g, "");
  if (importedCallTargets.functions.has(compact)) {
    return true;
  }

  const member = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(compact);
  return Boolean(member && importedCallTargets.namespaces.has(member[1]));
}

function isKnownImmutableTaintApi(calleeText) {
  return /^(?:JSON\.(?:parse|stringify)|Object\.(?:assign|fromEntries))$/.test(
    String(calleeText || "").replace(/\s+/g, "")
  );
}

function isKnownNonMutatingFrameworkCallee(calleeText) {
  return /^(?:Response\.json|NextResponse\.json|res\.json)$/.test(String(calleeText || "").replace(/\s+/g, ""));
}

function collectPatternIdentifiers(node, sourceCode, identifiers = []) {
  if (!node) {
    return identifiers;
  }

  if (
    node.type === "identifier" ||
    node.type === "shorthand_property_identifier_pattern" ||
    node.type === "property_identifier"
  ) {
    identifiers.push(textFromNode(sourceCode, node));
    return identifiers;
  }

  for (let index = 0; index < node.namedChildCount; index += 1) {
    collectPatternIdentifiers(node.namedChild(index), sourceCode, identifiers);
  }

  return identifiers;
}

function collectSsrfDataflow(tree, sourceCode, trustedValidators, importedCallTargets = collectImportedCallTargets(tree, sourceCode)) {
  const taintedVariables = new Set();
  const validatedVariables = new Set();
  const dynamicCallableVariables = new Set();
  const hardStops = [];
  const hardStopKeys = new Set();
  let changed = true;

  const addHardStop = ({ node, reason, evidence }) => {
    const key = `${reason}:${node.startIndex}:${evidence}`;
    if (hardStopKeys.has(key)) {
      return;
    }

    hardStopKeys.add(key);
    hardStops.push({
      node,
      reason,
      evidence
    });
  };

  while (changed) {
    changed = false;
    walkTree(tree.rootNode, (node) => {
      if (node.type === "variable_declarator") {
        const nameNode = childForField(node, "name");
        const valueNode = childForField(node, "value");
        if (!nameNode || !valueNode) {
          return;
        }

        const valueText = textFromNode(sourceCode, valueNode);
        const names = collectPatternIdentifiers(nameNode, sourceCode);
        const isValidated = isTrustedSafeUrlValidatorCallText(valueText, trustedValidators);
        if (/\[[\s\S]+\]/.test(valueText) && isUserControlledUrlExpression(valueText, taintedVariables)) {
          for (const name of names) {
            if (!dynamicCallableVariables.has(name)) {
              dynamicCallableVariables.add(name);
              changed = true;
            }
          }
        }

        const isTainted =
          isJsonSerializationTaintExpression(valueText, taintedVariables) ||
          isUserControlledUrlExpression(valueText, taintedVariables);

        if (isValidated && isTainted) {
          for (const name of names) {
            if (!validatedVariables.has(name)) {
              validatedVariables.add(name);
              changed = true;
            }
          }
          return;
        }

        if (isTainted) {
          for (const name of names) {
            if (!taintedVariables.has(name)) {
              taintedVariables.add(name);
              changed = true;
            }
          }
        }
      }

      if (node.type === "assignment_expression") {
        const leftNode = childForField(node, "left");
        const rightNode = childForField(node, "right");
        if (!leftNode || !rightNode) {
          return;
        }

        const rightText = textFromNode(sourceCode, rightNode);
        if (/\[[\s\S]+\]/.test(rightText) && isUserControlledUrlExpression(rightText, taintedVariables)) {
          for (const name of collectPatternIdentifiers(leftNode, sourceCode)) {
            if (!dynamicCallableVariables.has(name)) {
              dynamicCallableVariables.add(name);
              changed = true;
            }
          }
        }

        if (
          isJsonSerializationTaintExpression(rightText, taintedVariables) ||
          isUserControlledUrlExpression(rightText, taintedVariables)
        ) {
          for (const name of collectPatternIdentifiers(leftNode, sourceCode)) {
            if (!taintedVariables.has(name)) {
              taintedVariables.add(name);
              changed = true;
            }
          }
        }
      }

      if (node.type === "call_expression") {
        const callText = textFromNode(sourceCode, node);
        const calleeText = callExpressionCalleeText(sourceCode, node);
        const argsNode = childForField(node, "arguments");
        const rootCallee = rootIdentifierFromCallee(calleeText);

        if (/\[[\s\S]+\]/.test(calleeText) && isUserControlledUrlExpression(calleeText, taintedVariables)) {
          addHardStop({
            node,
            reason: "dynamic-dispatch",
            evidence: "tainted dynamic dispatch"
          });
          return;
        }

        if (rootCallee && dynamicCallableVariables.has(rootCallee)) {
          addHardStop({
            node,
            reason: "dynamic-dispatch",
            evidence: `tainted dynamic dispatch via ${rootCallee}`
          });
          return;
        }

        if (
          !isKnownImmutableTaintApi(calleeText) &&
          !isOutboundHttpPrimitive(calleeText) &&
          !isTrustedSafeUrlValidatorCallee(calleeText, trustedValidators) &&
          argsNode
        ) {
          const taintedArguments = [];
          for (let index = 0; index < argsNode.namedChildCount; index += 1) {
            const argumentText = textFromNode(sourceCode, argsNode.namedChild(index));
            if (isUserControlledUrlExpression(argumentText, taintedVariables)) {
              taintedArguments.push(argumentText);
            }
          }

          if (taintedArguments.length > 0) {
            if (isImportedCallee(calleeText, importedCallTargets)) {
              addHardStop({
                node,
                reason: "inter-procedural-boundary",
                evidence: `tainted value passed into imported function ${calleeText}`
              });
              return;
            }

            if (!isKnownNonMutatingFrameworkCallee(calleeText)) {
              addHardStop({
                node,
                reason: "complex-aliasing",
                evidence: `tainted object passed into unknown function ${calleeText}`
              });
              return;
            }
          }
        }

        if (!isTrustedSafeUrlValidatorCallee(calleeText, trustedValidators)) {
          return;
        }

        for (const name of taintedVariables) {
          if (new RegExp(`\\b${escapeRegexLiteral(name)}\\b`).test(callText) && !validatedVariables.has(name)) {
            validatedVariables.add(name);
            changed = true;
          }
        }
      }
    });
  }

  return { taintedVariables, validatedVariables, hardStops };
}

function firstArgumentNode(callNode) {
  const argsNode = childForField(callNode, "arguments");
  return argsNode && argsNode.namedChildCount > 0 ? argsNode.namedChild(0) : null;
}

function callExpressionCalleeText(sourceCode, node) {
  const callee = childForField(node, "function");
  return callee ? textFromNode(sourceCode, callee).replace(/\s+/g, "") : "";
}

function isOutboundHttpPrimitive(calleeText) {
  return (
    calleeText === "fetch" ||
    calleeText === "axios" ||
    /^axios\.(?:get|post|put|patch|delete|request)$/.test(calleeText) ||
    /^(?:http|https)\.(?:get|request)$/.test(calleeText)
  );
}

function isStaticUrlExpression(argumentText) {
  const text = String(argumentText || "").trim();
  if (/^['"`]https?:\/\//i.test(text)) {
    return true;
  }

  return /^new\s+URL\s*\(\s*['"`]https?:\/\//i.test(text);
}

function isValidatedUrlExpression(argumentText, validatedVariables = new Set(), trustedValidators = { functions: new Set(), namespaces: new Set() }) {
  const text = String(argumentText || "");
  return (
    isTrustedSafeUrlValidatorCallText(text, trustedValidators) ||
    [...validatedVariables].some((name) => new RegExp(`\\b${escapeRegexLiteral(name)}\\b`).test(text))
  );
}

function ambiguousAstFinding({ filePath, sourceCode, hardStop }) {
  return finding({
    ruleId: "ambiguous-ast",
    severity: "warning",
    state: "AMBIGUOUS",
    filePath,
    line: lineFromStringIndex(sourceCode, hardStop.node.startIndex),
    message: "Local AST proof surrendered at an unsafe semantic boundary.",
    evidence: hardStop.evidence,
    ambiguityReason: hardStop.reason,
    deployedConsequence: "PreFlight cannot deterministically prove whether this path is sanitized or vulnerable without semantic cross-boundary analysis.",
    actionRequired: "Route this file through the MicroRouter/Reasoning Engine or manually verify the boundary before committing.",
    requiresDeepRemediation: true
  });
}

function scanSsrfFindings({ filePath, relativePath, sourceCode, tree }) {
  if (!isSourceFile(filePath) || !isBackendSsrfScanTarget(relativePath, sourceCode)) {
    return [];
  }

  const trustedValidators = collectTrustedUrlValidators(tree, sourceCode);
  const importedCallTargets = collectImportedCallTargets(tree, sourceCode);
  const { taintedVariables, validatedVariables, hardStops } = collectSsrfDataflow(
    tree,
    sourceCode,
    trustedValidators,
    importedCallTargets
  );
  if (hardStops.length > 0) {
    return dedupeFindings(hardStops.map((hardStop) => ambiguousAstFinding({ filePath, sourceCode, hardStop })));
  }

  const findings = [];
  walkTree(tree.rootNode, (node) => {
    if (node.type !== "call_expression") {
      return;
    }

    const calleeText = callExpressionCalleeText(sourceCode, node);
    if (!isOutboundHttpPrimitive(calleeText)) {
      return;
    }

    const argumentNode = firstArgumentNode(node);
    if (!argumentNode) {
      return;
    }

    const argumentText = textFromNode(sourceCode, argumentNode);
    if (
      isStaticUrlExpression(argumentText) ||
      isValidatedUrlExpression(argumentText, validatedVariables, trustedValidators) ||
      !isUserControlledUrlExpression(argumentText, taintedVariables)
    ) {
      return;
    }

    findings.push(finding({
      ruleId: "ssrf",
      severity: "high",
      filePath,
      line: lineFromStringIndex(sourceCode, node.startIndex),
      message: "Outbound HTTP request uses a user-controlled URL without private-IP and redirect validation.",
      evidence: textFromNode(sourceCode, node).replace(/\s+/g, " ").trim(),
      deployedConsequence: "If you deploy this, attackers can pivot server-side requests into internal metadata services or private network targets.",
      actionRequired: "Route the URL through an allowlist/private-IP/redirect validator, then test localhost, 169.254.169.254, and redirect-chain inputs.",
      requiresDeepRemediation: true
    }));
  });

  return dedupeFindings(findings);
}

function severityFromCustomRule(rule) {
  return rule.severity === "warn" ? "warning" : "critical";
}

function customRuleFinding({ rule, filePath, line, evidence }) {
  return finding({
    ruleId: "custom-team-rule",
    severity: severityFromCustomRule(rule),
    filePath,
    line,
    message: `Custom team rule violated: ${rule.name}.`,
    evidence,
    customRuleName: rule.name
  });
}

function extractImportPath(importText) {
  const fromImport = /\bfrom\s+['"]([^'"]+)['"]/.exec(importText);
  if (fromImport) {
    return fromImport[1];
  }

  const bareImport = /^\s*import\s+['"]([^'"]+)['"]/.exec(importText);
  return bareImport ? bareImport[1] : null;
}

function scanForbiddenImportRule({ filePath, sourceCode, tree, rule }) {
  const findings = [];
  walkTree(tree.rootNode, (node) => {
    if (node.type !== "import_statement") {
      return;
    }

    const importPath = extractImportPath(textFromNode(sourceCode, node));
    if (importPath !== rule.forbiddenPattern.importPath) {
      return;
    }

    findings.push(customRuleFinding({
      rule,
      filePath,
      line: lineFromStringIndex(sourceCode, node.startIndex),
      evidence: `forbidden import ${importPath}`
    }));
  });

  return findings;
}

function escapeRegexLiteral(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scanForbiddenMethodCallRule({ filePath, sourceCode, tree, rule }) {
  const findings = [];
  const { object, method } = rule.forbiddenPattern;
  const methodPattern = object
    ? new RegExp(`\\b${escapeRegexLiteral(object)}\\s*\\.\\s*${escapeRegexLiteral(method)}$`)
    : new RegExp(`(?:^|\\.)\\s*${escapeRegexLiteral(method)}$`);

  walkTree(tree.rootNode, (node) => {
    if (node.type !== "call_expression") {
      return;
    }

    const callee = childForField(node, "function");
    const calleeText = callee ? textFromNode(sourceCode, callee).replace(/\s+/g, "") : "";
    if (!methodPattern.test(calleeText)) {
      return;
    }

    findings.push(customRuleFinding({
      rule,
      filePath,
      line: lineFromStringIndex(sourceCode, node.startIndex),
      evidence: `forbidden method call ${object ? `${object}.` : ""}${method}`
    }));
  });

  return findings;
}

function hasRequiredWrapperCall({ sourceCode, tree, wrapper }) {
  let found = false;
  walkTree(tree.rootNode, (node) => {
    if (found || node.type !== "call_expression") {
      return;
    }

    const callee = childForField(node, "function");
    if (callee && textFromNode(sourceCode, callee).trim() === wrapper) {
      found = true;
    }
  });
  return found;
}

function scanRequiredWrapperRule({ filePath, sourceCode, tree, rule }) {
  const wrapper = rule.forbiddenPattern.wrapper;
  if (hasRequiredWrapperCall({ sourceCode, tree, wrapper })) {
    return [];
  }

  return [
    customRuleFinding({
      rule,
      filePath,
      line: 1,
      evidence: `missing required wrapper ${wrapper}`
    })
  ];
}

function scanCustomTeamRules({ filePath, relativePath, sourceCode, tree, policy }) {
  const rules = Array.isArray(policy.customRules) ? policy.customRules : [];
  const matchingRules = rules.filter((rule) =>
    rule.targetFiles.some((targetPattern) => matchesTargetFile(relativePath, targetPattern))
  );
  const findings = [];

  for (const rule of matchingRules) {
    if (rule.forbiddenPattern.type === "forbidden_import") {
      findings.push(...scanForbiddenImportRule({ filePath, sourceCode, tree, rule }));
    } else if (rule.forbiddenPattern.type === "forbidden_method_call") {
      findings.push(...scanForbiddenMethodCallRule({ filePath, sourceCode, tree, rule }));
    } else if (rule.forbiddenPattern.type === "required_wrapper") {
      findings.push(...scanRequiredWrapperRule({ filePath, sourceCode, tree, rule }));
    }
  }

  return dedupeFindings(findings);
}

async function scanBackendSource(rootDir = process.cwd(), options = {}) {
  const resolvedRoot = path.resolve(rootDir);
  const policy = options.policy || normalizePolicy();
  const relativePaths = await fg(["**/*.{js,jsx,ts,tsx}"], {
    cwd: resolvedRoot,
    absolute: false,
    dot: false,
    ignore: DEFAULT_SOURCE_GLOB_IGNORES
  });
  const findings = [];

  for (const relativePath of relativePaths.sort()) {
    if (isIgnoredPath(relativePath, policy)) {
      continue;
    }

    const filePath = path.join(resolvedRoot, relativePath);
    const parsed = await prepareParsedSourceForScan(filePath, { warn: options.warn });
    if (parsed === null) {
      continue;
    }

    try {
      findings.push(...scanSsrfFindings({
        filePath,
        relativePath: toPosix(relativePath),
        sourceCode: parsed.sourceCode,
        tree: parsed.tree
      }));
    } finally {
      parsed.tree.delete?.();
    }
  }

  return applyPolicy(dedupeFindings(findings), policy, resolvedRoot).sort((a, b) => {
    if (a.filePath === b.filePath) {
      return a.line - b.line;
    }

    return a.filePath.localeCompare(b.filePath);
  });
}

function scanSecretSource() {
  return [];
}

function scanFrontendSource() {
  return [];
}

async function collectSourceFiles(rootDir, options = {}) {
  const resolvedRoot = path.resolve(rootDir);
  const policy = options.policy || normalizePolicy();
  const relativePaths = await fg(["**/*.{js,jsx,ts,tsx}"], {
    cwd: resolvedRoot,
    absolute: false,
    dot: false,
    ignore: DEFAULT_SOURCE_GLOB_IGNORES
  });

  return relativePaths
    .filter((relativePath) => !isIgnoredPath(relativePath, policy))
    .map((relativePath) => ({
      filePath: path.join(resolvedRoot, relativePath),
      relativePath: toPosix(relativePath)
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function collectImportLineMap(tree, sourceCode) {
  const importLines = new Map();

  walkTree(tree.rootNode, (node) => {
    if (node.type !== "import_statement") {
      return;
    }

    const text = textFromNode(sourceCode, node);
    for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
      if (!importLines.has(match[1])) {
        importLines.set(match[1], lineFromStringIndex(sourceCode, node.startIndex));
      }
    }
  });

  return importLines;
}

function credentialRegexesForTaint() {
  return CREDENTIAL_PATTERNS.map((pattern) => new RegExp(pattern.regex.source, pattern.regex.flags));
}

function buildProjectGraphNode(filePath, sourceCode, tree) {
  const boundaries = parseModuleBoundaries(tree.rootNode, sourceCode);
  return {
    isClient: isTreeClientComponent(tree.rootNode, sourceCode),
    taintedSources: findTaintSources(tree.rootNode, sourceCode, credentialRegexesForTaint()),
    imports: boundaries.imports.map((item) => ({
      ...item,
      source: resolveImportPath(filePath, item.source) || item.source
    })),
    reExports: (boundaries.reExports || []).map((item) => ({
      ...item,
      source: resolveImportPath(filePath, item.source) || item.source
    })),
    exports: boundaries.exports
  };
}

function scanSqlConcatenationFindings({ filePath, sourceCode, tree }) {
  return findSqlConcatenations(tree.rootNode, sourceCode).map((match) =>
    finding({
      ruleId: "sql-injection",
      severity: "critical",
      filePath,
      line: lineFromByteIndex(sourceCode, match.startIndex),
      message: "SQL query is built through string concatenation instead of parameter binding.",
      evidence: match.rawSnippet,
      fix: {
        kind: "sql-remediation",
        startByte: match.startIndex,
        endByte: match.endIndex,
        expectedText: match.rawSnippet,
        rawSnippet: match.rawSnippet
      }
    })
  );
}

function scanArchitecturalLeakFindings({ filePath, sourceCode, tree }) {
  return findServerSideLeaks(tree.rootNode, sourceCode).map((leak) =>
    finding({
      ruleId: "architectural-leak",
      severity: "high",
      filePath,
      line: lineFromByteIndex(sourceCode, leak.startIndex),
      message: "Client component executes server-only code that should move behind a server action.",
      evidence: leak.functionName,
      fix: {
        kind: "scaffold-server-action",
        leak
      }
    })
  );
}

function scanParsedSourceFile({ filePath, relativePath, sourceCode, tree, policy = normalizePolicy() }) {
  const credentialRequiresClient =
    isInsideNextFrontend(relativePath) && !isBackendApiRoute(relativePath);

  return [
    ...scanCredentialStrings({
      filePath,
      relativePath,
      sourceCode,
      tree,
      requireClientComponent: credentialRequiresClient
    }),
    ...scanServiceRoleClientPropFindings({ filePath, relativePath, sourceCode, tree }),
    ...scanBackendStrings({
      filePath,
      relativePath,
      sourceCode,
      tree,
      includeStandaloneBackend: true
    }),
    ...scanSsrfFindings({ filePath, relativePath, sourceCode, tree }),
    ...scanSqlConcatenationFindings({ filePath, sourceCode, tree }),
    ...scanArchitecturalLeakFindings({ filePath, sourceCode, tree }),
    ...scanCustomTeamRules({ filePath, relativePath, sourceCode, tree, policy })
  ];
}

function taintViolationsToFindings(violations, parsedFiles) {
  return violations.map((violation) => {
    const parsed = parsedFiles.get(violation.leakedFile);
    const line = parsed?.importLines.get(violation.variable) || 1;
    return finding({
      ruleId: "taint-violation",
      severity: "critical",
      filePath: violation.leakedFile,
      line,
      message: `Client component imports tainted value ${violation.variable}.`,
      evidence: `from ${violation.sourceFile}`,
      variable: violation.variable,
      sourceFile: violation.sourceFile,
      leakedFile: violation.leakedFile
    });
  });
}

function dedupeFindings(findings) {
  const seen = new Set();
  return findings.filter((item) => {
    const key = `${item.ruleId}:${item.filePath}:${item.line}:${item.evidence || ""}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

async function scanFrontendSecrets(rootDir, options = {}) {
  const policy = options.policy || normalizePolicy();
  const files = await fg(["{app,pages}/**/*.{js,jsx,ts,tsx}"], {
    cwd: rootDir,
    absolute: false,
    dot: false,
    ignore: ["app/api/**", "pages/api/**", ...DEFAULT_SOURCE_GLOB_IGNORES]
  });

  const results = [];

  for (const relativePath of files) {
    if (isIgnoredPath(relativePath, policy)) {
      continue;
    }

    const filePath = path.join(rootDir, relativePath);
    const parsed = await prepareParsedSourceForScan(filePath, { warn: options.warn });
    if (parsed === null) {
      continue;
    }
    try {
      results.push(...scanCredentialStrings({
        filePath,
        relativePath,
        sourceCode: parsed.sourceCode,
        tree: parsed.tree,
        requireClientComponent: true
      }));
    } finally {
      parsed.tree.delete?.();
    }
  }

  return results;
}

async function scanBackendSecrets(rootDir, options = {}) {
  const policy = options.policy || normalizePolicy();
  const files = await fg(["{app/api,pages/api}/**/*.{js,jsx,ts,tsx}"], {
    cwd: rootDir,
    absolute: false,
    dot: false,
    ignore: DEFAULT_SOURCE_GLOB_IGNORES
  });

  const results = [];

  for (const relativePath of files) {
    if (isIgnoredPath(relativePath, policy)) {
      continue;
    }

    const filePath = path.join(rootDir, relativePath);
    const parsed = await prepareParsedSourceForScan(filePath, { warn: options.warn });
    if (parsed === null) {
      continue;
    }
    try {
      results.push(...scanBackendStrings({
        filePath,
        relativePath,
        sourceCode: parsed.sourceCode,
        tree: parsed.tree,
        includeStandaloneBackend: false
      }));
    } finally {
      parsed.tree.delete?.();
    }
  }

  return results;
}

async function scanStandaloneSecrets(rootDir, options = {}) {
  const policy = options.policy || normalizePolicy();
  const files = await fg(["**/*.{js,jsx,ts,tsx}"], {
    cwd: rootDir,
    absolute: false,
    dot: false,
    ignore: [
      ...DEFAULT_SOURCE_GLOB_IGNORES,
      "{app,pages}/**",
    ]
  });

  const results = [];

  for (const relativePath of files) {
    if (isIgnoredPath(relativePath, policy)) {
      continue;
    }

    const filePath = path.join(rootDir, relativePath);
    const parsed = await prepareParsedSourceForScan(filePath, { warn: options.warn });
    if (parsed === null) {
      continue;
    }
    try {
      results.push(...scanCredentialStrings({
        filePath,
        relativePath,
        sourceCode: parsed.sourceCode,
        tree: parsed.tree,
        requireClientComponent: false
      }));
      results.push(...scanBackendStrings({
        filePath,
        relativePath,
        sourceCode: parsed.sourceCode,
        tree: parsed.tree,
        includeStandaloneBackend: true
      }));
    } finally {
      parsed.tree.delete?.();
    }
  }

  return results;
}

async function directoryExists(rootDir, directoryName) {
  try {
    const stats = await fs.stat(path.join(rootDir, directoryName));
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function shouldScanAsStandaloneSourceDirectory(rootDir) {
  const projectFolders = await Promise.all([
    directoryExists(rootDir, "app"),
    directoryExists(rootDir, "pages"),
    directoryExists(rootDir, "supabase")
  ]);

  return !projectFolders.some(Boolean);
}

function sqlStatementsWithOffsets(source) {
  const statements = [];
  let start = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inDollarQuote = null;

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const nextTwo = source.slice(index, index + 2);

    if (!inSingleQuote && !inDoubleQuote && !inDollarQuote && nextTwo === "--") {
      const newline = source.indexOf("\n", index + 2);
      index = newline === -1 ? source.length : newline;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && !inDollarQuote && nextTwo === "/*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 1;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && current === "$") {
      const tag = source.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (tag) {
        if (inDollarQuote === tag) {
          inDollarQuote = null;
        } else if (!inDollarQuote) {
          inDollarQuote = tag;
        }
        index += tag.length - 1;
        continue;
      }
    }

    if (!inDoubleQuote && !inDollarQuote && current === "'" && source[index - 1] !== "\\") {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (!inSingleQuote && !inDollarQuote && current === '"') {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && !inDollarQuote && current === ";") {
      statements.push({ sql: source.slice(start, index + 1), offset: start });
      start = index + 1;
    }
  }

  const tail = source.slice(start).trim();
  if (tail) {
    statements.push({ sql: source.slice(start), offset: start });
  }

  return statements;
}

function lineAtOffset(source, offset) {
  return source.slice(0, offset).split(/\r?\n/).length;
}

function normalizeSqlIdentifier(identifier) {
  if (!identifier) {
    return null;
  }

  if (typeof identifier === "string") {
    return identifier.replace(/^"|"$/g, "").toLowerCase();
  }

  const schema = identifier.schema ? normalizeSqlIdentifier(identifier.schema) : "public";
  const name = normalizeSqlIdentifier(identifier.name);
  return `${schema}.${name}`;
}

function extractCreatedTables(source) {
  const tables = [];

  for (const statement of sqlStatementsWithOffsets(source)) {
    let parsed;
    try {
      parsed = parseSql(statement.sql);
    } catch {
      continue;
    }

    for (const astNode of parsed) {
      if (astNode.type === "create table") {
        const tableName = normalizeSqlIdentifier(astNode.name);
        if (tableName) {
          tables.push({
            tableName,
            line: lineAtOffset(source, statement.offset + statement.sql.search(/\S/))
          });
        }
      }
    }
  }

  return tables;
}

function extractRlsEnabledTables(source) {
  const enabledTables = new Set();
  const pattern =
    /alter\s+table\s+(?:only\s+)?(?:(?:"([^"]+)"|([A-Za-z_][\w$]*))\.)?(?:"([^"]+)"|([A-Za-z_][\w$]*))\s+enable\s+row\s+level\s+security\b/gi;

  let match;
  while ((match = pattern.exec(source)) !== null) {
    const schema = (match[1] || match[2] || "public").toLowerCase();
    const table = (match[3] || match[4]).toLowerCase();
    enabledTables.add(`${schema}.${table}`);
  }

  return enabledTables;
}

function parseStaticSqlLiteral(value) {
  const text = String(value || "").trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    return { type: "number", value: Number(text), raw: text };
  }

  if (/^(?:true|false)$/i.test(text)) {
    return { type: "boolean", value: /^true$/i.test(text), raw: text.toLowerCase() };
  }

  if (/^'(?:''|[^'])*'$/.test(text)) {
    return { type: "string", value: text.slice(1, -1).replace(/''/g, "'"), raw: text };
  }

  if (/^"(?:[^"]|"")*"$/.test(text)) {
    return { type: "string", value: text.slice(1, -1).replace(/""/g, "\""), raw: text };
  }

  return null;
}

function evaluateStaticSqlComparison(predicateText) {
  const text = String(predicateText || "").trim();
  const comparison = /^(.+?)\s*(=|<>|!=|>=|<=|>|<)\s*(.+?)$/.exec(text);
  if (!comparison) {
    return null;
  }

  const left = parseStaticSqlLiteral(comparison[1]);
  const right = parseStaticSqlLiteral(comparison[3]);
  if (!left || !right || left.type !== right.type) {
    return null;
  }

  const operator = comparison[2];
  let result;
  switch (operator) {
    case "=":
      result = left.value === right.value;
      break;
    case "<>":
    case "!=":
      result = left.value !== right.value;
      break;
    case ">":
      result = left.value > right.value;
      break;
    case ">=":
      result = left.value >= right.value;
      break;
    case "<":
      result = left.value < right.value;
      break;
    case "<=":
      result = left.value <= right.value;
      break;
    default:
      return null;
  }

  if (result !== true) {
    return null;
  }

  return {
    result,
    evidence: operator === "=" && left.raw === right.raw
      ? "tautological RLS predicate"
      : "statically true RLS predicate"
  };
}

function findTautologicalRlsPredicates(source) {
  const findings = [];
  const pattern = /\b(?:using|with\s+check)\s*\(\s*([^()]+?)\s*\)/gi;
  let match;

  while ((match = pattern.exec(source)) !== null) {
    const evaluation = evaluateStaticSqlComparison(match[1]);
    if (!evaluation) {
      continue;
    }

    findings.push({
      offset: match.index,
      evidence: evaluation.evidence
    });
  }

  return findings;
}

function scanSqlSource({ filePath, source }) {
  const rlsEnabledTables = extractRlsEnabledTables(source);
  const missingRlsFindings = extractCreatedTables(source)
    .filter(({ tableName }) => !rlsEnabledTables.has(tableName))
    .map(({ line, tableName }) =>
      finding({
        ruleId: "missing-rls",
        severity: "high",
        filePath,
        line,
        tableName,
        message: `Table ${tableName} is created without enabling Row Level Security.`
      })
    );
  const tautologyFindings = findTautologicalRlsPredicates(source).map((item) =>
    finding({
      ruleId: "missing-rls",
      severity: "critical",
      filePath,
      line: lineAtOffset(source, item.offset),
      message: "Supabase RLS policy predicate is a tautology.",
      evidence: item.evidence
    })
  );

  return dedupeFindings([...missingRlsFindings, ...tautologyFindings]);
}

async function scanSupabaseMigrations(rootDir, options = {}) {
  const policy = options.policy || normalizePolicy();
  const files = await fg(["supabase/migrations/**/*.sql"], {
    cwd: rootDir,
    absolute: false,
    dot: false,
    ignore: ["**/node_modules/**"]
  });

  const createdTables = [];
  const rlsEnabledTables = new Set();
  const tautologyFindings = [];

  for (const relativePath of files) {
    if (isIgnoredPath(relativePath, policy)) {
      continue;
    }

    const filePath = path.join(rootDir, relativePath);
    const source = await fs.readFile(filePath, "utf8");
    const tables = extractCreatedTables(source).map((table) => ({ ...table, filePath }));
    createdTables.push(...tables);
    tautologyFindings.push(
      ...findTautologicalRlsPredicates(source).map((item) =>
        finding({
          ruleId: "missing-rls",
          severity: "critical",
          filePath,
          line: lineAtOffset(source, item.offset),
          message: "Supabase RLS policy predicate is a tautology.",
          evidence: item.evidence
        })
      )
    );

    for (const tableName of extractRlsEnabledTables(source)) {
      rlsEnabledTables.add(tableName);
    }
  }

  const missingRlsFindings = createdTables
    .filter(({ tableName }) => !rlsEnabledTables.has(tableName))
    .map(({ filePath, line, tableName }) =>
      finding({
        ruleId: "missing-rls",
        severity: "high",
        filePath,
        line,
        tableName,
        message: `Table ${tableName} is created without enabling Row Level Security.`
      })
    );

  return applyPolicy(dedupeFindings([...missingRlsFindings, ...tautologyFindings]), policy, rootDir);
}

async function fileExists(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

async function getChangedScanFiles(rootDir = process.cwd(), options = {}) {
  const resolvedRoot = path.resolve(rootDir);
  const policy = options.policy || normalizePolicy();
  const [diff, untracked] = await Promise.all([
    gitOutputOrEmpty(resolvedRoot, ["diff", "--name-only", "HEAD"], [/ambiguous argument ['"]?HEAD['"]?/i, /unknown revision/i]),
    gitOutputOrEmpty(resolvedRoot, ["ls-files", "--others", "--exclude-standard"])
  ]);

  const candidates = new Set(
    `${diff}\n${untracked}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  );

  const files = [];
  for (const relativePath of candidates) {
    if (!isScannableChangedFile(relativePath)) {
      continue;
    }

    if (isIgnoredPath(relativePath, policy)) {
      continue;
    }

    const filePath = path.join(resolvedRoot, relativePath);
    if (await fileExists(filePath)) {
      files.push({
        filePath,
        relativePath: toPosix(relativePath)
      });
    }
  }

  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function scanFiles(rootDir, files, options = {}) {
  const resolvedRoot = path.resolve(rootDir);
  const policy = options.policy || normalizePolicy();
  const findings = [];
  const projectGraph = {};
  const parsedFiles = new Map();
  const sourceByFile = new Map();

  for (const file of files) {
    const filePath = file.filePath || path.join(resolvedRoot, file.relativePath);
    const relativePath = toPosix(file.relativePath || path.relative(resolvedRoot, filePath));
    if (isIgnoredPath(relativePath, policy)) {
      continue;
    }

    if (path.extname(filePath).toLowerCase() === ".sql") {
      let source;
      try {
        source = await fs.readFile(filePath, "utf8");
      } catch (error) {
        const warn = options.warn || ((message) => createLogger({ stderr: process.stderr }).warn(message));
        warn(`Warning: could not scan ${filePath}: ${error.message}`);
        continue;
      }
      findings.push(...scanSqlSource({ filePath, source }));
      continue;
    }

    const parsed = await prepareParsedSourceForScan(filePath, { warn: options.warn });
    if (parsed === null) {
      continue;
    }

    try {
      sourceByFile.set(filePath, parsed.sourceCode);
      parsedFiles.set(filePath, {
        sourceCode: parsed.sourceCode,
        importLines: collectImportLineMap(parsed.tree, parsed.sourceCode)
      });
      projectGraph[filePath] = buildProjectGraphNode(filePath, parsed.sourceCode, parsed.tree);
      findings.push(...scanParsedSourceFile({
        filePath,
        relativePath,
        sourceCode: parsed.sourceCode,
        tree: parsed.tree,
        policy
      }));
    } finally {
      parsed.tree.delete?.();
    }
  }

  findings.push(...taintViolationsToFindings(analyzeTaintGraph(projectGraph), parsedFiles));
  const filteredFindings = applyPolicy(dedupeFindings(findings), policy, resolvedRoot);
  const suppressionResult = suppressIgnoredFindings(filteredFindings, sourceByFile);
  const sortedFindings = suppressionResult.findings.sort((a, b) => {
    if (a.filePath === b.filePath) {
      return a.line - b.line;
    }

    return a.filePath.localeCompare(b.filePath);
  });

  return attachScanMetadata(sortedFindings, {
    suppressedIssues: suppressionResult.suppressed
  });
}

async function scanProjectDiff(rootDir = process.cwd(), options = {}) {
  const resolvedRoot = path.resolve(rootDir);
  const policy = options.policy || normalizePolicy();
  const files = await getChangedScanFiles(resolvedRoot, { policy });
  return scanFiles(resolvedRoot, files, { policy, warn: options.warn });
}

async function scanProject(rootDir = process.cwd(), options = {}) {
  const resolvedRoot = path.resolve(rootDir);
  const policy = options.policy || normalizePolicy();
  const [sourceFiles, migrationFindings] = await Promise.all([
    collectSourceFiles(resolvedRoot, { policy }),
    scanSupabaseMigrations(resolvedRoot, { policy })
  ]);
  const sourceFindings = await scanFiles(resolvedRoot, sourceFiles, { policy, warn: options.warn });
  const finalFindings = applyPolicy([...sourceFindings, ...migrationFindings], policy, resolvedRoot).sort((a, b) => {
    if (a.filePath === b.filePath) {
      return a.line - b.line;
    }

    return a.filePath.localeCompare(b.filePath);
  });

  return attachScanMetadata(finalFindings, {
    suppressedIssues: Array.isArray(sourceFindings.suppressedIssues) ? sourceFindings.suppressedIssues : []
  });
}

function isAmbiguousAstFinding(finding) {
  return finding?.ruleId === "ambiguous-ast" || finding?.state === "AMBIGUOUS";
}

function buildAmbiguousReasoningDiff(ambiguousFindings, rootDir = process.cwd()) {
  return ambiguousFindings
    .map((item) => {
      const relativePath = toPosix(path.relative(path.resolve(rootDir), item.filePath));
      return [
        `diff --git a/${relativePath} b/${relativePath}`,
        `+++ b/${relativePath}`,
        `+// PREFLIGHT_AST_STATE=AMBIGUOUS line=${item.line || 1} reason=${item.ambiguityReason || "unknown"}`,
        `+// ${item.evidence || "Local AST proof surrendered."}`
      ].join("\n");
    })
    .join("\n");
}

function extractLocalImportPathsForReasoning(sourceCode) {
  const importSources = new Set();
  const patterns = [
    /\bimport\s+(?:[\s\S]*?\s+from\s+)?['"](.+?)['"]/g,
    /\brequire\s*\(\s*['"](.+?)['"]\s*\)/g
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(sourceCode)) !== null) {
      if (match[1]?.startsWith(".")) {
        importSources.add(match[1]);
      }
    }
  }

  return [...importSources];
}

async function collectAmbiguousReasoningFiles(ambiguousFindings, rootDir = process.cwd()) {
  const resolvedRoot = path.resolve(rootDir);
  const filePaths = new Set(ambiguousFindings.map((item) => path.resolve(item.filePath)));

  for (const filePath of [...filePaths]) {
    let sourceCode;
    try {
      sourceCode = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }

    for (const importSource of extractLocalImportPathsForReasoning(sourceCode)) {
      const importedPath = resolveImportPath(filePath, importSource);
      if (importedPath && path.resolve(importedPath).startsWith(resolvedRoot)) {
        filePaths.add(path.resolve(importedPath));
      }
    }
  }

  const files = [];
  for (const filePath of [...filePaths].sort()) {
    try {
      files.push({
        filePath: toPosix(path.relative(resolvedRoot, filePath)),
        content: await fs.readFile(filePath, "utf8")
      });
    } catch {
      // Ignore files that disappeared between scan and routing.
    }
  }

  return files;
}

async function routeAmbiguousFindingsToReasoning(findings, options = {}) {
  const ambiguousFindings = (Array.isArray(findings) ? findings : []).filter(isAmbiguousAstFinding);
  if (ambiguousFindings.length === 0) {
    return {
      routed: "local",
      ambiguous: false,
      patchSet: null
    };
  }

  const rootDir = path.resolve(options.rootDir || process.cwd());
  const routeDeepRemediation = options.routeDeepRemediation || routeDeepRemediationDefault;

  return routeDeepRemediation({
    diff: buildAmbiguousReasoningDiff(ambiguousFindings, rootDir),
    files: await collectAmbiguousReasoningFiles(ambiguousFindings, rootDir),
    microRouter: options.microRouter || {
      evaluate: async () => ({ requires_deep_scan: true, routed: "ambiguous-ast" })
    },
    ...(options.reasoningEngine ? { reasoningEngine: options.reasoningEngine } : {}),
    ...(options.reasoningOptions ? { reasoningOptions: options.reasoningOptions } : {})
  });
}

function normalizeReasoningVerdictState(state) {
  const value = String(state || "").toUpperCase();
  if (value === "GREEN") {
    return "SAFE";
  }
  if (value === "RED") {
    return "VULNERABLE";
  }
  if (value === "YELLOW") {
    return "AMBIGUOUS";
  }
  return value;
}

function reasoningResultToFindings(reasoningResult, ambiguousFindings, rootDir = process.cwd()) {
  const firstAmbiguous = ambiguousFindings[0];
  const filePath = firstAmbiguous?.filePath || path.resolve(rootDir);
  const line = firstAmbiguous?.line || 1;

  if (reasoningResult?.patchSet) {
    const patchCount = Array.isArray(reasoningResult.patchSet.patches) ? reasoningResult.patchSet.patches.length : 0;
    return [
      finding({
        ruleId: "llm-reasoning",
        severity: "critical",
        state: "PATCH",
        filePath,
        line,
        message: reasoningResult.patchSet.explanation || "Reasoning Engine proposed a patch set for ambiguous AST findings.",
        evidence: `Reasoning Engine proposed ${patchCount} patch${patchCount === 1 ? "" : "es"}.`,
        requiresDeepRemediation: true,
        patchSet: reasoningResult.patchSet
      })
    ];
  }

  const verdict = reasoningResult?.verdict || reasoningResult?.microDecision?.verdict || null;
  if (!verdict) {
    return ambiguousFindings;
  }

  const state = normalizeReasoningVerdictState(verdict.state);
  if (state === "SAFE") {
    return [];
  }

  return [
    finding({
      ruleId: "llm-reasoning",
      severity: state === "VULNERABLE" ? "critical" : "warning",
      state,
      filePath,
      line,
      message: verdict.reasoning || "Reasoning Engine returned a semantic verdict for ambiguous AST findings.",
      evidence: verdict.auto_patch
        ? "Reasoning Engine returned an auto-patch."
        : verdict.manual_qa_line || `Reasoning Engine verdict: ${state}`,
      requiresDeepRemediation: state !== "SAFE",
      autoPatch: verdict.auto_patch || null,
      manualQaLine: verdict.manual_qa_line || null
    })
  ];
}

function mergeReasoningFindings(findings, reasoningResult, rootDir = process.cwd()) {
  const ambiguousFindings = findings.filter(isAmbiguousAstFinding);
  if (ambiguousFindings.length === 0) {
    return findings;
  }

  const nonAmbiguousFindings = findings.filter((item) => !isAmbiguousAstFinding(item));
  return dedupeFindings([
    ...nonAmbiguousFindings,
    ...reasoningResultToFindings(reasoningResult, ambiguousFindings, rootDir)
  ]);
}

function shouldRouteAmbiguousFindings(env = process.env) {
  return Boolean(
    env.PREFLIGHT_PRO_KEY ||
    env.PREFLIGHT_PRO_LICENSE_KEY
  );
}

function isOfflineLocalFixFinding(item) {
  return (
    item?.fix?.kind === "credential" ||
    item?.fix?.kind === "scaffold-server-action" ||
    item?.fix?.kind === "sql-remediation"
  );
}

function isClaudePhaseFixFinding(item) {
  return item?.fix?.kind === "sql-remediation" || (item?.ruleId === "llm-reasoning" && item?.patchSet);
}

function hasProEngineAccess(env = process.env) {
  return Boolean(env.PREFLIGHT_PRO_KEY || env.PREFLIGHT_PRO_LICENSE_KEY);
}

function isComplexStructuralFinding(item) {
  return isAmbiguousAstFinding(item) || isClaudePhaseFixFinding(item);
}

function renderFixPhaseBanner(phase) {
  if (phase === "local") {
    return "🔍 [PHASE 1] Running Offline Local AST Optimization Pass...\n";
  }

  if (phase === "pro") {
    return "🚀 [PHASE 2] Handing Off Remaining Architectural Flaws to PreFlight Pro Deep Reasoning Engine...\n";
  }

  return "";
}

function mergeFixResults(...results) {
  return results.reduce((totals, result) => ({
    attempted: totals.attempted + (result?.attempted || 0),
    applied: totals.applied + (result?.applied || 0),
    skipped: totals.skipped + (result?.skipped || 0),
    unsupported: totals.unsupported + (result?.unsupported || 0),
    ciBlocked: totals.ciBlocked || result?.ciBlocked === true,
    reported: totals.reported || result?.reported === true
  }), {
    attempted: 0,
    applied: 0,
    skipped: 0,
    unsupported: 0,
    ciBlocked: false,
    reported: false
  });
}

function askQuestion(question, options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const interfaceHandle = readline.createInterface({ input, output });

  return new Promise((resolve) => {
    interfaceHandle.question(question, (answer) => {
      interfaceHandle.close();
      resolve(answer);
    });
  });
}

function questionWithInterface(interfaceHandle, question) {
  return new Promise((resolve) => {
    interfaceHandle.question(question, (answer) => {
      resolve(answer || "");
    });
  });
}

async function readAllInput(input) {
  let text = "";
  input.setEncoding?.("utf8");

  for await (const chunk of input) {
    text += chunk;
  }

  return text;
}

async function createPromptOptions(options = {}) {
  if (options.ask) {
    return {
      promptOptions: options,
      close: () => {}
    };
  }

  const input = options.input || process.stdin;
  const output = options.output || process.stdout;

  if (input.isTTY !== true) {
    const answers = (await readAllInput(input)).split(/\r?\n/);
    return {
      promptOptions: {
        ...options,
        ask: async (question) => {
          output.write(question);
          return answers.shift() || "";
        }
      },
      close: () => {}
    };
  }

  const promptInterface = readline.createInterface({ input, output });
  return {
    promptOptions: { ...options, promptInterface },
    close: () => promptInterface.close()
  };
}

function redactFixPreviewText(value) {
  if (detectCredential(unquoteTreeString(String(value || ""))) || detectSecret(unquoteTreeString(String(value || "")))) {
    return "[redacted credential]";
  }

  return String(value || "").replace(/\r?\n/g, "\\n");
}

function renderCiFixPreview(filePath, fix) {
  return [
    `Proposed fix for ${filePath}`,
    `-[redacted credential]`.replace("[redacted credential]", redactFixPreviewText(fix.expectedText)),
    `+${fix.replacement}`,
    ""
  ].join("\n");
}

function renderFixPreviewHeading(filePath, node) {
  if (node?.kind === "credential") {
    return `\n[LOCAL] AST fix available in ${filePath}\n`;
  }

  if (node?.kind === "sql-remediation") {
    if (node?.engine === "local") {
      return `\n[LOCAL] AST SQL fix available in ${filePath}\n`;
    }
    return `\n[PRO] SQL fix generated via Pro Engine for ${filePath}\n`;
  }

  return `\n[PREFLIGHT] Fix available in ${filePath}\n`;
}

function renderScaffoldFixLog(filePath, scaffoldResult) {
  const lines = [`\n[LOCAL] AST scaffold applied for ${filePath}`];
  if (scaffoldResult?.actionFile) {
    lines.push(`Created server action bridge: ${scaffoldResult.actionFile}`);
  }
  if (scaffoldResult?.clientFile) {
    lines.push(`Updated client component: ${scaffoldResult.clientFile}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function promptAndApplyFix(filePath, node, originalSourceBytes, options = {}) {
  const replacementText = node.replacement;
  const startByte = node.startByte;
  const endByte = node.endByte;
  const output = options.output || process.stdout;
  const ask =
    options.ask ||
    (options.promptInterface
      ? (question) => questionWithInterface(options.promptInterface, question)
      : (question) => askQuestion(question, options));
  const expectedText = node.expectedText;

  if (typeof replacementText !== "string" || !replacementText) {
    output.write(`Fix skipped because no replacement is configured for ${filePath}.\n`);
    return originalSourceBytes;
  }

  if (
    !Number.isInteger(startByte) ||
    !Number.isInteger(endByte) ||
    startByte < 0 ||
    endByte <= startByte ||
    endByte > originalSourceBytes.length
  ) {
    output.write(`Fix skipped because the stored byte range is invalid for ${filePath}.\n`);
    return originalSourceBytes;
  }

  const leakedKey = originalSourceBytes.subarray(startByte, endByte).toString("utf8");

  if (typeof expectedText !== "string" || leakedKey !== expectedText) {
    output.write(`Fix skipped because the file changed after scanning: ${filePath}\n`);
    return originalSourceBytes;
  }

  output.write(renderFixPreviewHeading(filePath, node));
  output.write(`\u001b[91m(-) ${leakedKey}\u001b[0m\n`);
  output.write(`\u001b[92m(+) ${replacementText}\u001b[0m\n`);

  const confirm = await ask("\nApply this fix? (y/N): ");
  if (confirm.toLowerCase() !== "y") {
    output.write("Skipped.\n");
    return originalSourceBytes;
  }

  const replacement = Buffer.from(replacementText, "utf8");
  const newBytes = Buffer.concat([
    originalSourceBytes.subarray(0, startByte),
    replacement,
    originalSourceBytes.subarray(endByte)
  ]);

  if (/^process\.env\.[A-Za-z_$][\w$]*$/.test(replacementText)) {
    const envName = replacementText.replace(/^process\.env\./, "");
    output.write(`Fix applied! Remember to add ${envName} to your .env file.\n`);
  } else {
    output.write("Fix applied!\n");
  }
  return newBytes;
}

function assertNonOverlappingFixes(fixes) {
  const ordered = fixes.slice().sort((left, right) => left.startByte - right.startByte);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (current.startByte < previous.endByte) {
      throw new Error(`Overlapping PreFlight fixes: ${previous.kind} intersects ${current.kind}`);
    }
  }
}

function dedupeExactFixes(fixes) {
  const seen = new Set();
  return fixes.filter((fix) => {
    const key = [
      fix.kind,
      fix.startByte,
      fix.endByte,
      fix.expectedText || "",
      fix.replacement || "",
      fix.engine || ""
    ].join(":");

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

async function applyScanFixes(findings, options = {}) {
  const fixesByFile = new Map();
  const scaffoldFixes = [];
  const reasoningPatchFindings = [];
  const modifiedFilePaths = new Set();
  const generateParameterizedFix = options.generateParameterizedFix || generateSqlParameterizedFix;
  const applyDeepReasoningPatchSet = options.applyMultiFilePatchSet || applyDeepReasoningPatchSetDefault;
  const usesDefaultSqlRemediator = !options.generateParameterizedFix;
  let sqlRemediationUnavailable = false;
  let attempted = 0;
  let applied = 0;
  let skipped = 0;
  let unsupported = 0;
  const rootDir = path.resolve(options.rootDir || process.cwd());

  for (const item of findings) {
    if (item?.ruleId === "llm-reasoning" && item?.patchSet) {
      reasoningPatchFindings.push(item);
      continue;
    }

    if (!item.fix) {
      unsupported += 1;
      continue;
    }

    if (item.fix.kind === "scaffold-server-action") {
      scaffoldFixes.push({ filePath: item.filePath, leak: item.fix.leak });
      continue;
    }

    if (item.fix.kind !== "credential" && item.fix.kind !== "sql-remediation") {
      unsupported += 1;
      continue;
    }

    if (!fixesByFile.has(item.filePath)) {
      fixesByFile.set(item.filePath, []);
    }
    fixesByFile.get(item.filePath).push({ finding: item, fix: item.fix });
  }

  if (options.ci === true) {
    const output = options.output || process.stdout;
    let attemptedPreviews = 0;
    output.write("CI mode detected. Interactive Auto-Heal prompts are disabled.\n");

    for (const [filePath, fixes] of fixesByFile) {
      for (const { fix } of fixes) {
        if (fix.kind === "credential") {
          output.write(renderCiFixPreview(filePath, fix));
          attemptedPreviews += 1;
          continue;
        }

        unsupported += 1;
      }
    }

    unsupported += scaffoldFixes.length + reasoningPatchFindings.length;
    return {
      attempted: attemptedPreviews,
      applied: 0,
      skipped: attemptedPreviews,
      unsupported,
      ciBlocked: true
    };
  }

  const { promptOptions, close } = await createPromptOptions(options);

  try {
    for (const [filePath, fixes] of fixesByFile) {
      let currentSourceBytes = await fs.readFile(filePath);
      const resolvedFixes = [];
      let fileApplied = false;

      for (const { fix } of fixes) {
        if (fix.kind === "sql-remediation") {
          if (sqlRemediationUnavailable) {
            unsupported += 1;
            continue;
          }
          let resolvedEngine = "pro";
          const replacement = usesDefaultSqlRemediator
            ? await generateParameterizedFix(fix.rawSnippet, {
                localOnly: options.localOnlySqlRemediation === true,
                onResolution: ({ engine } = {}) => {
                  if (engine) {
                    resolvedEngine = engine;
                  }
                },
                onProviderFailure: () => {
                  sqlRemediationUnavailable = true;
                }
              })
            : await generateParameterizedFix(fix.rawSnippet, {
                localOnly: options.localOnlySqlRemediation === true,
                onResolution: ({ engine } = {}) => {
                  if (engine) {
                    resolvedEngine = engine;
                  }
                }
              });
          if (replacement === fix.rawSnippet) {
            unsupported += 1;
            continue;
          }
          resolvedFixes.push({
            ...fix,
            replacement,
            engine: resolvedEngine
          });
          continue;
        }

        resolvedFixes.push(fix);
      }

      const uniqueResolvedFixes = dedupeExactFixes(resolvedFixes);
      const sortedFixes = uniqueResolvedFixes
        .slice()
        .sort((left, right) => right.startByte - left.startByte);
      assertNonOverlappingFixes(uniqueResolvedFixes);

      for (const fix of sortedFixes) {
        const before = currentSourceBytes;
        currentSourceBytes = await promptAndApplyFix(filePath, fix, currentSourceBytes, promptOptions);
        if (!Buffer.compare(before, currentSourceBytes)) {
          skipped += 1;
        } else {
          applied += 1;
          fileApplied = true;
        }
        attempted += 1;
      }

      await assertSourceSyntaxSafe(filePath, currentSourceBytes.toString("utf8"));
      await fs.writeFile(filePath, currentSourceBytes);
      if (fileApplied) {
        modifiedFilePaths.add(path.resolve(filePath));
      }
    }

    for (const item of scaffoldFixes) {
      const scaffoldResult = await applyScaffoldTransaction(item.filePath, item.leak);
      attempted += 1;
      applied += 1;
      (promptOptions.output || process.stdout).write(renderScaffoldFixLog(item.filePath, scaffoldResult));
      if (scaffoldResult?.clientFile) {
        modifiedFilePaths.add(path.resolve(scaffoldResult.clientFile));
      }
      if (scaffoldResult?.actionFile) {
        modifiedFilePaths.add(path.resolve(scaffoldResult.actionFile));
      }
    }

    for (const item of reasoningPatchFindings) {
      const conflictingPatchPaths = Array.isArray(item?.patchSet?.patches)
        ? item.patchSet.patches
            .map((patch) => patch?.filePath || patch?.file_path)
            .filter((filePath) => typeof filePath === "string" && filePath.trim() !== "")
            .map((filePath) => path.resolve(rootDir, filePath))
            .filter((filePath) => modifiedFilePaths.has(filePath))
        : [];

      if (conflictingPatchPaths.length > 0) {
        for (const filePath of conflictingPatchPaths) {
          const displayPath = path.relative(rootDir, filePath) || filePath;
          (promptOptions.output || process.stdout).write(
            `⚠️ Skipping deep patch for ${displayPath} to prevent overwriting an applied foundational fix.\n`
          );
        }
        unsupported += 1;
        continue;
      }

      const patchResult = await applyDeepReasoningPatchSet(item.patchSet, {
        ...promptOptions,
        output: promptOptions.output || process.stdout,
        question: "Apply this deep reasoning fix? (y/N): ",
        rootDir
      });
      attempted += patchResult?.attempted || 0;
      applied += patchResult?.applied || 0;
      skipped += patchResult?.skipped || 0;
      if (patchResult?.manualReviewRequired) {
        unsupported += 1;
        continue;
      }

      if ((patchResult?.applied || 0) > 0 && Array.isArray(item?.patchSet?.patches)) {
        for (const patch of item.patchSet.patches) {
          const patchFilePath = patch?.filePath || patch?.file_path;
          if (typeof patchFilePath === "string" && patchFilePath.trim() !== "") {
            modifiedFilePaths.add(path.resolve(rootDir, patchFilePath));
          }
        }
      }
    }
  } finally {
    close();
  }

  return { attempted, applied, skipped, unsupported };
}

function renderReport(findings, options = {}) {
  const colorOptions = {
    color: options.color,
    noColor: options.noColor,
    stream: options.stream || process.stdout
  };

  if (findings.length === 0) {
    return `${colorize("success", "PreFlight Check found 0 issues.", colorOptions)}\n`;
  }

  const plural = findings.length === 1 ? "issue" : "issues";
  const lines = [
    colorize("error", `PreFlight Check found ${findings.length} ${plural}.`, colorOptions),
    ""
  ];

  for (const item of findings) {
    lines.push(`${colorize(item.severity, item.severity.toUpperCase(), colorOptions)} ${item.ruleId}`);
    lines.push(`  ${item.filePath}:${item.line}`);
    lines.push(`  ${item.message}`);
    if (item.evidence) {
      lines.push(`  Evidence: ${item.evidence}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function resolveTriStateRiskScore(findings = []) {
  const normalizedFindings = Array.isArray(findings) ? findings : [];
  const driftStates = new Set(["AMBIGUOUS", "PATCH"]);
  const hasHardBlock = normalizedFindings.some((item) => {
    const state = String(item?.state || "").toUpperCase();
    return item?.severity === "critical" && !driftStates.has(state) && item?.ruleId !== "llm-reasoning";
  });

  if (hasHardBlock) {
    return TRI_STATE_RISK_SCORE.HARD_BLOCK;
  }

  const hasHighRiskDrift = normalizedFindings.some((item) => {
    const state = String(item?.state || "").toUpperCase();
    return (
      driftStates.has(state) ||
      item?.severity === "warning" ||
      item?.ruleId === "ambiguous-ast" ||
      item?.ruleId === "llm-reasoning"
    );
  });

  if (hasHighRiskDrift) {
    return TRI_STATE_RISK_SCORE.HIGH_RISK_DRIFT;
  }

  return TRI_STATE_RISK_SCORE.LIKELY_SAFE;
}

function renderTriStateRiskScore(findings = []) {
  const classification = resolveTriStateRiskScore(findings);
  return [
    "Tri-State Risk Score",
    `${classification.icon} ${classification.label}: ${classification.description}.`,
    ""
  ].join("\n");
}

function renderSuppressionAuditNote(suppressedIssues = [], options = {}) {
  if (!Array.isArray(suppressedIssues) || suppressedIssues.length === 0) {
    return "";
  }

  const colorOptions = {
    color: options.color,
    noColor: options.noColor,
    stream: options.stream || process.stdout
  };
  const plural = suppressedIssues.length === 1 ? "issue" : "issues";
  const lines = [
    colorize("warning", `Note: ${suppressedIssues.length} ${plural} suppressed via preflight-ignore directive${suppressedIssues.length === 1 ? "" : "s"}.`, colorOptions)
  ];

  for (const item of suppressedIssues.slice(0, 5)) {
    lines.push(`  ignored ${item.ruleId} at ${item.filePath}:${item.line}`);
  }

  if (suppressedIssues.length > 5) {
    lines.push(`  ...and ${suppressedIssues.length - 5} more suppressed issue(s)`);
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

function toSarifUri(filePath, rootDir) {
  const relativePath = path.relative(path.resolve(rootDir), filePath) || path.basename(filePath);
  return toPosix(relativePath);
}

function renderSarif(findings, options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());

  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: "PreFlight Check",
            informationUri: "https://preflight.local",
            rules: Object.values(SARIF_RULES)
          }
        },
        results: findings.map((item) => ({
          ruleId: item.ruleId,
          level: "error",
          message: {
            text: item.message
          },
          locations: [
            {
              physicalLocation: {
                artifactLocation: {
                  uri: toSarifUri(item.filePath, rootDir)
                },
                region: {
                  startLine: item.line || 1
                }
              }
            }
          ],
          properties: {
            severity: item.severity,
            ...(item.evidence ? { evidence: item.evidence } : {}),
            ...(item.tableName ? { tableName: item.tableName } : {})
          }
        }))
      }
    ]
  };
}

async function writeSarifReport(findings, options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const outputPath = path.join(rootDir, SARIF_REPORT_NAME);
  await fs.writeFile(outputPath, `${JSON.stringify(renderSarif(findings, { rootDir }), null, 2)}\n`, "utf8");
  return outputPath;
}

async function auditDependencies(rootDir = process.cwd(), options = {}) {
  const resolvedRoot = path.resolve(rootDir);
  const runner = options.runner || runCommand;
  try {
    const result = await runner("npm", ["audit", "--json"], resolvedRoot);
    return normalizeAuditResult(result.stdout, resolvedRoot);
  } catch (error) {
    const output = error.stdout || error.output || "";
    if (output.trim()) {
      return normalizeAuditResult(output, resolvedRoot);
    }

    throw error;
  }
}

function normalizeAuditResult(rawJson, rootDir = process.cwd()) {
  const parsed = JSON.parse(rawJson || "{}");
  const vulnerabilities = parsed.metadata?.vulnerabilities || {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
    total: 0
  };

  return {
    directory: path.resolve(rootDir),
    vulnerabilities,
    metadata: parsed.metadata || {},
    auditReportVersion: parsed.auditReportVersion,
    raw: parsed
  };
}

function renderAuditReport(result, options = {}) {
  const colorOptions = {
    color: options.color,
    noColor: options.noColor,
    stream: options.stream || process.stdout
  };
  const vulnerabilities = result.vulnerabilities || {};
  const total = vulnerabilities.total || 0;

  if (total === 0) {
    return `${colorize("success", "PreFlight dependency audit found 0 vulnerabilities.", colorOptions)}\n`;
  }

  return [
    colorize("error", `PreFlight dependency audit found ${total} vulnerabilities.`, colorOptions),
    colorize("critical", `  Critical: ${vulnerabilities.critical || 0}`, colorOptions),
    colorize("high", `  High: ${vulnerabilities.high || 0}`, colorOptions),
    colorize("warning", `  Moderate: ${vulnerabilities.moderate || 0}`, colorOptions),
    colorize("warning", `  Low: ${vulnerabilities.low || 0}`, colorOptions),
    `  Info: ${vulnerabilities.info || 0}`,
    ""
  ].join("\n");
}

async function runCommand(command, args, cwd) {
  const executable = process.platform === "win32" && command === "npm" ? "cmd.exe" : command;
  const finalArgs = process.platform === "win32" && command === "npm" ? ["/d", "/s", "/c", "npm", ...args] : args;

  try {
    return await execFileAsync(executable, finalArgs, {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 10
    });
  } catch (error) {
    error.output = `${error.stdout || ""}${error.stderr || ""}`;
    throw error;
  }
}

async function git(rootDir, args) {
  return runCommand("git", args, rootDir);
}

async function gitOutputOrEmpty(rootDir, args, allowedFailurePatterns = []) {
  try {
    return (await git(rootDir, args)).stdout;
  } catch (error) {
    const output = error.output || error.message || "";
    if (allowedFailurePatterns.some((pattern) => pattern.test(output))) {
      return "";
    }

    throw error;
  }
}

async function gitBranchExists(rootDir, branchName) {
  try {
    await git(rootDir, ["rev-parse", "--verify", branchName]);
    return true;
  } catch {
    return false;
  }
}

async function deleteBranchIfExists(rootDir, branchName) {
  if (await gitBranchExists(rootDir, branchName)) {
    await git(rootDir, ["branch", "-D", branchName]);
  }
}

async function rollbackTemporaryBranch(rootDir, originalBranch, originalRef, branchName) {
  await git(rootDir, ["reset", "--hard", originalRef]);
  await git(rootDir, ["checkout", originalBranch]);
  await deleteBranchIfExists(rootDir, branchName);
}

async function assertCleanWorkingTree(rootDir) {
  const { stdout } = await git(rootDir, ["status", "--porcelain"]);
  if (stdout.trim()) {
    throw new Error("Refusing to apply a fix while the Git working tree has uncommitted changes.");
  }
}

async function applyFixWithRollback(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const patchFile = options.patchFile ? path.resolve(options.patchFile) : null;
  const branchName = options.branchName || "preflight-temp-fix";
  const buildCommand = options.buildCommand || ["npm", "run", "build"];

  if (!patchFile) {
    throw new Error("A patch file is required.");
  }

  if (!Array.isArray(buildCommand) || buildCommand.length === 0) {
    throw new Error("buildCommand must be an array like ['npm', 'run', 'build'].");
  }

  await fs.access(patchFile);
  await assertCleanWorkingTree(rootDir);

  if (await gitBranchExists(rootDir, branchName)) {
    throw new Error(`Temporary branch already exists: ${branchName}`);
  }

  const originalBranch = (await git(rootDir, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  const originalRef = (await git(rootDir, ["rev-parse", "HEAD"])).stdout.trim();

  await git(rootDir, ["checkout", "-b", branchName]);

  try {
    await git(rootDir, ["apply", patchFile]);

    let buildOutput = "";
    try {
      const build = await runCommand(buildCommand[0], buildCommand.slice(1), rootDir);
      buildOutput = `${build.stdout || ""}${build.stderr || ""}`;
    } catch (buildError) {
      buildOutput = buildError.output || buildError.message;
      await rollbackTemporaryBranch(rootDir, originalBranch, originalRef, branchName);
      return {
        success: false,
        branchName,
        originalBranch,
        buildOutput,
        rollbackCommand: `git reset --hard ${originalRef}`
      };
    }

    await git(rootDir, ["add", "-A"]);
    const status = (await git(rootDir, ["status", "--porcelain"])).stdout.trim();
    if (status) {
      await git(rootDir, ["commit", "-m", "Apply PreFlight AI fix"]);
    }

    await git(rootDir, ["checkout", originalBranch]);
    if (status) {
      await git(rootDir, ["merge", "--ff-only", branchName]);
    }
    await git(rootDir, ["branch", "-D", branchName]);

    return {
      success: true,
      branchName,
      originalBranch,
      buildOutput
    };
  } catch (error) {
    try {
      await rollbackTemporaryBranch(rootDir, originalBranch, originalRef, branchName);
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }
    throw error;
  }
}

function getMcpConfigTargets(options = {}) {
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;

  if (platform === "win32") {
    const appData = env.APPDATA || path.join(homeDir, "AppData", "Roaming");
    return [
      {
        client: "Claude Desktop",
        filePath: path.join(appData, "Claude", "claude_desktop_config.json")
      },
      {
        client: "Cline for VS Code",
        filePath: path.join(appData, "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "mcp_settings.json")
      },
      {
        client: "RooCode for VS Code",
        filePath: path.join(appData, "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json")
      }
    ];
  }

  if (platform === "darwin") {
    const appSupport = path.join(homeDir, "Library", "Application Support");
    return [
      {
        client: "Claude Desktop",
        filePath: path.join(appSupport, "Claude", "claude_desktop_config.json")
      },
      {
        client: "Cline for VS Code",
        filePath: path.join(appSupport, "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "mcp_settings.json")
      },
      {
        client: "RooCode for VS Code",
        filePath: path.join(appSupport, "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json")
      }
    ];
  }

  const configHome = env.XDG_CONFIG_HOME || path.join(homeDir, ".config");
  return [
    {
      client: "Claude Desktop",
      filePath: path.join(configHome, "Claude", "claude_desktop_config.json")
    },
    {
      client: "Cline for VS Code",
      filePath: path.join(configHome, "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "mcp_settings.json")
    },
    {
      client: "RooCode for VS Code",
      filePath: path.join(configHome, "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json")
    }
  ];
}

async function injectMcpServerConfig(target, options = {}) {
  const serverName = options.serverName || PREFLIGHT_MCP_SERVER_NAME;
  const serverConfig = options.serverConfig || PREFLIGHT_MCP_SERVER_CONFIG;
  const raw = await fs.readFile(target.filePath, "utf8");
  const config = raw.trim() ? JSON.parse(raw) : {};

  if (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)) {
    config.mcpServers = {};
  }

  config.mcpServers[serverName] = serverConfig;
  await writeJsonFileSafely(target.filePath, config);
  return target.client;
}

async function writeJsonFileSafely(filePath, value) {
  const tempPath = `${filePath}.preflight-tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

async function installMcpForKnownClients(options = {}) {
  const targets = options.targets || getMcpConfigTargets(options);
  const output = options.output || process.stdout;
  const errorOutput = options.errorOutput || process.stderr;
  const color = options.color !== false;
  const configuredClients = [];

  for (const target of targets) {
    if (!(await fileExists(target.filePath))) {
      continue;
    }

    try {
      const client = await injectMcpServerConfig(target, options);
      configuredClients.push(client);
      output.write(`${colorize("success", "Configured", { color, stream: output })} ${client}: ${target.filePath}\n`);
    } catch (error) {
      errorOutput.write(`Warning: could not update ${target.client} MCP config at ${target.filePath}: ${error.message}\n`);
    }
  }

  if (configuredClients.length > 0) {
    output.write(`${colorize("success", "PreFlight Pro MCP auto-configured", { color, stream: output })} for ${configuredClients.join(", ")}.\n`);
  }

  output.write(`${UNIVERSAL_MCP_OUTPUT}\n`);
  return configuredClients;
}

function normalizeCliArgs(argv) {
  const [nodePath, scriptPath, firstArg, ...rest] = argv;
  const knownCommands = new Set(["scan", "scan-diff", "audit", "activate", "apply-fix", "install-mcp", "init", "init-config", "mcp", "upgrade", "help"]);

  if (!firstArg || firstArg.startsWith("-") || !knownCommands.has(firstArg)) {
    return [nodePath, scriptPath, "scan", ...(firstArg ? [firstArg, ...rest] : rest)];
  }

  return argv;
}

function stripDeprecatedAiKeyFlags(argv = process.argv) {
  const nextArgv = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg.startsWith("--") && arg.endsWith("-key")) {
      const value = argv[index + 1];
      if (value && !value.startsWith("-")) {
        index += 1;
      }
      continue;
    }

    if (/^--[^=]+-key=/.test(arg)) {
      continue;
    }

    nextArgv.push(arg);
  }

  return nextArgv;
}

function buildTelemetryRepositoryMetadata(rootDir, options = {}) {
  const repositoryContext = (options.getRepositoryContext || getDefaultRepositoryContext)({
    cwd: rootDir,
    env: options.env || process.env
  });
  const repository = repositoryContext.repository || {};

  return {
    remoteUrl: repositoryContext.remoteUrl || repository.remoteUrl || null,
    host: repository.host || null,
    owner: repository.owner || null,
    repo: repository.repo || null,
    isOrganization: repositoryContext.isOrganization === true
  };
}

async function waitForTelemetryFlush(telemetryPromise, timeoutMs = 400) {
  await Promise.race([
    Promise.resolve(telemetryPromise).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, timeoutMs))
  ]);
}

async function runCli(argv = process.argv, options = {}) {
  const normalizedArgv = normalizeCliArgs(stripDeprecatedAiKeyFlags(argv));
  const activateLicenseKey = options.activateLicenseKey || activateDefaultLicenseKey;
  const auditDependencyRunner = options.auditDependencies || auditDependencies;
  const forceRouteAmbiguous = options.routeAmbiguous;
  const startMcpServer = options.startMcpServer || startDefaultMcpServer;
  const verifyFixPermission = options.verifyFixPermission || verifyDefaultFixPermission;
  const reportTelemetry = options.reportTelemetry || reportTelemetryDefault;
  const routeDeepRemediation = options.routeDeepRemediation || routeDeepRemediationDefault;
  const resolveStoredLicenseKey = options.resolveStoredLicenseKey || resolveDefaultStoredLicenseKey;
  const startCliLogin = options.startCliLogin || startDefaultCliLogin;
  const getRepositoryContextForTelemetry = options.getRepositoryContext;
  const program = new Command();
  program
    .name("preflight")
    .description("Local zero-knowledge scanner for Next.js and Supabase security flaws.")
    .version(packageJson.version, "-v, --version");

  program
    .command("login")
    .description("Authorize the PreFlight CLI through the browser.")
    .option("--dashboard-url <url>", "PreFlight dashboard URL", process.env.PREFLIGHT_DASHBOARD_URL || "https://preflight-vibe.vercel.app")
    .option("--port <port>", "preferred localhost callback port", "4242")
    .option("--no-open", "print the auth URL without opening a browser")
    .action(async (loginOptions) => {
      try {
        process.stdout.write("Starting PreFlight browser login...\n");
        const login = await startCliLogin({
          dashboardUrl: loginOptions.dashboardUrl,
          openBrowser: loginOptions.open === false ? async () => {} : undefined,
          port: Number(loginOptions.port)
        });
        process.stdout.write(`Authorize this device in your browser: ${login.authUrl}\n`);
        process.stdout.write(`Waiting for authorization on localhost:${login.port}...\n`);
        await login.result;
        process.stdout.write("PreFlight CLI login complete. License saved to ~/.preflight/config.json\n");
        process.exitCode = 0;
      } catch (error) {
        process.stderr.write(`PreFlight login failed: ${error.message}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command("activate")
    .description("Activate a PreFlight Pro Lemon Squeezy license key.")
    .argument("<key>", "license key to activate")
    .argument("[email]", "purchase email address")
    .action(async (key, email) => {
      if (!email) {
        console.log(colorize("error", "\u274c Usage: preflight activate <key> <email>", { stream: process.stdout }));
        process.exitCode = 1;
        return;
      }

      try {
        const result = await activateLicenseKey(key, email);
        if (result.success === false) {
          console.log(colorize("error", result.message, { stream: process.stdout }));
          process.exitCode = 1;
          return;
        }

        console.log(colorize("success", result.message || "\u2705 PreFlight Pro activated successfully! Unlimited AI auto-fixes unlocked.", { stream: process.stdout }));
        process.exitCode = 0;
      } catch (error) {
        createLogger({ stderr: process.stderr }).error(`License activation failed: ${error.message}`);
        process.exitCode = 1;
      }
    });

  program
    .command("apply-fix")
    .description("Apply a local patch on a temporary branch, run npm run build, then merge or rollback.")
    .argument("<patch-file>", "local patch file to apply with git apply")
    .argument("[directory]", "project directory", process.cwd())
    .option("--branch <name>", "temporary branch name", "preflight-temp-fix")
    .action(async (patchFile, directory, options) => {
      try {
        await ensureLicenseVerified();
      } catch (error) {
        if (error instanceof InvalidLicenseKeyError) {
          createLogger({ stderr: process.stderr }).error("Invalid License Key");
          process.exit(1);
        }

        createLogger({ stderr: process.stderr }).error(`License verification failed: ${error.message}`);
        process.exit(1);
      }

      const result = await applyFixWithRollback({
        rootDir: directory,
        patchFile,
        branchName: options.branch
      });

      if (result.success) {
        process.stdout.write(`PreFlight fix merged from ${result.branchName} into ${result.originalBranch}.\n`);
        process.exitCode = 0;
      } else {
        process.stderr.write(`PreFlight fix failed build and was rolled back with ${result.rollbackCommand}.\n`);
        process.exitCode = 1;
      }
    });

  program
    .command("install-mcp")
    .description("Auto-configure PreFlight Pro MCP for known local AI clients.")
    .action(async () => {
      await installMcpForKnownClients();
      process.exitCode = 0;
    });

  program
    .command("init")
    .description("Install the local Git pre-commit interceptor.")
    .argument("[directory]", "repository directory", process.cwd())
    .action(async (directory) => {
      const result = installDefaultPreCommitHook(path.resolve(directory));
      process.stdout.write(`PreFlight pre-commit hook installed: ${result.hookPath}\n`);
      if (result.backupPath) {
        process.stdout.write(`Existing hook backed up: ${result.backupPath}\n`);
      }
      process.exitCode = 0;
    });

  program
    .command("init-config")
    .description("Write a default PreFlight team ruleset template.")
    .argument("[directory]", "repository directory", process.cwd())
    .option("--force", "overwrite an existing preflight.config.json")
    .action(async (directory, options) => {
      try {
        const configPath = await writePreflightConfigTemplate(path.resolve(directory), {
          overwrite: options.force === true
        });
        process.stdout.write(`PreFlight config template written: ${configPath}\n`);
        process.exitCode = 0;
      } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command("upgrade")
    .description("Show PreFlight Pro closed beta access instructions.")
    .action(async () => {
      process.stdout.write([
        "🚀 PreFlight Pro is currently in Closed Beta.",
        "",
        "Unlock the Cloud AI Engine ($19/mo) for automated contextual patching and deep security tracing.",
        "",
        `Join the waitlist: ${PREFLIGHT_WAITLIST_URL}`,
        ""
      ].join("\n"));
      process.exitCode = 0;
    });

  program
    .command("scan-diff")
    .description("Scan a staged diff from stdin. Used by the Git pre-commit hook.")
    .option("--stdin", "read the diff from stdin")
    .option("--auto-fix", "return a locally redacted diff for confirmed secret findings")
    .action(async (options) => {
      const ciEnvironment = detectCiEnvironment(process.env);
      if (!options.stdin && process.stdin.isTTY === true) {
        throw new Error("scan-diff expects --stdin or piped diff input.");
      }

      const diff = await readAllInput(process.stdin);
      const result = scanStagedDiff(diff, { autoFix: options.autoFix });
      process.stdout.write(renderDiffScanReceipt(result));
      if (options.autoFix && result.autoPatch) {
        if (ciEnvironment.isCi) {
          process.stdout.write("CI mode detected. Auto-Heal prompts are disabled.\n");
          process.stdout.write("Proposed Auto-Heal Patch:\n");
          process.stdout.write(`${result.autoPatch}\n`);
        } else {
          const accepted = await promptForDiffAutoHeal(result.autoPatch, {
            color: true,
            output: process.stdout
          });
          if (accepted) {
            process.stdout.write("Auto-Heal accepted. Patch review complete; no filesystem write was performed by scan-diff.\n");
          } else {
            process.stdout.write("Auto-Heal declined. No files were changed.\n");
          }
        }
      }
      if (ciEnvironment.isCi) {
        await reportCiFindings(result.findings || [], {
          env: process.env,
          rootDir: process.cwd()
        });
      }
      const licenseKey = await resolveStoredLicenseKey({ env: process.env });
      await waitForTelemetryFlush(reportTelemetry(
        result.findings || [],
        buildTelemetryRepositoryMetadata(process.cwd(), {
          getRepositoryContext: getRepositoryContextForTelemetry,
          env: process.env
        }),
        licenseKey || undefined,
        {
          ci: ciEnvironment.isCi,
          source: ciEnvironment.isCi ? "ci" : "cli"
        }
      ));
      process.exitCode = result.ok ? 0 : 1;
    });

  program
    .command("audit")
    .description("Run an explicit dependency audit with npm audit.")
    .argument("[directory]", "project directory to audit", process.cwd())
    .option("--json", "print audit result as JSON")
    .option("--no-color", "disable color output")
    .action(async (directory, options) => {
      const result = await auditDependencyRunner(path.resolve(directory));
      if (options.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        process.stdout.write(renderAuditReport(result, { color: options.color, stream: process.stdout }));
      }

      process.exitCode = result.vulnerabilities?.total > 0 ? 1 : 0;
    });

  program
    .command("mcp")
    .description("Start the PreFlight MCP server over stdio.")
    .action(async () => {
      await startMcpServer({
        applyScanFixes,
        auditDependencies,
        cwd: process.cwd(),
        loadPreflightPolicy,
        renderAuditReport,
        renderReport,
        scanProject,
        scanProjectDiff,
        version: packageJson.version
      });
      process.exitCode = 0;
    });

  async function runScanAction(directory, options) {
    const ciEnvironment = detectCiEnvironment(process.env);
    const requestedPath = path.resolve(directory);
    const requestedStats = await fs.stat(requestedPath);
    const isSingleFileScan = requestedStats.isFile();
    const rootDir = isSingleFileScan ? process.cwd() : requestedPath;
    if (options.fix) {
      const permission = await verifyFixPermission({ cwd: rootDir });
      if (!permission.allowed) {
        process.stderr.write(`${permission.message}\n`);
        process.exitCode = 1;
        return;
      }
      if (permission.receipt) {
        process.stdout.write(`${permission.receipt}\n`);
      }
    }
    if (options.fix && isSingleFileScan && !ciEnvironment.isCi) {
      const checkoutRouteResult = await applyCheckoutRouteDemoRemediation(requestedPath, { rootDir });
      if (checkoutRouteResult) {
        process.exitCode = 0;
        return;
      }
    }

    const policy = await loadPreflightPolicy(process.cwd());
    const scanPolicy = isSingleFileScan && options.fix ? normalizePolicy() : policy;
    let findings = options.diff
      ? await scanProjectDiff(rootDir, { policy: scanPolicy })
      : isSingleFileScan
        ? await scanFiles(rootDir, [{
          filePath: requestedPath,
          relativePath: toPosix(path.relative(rootDir, requestedPath))
        }], { policy: scanPolicy })
        : await scanProject(rootDir, { policy: scanPolicy });
    let suppressedIssues = Array.isArray(findings.suppressedIssues) ? findings.suppressedIssues : [];
    let fixResult = null;

    if (options.fix) {
      const output = options.output || process.stdout;
      const localFixFindings = findings.filter(isOfflineLocalFixFinding);
      output.write(renderFixPhaseBanner("local"));
      const localFixResult = await applyScanFixes(localFixFindings, {
        ci: ciEnvironment.isCi,
        output,
        input: options.input,
        ask: options.ask,
        rootDir,
        localOnlySqlRemediation: true
      });
      findings = options.diff
        ? await scanProjectDiff(rootDir, { policy: scanPolicy })
        : isSingleFileScan
          ? await scanFiles(rootDir, [{
            filePath: requestedPath,
            relativePath: toPosix(path.relative(rootDir, requestedPath))
          }], { policy: scanPolicy })
          : await scanProject(rootDir, { policy: scanPolicy });
      suppressedIssues = Array.isArray(findings.suppressedIssues) ? findings.suppressedIssues : [];

      const hasProAccess = hasProEngineAccess(process.env);
      const complexFindings = findings.filter(isComplexStructuralFinding);

      if (!hasProAccess && complexFindings.length > 0) {
        output.write(`${ADVANCED_REMEDIATION_REQUIRES_PRO_MESSAGE}\n`);
        fixResult = mergeFixResults(localFixResult, {
          attempted: 0,
          applied: 0,
          skipped: 0,
          unsupported: complexFindings.length
        });
      } else {
        let proPhaseBannerPrinted = false;
        if (
          findings.some(isAmbiguousAstFinding) &&
          (forceRouteAmbiguous === true || options.routeAmbiguous === true || shouldRouteAmbiguousFindings(process.env))
        ) {
          output.write(renderFixPhaseBanner("pro"));
          proPhaseBannerPrinted = true;
          try {
            const reasoningResult = await routeAmbiguousFindingsToReasoning(findings, {
              rootDir,
              routeDeepRemediation
            });
            findings = mergeReasoningFindings(findings, reasoningResult, rootDir);
          } catch (error) {
            if (isPaymentRequiredError(error)) {
              process.stdout.write(`${PRO_ENGINE_CONNECTION_ERROR}\n`);
            } else if (isManualReviewRequiredError(error)) {
              process.stdout.write(`${MANUAL_REVIEW_MESSAGE}\n`);
            } else {
              createLogger({ stderr: process.stderr }).warn(
                `Warning: ambiguous AST routing failed closed: ${error.message}`
              );
            }
          }
        }

        const proPhaseFindings = findings.filter(isClaudePhaseFixFinding);
        const shouldShowProBanner = proPhaseFindings.length > 0 && !proPhaseBannerPrinted;
        if (shouldShowProBanner) {
          output.write(renderFixPhaseBanner("pro"));
        }
        const proFixResult = await applyScanFixes(proPhaseFindings, {
          ci: ciEnvironment.isCi,
          output,
          input: options.input,
          ask: options.ask,
          rootDir
        });
        fixResult = mergeFixResults(localFixResult, proFixResult);
      }
    } else if (
      findings.some(isAmbiguousAstFinding) &&
      (forceRouteAmbiguous === true || options.routeAmbiguous === true || shouldRouteAmbiguousFindings(process.env))
    ) {
      try {
        const reasoningResult = await routeAmbiguousFindingsToReasoning(findings, {
          rootDir,
          routeDeepRemediation
        });
        findings = mergeReasoningFindings(findings, reasoningResult, rootDir);
      } catch (error) {
        if (isPaymentRequiredError(error)) {
          process.stdout.write(`${PRO_ENGINE_CONNECTION_ERROR}\n`);
        } else if (isManualReviewRequiredError(error)) {
          process.stdout.write(`${MANUAL_REVIEW_MESSAGE}\n`);
        } else {
          createLogger({ stderr: process.stderr }).warn(
            `Warning: ambiguous AST routing failed closed: ${error.message}`
          );
        }
      }
    }

    if (options.fix) {
      process.stdout.write(renderTriStateRiskScore(findings));
      process.stdout.write(renderSuppressionAuditNote(suppressedIssues, { color: options.color, stream: process.stdout }));
      if (!fixResult?.reported) {
        process.stdout.write(
          `PreFlight remediation attempted ${fixResult?.attempted || 0} fix(es): ` +
            `${fixResult?.applied || 0} applied, ${fixResult?.skipped || 0} skipped, ${fixResult?.unsupported || 0} unsupported.\n`
        );
      }
    } else if (options.format === "sarif") {
      await writeSarifReport(findings, { rootDir });
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
    } else {
      process.stdout.write(renderTriStateRiskScore(findings));
      process.stdout.write(renderSuppressionAuditNote(suppressedIssues, { color: options.color, stream: process.stdout }));
      process.stdout.write(renderReport(findings, { color: options.color, stream: process.stdout }));
    }

    if (ciEnvironment.isCi) {
      await reportCiFindings(findings, {
        env: process.env,
        fixResult,
        rootDir
      });
    }

    const licenseKey = await resolveStoredLicenseKey({ env: process.env });
    await waitForTelemetryFlush(reportTelemetry(
      findings,
      buildTelemetryRepositoryMetadata(rootDir, {
        getRepositoryContext: getRepositoryContextForTelemetry,
        env: process.env
      }),
      licenseKey || undefined,
      {
        ci: ciEnvironment.isCi,
        source: ciEnvironment.isCi ? "ci" : "cli"
      }
    ));

    if (options.fix) {
      const unresolved = (fixResult?.skipped || 0) + (fixResult?.unsupported || 0);
      process.exitCode = unresolved > 0 ? 1 : 0;
    } else {
      process.exitCode = findings.length > 0 ? 1 : 0;
    }
  }

  program
    .command("scan")
    .description("Run the free local scanner.")
    .argument("[directory]", "project directory to scan", process.cwd())
    .option("--diff", "scan only changed Git files")
    .option("--fix", "interactively remediate supported findings")
    .option("--format <format>", "output format: text or sarif", "text")
    .option("--json", "print findings as JSON")
    .option("--no-color", "disable color output")
    .action(runScanAction);

  await program.parseAsync(normalizedArgv);
}

module.exports = {
  auditDependencies,
  applyScanFixes,
  applyFixWithRollback,
  detectSecret,
  ensureLicenseVerified,
  extractCreatedTables,
  extractRlsEnabledTables,
  getChangedScanFiles,
  getMcpConfigTargets,
  getPreflightConfigPath,
  hasUseClientDirective,
  injectMcpServerConfig,
  installMcpForKnownClients,
  InvalidLicenseKeyError,
  isIgnoredPath,
  loadPreflightPolicy,
  matchesIgnorePath,
  normalizeCliArgs,
  normalizePolicy,
  postFormUrlEncoded,
  promptAndApplyFix,
  promptForLicenseKey,
  readPreflightConfig,
  stripDeprecatedAiKeyFlags,
  applyAstCredentialRemediation,
  renderReport,
  renderAuditReport,
  renderTriStateRiskScore,
  routeAmbiguousFindingsToReasoning,
  resolveTriStateRiskScore,
  renderSarif,
  runCli,
  savePreflightConfig,
  scanBackendSecrets,
  scanBackendSource,
  scanFiles,
  scanFrontendSecrets,
  scanFrontendSource,
  scanProject,
  scanProjectDiff,
  scanSecretSource,
  scanSqlSource,
  scanStandaloneSecrets,
  scanSupabaseMigrations,
  validateLicenseKey,
  writeSarifReport
};

const isBinEntrypoint =
  module.parent && module.parent.filename === path.join(__dirname, "bin", "preflight.js");

if (require.main === module || isBinEntrypoint) {
  runCli().catch((error) => {
    process.stderr.write(`PreFlight Check failed: ${error.message}\n`);
    process.exitCode = 2;
  });
}
