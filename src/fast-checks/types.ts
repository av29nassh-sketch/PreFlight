export type FastCheckStatus = "PASSED" | "WARNING" | "HARD_BLOCK";

export interface FastCheckFinding {
  file: string;
  line?: number;
  issue: string;
  severity: Exclude<FastCheckStatus, "PASSED">;
}

export interface FastCheckResult {
  status: FastCheckStatus;
  findings: FastCheckFinding[];
}

export function resolveFastCheckStatus(findings: FastCheckFinding[]): FastCheckStatus {
  if (findings.some((finding) => finding.severity === "HARD_BLOCK")) {
    return "HARD_BLOCK";
  }

  if (findings.some((finding) => finding.severity === "WARNING")) {
    return "WARNING";
  }

  return "PASSED";
}
