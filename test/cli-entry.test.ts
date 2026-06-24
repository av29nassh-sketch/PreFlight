import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";

describe("PreFlight CLI entry", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-cli-entry-"));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  test("demo scaffolds a vulnerable Next.js route for the Ink dashboard", async () => {
    const { createDemoProject } = await import("../src/cli/index");
    const demoDir = await createDemoProject(workspaceDir);
    const routeFile = path.join(demoDir, "app", "api", "users", "route.ts");
    const source = await fs.readFile(routeFile, "utf8");

    expect(path.basename(demoDir)).toBe(".preflight-playground");
    expect(source).toContain("req.query.userId");
    expect(source).toContain('"SELECT * FROM users WHERE id = " + userId');
    expect(source).toContain("db.query(sql)");
  });

  test("scan --fix preserves the legacy CLI contract", async () => {
    const targetDir = path.join(workspaceDir, "clean-target");
    const cliPath = path.resolve(__dirname, "..", "cli.js");

    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, "safe.js"), "const safe = true;\n");

    const result = spawnSync(process.execPath, [cliPath, "scan", ".", "--fix"], {
      cwd: targetDir,
      encoding: "utf8",
      timeout: 30000
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("unknown option '--fix'");
  });

  test("start registry stores watched workspaces once with absolute paths", async () => {
    const {
      addWatchedWorkspace,
      readWatchedWorkspaces,
      getWatchedWorkspacesPath
    } = await import("../src/cli/start");
    const homeDir = path.join(workspaceDir, "home");
    const watchedPath = getWatchedWorkspacesPath(homeDir);
    const projectDir = path.join(workspaceDir, "project");

    await fs.mkdir(projectDir, { recursive: true });
    await addWatchedWorkspace(projectDir, watchedPath);
    await addWatchedWorkspace(path.join(projectDir, "."), watchedPath);

    await expect(readWatchedWorkspaces(watchedPath)).resolves.toEqual([path.resolve(projectDir)]);
  });

  test("startup registration writes user-level launch entries without admin privileges", async () => {
    const { getStartupRegistrationPlan } = await import("../src/cli/start");
    const homeDir = path.join(workspaceDir, "home");

    const windowsPlan = getStartupRegistrationPlan({
      platform: "win32",
      homeDir,
      command: "preflight wakeup"
    });
    expect(windowsPlan.filePath).toContain(path.join("Microsoft", "Windows", "Start Menu", "Programs", "Startup"));
    expect(windowsPlan.content).toContain("preflight wakeup");

    const darwinPlan = getStartupRegistrationPlan({
      platform: "darwin",
      homeDir,
      command: "preflight wakeup"
    });
    expect(darwinPlan.filePath).toContain(path.join("Library", "LaunchAgents"));
    expect(darwinPlan.content).toContain("<string>/bin/sh</string>");
    expect(darwinPlan.content).toContain("<string>-lc</string>");
    expect(darwinPlan.content).toContain("<string>preflight wakeup</string>");

    const linuxPlan = getStartupRegistrationPlan({
      platform: "linux",
      homeDir,
      command: "preflight wakeup"
    });
    expect(linuxPlan.filePath).toContain(path.join(".config", "autostart"));
    expect(linuxPlan.content).toContain('Exec=sh -lc "preflight wakeup"');
  });

  test("start registers current workspace and wakeup relaunches registered workspaces", async () => {
    const { getWatchedWorkspacesPath, runStart, runWakeup } = await import("../src/cli/start");
    const homeDir = path.join(workspaceDir, "home");
    const watchedPath = getWatchedWorkspacesPath(homeDir);
    const projectDir = path.join(workspaceDir, "project");
    const spawned: string[] = [];
    const startupFiles: string[] = [];

    await fs.mkdir(projectDir, { recursive: true });

    await runStart(projectDir, {
      homeDir,
      watchedPath,
      spawnDaemon: (workspace) => {
        spawned.push(path.resolve(workspace));
        return {} as any;
      },
      setupStartup: async (options) => {
        startupFiles.push(options.homeDir || "");
        return path.join(options.homeDir || "", "startup");
      }
    });

    expect(spawned).toEqual([path.resolve(projectDir)]);
    expect(startupFiles).toEqual([homeDir]);
    await expect(fs.stat(path.join(projectDir, ".vscode"))).resolves.toMatchObject({ isDirectory: expect.any(Function) });

    spawned.length = 0;
    await expect(runWakeup({
      watchedPath,
      spawnDaemon: (workspace) => {
        spawned.push(path.resolve(workspace));
        return {} as any;
      }
    })).resolves.toBe(1);
    expect(spawned).toEqual([path.resolve(projectDir)]);
  });
});
