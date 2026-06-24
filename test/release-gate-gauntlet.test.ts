import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

function makeTempProject(files: Record<string, string>): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-gauntlet-"));
  for (const [relativePath, source] of Object.entries(files)) {
    const filePath = path.join(rootDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source, "utf8");
  }
  return rootDir;
}

describe("release gate gauntlet coverage", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("flags command injection, BOLA, and Stripe secrets without flagging parameterized template SQL", async () => {
    const { runReleaseGateScan } = await import("../src/release-gate/pipeline");
    const rootDir = makeTempProject({
      "src/api/the-gauntlet-2.js": `
const express = require('express');
const router = express.Router();
const db = require('../db');
const { exec } = require('child_process');

router.get('/safe-users', (req, res) => {
    const table = "users";
    const safeQuery = \`SELECT id, name FROM \${table} WHERE role = ?\`;
    db.execute(safeQuery, [req.query.role], (err, results) => {
        res.json(results);
    });
});

router.post('/ping-server', (req, res) => {
    const targetIp = req.body.ip;
    const sysCommand = "ping -c 4 " + targetIp;
    
    exec(sysCommand, (error, stdout) => {
        if (error) return res.status(500).send("Ping failed");
        res.send(stdout);
    });
});

router.post('/update-billing', (req, res) => {
    const { accountId, newPlan } = req.body;
    db.execute("UPDATE billing SET plan = ? WHERE account_id = ?", [newPlan, accountId]);
    res.send("Billing updated successfully");
});

const STRIPE_SECRET_KEY = "sk_live_PREFLIGHT_DUMMY_KEY_12345";

module.exports = router;
`
    });
    roots.push(rootDir);

    const result = await runReleaseGateScan({ targetDir: rootDir, eyeActive: true });
    const allIssues = [
      ...result.findings.map((finding) => finding.issue),
      ...result.fuzzFindings.map((finding) => finding.issue)
    ].join("\n");

    expect(result.status).toBe("HARD_BLOCK");
    expect(allIssues).toMatch(/Stripe/i);
    expect(allIssues).toMatch(/authorization/i);
    expect(result.fuzzFindings.some((finding) => finding.type === "COMMAND_INJECTION")).toBe(true);
    expect(allIssues).not.toMatch(/safeQuery/i);
  });

  test("scans only changed files during daemon-triggered release gate runs", async () => {
    const { runReleaseGateScan } = await import("../src/release-gate/pipeline");
    const rootDir = makeTempProject({
      "src/api/changed.js": `
const express = require('express');
const router = express.Router();

router.get('/health', (_req, res) => {
  res.json({ ok: true });
});

module.exports = router;
`,
      "src/api/stale-vulnerable.js": `
const { exec } = require('child_process');

router.post('/ping-server', (req, res) => {
    const targetIp = req.body.ip;
    const sysCommand = "ping -c 4 " + targetIp;
    exec(sysCommand, (_error, stdout) => res.send(stdout));
});
`
    });
    roots.push(rootDir);

    const result = await runReleaseGateScan({
      targetDir: rootDir,
      eyeActive: true,
      changedFiles: [path.join(rootDir, "src/api/changed.js")]
    });

    expect(result.status).toBe("PASSED");
    expect(result.findings).toHaveLength(0);
    expect(result.fuzzFindings).toHaveLength(0);
    expect(result.eye.changedFiles).toEqual([path.join("src", "api", "changed.js")]);
  });

  test("does not flag safe execFile argument arrays after command injection remediation", async () => {
    const { runReleaseGateScan } = await import("../src/release-gate/pipeline");
    const rootDir = makeTempProject({
      "src/api/server.js": `
const { execFile } = require('child_process');
const express = require('express');
const app = express();

app.get('/network-test', (req, res) => {
    const userIP = req.query.ip;

    const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    const ipv6Regex = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;

    if (!userIP || (!ipv4Regex.test(userIP) && !ipv6Regex.test(userIP))) {
        return res.status(400).send('Invalid IP address format');
    }

    execFile('ping', ['-c', '4', userIP], (error, stdout, stderr) => {
        if (error) {
            return res.status(500).send(\`Execution error: \${error.message}\`);
        }
        res.send(\`<pre>\${stdout}</pre>\`);
    });
});

app.listen(3000, () => console.log('Server running...'));
`
    });
    roots.push(rootDir);

    const result = await runReleaseGateScan({
      targetDir: rootDir,
      eyeActive: true,
      changedFiles: [path.join(rootDir, "src/api/server.js")]
    });

    expect(result.status).toBe("PASSED");
    expect(result.findings).toHaveLength(0);
    expect(result.fuzzFindings).toHaveLength(0);
  });

  test("classifies inline exec request-query flow as command injection, not SQL injection", async () => {
    const { runReleaseGateScan } = await import("../src/release-gate/pipeline");
    const rootDir = makeTempProject({
      "server.js": `
const { exec } = require("child_process");
const express = require("express");
const app = express();

app.get("/ping", (req, res) => {
  const ip = req.query.ip;
  exec("ping " + ip, (err, stdout) => {
    res.send(stdout);
  });
});
`
    });
    roots.push(rootDir);

    const result = await runReleaseGateScan({
      targetDir: rootDir,
      eyeActive: true,
      changedFiles: [path.join(rootDir, "server.js")]
    });

    expect(result.status).toBe("HARD_BLOCK");
    expect(result.fuzzFindings.some((finding) => finding.type === "COMMAND_INJECTION")).toBe(true);
    expect(result.fuzzFindings.some((finding) => finding.type === "SQL_INJECTION")).toBe(false);
  });

  test("downgrades syntax-corrupted source to a soft warning with no hard block", async () => {
    const { runReleaseGateScan } = await import("../src/release-gate/pipeline");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rootDir = makeTempProject({
      "src/api/broken.js": `
const express = require('express');
const router = express.Router();
router.post('/ping-server', (req, res) => {
    const sysCom mand = "ping -c 4 " + req.body.ip;
    res.send("ok");
});
`
    });
    roots.push(rootDir);

    try {
      const result = await runReleaseGateScan({
        targetDir: rootDir,
        eyeActive: true,
        changedFiles: [path.join(rootDir, "src/api/broken.js")]
      });

      expect(result.status).toBe("PASSED");
      expect(result.findings.some((finding) => /syntax|parser/i.test(finding.issue))).toBe(false);
      expect(result.fuzzFindings).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Soft syntax warning ignored"));
    } finally {
      warnSpy.mockRestore();
    }
  });
});
