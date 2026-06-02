#!/usr/bin/env node

const fs = require("node:fs/promises");
const { execFile } = require("node:child_process");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { promisify } = require("node:util");
const { parse: parseJavaScript } = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const chalk = require("chalk");
const { Command } = require("commander");
const fg = require("fast-glob");
const colors = require("picocolors");
const { parse: parseSql } = require("pgsql-ast-parser");

const execFileAsync = promisify(execFile);
const PREFLIGHT_CONFIG_FILE = ".preflight-config.json";
const PREFLIGHT_POLICY_FILE = "preflight.config.json";
const LEMON_SQUEEZY_VALIDATE_URL = "https://api.lemonsqueezy.com/v1/licenses/validate";
const SOURCE_EXTENSIONS = ["js", "jsx", "ts", "tsx"];
const SCAN_EXTENSIONS = new Set([...SOURCE_EXTENSIONS, "sql"]);
const SECRET_VALUE_PATTERNS = [
  /\bsk_(?:test|live)_[A-Za-z0-9_=-]{8,}\b/,
  /\bsupabase[_-]?service[_-]?role\b/i,
  /\bservice[_-]?role[_-]?key\b/i
];
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
    )
  };
}

async function loadPreflightPolicy(rootDir = process.cwd(), options = {}) {
  const warn = options.warn || ((message) => console.warn(chalk.yellow(message)));
  const configPath = path.join(path.resolve(rootDir), PREFLIGHT_POLICY_FILE);
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return normalizePolicy(JSON.parse(raw));
  } catch (error) {
    if (error.code === "ENOENT") {
      return normalizePolicy();
    }

    warn("Warning: preflight.config.json contains invalid JSON and was ignored.");
    return normalizePolicy();
  }
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
  return policy.ignorePaths.some((ignorePath) => matchesIgnorePath(relativePath, ignorePath));
}

