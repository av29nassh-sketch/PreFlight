import type { FastCheckStatus } from "../fast-checks/types";
import type { SupabaseMigrationScanStatus } from "../migrations/parser";
import type { ReleaseFuzzerFinding } from "../fuzzer/runFuzzer";

export type ReleaseGateStatus = "PASSED" | "WARNING" | "HARD_BLOCK";

export interface ReleaseGateFinding {
  file: string;
  line?: number;
  issue: string;
  severity: Exclude<ReleaseGateStatus, "PASSED">;
  source: "fast-check" | "supabase-migration";
}

export interface ReleaseGateScanResult {
  status: ReleaseGateStatus;
  targetDir: string;
  scannedAt: string;
  eye: {
    active: boolean;
    changedFiles: string[];
  };
  findings: ReleaseGateFinding[];
  fuzzFindings: ReleaseFuzzerFinding[];
}

export function resolveReleaseGateStatus(findings: ReleaseGateFinding[], fuzzFindings: ReleaseFuzzerFinding[] = []): ReleaseGateStatus {
  if (fuzzFindings.some((finding) => finding.severity === "HARD_BLOCK")) {
    return "HARD_BLOCK";
  }

  if (findings.some((finding) => finding.severity === "HARD_BLOCK")) {
    return "HARD_BLOCK";
  }

  if (findings.some((finding) => finding.severity === "WARNING")) {
    return "WARNING";
  }

  return "PASSED";
}

export function fromFastCheckSeverity(severity: Exclude<FastCheckStatus, "PASSED">): Exclude<ReleaseGateStatus, "PASSED"> {
  return severity;
}

export function fromMigrationStatus(status: Exclude<SupabaseMigrationScanStatus, "PASSED">): Exclude<ReleaseGateStatus, "PASSED"> {
  return status === "HARD_BLOCK" ? "HARD_BLOCK" : "WARNING";
}
