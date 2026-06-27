const http = require("node:http");

describe("preflight proxy beta license lifecycle", () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };
  let server;
  let baseUrl;
  let records;

  function createJsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" }
    });
  }

  function extractTokenFromUrl(url) {
    const parsed = new URL(url);
    const keyFilter = parsed.searchParams.get("key_string") || "";
    return keyFilter.startsWith("eq.") ? keyFilter.slice(3) : "";
  }

  beforeEach(async () => {
    vi.resetModules();
    process.env = {
      ...originalEnv,
      SUPABASE_URL: "https://supabase.example.test",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
      ANTHROPIC_KEY: "test-anthropic-key"
    };

    records = new Map();
    global.fetch = vi.fn(async (url, options = {}) => {
      const token = extractTokenFromUrl(String(url));
      const record = records.get(token);

      if ((options.method || "GET").toUpperCase() === "PATCH") {
        if (!record || record.activated_at !== null) {
          return createJsonResponse([]);
        }

        const patch = JSON.parse(String(options.body || "{}"));
        const updated = {
          ...record,
          activated_at: patch.activated_at,
          expires_at: patch.expires_at
        };
        records.set(token, updated);
        return createJsonResponse([updated]);
      }

      return createJsonResponse(record ? [record] : []);
    });

    const app = require("../preflight-proxy/server");
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    global.fetch = originalFetch;
    process.env = originalEnv;
  });

  test("license validation checks existence without starting the activation clock", async () => {
    const token = "PREFLIGHT-BETA-20260611-LIFECYCLE1";
    records.set(token, {
      key_string: token,
      activated_at: null,
      expires_at: null
    });

    const response = await originalFetch(`${baseUrl}/api/v1/license/validate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ valid: true });
    expect(records.get(token)).toMatchObject({
      activated_at: null,
      expires_at: null
    });
  });

  test("first remediation request activates a beta key for exactly fourteen days", async () => {
    const token = "PREFLIGHT-BETA-20260611-LIFECYCLE2";
    records.set(token, {
      key_string: token,
      activated_at: null,
      expires_at: null
    });

    const response = await originalFetch(`${baseUrl}/api/v1/remediation`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({})
    });

    expect(response.status).toBe(400);
    const record = records.get(token);
    expect(record.activated_at).toEqual(expect.any(String));
    expect(record.expires_at).toEqual(expect.any(String));

    const activatedAt = new Date(record.activated_at).getTime();
    const expiresAt = new Date(record.expires_at).getTime();
    expect(expiresAt - activatedAt).toBe(14 * 24 * 60 * 60 * 1000);
  });

  test("first remediation request preserves a pre-seeded lifetime expiry", async () => {
    const token = "PREFLIGHT-BETA-20260627-LIFETIME1";
    const lifetimeExpiry = "9999-12-31T23:59:59Z";
    records.set(token, {
      key_string: token,
      activated_at: null,
      expires_at: lifetimeExpiry
    });

    const response = await originalFetch(`${baseUrl}/api/v1/remediation`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({})
    });

    expect(response.status).toBe(400);
    const record = records.get(token);
    expect(record.activated_at).toEqual(expect.any(String));
    expect(record.expires_at).toBe(lifetimeExpiry);
  });

  test("expired activated beta keys are rejected", async () => {
    const token = "PREFLIGHT-BETA-20260611-LIFECYCLE3";
    records.set(token, {
      key_string: token,
      activated_at: "2026-01-01T00:00:00.000Z",
      expires_at: "2026-01-15T00:00:00.000Z"
    });

    const response = await originalFetch(`${baseUrl}/api/v1/license/validate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Beta License Expired" });
  });
});
