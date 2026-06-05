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
    const { scanDiff, STATES } = require("../src/ast/scanner");
    const diff = [
      "diff --git a/app.js b/app.js",
      "+const stripe = \"sk_live_1234567890abcdef\";",
      "+db.query(\"SELECT * FROM users WHERE id = \" + userId);"
    ].join("\n");

    const result = scanDiff(diff, { autoFix: true });

    expect(result.state).toBe(STATES.CONFIRMED_FINDING);
    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.kind)).toEqual(["secret", "raw-sql"]);
    expect(result.fixedDiff).toContain("sk_live_REDACTED_BY_PREFLIGHT");
    expect(result.fixedDiff).not.toContain("1234567890abcdef");
  });

  test("scanner returns exact upgrade guidance for fuzzy architectural boundaries", () => {
    const { FUZZY_CONTEXT_MESSAGE, STATES, renderScanReceipt, scanDiff } = require("../src/ast/scanner");
    const diff = [
      "diff --git a/auth.js b/auth.js",
      "+const user = await supabase.auth.getUser();",
      "+await client.rpc('tenant_lookup', { id });"
    ].join("\n");

    const result = scanDiff(diff);

    expect(result.state).toBe(STATES.NEEDS_RUNTIME_CHECK);
    expect(result.ok).toBe(false);
    expect(result.message).toBe(FUZZY_CONTEXT_MESSAGE);
    expect(renderScanReceipt(result)).toBe([
      "⚠️  Complex Architecture Detected (Fuzzy Context)",
      "PreFlight's local engine found complex multi-file tenant wrappers or RPC blocks that require deep architectural reasoning.",
      "",
      "👉 To resolve this, run:",
      "   preflight upgrade",
      "",
      "This will show you how to unlock the Cloud AI Engine ($19/mo) for automated contextual patching and deep security tracing.",
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
    expect(prepared.logSafeSummary).not.toContain("pf_pro_test_license_key");
    expect(prepared.payload.requestedAction).toBe("auto-heal");
  });

  test("cloud fallback sends diff through SDK when local hardware cannot run", async () => {
    const {
      analyzeDiffWithCloud,
      PREFLIGHT_SYSTEM_PROMPT
    } = require("../src/router/cloud");
    const requests = [];
    const fakeClient = {
      chat: {
        completions: {
          create: async (request) => {
            requests.push(request);
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      state: "YELLOW",
                      reasoning: "Tenant isolation spans multiple files and cannot be proven from this diff alone.",
                      manual_qa_line: "Create two tenants locally and confirm user A cannot read user B records.",
                      auto_patch: null
                    })
                  }
                }
              ]
            };
          }
        }
      }
    };

    const result = await analyzeDiffWithCloud("+await client.rpc('tenant_lookup')", {
      apiKey: "pf_cloud_test_key",
      canRunLocal: false,
      client: fakeClient,
      model: "test-model"
    });

    expect(result.routed).toBe("cloud");
    expect(result.verdict).toEqual({
      state: "YELLOW",
      reasoning: "Tenant isolation spans multiple files and cannot be proven from this diff alone.",
      manual_qa_line: "Create two tenants locally and confirm user A cannot read user B records.",
      auto_patch: null
    });
    expect(requests[0]).toMatchObject({
      model: "test-model",
      response_format: { type: "json_object" },
      temperature: 0
    });
    expect(requests[0].messages[0]).toEqual({
      role: "system",
      content: PREFLIGHT_SYSTEM_PROMPT
    });
    expect(requests[0].messages[1].content).toContain("+await client.rpc('tenant_lookup')");
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

  test("cloud fallback rejects malformed model JSON", async () => {
    const { analyzeDiffWithCloud } = require("../src/router/cloud");
    const fakeClient = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: "{\"state\":\"RED\",\"reasoning\":\"Missing fields\"}" } }]
          })
        }
      }
    };

    await expect(
      analyzeDiffWithCloud("+const unsafe = true;", {
        apiKey: "pf_cloud_test_key",
        canRunLocal: false,
        client: fakeClient
      })
    ).rejects.toThrow("Cloud verdict must include manual_qa_line");
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
      "⚠️  Complex Architecture Detected (Fuzzy Context)",
      "PreFlight's local engine found complex multi-file tenant wrappers or RPC blocks that require deep architectural reasoning.",
      "",
      "👉 To resolve this, run:",
      "   preflight upgrade",
      "",
      "This will show you how to unlock the Cloud AI Engine ($19/mo) for automated contextual patching and deep security tracing.",
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
});
