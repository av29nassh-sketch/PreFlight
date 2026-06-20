#!/usr/bin/env node
import "dotenv/config";
import path from "node:path";
import React from "react";
import { render } from "ink";
import { startWatcher } from "./eye/watcher";
import { runReleaseGateScan } from "./release-gate/pipeline";
import type { ReleaseGateScanResult } from "./release-gate/model";
import { Dashboard } from "./tui/Dashboard";

export async function main(argv = process.argv): Promise<void> {
  const targetDir = path.resolve(process.cwd(), argv[2] ?? ".");
  let currentResult: ReleaseGateScanResult = await runReleaseGateScan({
    targetDir,
    eyeActive: true
  });

  const inputEnabled = Boolean(process.stdin.isTTY);
  const renderDashboard = () =>
    React.createElement(Dashboard, {
      result: currentResult,
      inputEnabled,
      onPatchApplied: async () => {
        currentResult = await runReleaseGateScan({
          targetDir,
          eyeActive: true
        });
        app.rerender(renderDashboard());
      }
    });
  const app = render(renderDashboard());

  const watcher = startWatcher(targetDir, {
    onBatch: async (changedFiles) => {
      currentResult = await runReleaseGateScan({
        targetDir,
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

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`PreFlight release gate failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
