#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { shouldIgnoreWatchPath } from "../eye/ignoreRules";
import { scanPackageJson } from "./dependencies";
import { scanForSecrets } from "./secrets";
import { type FastCheckFinding, type FastCheckResult, resolveFastCheckStatus } from "./types";

const SECRET_SCAN_EXTENSIONS = [
  "cjs",
  "cts",
  "env",
  "js",
  "json",
  "jsx",
  "mjs",
  "mts",
  "sql",
  "ts",
  "tsx",
  "txt",
  "yaml",
  "yml"
];

function isSecretScanTarget(filePath: string): boolean {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  return SECRET_SCAN_EXTENSIONS.includes(extension);
}

async function collectCandidateFiles(targetDir: string): Promise<string[]> {
  return fg("**/*", {
    absolute: true,
    cwd: targetDir,
    dot: true,
    ignore: ["**/node_modules/**", "**/.git/**", "**/.next/**", "**/dist/**", "**/build/**", "**/.turbo/**", "**/.cache/**"],
    onlyFiles: true
  });
}

export async function runFastChecks(targetDir: string): Promise<FastCheckResult> {
  const resolvedTargetDir = path.resolve(targetDir);
  const candidateFiles = await collectCandidateFiles(resolvedTargetDir);
  const findings: FastCheckFinding[] = [];

  for (const filePath of candidateFiles) {
    if (shouldIgnoreWatchPath(filePath)) {
      continue;
    }

    if (path.basename(filePath) === "package.json") {
      try {
        findings.push(...(await scanPackageJson(filePath)));
      } catch (error) {
        findings.push({
          file: filePath,
          issue: `Could not parse package.json: ${error instanceof Error ? error.message : String(error)}`,
          severity: "WARNING"
        });
      }
    }

    if (!isSecretScanTarget(filePath)) {
      continue;
    }

    try {
      const fileContent = await fs.readFile(filePath, "utf8");
      findings.push(...scanForSecrets(fileContent, filePath));
    } catch {
      // Ignore unreadable binary or transient files in the fast local pass.
    }
  }

  return {
    status: resolveFastCheckStatus(findings),
    findings
  };
}

async function main(): Promise<void> {
  const targetDir = path.resolve(process.cwd(), process.argv[2] ?? ".");
  const result = await runFastChecks(targetDir);
  const statusColor =
    result.status === "HARD_BLOCK" ? "\x1b[31m" : result.status === "WARNING" ? "\x1b[33m" : "\x1b[32m";

  process.stdout.write(`${statusColor}${result.status}\x1b[0m 0-Token Fast Checks: ${targetDir}\n`);

  if (result.findings.length === 0) {
    process.stdout.write("No fast-check issues found.\n");
    return;
  }

  for (const finding of result.findings) {
    const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
    process.stdout.write(`- ${finding.severity} ${location}\n  ${finding.issue}\n`);
  }
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`0-Token Fast Checks failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
