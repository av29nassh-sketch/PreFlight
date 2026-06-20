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
});
