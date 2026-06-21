import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const originalFetch = globalThis.fetch;
const originalProKey = process.env.PREFLIGHT_PRO_KEY;

function makeTempFile(sourceCode: string): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-release-patch-"));
  const filePath = path.join(rootDir, "the-gauntlet-2.js");
  fs.writeFileSync(filePath, sourceCode, "utf8");
  return filePath;
}

describe("release-gate applyAutoPatch", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.PREFLIGHT_PRO_KEY = originalProKey;
    vi.restoreAllMocks();
  });

  test("routes unresolved fast-check findings to the proxy using fuzzer-style remediation schema", async () => {
    const { applyAutoPatch } = await import("../src/release-gate/patcher");
    const originalSource = [
      "const { exec } = require('child_process');",
      "const STRIPE_SECRET_KEY = \"sk_live_PREFLIGHT_DUMMY_KEY_12345\";",
      "router.post('/ping-server', (req, res) => {",
      "  const targetIp = req.body.ip;",
      "  const sysCommand = \"ping -c 4 \" + targetIp;",
      "  exec(sysCommand);",
      "});",
      ""
    ].join("\n");
    const patchedSource = [
      "const { execFile } = require('child_process');",
      "const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;",
      "router.post('/ping-server', (req, res) => {",
      "  const targetIp = String(req.body.ip || '').replace(/[^0-9.]/g, '');",
      "  execFile('ping', ['-c', '4', targetIp]);",
      "});",
      ""
    ].join("\n");
    const filePath = makeTempFile(originalSource);
    let requestBody: any;

    process.env.PREFLIGHT_PRO_KEY = "PREFLIGHT-BETA-20260611-TEST";
    globalThis.fetch = vi.fn(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ code: patchedSource }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as any;

    await expect(
      applyAutoPatch(filePath, [
        "Stripe secret key detected in source content.",
        "Command injection risk: user-controlled input flows into exec(sysCommand).",
        "Potential BOLA/authorization bypass: route updates account-scoped data from request body without an obvious authorization guard."
      ])
    ).resolves.toBe(true);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://preflight-proxy.vercel.app/api/v1/remediation",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer PREFLIGHT-BETA-20260611-TEST",
          "X-PreFlight-Pro-Key": "PREFLIGHT-BETA-20260611-TEST"
        })
      })
    );
    expect(requestBody).toMatchObject({
      filePath,
      sourceCode: originalSource,
      vulnerabilityType: "COMMAND_INJECTION"
    });
    expect(requestBody.executionTrail.join("\n")).toContain("Stripe secret key detected");
    expect(fs.readFileSync(filePath, "utf8")).toContain("process.env.STRIPE_SECRET_KEY");
  });
});
