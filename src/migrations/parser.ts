import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";

export type SupabaseMigrationScanStatus = "PASSED" | "WARNING" | "HARD_BLOCK";

export interface SupabaseMigrationFileFinding {
  filePath: string;
  status: SupabaseMigrationScanStatus;
  errors: string[];
  warnings: string[];
  tables: string[];
}

export interface SupabaseMigrationScanResult {
  status: SupabaseMigrationScanStatus;
  errors: string[];
  warnings: string[];
  files: SupabaseMigrationFileFinding[];
}

interface CreateTableMatch {
  tableName: string;
  rawName: string;
}

const CREATE_TABLE_PATTERN =
  /\bcreate\s+(?:temporary\s+|temp\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?((?:"[^"]+"|[a-zA-Z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[a-zA-Z_][\w$]*))?)/gi;

const UNSAFE_POLICY_PATTERNS = [
  {
    pattern: /\busing\s*\(\s*true\s*\)/i,
    label: "Policy contains USING (true), which can allow broad row access."
  },
  {
    pattern: /\bwith\s+check\s*\(\s*true\s*\)/i,
    label: "Policy contains WITH CHECK (true), which can allow broad writes."
  }
];

function stripSqlComments(sql: string): string {
  return sql
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function normalizeIdentifierPart(identifier: string): string {
  const trimmed = identifier.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }

  return trimmed.toLowerCase();
}

function normalizeTableName(rawName: string): string {
  return rawName
    .split(".")
    .map((part) => normalizeIdentifierPart(part))
    .join(".");
}

function getUnqualifiedTableName(tableName: string): string {
  const parts = tableName.split(".");
  return parts[parts.length - 1] ?? tableName;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tableNamePattern(tableName: string): string {
  const unqualifiedTableName = getUnqualifiedTableName(tableName);
  const escapedFullName = escapeRegExp(tableName).replace(/\\\./g, "\\s*\\.\\s*");
  const escapedUnqualifiedName = escapeRegExp(unqualifiedTableName);

  return `(?:(?:${escapedFullName})|(?:${escapedUnqualifiedName})|(?:(?:\"[^\"]+\"|[a-zA-Z_][\\w$]*)\\s*\\.\\s*${escapedUnqualifiedName}))`;
}

function extractCreatedTables(sql: string): CreateTableMatch[] {
  const matches: CreateTableMatch[] = [];
  let match: RegExpExecArray | null;

  CREATE_TABLE_PATTERN.lastIndex = 0;
  while ((match = CREATE_TABLE_PATTERN.exec(sql)) !== null) {
    const rawName = match[1].replace(/\s+/g, "");
    matches.push({
      rawName,
      tableName: normalizeTableName(rawName)
    });
  }

  return matches;
}

function hasRlsEnabledForTable(sql: string, tableName: string): boolean {
  const pattern = new RegExp(
    `\\balter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${tableNamePattern(
      tableName
    )}\\s+enable\\s+row\\s+level\\s+security\\b`,
    "i"
  );

  return pattern.test(sql);
}

function getUnsafePolicyWarnings(sql: string): string[] {
  return UNSAFE_POLICY_PATTERNS.filter(({ pattern }) => pattern.test(sql)).map(({ label }) => label);
}

function resolveStatus(errors: string[], warnings: string[]): SupabaseMigrationScanStatus {
  if (errors.length > 0) {
    return "HARD_BLOCK";
  }

  if (warnings.length > 0) {
    return "WARNING";
  }

  return "PASSED";
}

export async function scanSupabaseMigrationFile(filePath: string): Promise<SupabaseMigrationFileFinding> {
  const resolvedFilePath = path.resolve(filePath);
  const rawSql = await fs.readFile(resolvedFilePath, "utf8");
  const sql = stripSqlComments(rawSql);
  const createdTables = extractCreatedTables(sql);
  const errors: string[] = [];
  const warnings = getUnsafePolicyWarnings(sql);

  for (const { tableName } of createdTables) {
    if (!hasRlsEnabledForTable(sql, tableName)) {
      errors.push(`Table '${tableName}' is missing ENABLE ROW LEVEL SECURITY.`);
    }
  }

  return {
    filePath: resolvedFilePath,
    status: resolveStatus(errors, warnings),
    errors,
    warnings,
    tables: createdTables.map(({ tableName }) => tableName)
  };
}

export async function scanSupabaseMigrations(migrationsDir: string): Promise<SupabaseMigrationScanResult> {
  const resolvedMigrationsDir = path.resolve(migrationsDir);
  const sqlFiles = await fg("**/*.sql", {
    absolute: true,
    cwd: resolvedMigrationsDir,
    dot: false,
    onlyFiles: true
  });

  const files = await Promise.all(sqlFiles.sort().map((filePath) => scanSupabaseMigrationFile(filePath)));
  const errors = files.flatMap((file) => file.errors.map((error) => `${path.relative(resolvedMigrationsDir, file.filePath)}: ${error}`));
  const warnings = files.flatMap((file) =>
    file.warnings.map((warning) => `${path.relative(resolvedMigrationsDir, file.filePath)}: ${warning}`)
  );

  return {
    status: resolveStatus(errors, warnings),
    errors,
    warnings,
    files
  };
}
