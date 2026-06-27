import chokidar, { type FSWatcher } from "chokidar";
import fs from "node:fs";
import path from "node:path";
import { DebouncedWatchEventQueue, type WatchEventBatchHandler } from "./eventQueue";
import { shouldIgnoreWatchPath, shouldWatchSourcePath } from "./ignoreRules";

export interface EyeWatcherOptions {
  debounceMs?: number;
  onBatch?: WatchEventBatchHandler;
  output?: NodeJS.WritableStream;
}

export interface EyeWatcherHandle {
  targetDir: string;
  close: () => Promise<void>;
}

function formatRelativeFileList(targetDir: string, filePaths: string[]): string {
  return filePaths
    .map((filePath) => path.relative(targetDir, filePath) || path.basename(filePath))
    .join(", ");
}

function renderEyeLog(fileList: string): string {
  const cyanBold = "\x1b[1m\x1b[36m";
  const yellowBold = "\x1b[1m\x1b[33m";
  const reset = "\x1b[0m";

  return `${cyanBold}👁️  The Eye${reset} detected changes in ${yellowBold}${fileList}${reset}. Triggering PreFlight scan pipeline...\n`;
}

function assertWatchTarget(targetDir: string): void {
  if (!fs.existsSync(targetDir)) {
    throw new Error(`The Eye target directory does not exist: ${targetDir}`);
  }

  const stat = fs.statSync(targetDir);
  if (!stat.isDirectory()) {
    throw new Error(`The Eye target must be a directory: ${targetDir}`);
  }
}

async function runStubbedPreflightPipeline({
  targetDir,
  filePaths,
  output
}: {
  targetDir: string;
  filePaths: string[];
  output: NodeJS.WritableStream;
}): Promise<void> {
  output.write(renderEyeLog(formatRelativeFileList(targetDir, filePaths)));
}

export function startWatcher(targetDir: string, options: EyeWatcherOptions = {}): EyeWatcherHandle {
  const resolvedTargetDir = path.resolve(targetDir);
  const output = options.output ?? process.stdout;

  assertWatchTarget(resolvedTargetDir);

  const eventQueue = new DebouncedWatchEventQueue({
    debounceMs: options.debounceMs ?? 400,
    onFlush: async (filePaths) => {
      if (options.onBatch) {
        await options.onBatch(filePaths);
        return;
      }

      await runStubbedPreflightPipeline({
        targetDir: resolvedTargetDir,
        filePaths,
        output
      });
    }
  });

  const watcher: FSWatcher = chokidar.watch(resolvedTargetDir, {
    awaitWriteFinish: {
      pollInterval: 50,
      stabilityThreshold: 150
    },
    usePolling: process.platform === "win32",
    interval: 300,
    binaryInterval: 1000,
    ignored: (candidatePath, stats) => {
      const resolvedCandidatePath = path.resolve(candidatePath);
      if (resolvedCandidatePath === resolvedTargetDir) {
        return false;
      }

      const relativeCandidatePath = path.relative(resolvedTargetDir, resolvedCandidatePath) || path.basename(resolvedCandidatePath);

      if (!stats || stats.isDirectory()) {
        return shouldIgnoreWatchPath(relativeCandidatePath);
      }

      return !shouldWatchSourcePath(relativeCandidatePath);
    },
    ignoreInitial: true,
    persistent: true
  });

  watcher.on("add", (filePath) => {
    const relativeFilePath = path.relative(resolvedTargetDir, path.resolve(filePath));
    if (!shouldWatchSourcePath(relativeFilePath)) {
      return;
    }

    eventQueue.enqueue(path.resolve(filePath));
    try {
      output.write(`[Watcher] Detected save event on: ${filePath}\n`);
    } catch {
      // Logging must never prevent the daemon from scanning.
    }
  });

  watcher.on("change", (filePath) => {
    const relativeFilePath = path.relative(resolvedTargetDir, path.resolve(filePath));
    if (!shouldWatchSourcePath(relativeFilePath)) {
      return;
    }

    eventQueue.enqueue(path.resolve(filePath));
    try {
      output.write(`[Watcher] Detected save event on: ${filePath}\n`);
    } catch {
      // Logging must never prevent the daemon from scanning.
    }
  });

  watcher.on("error", (error) => {
    output.write(`\x1b[31mThe Eye watcher error:\x1b[0m ${error instanceof Error ? error.message : String(error)}\n`);
  });

  return {
    targetDir: resolvedTargetDir,
    close: async () => {
      eventQueue.dispose();
      await watcher.close();
    }
  };
}
