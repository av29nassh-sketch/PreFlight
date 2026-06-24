#!/usr/bin/env node
import "dotenv/config";
import childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import React from "react";
import { render } from "ink";
import { startPreFlightDaemon } from "../daemon/engine";
import { getPreflightSocketPath } from "../daemon/protocol";
import { startWatcher } from "../eye/watcher";
import { runStart, runWakeup } from "./start";
import { saveLicenseKey, validateLicenseKey } from "../config/auth";
import type { ReleaseGateScanResult } from "../release-gate/model";
import { runReleaseGateScan } from "../release-gate/pipeline";
import { applyAutoPatch } from "../release-gate/patcher";
import { Dashboard } from "../tui/Dashboard";
import { IpcDashboard } from "../tui/IpcDashboard";

const PLAYGROUND_DIR_NAME = ".preflight-playground";

const VULNERABLE_ROUTE = [
  "export async function GET(req) {",
  "  const userId = req.query.userId;",
  "  const sql = \"SELECT * FROM users WHERE id = \" + userId;",
  "  return db.query(sql);",
  "}",
  ""
].join("\n");

function getPackageVersion(): string {
  const packageJsonPath = path.resolve(__dirname, "..", "..", "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
  return packageJson.version || "0.0.0";
}

export async function createDemoProject(baseDir = process.cwd()): Promise<string> {
  const demoDir = path.resolve(baseDir, PLAYGROUND_DIR_NAME);
  const routeDir = path.join(demoDir, "app", "api", "users");
  const routeFile = path.join(routeDir, "route.ts");

  await fs.rm(demoDir, { recursive: true, force: true });
  await fs.mkdir(routeDir, { recursive: true });
  await fs.writeFile(routeFile, VULNERABLE_ROUTE, "utf8");

  return demoDir;
}

export async function runScan(targetDir = process.cwd()): Promise<void> {
  const resolvedTargetDir = path.resolve(targetDir);
  let currentResult: ReleaseGateScanResult = await runReleaseGateScan({
    targetDir: resolvedTargetDir,
    eyeActive: true
  });

  const inputEnabled = Boolean(process.stdin.isTTY);
  const renderDashboard = () =>
    React.createElement(Dashboard, {
      result: currentResult,
      inputEnabled,
      onPatchApplied: async () => {
        currentResult = await runReleaseGateScan({
          targetDir: resolvedTargetDir,
          eyeActive: true
        });
        app.rerender(renderDashboard());
      }
    });

  const app = render(renderDashboard());
  const watcher = startWatcher(resolvedTargetDir, {
    onBatch: async (changedFiles) => {
      currentResult = await runReleaseGateScan({
        targetDir: resolvedTargetDir,
        eyeActive: true,
        changedFiles
      });
      app.rerender(renderDashboard());
    }
  });

  let isShuttingDown = false;
  const shutdown = async (exitProcess = false) => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;
    await watcher.close();
    app.unmount();
    if (exitProcess) {
      process.exit(0);
    }
  };

  void app.waitUntilExit().then(() => shutdown());
  process.once("SIGINT", () => {
    void shutdown(true);
  });
}

export async function runLegacyScan(targetDir = process.cwd(), options: { fix?: boolean } = {}): Promise<void> {
  const args = [path.resolve(__dirname, "..", "..", "index.js"), "scan", targetDir];
  if (options.fix) {
    args.push("--fix");
  }

  const result = childProcess.spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    process.exitCode = result.status;
  }
}

function buildFixCommand(target: string): string {
  return `preflight fix "${target.replace(/"/g, '\\"')}"`;
}

