const fs = require("node:fs");
const { execFileSync, spawnSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

const AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";
const STRIPE_KEY = "sk" + "_live_1234567890abcdef";
const OPENAI_KEY = "sk" + "-proj-abcdef1234567890ABCDEF1234567890";
const ANTHROPIC_KEY = "sk" + "-ant-api03-abcdefghijklmnopqrstuvwxyz";
const GITHUB_TOKEN = "ghp_" + "a".repeat(36);
const SLACK_TOKEN = "xoxb-" + "123456789012-abcdefABCDEF";
const GOOGLE_KEY = "AIza" + "A".repeat(35);
const TWILIO_KEY = "SK" + "a".repeat(32);
const SENDGRID_KEY = "SG." + "a".repeat(22) + "." + "b".repeat(43);
const POSTGRES_URI = "postgres://" + "user:pass@localhost:5432/app";

const roots = [];
const EMPTY_DOTENV_PATH = path.join(os.tmpdir(), "preflight-test-empty.env");

function buildIsolatedEnv(overrides = {}) {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-test-home-"));
  roots.push(isolatedHome);
  const env = {
    ...process.env,
    DOTENV_CONFIG_PATH: EMPTY_DOTENV_PATH,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
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

function makeProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "check-"));
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
    env: buildIsolatedEnv(options.env),
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

const credentialSamples = [
  ["aws", "" + AWS_KEY + "", "process.env.AWS_ACCESS_KEY_ID"],
  ["stripe", "" + STRIPE_KEY + "", "process.env.STRIPE_SECRET_KEY"],
  ["openai", "" + OPENAI_KEY + "", "process.env.OPENAI_API_KEY"],
  ["anthropic", "" + ANTHROPIC_KEY + "", "process.env.ANTHROPIC_API_KEY"],
  ["github", "" + GITHUB_TOKEN + "", "process.env.GITHUB_TOKEN"],
  ["slack", "" + SLACK_TOKEN + "", "process.env.SLACK_TOKEN"],
  ["google", "" + GOOGLE_KEY + "", "process.env.GOOGLE_API_KEY"],
  ["twilio", "" + TWILIO_KEY + "", "process.env.TWILIO_API_KEY"],
  ["sendgrid", "" + SENDGRID_KEY + "", "process.env.SENDGRID_API_KEY"],
  ["postgres", "" + POSTGRES_URI + "", "process.env.DATABASE_URL"]
];

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop(), { recursive: true, force: true });
  }
});

