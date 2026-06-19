import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const originalFetch = globalThis.fetch;
const originalProKey = process.env.PREFLIGHT_PRO_KEY;

function makeTempFile(sourceCode: string): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-fuzzer-remediate-"));
  const filePath = path.join(rootDir, "route.js");
  fs.writeFileSync(filePath, sourceCode);
  return filePath;
}

describe("remediateFuzzerFinding", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.PREFLIGHT_PRO_KEY = originalProKey;
    vi.restoreAllMocks();
  });

  test("sends fuzzer context to the proxy and applies a valid direct replacement", async () => {
    const { remediateFuzzerFinding } = await import("../src/remediation/patcher");
    const filePath = makeTempFile("const sql = \"SELECT * FROM users WHERE id = \" + userId;\n");
    const patchedCode = "const sql = { text: \"SELECT * FROM users WHERE id = $1\", values: [userId] };\n";
    let requestBody: any;

    process.env.PREFLIGHT_PRO_KEY = "PREFLIGHT-BETA-20260611-TEST";
    globalThis.fetch = vi.fn(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ code: patchedCode }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as any;

    const result = await remediateFuzzerFinding({
      file: filePath,
      type: "SQL_INJECTION",
      severity: "HARD_BLOCK",
      payload: "' OR '1'='1",
      trail: ["req.query.userId", "db.query(sql)"],
      issue: "SQL injection payload reaches query without parameterization."
    });

    expect(result).toBe(true);
    expect(requestBody).toMatchObject({
      filePath,
      sourceCode: "const sql = \"SELECT * FROM users WHERE id = \" + userId;\n",
      vulnerabilityType: "SQL_INJECTION",
      breakingPayload: "' OR '1'='1",
      executionTrail: ["req.query.userId", "db.query(sql)"]
    });
    expect(fs.readFileSync(filePath, "utf8")).toBe(patchedCode);
  });

  test("applies a valid unified diff response", async () => {
    const { remediateFuzzerFinding } = await import("../src/remediation/patcher");
    const filePath = makeTempFile("const sql = \"SELECT * FROM users WHERE id = \" + userId;\n");
    const diff = [
      "--- a/route.js",
      "+++ b/route.js",
      "@@ -1,1 +1,1 @@",
      '-const sql = "SELECT * FROM users WHERE id = " + userId;',
      '+const sql = { text: "SELECT * FROM users WHERE id = $1", values: [userId] };',
      ""
    ].join("\n");

    process.env.PREFLIGHT_PRO_KEY = "PREFLIGHT-BETA-20260611-TEST";
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ patch: diff }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    ) as any;

    await expect(
      remediateFuzzerFinding({
        file: filePath,
        type: "SQL_INJECTION",
        severity: "HARD_BLOCK",
        payload: "' OR '1'='1",
        trail: ["req.query.userId", "db.query(sql)"]
      })
    ).resolves.toBe(true);
    expect(fs.readFileSync(filePath, "utf8")).toContain("values: [userId]");
  });

  test("rejects invalid JavaScript without overwriting the original file", async () => {
    const { remediateFuzzerFinding } = await import("../src/remediation/patcher");
    const originalSource = "const safe = true;\n";
    const filePath = makeTempFile(originalSource);

    process.env.PREFLIGHT_PRO_KEY = "PREFLIGHT-BETA-20260611-TEST";
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ code: "const broken = ;\n" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    ) as any;

    await expect(
      remediateFuzzerFinding({
        file: filePath,
        type: "SQL_INJECTION",
        severity: "HARD_BLOCK",
        payload: "' OR '1'='1",
        trail: ["req.query.userId", "db.query(sql)"]
      })
    ).rejects.toThrow(/syntax validation/i);
    expect(fs.readFileSync(filePath, "utf8")).toBe(originalSource);
  });
});
