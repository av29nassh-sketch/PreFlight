import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

function makeTempProject(files: Record<string, string>): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-regression-"));
  for (const [relativePath, source] of Object.entries(files)) {
    const filePath = path.join(rootDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source, "utf8");
  }
  return rootDir;
}

describe("gauntlet scanner regressions", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("release gate does not flag allowlisted table interpolation with parameterized values", async () => {
    const { runReleaseGateScan } = await import("../src/release-gate/pipeline");
    const rootDir = makeTempProject({
      "api/safe-sql-template.js": `
const express = require("express");
const db = require("../db");
const router = express.Router();

router.get("/users", (req, res) => {
  const allowedTables = new Set(["users", "admins"]);
  const requestedTable = req.query.table;
  const table = allowedTables.has(requestedTable) ? requestedTable : "users";
  const query = \`SELECT id, email FROM \${table} WHERE email = ? AND status = 'active'\`;
  db.execute(query, [req.query.email], (_error, rows) => res.json(rows));
});
`
    });
    roots.push(rootDir);

    const result = await runReleaseGateScan({ targetDir: rootDir, eyeActive: false });

    expect(result.fuzzFindings).toHaveLength(0);
    expect(result.status).toBe("PASSED");
  });

  test("release gate parses TypeScript routes without soft syntax warning noise", async () => {
    const { runReleaseGateScan } = await import("../src/release-gate/pipeline");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rootDir = makeTempProject({
      "app/api/health/route.ts": `
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export async function GET(_request: NextRequest) {
  return NextResponse.json({ ok: true });
}
`
    });
    roots.push(rootDir);

    try {
      const result = await runReleaseGateScan({ targetDir: rootDir, eyeActive: false });
      expect(result.status).toBe("PASSED");
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("Soft syntax warning ignored"));
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("legacy scanProject flags local command, SSRF, path traversal, and dependency pinning issues", async () => {
    const { scanProject } = require("../index");
    const rootDir = makeTempProject({
      "api/command.js": `
const { exec } = require("child_process");
router.post("/ping", (req, res) => {
  const targetIp = req.body.ip;
  const command = "ping -c 4 " + targetIp;
  exec(command, (_error, stdout) => res.send(stdout));
});
`,
      "api/ssrf.ts": `
export async function POST(request: Request) {
  const body = await request.json();
  const response = await fetch(body.previewUrl);
  return Response.json({ html: await response.text() });
}
`,
      "api/path.ts": `
import fs from "node:fs/promises";
import path from "node:path";
export async function GET(request: Request) {
  const url = new URL(request.url);
  const file = url.searchParams.get("file");
  const filePath = path.join(process.cwd(), "uploads", file || "fallback.txt");
  const text = await fs.readFile(filePath, "utf8");
  return Response.json({ text });
}
`,
      "api/billing.ts": `
export async function POST(request: Request) {
  const body = await request.json();
  const accountId = body.accountId;
  const newPlan = body.newPlan;
  await db.updateBillingPlan(accountId, newPlan);
  return Response.json({ ok: true });
}
`,
      "apps/web/supabase/migrations/202606210001_init.sql": `
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL
);
`,
      "package.json": JSON.stringify({
        name: "unsafe-deps",
        dependencies: {
          express: "latest",
          react: "*"
        }
      }, null, 2)
    });
    roots.push(rootDir);

    const findings = await scanProject(rootDir);
    const ruleIds = findings.map((finding: { ruleId: string }) => finding.ruleId);

    expect(ruleIds).toEqual(expect.arrayContaining([
      "command-injection",
      "ssrf",
      "path-traversal",
      "auth-bypass",
      "missing-rls",
      "dependency-unpinned"
    ]));
  });

  test("release gate flags exported account mutations without an authorization guard", async () => {
    const { runReleaseGateScan } = await import("../src/release-gate/pipeline");
    const rootDir = makeTempProject({
      "app/api/billing/route.ts": `
export async function POST(request: Request) {
  const body = await request.json();
  const accountId = body.accountId;
  const newPlan = body.newPlan;
  await db.updateBillingPlan(accountId, newPlan);
  return Response.json({ ok: true });
}
`
    });
    roots.push(rootDir);

    const result = await runReleaseGateScan({ targetDir: rootDir, eyeActive: false });

    expect(result.findings.map((finding) => finding.issue)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Potential BOLA/authorization bypass")
      ])
    );
    expect(result.status).toBe("HARD_BLOCK");
  });

  test("legacy scanProject hard-blocks weak SSRF validation instead of trusting any regex test", async () => {
    const { scanProject } = require("../index");
    const rootDir = makeTempProject({
      "api/proxy.ts": `
export async function POST(request: Request) {
  const body = await request.json();
  const previewUrl = body.previewUrl;
  if (!/.+/.test(previewUrl)) {
    return Response.json({ error: "bad" }, { status: 400 });
  }
  const response = await fetch(previewUrl);
  return Response.json({ html: await response.text() });
}
`
    });
    roots.push(rootDir);

    const findings = await scanProject(rootDir);

    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleId: "ssrf",
        message: expect.stringContaining("weak validation")
      })
    ]));
  });

  test("legacy scanProject hard-blocks inline command injection without ambiguous fallback", async () => {
    const { scanProject } = require("../index");
    const rootDir = makeTempProject({
      "api/ping.js": `
const { exec } = require("child_process");
router.get("/ping", (req, res) => {
  exec("ping -c 4 " + req.query.ip, (_error, stdout) => res.send(stdout));
});
`
    });
    roots.push(rootDir);

    const findings = await scanProject(rootDir);
    const ruleIds = findings.map((finding: { ruleId: string }) => finding.ruleId);

    expect(ruleIds).toContain("command-injection");
    expect(ruleIds).not.toContain("ambiguous-ast");
  });

  test("legacy scanProject hard-blocks BOLA when auth keyword is outside the route guard", async () => {
    const { scanProject } = require("../index");
    const rootDir = makeTempProject({
      "api/billing.ts": `
const auth = false;

export async function POST(request: Request) {
  const body = await request.json();
  await db.updateBillingPlan(body.accountId, "premium");
  return Response.json({ ok: true });
}
`
    });
    roots.push(rootDir);

    const findings = await scanProject(rootDir);
    const ruleIds = findings.map((finding: { ruleId: string }) => finding.ruleId);

    expect(ruleIds).toContain("auth-bypass");
    expect(ruleIds).not.toContain("ambiguous-ast");
  });
});
