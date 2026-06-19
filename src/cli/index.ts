#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import React from "react";
import { render } from "ink";
import { startWatcher } from "../eye/watcher";
import { saveLicenseKey, validateLicenseKey } from "../config/auth";
import type { ReleaseGateScanResult } from "../release-gate/model";
import { runReleaseGateScan } from "../release-gate/pipeline";
import { Dashboard } from "../tui/Dashboard";

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
    .description("Run The Eye and mount the interactive PreFlight Ink dashboard.")
    .action(async (dir: string) => {
      await runScan(dir);
    });

  program
    .command("demo")
    .description("Create a vulnerable playground project and launch the PreFlight Ink dashboard.")
    .action(async () => {
      await runDemo(process.cwd());
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
