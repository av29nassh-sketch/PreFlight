import path from "node:path";

const DEFAULT_IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  "dist",
  "build",
  "node_modules",
  "out"
]);

export function shouldIgnoreWatchPath(candidatePath: string): boolean {
  const normalizedPath = path.normalize(candidatePath);
  const segments = normalizedPath.split(path.sep).filter(Boolean);

  return segments.some((segment) => DEFAULT_IGNORED_DIRECTORY_NAMES.has(segment));
}

export { DEFAULT_IGNORED_DIRECTORY_NAMES };
