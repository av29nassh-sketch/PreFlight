import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { shouldIgnoreWatchPath } from "../eye/ignoreRules";
import { PreFlightCPG } from "../cpg";
import { PreFlightFuzzer, type FuzzResult } from "./PreFlightFuzzer";

const { parseJavaScript } = require("../../taintTracker");

export interface ReleaseFuzzerFinding {
  type: string;
  severity: "HARD_BLOCK";
  file: string;
  payload: string;
  trail: string[];
  issue: string;
}

const FUZZABLE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);

function isFuzzableSourceFile(filePath: string): boolean {
  return FUZZABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function toDisplayPath(targetDir: string, filePath: string): string {
  return path.relative(targetDir, filePath) || path.basename(filePath);
}

function formatTrail(result: FuzzResult): string[] {
  return result.executionTrail.map((node) => {
    const location = node.line ? `${node.filePath}:${node.line}` : node.filePath;
    const label = node.text ? node.text.replace(/\s+/g, " ").trim() : node.nodeType;
    return `${location} -> ${label}`;
  });
}

async function collectFuzzableFiles(targetDir: string): Promise<string[]> {
  return fg("**/*.{js,jsx,ts,tsx}", {
    absolute: true,
    cwd: targetDir,
    dot: true,
    ignore: ["**/node_modules/**", "**/.git/**", "**/.next/**", "**/dist/**", "**/build/**", "**/.turbo/**", "**/.cache/**"],
    onlyFiles: true
  });
}

export async function runFuzzerScan(targetDir: string): Promise<ReleaseFuzzerFinding[]> {
  const resolvedTargetDir = path.resolve(targetDir);
  const astByFile: Record<string, unknown> = {};
  const sourceByFile: Record<string, string> = {};
  const files = await collectFuzzableFiles(resolvedTargetDir);

  for (const filePath of files) {
    if (shouldIgnoreWatchPath(filePath) || !isFuzzableSourceFile(filePath)) {
      continue;
    }

    try {
      const source = await fs.readFile(filePath, "utf8");
      astByFile[filePath] = await parseJavaScript(source);
      sourceByFile[filePath] = source;
    } catch {
      // Ignore transient files and syntax states while an AI/editor is mid-write.
    }
  }

  if (Object.keys(astByFile).length === 0) {
    return [];
  }

  const cpg = new PreFlightCPG({
    astByFile,
    sourceByFile
  });
  const fuzzer = new PreFlightFuzzer(cpg);

  return fuzzer.fuzzAll().map((result) => ({
    type: result.vulnerabilityType,
    severity: "HARD_BLOCK",
    file: toDisplayPath(resolvedTargetDir, result.sink.filePath),
    payload: result.payload,
    trail: formatTrail(result),
    issue: result.reason
  }));
}
