
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
const EMPTY_DOTENV_PATH = path.join(projectRoot, ".preflight-cli-live-empty.env");
const ISOLATED_HOME = path.join(projectRoot, ".preflight-cli-live-home");
let movedRootPolicy = false;

function buildIsolatedEnv(overrides = {}) {
  fs.mkdirSync(ISOLATED_HOME, { recursive: true });
  const env = {
    ...process.env,
    DOTENV_CONFIG_PATH: EMPTY_DOTENV_PATH,
    HOME: ISOLATED_HOME,
    USERPROFILE: ISOLATED_HOME,
    ...overrides
  };

  if (!Object.prototype.hasOwnProperty.call(overrides, "PREFLIGHT_PRO_KEY")) {
    delete env.PREFLIGHT_PRO_KEY;
  }
  if (!Object.prototype.hasOwnProperty.call(overrides, "PREFLIGHT_PRO_LICENSE_KEY")) {
    delete env.PREFLIGHT_PRO_LICENSE_KEY;
  }
  if (!Object.prototype.hasOwnProperty.call(overrides, "PREFLIGHT_TEAMS_KEY")) {
    delete env.PREFLIGHT_TEAMS_KEY;
  }

  return env;
}

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
        env: buildIsolatedEnv(options.env),
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
    fs.rmSync(ISOLATED_HOME, { recursive: true, force: true });
    if (movedRootPolicy) {
      fs.renameSync(rootPolicyBackupPath, rootPolicyPath);
    }
  });

  test("CLI Dry Run (Detection)", async () => {
    resetDemoFixture();

    const result = await runCli("node index.js scan ./demo-live-test");

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Tri-State Risk Score");
    expect(result.stdout).toContain("🔴 Hard Block: Secrets, leaked roles, missing RLS.");
    expect(result.stdout).toContain("PreFlight Check found 1 issue");
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

  test("CLI prints the beta license receipt before running auto-fixes", async () => {
    resetDemoFixture();

    const result = await runCli("node index.js scan ./demo-live-test --fix", {
      input: "y\n",
      env: {
        PREFLIGHT_PRO_KEY: "PREFLIGHT-BETA-20260611-TEST"
      }
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("⚠️ Beta License Active — Unlocked Pro Auto-Fixes (Expires 14 days from issue date).");
    expect(result.stdout).toContain("PreFlight remediation attempted 1 fix(es): 1 applied");
  });
});
