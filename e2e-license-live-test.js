const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const {
  activateLicenseKey,
  recordFreeFixUsage,
  verifyFixPermission
} = require("./src/licensing/licenseManager.js");

const CONFIG_DIR = path.join(os.homedir(), ".preflight");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

function setLocalState(state) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(state, null, 2), "utf8");
}

function getLocalState() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
}

const originalHttpsRequest = https.request;
let mockResponseData = null;
let mockNetworkError = false;

https.request = function mockHttpsRequest(options, requestOptions, callback) {
  const responseCallback = typeof requestOptions === "function" ? requestOptions : callback;

  if (mockNetworkError) {
    const req = {
      on(event, handler) {
        if (event === "error") {
          setTimeout(() => {
            const error = new Error("ECONNREFUSED: Network down");
            error.code = "ECONNREFUSED";
            handler(error);
          }, 10);
        }
        return req;
      },
      write() {},
      end() {}
    };
    return req;
  }

  const res = {
    setEncoding() {},
    on(event, handler) {
      if (event === "data") {
        handler(Buffer.from(JSON.stringify(mockResponseData || {})));
      }
      if (event === "end") {
        handler();
      }
      return res;
    }
  };

  if (responseCallback) {
    responseCallback(res);
  }

  return {
    on() {},
    write() {},
    end() {}
  };
};

async function runLiveTests() {
  console.log("Starting Live E2E License Gate Tests...\n");
  let passed = 0;
  let failed = 0;

  const assert = (condition, message) => {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed += 1;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed += 1;
    }
  };

  console.log("SCENARIO 1: Fresh Free Tier User");
  setLocalState({ freeFixesUsed: 0, licenseKey: null, instanceId: null });
  let status = await verifyFixPermission();
  assert(status.allowed === true && status.tier === "free", "Allowed access on free tier.");

  await recordFreeFixUsage();
  assert(getLocalState().freeFixesUsed === 1, "Counter successfully incremented to 1.");
  console.log("");

  console.log("SCENARIO 2: Free Tier Exhausted (Paywall)");
  setLocalState({ freeFixesUsed: 5, licenseKey: null, instanceId: null });
  status = await verifyFixPermission();
  assert(status.allowed === false, "Access denied when max fixes reached.");
  assert(status.message && status.message.includes("Free fixes exhausted"), "Displayed correct paywall message.");
  console.log("");

  console.log("SCENARIO 3: Lemon Squeezy Activation");
  mockResponseData = {
    activated: true,
    meta: {
      customer_email: "buyer@example.com"
    },
    instance: { id: "mock_inst_123" }
  };
  mockNetworkError = false;

  const actStatus = await activateLicenseKey("live_test_key_xyz", "buyer@example.com");
  assert(actStatus.success === true, "Activation returned success.");

  const savedState = getLocalState();
  assert(
    savedState.licenseKey === "live_test_key_xyz" && savedState.instanceId === "mock_inst_123",
    "License key and instance ID securely stored in config."
  );
  console.log("");

  console.log("SCENARIO 4: The Loophole (Revoked Key Online)");
  setLocalState({ freeFixesUsed: 5, licenseKey: "revoked_key", instanceId: "mock_inst_123" });
  mockResponseData = { valid: false };
  mockNetworkError = false;

  status = await verifyFixPermission();
  assert(status.allowed === false, "Access explicitly denied for revoked key.");

  const scrubbedState = getLocalState();
  assert(
    scrubbedState.licenseKey === null && scrubbedState.instanceId === null,
    "Config file was successfully scrubbed to prevent bypass."
  );
  console.log("");

  console.log("SCENARIO 5: Offline Grace Period Fallback");
  setLocalState({ freeFixesUsed: 5, licenseKey: "valid_key", instanceId: "mock_inst_123" });
  mockNetworkError = true;

  status = await verifyFixPermission();
  assert(
    status.allowed === true && status.tier === "pro" && status.offline === true,
    "Allowed offline access to prevent locking out Pro users."
  );
  console.log("");

// --- SCENARIO 6: Email Verification Check ---
    console.log("📋 SCENARIO 6: Email Ownership Mismatch");
    setLocalState({ freeFixesUsed: 5, licenseKey: null, instanceId: null });
    
    // Mock the Lemon Squeezy response with the real buyer's email
    mockResponseData = { 
        activated: true, 
        instance: { id: "mock_inst_999" },
        meta: { customer_email: "buyer@real.com" }
    };
    mockNetworkError = false;
    
    // Attempt to activate with the WRONG email
    const emailStatus = await activateLicenseKey("live_test_key_xyz", "pirate@fake.com");
    
    assert(emailStatus.success === false, "Activation blocked due to email mismatch.");
    assert(emailStatus.message.includes("Email"), "Returned exact email mismatch error.");
    
    const failedState = getLocalState();
    assert(failedState.licenseKey === null, "Config file remained secure and did not save the key.");
    console.log("");

  console.log("-------------------------------------------------");
  if (failed === 0) {
    console.log(`🎉 ALL TESTS PASSED (${passed}/${passed}). Ready to ship.`);
  } else {
    console.log(`⚠️ FAILED TESTS: ${failed}. Check logic.`);
  }

  https.request = originalHttpsRequest;
  process.exitCode = failed === 0 ? 0 : 1;
}

runLiveTests().finally(() => {
  https.request = originalHttpsRequest;
});
