const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const roots = [];

function makeHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-login-"));
  roots.push(root);
  return root;
}

function request(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    }).on("error", reject);
  });
}

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop(), { recursive: true, force: true });
  }
});

describe("CLI browser login", () => {
  test("opens the dashboard auth URL and stores the returned license token", async () => {
    const { readConfig } = require("../src/licensing/licenseManager");
    const { startCliLogin } = require("../src/cli/login");
    const homeDir = makeHome();
    let openedUrl;

    const login = await startCliLogin({
      dashboardUrl: "http://localhost:3000",
      homeDir,
      maxAttempts: 1,
      openBrowser: async (url) => {
        openedUrl = url;
      },
      port: 43570,
      timeoutMs: 5000
    });
    const authUrl = new URL(openedUrl);

    expect(authUrl.pathname).toBe("/cli/auth");
    expect(authUrl.searchParams.get("port")).toBe(String(login.port));

    const state = authUrl.searchParams.get("state");
    const callbackUrl = `http://127.0.0.1:${login.port}/callback?token=browser-login-license&state=${state}`;
    await expect(request(callbackUrl)).resolves.toBe(200);
    await expect(login.result).resolves.toEqual(expect.objectContaining({
      state
    }));
    await expect(readConfig({ homeDir })).resolves.toEqual({
      freeFixesUsed: 0,
      instanceId: null,
      licenseKey: "browser-login-license"
    });
  });
});
