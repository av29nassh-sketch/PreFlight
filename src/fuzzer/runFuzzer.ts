import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { shouldIgnoreWatchPath } from "../eye/ignoreRules";
import { PreFlightCPG, type TreeSitterInput } from "../cpg";
import { PreFlightFuzzer, type FuzzResult } from "./PreFlightFuzzer";

const { parseSourceCode } = require("../../taintTracker");

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

function normalizeFuzzableFiles(targetDir: string, candidateFiles?: string[]): string[] | null {
  if (!candidateFiles || candidateFiles.length === 0) {
    return null;
  }

  const isInsideTargetDir = (filePath: string) => {
    const relativePath = path.relative(targetDir, filePath);
    return Boolean(relativePath) && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
  };

  return Array.from(
    new Set(
      candidateFiles
        .map((filePath) => (path.isAbsolute(filePath) ? filePath : path.resolve(targetDir, filePath)))
        .filter((filePath) => isInsideTargetDir(filePath))
    )
  );
}

export async function runFuzzerScan(targetDir: string, candidateFiles?: string[]): Promise<ReleaseFuzzerFinding[]> {
  const resolvedTargetDir = path.resolve(targetDir);
  const astByFile: Record<string, TreeSitterInput> = {};
  const sourceByFile: Record<string, string> = {};
  const files = normalizeFuzzableFiles(resolvedTargetDir, candidateFiles) ?? (await collectFuzzableFiles(resolvedTargetDir));

  for (const filePath of files) {
    if (shouldIgnoreWatchPath(filePath) || !isFuzzableSourceFile(filePath)) {
      continue;
    }

    try {
      const source = await fs.readFile(filePath, "utf8");
      astByFile[filePath] = await parseSourceCode(source, filePath);
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
