
const AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";
import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const demoDir = path.join(projectRoot, "demo-live-test");
const configPath = path.join(demoDir, "config.ts");
const rootPolicyPath = path.join(projectRoot, "preflight.config.json");
const rootPolicyBackupPath = path.join(projectRoot, ".preflight.config.json.cli-live-test.bak");
let movedRootPolicy = false;

function resetDemoFixture() {
  fs.rmSync(demoDir, { recursive: true, force: true });
  fs.mkdirSync(demoDir, { recursive: true });
  fs.writeFileSync(configPath, "const aws = \"" + AWS_KEY + "\";\n", "utf8");
}

function runCli(command, options = {}) {
  return new Promise((resolve) => {
    const child = exec(
      command,
      {
        cwd: projectRoot,
        encoding: "utf8",
        windowsHide: true
      },
      (error, stdout, stderr) => {
        resolve({
          code: error?.code ?? 0,
          error,
          stderr,
          stdout
        });
      }
    );

    child.stdin.end(options.input || "");
  });
}

describe("PreFlight CLI live E2E", () => {
  beforeAll(() => {
    if (fs.existsSync(rootPolicyPath)) {
      if (fs.existsSync(rootPolicyBackupPath)) {
        throw new Error(`Refusing to overwrite existing test backup: ${rootPolicyBackupPath}`);
      }
      fs.renameSync(rootPolicyPath, rootPolicyBackupPath);
      movedRootPolicy = true;
    }
    resetDemoFixture();
  });

  afterAll(() => {
    fs.rmSync(demoDir, { recursive: true, force: true });
    if (movedRootPolicy) {
      fs.renameSync(rootPolicyBackupPath, rootPolicyPath);
    }
  });

  test("CLI Dry Run (Detection)", async () => {
    resetDemoFixture();

    const result = await runCli("node index.js scan ./demo-live-test");

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("The Scavenger found 1 issue");
    expect(result.stdout).toContain("AWS Access Key ID");
    expect(result.stdout).toContain("config.ts:1");
  });

  test("CLI God Mode (Mutation)", async () => {
    resetDemoFixture();

    const result = await runCli("node index.js scan ./demo-live-test --fix", {
      input: "y\n"
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Fix applied! Remember to add AWS_ACCESS_KEY_ID to your .env file.");
    expect(result.stdout).toContain("PreFlight remediation attempted 1 fix(es): 1 applied");
    expect(fs.readFileSync(configPath, "utf8")).toBe("const aws = process.env.AWS_ACCESS_KEY_ID;\n");
  });
});
