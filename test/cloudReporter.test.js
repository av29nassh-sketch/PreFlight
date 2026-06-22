const crypto = require("node:crypto");

describe("cloudReporter", () => {
  test("does not report telemetry without a Pro or Teams key", async () => {
    const { reportTelemetry } = require("../src/telemetry/cloudReporter");
    const requests = [];

    const result = await reportTelemetry(
      [{ ruleId: "ssrf", severity: "high", filePath: "app/api/proxy/route.ts" }],
      { remoteUrl: "https://github.com/acme/app.git", owner: "acme", repo: "app" },
      null,
      {
        env: {},
        request: async (request) => {
          requests.push(request);
        }
      }
    );

    expect(result).toEqual({ skipped: true, reason: "missing_license_key" });
    expect(requests).toEqual([]);
  });

  test("maps local findings and signs telemetry payloads", async () => {
    const { reportTelemetry } = require("../src/telemetry/cloudReporter");
    const requests = [];
    const licenseKey = "test-pro-key";

    const result = await reportTelemetry(
      [
        {
          ruleId: "ssrf",
          severity: "high",
          filePath: "app/api/proxy/route.ts",
          state: "yellow",
          line: 12,
          evidence: "fetch(\"sk_live_DO_NOT_SEND\")",
          message: "Leaked token sk_live_DO_NOT_SEND",
          deployedConsequence: "Raw code: fetch(secret)",
          actionRequired: "Inspect token"
        },
        {
          ruleId: "backend-secret",
          severity: "critical",
          filePath: "server/db.ts"
        }
      ],
      {
        remoteUrl: "git@github.com:CompanyOrg/preflight.git",
        host: "github.com",
        owner: "CompanyOrg",
        repo: "preflight"
      },
      licenseKey,
      {
        env: {
          PREFLIGHT_CLOUD_URL: "https://dashboard.preflight.dev",
          PREFLIGHT_TELEMETRY_SECRET: "telemetry-secret"
        },
        request: async (request) => {
          requests.push(request);
          return { ok: true, statusCode: 202 };
        },
        now: () => 1710000000123
      }
    );

    expect(result).toEqual({ reported: true, statusCode: 202 });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://dashboard.preflight.dev/api/v1/telemetry/report");
    expect(requests[0].headers["Content-Type"]).toBe("application/json");
    expect(requests[0].headers["X-PreFlight-Signature"]).toMatch(/^sha256=/);

    const body = JSON.parse(requests[0].body);
    const expectedSignature = crypto
      .createHmac("sha256", "telemetry-secret")
      .update(requests[0].body)
      .digest("hex");

    expect(requests[0].headers["X-PreFlight-Signature"]).toBe(`sha256=${expectedSignature}`);
    expect(requests[0].body).not.toContain("sk_live_PREFLIGHT_DUMMY_KEY_12345");
    expect(requests[0].body).not.toContain("fetch(secret)");
    expect(body).toMatchObject({
      licenseKey,
      source: "cli",
      timestamp: 1710000000123,
      workspace: {
        remoteUrl: "git@github.com:CompanyOrg/preflight.git",
        host: "github.com",
        owner: "CompanyOrg",
        repo: "preflight"
      }
    });
    expect(body.findings).toEqual([
      {
        ruleId: "ssrf",
        severity: "HIGH",
        state: "YELLOW",
        filePath: "app/api/proxy/route.ts",
        metadata: {}
      },
      {
        ruleId: "backend-secret",
        severity: "CRITICAL",
        state: "RED",
        filePath: "server/db.ts",
        metadata: {}
      }
    ]);
  });

  test("uses PREFLIGHT_TEAMS_KEY when a direct license key is not supplied", async () => {
    const { reportTelemetry } = require("../src/telemetry/cloudReporter");
    const requests = [];

    const result = await reportTelemetry(
      [{ ruleId: "auth-drift", severity: "warning", filePath: "middleware.ts" }],
      { repo: "app" },
      undefined,
      {
        env: {
          PREFLIGHT_TEAMS_KEY: "teams-key",
          PREFLIGHT_CLOUD_URL: "https://dashboard.preflight.dev"
        },
        request: async (request) => {
          requests.push(request);
          return { ok: true, statusCode: 200 };
        }
      }
    );

    expect(result).toEqual({ reported: true, statusCode: 200 });
    expect(JSON.parse(requests[0].body).licenseKey).toBe("teams-key");
  });
});
