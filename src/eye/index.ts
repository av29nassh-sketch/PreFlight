#!/usr/bin/env node
import path from "node:path";
import { startWatcher } from "./watcher";

const targetArg = process.argv[2] ?? ".";
const targetDir = path.resolve(process.cwd(), targetArg);

const watcher = startWatcher(targetDir);

process.stdout.write(`\x1b[1m\x1b[36m👁️  The Eye is watching:\x1b[0m ${watcher.targetDir}\n`);
process.stdout.write("Modify or add a file to trigger the stubbed PreFlight scan pipeline. Press Ctrl+C to stop.\n");

process.on("SIGINT", () => {
  void watcher.close().then(() => {
    process.stdout.write("\nThe Eye stopped.\n");
    process.exit(0);
  });
});
