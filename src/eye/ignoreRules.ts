import path from "node:path";

const DEFAULT_IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".next",
  ".turbo",
  ".cache",
  "__fixtures__",
  "__tests__",
  "coverage",
  "dist",
  "build",
  "demo-live-test",
  "fixtures",
  "node_modules",
  "out",
  "playground",
  "playground-ast-only",
  "real-flow-fixture",
  "test",
  "tests"
]);

const DEFAULT_IGNORED_FILE_NAMES = new Set([
  ".preflight-tripwire.js",
  ".preflight-tripwire.ts"
]);

export function shouldIgnoreWatchPath(candidatePath: string): boolean {
  const normalizedPath = path.normalize(candidatePath);
  const segments = normalizedPath.split(path.sep).filter(Boolean);
  const fileName = path.basename(normalizedPath);

  return (
    segments.some((segment) => DEFAULT_IGNORED_DIRECTORY_NAMES.has(segment)) ||
    DEFAULT_IGNORED_FILE_NAMES.has(fileName) ||
    /\.(?:spec|test)\.[cm]?[jt]sx?$/i.test(fileName) ||
    /^\.preflight-tripwire\./.test(fileName)
  );
}

export { DEFAULT_IGNORED_DIRECTORY_NAMES, DEFAULT_IGNORED_FILE_NAMES };
