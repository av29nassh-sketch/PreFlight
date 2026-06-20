import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { ReleaseFuzzerFinding } from "../fuzzer/runFuzzer";
import type { ReleaseGateFinding, ReleaseGateScanResult } from "../release-gate/model";

export type DaemonPatchTarget =
  | {
      kind: "fuzzer";
      finding: ReleaseFuzzerFinding;
    }
  | {
      kind: "release-gate";
      finding: ReleaseGateFinding;
    };

export interface DaemonState {
  targetDir: string;
  trackedFiles: number;
  scanProgress: "idle" | "scanning" | "error";
  lastError?: string;
  lastHardBlock?: ReleaseFuzzerFinding | ReleaseGateFinding;
  result: ReleaseGateScanResult;
}

export type DaemonToClientMessage =
  | {
      type: "state";
      state: DaemonState;
    }
  | {
      type: "hard_block";
      finding: ReleaseFuzzerFinding | ReleaseGateFinding;
    }
  | {
      type: "patch_result";
      ok: boolean;
      message: string;
    }
  | {
      type: "log";
      message: string;
    };

export type ClientToDaemonMessage =
  | {
      type: "hello";
    }
  | {
      type: "patch";
      target: DaemonPatchTarget;
    };

export function encodeIpcMessage(message: DaemonToClientMessage | ClientToDaemonMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function getPreflightSocketPath(targetDir = process.cwd()): string {
  const hash = crypto.createHash("sha1").update(path.resolve(targetDir).toLowerCase()).digest("hex").slice(0, 12);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\preflight-${hash}`;
  }

  return path.join(os.tmpdir(), `preflight-${hash}.sock`);
}

export function parseIpcLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split(/\n/);
  return {
    lines: parts.slice(0, -1).filter((line) => line.trim()),
    rest: parts[parts.length - 1] || ""
  };
}
