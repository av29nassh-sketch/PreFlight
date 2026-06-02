const fs = require("node:fs");
const { execFileSync, spawnSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

const roots = [];

function makeProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scavenger-"));
  roots.push(root);

  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, contents);
  }

  return root;
}

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runNode(args, cwd, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    input: options.input
  });
}

function makeGitProject(files) {
  const root = makeProject(files);
  run("git", ["init", "-b", "main"], root);
  run("git", ["config", "user.email", "test@preflight.local"], root);
  run("git", ["config", "user.name", "PreFlight Test"], root);
  run("git", ["add", "."], root);
  run("git", ["commit", "-m", "initial"], root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop(), { recursive: true, force: true });
  }
});

describe("The Scavenger", () => {
  test("flags Stripe secret literals in app client components with file and line", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "app/dashboard/page.tsx": [
        "\"use client\";",
        "",
        "export default function Dashboard() {",
        "  const key = \"sk_live_1234567890abcdef\";",
        "  return <main>{key}</main>;",
        "}"
      ].join("\n")
    });

    const findings = await scanProject(root);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "frontend-secret",
          filePath: path.join(root, "app/dashboard/page.tsx"),
          line: 4
        })
      ])
    );
  });

  test("flags Supabase service role environment references in pages components", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "pages/index.tsx": [
        "export default function Home() {",
        "  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;",
        "  return <main>{serviceRole}</main>;",
        "}"
      ].join("\n")
    });

    const findings = await scanProject(root);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "frontend-secret",
          filePath: path.join(root, "pages/index.tsx"),
          line: 2
        })
      ])
    );
  });

  test("does not scan app server components for frontend secrets", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "app/page.tsx": [
        "export default async function Page() {",
        "  const key = \"sk_test_server_only\";",
        "  return <main />;",
        "}"
      ].join("\n")
    });

    const findings = await scanProject(root);

    expect(findings.filter((finding) => finding.ruleId === "frontend-secret")).toHaveLength(0);
  });

  test("scans standalone source directories without flagging harmless live-like identifiers", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "safe-code.js": "const task_live_status = \"active\";\n",
      "dangerous-code.js": "const stripe_key = \"sk_live_987654321\";\n"
    });

    const findings = await scanProject(root);
    const secretFindings = findings.filter((finding) => finding.ruleId === "frontend-secret");

    expect(secretFindings).toHaveLength(1);
    expect(secretFindings[0]).toEqual(
      expect.objectContaining({
        filePath: path.join(root, "dangerous-code.js"),
        line: 1
      })
    );
    expect(secretFindings.some((finding) => finding.filePath.endsWith("safe-code.js"))).toBe(false);
  });

  test("flags backend database URLs in standalone source directories", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "safe-code.js": "const task_live_status = \"active\";\n",
      "backend-leak.js": "const db = \"postgresql://admin:password123@localhost:5432/db\";\n"
    });

    const findings = await scanProject(root);
    const backendFindings = findings.filter((finding) => finding.ruleId === "backend-secret");

    expect(backendFindings).toHaveLength(1);
    expect(backendFindings[0]).toEqual(
      expect.objectContaining({
        filePath: path.join(root, "backend-leak.js"),
        line: 1
      })
    );
    expect(findings.some((finding) => finding.filePath.endsWith("safe-code.js"))).toBe(false);
  });

  test("flags hardcoded JWT secrets in API route jwt calls but ignores process env secrets", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "app/api/token/route.js": [
        "import jwt from \"jsonwebtoken\";",
        "export function GET() {",
        "  jwt.sign({ sub: \"1\" }, \"hardcoded-jwt-secret\");",
        "  jwt.verify(\"token\", process.env.JWT_SECRET);",
        "}"
      ].join("\n")
    });

    const findings = await scanProject(root);
    const backendFindings = findings.filter((finding) => finding.ruleId === "backend-secret");

    expect(backendFindings).toHaveLength(1);
    expect(backendFindings[0]).toEqual(
      expect.objectContaining({
        filePath: path.join(root, "app/api/token/route.js"),
        line: 3,
        evidence: "jwt.sign hardcoded secret"
      })
    );
  });

  test("flags public tables created without RLS being enabled", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "supabase/migrations/20260602000000_create_profiles.sql": [
        "create table public.profiles (",
        "  id uuid primary key,",
        "  email text not null",
        ");"
      ].join("\n")
    });

    const findings = await scanProject(root);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "missing-rls",
          filePath: path.join(root, "supabase/migrations/20260602000000_create_profiles.sql"),
          line: 1,
          tableName: "public.profiles"
        })
      ])
    );
  });

  test("accepts tables when the same migration enables RLS", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "supabase/migrations/20260602000001_create_profiles.sql": [
        "create table public.profiles (",
        "  id uuid primary key",
        ");",
        "alter table public.profiles enable row level security;",
        "create policy \"owners can read\" on public.profiles for select to authenticated using ((select auth.uid()) = id);"
      ].join("\n")
    });

    const findings = await scanProject(root);

    expect(findings.filter((finding) => finding.ruleId === "missing-rls")).toHaveLength(0);
  });

  test("renders a terminal-friendly report", () => {
    const { renderReport } = require("../index");

    const report = renderReport([
      {
        ruleId: "frontend-secret",
        severity: "critical",
        filePath: "/repo/app/page.tsx",
        line: 3,
        message: "Potential secret exposed in a client component."
      }
    ], { color: false });

    expect(report).toContain("The Scavenger found 1 issue");
    expect(report).toContain("/repo/app/page.tsx:3");
    expect(report).toContain("frontend-secret");
  });

  test("uses a cached license key when Lemon Squeezy validates it", async () => {
    const { ensureLicenseVerified } = require("../index");
    const homeDir = makeProject({
      ".preflight-config.json": JSON.stringify({ licenseKey: "cached-key" })
    });

    const result = await ensureLicenseVerified({
      homeDir,
      promptForLicenseKey: async () => {
        throw new Error("prompt should not run");
      },
      validateLicenseKey: async (key) => ({ valid: key === "cached-key" })
    });

    expect(result).toEqual({ valid: true, source: "config" });
  });

  test("prompts for a license, validates it, and saves it when no valid cached key exists", async () => {
    const { ensureLicenseVerified } = require("../index");
    const homeDir = makeProject({});

    const result = await ensureLicenseVerified({
      homeDir,
      promptForLicenseKey: async () => "fresh-key",
      validateLicenseKey: async (key) => ({ valid: key === "fresh-key" })
    });

    expect(result).toEqual({ valid: true, source: "prompt" });
    expect(JSON.parse(fs.readFileSync(path.join(homeDir, ".preflight-config.json"), "utf8"))).toMatchObject({
      licenseKey: "fresh-key"
    });
  });

  test("throws an invalid license error when the entered key fails validation", async () => {
    const { InvalidLicenseKeyError, ensureLicenseVerified } = require("../index");
    const homeDir = makeProject({});

    await expect(
      ensureLicenseVerified({
        homeDir,
        promptForLicenseKey: async () => "bad-key",
        validateLicenseKey: async () => ({ valid: false })
      })
    ).rejects.toBeInstanceOf(InvalidLicenseKeyError);

    expect(fs.existsSync(path.join(homeDir, ".preflight-config.json"))).toBe(false);
  });

  test("validates license keys with the Lemon Squeezy form-encoded request shape", async () => {
    const { validateLicenseKey } = require("../index");

    const result = await validateLicenseKey("abc 123", async (request) => {
      expect(request.url).toBe("https://api.lemonsqueezy.com/v1/licenses/validate");
      expect(request.headers).toMatchObject({
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      });
      expect(request.body).toBe("license_key=abc+123");
      return { valid: true };
    });

    expect(result).toEqual({ valid: true });
  });

  test("scan command runs free without prompting for a license key", () => {
    const root = makeProject({
      "safe-code.js": "const task_live_status = \"active\";\n"
    });

    const result = runNode([path.join(__dirname, "..", "index.js"), "scan", root, "--no-color"], root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("The Scavenger found 0 issues.");
    expect(result.stdout).not.toContain("Please enter your PreFlight license key");
    expect(result.stderr).not.toContain("Invalid License Key");
  });

  test("scan command writes SARIF v2.1.0 when a leak is detected", () => {
    const root = makeProject({
      "dangerous-code.js": "const stripe_key = \"sk_live_987654321\";\n"
    });

    const result = runNode([path.join(__dirname, "..", "index.js"), "scan", root, "--format=sarif"], root);
    const sarifPath = path.join(root, "preflight-report.sarif");
    const sarif = JSON.parse(fs.readFileSync(sarifPath, "utf8"));

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("The Scavenger found");
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].tool.driver.rules.map((rule) => rule.id).sort()).toEqual([
      "backend-secret",
      "frontend-secret",
      "missing-rls"
    ]);
    expect(sarif.runs[0].tool.driver.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "frontend-secret",
          defaultConfiguration: expect.objectContaining({
            level: "error"
          })
        })
      ])
    );
    expect(sarif.runs[0].results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "frontend-secret",
          level: "error",
          locations: expect.arrayContaining([
            expect.objectContaining({
              physicalLocation: expect.objectContaining({
                artifactLocation: expect.objectContaining({
                  uri: "dangerous-code.js"
                }),
                region: expect.objectContaining({
                  startLine: 1
                })
              })
            })
          ])
        })
      ])
    );
  });

  test("preflight config ignoreRules suppresses disabled vulnerability rules", async () => {
    const { loadPreflightPolicy, scanProject } = require("../index");
    const root = makeProject({
      "preflight.config.json": JSON.stringify({ ignoreRules: ["frontend-secret"] }),
      "dangerous-code.js": "const stripe_key = \"sk_live_987654321\";\n"
    });

    const policy = await loadPreflightPolicy(root);
    const findings = await scanProject(root, { policy });

    expect(policy.ignoreRules).toContain("frontend-secret");
    expect(findings.some((finding) => finding.ruleId === "frontend-secret")).toBe(false);
  });

  test("preflight config ignorePaths suppresses matching files", async () => {
    const { loadPreflightPolicy, scanProject } = require("../index");
    const root = makeProject({
      "preflight.config.json": JSON.stringify({ ignorePaths: ["tests/"] }),
      "tests/dangerous-code.js": "const stripe_key = \"sk_live_987654321\";\n",
      "app/api/leak/route.js": "export function GET() { return \"postgresql://admin:password123@localhost:5432/db\"; }\n"
    });

    const policy = await loadPreflightPolicy(root);
    const findings = await scanProject(root, { policy });

    expect(findings.some((finding) => finding.filePath.endsWith("tests/dangerous-code.js"))).toBe(false);
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "backend-secret",
          filePath: path.join(root, "app/api/leak/route.js")
        })
      ])
    );
  });

  test("preflight config is loaded from process cwd by default", async () => {
    const { loadPreflightPolicy } = require("../index");
    const root = makeProject({
      "preflight.config.json": JSON.stringify({ ignoreRules: ["backend-secret"] })
    });
    const previousCwd = process.cwd();

    try {
      process.chdir(root);
      const policy = await loadPreflightPolicy();
      expect(policy.ignoreRules).toContain("backend-secret");
    } finally {
      process.chdir(previousCwd);
    }
  });

  test("ignorePaths matches Windows-style paths against slashless config entries", () => {
    const { isIgnoredPath, normalizePolicy } = require("../index");
    const policy = normalizePolicy({ ignorePaths: ["tests"] });

    expect(isIgnoredPath("C:\\repo\\tests\\backend-leak.js", policy)).toBe(true);
    expect(isIgnoredPath("tests\\backend-leak.js", policy)).toBe(true);
    expect(isIgnoredPath("src\\backend-leak.js", policy)).toBe(false);
  });

  test("invalid preflight config warns and is ignored", async () => {
    const { loadPreflightPolicy } = require("../index");
    const root = makeProject({
      "preflight.config.json": "{ bad json"
    });
    const warnings = [];

    const policy = await loadPreflightPolicy(root, {
      warn: (message) => warnings.push(message)
    });

    expect(policy.ignorePaths).toEqual([]);
    expect([...policy.ignoreRules]).toEqual([]);
    expect(warnings).toContain("Warning: preflight.config.json contains invalid JSON and was ignored.");
  });

  test("scan command loads preflight config from process cwd", () => {
    const scanRoot = makeProject({
      "dangerous-code.js": "const stripe_key = \"sk_live_987654321\";\n"
    });
    const commandCwd = makeProject({
      "preflight.config.json": JSON.stringify({ ignoreRules: ["frontend-secret"] })
    });

    const result = runNode([path.join(__dirname, "..", "index.js"), "scan", scanRoot, "--no-color"], commandCwd);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("The Scavenger found 0 issues.");
  });

  test("scan command warns and ignores invalid preflight config JSON", () => {
    const commandCwd = makeProject({
      "preflight.config.json": "{ bad json",
      "safe-code.js": "const task_live_status = \"active\";\n"
    });

    const result = runNode([path.join(__dirname, "..", "index.js"), "scan", commandCwd, "--no-color"], commandCwd);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Warning: preflight.config.json contains invalid JSON and was ignored.");
    expect(result.stdout).toContain("The Scavenger found 0 issues.");
  });

  test("diff scan only scans changed source and sql files", async () => {
    const { getChangedScanFiles, scanProjectDiff } = require("../index");
    const root = makeGitProject({
      "app/page.js": [
        "\"use client\";",
        "export default function Page() {",
        "  return \"safe\";",
        "}"
      ].join("\n"),
      "notes.md": "ignore me\n"
    });

    fs.mkdirSync(path.join(root, "app/api/leak"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "app/api/leak/route.js"),
      "export function GET() { return \"postgresql://admin:password123@localhost:5432/db\"; }\n"
    );
    fs.writeFileSync(path.join(root, "notes.md"), "changed but ignored\n");
    fs.writeFileSync(path.join(root, "scratch.txt"), "untracked but ignored\n");
    fs.writeFileSync(path.join(root, "supabase.sql"), "create table public.todos (id uuid primary key);\n");
    fs.mkdirSync(path.join(root, "tests"), { recursive: true });
    fs.writeFileSync(path.join(root, "tests/safe-code.js"), "const task_live_status = \"active\";\n");
    fs.writeFileSync(path.join(root, "tests/dangerous-code.js"), "const stripe_key = \"sk_live_987654321\";\n");

    const changedFiles = await getChangedScanFiles(root);
    const findings = await scanProjectDiff(root);

    expect(changedFiles.map((file) => file.relativePath).sort()).toEqual([
      "app/api/leak/route.js",
      "supabase.sql",
      "tests/dangerous-code.js",
      "tests/safe-code.js"
    ]);
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "backend-secret",
          filePath: path.join(root, "app/api/leak/route.js")
        }),
        expect.objectContaining({
          ruleId: "missing-rls",
          filePath: path.join(root, "supabase.sql")
        }),
        expect.objectContaining({
          ruleId: "frontend-secret",
          filePath: path.join(root, "tests/dangerous-code.js")
        })
      ])
    );
    expect(findings.some((finding) => finding.filePath.endsWith("notes.md"))).toBe(false);
    expect(findings.some((finding) => finding.filePath.endsWith("safe-code.js"))).toBe(false);

    const cli = runNode([path.join(__dirname, "..", "index.js"), "scan", root, "--diff", "--json"], root);
    const cliFindings = JSON.parse(cli.stdout);
    expect(cli.status).toBe(1);
    expect(cliFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filePath: path.join(root, "tests/dangerous-code.js")
        })
      ])
    );
  });

  test("apply-fix is license-gated before it applies a patch", () => {
    const root = makeGitProject({
      "message.txt": "old\n",
      "package.json": JSON.stringify({ scripts: { build: "node build-check.js" } }),
      "build-check.js": "process.exit(0);\n",
      "fix.patch": [
        "diff --git a/message.txt b/message.txt",
        "--- a/message.txt",
        "+++ b/message.txt",
        "@@ -1 +1 @@",
        "-old",
        "+fixed",
        ""
      ].join("\n")
    });

    const result = runNode(
      [path.join(__dirname, "..", "index.js"), "apply-fix", path.join(root, "fix.patch"), root],
      root,
      { input: "\n" }
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Please buy PreFlight Repair Queue");
    expect(result.stderr).toContain("Invalid License Key");
    expect(fs.readFileSync(path.join(root, "message.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("old\n");
  });

  test("applies a patch on a temporary branch and merges it when the build passes", async () => {
    const { applyFixWithRollback } = require("../index");
    const root = makeGitProject({
      "message.txt": "old\n",
      "package.json": JSON.stringify({ scripts: { build: "node build-check.js" } }),
      "build-check.js": "process.exit(0);\n",
      "fix.patch": [
        "diff --git a/message.txt b/message.txt",
        "--- a/message.txt",
        "+++ b/message.txt",
        "@@ -1 +1 @@",
        "-old",
        "+fixed",
        ""
      ].join("\n")
    });

    const result = await applyFixWithRollback({
      rootDir: root,
      patchFile: path.join(root, "fix.patch"),
      branchName: "preflight-temp-fix"
    });

    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(root, "message.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("fixed\n");
    expect(run("git", ["rev-parse", "--abbrev-ref", "HEAD"], root).trim()).toBe("main");
    expect(() => run("git", ["rev-parse", "--verify", "preflight-temp-fix"], root)).toThrow();
  });

  test("runs git reset hard and restores the base branch when the build fails", async () => {
    const { applyFixWithRollback } = require("../index");
    const root = makeGitProject({
      "message.txt": "old\n",
      "package.json": JSON.stringify({ scripts: { build: "node build-check.js" } }),
      "build-check.js": [
        "const fs = require('node:fs');",
        "const text = fs.readFileSync('message.txt', 'utf8');",
        "process.exit(text.includes('broken') ? 1 : 0);",
        ""
      ].join("\n"),
      "fix.patch": [
        "diff --git a/message.txt b/message.txt",
        "--- a/message.txt",
        "+++ b/message.txt",
        "@@ -1 +1 @@",
        "-old",
        "+broken",
        ""
      ].join("\n")
    });

    const result = await applyFixWithRollback({
      rootDir: root,
      patchFile: path.join(root, "fix.patch"),
      branchName: "preflight-temp-fix"
    });

    expect(result.success).toBe(false);
    expect(fs.readFileSync(path.join(root, "message.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("old\n");
    expect(run("git", ["rev-parse", "--abbrev-ref", "HEAD"], root).trim()).toBe("main");
    expect(() => run("git", ["rev-parse", "--verify", "preflight-temp-fix"], root)).toThrow();
  });
});