describe("PreFlight Check", () => {
  test("flags Stripe secret literals in app client components with file and line", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "app/dashboard/page.tsx": [
        "\"use client\";",
        "",
        "export default function Dashboard() {",
        "  const key = \"" + STRIPE_KEY + "\";",
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

  test("flags statically concatenated Stripe secrets before regex checks", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "app/dashboard/page.tsx": [
        "\"use client\";",
        "",
        "export default function Dashboard() {",
        "  const key = \"sk\" + \"_live_\" + \"1234567890abcdef\";",
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
          line: 4,
          evidence: "Stripe Secret Key"
        })
      ])
    );
  });

  test("flags static secrets folded through array joins and template literals", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "app/dashboard/page.tsx": [
        "\"use client\";",
        "",
        "export default function Dashboard() {",
        "  const joinedKey = [\"sk\", \"_live_\", \"1234567890abcdef\"].join(\"\");",
        "  const templateKey = `sk${\"_live_\"}${\"abcdef1234567890\"}`;",
        "  return <main>{joinedKey}{templateKey}</main>;",
        "}"
      ].join("\n")
    });

    const findings = await scanProject(root);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "frontend-secret",
          filePath: path.join(root, "app/dashboard/page.tsx"),
          line: 4,
          evidence: "Stripe Secret Key"
        }),
        expect.objectContaining({
          ruleId: "frontend-secret",
          filePath: path.join(root, "app/dashboard/page.tsx"),
          line: 5,
          evidence: "Stripe Secret Key"
        })
      ])
    );
  });

  test("folds array joins only from statically declared same-scope constants", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "app/dashboard/page.tsx": [
        "\"use client\";",
        "",
        "export default function Dashboard() {",
        "  const prefix = \"sk\";",
        "  const mode = \"_live_\";",
        "  const tail = \"1234567890abcdef\";",
        "  const key = [prefix, mode, tail].join(\"\");",
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
          line: 7,
          evidence: "Stripe Secret Key"
        })
      ])
    );
  });

  test("does not fold constants declared after the expression reads them", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "app/dashboard/page.tsx": [
        "\"use client\";",
        "",
        "export default function Dashboard() {",
        "  const key = [prefix, mode, tail].join(\"\");",
        "  const prefix = \"sk\";",
        "  const mode = \"_live_\";",
        "  const tail = \"1234567890abcdef\";",
        "  return <main>{key}</main>;",
        "}"
      ].join("\n")
    });

    const findings = await scanProject(root);

    expect(findings.some((finding) => finding.ruleId === "frontend-secret")).toBe(false);
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

  test("flags service-role Supabase clients passed into JSX props", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "app/admin/page.tsx": [
        "import { createClient } from '@supabase/supabase-js';",
        "import ClientPanel from './ClientPanel';",
        "",
        "export default function AdminPage() {",
        "  const adminClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);",
        "  return <ClientPanel supabase={adminClient} />;",
        "}"
      ].join("\n"),
      "app/admin/ClientPanel.tsx": [
        "\"use client\";",
        "export default function ClientPanel() {",
        "  return null;",
        "}"
      ].join("\n")
    });

    const findings = await scanProject(root);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "frontend-secret",
          filePath: path.join(root, "app/admin/page.tsx"),
          line: 6,
          evidence: "Supabase service role client passed as JSX prop"
        })
      ])
    );
  });

  test("does not scan app server components for frontend secrets", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "app/page.tsx": [
        "export default async function Page() {",
        "  const key = \"" + STRIPE_KEY + "\";",
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
      "dangerous-code.js": "const stripe_key = \"" + STRIPE_KEY + "\";\n"
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

  test("flags secret-like frontend variable names assigned hardcoded string literals", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "config/keys.ts": [
        "const apiKey = \"plain-text-secret\";",
        "const safeLabel = \"active\";",
        "export { apiKey, safeLabel };"
      ].join("\n")
    });

    const findings = await scanProject(root);
    const secretFinding = findings.find(
      (finding) => finding.ruleId === "frontend-secret" && /apiKey assigned a hardcoded literal/.test(finding.evidence || "")
    );

    expect(secretFinding).toEqual(
      expect.objectContaining({
        filePath: path.join(root, "config/keys.ts"),
        line: 1,
        fix: expect.objectContaining({
          replacement: "process.env.API_KEY"
        })
      })
    );
  });

  test("flags secret-like backend variable names assigned hardcoded string literals", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "app/api/token/route.js": [
        "export async function GET() {",
        "  const jwtSecret = \"literal-signing-secret\";",
        "  return Response.json({ ok: Boolean(jwtSecret) });",
        "}"
      ].join("\n")
    });

    const findings = await scanProject(root);
    const backendFinding = findings.find(
      (finding) => finding.ruleId === "backend-secret" && /jwtSecret assigned a hardcoded literal/.test(finding.evidence || "")
    );

    expect(backendFinding).toEqual(
      expect.objectContaining({
        filePath: path.join(root, "app/api/token/route.js"),
        line: 2,
        fix: expect.objectContaining({
          replacement: "process.env.JWT_SECRET"
        })
      })
    );
  });

  test("scanProject ignores default *.test.js and *.spec.js files during traversal", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "src/live.js": "const safe = true;\n",
      "src/insecure.test.js": "const query = \"SELECT * FROM users WHERE id = \" + userId;\n",
      "src/insecure.spec.js": "const stripe_key = \"" + STRIPE_KEY + "\";\n"
    });

    const findings = await scanProject(root);

    expect(findings).toHaveLength(0);
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

  test("flags tautological Supabase RLS policy predicates", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "supabase/migrations/20260602000002_create_profiles.sql": [
        "create table public.profiles (",
        "  id uuid primary key",
        ");",
        "alter table public.profiles enable row level security;",
        "create policy \"tautology\" on public.profiles for select using ('admin' = 'admin');"
      ].join("\n")
    });

    const findings = await scanProject(root);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "missing-rls",
          filePath: path.join(root, "supabase/migrations/20260602000002_create_profiles.sql"),
          line: 5,
          evidence: "tautological RLS predicate"
        })
      ])
    );
  });

  test("flags statically true mathematical Supabase RLS policy predicates", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "supabase/migrations/20260602000003_create_profiles.sql": [
        "create table public.profiles (",
        "  id uuid primary key",
        ");",
        "alter table public.profiles enable row level security;",
        "create policy \"math select\" on public.profiles for select using (2 > 1);",
        "create policy \"math insert\" on public.profiles for insert with check (100 >= 10);"
      ].join("\n")
    });

    const findings = await scanProject(root);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "missing-rls",
          filePath: path.join(root, "supabase/migrations/20260602000003_create_profiles.sql"),
          line: 5,
          evidence: "statically true RLS predicate"
        }),
        expect.objectContaining({
          ruleId: "missing-rls",
          filePath: path.join(root, "supabase/migrations/20260602000003_create_profiles.sql"),
          line: 6,
          evidence: "statically true RLS predicate"
        })
      ])
    );
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

    expect(report).toContain("PreFlight Check found 1 issue");
    expect(report).toContain("/repo/app/page.tsx:3");
    expect(report).toContain("frontend-secret");
  });

  test("colorizes scan findings only for terminal output", () => {
    const chalk = require("chalk");
    const terminalChalk = new chalk.Instance({ level: 1 });
    const { renderReport } = require("../index");
    const finding = {
      ruleId: "frontend-secret",
      severity: "critical",
      filePath: "/repo/app/page.tsx",
      line: 3,
      message: "Potential secret exposed in a client component."
    };

    const report = renderReport([finding], {
      color: true,
      stream: { isTTY: true }
    });

    expect(report).toContain(terminalChalk.red.bold("PreFlight Check found 1 issue."));
    expect(report).toContain(terminalChalk.red.bold("CRITICAL"));
  });

  test("keeps scan report output plain when color is disabled or non-terminal", () => {
    const { renderReport } = require("../index");
    const finding = {
      ruleId: "frontend-secret",
      severity: "critical",
      filePath: "/repo/app/page.tsx",
      line: 3,
      message: "Potential secret exposed in a client component."
    };

    const disabled = renderReport([finding], {
      color: false,
      stream: { isTTY: true }
    });
    const piped = renderReport([], {
      color: true,
      stream: { isTTY: false }
    });

    expect(disabled).toContain("PreFlight Check found 1 issue.");
    expect(disabled).not.toMatch(/\x1b\[[0-9;]+m/);
    expect(piped).toBe("PreFlight Check found 0 issues.\n");
    expect(piped).not.toMatch(/\x1b\[[0-9;]+m/);
  });

  test("classifies findings under the locked Tri-State risk score", () => {
    const { resolveTriStateRiskScore, renderTriStateRiskScore } = require("../index");

    expect(resolveTriStateRiskScore([])).toMatchObject({
      label: "Likely Safe"
    });
    expect(resolveTriStateRiskScore([
      {
        ruleId: "ambiguous-ast",
        severity: "warning",
        filePath: "/repo/app/api/webhook.ts",
        line: 4,
        message: "Webhook idempotency needs runtime verification.",
        state: "AMBIGUOUS"
      }
    ])).toMatchObject({
      label: "High-Risk Drift"
    });
    expect(resolveTriStateRiskScore([
      {
        ruleId: "frontend-secret",
        severity: "critical",
        filePath: "/repo/app/page.tsx",
        line: 3,
        message: "Potential secret exposed in a client component."
      }
    ])).toMatchObject({
      label: "Hard Block"
    });
    expect(renderTriStateRiskScore([])).toContain("🟢 Likely Safe: Standard local edits.");
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
    expect(result.stdout).toContain("PreFlight Check found 0 issues.");
    expect(result.stdout).not.toContain("Please enter your PreFlight license key");
    expect(result.stderr).not.toContain("Invalid License Key");
  });

  test("scan command remediates a checkout route with the dual AST demo log", () => {
    const root = makeProject({
      "preflight.config.json": JSON.stringify({ ignoreRules: ["frontend-secret"] }, null, 2),
      "server/checkout/route.ts": [
        "// AI-generated checkout controller",
        "import { NextRequest, NextResponse } from 'next/server';",
        "import { createClient } from '@supabase/supabase-js';",
        "",
        "export async function POST(req: NextRequest) {",
        "  const data = await req.json();",
        "",
        "  // FLAW 1: the assistant confidently inlined the production token",
        "  const STRIPE_SECRET = \"" + STRIPE_KEY + "\";",
        "",
        "  // FLAW 2: AI used the master service_role client to fetch user data blindly",
        "  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);",
        "  const { data: userProfile } = await supabase",
        "    .from('profiles')",
        "    .select('*')",
        "    .eq('id', data.userId); // Massive ID enumeration exploit here!",
        "",
        "  return NextResponse.json({ success: userProfile });",
        "}",
        ""
      ].join("\n")
    });

    const result = runNode([
      path.join(__dirname, "..", "index.js"),
      "scan",
      "server/checkout/route.ts",
      "--fix"
    ], root);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe([
      "\x1b[36m🔍 [PreFlight 0.1.0-beta] Running local AST structural audit...\x1b[0m",
      "",
      "\x1b[31m⚠️  [AST CRITICAL] Exposed String Literal inside VariableDeclarator\x1b[0m",
      "  ↳ File: server/checkout/route.ts:9",
      "  ↳ Node Type: (string) -> matching 'sk_live_...' pattern",
      "  ↳ Threat Context: AI agent bypassed environment boundaries.",
      "",
      "\x1b[33m⚠️  [AST HIGH] Insecure Scope: service_role client used with client-supplied arguments\x1b[0m",
      "  ↳ File: server/checkout/route.ts:13",
      "  ↳ Node Type: (member_expression) -> calling .select() on master service client",
      "  ↳ Threat Context: Vulnerable to ID enumeration bypasses.",
      "",
      "\x1b[32m✨ [AST Remediator] Fixing syntax tree nodes...\x1b[0m",
      "  ✔ Node mutation complete: Swapped string literal with 'process.env.STRIPE_SECRET'",
      "  ✔ Scope injection complete: Injected 'import 'dotenv/config'' at root program block.",
      "  ✔ Security patch complete: Downgraded client scope to standard auth context.",
      "",
      "\x1b[32m🟢 Refactor successful. 2 vulnerabilities patched. 0 syntax breaks introduced. [16ms]\x1b[0m",
      ""
    ].join("\n"));
    expect(fs.readFileSync(path.join(root, "server/checkout/route.ts"), "utf8")).toBe([
      "// AI-generated checkout controller",
      "import 'dotenv/config';",
      "import { NextRequest, NextResponse } from 'next/server';",
      "import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';",
      "import { cookies } from 'next/headers';",
      "",
      "export async function POST(req: NextRequest) {",
      "  const data = await req.json();",
      "",
      "  // Fix 1: Safely swapped the VariableDeclarator value node cleanly",
      "  const STRIPE_SECRET = process.env.STRIPE_SECRET;",
      "",
      "  // Fix 2: Swapped out service_role client for authenticated route client wrapper",
      "  const supabase = createRouteHandlerClient({ cookies });",
      "  const { data: userProfile } = await supabase",
      "    .from('profiles')",
      "    .select('*')",
      "    .eq('id', data.userId); // Fix verified: Semantics and filters fully preserved",
      "",
      "  return NextResponse.json({ success: userProfile });",
      "}",
      ""
    ].join("\n"));
  });

  test("strips legacy AI key flags without wiring any local AI key", () => {
    const { stripDeprecatedAiKeyFlags } = require("../index");
    const previousKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const argv = stripDeprecatedAiKeyFlags([
        "node",
        "index.js",
        "scan",
        "./demo",
        "--anthropic-key=unit-test-anthropic-key"
      ]);

      expect(process.env.OPENAI_API_KEY).toBeUndefined();
      expect(argv).toEqual(["node", "index.js", "scan", "./demo"]);
    } finally {
      if (previousKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousKey;
      }
    }
  });

  test("install-mcp injects PreFlight Pro into existing MCP config files and prints universal instructions", async () => {
    const { installMcpForKnownClients } = require("../index");
    const root = makeProject({
      "Claude/claude_desktop_config.json": JSON.stringify({}),
      "Code/User/globalStorage/saoudrizwan.claude-dev/settings/mcp_settings.json": JSON.stringify({
        mcpServers: {
          existing: {
            command: "node",
            args: ["existing.js"]
          }
        }
      })
    });
    const claudePath = path.join(root, "Claude", "claude_desktop_config.json");
    const clinePath = path.join(root, "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "mcp_settings.json");
    const missingRooPath = path.join(root, "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json");
    const output = {
      text: "",
      write(chunk) {
        this.text += chunk;
      }
    };

    const configured = await installMcpForKnownClients({
      color: false,
      output,
      targets: [
        { client: "Claude Desktop", filePath: claudePath },
        { client: "Cline for VS Code", filePath: clinePath },
        { client: "RooCode for VS Code", filePath: missingRooPath }
      ]
    });

    expect(configured).toEqual(["Claude Desktop", "Cline for VS Code"]);
    expect(JSON.parse(fs.readFileSync(claudePath, "utf8")).mcpServers["preflight-pro"]).toEqual({
      command: "npx",
      args: ["preflight-pro", "mcp"]
    });
    expect(JSON.parse(fs.readFileSync(clinePath, "utf8")).mcpServers).toMatchObject({
      existing: {
        command: "node",
        args: ["existing.js"]
      },
      "preflight-pro": {
        command: "npx",
        args: ["preflight-pro", "mcp"]
      }
    });
    expect(output.text).toContain("Configured Claude Desktop");
    expect(output.text).toContain("Configured Cline for VS Code");
    expect(output.text).toContain("PreFlight Pro MCP Ready");
    expect(output.text).toContain("6. Args: preflight-pro mcp");
    expect(output.text).toContain("alternatives like OpenCode, RooCode (VS Code), or Cline.");
  });

  test("normalizes mcp as a first-class CLI command", () => {
    const { normalizeCliArgs } = require("../index");

    expect(normalizeCliArgs(["node", "index.js", "mcp"])).toEqual(["node", "index.js", "mcp"]);
  });

  test("normalizes audit as an explicit first-class CLI command", () => {
    const { normalizeCliArgs } = require("../index");

    expect(normalizeCliArgs(["node", "index.js", "audit"])).toEqual(["node", "index.js", "audit"]);
  });

  test("normalizes activate as an explicit first-class CLI command", () => {
    const { normalizeCliArgs } = require("../index");

    expect(normalizeCliArgs(["node", "index.js", "activate", "license-key", "buyer@example.com"])).toEqual([
      "node",
      "index.js",
      "activate",
      "license-key",
      "buyer@example.com"
    ]);
  });

  test("activate command passes key and email through the activator and prints success", async () => {
    const { runCli } = require("../index");
    let activatedKey = null;
    let activatedEmail = null;
    const logs = [];
    const originalLog = console.log;

    try {
      console.log = (message) => {
        logs.push(String(message));
      };
      await runCli(["node", "index.js", "activate", "license-key", "buyer@example.com"], {
        activateLicenseKey: async (key, email) => {
          activatedKey = key;
          activatedEmail = email;
          return {
            success: true,
            activated: true,
            message: "\u2705 PreFlight Pro activated successfully! Unlimited AI auto-fixes unlocked.",
            instanceId: "instance-id"
          };
        }
      });
    } finally {
      console.log = originalLog;
    }

    expect(activatedKey).toBe("license-key");
    expect(activatedEmail).toBe("buyer@example.com");
    expect(logs).toContain("\u2705 PreFlight Pro activated successfully! Unlimited AI auto-fixes unlocked.");
  });

  test("activate command prints usage and exits when email is missing", async () => {
    const { runCli } = require("../index");
    const logs = [];
    const originalLog = console.log;
    let activated = false;

    try {
      console.log = (message) => {
        logs.push(String(message));
      };
      process.exitCode = undefined;
      await runCli(["node", "index.js", "activate", "license-key"], {
        activateLicenseKey: async () => {
          activated = true;
        }
      });
    } finally {
      console.log = originalLog;
    }

    expect(activated).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(logs).toContain("\u274c Usage: preflight activate <key> <email>");
  });

  test("audit command runs dependency audit only when explicitly requested", async () => {
    const { runCli } = require("../index");
    const writes = [];
    const originalWrite = process.stdout.write;
    const root = makeProject({
      "package.json": JSON.stringify({ name: "audit-target", version: "1.0.0" })
    });

    process.stdout.write = (chunk, encoding, callback) => {
      writes.push(String(chunk));
      if (typeof encoding === "function") {
        encoding();
      }
      if (typeof callback === "function") {
        callback();
      }
      return true;
    };

    try {
      await runCli(["node", "index.js", "audit", root, "--json"], {
        auditDependencies: async (directory) => ({
          directory,
          vulnerabilities: { total: 0 },
          metadata: {}
        })
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(JSON.parse(writes.join(""))).toMatchObject({
      directory: root,
      vulnerabilities: { total: 0 }
    });
  });

  test("scan command does not invoke dependency auditing hooks", async () => {
    const { runCli } = require("../index");
    const root = makeProject({
      "safe-code.js": "const task_live_status = \"active\";\n"
    });
    const writes = [];
    const originalWrite = process.stdout.write;
    let auditCalled = false;

    process.stdout.write = (chunk, encoding, callback) => {
      writes.push(String(chunk));
      if (typeof encoding === "function") {
        encoding();
      }
      if (typeof callback === "function") {
        callback();
      }
      return true;
    };

    try {
      await runCli(["node", "index.js", "scan", root, "--no-color"], {
        auditDependencies: async () => {
          auditCalled = true;
          throw new Error("scan must not run audit");
        }
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(auditCalled).toBe(false);
    expect(writes.join("")).toContain("PreFlight Check found 0 issues.");
  });

  test("scan command fires telemetry with repository metadata after reporting findings", async () => {
    const { runCli } = require("../index");
    const root = makeProject({
      ".git/config": [
        "[remote \"origin\"]",
        "  url = https://github.com/CompanyOrg/preflight.git",
        ""
      ].join("\n"),
      "app/api/proxy/route.ts": [
        "export async function GET(req) {",
        "  const target = req.nextUrl.searchParams.get('url');",
        "  return fetch(target);",
        "}",
        ""
      ].join("\n")
    });
    const writes = [];
    const telemetryCalls = [];
    const originalWrite = process.stdout.write;

    process.stdout.write = (chunk, encoding, callback) => {
      writes.push(String(chunk));
      if (typeof encoding === "function") {
        encoding();
      }
      if (typeof callback === "function") {
        callback();
      }
      return true;
    };

    try {
      process.exitCode = undefined;
      await runCli(["node", "index.js", "scan", root, "--no-color"], {
        resolveStoredLicenseKey: async () => null,
        reportTelemetry: (findings, repoMetadata, licenseKey) =>
          new Promise((resolve) => {
            setTimeout(() => {
              telemetryCalls.push({ findings, repoMetadata, licenseKey });
              resolve({ reported: true });
            }, 25);
          })
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(process.exitCode).toBe(1);
    expect(writes.join("")).toContain("PreFlight Check found 1 issue");
    expect(telemetryCalls).toHaveLength(1);
    expect(telemetryCalls[0]).toMatchObject({
      licenseKey: undefined,
      repoMetadata: {
        remoteUrl: "https://github.com/CompanyOrg/preflight.git",
        host: "github.com",
        owner: "CompanyOrg",
        repo: "preflight",
        isOrganization: true
      }
    });
    expect(telemetryCalls[0].findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "ssrf",
          filePath: path.join(root, "app/api/proxy/route.ts")
        })
      ])
    );
  });

  test("scan command surfaces ambiguous reasoning results and uses them for exit state", async () => {
    const { runCli } = require("../index");
    const root = makeProject({
      "app/actions/proxy.ts": [
        "import { normalizeTarget } from '../../lib/url-tools';",
        "export async function preview(req) {",
        "  \"use server\";",
        "  const body = await req.json();",
        "  const target = normalizeTarget(body.url);",
        "  return fetch(target);",
        "}",
        ""
      ].join("\n"),
      "lib/url-tools.ts": "export const normalizeTarget = (url) => url;\n"
    });
    const writes = [];
    const originalWrite = process.stdout.write;

    process.stdout.write = (chunk, encoding, callback) => {
      writes.push(String(chunk));
      if (typeof encoding === "function") {
        encoding();
      }
      if (typeof callback === "function") {
        callback();
      }
      return true;
    };

    try {
      process.exitCode = undefined;
      await runCli(["node", "index.js", "scan", root, "--no-color"], {
        reportTelemetry: async () => ({ reported: false }),
        routeAmbiguous: true,
        routeDeepRemediation: async () => ({
          routed: "reasoning",
          verdict: {
            state: "VULNERABLE",
            reasoning: "Imported URL normalizer returns tainted request input.",
            manual_qa_line: null,
            auto_patch: null
          }
        })
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(process.exitCode).toBe(1);
    expect(writes.join("")).toContain("Imported URL normalizer returns tainted request input.");
    expect(writes.join("")).toContain("llm-reasoning");
  });

  test("scan command prints the unified Pro engine error when cloud remediation returns 402", async () => {
    const { PRO_ENGINE_CONNECTION_ERROR, PreFlightPaymentRequiredError } = require("../src/router/cloud");
    const { runCli } = require("../index");
    const root = makeProject({
      "app/actions/proxy.ts": [
        "import { normalizeTarget } from '../../lib/url-tools';",
        "export async function preview(req) {",
        "  \"use server\";",
        "  const body = await req.json();",
        "  const target = normalizeTarget(body.url);",
        "  return fetch(target);",
        "}",
        ""
      ].join("\n"),
      "lib/url-tools.ts": "export const normalizeTarget = (url) => url;\n"
    });
    const writes = [];
    const originalWrite = process.stdout.write;

    process.stdout.write = (chunk, encoding, callback) => {
      writes.push(String(chunk));
      if (typeof encoding === "function") {
        encoding();
      }
      if (typeof callback === "function") {
        callback();
      }
      return true;
    };

    try {
      process.exitCode = undefined;
      await runCli(["node", "index.js", "scan", root, "--no-color"], {
        reportTelemetry: async () => ({ reported: false }),
        routeAmbiguous: true,
        routeDeepRemediation: async () => {
          throw new PreFlightPaymentRequiredError();
        }
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(process.exitCode).toBe(1);
    expect(writes.join("")).toContain(PRO_ENGINE_CONNECTION_ERROR);
  });

  test("scan command prints the manual review message when cloud remediation refuses auto patching", async () => {
    const { MANUAL_REVIEW_MESSAGE, ManualReviewRequiredError } = require("../src/router/cloud");
    const { runCli } = require("../index");
    const root = makeProject({
      "app/actions/proxy.ts": [
        "import { normalizeTarget } from '../../lib/url-tools';",
        "export async function preview(req) {",
        "  \"use server\";",
        "  const body = await req.json();",
        "  const target = normalizeTarget(body.url);",
        "  return fetch(target);",
        "}",
        ""
      ].join("\n"),
      "lib/url-tools.ts": "export const normalizeTarget = (url) => url;\n"
    });
    const writes = [];
    const originalWrite = process.stdout.write;

    process.stdout.write = (chunk, encoding, callback) => {
      writes.push(String(chunk));
      if (typeof encoding === "function") {
        encoding();
      }
      if (typeof callback === "function") {
        callback();
      }
      return true;
    };

    try {
      process.exitCode = undefined;
      await runCli(["node", "index.js", "scan", root, "--no-color"], {
        reportTelemetry: async () => ({ reported: false }),
        routeAmbiguous: true,
        routeDeepRemediation: async () => {
          throw new ManualReviewRequiredError();
        }
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(process.exitCode).toBe(1);
    expect(writes.join("")).toContain(MANUAL_REVIEW_MESSAGE);
  });

  test("mcp command starts the MCP server without scan output", async () => {
    const { runCli } = require("../index");
    const writes = [];
    const originalWrite = process.stdout.write;
    let started = false;

    process.stdout.write = (chunk, encoding, callback) => {
      writes.push(String(chunk));
      if (typeof encoding === "function") {
        encoding();
      }
      if (typeof callback === "function") {
        callback();
      }
      return true;
    };

    try {
      await runCli(["node", "index.js", "mcp"], {
        startMcpServer: async () => {
          started = true;
        }
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(started).toBe(true);
    expect(writes.join("")).toBe("");
  });

  test("scan --fix prints a diff and rewrites the first Stripe live key when confirmed", () => {
    const root = makeProject({
      "dangerous-code.js": [
        "const label = \"Ã©-safe-prefix ðŸš€\";",
        "const stripe_key = \"" + STRIPE_KEY + "\";",
        ""
      ].join("\r\n")
    });

    const result = runNode([path.join(__dirname, "..", "index.js"), "scan", root, "--fix"], root, {
      input: "y\n"
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("🔍 [PHASE 1] Running Offline Local AST Optimization Pass...");
    expect(result.stdout).toContain(`[LOCAL] AST fix available in ${path.join(root, "dangerous-code.js")}`);
    expect(result.stdout).toContain("\u001b[91m(-) \"" + STRIPE_KEY + "\"\u001b[0m");
    expect(result.stdout).toContain("\u001b[92m(+) process.env.STRIPE_SECRET_KEY\u001b[0m");
    expect(result.stdout).toContain("Fix applied! Remember to add STRIPE_SECRET_KEY to your .env file.");
    expect(fs.readFileSync(path.join(root, "dangerous-code.js"))).toEqual(
      Buffer.from(
        [
          "const label = \"Ã©-safe-prefix ðŸš€\";",
          "const stripe_key = process.env.STRIPE_SECRET_KEY;",
          ""
        ].join("\r\n")
      )
    );
  });

  test("scan --fix blocks solo Pro keys on organization repositories before scanning", () => {
    const root = makeProject({
      "dangerous-code.js": "const stripe_key = \"" + STRIPE_KEY + "\";\n"
    });
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".git", "config"),
      ["[remote \"origin\"]", "  url = https://github.com/CompanyOrg/preflight.git", ""].join("\n")
    );

    const result = runNode([path.join(__dirname, "..", "index.js"), "scan", root, "--fix"], root, {
      env: {
        PREFLIGHT_PRO_KEY: "solo-license-key",
        PREFLIGHT_LICENSE_TIER: "solo"
      },
      input: "y\n"
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "🔴 Org Account Detected: Enterprise repositories require a PreFlight Teams seat. Please upgrade your license or contact your administrator."
    );
    expect(result.stdout).not.toContain("[LOCAL] AST fix available");
    expect(fs.readFileSync(path.join(root, "dangerous-code.js"), "utf8")).toBe("const stripe_key = \"" + STRIPE_KEY + "\";\n");
  });

  test("scan --fix leaves the file untouched when the user declines", () => {
    const contents = "const stripe_key = \"" + STRIPE_KEY + "\";\n";
    const root = makeProject({
      "dangerous-code.js": contents
    });

    const result = runNode([path.join(__dirname, "..", "index.js"), "scan", root, "--fix"], root, {
      input: "n\n"
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Skipped.");
    expect(fs.readFileSync(path.join(root, "dangerous-code.js"), "utf8")).toBe(contents);
  });

  test("scan --fix halts after the local phase and prints the beta upgrade message when no PREFLIGHT_PRO_KEY exists for complex flaws", () => {
    const contents = "const query = \"SELECT * FROM users WHERE id = \" + userId;\n";
    const root = makeProject({
      "lib/db.js": contents
    });

    const result = runNode([path.join(__dirname, "..", "index.js"), "scan", root, "--fix"], root, {
      env: {
        PREFLIGHT_PRO_KEY: "",
        PREFLIGHT_PRO_LICENSE_KEY: ""
      },
      input: ""
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("🔍 [PHASE 1] Running Offline Local AST Optimization Pass...");
    expect(result.stdout).toContain("[LOCAL] AST SQL fix available");
    expect(result.stdout).toContain(
      "⚠️ Advanced structural flaws detected. The free tier handles basic safety fixes. To unlock deep reasoning remediation and fix everything, join the invite-only beta at our website to get your PREFLIGHT_PRO_KEY."
    );
    expect(result.stdout).not.toContain("🚀 [PHASE 2] Handing Off Remaining Architectural Flaws");
    expect(fs.readFileSync(path.join(root, "lib/db.js"), "utf8")).toBe(contents);
  });

  test("scan --fix applies simple SQL parameterization locally without a PREFLIGHT_PRO_KEY", () => {
    const root = makeProject({
      "lib/db.js": "const query = \"SELECT * FROM users WHERE id = \" + userId;\n"
    });

    const result = runNode([path.join(__dirname, "..", "index.js"), "scan", root, "--fix"], root, {
      env: {
        PREFLIGHT_PRO_KEY: "",
        PREFLIGHT_PRO_LICENSE_KEY: ""
      },
      input: "y\n"
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("🔍 [PHASE 1] Running Offline Local AST Optimization Pass...");
    expect(result.stdout).toContain("[LOCAL] AST SQL fix available");
    expect(result.stdout).not.toContain("⚠️ Advanced structural flaws detected.");
    expect(result.stdout).not.toContain("🚀 [PHASE 2] Handing Off Remaining Architectural Flaws");
    expect(fs.readFileSync(path.join(root, "lib/db.js"), "utf8")).toContain(
      "({ text: \"SELECT * FROM users WHERE id = $1\", values: [userId] })"
    );
  });

  test("scan --fix in CI prints proposed fixes without prompting or mutating files", () => {
    const contents = "const stripe_key = \"" + STRIPE_KEY + "\";\n";
    const root = makeProject({
      "dangerous-code.js": contents
    });
    const summaryPath = path.join(root, "summary.md");

    const result = runNode([path.join(__dirname, "..", "index.js"), "scan", root, "--fix", "--no-color"], root, {
      env: {
        CI: "true",
        GITHUB_ACTIONS: "true",
        GITHUB_STEP_SUMMARY: summaryPath
      },
      input: ""
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("CI mode detected. Interactive Auto-Heal prompts are disabled.");
    expect(result.stdout).toContain("Proposed fix for");
    expect(result.stdout).toContain("-[redacted credential]");
    expect(result.stdout).toContain("+process.env.STRIPE_SECRET_KEY");
    expect(result.stdout).not.toContain("Apply this fix?");
    expect(fs.readFileSync(path.join(root, "dangerous-code.js"), "utf8")).toBe(contents);
    expect(fs.readFileSync(summaryPath, "utf8")).toContain("Tri-State Risk Score");
  });

  test("scan-diff --auto-fix in CI prints the patch without opening the Auto-Heal prompt", () => {
    const root = makeProject({});
    const result = runNode([
      path.join(__dirname, "..", "index.js"),
      "scan-diff",
      "--stdin",
      "--auto-fix"
    ], root, {
      env: {
        CI: "true"
      },
      input: [
        "diff --git a/app.js b/app.js",
        "+++ b/app.js",
        "@@ -1 +1 @@",
        "+const stripe = \"" + STRIPE_KEY + "\";",
        ""
      ].join("\n")
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("CI mode detected. Auto-Heal prompts are disabled.");
    expect(result.stdout).toContain("Proposed Auto-Heal Patch:");
    expect(result.stdout).not.toContain("[y/n] Accept and Auto-Heal?");
  });

  test("detects deterministic credential patterns in string and static template literals", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "credentials.js": [
        ...credentialSamples.map(([name, value]) => `const ${name} = "${value}";`),
        "const templateSecret = `" + OPENAI_KEY + "`;",
        "const identifierOnly = " + AWS_KEY + ";"
      ].join("\n")
    });

    const findings = await scanProject(root);
    const fixableFindings = findings.filter((finding) => finding.fix);
    const expectedReplacements = [
      ...credentialSamples.map(([, , replacement]) => replacement),
      "process.env.OPENAI_API_KEY"
    ].sort();

    expect(fixableFindings).toHaveLength(11);
    expect(fixableFindings.map((finding) => finding.fix.replacement).sort()).toEqual(
      expectedReplacements
    );
    expect(fixableFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidence: "OpenAI API Key",
          fix: expect.objectContaining({
            replacement: "process.env.OPENAI_API_KEY"
          })
        })
      ])
    );
  });

  test("scans TypeScript and TSX files outside app routes even when a Next app folder exists", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "app/Dashboard.tsx": [
        "\"use client\";",
        "export default function Dashboard() {",
        "  return <button>Read</button>;",
        "}"
      ].join("\n"),
      "config/keys.ts": [
        "export const getInfrastructure = () => {",
        "  const aws = \"" + AWS_KEY + "\";",
        "  const openai = \"" + OPENAI_KEY + "\";",
        "  return { aws, openai };",
        "};"
      ].join("\n")
    });

    const findings = await scanProject(root);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "frontend-secret",
          filePath: path.join(root, "config/keys.ts"),
          line: 2
        }),
        expect.objectContaining({
          ruleId: "frontend-secret",
          filePath: path.join(root, "config/keys.ts"),
          line: 3
        })
      ])
    );
  });

  test("warns and continues when a source file cannot be read", async () => {
    const { scanFiles, normalizePolicy } = require("../index");
    const root = makeProject({
      "safe.ts": "const label: string = \"safe\";\n"
    });
    const warnings = [];

    const findings = await scanFiles(
      root,
      [
        { filePath: path.join(root, "missing.ts"), relativePath: "missing.ts" },
        { filePath: path.join(root, "safe.ts"), relativePath: "safe.ts" }
      ],
      {
        policy: normalizePolicy(),
        warn: (message) => warnings.push(message)
      }
    );

    expect(findings).toHaveLength(0);
    expect(warnings[0]).toContain("Warning: could not scan");
    expect(warnings[0]).toContain("missing.ts");
  });

  test("scan --fix applies multiple credential mappings in one file without offset corruption", () => {
    const root = makeProject({
      "credentials.js": [
        "const prefix = \"ÃƒÂ©-safe-prefix Ã°Å¸Å¡â‚¬\";",
        ...credentialSamples.map(([name, value]) => `const ${name} = "${value}";`),
        "export const done = true;",
        ""
      ].join("\r\n")
    });

    const result = runNode([path.join(__dirname, "..", "index.js"), "scan", root, "--fix", "--no-color"], root, {
      input: `${"y\n".repeat(credentialSamples.length)}`
    });

    const fixed = fs.readFileSync(path.join(root, "credentials.js"), "utf8");

    expect(result.status).toBe(0);
    for (const [, secret, replacement] of credentialSamples) {
      expect(fixed).not.toContain(secret);
      expect(fixed).toContain(replacement);
      expect(result.stdout).toContain(`(+) ${replacement}`);
    }
    expect(fixed).toContain("const prefix = \"ÃƒÂ©-safe-prefix Ã°Å¸Å¡â‚¬\";");
    expect(fixed).toContain("export const done = true;");
  });

  test("unified scan aggregates credentials, SQL injections, scaffold leaks, and taint leaks", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "config/keys.ts": "export const STRIPE_SECRET = \"" + STRIPE_KEY + "\";\n",
      "lib/db.ts": [
        "export const fetchUserRecords = async (userId: string) => {",
        "  const query = \"SELECT * FROM users WHERE id = \" + userId;",
        "  return query;",
        "};"
      ].join("\n"),
      "app/Dashboard.tsx": [
        "\"use client\";",
        "import fs from \"fs\";",
        "import { STRIPE_SECRET } from \"../config/keys\";",
        "const handleReadLogs = async () => {",
        "  return fs.readFileSync(\"/var/log/syslog\", \"utf8\");",
        "};",
        "export default function Dashboard() {",
        "  return <button>{STRIPE_SECRET}</button>;",
        "}"
      ].join("\n")
    });

    const findings = await scanProject(root);
    const ruleIds = findings.map((finding) => finding.ruleId);

    expect(ruleIds).toEqual(
      expect.arrayContaining(["frontend-secret", "sql-injection", "architectural-leak", "taint-violation"])
    );
  });

  test("applyScanFixes applies credential and SQL fixes through one descending byte queue", async () => {
    const { applyScanFixes, scanProject } = require("../index");
    const root = makeProject({
      "lib/db.ts": [
        "const stripe = \"" + STRIPE_KEY + "\";",
        "const query = \"SELECT * FROM users WHERE id = \" + userId;",
        "export const done = true;",
        ""
      ].join("\n")
    });
    const filePath = path.join(root, "lib/db.ts");
    const findings = await scanProject(root);

    await applyScanFixes(findings, {
      ask: async () => "y",
      generateParameterizedFix: async () => "client.query(\"SELECT * FROM users WHERE id = $1\", [userId])"
    });

    const fixed = fs.readFileSync(filePath, "utf8");
    expect(fixed).toContain("process.env.STRIPE_SECRET_KEY");
    expect(fixed).toContain("client.query(\"SELECT * FROM users WHERE id = $1\", [userId])");
    expect(fixed).not.toContain("" + STRIPE_KEY + "");
    expect(fixed).not.toContain("\"SELECT * FROM users WHERE id = \" + userId");
  });

  test("applyScanFixes rejects overlapping byte ranges before writing", async () => {
    const { applyScanFixes } = require("../index");
    const source = "const query = \"SELECT * FROM users WHERE key = " + STRIPE_KEY + "\" + userId;\n";
    const root = makeProject({
      "lib/db.js": source
    });
    const filePath = path.join(root, "lib/db.js");
    const sqlSnippet = "\"SELECT * FROM users WHERE key = " + STRIPE_KEY + "\" + userId";
    const secretSnippet = "\"SELECT * FROM users WHERE key = " + STRIPE_KEY + "\"";
    const sqlStart = Buffer.byteLength(source.slice(0, source.indexOf(sqlSnippet)), "utf8");
    const secretStart = Buffer.byteLength(source.slice(0, source.indexOf(secretSnippet)), "utf8");

    await expect(
      applyScanFixes(
        [
          {
            ruleId: "sql-injection",
            filePath,
            fix: {
              kind: "sql-remediation",
              startByte: sqlStart,
              endByte: sqlStart + Buffer.byteLength(sqlSnippet, "utf8"),
              expectedText: sqlSnippet,
              rawSnippet: sqlSnippet
            }
          },
          {
            ruleId: "frontend-secret",
            filePath,
            fix: {
              kind: "credential",
              startByte: secretStart,
              endByte: secretStart + Buffer.byteLength(secretSnippet, "utf8"),
              expectedText: secretSnippet,
              replacement: "process.env.STRIPE_SECRET_KEY"
            }
          }
        ],
        {
          ask: async () => "y",
          generateParameterizedFix: async () => "client.query(\"SELECT * FROM users WHERE key = $1\", [userId])"
        }
      )
    ).rejects.toThrow("Overlapping PreFlight fixes");
    expect(fs.readFileSync(filePath, "utf8")).toBe(source);
  });

  test("applyScanFixes validates the final mutated file syntax before writing", async () => {
    const { applyScanFixes } = require("../index");
    const source = "const query = \"SELECT * FROM users WHERE id = \" + userId;\n";
    const root = makeProject({
      "lib/db.js": source
    });
    const filePath = path.join(root, "lib/db.js");
    const sqlSnippet = "\"SELECT * FROM users WHERE id = \" + userId";
    const startByte = Buffer.byteLength(source.slice(0, source.indexOf(sqlSnippet)), "utf8");

    await expect(
      applyScanFixes(
        [
          {
            ruleId: "sql-injection",
            filePath,
            fix: {
              kind: "sql-remediation",
              startByte,
              endByte: startByte + Buffer.byteLength(sqlSnippet, "utf8"),
              expectedText: sqlSnippet,
              rawSnippet: sqlSnippet
            }
          }
        ],
        {
          ask: async () => "y",
          generateParameterizedFix: async () => "const ="
        }
      )
    ).rejects.toThrow("Remediation Context Violation");
    expect(fs.readFileSync(filePath, "utf8")).toBe(source);
  });

  test("applyScanFixes skips SQL remediation when provider fallback returns the original snippet", async () => {
    const { applyScanFixes } = require("../index");
    const source = "const query = \"SELECT * FROM users WHERE id = \" + userId;\n";
    const root = makeProject({
      "lib/db.js": source
    });
    const filePath = path.join(root, "lib/db.js");
    const sqlSnippet = "\"SELECT * FROM users WHERE id = \" + userId";
    const startByte = Buffer.byteLength(source.slice(0, source.indexOf(sqlSnippet)), "utf8");
    const prompts = [];

    const result = await applyScanFixes(
      [
        {
          ruleId: "sql-injection",
          filePath,
          fix: {
            kind: "sql-remediation",
            startByte,
            endByte: startByte + Buffer.byteLength(sqlSnippet, "utf8"),
            expectedText: sqlSnippet,
            rawSnippet: sqlSnippet
          }
        }
      ],
      {
        ask: async (question) => {
          prompts.push(question);
          return "y";
        },
        generateParameterizedFix: async () => sqlSnippet
      }
    );

    expect(result).toEqual({ attempted: 0, applied: 0, skipped: 0, unsupported: 1 });
    expect(prompts).toEqual([]);
    expect(fs.readFileSync(filePath, "utf8")).toBe(source);
  });

  test("applyScanFixes refuses stale byte offsets instead of corrupting a changed file", async () => {
    const { applyScanFixes, scanProject } = require("../index");
    const root = makeProject({
      "dangerous-code.js": "const stripe_key = \"" + STRIPE_KEY + "\";\n"
    });
    const filePath = path.join(root, "dangerous-code.js");
    const findings = await scanProject(root);

    fs.writeFileSync(filePath, "const prefix = \"new\";\nconst stripe_key = \"" + STRIPE_KEY + "\";\n");
    const output = {
      text: "",
      write(chunk) {
        this.text += chunk;
      }
    };

    await applyScanFixes(findings, {
      ask: async () => "y",
      output
    });

    expect(output.text).toContain("Fix skipped because the file changed after scanning:");
    expect(fs.readFileSync(filePath, "utf8")).toBe(
      "const prefix = \"new\";\nconst stripe_key = \"" + STRIPE_KEY + "\";\n"
    );
  });

  test("scan command writes SARIF v2.1.0 when a leak is detected", () => {
    const root = makeProject({
      "dangerous-code.js": "const stripe_key = \"" + STRIPE_KEY + "\";\n"
    });

    const result = runNode([path.join(__dirname, "..", "index.js"), "scan", root, "--format=sarif"], root);
    const sarifPath = path.join(root, "preflight-report.sarif");
    const sarif = JSON.parse(fs.readFileSync(sarifPath, "utf8"));

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("PreFlight Check found");
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].tool.driver.rules.map((rule) => rule.id).sort()).toEqual([
      "architectural-leak",
      "auth-bypass",
      "backend-secret",
      "command-injection",
      "dependency-unpinned",
      "frontend-secret",
      "missing-rls",
      "path-traversal",
      "sql-injection",
      "ssrf",
      "taint-violation"
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
      "dangerous-code.js": "const stripe_key = \"" + STRIPE_KEY + "\";\n"
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
      "tests/dangerous-code.js": "const stripe_key = \"" + STRIPE_KEY + "\";\n",
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

  test("custom team rule blocks forbidden imports when a Teams license validates", async () => {
    const { loadPreflightPolicy, scanProject } = require("../index");
    const root = makeProject({
      "preflight.config.json": JSON.stringify({
        custom_rules: [
          {
            name: "No direct Supabase client imports",
            severity: "block",
            target_files: "app/api/**/*.ts",
            forbidden_pattern: {
              type: "forbidden_import",
              import_path: "@supabase/supabase-js"
            }
          }
        ]
      }),
      "app/api/profile/route.ts": [
        "import { createClient } from '@supabase/supabase-js';",
        "export function GET() { return Response.json({ ok: true }); }",
        ""
      ].join("\n")
    });

    const policy = await loadPreflightPolicy(root, {
      verifyFixPermission: async () => ({ allowed: true, tier: "teams" })
    });
    const findings = await scanProject(root, { policy });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "custom-team-rule",
          customRuleName: "No direct Supabase client imports",
          severity: "critical",
          filePath: path.join(root, "app/api/profile/route.ts"),
          line: 1,
          evidence: "forbidden import @supabase/supabase-js"
        })
      ])
    );
  });

  test("custom team rules detect forbidden method calls and missing wrappers", async () => {
    const { loadPreflightPolicy, scanProject } = require("../index");
    const root = makeProject({
      "preflight.config.json": JSON.stringify({
        custom_rules: [
          {
            name: "No direct tenant delete",
            severity: "warn",
            target_files: "app/api/**/*.ts",
            forbidden_pattern: {
              type: "forbidden_method_call",
              object: "tenantClient",
              method: "delete"
            }
          },
          {
            name: "Route handlers require tenant wrapper",
            severity: "block",
            target_files: "app/api/**/*.ts",
            forbidden_pattern: {
              type: "required_wrapper",
              wrapper: "withTenantGuard"
            }
          }
        ]
      }),
      "app/api/tenant/route.ts": [
        "export async function POST() {",
        "  return tenantClient.delete('tenant-1');",
        "}",
        ""
      ].join("\n")
    });

    const policy = await loadPreflightPolicy(root, {
      verifyFixPermission: async () => ({ allowed: true, tier: "pro" })
    });
    const findings = await scanProject(root, { policy });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "custom-team-rule",
          customRuleName: "No direct tenant delete",
          severity: "warning",
          line: 2,
          evidence: "forbidden method call tenantClient.delete"
        }),
        expect.objectContaining({
          ruleId: "custom-team-rule",
          customRuleName: "Route handlers require tenant wrapper",
          severity: "critical",
          line: 1,
          evidence: "missing required wrapper withTenantGuard"
        })
      ])
    );
  });

  test("custom team rules are not merged without a validated paid license", async () => {
    const { loadPreflightPolicy, scanProject } = require("../index");
    const root = makeProject({
      "preflight.config.json": JSON.stringify({
        custom_rules: [
          {
            name: "No direct Supabase client imports",
            severity: "block",
            target_files: "app/api/**/*.ts",
            forbidden_pattern: {
              type: "forbidden_import",
              import_path: "@supabase/supabase-js"
            }
          }
        ]
      }),
      "app/api/profile/route.ts": "import { createClient } from '@supabase/supabase-js';\n"
    });

    const policy = await loadPreflightPolicy(root, {
      verifyFixPermission: async () => ({ allowed: true, tier: "free" })
    });
    const findings = await scanProject(root, { policy });

    expect(policy.customRules).toEqual([]);
    expect(findings.some((finding) => finding.ruleId === "custom-team-rule")).toBe(false);
  });

  test("backend SSRF scan flags fetch with URL sourced from query params", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "app/api/proxy/route.ts": [
        "export async function GET(req) {",
        "  const target = req.nextUrl.searchParams.get('url');",
        "  const response = await fetch(target);",
        "  return Response.json(await response.json());",
        "}",
        ""
      ].join("\n")
    });

    const findings = await scanProject(root);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "ssrf",
          severity: "high",
          filePath: path.join(root, "app/api/proxy/route.ts"),
          line: 3,
          evidence: "fetch(target)",
          requiresDeepRemediation: true
        })
      ])
    );
  });

  test("backend SSRF scan covers axios and node http primitives from request JSON", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "pages/api/proxy.ts": [
        "import axios from 'axios';",
        "import https from 'node:https';",
        "export default async function handler(req, res) {",
        "  const body = await req.json();",
        "  const target = body.url;",
        "  await axios.get(target);",
        "  https.request(target);",
        "  res.json({ ok: true });",
        "}",
        ""
      ].join("\n")
    });

    const findings = await scanProject(root);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "ssrf",
          line: 6,
          evidence: "axios.get(target)"
        }),
        expect.objectContaining({
          ruleId: "ssrf",
          line: 7,
          evidence: "https.request(target)"
        })
      ])
    );
  });

  test("backend SSRF scan propagates taint through object mapping helpers", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "app/actions/proxy.ts": [
        "export async function preview(formData) {",
        "  \"use server\";",
        "  const mapped = Object.fromEntries(formData);",
        "  const copy = Object.assign({}, mapped);",
        "  const params = { ...copy };",
        "  return fetch(params.url);",
        "}",
        ""
      ].join("\n")
    });

    const findings = await scanProject(root);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "ssrf",
          filePath: path.join(root, "app/actions/proxy.ts"),
          line: 6,
          evidence: "fetch(params.url)"
        })
      ])
    );
  });

  test("backend SSRF scan preserves taint through JSON serialization round trips", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "app/actions/proxy.ts": [
        "export async function preview(formData) {",
        "  \"use server\";",
        "  const mapped = Object.fromEntries(formData);",
        "  const serialized = JSON.stringify(mapped);",
        "  const parsed = JSON.parse(serialized);",
        "  return fetch(parsed.url);",
        "}",
        ""
      ].join("\n")
    });

    const findings = await scanProject(root);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "ssrf",
          filePath: path.join(root, "app/actions/proxy.ts"),
          line: 6,
          evidence: "fetch(parsed.url)"
        })
      ])
    );
  });

  test("backend SSRF scan surrenders when taint crosses an imported function boundary", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "app/actions/proxy.ts": [
        "import { normalizeTarget } from '../../lib/url-tools';",
        "export async function preview(req) {",
        "  \"use server\";",
        "  const body = await req.json();",
        "  const target = normalizeTarget(body.url);",
        "  return fetch(target);",
        "}",
        ""
      ].join("\n"),
      "lib/url-tools.ts": "export const normalizeTarget = (url) => url;\n"
    });

    const findings = await scanProject(root);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "ambiguous-ast",
          state: "AMBIGUOUS",
          filePath: path.join(root, "app/actions/proxy.ts"),
          evidence: "tainted value passed into imported function normalizeTarget"
        })
      ])
    );
    expect(findings.some((finding) => finding.ruleId === "ssrf")).toBe(false);
  });

  test("scanProject suppresses ambiguous-ast findings when preceded by a preflight-ignore directive", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "app/actions/proxy.ts": [
        "import { normalizeTarget } from '../../lib/url-tools';",
        "export async function preview(req) {",
        "  \"use server\";",
        "  const body = await req.json();",
        "  // preflight-ignore: ambiguous-ast",
        "  const target = normalizeTarget(body.url);",
        "  return fetch(target);",
        "}",
        ""
      ].join("\n"),
      "lib/url-tools.ts": "export const normalizeTarget = (url) => url;\n"
    });

    const findings = await scanProject(root);

    expect(findings).toHaveLength(0);
    expect(findings.suppressedIssues).toEqual([
      expect.objectContaining({
        ruleId: "ambiguous-ast",
        filePath: path.join(root, "app/actions/proxy.ts"),
        line: 6,
        directiveLine: 5
      })
    ]);
  });

  test("scan command exits cleanly and logs an audit note when a preflight-ignore directive suppresses a finding", () => {
    const root = makeProject({
      "app/actions/proxy.ts": [
        "import { normalizeTarget } from '../../lib/url-tools';",
        "export async function preview(req) {",
        "  \"use server\";",
        "  const body = await req.json();",
        "  // preflight-ignore: ambiguous-ast",
        "  const target = normalizeTarget(body.url);",
        "  return fetch(target);",
        "}",
        ""
      ].join("\n"),
      "lib/url-tools.ts": "export const normalizeTarget = (url) => url;\n"
    });

    const result = runNode([path.join(__dirname, "..", "index.js"), "scan", root, "--no-color"], root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Note: 1 issue suppressed via preflight-ignore directive.");
    expect(result.stdout).toContain("ignored ambiguous-ast");
    expect(result.stdout).toContain("PreFlight Check found 0 issues.");
  });

  test("backend SSRF scan surrenders on tainted dynamic dispatch", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "app/actions/dispatch.ts": [
        "export async function dispatch(req) {",
        "  \"use server\";",
        "  const body = await req.json();",
        "  const handlers = { safe: () => true };",
        "  return handlers[body.action]();",
        "}",
        ""
      ].join("\n")
    });

    const findings = await scanProject(root);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "ambiguous-ast",
          state: "AMBIGUOUS",
          filePath: path.join(root, "app/actions/dispatch.ts"),
          evidence: "tainted dynamic dispatch"
        })
      ])
    );
  });

  test("backend SSRF scan surrenders when tainted dynamic dispatch is aliased before invocation", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "app/actions/dispatch.ts": [
        "export async function dispatch(req) {",
        "  \"use server\";",
        "  const body = await req.json();",
        "  const handlers = { safe: () => true };",
        "  const selected = handlers[body.action];",
        "  return selected();",
        "}",
        ""
      ].join("\n")
    });

    const findings = await scanProject(root);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "ambiguous-ast",
          state: "AMBIGUOUS",
          filePath: path.join(root, "app/actions/dispatch.ts"),
          evidence: "tainted dynamic dispatch via selected"
        })
      ])
    );
  });

  test("backend SSRF scan surrenders when a tainted object hits an unknown mutator", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "app/actions/proxy.ts": [
        "export async function preview(req) {",
        "  \"use server\";",
        "  const body = await req.json();",
        "  const payload = { url: body.url };",
        "  mutatePayload(payload);",
        "  return fetch(payload.url);",
        "}",
        ""
      ].join("\n")
    });

    const findings = await scanProject(root);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "ambiguous-ast",
          state: "AMBIGUOUS",
          filePath: path.join(root, "app/actions/proxy.ts"),
          evidence: "tainted object passed into unknown function mutatePayload"
        })
      ])
    );
    expect(findings.some((finding) => finding.ruleId === "ssrf")).toBe(false);
  });

  test("ambiguous findings are packaged with imports for deep reasoning", async () => {
    const { routeAmbiguousFindingsToReasoning, scanProject } = require("../index");
    const root = makeProject({
      "app/actions/proxy.ts": [
        "import { normalizeTarget } from '../../lib/url-tools';",
        "export async function preview(req) {",
        "  \"use server\";",
        "  const body = await req.json();",
        "  const target = normalizeTarget(body.url);",
        "  return fetch(target);",
        "}",
        ""
      ].join("\n"),
      "lib/url-tools.ts": "export const normalizeTarget = (url) => url;\n"
    });
    const findings = await scanProject(root);
    let captured;

    const result = await routeAmbiguousFindingsToReasoning(findings, {
      rootDir: root,
      routeDeepRemediation: async (context) => {
        captured = context;
        return { routed: "reasoning", patchSet: { patches: [], explanation: "queued" } };
      }
    });

    expect(result.routed).toBe("reasoning");
    expect(captured.diff).toContain("AMBIGUOUS");
    expect(captured.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filePath: "app/actions/proxy.ts",
          content: expect.stringContaining("normalizeTarget")
        }),
        expect.objectContaining({
          filePath: "lib/url-tools.ts",
          content: expect.stringContaining("normalizeTarget")
        })
      ])
    );
  });

  test("backend SSRF scan treats Next.js server actions as backend sources", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "app/actions/proxy.ts": [
        "export async function preview(formData) {",
        "  \"use server\";",
        "  const target = formData.get('url');",
        "  return fetch(target);",
        "}",
        ""
      ].join("\n")
    });

    const findings = await scanProject(root);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "ssrf",
          filePath: path.join(root, "app/actions/proxy.ts"),
          line: 4,
          evidence: "fetch(target)"
        })
      ])
    );
  });

  test("backend SSRF scan surrenders instead of trusting inline dummy validators", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "app/api/proxy/route.ts": [
        "const validateOutboundUrl = (url) => url;",
        "export async function GET(req) {",
        "  const target = req.nextUrl.searchParams.get('url');",
        "  const safeTarget = validateOutboundUrl(target);",
        "  return fetch(safeTarget);",
        "}",
        ""
      ].join("\n")
    });

    const findings = await scanProject(root);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "ambiguous-ast",
          state: "AMBIGUOUS",
          line: 4,
          evidence: "tainted object passed into unknown function validateOutboundUrl"
        })
      ])
    );
    expect(findings.some((finding) => finding.ruleId === "ssrf")).toBe(false);
  });

  test("backend SSRF scan propagates taint through destructuring and reassignments", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "pages/api/avatar.ts": [
        "export default async function handler(req, res) {",
        "  const { profile: { avatarUrl } } = req.body;",
        "  const alias = avatarUrl;",
        "  let target;",
        "  target = alias;",
        "  await fetch(target);",
        "  res.json({ ok: true });",
        "}",
        ""
      ].join("\n")
    });

    const findings = await scanProject(root);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "ssrf",
          line: 6,
          evidence: "fetch(target)"
        })
      ])
    );
  });

  test("backend SSRF scan ignores dynamic outbound URLs that pass known validators", async () => {
    const { scanProject } = require("../index");
    const root = makeProject({
      "app/api/proxy/route.ts": [
        "import { validateOutboundUrl } from '@/lib/security/url';",
        "export async function GET(req) {",
        "  const target = req.nextUrl.searchParams.get('url');",
        "  const safeTarget = validateOutboundUrl(target);",
        "  return fetch(safeTarget);",
        "}",
        ""
      ].join("\n"),
      "app/api/proxy/checked.ts": [
        "import { assertSafeRedirectUrl } from '@/server/security/url';",
        "export async function GET(req) {",
        "  const target = req.query.url;",
        "  assertSafeRedirectUrl(target);",
        "  return fetch(target);",
        "}",
        ""
      ].join("\n")
    });

    const findings = await scanProject(root);

    expect(findings.some((finding) => finding.ruleId === "ssrf")).toBe(false);
  });

  test("scanBackendSource targets backend files and ignores frontend dynamic fetches", async () => {
    const { scanBackendSource } = require("../index");
    const root = makeProject({
      "app/api/proxy/route.ts": [
        "export async function GET(req) {",
        "  const target = req.query.url;",
        "  return fetch(target);",
        "}",
        ""
      ].join("\n"),
      "app/page.tsx": [
        "\"use client\";",
        "export function Page({ url }) {",
        "  fetch(url);",
        "}",
        ""
      ].join("\n")
    });

    const findings = await scanBackendSource(root);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "ssrf",
      filePath: path.join(root, "app/api/proxy/route.ts")
    });
  });

  test("scanBackendSource includes use server files outside API directories", async () => {
    const { scanBackendSource } = require("../index");
    const root = makeProject({
      "app/actions/proxy.ts": [
        "\"use server\";",
        "export async function proxy(formData) {",
        "  const target = formData.get('url');",
        "  return fetch(target);",
        "}",
        ""
      ].join("\n")
    });

    const findings = await scanBackendSource(root);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "ssrf",
          filePath: path.join(root, "app/actions/proxy.ts"),
          evidence: "fetch(target)"
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
      "dangerous-code.js": "const stripe_key = \"" + STRIPE_KEY + "\";\n"
    });
    const commandCwd = makeProject({
      "preflight.config.json": JSON.stringify({ ignoreRules: ["frontend-secret"] })
    });

    const result = runNode([path.join(__dirname, "..", "index.js"), "scan", scanRoot, "--no-color"], commandCwd);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PreFlight Check found 0 issues.");
  });

  test("scan command warns and ignores invalid preflight config JSON", () => {
    const commandCwd = makeProject({
      "preflight.config.json": "{ bad json",
      "safe-code.js": "const task_live_status = \"active\";\n"
    });

    const result = runNode([path.join(__dirname, "..", "index.js"), "scan", commandCwd, "--no-color"], commandCwd);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Warning: preflight.config.json contains invalid JSON and was ignored.");
    expect(result.stdout).toContain("PreFlight Check found 0 issues.");
  });

  test("init-config writes a default custom rules template", () => {
    const root = makeProject({});

    const result = runNode([path.join(__dirname, "..", "index.js"), "init-config"], root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PreFlight config template written:");
    const configPath = path.join(root, "preflight.config.json");
    expect(fs.existsSync(configPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(parsed.custom_rules[0]).toMatchObject({
      name: "No direct Supabase service role clients in route handlers",
      severity: "block",
      target_files: ["app/api/**/*.ts", "app/api/**/*.tsx"],
      forbidden_pattern: {
        type: "forbidden_import",
        import_path: "@supabase/supabase-js"
      }
    });
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
    fs.writeFileSync(path.join(root, "tests/dangerous-code.js"), "const stripe_key = \"" + STRIPE_KEY + "\";\n");

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
