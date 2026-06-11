describe("remediationEngine", () => {
  test("findSqlConcatenations returns byte coordinates for SQL string concatenations", async () => {
    const { findSqlConcatenations, parseJavaScript } = require("../remediationEngine");
    const sourceCode = [
      "const prefix = \"é-safe-prefix 🚀\";",
      "const query = \"SELECT * FROM users WHERE id = \" + userId;",
      "const safe = \"hello \" + name;",
      ""
    ].join("\r\n");
    const tree = await parseJavaScript(sourceCode);

    const matches = findSqlConcatenations(tree.rootNode, sourceCode);
    const rawSnippet = "\"SELECT * FROM users WHERE id = \" + userId";
    const stringIndex = sourceCode.indexOf(rawSnippet);
    const byteIndex = Buffer.byteLength(sourceCode.slice(0, stringIndex), "utf8");

    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({
      startIndex: byteIndex,
      endIndex: byteIndex + Buffer.byteLength(rawSnippet, "utf8"),
      rawSnippet
    });
  });

  test("findSqlConcatenations detects SQL keywords on either side of a plus expression", async () => {
    const { findSqlConcatenations, parseJavaScript } = require("../remediationEngine");
    const sourceCode = [
      "const insertQuery = values + \" INSERT INTO audit_log VALUES ($1)\";",
      "const updateQuery = \"UPDATE users SET name = \" + nextName;",
      "const deleteQuery = prefix + \" DELETE FROM sessions WHERE id = \" + sessionId;",
      ""
    ].join("\n");
    const tree = await parseJavaScript(sourceCode);

    const matches = findSqlConcatenations(tree.rootNode, sourceCode);

    expect(matches.map((match) => match.rawSnippet)).toEqual([
      "values + \" INSERT INTO audit_log VALUES ($1)\"",
      "\"UPDATE users SET name = \" + nextName",
      "prefix + \" DELETE FROM sessions WHERE id = \" + sessionId",
      "prefix + \" DELETE FROM sessions WHERE id = \""
    ]);
  });

  test("findSqlConcatenations detects interpolated SQL template literals", async () => {
    const { findSqlConcatenations, parseJavaScript } = require("../remediationEngine");
    const sourceCode = [
      "const safe = `hello ${name}`;",
      "const query = `SELECT * FROM users WHERE id = ${userId}`;",
      ""
    ].join("\n");
    const tree = await parseJavaScript(sourceCode);

    const matches = findSqlConcatenations(tree.rootNode, sourceCode);

    expect(matches.map((match) => match.rawSnippet)).toEqual([
      "`SELECT * FROM users WHERE id = ${userId}`"
    ]);
  });

  test("generateParameterizedFix sends a constrained zero-temperature Chat Completions request", async () => {
    const { generateParameterizedFix, SURGICAL_LLM_SYSTEM_PROMPT } = require("../remediationEngine");
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
                    content: "db.query(\"SELECT * FROM users WHERE id = $1\", [userId])"
                  }
                }
              ],
              usage: {
                prompt_tokens: 11,
                completion_tokens: 7,
                total_tokens: 18
              }
            };
          }
        }
      }
    };
    const logs = [];

    const fix = await generateParameterizedFix("buildSecureQuery(userId)", {
      client: fakeClient,
      log: (message) => logs.push(message),
      model: "test-model"
    });

    expect(fix).toBe("db.query(\"SELECT * FROM users WHERE id = $1\", [userId])");
    expect(requests[0]).toMatchObject({
      model: "test-model",
      messages: [
        { role: "system", content: SURGICAL_LLM_SYSTEM_PROMPT },
        { role: "user", content: "buildSecureQuery(userId)" }
      ],
      temperature: 0
    });
    expect(logs[0]).toContain("[PRO] Pro Engine fix generated. Tokens used: 18 (Prompt: 11, Completion: 7)");
  });

  test("verifySyntaxSafety accepts parseable fragments and rejects ERROR nodes", async () => {
    const { verifySyntaxSafety } = require("../remediationEngine");

    await expect(verifySyntaxSafety("db.query(\"SELECT * FROM users WHERE id = $1\", [userId])")).resolves.toBe(true);
    await expect(verifySyntaxSafety("const query = ")).rejects.toThrow("Remediation Syntax Violation");
  });

  test("generateParameterizedFix deterministically parameterizes simple SQL snippets offline before requesting Pro access", async () => {
    const { generateParameterizedFix } = require("../remediationEngine");

    const result = await generateParameterizedFix("\"SELECT * FROM users WHERE id = \" + userId");

    expect(result).toBe("({ text: \"SELECT * FROM users WHERE id = $1\", values: [userId] })");
  });

  test("generateParameterizedFix skips safely and requires a PreFlight Pro activation when no proxy key exists for unresolved snippets", async () => {
    const {
      ADVANCED_REMEDIATION_REQUIRES_PRO_MESSAGE,
      generateParameterizedFix
    } = require("../remediationEngine");
    const previousEnv = {
      PREFLIGHT_PRO_KEY: process.env.PREFLIGHT_PRO_KEY,
      PREFLIGHT_PRO_LICENSE_KEY: process.env.PREFLIGHT_PRO_LICENSE_KEY
    };
    const warnings = [];
    delete process.env.PREFLIGHT_PRO_KEY;
    delete process.env.PREFLIGHT_PRO_LICENSE_KEY;

    try {
      const rawSnippet = "queryText";
      const result = await generateParameterizedFix(rawSnippet, {
        warn: (message) => warnings.push(message)
      });

      expect(result).toBe(rawSnippet);
      expect(warnings).toEqual([ADVANCED_REMEDIATION_REQUIRES_PRO_MESSAGE]);
      if (false) {
        expect(warnings).toEqual([
        [
          "=========================================",
          "💡 SQL Remediation is available for FREE!",
          "=========================================",
          "To automatically fix SQL injections, get a free API key:",
          "1. Go to Google AI Studio (https://aistudio.google.com/)",
          "2. Generate a free API key.",
          "3. Add it to your IDE/Environment as: GEMINI_API_KEY",
          "=========================================",
          "[SKIP] Skipping LLM SQL remediation for this run."
        ].join("\n")
        ]);
      }
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  test("generateParameterizedFix surfaces the unified Pro engine connection error when the provider request fails", async () => {
    const { generateParameterizedFix, PRO_ENGINE_CONNECTION_ERROR } = require("../remediationEngine");
    const rawSnippet = "buildSecureQuery(userId)";
    const warnings = [];
    const providerFailures = [];
    const fakeClient = {
      chat: {
        completions: {
          create: async () => {
            const error = new Error("404 Provider returned error");
            error.status = 404;
            throw error;
          }
        }
      }
    };

    const result = await generateParameterizedFix(rawSnippet, {
      client: fakeClient,
      model: "test-model",
      onProviderFailure: (error, provider) => providerFailures.push({ error, provider }),
      warn: (message) => warnings.push(message)
    });

    expect(result).toBe(rawSnippet);
    expect(warnings[0]).toBe(PRO_ENGINE_CONNECTION_ERROR);
    expect(providerFailures).toHaveLength(1);
    expect(providerFailures[0].provider.model).toBe("test-model");
  });

  test("generateParameterizedFix routes PreFlight Pro SQL remediation through the live proxy contract", async () => {
    const { generateParameterizedFix, SURGICAL_LLM_SYSTEM_PROMPT } = require("../remediationEngine");
    const requests = [];

    const fix = await generateParameterizedFix("buildSecureQuery(userId)", {
      licenseKey: "PREFLIGHT-BETA-20260610-TEST1",
      transport: async (request) => {
        requests.push(request);
        return {
          content: [
            {
              text: "db.query(\"SELECT * FROM users WHERE id = $1\", [userId])"
            }
          ]
        };
      }
    });

    expect(fix).toBe("db.query(\"SELECT * FROM users WHERE id = $1\", [userId])");
    expect(requests[0]).toMatchObject({
      endpoint: "https://preflight-proxy.vercel.app/api/v1/remediation",
      headers: {
        Authorization: "Bearer PREFLIGHT-BETA-20260610-TEST1",
        "Content-Type": "application/json",
        "X-PreFlight-Pro-Key": "PREFLIGHT-BETA-20260610-TEST1"
      },
      payload: {
        system: SURGICAL_LLM_SYSTEM_PROMPT,
        max_tokens: 900,
        messages: [
          {
            role: "user",
            content: "buildSecureQuery(userId)"
          }
        ]
      }
    });
  });

  test("generateParameterizedFix extracts the code block when the proxy returns explanation text plus markdown", async () => {
    const { generateParameterizedFix } = require("../remediationEngine");

    const fix = await generateParameterizedFix("buildSecureQuery(userId)", {
      licenseKey: "PREFLIGHT-BETA-20260610-TEST1",
      transport: async () => ({
        content: [
          {
            text: [
              "Root Cause: String-built SQL bypasses parameter binding.",
              "```js",
              "db.query(\"SELECT * FROM users WHERE id = $1\", [userId])",
              "```"
            ].join("\n")
          }
        ]
      })
    });

    expect(fix).toBe("db.query(\"SELECT * FROM users WHERE id = $1\", [userId])");
  });

  test("generateParameterizedFix wraps bare SQL proxy output into a query config expression for inline replacement", async () => {
    const { generateParameterizedFix } = require("../remediationEngine");

    const fix = await generateParameterizedFix("buildSecureQuery(userId)", {
      licenseKey: "PREFLIGHT-BETA-20260610-TEST1",
      transport: async () => ({
        content: [
          {
            text: "SELECT * FROM users WHERE id = $1"
          }
        ]
      })
    });

    expect(fix).toBe("({ text: \"SELECT * FROM users WHERE id = $1\", values: [buildSecureQuery(userId)] })");
  });

  test("resolveLlmProvider uses the PreFlight Pro proxy key instead of user-supplied AI keys", () => {
    const { resolveLlmProvider } = require("../remediationEngine");

    expect(resolveLlmProvider({
      PREFLIGHT_PRO_KEY: "PREFLIGHT-BETA-20260610-TEST1",
      MODEL_NAME: "custom-model"
    })).toMatchObject({
      baseURL: "https://preflight-proxy.vercel.app/api/v1/remediation",
      endpoint: "https://preflight-proxy.vercel.app/api/v1/remediation",
      model: "custom-model",
      provider: "preflight-pro"
    });
    expect(resolveLlmProvider({})).toBe(null);
  });

  test("parseMultiFileRemediationJson validates the strict deep remediation structure", () => {
    const { parseMultiFileRemediationJson } = require("../remediationEngine");

    expect(parseMultiFileRemediationJson(JSON.stringify({
      patches: [
        {
          file_path: "app/api/tenant/route.ts",
          action: "update",
          new_content: "export const GET = withTenantGuard(handler);\n"
        }
      ],
      explanation: "Verify tenant isolation manually after applying the wrapper."
    }))).toEqual({
      patches: [
        {
          filePath: "app/api/tenant/route.ts",
          action: "update",
          newContent: "export const GET = withTenantGuard(handler);\n"
        }
      ],
      explanation: "Verify tenant isolation manually after applying the wrapper."
    });

    expect(() => parseMultiFileRemediationJson(JSON.stringify({
      patches: [{ file_path: "../escape.js", action: "update", new_content: "bad" }],
      explanation: "bad path"
    }))).toThrow("Patch file_path must stay inside the workspace");
  });

  test("applyMultiFilePatchSet prompts once and applies update create delete actions", async () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const { applyMultiFilePatchSet } = require("../remediationEngine");
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-deep-remediate-"));
    const prompts = [];
    const output = { text: "", write(chunk) { this.text += String(chunk); } };

    try {
      fs.mkdirSync(path.join(rootDir, "app/api/tenant"), { recursive: true });
      fs.writeFileSync(path.join(rootDir, "app/api/tenant/route.ts"), "export async function GET() {}\n");
      fs.writeFileSync(path.join(rootDir, "app/api/tenant/old.ts"), "remove me\n");

      const result = await applyMultiFilePatchSet({
        patches: [
          {
            filePath: "app/api/tenant/route.ts",
            action: "update",
            newContent: "export const GET = withTenantGuard(handler);\n"
          },
          {
            filePath: "app/api/tenant/policy.ts",
            action: "create",
            newContent: "export const policy = 'tenant';\n"
          },
          {
            filePath: "app/api/tenant/old.ts",
            action: "delete",
            newContent: ""
          }
        ],
        explanation: "Wrap tenant routes and remove stale bypass file."
      }, {
        ask: async (question) => {
          prompts.push(question);
          return "y";
        },
        output,
        rootDir
      });

      expect(prompts).toEqual(["[y/n] Apply entire multi-file architectural patch? "]);
      expect(result).toEqual({ attempted: 3, applied: 3, skipped: 0 });
      expect(fs.readFileSync(path.join(rootDir, "app/api/tenant/route.ts"), "utf8")).toBe("export const GET = withTenantGuard(handler);\n");
      expect(fs.readFileSync(path.join(rootDir, "app/api/tenant/policy.ts"), "utf8")).toBe("export const policy = 'tenant';\n");
      expect(fs.existsSync(path.join(rootDir, "app/api/tenant/old.ts"))).toBe(false);
      expect(output.text).toContain("Wrap tenant routes and remove stale bypass file.");
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("applyMultiFilePatchSet leaves files untouched when declined", async () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const { applyMultiFilePatchSet } = require("../remediationEngine");
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-deep-decline-"));

    try {
      fs.writeFileSync(path.join(rootDir, "route.ts"), "before\n");
      const result = await applyMultiFilePatchSet({
        patches: [
          {
            filePath: "route.ts",
            action: "update",
            newContent: "after\n"
          }
        ],
        explanation: "Decline this."
      }, {
        ask: async () => "n",
        output: { write() {} },
        rootDir
      });

      expect(result).toEqual({ attempted: 1, applied: 0, skipped: 1 });
      expect(fs.readFileSync(path.join(rootDir, "route.ts"), "utf8")).toBe("before\n");
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("applyMultiFilePatchSet refuses MANUAL_REVIEW_REQUIRED payloads before writing files", async () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const { applyMultiFilePatchSet, MANUAL_REVIEW_MESSAGE } = require("../remediationEngine");
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-manual-review-"));
    const output = { text: "", write(chunk) { this.text += String(chunk); } };

    try {
      fs.writeFileSync(path.join(rootDir, "route.ts"), "before\n");
      const result = await applyMultiFilePatchSet(" MANUAL_REVIEW_REQUIRED ", {
        ask: async () => "y",
        output,
        rootDir
      });

      expect(result).toEqual({
        attempted: 0,
        applied: 0,
        skipped: 0,
        manualReviewRequired: true
      });
      expect(output.text).toContain(MANUAL_REVIEW_MESSAGE);
      expect(fs.readFileSync(path.join(rootDir, "route.ts"), "utf8")).toBe("before\n");
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("applyMultiFilePatchSet aborts the whole transaction when a JS patch fails syntax validation", async () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const { applyMultiFilePatchSet, MANUAL_REVIEW_MESSAGE } = require("../remediationEngine");
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-deep-invalid-"));
    const output = { text: "", write(chunk) { this.text += String(chunk); } };

    try {
      fs.mkdirSync(path.join(rootDir, "app/api/tenant"), { recursive: true });
      fs.writeFileSync(path.join(rootDir, "app/api/tenant/route.ts"), "export async function GET() {}\n");
      fs.writeFileSync(path.join(rootDir, "app/api/tenant/policy.ts"), "export const policy = 'before';\n");

      const result = await applyMultiFilePatchSet({
        patches: [
          {
            filePath: "app/api/tenant/route.ts",
            action: "update",
            newContent: "export const GET = (\n"
          },
          {
            filePath: "app/api/tenant/policy.ts",
            action: "update",
            newContent: "export const policy = 'after';\n"
          }
        ],
        explanation: "This invalid patch should never hit disk."
      }, {
        ask: async () => "y",
        output,
        rootDir
      });

      expect(result).toEqual({
        attempted: 2,
        applied: 0,
        skipped: 0,
        manualReviewRequired: true
      });
      expect(output.text).toContain(MANUAL_REVIEW_MESSAGE);
      expect(fs.readFileSync(path.join(rootDir, "app/api/tenant/route.ts"), "utf8")).toBe("export async function GET() {}\n");
      expect(fs.readFileSync(path.join(rootDir, "app/api/tenant/policy.ts"), "utf8")).toBe("export const policy = 'before';\n");
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("applyMultiFilePatchSet accepts valid JSX patches without forcing manual review", async () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const { applyMultiFilePatchSet } = require("../remediationEngine");
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-deep-jsx-"));

    try {
      fs.mkdirSync(path.join(rootDir, "app"), { recursive: true });
      fs.writeFileSync(path.join(rootDir, "app/page.jsx"), "export default function Page() { return null; }\n");

      const result = await applyMultiFilePatchSet({
        patches: [
          {
            filePath: "app/page.jsx",
            action: "update",
            newContent: "export default function Page() { return <main><h1>Safe</h1></main>; }\n"
          }
        ],
        explanation: "Render a safe JSX page."
      }, {
        ask: async () => "y",
        output: { write() {} },
        rootDir
      });

      expect(result).toEqual({ attempted: 1, applied: 1, skipped: 0 });
      expect(fs.readFileSync(path.join(rootDir, "app/page.jsx"), "utf8")).toBe(
        "export default function Page() { return <main><h1>Safe</h1></main>; }\n"
      );
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
