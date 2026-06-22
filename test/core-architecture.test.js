const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const roots = [];

function makeProject(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-core-"));
  roots.push(root);

  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, contents);
  }

  return root;
}

function runNode(args, cwd, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    input: options.input
  });
}

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop(), { recursive: true, force: true });
  }
});

describe("PreFlight core modular architecture", () => {
  test("installs a managed pre-commit hook that pipes staged diff into PreFlight", () => {
    const { installPreCommitHook } = require("../src/cli/init");
    const root = makeProject({ ".git/HEAD": "ref: refs/heads/main\n" });

    const result = installPreCommitHook(root, {
      engineCommand: "preflight scan-diff --stdin"
    });

    const hookPath = path.join(root, ".git", "hooks", "pre-commit");
    const hook = fs.readFileSync(hookPath, "utf8");

    expect(result.hookPath).toBe(hookPath);
    expect(result.installed).toBe(true);
    expect(hook).toContain("git diff --cached");
    expect(hook).toContain("preflight scan-diff --stdin");
    expect(hook).toContain("exit 1");
  });

  test("scanner redacts confirmed secret findings and blocks unsafe diffs", () => {
    const { renderScanReceipt, scanDiff, STATES } = require("../src/ast/scanner");
    const diff = [
      "diff --git a/app.js b/app.js",
      "+++ b/app.js",
      "+const stripe = \"sk_live_PREFLIGHT_DUMMY_KEY_12345\";",
      "+db.query(\"SELECT * FROM users WHERE id = \" + userId);"
    ].join("\n");

    const result = scanDiff(diff, { autoFix: true });
    const receipt = renderScanReceipt(result, { color: false });

    expect(result.state).toBe(STATES.CONFIRMED_FINDING);
    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.kind)).toEqual(["secret", "raw-sql"]);
    expect(result.fixedDiff).toContain("sk_live_REDACTED_BY_PREFLIGHT");
    expect(result.fixedDiff).not.toContain("1234567890abcdef");
    expect(result.autoPatch).toContain("-const stripe");
    expect(result.autoPatch).toContain("+const stripe");
    expect(receipt).toContain("🔴 CONFIRMED FINDING (Hard Block)");
    expect(receipt).toContain("[Deployed Consequence]: \"If you deploy this, secrets or injectable queries can be abused in production before review catches them.\"");
    expect(receipt).toContain("[Action Required]: \"Reject this commit or accept the explicit Auto-Heal prompt after reviewing the patch.\"");
  });

  test("scanner returns high-risk drift guidance with deployed consequence for fuzzy boundaries", () => {
    const { STATES, renderScanReceipt, scanDiff } = require("../src/ast/scanner");
    const diff = [
      "diff --git a/auth.js b/auth.js",
      "+++ b/auth.js",
      "+const user = await supabase.auth.getUser();",
      "+await client.rpc('tenant_lookup', { id });"
    ].join("\n");

    const result = scanDiff(diff);

    expect(result.state).toBe(STATES.NEEDS_RUNTIME_CHECK);
    expect(result.ok).toBe(false);
    expect(renderScanReceipt(result, { color: false })).toBe([
      "🟡 HIGH-RISK DRIFT (Needs Runtime Check)",
      "PreFlight Check found AI coding drift in a sensitive architectural boundary.",
      "",
      "[Deployed Consequence]: \"If you deploy this, tenant isolation or auth behavior can change across files without a visible route-level failure.\"",
      "[Action Required]: \"Run the affected flow locally as User A and User B, then verify cross-tenant reads and writes return 403 or an empty result.\"",
      "",
      "Findings:",
      "- fuzzy-context at auth.js:1",
      "- fuzzy-context at auth.js:2",
      ""
    ].join("\n"));
  });

  test("scanner returns a green receipt for clean diffs", () => {
    const { SAFE_RECEIPT, STATES, scanDiff } = require("../src/ast/scanner");

    const result = scanDiff("+const label = 'hello';");

    expect(result.state).toBe(STATES.LIKELY_SAFE);
    expect(result.ok).toBe(true);
    expect(result.message).toBe(SAFE_RECEIPT);
  });

  test("scanner catches vibecoder Supabase and Next.js drift rules", () => {
    const { scanDiff, STATES } = require("../src/ast/scanner");

    const brokenRls = scanDiff([
      "diff --git a/supabase/migrations/001_policy.sql b/supabase/migrations/001_policy.sql",
      "+++ b/supabase/migrations/001_policy.sql",
      "+create policy \"open update\" on profiles for update using (true);"
    ].join("\n"));
    const middlewareBypass = scanDiff([
      "diff --git a/middleware.ts b/middleware.ts",
      "+++ b/middleware.ts",
      "+export function middleware() {",
      "+  return NextResponse.next();",
      "+}"
    ].join("\n"));
    const billingDrift = scanDiff([
      "diff --git a/app/api/webhooks/stripe/route.ts b/app/api/webhooks/stripe/route.ts",
      "+++ b/app/api/webhooks/stripe/route.ts",
      "+import Stripe from 'stripe';",
      "+export async function POST(req) { return Response.json({ ok: true }); }"
    ].join("\n"));

    expect(brokenRls.state).toBe(STATES.CONFIRMED_FINDING);
    expect(brokenRls.findings[0].kind).toBe("supabase-rls");
    expect(middlewareBypass.state).toBe(STATES.CONFIRMED_FINDING);
    expect(middlewareBypass.findings[0].kind).toBe("middleware-auth-bypass");
    expect(billingDrift.state).toBe(STATES.NEEDS_RUNTIME_CHECK);
    expect(billingDrift.findings[0].kind).toBe("billing-webhook-drift");
  });

  test("scanner catches tautological Supabase RLS predicates in diffs", () => {
    const { scanDiff, STATES } = require("../src/ast/scanner");

    const numericTautology = scanDiff([
      "diff --git a/supabase/migrations/002_policy.sql b/supabase/migrations/002_policy.sql",
      "+++ b/supabase/migrations/002_policy.sql",
      "+create policy \"open select\" on profiles for select using (1 = 1);"
    ].join("\n"));
    const stringTautology = scanDiff([
      "diff --git a/supabase/migrations/003_policy.sql b/supabase/migrations/003_policy.sql",
      "+++ b/supabase/migrations/003_policy.sql",
      "+create policy \"open insert\" on profiles for insert with check ('admin' = 'admin');"
    ].join("\n"));

    expect(numericTautology.state).toBe(STATES.CONFIRMED_FINDING);
    expect(numericTautology.findings[0].kind).toBe("supabase-rls");
    expect(stringTautology.state).toBe(STATES.CONFIRMED_FINDING);
    expect(stringTautology.findings[0].kind).toBe("supabase-rls");
  });

  test("scanner catches statically true mathematical RLS predicates in diffs", () => {
    const { scanDiff, STATES } = require("../src/ast/scanner");

    const result = scanDiff([
      "diff --git a/supabase/migrations/004_policy.sql b/supabase/migrations/004_policy.sql",
      "+++ b/supabase/migrations/004_policy.sql",
      "+create policy \"open select\" on profiles for select using (2 > 1);",
      "+create policy \"open insert\" on profiles for insert with check (100 >= 10);"
    ].join("\n"));

    expect(result.state).toBe(STATES.CONFIRMED_FINDING);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "supabase-rls"
        })
      ])
    );
  });

  test("interactive Auto-Heal prompt prints a colorized diff and requires explicit y", async () => {
    const { promptForAutoHeal } = require("../src/ast/scanner");
    const output = { text: "", write(chunk) { this.text += chunk; } };
    const patch = [
      "--- a/app.js",
      "+++ b/app.js",
      "-const stripe = \"sk_live_PREFLIGHT_DUMMY_KEY_12345\";",
      "+const stripe = process.env.STRIPE_SECRET_KEY;"
    ].join("\n");

    const declined = await promptForAutoHeal(patch, {
      ask: async (question) => {
        expect(question).toBe("[y/n] Accept and Auto-Heal? ");
        return "n";
      },
      color: true,
      output
    });

    expect(declined).toBe(false);
    expect(output.text).toContain("\x1b[31m-const stripe");
    expect(output.text).toContain("\x1b[32m+const stripe");
    expect(output.text).toContain("[y/n] Accept and Auto-Heal?");
  });

  test("hardware router evaluates local capability from CPU, RAM, and VRAM probes", () => {
    const { evaluateHardware } = require("../src/router/hardware");

    expect(evaluateHardware({
      cpuCores: 12,
      totalRamBytes: 32 * 1024 ** 3,
      vramBytes: 8 * 1024 ** 3
    })).toBe(true);
    expect(evaluateHardware({
      cpuCores: 4,
      totalRamBytes: 8 * 1024 ** 3,
      vramBytes: 2 * 1024 ** 3
    })).toBe(false);
  });

  test("cloud fallback builds authenticated payload without leaking license in logs", () => {
    const { buildCloudPayload, prepareCloudFallback } = require("../src/router/cloud");
    const diff = "+const safe = true;";

    const payload = buildCloudPayload(diff, {
      mode: "manual-qa",
      repoId: "repo-123"
    });
    const prepared = prepareCloudFallback(diff, {
      licenseKey: "pf_pro_test_license_key",
      mode: "auto-heal",
      repoId: "repo-123"
    });

    expect(payload.diff).toBe(diff);
    expect(payload.requestedAction).toBe("manual-qa");
    expect(prepared.headers.Authorization).toBe("Bearer pf_pro_test_license_key");
    expect(prepared.headers["X-PreFlight-Pro-Key"]).toBe("pf_pro_test_license_key");
    expect(prepared.logSafeSummary).not.toContain("pf_pro_test_license_key");
    expect(prepared.payload.requestedAction).toBe("auto-heal");
  });

  test("cloud fallback sends diff through the PreFlight Pro proxy when local hardware cannot run", async () => {
    const { PREFLIGHT_SYSTEM_PROMPT, analyzeDiffWithCloud } = require("../src/router/cloud");
    const requests = [];

    const result = await analyzeDiffWithCloud("+await client.rpc('tenant_lookup')", {
      licenseKey: "PREFLIGHT-BETA-20260610-TEST1",
      canRunLocal: false,
      transport: async (request) => {
        requests.push(request);
        return {
          verdict: {
            state: "YELLOW",
            reasoning: "Tenant isolation spans multiple files and cannot be proven from this diff alone.",
            manual_qa_line: "Create two tenants locally and confirm user A cannot read user B records.",
            auto_patch: null
          }
        };
      }
    });

    expect(result.routed).toBe("cloud");
    expect(result.verdict).toEqual({
      state: "YELLOW",
      reasoning: "Tenant isolation spans multiple files and cannot be proven from this diff alone.",
      manual_qa_line: "Create two tenants locally and confirm user A cannot read user B records.",
      auto_patch: null
    });
    expect(requests[0].headers.Authorization).toBe("Bearer PREFLIGHT-BETA-20260610-TEST1");
    expect(requests[0].headers["X-PreFlight-Pro-Key"]).toBe("PREFLIGHT-BETA-20260610-TEST1");
    expect(requests[0].payload.system).toBe(PREFLIGHT_SYSTEM_PROMPT);
    expect(requests[0].payload.messages[0].content).toContain("+await client.rpc('tenant_lookup')");
  });

  test("cloud fallback validates proxy verdict responses without requiring AI provider keys", async () => {
    const { callCloudDiffAnalyzer } = require("../src/router/cloud");
    const requests = [];

    const verdict = await callCloudDiffAnalyzer("+const ok = true;", {
      licenseKey: "PREFLIGHT-BETA-20260610-TEST1",
      transport: async (request) => {
        requests.push(request);
        return {
          state: "GREEN",
          reasoning: "No cross-tenant boundary regression detected in this reduced diff.",
          manual_qa_line: null,
          auto_patch: null
        };
      }
    });

    expect(verdict).toEqual({
      state: "GREEN",
      reasoning: "No cross-tenant boundary regression detected in this reduced diff.",
      manual_qa_line: null,
      auto_patch: null
    });
    expect(requests[0].headers.Authorization).toBe("Bearer PREFLIGHT-BETA-20260610-TEST1");
    expect(requests[0].headers["X-PreFlight-Pro-Key"]).toBe("PREFLIGHT-BETA-20260610-TEST1");
  });

  test("cloud fallback skips SDK calls when local hardware can run", async () => {
    const { analyzeDiffWithCloud } = require("../src/router/cloud");
    const fakeClient = {
      chat: {
        completions: {
          create: async () => {
            throw new Error("cloud should not be called");
          }
        }
      }
    };

    const result = await analyzeDiffWithCloud("+const safe = true;", {
      canRunLocal: true,
      client: fakeClient
    });

    expect(result).toEqual({
      routed: "local",
      verdict: null
    });
  });

  test("cloud fallback surfaces the unified Pro engine error when the proxy response is malformed", async () => {
    const { PRO_ENGINE_CONNECTION_ERROR, analyzeDiffWithCloud } = require("../src/router/cloud");

    await expect(
      analyzeDiffWithCloud("+const unsafe = true;", {
        licenseKey: "PREFLIGHT-BETA-20260610-TEST1",
        canRunLocal: false,
        transport: async () => ({
          state: "RED",
          reasoning: "Missing fields"
        })
      })
    ).rejects.toThrow(PRO_ENGINE_CONNECTION_ERROR);
  });

  test("parseJsonObject tolerates fenced JSON wrapped in extra text", () => {
    const { parseJsonObject } = require("../src/router/cloud");

    expect(
      parseJsonObject([
        "Root Cause: Wrapped response",
        "```json",
        "{\"state\":\"GREEN\",\"reasoning\":\"Safe.\",\"manual_qa_line\":null,\"auto_patch\":null}",
        "```"
      ].join("\n"))
    ).toEqual({
      state: "GREEN",
      reasoning: "Safe.",
      manual_qa_line: null,
      auto_patch: null
    });
  });

  test("micro-router defaults to local Ollama-compatible provider without requiring a cloud key", () => {
    const { resolveMicroRouterProvider } = require("../src/router/cloud");

    expect(resolveMicroRouterProvider({})).toEqual({
      apiKey: "ollama",
      baseURL: "http://localhost:11434/v1",
      model: "qwen2.5-coder:0.5b",
      provider: "ollama",
      timeoutMs: 5000
    });
  });

  test("micro-router ignores AI provider keys and stays on the local keyless path", () => {
    const { resolveMicroRouterProvider } = require("../src/router/cloud");

    expect(resolveMicroRouterProvider({
      OPENROUTER_API_KEY: "openrouter-key",
      PREFLIGHT_MICRO_MODEL: "qwen/qwen3-coder:free"
    })).toEqual({
      apiKey: "ollama",
      baseURL: "http://localhost:11434/v1",
      model: "qwen/qwen3-coder:free",
      provider: "ollama",
      timeoutMs: 5000
    });
  });

  test("reasoning engine resolves to the PreFlight Pro proxy configuration", () => {
    const { resolveReasoningEngineProvider } = require("../src/router/cloud");

    expect(resolveReasoningEngineProvider({
      PREFLIGHT_PRO_KEY: "PREFLIGHT-BETA-20260610-TEST1"
    })).toEqual({
      endpoint: "https://preflight-proxy.vercel.app/api/v1/remediation",
      freeFix: false,
      licenseKey: "PREFLIGHT-BETA-20260610-TEST1",
      provider: "preflight-proxy",
      timeoutMs: 30000
    });
  });

  test("micro-router sends a compact diff payload and parses strict boolean JSON", async () => {
    const {
      MICRO_ROUTER_SYSTEM_PROMPT,
      MicroRouter
    } = require("../src/router/cloud");
    const requests = [];
    const fakeClient = {
      chat: {
        completions: {
          create: async (request, requestOptions) => {
            requests.push({ request, requestOptions });
            return {
              choices: [{ message: { content: "{\"requires_deep_scan\":false}" } }]
            };
          }
        }
      }
    };

    const router = new MicroRouter({
      client: fakeClient,
      env: {},
      model: "micro-test",
      timeoutMs: 1234
    });
    const result = await router.evaluate([
      "diff --git a/app.js b/app.js",
      "index 111..222 100644",
      "--- a/app.js",
      "+++ b/app.js",
      "@@ -1,2 +1,2 @@",
      "-const count = 1;",
      "+const count = 2;",
      " const untouched = true;"
    ].join("\n"));

    expect(result).toEqual({
      requires_deep_scan: false,
      routed: "micro",
      fallback: false
    });
    expect(requests[0].request).toMatchObject({
      model: "micro-test",
      response_format: { type: "json_object" },
      temperature: 0
    });
    expect(requests[0].request.messages[0]).toEqual({
      role: "system",
      content: MICRO_ROUTER_SYSTEM_PROMPT
    });
    expect(requests[0].request.messages[1].content).toContain("+const count = 2;");
    expect(requests[0].request.messages[1].content).not.toContain("index 111..222");
    expect(requests[0].requestOptions).toEqual({ timeout: 1234 });
  });

  test("micro-router fails closed when the local/free model throws", async () => {
    const { MicroRouter } = require("../src/router/cloud");
    const router = new MicroRouter({
      client: {
        chat: {
          completions: {
            create: async () => {
              throw new Error("local model unavailable");
            }
          }
        }
      },
      env: {}
    });

    await expect(router.evaluate("+const safe = true;")).resolves.toEqual({
      requires_deep_scan: true,
      routed: "micro",
      fallback: true,
      reason: "local model unavailable"
    });
  });

  test("reasoning engine receives full diff and touched files when micro-router requires deep scan", async () => {
    const {
      REASONING_ENGINE_SYSTEM_PROMPT,
      routeDeepRemediation
    } = require("../src/router/cloud");
    const requests = [];
    const fakeClient = {
      chat: {
        completions: {
          create: async (request, requestOptions) => {
            requests.push({ request, requestOptions });
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      patches: [
                        {
                          file_path: "app/api/tenant/route.ts",
                          action: "update",
                          new_content: "export const GET = withTenantGuard(handler);\n"
                        }
                      ],
                      explanation: "Wrap the route handler and verify tenant isolation with two users."
                    })
                  }
                }
              ]
            };
          }
        }
      }
    };

    const result = await routeDeepRemediation({
      diff: [
        "diff --git a/app/api/tenant/route.ts b/app/api/tenant/route.ts",
        "+++ b/app/api/tenant/route.ts",
        "+export async function GET() { return Response.json({ ok: true }); }",
        ""
      ].join("\n"),
      files: [
        {
          filePath: "app/api/tenant/route.ts",
          content: "export async function GET() { return Response.json({ ok: true }); }\n"
        }
      ],
      microRouter: {
        evaluate: async () => ({ requires_deep_scan: true })
      },
      reasoningEngine: {
        generatePatchSet: async (context) => {
          expect(context.files[0].content).toContain("export async function GET");
          return fakeClient.chat.completions.create({
            model: "reasoning-test",
            messages: [
              { role: "system", content: REASONING_ENGINE_SYSTEM_PROMPT },
              { role: "user", content: JSON.stringify(context) }
            ],
            response_format: { type: "json_object" },
            temperature: 0
          }, { timeout: 30000 }).then((response) =>
            require("../remediationEngine").parseMultiFileRemediationJson(response.choices[0].message.content)
          );
        }
      }
    });

    expect(result.routed).toBe("reasoning");
    expect(result.patchSet).toEqual({
      patches: [
        {
          filePath: "app/api/tenant/route.ts",
          action: "update",
          newContent: "export const GET = withTenantGuard(handler);\n"
        }
      ],
      explanation: "Wrap the route handler and verify tenant isolation with two users."
    });
    expect(requests[0].request.messages[0]).toEqual({
      role: "system",
      content: REASONING_ENGINE_SYSTEM_PROMPT
    });
    expect(requests[0].requestOptions).toEqual({ timeout: 30000 });
  });

  test("ReasoningEngine sends deep remediation through the PreFlight Pro proxy", async () => {
    const { REASONING_ENGINE_SYSTEM_PROMPT, ReasoningEngine } = require("../src/router/cloud");
    const requests = [];
    const engine = new ReasoningEngine({
      env: {
        PREFLIGHT_PRO_KEY: "PREFLIGHT-BETA-20260610-TEST1"
      },
      timeoutMs: 12345,
      transport: async (request) => {
        requests.push(request);
        return {
          patches: [
            {
              file_path: "middleware.ts",
              action: "update",
              new_content: "export default withAuth(middleware);\n"
            }
          ],
          explanation: "Restore auth middleware and verify protected routes return 403."
        };
      }
    });

    const patchSet = await engine.generatePatchSet({
      diff: "+return NextResponse.next();\n",
      files: [{ filePath: "middleware.ts", content: "export function middleware() { return NextResponse.next(); }\n" }]
    });

    expect(patchSet).toEqual({
      patches: [
        {
          filePath: "middleware.ts",
          action: "update",
          newContent: "export default withAuth(middleware);\n"
        }
      ],
      explanation: "Restore auth middleware and verify protected routes return 403."
    });
    expect(requests[0].headers.Authorization).toBe("Bearer PREFLIGHT-BETA-20260610-TEST1");
    expect(requests[0].headers["X-PreFlight-Pro-Key"]).toBe("PREFLIGHT-BETA-20260610-TEST1");
    expect(requests[0].payload.system).toBe(REASONING_ENGINE_SYSTEM_PROMPT);
    expect(requests[0].payload.messages[0].content).toContain("middleware.ts");
  });

  test("requestCloudScan parses direct proxy responses even when a transport function is supplied", async () => {
    const { requestCloudScan } = require("../src/router/cloud");

    const result = await requestCloudScan("diff --git a/app/page.tsx b/app/page.tsx\n+++ b/app/page.tsx", {
      endpoint: "https://preflight-proxy.vercel.app/api/v1/remediation",
      licenseKey: "PREFLIGHT-BETA-20260610-TEST1",
      mode: "auto-heal",
      transport: async () => ({
        content: [
          {
            text: "```json\n{\"patches\":[{\"file_path\":\"app/page.tsx\",\"action\":\"update\",\"new_content\":\"export default function Page() { return null; }\\n\"}],\"explanation\":\"Restore the safe page boundary.\"}\n```"
          }
        ]
      })
    });

    expect(result).toEqual({
      patches: [
        {
          file_path: "app/page.tsx",
          action: "update",
          new_content: "export default function Page() { return null; }\n"
        }
      ],
      explanation: "Restore the safe page boundary."
    });
  });

  test("applyScanFixes treats llm-reasoning patch sets as supported deep fixes", async () => {
    const { applyScanFixes } = require("../index");
    const root = makeProject({
      "app/api/tenant-sync/route.ts": "export async function POST() { return Response.json({ ok: true }); }\n"
    });
    const prompts = [];
    const output = { text: "", write(chunk) { this.text += String(chunk); } };

    const result = await applyScanFixes([
      {
        ruleId: "llm-reasoning",
        severity: "critical",
        filePath: path.join(root, "app/api/tenant-sync/route.ts"),
        patchSet: {
          patches: [
            {
              filePath: "app/api/tenant-sync/route.ts",
              action: "update",
              newContent: "export const POST = withTenantGuard(handler);\n"
            }
          ],
          explanation: "Restore the tenant guard before forwarding tenant-scoped writes."
        }
      }
    ], {
      ask: async (question) => {
        prompts.push(question);
        return "y";
      },
      output,
      rootDir: root
    });

    expect(result).toEqual({ attempted: 1, applied: 1, skipped: 0, unsupported: 0 });
    expect(prompts).toEqual(["Apply this deep reasoning fix? (y/N): "]);
    expect(output.text).toContain("Deep Multi-File Remediation");
    expect(output.text).toMatch(/app[\\/]api[\\/]tenant-sync[\\/]route\.ts/);
    expect(fs.readFileSync(path.join(root, "app/api/tenant-sync/route.ts"), "utf8")).toBe(
      "export const POST = withTenantGuard(handler);\n"
    );
  });

  test("applyScanFixes blocks deep patches that would overwrite a file already fixed in the same run", async () => {
    const { applyScanFixes } = require("../index");
    const original = "const secret = \"sk_test_123\";\n";
    const replacement = "const secret = process.env.STRIPE_SECRET_KEY;\n";
    const root = makeProject({
      "app/api/tenant-sync/route.ts": original
    });
    const prompts = [];
    const output = { text: "", write(chunk) { this.text += String(chunk); } };

    const result = await applyScanFixes([
      {
        ruleId: "frontend-secret",
        severity: "critical",
        filePath: path.join(root, "app/api/tenant-sync/route.ts"),
        fix: {
          kind: "credential",
          startByte: 0,
          endByte: Buffer.byteLength(original, "utf8"),
          expectedText: original,
          replacement
        }
      },
      {
        ruleId: "llm-reasoning",
        severity: "critical",
        filePath: path.join(root, "app/api/tenant-sync/route.ts"),
        patchSet: {
          patches: [
            {
              filePath: "app/api/tenant-sync/route.ts",
              action: "update",
              newContent: "export const POST = withTenantGuard(handler);\n"
            }
          ],
          explanation: "Restore the tenant guard before forwarding tenant-scoped writes."
        }
      }
    ], {
      ask: async (question) => {
        prompts.push(question);
        return "y";
      },
      output,
      rootDir: root
    });

    expect(result).toEqual({ attempted: 1, applied: 1, skipped: 0, unsupported: 1 });
    expect(prompts).toEqual(["\nApply this fix? (y/N): "]);
    expect(output.text).toContain("Skipping deep patch for");
    expect(output.text).toMatch(/app[\\/]api[\\/]tenant-sync[\\/]route\.ts/);
    expect(fs.readFileSync(path.join(root, "app/api/tenant-sync/route.ts"), "utf8")).toBe(replacement);
  });

  test("applyScanFixes blocks a second deep patch from overwriting an earlier deep patch in the same run", async () => {
    const { applyScanFixes } = require("../index");
    const root = makeProject({
      "app/api/tenant-sync/route.ts": "export async function POST() { return Response.json({ ok: true }); }\n"
    });
    const prompts = [];
    const output = { text: "", write(chunk) { this.text += String(chunk); } };

    const result = await applyScanFixes([
      {
        ruleId: "llm-reasoning",
        severity: "critical",
        filePath: path.join(root, "app/api/tenant-sync/route.ts"),
        patchSet: {
          patches: [
            {
              filePath: "app/api/tenant-sync/route.ts",
              action: "update",
              newContent: "export const POST = withTenantGuard(handler);\n"
            }
          ],
          explanation: "Apply the first deep patch."
        }
      },
      {
        ruleId: "llm-reasoning",
        severity: "critical",
        filePath: path.join(root, "app/api/tenant-sync/route.ts"),
        patchSet: {
          patches: [
            {
              filePath: "app/api/tenant-sync/route.ts",
              action: "update",
              newContent: "export const POST = insecureHandler;\n"
            }
          ],
          explanation: "This second deep patch should be blocked."
        }
      }
    ], {
      ask: async (question) => {
        prompts.push(question);
        return "y";
      },
      output,
      rootDir: root
    });

    expect(result).toEqual({ attempted: 1, applied: 1, skipped: 0, unsupported: 1 });
    expect(prompts).toEqual(["Apply this deep reasoning fix? (y/N): "]);
    expect(output.text).toContain("Skipping deep patch for");
    expect(output.text).toMatch(/app[\\/]api[\\/]tenant-sync[\\/]route\.ts/);
    expect(fs.readFileSync(path.join(root, "app/api/tenant-sync/route.ts"), "utf8")).toBe(
      "export const POST = withTenantGuard(handler);\n"
    );
  });

  test("ReasoningEngine converts backend 402 responses into a paywall interceptor error", async () => {
    const {
      PreFlightPaymentRequiredError,
      PRO_ENGINE_CONNECTION_ERROR,
      ReasoningEngine
    } = require("../src/router/cloud");
    const engine = new ReasoningEngine({
      env: {
        PREFLIGHT_PRO_KEY: "PREFLIGHT-BETA-20260610-TEST1"
      },
      transport: async () => {
        const error = new Error("Payment Required");
        error.status = 402;
        throw error;
      }
    });

    await expect(engine.generatePatchSet({
      diff: "+export async function GET() { return Response.json({ ok: true }); }\n",
      files: []
    })).rejects.toBeInstanceOf(PreFlightPaymentRequiredError);
    await expect(engine.generatePatchSet({
      diff: "+export async function GET() { return Response.json({ ok: true }); }\n",
      files: []
    })).rejects.toMatchObject({
      status: 402,
      message: PRO_ENGINE_CONNECTION_ERROR
    });
  });

  test("ReasoningEngine refuses to parse MANUAL_REVIEW_REQUIRED as an auto patch", async () => {
    const {
      ManualReviewRequiredError,
      MANUAL_REVIEW_MESSAGE,
      ReasoningEngine
    } = require("../src/router/cloud");
    const engine = new ReasoningEngine({
      env: {
        PREFLIGHT_PRO_KEY: "PREFLIGHT-BETA-20260610-TEST1"
      },
      transport: async () => "  MANUAL_REVIEW_REQUIRED  "
    });

    await expect(engine.generatePatchSet({
      diff: "+export async function GET() { return Response.json({ ok: true }); }\n",
      files: []
    })).rejects.toBeInstanceOf(ManualReviewRequiredError);
    await expect(engine.generatePatchSet({
      diff: "+export async function GET() { return Response.json({ ok: true }); }\n",
      files: []
    })).rejects.toMatchObject({
      message: MANUAL_REVIEW_MESSAGE
    });
  });

  test("deep remediation routing stops after micro-router says no deep scan is needed", async () => {
    const { routeDeepRemediation } = require("../src/router/cloud");
    let reasoningCalled = false;

    const result = await routeDeepRemediation({
      diff: "+const label = 'copy';",
      files: [],
      microRouter: {
        evaluate: async () => ({ requires_deep_scan: false })
      },
      reasoningEngine: {
        generatePatchSet: async () => {
          reasoningCalled = true;
        }
      }
    });

    expect(reasoningCalled).toBe(false);
    expect(result).toEqual({
      routed: "micro",
      requires_deep_scan: false,
      patchSet: null
    });
  });

  test("scan-diff CLI reads stdin and exits non-zero for fuzzy context", () => {
    const root = makeProject({});
    const result = runNode([
      path.join(__dirname, "..", "index.js"),
      "scan-diff",
      "--stdin"
    ], root, {
      input: "+const user = await supabase.auth.getUser();\n"
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe([
      "🟡 HIGH-RISK DRIFT (Needs Runtime Check)",
      "PreFlight Check found AI coding drift in a sensitive architectural boundary.",
      "",
      "[Deployed Consequence]: \"If you deploy this, tenant isolation or auth behavior can change across files without a visible route-level failure.\"",
      "[Action Required]: \"Run the affected flow locally as User A and User B, then verify cross-tenant reads and writes return 403 or an empty result.\"",
      "",
      "Findings:",
      "- fuzzy-context at unknown:1",
      ""
    ].join("\n"));
    expect(result.stderr).toBe("");
  });

  test("upgrade CLI prints the live waitlist URL", () => {
    const root = makeProject({});
    const result = runNode([
      path.join(__dirname, "..", "index.js"),
      "upgrade"
    ], root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("https://waitlister.me/p/preflight");
    expect(result.stdout).not.toContain("[INSERT_YOUR_WAITLIST_URL]");
    expect(result.stdout).not.toContain("click here to join the waitlist](#)");
  });

  test("CLI exposes a version flag for binary smoke tests", () => {
    const root = makeProject({});
    const packageJson = require("../package.json");
    const result = runNode([
      path.join(__dirname, "..", "index.js"),
      "--version"
    ], root);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(packageJson.version);
    expect(result.stderr).toBe("");
  });
});
