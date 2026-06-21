import { afterEach, describe, expect, test } from "vitest";

const originalAuthEndpoint = process.env.PREFLIGHT_AUTH_VALIDATE_ENDPOINT;
const originalRemediationEndpoint = process.env.PREFLIGHT_REMEDIATION_ENDPOINT;
const originalProxyEndpoint = process.env.PREFLIGHT_PROXY_ENDPOINT;

afterEach(() => {
  if (originalAuthEndpoint === undefined) {
    delete process.env.PREFLIGHT_AUTH_VALIDATE_ENDPOINT;
  } else {
    process.env.PREFLIGHT_AUTH_VALIDATE_ENDPOINT = originalAuthEndpoint;
  }

  if (originalRemediationEndpoint === undefined) {
    delete process.env.PREFLIGHT_REMEDIATION_ENDPOINT;
  } else {
    process.env.PREFLIGHT_REMEDIATION_ENDPOINT = originalRemediationEndpoint;
  }

  if (originalProxyEndpoint === undefined) {
    delete process.env.PREFLIGHT_PROXY_ENDPOINT;
  } else {
    process.env.PREFLIGHT_PROXY_ENDPOINT = originalProxyEndpoint;
  }
});

describe("PreFlight auth endpoint routing", () => {
  test("does not fall back to remediation endpoints for license validation", async () => {
    const { getAuthValidateEndpoint } = await import("../src/config/auth");

    delete process.env.PREFLIGHT_AUTH_VALIDATE_ENDPOINT;
    process.env.PREFLIGHT_REMEDIATION_ENDPOINT = "https://example.invalid/api/v1/remediation";
    process.env.PREFLIGHT_PROXY_ENDPOINT = "https://example.invalid/api/v1/remediation";

    expect(getAuthValidateEndpoint()).toBe("https://preflight-proxy.vercel.app/api/v1/license/validate");
  });

  test("allows an explicit auth validation endpoint override", async () => {
    const { getAuthValidateEndpoint } = await import("../src/config/auth");

    process.env.PREFLIGHT_AUTH_VALIDATE_ENDPOINT = "https://proxy.example.test/api/v1/license/validate";
    process.env.PREFLIGHT_REMEDIATION_ENDPOINT = "https://example.invalid/api/v1/remediation";

    expect(getAuthValidateEndpoint()).toBe("https://proxy.example.test/api/v1/license/validate");
  });
});