function applyPolicy(findings, policy = normalizePolicy(), rootDir = process.cwd()) {
  return findings.filter((item) => {
    const relativePath = toPosix(path.relative(path.resolve(rootDir), item.filePath));
    return !policy.ignoreRules.has(item.ruleId) && !isIgnoredPath(relativePath, policy);
  });
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

function parseSource(source, filePath) {
  return parseJavaScript(source, {
    sourceType: "unambiguous",
    errorRecovery: true,
    plugins: [
      "jsx",
      "typescript",
      "decorators-legacy",
      "classProperties",
      "classPrivateProperties",
      "classPrivateMethods",
      "dynamicImport",
      "importAttributes",
      "topLevelAwait"
    ],
    sourceFilename: filePath
  });
}

function detectSecret(value) {
  if (typeof value !== "string") {
    return null;
  }

  const directMatch = SECRET_VALUE_PATTERNS.find((pattern) => pattern.test(value));
  if (directMatch) {
    return directMatch.source;
  }

  const jwtRole = decodeSupabaseJwtRole(value);
  if (jwtRole === "service_role") {
    return "supabase service_role JWT";
  }

  return null;
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

function getEnvKey(node) {
  if (!node || node.type !== "MemberExpression") {
    return null;
  }

  const object = node.object;
  if (
    !object ||
    object.type !== "MemberExpression" ||
    object.object?.type !== "Identifier" ||
    object.object.name !== "process" ||
    object.property?.type !== "Identifier" ||
    object.property.name !== "env"
  ) {
    return null;
  }

  if (node.property.type === "Identifier") {
    return node.property.name;
  }

  if (node.property.type === "StringLiteral") {
    return node.property.value;
  }

  return null;
}

function finding({ ruleId, severity, filePath, line, message, evidence, tableName }) {
  return {
    ruleId,
    severity,
    filePath,
    line,
    message,
    ...(evidence ? { evidence } : {}),
    ...(tableName ? { tableName } : {})
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

function getMemberExpressionName(node) {
  if (!node || node.type !== "MemberExpression") {
    return null;
  }

  const propertyName =
    node.property?.type === "Identifier"
      ? node.property.name
      : node.property?.type === "StringLiteral"
        ? node.property.value
        : null;

  if (!propertyName) {
    return null;
  }

  if (node.object?.type === "Identifier") {
    return `${node.object.name}.${propertyName}`;
  }

  return propertyName;
}

function isJwtSecretCall(node) {
  if (!node || node.type !== "CallExpression") {
    return false;
  }

  const calleeName =
    node.callee?.type === "Identifier" ? node.callee.name : getMemberExpressionName(node.callee);

  return calleeName === "jwt.sign" || calleeName === "jwt.verify" || calleeName === "sign" || calleeName === "verify";
}

function isHardcodedStringNode(node) {
  return node?.type === "StringLiteral" || node?.type === "TemplateLiteral" && node.expressions.length === 0;
}

function getStringNodeLine(node) {
  if (node?.type === "TemplateLiteral") {
    return node.quasis[0]?.loc?.start?.line || node.loc?.start?.line || 1;
  }

  return node?.loc?.start?.line || 1;
}

function scanBackendSource({ filePath, relativePath, source, includeStandaloneBackend }) {
  if (!isSourceFile(filePath)) {
    return [];
  }

  if (!includeStandaloneBackend && !isBackendApiRoute(relativePath)) {
    return [];
  }

  let ast;
  try {
    ast = parseSource(source, filePath);
  } catch (error) {
    return [
      finding({
        ruleId: "parse-error",
        severity: "warning",
        filePath,
        line: error.loc?.line || 1,
        message: `Could not parse source file: ${error.message}`
      })
    ];
  }

  const findings = [];

  function addBackendSecret(node, evidence, message) {
    findings.push(
      finding({
        ruleId: "backend-secret",
        severity: "critical",
        filePath,
        line: getStringNodeLine(node),
        message,
        evidence
      })
    );
  }

  traverse(ast, {
    StringLiteral({ node }) {
      const match = detectDatabaseUrl(node.value);
      if (match) {
        addBackendSecret(node, match, "Raw backend database connection string is hardcoded in source.");
      }
    },
    TemplateElement({ node }) {
      const match = detectDatabaseUrl(node.value.cooked || node.value.raw);
      if (match) {
        addBackendSecret(node, match, "Raw backend database connection string is hardcoded in source.");
      }
    },
    CallExpression({ node }) {
      if (!isJwtSecretCall(node)) {
        return;
      }

      const secretArg = node.arguments[1];
      if (isHardcodedStringNode(secretArg)) {
        const calleeName = node.callee?.type === "Identifier" ? node.callee.name : getMemberExpressionName(node.callee);
        addBackendSecret(
          secretArg,
          `${calleeName} hardcoded secret`,
          "JWT signing or verification secret is hardcoded instead of using process.env."
        );
      }
    }
  });

  return dedupeFindings(findings);
}

function scanSecretSource({ filePath, relativePath, source, requireClientComponent }) {
  if (!isSourceFile(filePath)) {
    return [];
  }

  if (requireClientComponent && (!isInsideNextFrontend(relativePath) || !isClientComponent(relativePath, source))) {
    return [];
  }

  let ast;
  try {
    ast = parseSource(source, filePath);
  } catch (error) {
    return [
      finding({
        ruleId: "parse-error",
        severity: "warning",
        filePath,
        line: error.loc?.line || 1,
        message: `Could not parse source file: ${error.message}`
      })
    ];
  }

  const findings = [];

  function addFrontendSecret(node, evidence) {
    findings.push(
      finding({
        ruleId: "frontend-secret",
        severity: "critical",
        filePath,
        line: node.loc?.start?.line || 1,
        message: frontendSecretMessage(requireClientComponent),
        evidence
      })
    );
  }

  traverse(ast, {
    StringLiteral({ node }) {
      const match = detectSecret(node.value);
      if (match) {
        addFrontendSecret(node, match);
      }
    },
    TemplateElement({ node }) {
      const match = detectSecret(node.value.cooked || node.value.raw);
      if (match) {
        addFrontendSecret(node, match);
      }
    },
    MemberExpression({ node }) {
      const envKey = getEnvKey(node);
      if (envKey && SERVICE_ROLE_NAME_PATTERN.test(envKey)) {
        addFrontendSecret(node, `process.env.${envKey}`);
      }
    },
    Identifier({ node }) {
      if (SERVICE_ROLE_NAME_PATTERN.test(node.name)) {
        addFrontendSecret(node, node.name);
      }
    }
  });

  return dedupeFindings(findings);
}

function scanFrontendSource({ filePath, relativePath, source }) {
  return scanSecretSource({ filePath, relativePath, source, requireClientComponent: true });
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
    ignore: ["app/api/**", "pages/api/**", "**/*.d.ts", "**/node_modules/**", "**/.next/**"]
  });

  const results = [];

  for (const relativePath of files) {
    if (isIgnoredPath(relativePath, policy)) {
      continue;
    }

    const filePath = path.join(rootDir, relativePath);
    const source = await fs.readFile(filePath, "utf8");
    results.push(...scanFrontendSource({ filePath, relativePath, source }));
  }

  return results;
}

async function scanBackendSecrets(rootDir, options = {}) {
  const policy = options.policy || normalizePolicy();
  const files = await fg(["{app/api,pages/api}/**/*.{js,jsx,ts,tsx}"], {
    cwd: rootDir,
    absolute: false,
    dot: false,
    ignore: ["**/*.d.ts", "**/node_modules/**", "**/.next/**", "**/dist/**", "**/coverage/**"]
  });

  const results = [];

  for (const relativePath of files) {
    if (isIgnoredPath(relativePath, policy)) {
      continue;
    }

    const filePath = path.join(rootDir, relativePath);
    const source = await fs.readFile(filePath, "utf8");
    results.push(...scanBackendSource({ filePath, relativePath, source, includeStandaloneBackend: false }));
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
      "**/*.d.ts",
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/coverage/**"
    ]
  });

  const results = [];

  for (const relativePath of files) {
    if (isIgnoredPath(relativePath, policy)) {
      continue;
    }

    const filePath = path.join(rootDir, relativePath);
    const source = await fs.readFile(filePath, "utf8");
    results.push(...scanSecretSource({ filePath, relativePath, source, requireClientComponent: false }));
    results.push(...scanBackendSource({ filePath, relativePath, source, includeStandaloneBackend: true }));
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

function scanSqlSource({ filePath, source }) {
  const rlsEnabledTables = extractRlsEnabledTables(source);

  return extractCreatedTables(source)
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

  for (const relativePath of files) {
    if (isIgnoredPath(relativePath, policy)) {
      continue;
    }

    const filePath = path.join(rootDir, relativePath);
    const source = await fs.readFile(filePath, "utf8");
    const tables = extractCreatedTables(source).map((table) => ({ ...table, filePath }));
    createdTables.push(...tables);

    for (const tableName of extractRlsEnabledTables(source)) {
      rlsEnabledTables.add(tableName);
    }
  }

  return applyPolicy(createdTables
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
    ), policy, rootDir);
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

  for (const file of files) {
    const filePath = file.filePath || path.join(resolvedRoot, file.relativePath);
    const relativePath = toPosix(file.relativePath || path.relative(resolvedRoot, filePath));
    if (isIgnoredPath(relativePath, policy)) {
      continue;
    }

    const source = await fs.readFile(filePath, "utf8");

    if (path.extname(filePath).toLowerCase() === ".sql") {
      findings.push(...scanSqlSource({ filePath, source }));
      continue;
    }

    findings.push(
      ...scanSecretSource({
        filePath,
        relativePath,
        source,
        requireClientComponent: false
      })
    );
    findings.push(
      ...scanBackendSource({
        filePath,
        relativePath,
        source,
        includeStandaloneBackend: true
      })
    );
  }

  return applyPolicy(dedupeFindings(findings), policy, resolvedRoot).sort((a, b) => {
    if (a.filePath === b.filePath) {
      return a.line - b.line;
    }

    return a.filePath.localeCompare(b.filePath);
  });
}

async function scanProjectDiff(rootDir = process.cwd(), options = {}) {
  const resolvedRoot = path.resolve(rootDir);
  const policy = options.policy || normalizePolicy();
  const files = await getChangedScanFiles(resolvedRoot, { policy });
  return scanFiles(resolvedRoot, files, { policy });
}

async function scanProject(rootDir = process.cwd(), options = {}) {
  const resolvedRoot = path.resolve(rootDir);
  const policy = options.policy || normalizePolicy();
  const includeStandaloneSecrets = await shouldScanAsStandaloneSourceDirectory(resolvedRoot);
  const [frontendFindings, backendFindings, standaloneFindings, migrationFindings] = await Promise.all([
    scanFrontendSecrets(resolvedRoot, { policy }),
    scanBackendSecrets(resolvedRoot, { policy }),
    includeStandaloneSecrets ? scanStandaloneSecrets(resolvedRoot, { policy }) : Promise.resolve([]),
    scanSupabaseMigrations(resolvedRoot, { policy })
  ]);

  return applyPolicy(
    [...frontendFindings, ...backendFindings, ...standaloneFindings, ...migrationFindings],
    policy,
    resolvedRoot
  ).sort((a, b) => {
    if (a.filePath === b.filePath) {
      return a.line - b.line;
    }

    return a.filePath.localeCompare(b.filePath);
  });
}

function renderReport(findings, options = {}) {
  const color = options.color !== false;
  const c = color ? colors : new Proxy({}, { get: () => (value) => value });

  if (findings.length === 0) {
    return `${c.green("The Scavenger found 0 issues.")}\n`;
  }

  const plural = findings.length === 1 ? "issue" : "issues";
  const lines = [
    c.red(`The Scavenger found ${findings.length} ${plural}.`),
    ""
  ];

  for (const item of findings) {
    lines.push(`${c.bold(item.severity.toUpperCase())} ${c.cyan(item.ruleId)}`);
    lines.push(`  ${item.filePath}:${item.line}`);
    lines.push(`  ${item.message}`);
    if (item.evidence) {
      lines.push(`  Evidence: ${item.evidence}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
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
            name: "PreFlight Scavenger",
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

function normalizeCliArgs(argv) {
  const [nodePath, scriptPath, firstArg, ...rest] = argv;
  const knownCommands = new Set(["scan", "apply-fix", "help"]);

  if (!firstArg || firstArg.startsWith("-") || !knownCommands.has(firstArg)) {
    return [nodePath, scriptPath, "scan", ...(firstArg ? [firstArg, ...rest] : rest)];
  }

  return argv;
}

async function runCli(argv = process.argv) {
  const normalizedArgv = normalizeCliArgs(argv);
  const program = new Command();
  program
    .name("scavenger")
    .description("Local zero-knowledge scanner for Next.js and Supabase security flaws.");

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
          console.error(chalk.red("Invalid License Key"));
          process.exit(1);
        }

        console.error(chalk.red(`License verification failed: ${error.message}`));
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

  async function runScanAction(directory, options) {
    const rootDir = path.resolve(directory);
    const policy = await loadPreflightPolicy(process.cwd());
    const findings = options.diff ? await scanProjectDiff(rootDir, { policy }) : await scanProject(rootDir, { policy });

    if (options.format === "sarif") {
      await writeSarifReport(findings, { rootDir });
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
    } else {
      process.stdout.write(renderReport(findings, { color: options.color }));
    }

    process.exit(findings.length > 0 ? 1 : 0);
  }

  program
    .command("scan")
    .description("Run the free local scanner.")
    .argument("[directory]", "project directory to scan", process.cwd())
    .option("--diff", "scan only changed Git files")
    .option("--format <format>", "output format: text or sarif", "text")
    .option("--json", "print findings as JSON")
    .option("--no-color", "disable color output")
    .action(runScanAction);

  await program.parseAsync(normalizedArgv);
}

module.exports = {
  applyFixWithRollback,
  detectSecret,
  ensureLicenseVerified,
  extractCreatedTables,
  extractRlsEnabledTables,
  getChangedScanFiles,
  getPreflightConfigPath,
  hasUseClientDirective,
  InvalidLicenseKeyError,
  isIgnoredPath,
  loadPreflightPolicy,
  matchesIgnorePath,
  normalizeCliArgs,
  normalizePolicy,
  postFormUrlEncoded,
  promptForLicenseKey,
  readPreflightConfig,
  renderReport,
  renderSarif,
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

if (require.main === module) {
  runCli().catch((error) => {
    process.stderr.write(`The Scavenger failed: ${error.message}\n`);
    process.exitCode = 2;
  });
}
