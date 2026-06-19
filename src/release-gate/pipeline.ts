import fs from "node:fs";
import path from "node:path";
import { runFastChecks } from "../fast-checks";
import { runFuzzerScan } from "../fuzzer/runFuzzer";
import { scanSupabaseMigrations } from "../migrations/parser";
import {
  type ReleaseGateFinding,
  type ReleaseGateScanResult,
  fromFastCheckSeverity,
  fromMigrationStatus,
  resolveReleaseGateStatus
} from "./model";

function toDisplayPath(targetDir: string, filePath: string): string {
  return path.relative(targetDir, filePath) || path.basename(filePath);
}

function resolveSupabaseMigrationsDir(targetDir: string): string | null {
  const candidate = path.join(targetDir, "supabase", "migrations");
  return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory() ? candidate : null;
}

export async function runReleaseGateScan({
  targetDir,
  eyeActive,
  changedFiles = []
}: {
  targetDir: string;
  eyeActive: boolean;
  changedFiles?: string[];
}): Promise<ReleaseGateScanResult> {
  const resolvedTargetDir = path.resolve(targetDir);
  const findings: ReleaseGateFinding[] = [];
  const [fastCheckResult, fuzzFindings] = await Promise.all([runFastChecks(resolvedTargetDir), runFuzzerScan(resolvedTargetDir)]);

  findings.push(
    ...fastCheckResult.findings.map((finding) => ({
      file: toDisplayPath(resolvedTargetDir, finding.file),
      line: finding.line,
      issue: finding.issue,
      severity: fromFastCheckSeverity(finding.severity),
      source: "fast-check" as const
    }))
  );

  const migrationsDir = resolveSupabaseMigrationsDir(resolvedTargetDir);
  if (migrationsDir) {
    const migrationResult = await scanSupabaseMigrations(migrationsDir);

    for (const file of migrationResult.files) {
      const relativeFile = toDisplayPath(resolvedTargetDir, file.filePath);

      findings.push(
        ...file.errors.map((error) => ({
          file: relativeFile,
          issue: error,
          severity: fromMigrationStatus("HARD_BLOCK"),
          source: "supabase-migration" as const
        }))
      );

      findings.push(
        ...file.warnings.map((warning) => ({
          file: relativeFile,
          issue: warning,
          severity: fromMigrationStatus("WARNING"),
          source: "supabase-migration" as const
        }))
      );
    }
  }

  return {
    status: resolveReleaseGateStatus(findings, fuzzFindings),
    targetDir: resolvedTargetDir,
    scannedAt: new Date().toISOString(),
    eye: {
      active: eyeActive,
      changedFiles: changedFiles.map((filePath) => toDisplayPath(resolvedTargetDir, filePath))
    },
    findings,
    fuzzFindings
  };
}
