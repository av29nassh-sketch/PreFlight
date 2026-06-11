const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const roots = [];
const ACTIVATION_MESSAGE = "\u2705 PreFlight Pro activated successfully! Unlimited AI auto-fixes unlocked.";
const EMAIL_MISMATCH_MESSAGE = "\u274c Email does not match the purchase record.";
const EXHAUSTED_MESSAGE =
  "\u26a0\ufe0f Free fixes exhausted (5/5). Upgrade to PreFlight Pro for unlimited AI auto-fixes for a one-time payment of $49 / \u20b91999: https://yourwebsite.com/buy";
const BETA_ACTIVE_RECEIPT =
  "\u26a0\ufe0f Beta License Active \u2014 Unlocked Pro Auto-Fixes (Expires 14 days from issue date).";
const ORG_ACCOUNT_MESSAGE =
  "🔴 Org Account Detected: Enterprise repositories require a PreFlight Teams seat. Please upgrade your license or contact your administrator.";

function makeHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-license-"));
  roots.push(root);
  return root;
}

function readConfigFile(homeDir) {
  return JSON.parse(fs.readFileSync(path.join(homeDir, ".preflight", "config.json"), "utf8"));
}

afterEach(() => {
  vi.useRealTimers();
  while (roots.length > 0) {
    fs.rmSync(roots.pop(), { recursive: true, force: true });
  }
});

