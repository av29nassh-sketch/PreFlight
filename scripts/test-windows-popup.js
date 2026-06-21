#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");

const ROOT_DIR = path.resolve(__dirname, "..");
const TARGET_FILE = path.join(ROOT_DIR, "src", "api", "preflight-popup-test.js");
const WS_URL = process.env.PREFLIGHT_DAEMON_WS_URL || "ws://127.0.0.1:9001";

const source = `const express = require("express");
const { exec } = require("child_process");

const router = express.Router();

router.post("/preflight-popup-test", (req, res) => {
  const targetIp = req.body.ip;
  const command = "ping -c 4 " + targetIp;

  exec(command, (_error, stdout) => {
    res.send(stdout);
  });
});

module.exports = router;
`;

function writeFixture() {
  fs.mkdirSync(path.dirname(TARGET_FILE), { recursive: true });
  fs.writeFileSync(TARGET_FILE, source, "utf8");
}

function main() {
  const ws = new WebSocket(WS_URL);
  const timeout = setTimeout(() => {
    ws.close();
    console.error("No HARD_BLOCK broadcast received. Is the daemon running with PREFLIGHT_FORCE_WINDOWS_POPUP=1?");
    process.exitCode = 1;
  }, 15000);

  ws.on("open", () => {
    writeFixture();
    console.log(`Wrote vulnerable fixture: ${path.relative(ROOT_DIR, TARGET_FILE)}`);
    console.log("If the daemon was started with PREFLIGHT_FORCE_WINDOWS_POPUP=1, Windows should show a PreFlight popup.");
  });

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (
      message.type === "HARD_BLOCK" &&
      path.resolve(message.filePath || "").toLowerCase() === TARGET_FILE.toLowerCase()
    ) {
      clearTimeout(timeout);
      console.log(`Daemon detected: ${message.issueType} at ${path.relative(ROOT_DIR, message.filePath)}:${message.line || "?"}`);
      ws.close();
    }
  });

  ws.on("error", (error) => {
    clearTimeout(timeout);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

main();
