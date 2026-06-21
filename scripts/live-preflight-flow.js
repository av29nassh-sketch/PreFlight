#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");

const ROOT_DIR = path.resolve(__dirname, "..");
const TARGET_FILE = path.join(ROOT_DIR, "src", "api", "preflight-live-flow.js");
const WS_URL = process.env.PREFLIGHT_DAEMON_WS_URL || "ws://127.0.0.1:9001";
const WAIT_FOR_FIX_MS = Number(process.env.PREFLIGHT_LIVE_WAIT_MS || 180000);

const vulnerableSource = `const express = require("express");
const { exec } = require("child_process");

const router = express.Router();

router.post("/preflight-live/ping", (req, res) => {
  const targetIp = req.body.ip;
  const command = "ping -c 4 " + targetIp;

  exec(command, (error, stdout) => {
    if (error) {
      return res.status(500).send("Ping failed");
    }

    return res.send(stdout);
  });
});

module.exports = router;
`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureTargetDirectory() {
  fs.mkdirSync(path.dirname(TARGET_FILE), { recursive: true });
}

function writeVulnerableFixture() {
  ensureTargetDirectory();
  fs.writeFileSync(TARGET_FILE, vulnerableSource, "utf8");
}

function isTargetHardBlock(message) {
  return (
    message &&
    message.type === "HARD_BLOCK" &&
    path.resolve(message.filePath || "").toLowerCase() === TARGET_FILE.toLowerCase()
  );
}

function waitForHardBlock() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let resolved = false;
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`Timed out waiting for HARD_BLOCK from ${WS_URL}. Is the daemon running?`));
    }, 15000);

    ws.on("open", async () => {
      console.log(`[1/5] Connected to daemon WebSocket: ${WS_URL}`);
      console.log("[2/5] Writing disposable vulnerable fixture...");
      writeVulnerableFixture();
      console.log(`      ${path.relative(ROOT_DIR, TARGET_FILE)}`);
    });

    ws.on("message", (raw) => {
      if (resolved) {
        return;
      }

      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (!isTargetHardBlock(message)) {
        return;
      }

      clearTimeout(timeout);
      resolved = true;
      console.log("[3/5] Daemon broadcast received:");
      console.log(`      ${message.issueType} at ${path.relative(ROOT_DIR, message.filePath)}:${message.line || "?"}`);
      console.log("      You should now see the red squiggle/lightbulb in the editor.");
      resolve({ ws, alert: message });
    });

    ws.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function waitForRemediation() {
  const startedAt = Date.now();
  let lastContent = fs.existsSync(TARGET_FILE) ? fs.readFileSync(TARGET_FILE, "utf8") : "";

  console.log("[4/5] Click the PreFlight quick fix in the IDE now.");
  console.log("      Waiting for the file to be rewritten by the extension/proxy...");

  while (Date.now() - startedAt < WAIT_FOR_FIX_MS) {
    await sleep(1000);

    if (!fs.existsSync(TARGET_FILE)) {
      continue;
    }

    const currentContent = fs.readFileSync(TARGET_FILE, "utf8");
    if (currentContent === lastContent) {
      continue;
    }

    lastContent = currentContent;
    if (!/\bexec\s*\(/.test(currentContent) && /execFile|spawn|validate|regex|allow/i.test(currentContent)) {
      console.log("[5/5] File changed and unsafe exec() call is gone.");
      console.log("      Live PreFlight flow is working.");
      return;
    }

    console.log("      File changed, but unsafe exec() still appears present. Keep reviewing the patch.");
  }

  throw new Error("Timed out waiting for the extension/proxy to rewrite the file.");
}

async function main() {
  console.log("PreFlight live flow test");
  console.log("========================");
  console.log("Before running this:");
  console.log("  1. Start daemon: node .\\cli.js daemon .");
  console.log("  2. Reload Cursor/VS Code after installing PreFlight Companion.");
  console.log("  3. Open src/api/preflight-live-flow.js when it appears.");
  console.log("");

  const { ws } = await waitForHardBlock();
  try {
    await waitForRemediation();
  } finally {
    ws.close();
  }
}

main().catch((error) => {
  console.error(`Live flow failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
