import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import fg from "fast-glob";
import { startWatcher, type EyeWatcherHandle } from "../eye/watcher";
import { applyAutoPatch } from "../release-gate/patcher";
import { runReleaseGateScan } from "../release-gate/pipeline";
import type { ReleaseGateScanResult } from "../release-gate/model";
import { remediateFuzzerFinding } from "../remediation/patcher";
import {
  type ClientToDaemonMessage,
  type DaemonPatchTarget,
  type DaemonState,
  type DaemonToClientMessage,
  encodeIpcMessage,
  getPreflightSocketPath,
  parseIpcLines
} from "./protocol";

export interface PreFlightDaemonOptions {
  targetDir?: string;
  socketPath?: string;
  output?: NodeJS.WritableStream;
}

export interface PreFlightDaemonHandle {
  socketPath: string;
  targetDir: string;
  close: () => Promise<void>;
}

const EMPTY_RESULT: ReleaseGateScanResult = {
  status: "PASSED",
  targetDir: process.cwd(),
  scannedAt: new Date(0).toISOString(),
  eye: {
    active: true,
    changedFiles: []
  },
  findings: [],
  fuzzFindings: []
};

async function countTrackedFiles(targetDir: string): Promise<number> {
  const files = await fg("**/*", {
    absolute: true,
    cwd: targetDir,
    dot: true,
    ignore: ["**/node_modules/**", "**/.git/**", "**/.next/**", "**/dist/**", "**/build/**", "**/.turbo/**", "**/.cache/**"],
    onlyFiles: true
  });

  return files.length;
}

function findFirstHardBlock(result: ReleaseGateScanResult) {
  return (
    result.fuzzFindings.find((finding) => finding.severity === "HARD_BLOCK") ||
    result.findings.find((finding) => finding.severity === "HARD_BLOCK")
  );
}

function safeWrite(socket: net.Socket, message: DaemonToClientMessage): void {
  if (!socket.destroyed) {
    socket.write(encodeIpcMessage(message));
  }
}

export class PreFlightDaemon {
  private clients = new Set<net.Socket>();
  private server: net.Server | null = null;
  private watcher: EyeWatcherHandle | null = null;
  private state: DaemonState;
  private scanPromise: Promise<void> = Promise.resolve();

  readonly socketPath: string;
  readonly targetDir: string;

  constructor(private readonly options: PreFlightDaemonOptions = {}) {
    this.targetDir = path.resolve(options.targetDir || process.cwd());
    this.socketPath = options.socketPath || getPreflightSocketPath(this.targetDir);
    this.state = {
      targetDir: this.targetDir,
      trackedFiles: 0,
      scanProgress: "idle",
      result: {
        ...EMPTY_RESULT,
        targetDir: this.targetDir,
        scannedAt: new Date().toISOString()
      }
    };
  }

  async start(): Promise<PreFlightDaemonHandle> {
    await this.startIpcServer();
    await this.runScan([]);
    this.watcher = startWatcher(this.targetDir, {
      output: this.options.output,
      onBatch: async (changedFiles) => {
        this.scanPromise = this.scanPromise.then(() => this.runScan(changedFiles));
        await this.scanPromise;
      }
    });

    return {
      socketPath: this.socketPath,
      targetDir: this.targetDir,
      close: () => this.close()
    };
  }

  async close(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;

    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();

    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close(() => resolve());
    });
    this.server = null;

    if (process.platform !== "win32" && fs.existsSync(this.socketPath)) {
      fs.rmSync(this.socketPath, { force: true });
    }
  }

  private async startIpcServer(): Promise<void> {
    if (process.platform !== "win32" && fs.existsSync(this.socketPath)) {
      fs.rmSync(this.socketPath, { force: true });
    }

    this.server = net.createServer((socket) => this.handleClient(socket));

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.socketPath, () => {
        this.server?.off("error", reject);
        resolve();
      });
    });
  }

  private handleClient(socket: net.Socket): void {
    this.clients.add(socket);
    safeWrite(socket, { type: "state", state: this.state });

    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const parsed = parseIpcLines(buffered);
      buffered = parsed.rest;

      for (const line of parsed.lines) {
        this.handleClientMessage(socket, line);
      }
    });
    socket.on("close", () => this.clients.delete(socket));
    socket.on("error", () => this.clients.delete(socket));
  }

  private handleClientMessage(socket: net.Socket, rawLine: string): void {
    let message: ClientToDaemonMessage;
    try {
      message = JSON.parse(rawLine) as ClientToDaemonMessage;
    } catch {
      safeWrite(socket, { type: "log", message: "Ignoring malformed IPC message." });
      return;
    }

    if (message.type === "hello") {
      safeWrite(socket, { type: "state", state: this.state });
      return;
    }

    if (message.type === "patch") {
      void this.applyPatch(message.target);
    }
  }

  private broadcast(message: DaemonToClientMessage): void {
    for (const client of this.clients) {
      safeWrite(client, message);
    }
  }

  private async runScan(changedFiles: string[]): Promise<void> {
    this.state = {
      ...this.state,
      scanProgress: "scanning",
      lastError: undefined
    };
    this.broadcast({ type: "state", state: this.state });

    try {
      const [trackedFiles, result] = await Promise.all([
        countTrackedFiles(this.targetDir),
        runReleaseGateScan({
          targetDir: this.targetDir,
          eyeActive: true,
          changedFiles
        })
      ]);
      const lastHardBlock = findFirstHardBlock(result);

      this.state = {
        targetDir: this.targetDir,
        trackedFiles,
        scanProgress: "idle",
        lastHardBlock,
        result
      };
      this.broadcast({ type: "state", state: this.state });
      if (lastHardBlock) {
        this.broadcast({ type: "hard_block", finding: lastHardBlock });
      }
    } catch (error) {
      this.state = {
        ...this.state,
        scanProgress: "error",
        lastError: error instanceof Error ? error.message : String(error)
      };
      this.broadcast({ type: "state", state: this.state });
    }
  }

  private async applyPatch(target: DaemonPatchTarget): Promise<void> {
    try {
      if (target.kind === "fuzzer") {
        const patched = await remediateFuzzerFinding({
          ...target.finding,
          file: path.resolve(this.targetDir, target.finding.file)
        });
        if (!patched) {
          throw new Error("Fuzzer remediation did not apply a patch.");
        }
      } else {
        const fileFindings = this.state.result.findings.filter((finding) => finding.file === target.finding.file);
        const issues = fileFindings.length > 0 ? fileFindings.map((finding) => finding.issue) : [target.finding.issue];
        await applyAutoPatch(path.resolve(this.targetDir, target.finding.file), issues);
      }

      this.broadcast({ type: "patch_result", ok: true, message: "Patch applied. Rescanning..." });
      await this.runScan([]);
    } catch (error) {
      this.broadcast({
        type: "patch_result",
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

export async function startPreFlightDaemon(options: PreFlightDaemonOptions = {}): Promise<PreFlightDaemonHandle> {
  const daemon = new PreFlightDaemon(options);
  return daemon.start();
}
