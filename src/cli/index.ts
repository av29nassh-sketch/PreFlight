#!/usr/bin/env node
import "dotenv/config";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import React from "react";
import { render } from "ink";
import { startPreFlightDaemon } from "../daemon/engine";
import { getPreflightSocketPath } from "../daemon/protocol";
import { startWatcher } from "../eye/watcher";
import { saveLicenseKey, validateLicenseKey } from "../config/auth";
import type { ReleaseGateScanResult } from "../release-gate/model";
import { runReleaseGateScan } from "../release-gate/pipeline";
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
  process.stderr.write(`PreFlight daemon running for ${handle.targetDir}\n`);
  process.stderr.write(`IPC socket: ${handle.socketPath}\n`);

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

export function createProgram(): Command {
  const program = new Command();

  program
    .name("preflight")
    .description("Local-first security gate for AI-generated code.")
    .version("0.2.5");

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
