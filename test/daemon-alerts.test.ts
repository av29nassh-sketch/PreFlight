import path from "node:path";
import { describe, expect, test } from "vitest";
import { formatHardBlockAlert } from "../src/daemon/engine";
import { shouldIgnoreWatchPath } from "../src/eye/ignoreRules";
import type { ReleaseFuzzerFinding } from "../src/fuzzer/runFuzzer";
import type { ReleaseGateFinding } from "../src/release-gate/model";

describe("PreFlight daemon extension alerts", () => {
  test("serializes fuzzer HARD_BLOCK findings for WebSocket clients", () => {
    const targetDir = path.resolve("src", "api");
    const finding: ReleaseFuzzerFinding = {
      type: "COMMAND_INJECTION",
      severity: "HARD_BLOCK",
      file: "network.js",
      payload: "127.0.0.1; cat /etc/passwd",
      trail: [
        `${path.join(targetDir, "network.js")}:12 -> exec(command)`
      ],
      issue: "COMMAND_INJECTION payload reaches command-execution without sanitizer or parameterization."
    };

    const alert = formatHardBlockAlert(targetDir, finding);

    expect(alert).toMatchObject({
      type: "HARD_BLOCK",
      filePath: path.join(targetDir, "network.js"),
      line: 12,
      payload: "127.0.0.1; cat /etc/passwd",
      message: finding.issue,
      issueType: "COMMAND_INJECTION",
      severity: "HARD_BLOCK",
      source: "fuzzer"
    });
    expect(alert.detectedAt).toEqual(expect.any(String));
  });

  test("serializes release-gate findings with line and message", () => {
    const targetDir = path.resolve("src", "api");
    const finding: ReleaseGateFinding = {
      file: "config.ts",
      line: 4,
      issue: "Hardcoded secret detected.",
      severity: "HARD_BLOCK",
      source: "fast-check"
    };

    const alert = formatHardBlockAlert(targetDir, finding);

    expect(alert).toMatchObject({
      type: "HARD_BLOCK",
      filePath: path.join(targetDir, "config.ts"),
      line: 4,
      message: "Hardcoded secret detected.",
      issueType: "fast-check",
      severity: "HARD_BLOCK",
      source: "release-gate"
    });
  });

  test("daemon watch ignores test and fixture paths by default", () => {
    expect(shouldIgnoreWatchPath(path.join("test", "check.test.js"))).toBe(true);
    expect(shouldIgnoreWatchPath(path.join("tests", "api.spec.ts"))).toBe(true);
    expect(shouldIgnoreWatchPath(path.join("__fixtures__", "bad-route.js"))).toBe(true);
    expect(shouldIgnoreWatchPath(path.join("src", "api", "network.js"))).toBe(false);
  });
});
