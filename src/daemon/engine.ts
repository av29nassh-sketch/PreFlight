import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import fg from "fast-glob";
import { WebSocket, WebSocketServer, type WebSocket as WebSocketClient } from "ws";
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
import type { ReleaseFuzzerFinding } from "../fuzzer/runFuzzer";
import type { ReleaseGateFinding } from "../release-gate/model";
import { showWindowsHardBlockToast } from "../windows/nativeToast";

export interface PreFlightDaemonOptions {
  targetDir?: string;
  socketPath?: string;
  websocketPort?: number;
  output?: NodeJS.WritableStream;
}

export interface PreFlightDaemonHandle {
  socketPath: string;
  targetDir: string;
  websocketUrl: string;
  alreadyRunning?: boolean;
  close: () => Promise<void>;
}

export type PreFlightAlertMessage =
  | {
      type: "HARD_BLOCK";
      filePath: string;
      line?: number;
      payload?: string;
      message: string;
      issueType: string;
      severity: "HARD_BLOCK";
      source: "fuzzer" | "release-gate";
      detectedAt: string;
    }
  | {
      type: "CLEAR";
      filePath: string;
      detectedAt: string;
    }
  | {
      type: "PATCH_RESULT";
      ok: boolean;
      filePath?: string;
      message: string;
      detectedAt: string;
    };

type WebSocketClientMessage =
  | {
      type: "editor_hello";
      client?: string;
    }
  | {
      type: "patch_file";
      filePath: string;
    };

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

type HardBlockFinding = ReleaseFuzzerFinding | ReleaseGateFinding;
type HardBlockAlert = Extract<PreFlightAlertMessage, { type: "HARD_BLOCK" }>;
const NOTIFICATION_COOLDOWN_MS = 60_000;
const PREFLIGHT_NOTIFICATION_ICON = path.resolve(__dirname, "..", "..", "assets", "preflight-notification.png");
const DAEMON_MANIFEST_FILE = "preflight-daemon.json";
const DAEMON_PORT_PROBE_MS = 750;

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

function isFuzzerFinding(finding: HardBlockFinding): finding is ReleaseFuzzerFinding {
  return "payload" in finding && "type" in finding;
}

function inferLineFromTrail(trail: string[] = []): number | undefined {
  for (const item of trail) {
    const match = item.match(/:(\d+)\b/);
    if (match?.[1]) {
      return Number(match[1]);
    }
  }

  return undefined;
}

function resolveFindingFilePath(targetDir: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(targetDir, filePath);
}

export function formatHardBlockAlert(targetDir: string, finding: HardBlockFinding): HardBlockAlert {
  const filePath = resolveFindingFilePath(targetDir, finding.file);

  if (isFuzzerFinding(finding)) {
    return {
      type: "HARD_BLOCK",
      filePath,
      line: inferLineFromTrail(finding.trail),
      payload: finding.payload,
      message: finding.issue,
      issueType: finding.type,
      severity: "HARD_BLOCK",
      source: "fuzzer",
      detectedAt: new Date().toISOString()
    };
  }

  return {
    type: "HARD_BLOCK",
    filePath,
    line: finding.line,
    message: finding.issue,
    issueType: finding.source,
    severity: "HARD_BLOCK",
    source: "release-gate",
    detectedAt: new Date().toISOString()
  };
}

function collectHardBlockAlerts(targetDir: string, result: ReleaseGateScanResult): HardBlockAlert[] {
  return [
    ...result.fuzzFindings
      .filter((finding) => finding.severity === "HARD_BLOCK")
      .map((finding) => formatHardBlockAlert(targetDir, finding)),
    ...result.findings
      .filter((finding) => finding.severity === "HARD_BLOCK")
      .map((finding) => formatHardBlockAlert(targetDir, finding))
  ];
}

function ensureAbsoluteAlertPath(targetDir: string, message: PreFlightAlertMessage): PreFlightAlertMessage {
  if (!("filePath" in message) || !message.filePath) {
    return message;
  }

  return {
    ...message,
    filePath: resolveFindingFilePath(targetDir, message.filePath)
  };
}

function safeWrite(socket: net.Socket, message: DaemonToClientMessage): void {
  if (!socket.destroyed) {
    socket.write(encodeIpcMessage(message));
  }
}

function getDaemonManifestPath(targetDir: string): string {
  return path.join(targetDir, ".vscode", DAEMON_MANIFEST_FILE);
}

