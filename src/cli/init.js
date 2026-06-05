const fs = require("node:fs");
const path = require("node:path");

const MANAGED_HOOK_START = "# >>> preflight managed pre-commit hook >>>";
const MANAGED_HOOK_END = "# <<< preflight managed pre-commit hook <<<";
const DEFAULT_ENGINE_COMMAND = "preflight scan-diff --stdin";

function assertRepositoryRoot(repoDir) {
  if (typeof repoDir !== "string" || repoDir.trim() === "") {
    throw new TypeError("installPreCommitHook requires a repository directory.");
  }

  const resolvedRepoDir = path.resolve(repoDir);
  const gitDir = path.join(resolvedRepoDir, ".git");
  if (!fs.existsSync(gitDir)) {
    throw new Error(`No .git directory found at ${resolvedRepoDir}. Run this inside a Git repository.`);
  }

  return resolvedRepoDir;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\"'\"'")}'`;
}

function buildPreCommitHook(options = {}) {
  const engineCommand = options.engineCommand || DEFAULT_ENGINE_COMMAND;
  if (typeof engineCommand !== "string" || engineCommand.trim() === "") {
    throw new TypeError("engineCommand must be a non-empty string.");
  }

  return [
    "#!/bin/sh",
    MANAGED_HOOK_START,
    "set -eu",
    "",
    "if ! command -v git >/dev/null 2>&1; then",
    "  echo \"PreFlight: git executable not found; blocking commit.\" >&2",
    "  exit 1",
    "fi",
    "",
    "if git diff --cached --quiet --exit-code --; then",
    "  exit 0",
    "fi",
    "",
    "tmp_diff=$(mktemp \"${TMPDIR:-/tmp}/preflight-staged.XXXXXX\")",
    "trap 'rm -f \"$tmp_diff\"' EXIT HUP INT TERM",
    "",
    "git diff --cached --no-ext-diff --unified=0 -- > \"$tmp_diff\"",
    `if ! cat "$tmp_diff" | ${engineCommand}; then`,
    "  echo \"PreFlight: commit blocked. Review findings above.\" >&2",
    "  exit 1",
    "fi",
    "",
    "exit 0",
    MANAGED_HOOK_END,
    ""
  ].join("\n");
}

function hasManagedHook(contents) {
  return contents.includes(MANAGED_HOOK_START) && contents.includes(MANAGED_HOOK_END);
}

function replaceManagedHook(contents, nextHook) {
  const start = contents.indexOf(MANAGED_HOOK_START);
  const end = contents.indexOf(MANAGED_HOOK_END);
  if (start === -1 || end === -1 || end < start) {
    return nextHook;
  }

  const before = contents.slice(0, start).trimEnd();
  const after = contents.slice(end + MANAGED_HOOK_END.length).trimStart();
  return [before, nextHook.trimEnd(), after].filter(Boolean).join("\n\n") + "\n";
}

function backupExistingHook(hookPath, contents) {
  if (!contents || hasManagedHook(contents)) {
    return null;
  }

  const backupPath = `${hookPath}.preflight-backup-${Date.now()}`;
  fs.writeFileSync(backupPath, contents, { encoding: "utf8", mode: 0o755 });
  return backupPath;
}

function installPreCommitHook(repoDir = process.cwd(), options = {}) {
  const resolvedRepoDir = assertRepositoryRoot(repoDir);
  const hooksDir = path.join(resolvedRepoDir, ".git", "hooks");
  const hookPath = path.join(hooksDir, "pre-commit");
  const hook = buildPreCommitHook(options);

  fs.mkdirSync(hooksDir, { recursive: true });

  let existing = "";
  try {
    existing = fs.readFileSync(hookPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`Could not read existing pre-commit hook: ${error.message}`);
    }
  }

  const backupPath = backupExistingHook(hookPath, existing);
  const nextContents = hasManagedHook(existing) ? replaceManagedHook(existing, hook) : hook;

  fs.writeFileSync(hookPath, nextContents, { encoding: "utf8", mode: 0o755 });
  try {
    fs.chmodSync(hookPath, 0o755);
  } catch {
    // Windows may ignore POSIX executable bits; Git for Windows still runs hook scripts.
  }

  return {
    backupPath,
    hookPath,
    installed: true
  };
}

module.exports = {
  buildPreCommitHook,
  DEFAULT_ENGINE_COMMAND,
  installPreCommitHook
};
