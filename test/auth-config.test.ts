import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const originalHome = process.env.PREFLIGHT_HOME;
const originalProKey = process.env.PREFLIGHT_PRO_KEY;
const originalFetch = globalThis.fetch;

describe("PreFlight local auth config", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-auth-home-"));
    process.env.PREFLIGHT_HOME = homeDir;
    delete process.env.PREFLIGHT_PRO_KEY;
  });

  afterEach(async () => {
    process.env.PREFLIGHT_HOME = originalHome;
    process.env.PREFLIGHT_PRO_KEY = originalProKey;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("stores and reads a local Pro license key", async () => {
    const { readStoredLicenseKey, saveLicenseKey } = await import("../src/config/auth");

    await expect(readStoredLicenseKey()).resolves.toBeNull();
    await saveLicenseKey("PREFLIGHT-BETA-20260611-TEST");

    await expect(readStoredLicenseKey()).resolves.toBe("PREFLIGHT-BETA-20260611-TEST");
    await expect(fs.stat(path.join(homeDir, ".preflight", "config.json"))).resolves.toBeTruthy();
  });

  test("remediation patcher injects the saved key when env key is absent", async () => {
    const { saveLicenseKey } = await import("../src/config/auth");
    const { remediateFuzzerFinding } = await import("../src/remediation/patcher");
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-auth-patcher-"));
    const filePath = path.join(tempDir, "route.js");
    let capturedHeaders: Headers;

    await fs.writeFile(filePath, "const safe = true;\n", "utf8");
    await saveLicenseKey("PREFLIGHT-BETA-20260611-SAVED");
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ code: "const safe = false;\n" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as any;

    await expect(
      remediateFuzzerFinding({
        file: filePath,
        type: "SQL_INJECTION",
        severity: "HARD_BLOCK",
        payload: "' OR '1'='1",
        trail: ["req.query.userId", "db.query(sql)"]
      })
    ).resolves.toBe(true);

    expect(capturedHeaders!.get("X-PreFlight-Pro-Key")).toBe("PREFLIGHT-BETA-20260611-SAVED");
    expect(capturedHeaders!.get("Authorization")).toBe("Bearer PREFLIGHT-BETA-20260611-SAVED");
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("remediation patcher explains how to activate when no key is saved", async () => {
    const { remediateFuzzerFinding } = await import("../src/remediation/patcher");
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-auth-missing-"));
    const filePath = path.join(tempDir, "route.js");

    await fs.writeFile(filePath, "const safe = true;\n", "utf8");

    await expect(
      remediateFuzzerFinding({
        file: filePath,
        type: "SQL_INJECTION",
        severity: "HARD_BLOCK",
        payload: "' OR '1'='1",
        trail: ["req.query.userId", "db.query(sql)"]
      })
    ).rejects.toThrow("Auto-Patch requires a Pro license. Run 'preflight auth <your-key>' to activate.");
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("auth command validates and stores a key", async () => {
    const { createProgram } = await import("../src/cli/index");
    const { readStoredLicenseKey } = await import("../src/config/auth");

    let capturedUrl = "";
    let capturedBody: any;
    globalThis.fetch = vi.fn(async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ valid: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as any;

    await createProgram().parseAsync(["node", "preflight", "auth", "PREFLIGHT-BETA-20260611-AUTH"]);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(capturedUrl).toBe("https://preflight-proxy.vercel.app/api/v1/license/validate");
    expect(capturedBody).toEqual({});
    await expect(readStoredLicenseKey()).resolves.toBe("PREFLIGHT-BETA-20260611-AUTH");
  });
});
