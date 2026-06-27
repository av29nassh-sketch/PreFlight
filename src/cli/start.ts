import childProcess from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type StartupPlatform = NodeJS.Platform;

export interface StartupRegistrationPlan {
  filePath: string;
  content: string;
}

export interface StartupRegistrationOptions {
  platform?: StartupPlatform;
  homeDir?: string;
  command?: string;
}

export interface RunStartOptions {
  homeDir?: string;
  spawnDaemon?: typeof spawnDetachedDaemon;
  setupStartup?: typeof setupUserAutostart;
  watchedPath?: string;
}

export interface RunWakeupOptions {
  watchedPath?: string;
  spawnDaemon?: typeof spawnDetachedDaemon;
}

function getCliEntrypoint(): string {
  return path.resolve(__dirname, "..", "..", "cli.js");
}

function escapeVbsString(value: string): string {
  return value.replace(/"/g, "\"\"");
}

function escapeDesktopExecValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

export function getPreflightConfigDir(homeDir = os.homedir()): string {
  return path.join(homeDir, ".config", "preflight");
}

export function getWatchedWorkspacesPath(homeDir = os.homedir()): string {
  return path.join(getPreflightConfigDir(homeDir), "watched.json");
}

export async function readWatchedWorkspaces(watchedPath = getWatchedWorkspacesPath()): Promise<string[]> {
  try {
    const raw = await fs.readFile(watchedPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

export async function addWatchedWorkspace(
  workspaceDir = process.cwd(),
  watchedPath = getWatchedWorkspacesPath()
): Promise<string[]> {
  const resolvedWorkspace = path.resolve(workspaceDir);
  const existing = await readWatchedWorkspaces(watchedPath);
  const normalized = Array.from(new Set([...existing.map((item) => path.resolve(item)), resolvedWorkspace]));

  await fs.mkdir(path.dirname(watchedPath), { recursive: true });
  await fs.writeFile(watchedPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");

  return normalized;
}

export function getStartupRegistrationPlan(options: StartupRegistrationOptions = {}): StartupRegistrationPlan {
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir();
  const command = options.command || "preflight wakeup";

  if (platform === "win32") {
    return {
      filePath: path.join(
        process.env.APPDATA || path.join(homeDir, "AppData", "Roaming"),
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
        "Startup",
        "PreFlight Wakeup.vbs"
      ),
      content: [
        "Set WshShell = CreateObject(\"WScript.Shell\")",
        `WshShell.Run "cmd.exe /d /s /c ""${escapeVbsString(command)}""", 0, False`,
        ""
      ].join("\r\n")
    };
  }

  if (platform === "darwin") {
    return {
      filePath: path.join(homeDir, "Library", "LaunchAgents", "com.preflight.wakeup.plist"),
      content: [
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
        "<plist version=\"1.0\">",
        "<dict>",
        "  <key>Label</key>",
        "  <string>com.preflight.wakeup</string>",
        "  <key>ProgramArguments</key>",
        "  <array>",
        "    <string>/bin/sh</string>",
        "    <string>-lc</string>",
        `    <string>${command}</string>`,
        "  </array>",
        "  <key>RunAtLoad</key>",
        "  <true/>",
        "</dict>",
        "</plist>",
        ""
      ].join("\n")
    };
  }

  return {
    filePath: path.join(homeDir, ".config", "autostart", "preflight-wakeup.desktop"),
    content: [
      "[Desktop Entry]",
      "Type=Application",
      "Name=PreFlight Wakeup",
      `Exec=sh -lc "${escapeDesktopExecValue(command)}"`,
      "X-GNOME-Autostart-enabled=true",
      ""
    ].join("\n")
  };
}

export async function setupUserAutostart(options: StartupRegistrationOptions = {}): Promise<string> {
  const plan = getStartupRegistrationPlan(options);
  await fs.mkdir(path.dirname(plan.filePath), { recursive: true });
  await fs.writeFile(plan.filePath, plan.content, "utf8");
  return plan.filePath;
}

export function spawnDetachedDaemon(workspaceDir = process.cwd()): childProcess.ChildProcess {
  const resolvedWorkspace = path.resolve(workspaceDir);
  const logDir = getPreflightConfigDir();
  fsSync.mkdirSync(logDir, { recursive: true });
  const logFd = fsSync.openSync(path.join(logDir, "daemon.log"), "a");
  const child = childProcess.spawn(process.execPath, [getCliEntrypoint(), "daemon", "."], {
    cwd: resolvedWorkspace,
    detached: true,
    env: {
      ...process.env,
      PREFLIGHT_DAEMON_WS_PORT: "0"
    },
    stdio: ["ignore", logFd, logFd],
    windowsHide: true
  });
  child.once("error", (error) => {
    process.stderr.write(`PreFlight could not start background daemon: ${error.message}\n`);
  });
  child.unref();
  return child;
}

export async function runStart(workspaceDir = process.cwd(), options: RunStartOptions = {}): Promise<void> {
  const resolvedWorkspace = path.resolve(workspaceDir);

  await fs.mkdir(path.join(resolvedWorkspace, ".vscode"), { recursive: true });
  await addWatchedWorkspace(resolvedWorkspace, options.watchedPath || getWatchedWorkspacesPath(options.homeDir));
  await (options.setupStartup || setupUserAutostart)({ homeDir: options.homeDir });
  (options.spawnDaemon || spawnDetachedDaemon)(resolvedWorkspace);

  process.stdout.write("🚀 PreFlight active. 'The Eye' is now watching this directory in the background.\n");
}

export async function runWakeup(options: RunWakeupOptions = {}): Promise<number> {
  const watchedWorkspaces = await readWatchedWorkspaces(options.watchedPath);
  const spawnDaemon = options.spawnDaemon || spawnDetachedDaemon;
  let spawned = 0;

  for (const workspace of watchedWorkspaces) {
    try {
      await fs.access(workspace);
      spawnDaemon(workspace);
      spawned += 1;
    } catch {
      // Ignore deleted or inaccessible workspaces; the registry is intentionally append-only for now.
    }
  }

  return spawned;
}