describe("licenseManager", () => {
  test("parses GitHub and GitLab remote owners from HTTPS and SSH URLs", () => {
    const { parseRepositoryRemote } = require("../src/licensing/licenseManager");

    expect(parseRepositoryRemote("https://github.com/CompanyOrg/preflight.git")).toEqual({
      host: "github.com",
      owner: "CompanyOrg",
      repo: "preflight",
      remoteUrl: "https://github.com/CompanyOrg/preflight.git"
    });
    expect(parseRepositoryRemote("git@gitlab.com:CompanyOrg/preflight.git")).toEqual({
      host: "gitlab.com",
      owner: "CompanyOrg",
      repo: "preflight",
      remoteUrl: "git@gitlab.com:CompanyOrg/preflight.git"
    });
  });

  test("reads origin URL from the local .git/config without shelling out", () => {
    const { readGitRemoteOriginUrl } = require("../src/licensing/licenseManager");
    const root = makeHome();
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".git", "config"),
      [
        "[core]",
        "  repositoryformatversion = 0",
        "[remote \"origin\"]",
        "  url = git@github.com:CompanyOrg/preflight.git",
        "  fetch = +refs/heads/*:refs/remotes/origin/*",
        ""
      ].join("\n")
    );

    expect(readGitRemoteOriginUrl({ cwd: root })).toBe("git@github.com:CompanyOrg/preflight.git");
  });

  test("blocks a solo Pro key when the repository owner is an organization", async () => {
    const { verifyFixPermission, writeConfig } = require("../src/licensing/licenseManager");
    const homeDir = makeHome();
    const root = makeHome();
    let validated = false;
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".git", "config"),
      ["[remote \"origin\"]", "  url = https://github.com/CompanyOrg/preflight.git", ""].join("\n")
    );
    await writeConfig({ freeFixesUsed: 0, licenseKey: null, instanceId: null }, { homeDir });

    const result = await verifyFixPermission({
      cwd: root,
      env: {
        PREFLIGHT_PRO_KEY: "solo-license-key",
        PREFLIGHT_LICENSE_TIER: "solo"
      },
      homeDir,
      requestLicenseValidation: async () => {
        validated = true;
        return { valid: true };
      }
    });

    expect(validated).toBe(false);
    expect(result).toEqual({
      allowed: false,
      tier: "solo",
      message: ORG_ACCOUNT_MESSAGE,
      repository: {
        host: "github.com",
        owner: "CompanyOrg",
        repo: "preflight",
        remoteUrl: "https://github.com/CompanyOrg/preflight.git"
      }
    });
  });

  test("allows a Teams key on an organization repository", async () => {
    const { verifyFixPermission, writeConfig } = require("../src/licensing/licenseManager");
    const homeDir = makeHome();
    const root = makeHome();
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".git", "config"),
      ["[remote \"origin\"]", "  url = https://github.com/CompanyOrg/preflight.git", ""].join("\n")
    );
    await writeConfig({ freeFixesUsed: 0, licenseKey: null, instanceId: null }, { homeDir });

    const result = await verifyFixPermission({
      cwd: root,
      env: {
        PREFLIGHT_PRO_KEY: "teams-license-key",
        PREFLIGHT_LICENSE_TIER: "teams"
      },
      homeDir,
      requestLicenseValidation: async () => ({ valid: true })
    });

    expect(result).toEqual({ allowed: true, tier: "teams" });
  });

  test("defaults safely when no Git remote origin exists", async () => {
    const { verifyFixPermission, writeConfig } = require("../src/licensing/licenseManager");
    const homeDir = makeHome();
    const root = makeHome();
    await writeConfig({ freeFixesUsed: 0, licenseKey: null, instanceId: null }, { homeDir });

    await expect(verifyFixPermission({ cwd: root, homeDir, env: {} })).resolves.toEqual({
      allowed: true,
      tier: "free",
      remaining: 5
    });
  });

  test("resolves CI environment licenses before the local browser login config", async () => {
    const { resolveStoredLicenseKey, writeConfig } = require("../src/licensing/licenseManager");
    const homeDir = makeHome();
    await writeConfig({ freeFixesUsed: 0, licenseKey: "local-license-key", instanceId: null }, { homeDir });

    await expect(resolveStoredLicenseKey({
      homeDir,
      env: {
        PREFLIGHT_PRO_KEY: "ci-license-key"
      }
    })).resolves.toBe("ci-license-key");
    await expect(resolveStoredLicenseKey({ homeDir, env: {} })).resolves.toBe("local-license-key");
  });

  test("activates a Lemon Squeezy license and saves its instance when purchase email matches", async () => {
    const { activateLicenseKey, readConfig } = require("../src/licensing/licenseManager");
    const homeDir = makeHome();
    const requests = [];

    const result = await activateLicenseKey("license-key", "buyer@example.com", {
      homeDir,
      hostname: () => "workstation",
      requestLicenseActivation: async (request) => {
        requests.push(request);
        return {
          activated: true,
          meta: {
            customer_email: "buyer@example.com"
          },
          instance: {
            id: "instance-id"
          }
        };
      }
    });

    expect(result).toEqual({
      success: true,
      activated: true,
      message: ACTIVATION_MESSAGE,
      instanceId: "instance-id"
    });
    expect(requests).toEqual([
      {
        url: "https://api.lemonsqueezy.com/v1/licenses/activate",
        body: "license_key=license-key&instance_name=workstation"
      }
    ]);
    await expect(readConfig({ homeDir })).resolves.toEqual({
      freeFixesUsed: 0,
      licenseKey: "license-key",
      instanceId: "instance-id"
    });
  });

  test("rejects activation when purchase email does not match and does not save the license", async () => {
    const { activateLicenseKey, readConfig } = require("../src/licensing/licenseManager");
    const homeDir = makeHome();

    const result = await activateLicenseKey("license-key", "other@example.com", {
      homeDir,
      hostname: () => "workstation",
      requestLicenseActivation: async () => ({
        activated: true,
        meta: {
          customer_email: "buyer@example.com"
        },
        instance: {
          id: "instance-id"
        }
      })
    });

    expect(result).toEqual({
      success: false,
      message: EMAIL_MISMATCH_MESSAGE
    });
    await expect(readConfig({ homeDir })).resolves.toEqual({
      freeFixesUsed: 0,
      licenseKey: null,
      instanceId: null
    });
  });

  test("allows free fixes while fewer than five have been used", async () => {
    const { verifyFixPermission, writeConfig } = require("../src/licensing/licenseManager");
    const homeDir = makeHome();
    await writeConfig({ freeFixesUsed: 2, licenseKey: null, instanceId: null }, { homeDir });

    await expect(verifyFixPermission({ homeDir })).resolves.toEqual({
      allowed: true,
      tier: "free",
      remaining: 3
    });
  });

  test("blocks free fixes after the fifth use", async () => {
    const { verifyFixPermission, writeConfig } = require("../src/licensing/licenseManager");
    const homeDir = makeHome();
    await writeConfig({ freeFixesUsed: 5, licenseKey: null, instanceId: null }, { homeDir });

    await expect(verifyFixPermission({ homeDir })).resolves.toEqual({
      allowed: false,
      tier: "free",
      message: EXHAUSTED_MESSAGE
    });
  });

  test("allows a local beta key for 14 days without calling Lemon Squeezy", async () => {
    const { verifyFixPermission, writeConfig } = require("../src/licensing/licenseManager");
    const homeDir = makeHome();
    let validated = false;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T00:00:00.000Z"));
    await writeConfig({ freeFixesUsed: 5, licenseKey: "PREFLIGHT-BETA-20260529-TEST", instanceId: null }, { homeDir });

    const result = await verifyFixPermission({
      homeDir,
      requestLicenseValidation: async () => {
        validated = true;
        return { valid: true };
      }
    });

    expect(validated).toBe(false);
    expect(result).toEqual({
      allowed: true,
      tier: "pro",
      receipt: BETA_ACTIVE_RECEIPT
    });
  });

  test("rejects an expired local beta key before any online validation attempt", async () => {
    const { verifyFixPermission, writeConfig } = require("../src/licensing/licenseManager");
    const homeDir = makeHome();
    let validated = false;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T00:00:00.000Z"));
    await writeConfig({ freeFixesUsed: 5, licenseKey: "PREFLIGHT-BETA-20260520-TEST", instanceId: null }, { homeDir });

    const result = await verifyFixPermission({
      homeDir,
      requestLicenseValidation: async () => {
        validated = true;
        return { valid: true };
      }
    });

    expect(validated).toBe(false);
    expect(result).toEqual({
      allowed: false,
      tier: "pro",
      message: "\u274c Beta license expired. Please request a fresh PreFlight beta key."
    });
  });

  test("validates a complete Lemon Squeezy license as pro", async () => {
    const { verifyFixPermission, writeConfig } = require("../src/licensing/licenseManager");
    const homeDir = makeHome();
    const requests = [];
    await writeConfig({ freeFixesUsed: 5, licenseKey: "license-key", instanceId: "instance-id" }, { homeDir });

    const result = await verifyFixPermission({
      homeDir,
      requestLicenseValidation: async (request) => {
        requests.push(request);
        return { valid: true };
      }
    });

    expect(result).toEqual({ allowed: true, tier: "pro" });
    expect(requests).toEqual([
      {
        url: "https://api.lemonsqueezy.com/v1/licenses/validate",
        body: "license_key=license-key&instance_id=instance-id"
      }
    ]);
  });

  test("scrubs stored license and denies access when online validation is invalid", async () => {
    const { verifyFixPermission, writeConfig } = require("../src/licensing/licenseManager");
    const homeDir = makeHome();
    await writeConfig({ freeFixesUsed: 2, licenseKey: "bad-license", instanceId: "bad-instance" }, { homeDir });

    const result = await verifyFixPermission({
      homeDir,
      requestLicenseValidation: async () => ({ valid: false })
    });

    expect(result).toEqual({
      allowed: false,
      tier: "pro",
      message: "\u274c License is inactive or invalid. Please run 'preflight activate <key>' with a valid key."
    });
    expect(readConfigFile(homeDir)).toEqual({
      freeFixesUsed: 2,
      licenseKey: null,
      instanceId: null
    });
  });

  test("allows paid users when license validation fails offline", async () => {
    const { verifyFixPermission, writeConfig } = require("../src/licensing/licenseManager");
    const homeDir = makeHome();
    await writeConfig({ freeFixesUsed: 5, licenseKey: "license-key", instanceId: "instance-id" }, { homeDir });

    const result = await verifyFixPermission({
      homeDir,
      requestLicenseValidation: async () => {
        const error = new Error("offline");
        error.code = "ENOTFOUND";
        throw error;
      }
    });

    expect(result).toEqual({ allowed: true, tier: "pro", offline: true });
  });

  test("records free usage in ~/.preflight/config.json", async () => {
    const { getConfigPath, recordFreeFixUsage, writeConfig } = require("../src/licensing/licenseManager");
    const homeDir = makeHome();

    await recordFreeFixUsage({ homeDir });
    expect(getConfigPath(homeDir)).toBe(path.join(homeDir, ".preflight", "config.json"));
    expect(readConfigFile(homeDir)).toEqual({
      freeFixesUsed: 1,
      licenseKey: null,
      instanceId: null
    });

    await writeConfig({ freeFixesUsed: 1, licenseKey: "license-key", instanceId: "instance-id" }, { homeDir });
    await recordFreeFixUsage({ homeDir });

    expect(readConfigFile(homeDir)).toEqual({
      freeFixesUsed: 2,
      licenseKey: "license-key",
      instanceId: "instance-id"
    });
  });
});