async function copyTextToClipboard(text: string): Promise<void> {
  const command =
    process.platform === "win32" ? "clip.exe" : process.platform === "darwin" ? "pbcopy" : "xclip";
  const args = process.platform === "linux" ? ["-selection", "clipboard"] : [];
  const child = childProcess.spawn(command, args, {
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true
  });

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Clipboard command exited with code ${code}.`));
    });
    child.stdin.end(text);
  });
}

export async function copyFixCommand(target: string): Promise<string> {
  const fixCommand = buildFixCommand(target);
  await copyTextToClipboard(fixCommand);
  return fixCommand;
}

export async function handlePreFlightUri(rawUri: string): Promise<void> {
  const uri = new URL(rawUri);
  if (uri.protocol !== "preflight:") {
    throw new Error("Unsupported PreFlight URI protocol.");
  }

  if (uri.hostname === "copy-fix") {
    const filePath = uri.searchParams.get("file");
    if (!filePath) {
      throw new Error("Missing file parameter in PreFlight copy-fix URI.");
    }

    const copiedCommand = await copyFixCommand(filePath);
    process.stdout.write(`Copied fix command: ${copiedCommand}\n`);
    return;
  }

  throw new Error(`Unsupported PreFlight URI action: ${uri.hostname}`);
}

async function waitForChildProcess(child: childProcess.ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code && code !== 0) {
        reject(new Error(`PreFlight child process exited with code ${code}.`));
        return;
      }

      if (signal) {
        reject(new Error(`PreFlight child process exited after signal ${signal}.`));
        return;
      }

      resolve();
    });
  });
}

export async function runLegacyMcp(): Promise<void> {
  const child = childProcess.fork(path.resolve(__dirname, "..", "..", "index.js"), ["mcp"], {
    env: process.env,
    stdio: ["inherit", "inherit", "inherit", "ipc"]
  });
  await waitForChildProcess(child);
}

export async function runDaemon(targetDir = process.cwd()): Promise<void> {
  const handle = await startPreFlightDaemon({
    targetDir,
    output: process.stderr
  });
  if (handle.alreadyRunning) {
    process.stderr.write(`PreFlight daemon already running for ${handle.targetDir}\n`);
    process.stderr.write(`WebSocket alerts: ${handle.websocketUrl}\n`);
    return;
  }

  process.stderr.write(`PreFlight daemon running for ${handle.targetDir}\n`);
  process.stderr.write(`IPC socket: ${handle.socketPath}\n`);
  process.stderr.write(`WebSocket alerts: ${handle.websocketUrl}\n`);

  let closing = false;
  const close = async () => {
    if (closing) {
      return;
    }

    closing = true;
    await handle.close();
  };

  process.once("SIGINT", () => {
    void close().then(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void close().then(() => process.exit(0));
  });

  await new Promise(() => {});
}

export async function runDashboard(targetDir = process.cwd()): Promise<void> {
  const resolvedTargetDir = path.resolve(targetDir);
  const app = render(React.createElement(IpcDashboard, {
    targetDir: resolvedTargetDir,
    socketPath: getPreflightSocketPath(resolvedTargetDir)
  }));
  await app.waitUntilExit();
}

interface McpTarget {
  name: string;
  filePath: string;
}

function resolveMcpCommand(): string {
  return process.platform === "win32" ? "preflight.cmd" : "preflight";
}

function buildMcpServerConfig() {
  return {
    command: resolveMcpCommand(),
    args: ["mcp"],
    env: {
      NODE_ENV: "production"
    }
  };
}

function getClaudeDesktopConfigPath(): string {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }

  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

function getMcpInstallTargets(directory = process.cwd()): McpTarget[] {
  return [
    {
      name: "Cursor global",
      filePath: path.join(os.homedir(), ".cursor", "mcp.json")
    },
    {
      name: "Claude Desktop",
      filePath: getClaudeDesktopConfigPath()
    },
    {
      name: "VS Code workspace",
      filePath: path.join(path.resolve(directory), ".vscode", "mcp.json")
    }
  ];
}

async function readJsonObject(filePath: string): Promise<Record<string, any>> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw.trim()) {
      return {};
    }

    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

async function writeJsonObject(filePath: string, value: Record<string, any>): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function installMcp(directory = process.cwd()): Promise<string[]> {
  const configuredTargets: string[] = [];
  const serverConfig = buildMcpServerConfig();

  for (const target of getMcpInstallTargets(directory)) {
    const config = await readJsonObject(target.filePath);
    const mcpServers = config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
      ? config.mcpServers
      : {};

    config.mcpServers = {
      ...mcpServers,
      "preflight-pro": serverConfig
    };
    await writeJsonObject(target.filePath, config);
    configuredTargets.push(`${target.name}: ${target.filePath}`);
  }

  return configuredTargets;
}

export async function runDemo(baseDir = process.cwd()): Promise<void> {
  const demoDir = await createDemoProject(baseDir);
  process.stdout.write(`PreFlight demo project created at ${demoDir}\n`);
  process.stdout.write("Launching The Eye + Ink release gate...\n");
  await runScan(demoDir);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isFilePath(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function formatFuzzerIssue(finding: ReleaseGateScanResult["fuzzFindings"][number]): string {
  const details = [
    finding.issue,
    `Type: ${finding.type}`,
    `Breaking payload: ${finding.payload}`,
    ...finding.trail.map((step) => `Trail: ${step}`)
  ];

  return details.filter(Boolean).join("\n");
}

async function runReleaseGateFileFix(targetFile: string): Promise<void> {
  const resolvedFile = path.resolve(targetFile);
  const targetDir = path.dirname(resolvedFile);

  const result = await runReleaseGateScan({
    targetDir,
    eyeActive: false,
    changedFiles: [resolvedFile]
  });

  const issueMap = new Map<string, string[]>();
  const addIssue = (filePath: string, issue: string) => {
    const resolvedIssueFile = path.resolve(targetDir, filePath);
    const issues = issueMap.get(resolvedIssueFile) || [];
    issues.push(issue);
    issueMap.set(resolvedIssueFile, issues);
  };

  for (const finding of result.findings) {
    addIssue(finding.file, finding.issue);
  }

  for (const finding of result.fuzzFindings) {
    addIssue(finding.file, formatFuzzerIssue(finding));
  }

  const fileIssues = issueMap.get(resolvedFile) || [];
  if (fileIssues.length === 0) {
    process.stdout.write(`No PreFlight release-gate issues found in ${resolvedFile}\n`);
    return;
  }

  process.stdout.write(`PreFlight found ${fileIssues.length} issue(s) in ${resolvedFile}\n`);
  for (const issue of fileIssues) {
    const firstLine = issue.split(/\r?\n/).find((line) => line.trim()) || issue;
    process.stdout.write(`- ${firstLine}\n`);
  }

  await applyAutoPatch(resolvedFile, fileIssues);
  process.stdout.write(`PreFlight fix applied to ${resolvedFile}\n`);
}

export async function runFix(target = process.cwd()): Promise<void> {
  const resolvedTarget = path.resolve(target);

  if (!(await pathExists(resolvedTarget))) {
    throw new Error(`Fix target does not exist: ${resolvedTarget}`);
  }

  if (await isFilePath(resolvedTarget)) {
    await runReleaseGateFileFix(resolvedTarget);
    return;
  }

  await runLegacyScan(resolvedTarget, { fix: true });
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name("preflight")
    .description("Local-first security gate for AI-generated code.")
    .version(getPackageVersion());

  program
    .command("scan")
    .argument("[dir]", "Directory to scan and watch", process.cwd())
    .option("--fix", "Run the legacy PreFlight scan --fix remediation engine.")
    .description("Run The Eye and mount the interactive PreFlight Ink dashboard.")
    .action(async (dir: string, options: { fix?: boolean }) => {
      if (options.fix) {
        await runLegacyScan(dir, { fix: true });
        return;
      }

      await runScan(dir);
    });

  program
    .command("start")
    .argument("[dir]", "Directory The Eye should watch in the background", process.cwd())
    .description("Register this workspace and start The Eye as a background daemon.")
    .action(async (dir: string) => {
      await runStart(dir);
    });

  program
    .command("wakeup", { hidden: true })
    .description("Restart all registered PreFlight workspace daemons.")
    .action(async () => {
      await runWakeup();
    });

  program
    .command("fix")
    .argument("[target]", "File or directory to remediate", process.cwd())
    .description("Remediate a file through the release-gate pipeline, or a directory through scan --fix.")
    .action(async (target: string) => {
      await runFix(target);
    });

  program
    .command("copy-fix")
    .argument("<target>", "File or directory whose fix command should be copied")
    .description("Copy the matching preflight fix command to the system clipboard.")
    .action(async (target: string) => {
      const copiedCommand = await copyFixCommand(target);
      process.stdout.write(`Copied fix command: ${copiedCommand}\n`);
    });

  program
    .command("handle-uri")
    .argument("<uri>", "PreFlight protocol URI")
    .description("Handle internal preflight:// protocol activation.")
    .action(async (uri: string) => {
      await handlePreFlightUri(uri);
    });

  program
    .command("demo")
    .description("Create a vulnerable playground project and launch the PreFlight Ink dashboard.")
    .action(async () => {
      await runDemo(process.cwd());
    });

  program
    .command("daemon")
    .argument("[dir]", "Directory for the headless daemon to watch", process.cwd())
    .description("Start the headless PreFlight daemon with local IPC broadcasting.")
    .action(async (dir: string) => {
      await runDaemon(dir);
    });

  program
    .command("dashboard")
    .argument("[dir]", "Directory whose daemon socket should be visualized", process.cwd())
    .description("Open the standalone Ink dashboard and connect to the PreFlight daemon.")
    .action(async (dir: string) => {
      await runDashboard(dir);
    });

  program
    .command("mcp")
    .description("Start the PreFlight MCP server over stdio.")
    .action(async () => {
      await runLegacyMcp();
    });

  program
    .command("install-mcp")
    .argument("[dir]", "Workspace directory where .vscode/mcp.json should be updated", process.cwd())
    .description("Configure Cursor, Claude Desktop, and local VS Code MCP configs for PreFlight.")
    .action(async (dir: string) => {
      const targets = await installMcp(dir);
      process.stdout.write(`PreFlight MCP configured:\n${targets.map((target) => `- ${target}`).join("\n")}\n`);
    });

  program
    .command("auth")
    .argument("<key>", "PreFlight Pro license key")
    .description("Validate and save your PreFlight Pro license key locally.")
    .action(async (key: string) => {
      const normalizedKey = key.trim();
      const isValid = await validateLicenseKey(normalizedKey);
      if (!isValid) {
        throw new Error("Invalid PreFlight Pro license key. Please check the key and try again.");
      }

      await saveLicenseKey(normalizedKey);
      process.stdout.write("PreFlight Pro activated. You can now press [P] for Auto-Patch.\n");
    });

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  await createProgram().parseAsync(argv);
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`PreFlight CLI failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