function readDaemonManifest(targetDir: string): { pid?: number; websocketUrl?: string; targetDir?: string; port?: number } | null {
  const manifestPath = getDaemonManifestPath(targetDir);
  try {
    if (!fs.existsSync(manifestPath)) {
      return null;
    }

    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

function removeDaemonManifest(targetDir: string): void {
  try {
    fs.rmSync(getDaemonManifestPath(targetDir), { force: true });
  } catch {
    // Best-effort cleanup only.
  }
}

function isDaemonUrlReachable(daemonUrl: string, expectedTargetDir?: string): Promise<boolean> {
  try {
    const parsed = new URL(daemonUrl);
    if (!/^wss?:$/.test(parsed.protocol)) {
      return Promise.resolve(false);
    }
  } catch {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const socket = new WebSocket(daemonUrl);
    const timeout = setTimeout(() => finish(false), DAEMON_PORT_PROBE_MS);
    let settled = false;
    const finish = (reachable: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      socket.removeAllListeners();
      socket.terminate();
      resolve(reachable);
    };

    socket.once("message", (rawMessage) => {
      try {
        const message = JSON.parse(rawMessage.toString("utf8"));
        const rawTargetDir = message?.targetDir || message?.state?.targetDir;
        const daemonTargetDir = typeof rawTargetDir === "string" ? path.resolve(rawTargetDir) : null;
        finish(message?.type === "STATE" && (!expectedTargetDir || daemonTargetDir === path.resolve(expectedTargetDir)));
      } catch {
        finish(false);
      }
    });
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
  });
}

export class PreFlightDaemon {
  private clients = new Set<net.Socket>();
  private websocketClients = new Set<WebSocketClient>();
  private editorWebSocketClients = new Set<WebSocketClient>();
  private server: net.Server | null = null;
  private websocketServer: WebSocketServer | null = null;
  private watcher: EyeWatcherHandle | null = null;
  private state: DaemonState;
  private scanPromise: Promise<void> = Promise.resolve();
  private activeHardBlockFiles = new Set<string>();
  private notificationCooldowns = new Map<string, number>();

  readonly socketPath: string;
  readonly targetDir: string;
  websocketPort: number;
  websocketUrl: string;

  constructor(private readonly options: PreFlightDaemonOptions = {}) {
    this.targetDir = path.resolve(options.targetDir || process.cwd());
    this.socketPath = options.socketPath || getPreflightSocketPath(this.targetDir);
    this.websocketPort = options.websocketPort ?? Number(process.env.PREFLIGHT_DAEMON_WS_PORT || 0);
    this.websocketUrl = `ws://127.0.0.1:${this.websocketPort}`;
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
    await this.startWebSocketServer();
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
      websocketUrl: this.websocketUrl,
      close: () => this.close()
    };
  }

  async close(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;

    for (const client of this.websocketClients) {
      client.close();
    }
    this.websocketClients.clear();
    this.editorWebSocketClients.clear();

    await new Promise<void>((resolve) => {
      if (!this.websocketServer) {
        resolve();
        return;
      }

      this.websocketServer.close(() => resolve());
    });
    this.websocketServer = null;

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

    this.removeDaemonManifest();
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

  private async startWebSocketServer(): Promise<void> {
    this.websocketServer = new WebSocketServer({
      host: "127.0.0.1",
      port: this.websocketPort
    });

    this.websocketServer.on("connection", (socket) => {
      this.websocketClients.add(socket);
      socket.send(JSON.stringify({
        type: "STATE",
        targetDir: this.targetDir,
        status: this.state.result.status,
        lastHardBlock: this.state.lastHardBlock ? formatHardBlockAlert(this.targetDir, this.state.lastHardBlock) : null,
        detectedAt: new Date().toISOString()
      }));
      socket.on("message", (rawMessage) => this.handleWebSocketClientMessage(socket, rawMessage.toString("utf8")));
      socket.on("close", () => {
        this.websocketClients.delete(socket);
        this.editorWebSocketClients.delete(socket);
      });
      socket.on("error", () => {
        this.websocketClients.delete(socket);
        this.editorWebSocketClients.delete(socket);
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.websocketServer?.once("error", reject);
      this.websocketServer?.once("listening", () => {
        this.websocketServer?.off("error", reject);
        const address = this.websocketServer?.address();
        if (address && typeof address === "object" && typeof address.port === "number") {
          this.websocketPort = address.port;
          this.websocketUrl = `ws://127.0.0.1:${address.port}`;
        }
        this.writeDaemonManifest();
        resolve();
      });
    });
  }

  private handleWebSocketClientMessage(socket: WebSocketClient, rawMessage: string): void {
    let message: WebSocketClientMessage;
    try {
      message = JSON.parse(rawMessage) as WebSocketClientMessage;
    } catch {
      return;
    }

    if (message.type === "editor_hello") {
      this.editorWebSocketClients.add(socket);
      this.writeLog(`[PreFlight] VS Code client attached. Native popup fallback suppressed.`);
      return;
    }

    if (message.type === "patch_file") {
      void this.applyPatchForFile(message.filePath)
        .then(() => {
          this.sendWebSocket(socket, {
            type: "PATCH_RESULT",
            ok: true,
            filePath: resolveFindingFilePath(this.targetDir, message.filePath),
            message: "Patch applied. Rescanning...",
            detectedAt: new Date().toISOString()
          });
        })
        .catch((error) => {
          this.sendWebSocket(socket, {
            type: "PATCH_RESULT",
            ok: false,
            filePath: resolveFindingFilePath(this.targetDir, message.filePath),
            message: error instanceof Error ? error.message : String(error),
            detectedAt: new Date().toISOString()
          });
        });
    }
  }

  private writeDaemonManifest(): void {
    const manifestPath = getDaemonManifestPath(this.targetDir);
    const manifest = {
      pid: process.pid,
      targetDir: this.targetDir,
      websocketUrl: this.websocketUrl,
      port: this.websocketPort,
      updatedAt: new Date().toISOString()
    };

    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  private removeDaemonManifest(): void {
    const manifestPath = getDaemonManifestPath(this.targetDir);
    try {
      if (fs.existsSync(manifestPath)) {
        fs.rmSync(manifestPath, { force: true });
      }
    } catch {
      // Best-effort cleanup only; a stale manifest is corrected on next daemon start.
    }
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

  private sendWebSocket(client: WebSocketClient, message: PreFlightAlertMessage): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(ensureAbsoluteAlertPath(this.targetDir, message)));
    }
  }

  private broadcastWebSocket(message: PreFlightAlertMessage): void {
    const normalizedMessage = ensureAbsoluteAlertPath(this.targetDir, message);
    const serialized = JSON.stringify(normalizedMessage);
    for (const client of this.websocketClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(serialized);
      }
    }
  }

  private writeLog(message: string): void {
    try {
      (this.options.output || process.stderr).write(`${message}\n`);
    } catch {
      // Logging should never be able to crash the daemon.
    }
  }

  private logHardBlock(alert: HardBlockAlert): void {
    const relativeFile = path.relative(this.targetDir, alert.filePath) || path.basename(alert.filePath);
    const line = alert.line ? `:${alert.line}` : "";
    const payload = alert.payload ? `\nPayload: ${alert.payload}` : "";
    const message = [
      "\x07",
      "",
      "----------------------------------------",
      "PREFLIGHT HARD BLOCK",
      `Detected: ${alert.issueType}`,
      `File: ${relativeFile}${line}`,
      `Message: ${alert.message}${payload}`,
      "Action: Open preflight dashboard . and press [P] to fix.",
      "----------------------------------------",
      ""
    ].join("\n");

    (this.options.output || process.stderr).write(`${message}\n`);
  }

  private maybeNotifyHardBlockFile(alerts: HardBlockAlert[]): void {
    const primaryAlert = alerts[0];
    if (!primaryAlert) {
      return;
    }

    const forceWindowsFallback = process.env.PREFLIGHT_FORCE_WINDOWS_POPUP === "1";
    if (this.editorWebSocketClients.size > 0 && !forceWindowsFallback) {
      this.writeLog(`[PreFlight] HARD_BLOCK routed to ${this.editorWebSocketClients.size} IDE client(s). Native popup skipped.`);
      return;
    }

    const issueTypes = [...new Set(alerts.map((alert) => alert.issueType))];
    const notificationKey = `${primaryAlert.filePath}:${issueTypes.join(",")}`;
    const now = Date.now();
    const lastNotifiedAt = this.notificationCooldowns.get(notificationKey) || 0;
    if (now - lastNotifiedAt < NOTIFICATION_COOLDOWN_MS) {
      return;
    }

    this.notificationCooldowns.set(notificationKey, now);
    const relativeFile = path.relative(this.targetDir, primaryAlert.filePath) || path.basename(primaryAlert.filePath);
    const line = primaryAlert.line ? `:${primaryAlert.line}` : "";
    const title =
      alerts.length === 1
        ? `PreFlight HARD BLOCK: ${primaryAlert.issueType}`
        : `PreFlight HARD BLOCK: ${alerts.length} vulnerabilities`;
    const summary =
      alerts.length === 1
        ? `${relativeFile}${line}.`
        : `${relativeFile}. ${issueTypes.join(", ")}.`;

    const shown = showWindowsHardBlockToast({
      filePath: primaryAlert.filePath,
      relativeFile,
      issueTypes,
      line: primaryAlert.line,
      iconPath: PREFLIGHT_NOTIFICATION_ICON
    });

    if (!shown) {
      (this.options.output || process.stderr).write(`[PreFlight] ${title}: ${summary} Run preflight dashboard .\n`);
    }
  }

  private broadcastAlertState(result: ReleaseGateScanResult): void {
    const currentAlerts = collectHardBlockAlerts(this.targetDir, result).map((alert) => ({
      ...alert,
      filePath: resolveFindingFilePath(this.targetDir, alert.filePath)
    }));
    const currentFiles = new Set(currentAlerts.map((alert) => alert.filePath));

    for (const staleFilePath of this.activeHardBlockFiles) {
      if (!currentFiles.has(staleFilePath)) {
        this.broadcastWebSocket({
          type: "CLEAR",
          filePath: staleFilePath,
          detectedAt: new Date().toISOString()
        });
      }
    }

    const announcedFiles = new Set<string>();

    for (const alert of currentAlerts) {
      this.broadcastWebSocket(alert);
      if (!this.activeHardBlockFiles.has(alert.filePath) && !announcedFiles.has(alert.filePath)) {
        const fileAlerts = currentAlerts.filter((currentAlert) => currentAlert.filePath === alert.filePath);
        this.logHardBlock(alert);
        this.maybeNotifyHardBlockFile(fileAlerts);
        announcedFiles.add(alert.filePath);
      }
    }

    this.activeHardBlockFiles = currentFiles;
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
      this.broadcastAlertState(result);

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
        this.broadcast({
          type: "log",
          message: `Routing ${issues.length} release-gate issue(s) for ${target.finding.file} to PreFlight Pro remediation.`
        });
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

  private getFindingsForFile(filePath: string): {
    fuzzFindings: ReleaseFuzzerFinding[];
    releaseGateFindings: ReleaseGateFinding[];
  } {
    const resolvedFilePath = resolveFindingFilePath(this.targetDir, filePath);
    const sameFile = (candidate: string) => resolveFindingFilePath(this.targetDir, candidate) === resolvedFilePath;

    return {
      fuzzFindings: this.state.result.fuzzFindings.filter((finding) => sameFile(finding.file)),
      releaseGateFindings: this.state.result.findings.filter((finding) => sameFile(finding.file))
    };
  }

  private async applyPatchForFile(filePath: string): Promise<void> {
    const resolvedFilePath = resolveFindingFilePath(this.targetDir, filePath);
    const { fuzzFindings, releaseGateFindings } = this.getFindingsForFile(resolvedFilePath);

    if (fuzzFindings.length === 0 && releaseGateFindings.length === 0) {
      throw new Error(`No active PreFlight finding found for ${resolvedFilePath}.`);
    }

    for (const finding of fuzzFindings) {
      const patched = await remediateFuzzerFinding({
        ...finding,
        file: resolvedFilePath
      });

      if (!patched) {
        throw new Error(`Fuzzer remediation did not apply a patch for ${resolvedFilePath}.`);
      }
    }

    if (releaseGateFindings.length > 0) {
      await applyAutoPatch(
        resolvedFilePath,
        releaseGateFindings.map((finding) => finding.issue)
      );
    }

    await this.runScan([resolvedFilePath]);
  }
}

export async function startPreFlightDaemon(options: PreFlightDaemonOptions = {}): Promise<PreFlightDaemonHandle> {
  const targetDir = path.resolve(options.targetDir || process.cwd());
  const manifest = readDaemonManifest(targetDir);
  const manifestTargetDir = manifest?.targetDir ? path.resolve(manifest.targetDir) : null;

  if (manifest?.websocketUrl && manifestTargetDir === targetDir) {
    const isReachable = await isDaemonUrlReachable(manifest.websocketUrl, targetDir);
    if (isReachable) {
      return {
        socketPath: options.socketPath || getPreflightSocketPath(targetDir),
        targetDir,
        websocketUrl: manifest.websocketUrl,
        alreadyRunning: true,
        close: async () => undefined
      };
    }
  }

  removeDaemonManifest(targetDir);
  const daemon = new PreFlightDaemon(options);
  return daemon.start();
}
