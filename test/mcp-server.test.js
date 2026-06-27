describe("PreFlight MCP server tools", () => {
  test("registers scan_project and audit_dependencies as independent tools", async () => {
    const { registerMcpTools } = require("../src/mcp/server");
    const registered = [];
    const fakeServer = {
      registerTool(name, definition, handler) {
        registered.push({ name, definition, handler });
      }
    };
    let scanCalled = false;
    let auditCalled = false;
    let licenseChecked = false;

    registerMcpTools(fakeServer, {
      applyScanFixes: async () => ({ attempted: 0, applied: 0, skipped: 0, unsupported: 0 }),
      auditDependencies: async () => {
        auditCalled = true;
        return { vulnerabilities: { total: 0 }, metadata: {} };
      },
      cwd: process.cwd(),
      loadPreflightPolicy: async () => ({}),
      recordFreeFixUsage: async () => {},
      renderAuditReport: () => "audit report\n",
      renderReport: () => "scan report\n",
      scanProject: async () => {
        scanCalled = true;
        return [];
      },
      scanProjectDiff: async () => [],
      verifyFixPermission: async () => {
        licenseChecked = true;
        return { allowed: true, tier: "free" };
      }
    });

    expect(registered.map((tool) => tool.name).sort()).toEqual(["audit_dependencies", "preflight_fix", "scan_project"]);

    const scanTool = registered.find((tool) => tool.name === "scan_project");
    const auditTool = registered.find((tool) => tool.name === "audit_dependencies");
    await scanTool.handler({ directory: ".", diff: false, format: "text" });
    expect(scanCalled).toBe(true);
    expect(auditCalled).toBe(false);
    expect(licenseChecked).toBe(false);

    await auditTool.handler({ directory: ".", format: "text" });
    expect(auditCalled).toBe(true);
  });

  test("scan_project returns plain protocol-safe text in MCP mode", async () => {
    const { registerMcpTools } = require("../src/mcp/server");
    const registered = [];
    const fakeServer = {
      registerTool(name, definition, handler) {
        registered.push({ name, definition, handler });
      }
    };

    registerMcpTools(fakeServer, {
      applyScanFixes: async () => ({ attempted: 0, applied: 0, skipped: 0, unsupported: 0 }),
      auditDependencies: async () => ({ vulnerabilities: { total: 0 }, metadata: {} }),
      cwd: process.cwd(),
      loadPreflightPolicy: async () => ({}),
      recordFreeFixUsage: async () => {},
      renderAuditReport: () => "\x1b[32maudit report\x1b[39m\n",
      renderReport: (findings, options) => (options.color === false ? "PreFlight Check found 0 issues.\n" : "\x1b[32mPreFlight Check found 0 issues.\x1b[39m\n"),
      scanProject: async () => [],
      scanProjectDiff: async () => [],
      verifyFixPermission: async () => ({ allowed: true, tier: "free" })
    });

    const scanTool = registered.find((tool) => tool.name === "scan_project");
    const result = await scanTool.handler({ directory: ".", diff: false, format: "text" });

    expect(result.content[0].text).toBe("PreFlight Check found 0 issues.\n");
    expect(result.content[0].text).not.toMatch(/\x1b\[[0-9;]+m/);
  });

  test("preflight_fix returns an MCP error when free fixes are exhausted", async () => {
    const { registerMcpTools } = require("../src/mcp/server");
    const registered = [];
    const fakeServer = {
      registerTool(name, definition, handler) {
        registered.push({ name, definition, handler });
      }
    };
    const message =
      "\u26a0\ufe0f Free fixes exhausted (10/10). Upgrade to PreFlight Pro for unlimited AI auto-fixes for a one-time payment of $49 / \u20b91999: https://yourwebsite.com/buy";
    let fixCalled = false;

    registerMcpTools(fakeServer, {
      applyScanFixes: async () => {
        fixCalled = true;
        return { attempted: 1, applied: 1, skipped: 0, unsupported: 0 };
      },
      auditDependencies: async () => ({ vulnerabilities: { total: 0 }, metadata: {} }),
      cwd: process.cwd(),
      loadPreflightPolicy: async () => ({}),
      recordFreeFixUsage: async () => {},
      renderAuditReport: () => "audit report\n",
      renderReport: () => "scan report\n",
      scanProject: async () => [{ ruleId: "frontend-secret", fix: { kind: "credential" } }],
      scanProjectDiff: async () => [],
      verifyFixPermission: async () => ({ allowed: false, tier: "free", message })
    });

    const fixTool = registered.find((tool) => tool.name === "preflight_fix");
    const result = await fixTool.handler({ directory: ".", diff: false });

    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: message }]
    });
    expect(fixCalled).toBe(false);
  });

  test("preflight_fix records usage after a successful free-tier fix", async () => {
    const { registerMcpTools } = require("../src/mcp/server");
    const registered = [];
    const fakeServer = {
      registerTool(name, definition, handler) {
        registered.push({ name, definition, handler });
      }
    };
    let recorded = false;

    registerMcpTools(fakeServer, {
      applyScanFixes: async () => ({ attempted: 2, applied: 1, skipped: 1, unsupported: 0 }),
      auditDependencies: async () => ({ vulnerabilities: { total: 0 }, metadata: {} }),
      cwd: process.cwd(),
      loadPreflightPolicy: async () => ({}),
      recordFreeFixUsage: async () => {
        recorded = true;
      },
      renderAuditReport: () => "audit report\n",
      renderReport: () => "scan report\n",
      scanProject: async () => [{ ruleId: "frontend-secret", fix: { kind: "credential" } }],
      scanProjectDiff: async () => [],
      verifyFixPermission: async () => ({ allowed: true, tier: "free", remaining: 9 })
    });

    const fixTool = registered.find((tool) => tool.name === "preflight_fix");
    const result = await fixTool.handler({ directory: ".", diff: false });

    expect(recorded).toBe(true);
    expect(result).toEqual({
      content: [{ type: "text", text: "PreFlight remediation attempted 2 fix(es): 1 applied, 1 skipped, 0 unsupported.\n" }]
    });
  });

  test("preflight_fix does not record usage when no free-tier fixes are applied", async () => {
    const { registerMcpTools } = require("../src/mcp/server");
    const registered = [];
    const fakeServer = {
      registerTool(name, definition, handler) {
        registered.push({ name, definition, handler });
      }
    };
    let recorded = false;

    registerMcpTools(fakeServer, {
      applyScanFixes: async () => ({ attempted: 1, applied: 0, skipped: 1, unsupported: 0 }),
      auditDependencies: async () => ({ vulnerabilities: { total: 0 }, metadata: {} }),
      cwd: process.cwd(),
      loadPreflightPolicy: async () => ({}),
      recordFreeFixUsage: async () => {
        recorded = true;
      },
      renderAuditReport: () => "audit report\n",
      renderReport: () => "scan report\n",
      scanProject: async () => [{ ruleId: "frontend-secret", fix: { kind: "credential" } }],
      scanProjectDiff: async () => [],
      verifyFixPermission: async () => ({ allowed: true, tier: "free", remaining: 9 })
    });

    const fixTool = registered.find((tool) => tool.name === "preflight_fix");
    const result = await fixTool.handler({ directory: ".", diff: false });

    expect(recorded).toBe(false);
    expect(result).toEqual({
      content: [{ type: "text", text: "PreFlight remediation attempted 1 fix(es): 0 applied, 1 skipped, 0 unsupported.\n" }]
    });
  });

  test("preflight_fix includes the beta license receipt before the remediation summary", async () => {
    const { registerMcpTools } = require("../src/mcp/server");
    const registered = [];
    const fakeServer = {
      registerTool(name, definition, handler) {
        registered.push({ name, definition, handler });
      }
    };

    registerMcpTools(fakeServer, {
      applyScanFixes: async () => ({ attempted: 1, applied: 1, skipped: 0, unsupported: 0 }),
      auditDependencies: async () => ({ vulnerabilities: { total: 0 }, metadata: {} }),
      cwd: process.cwd(),
      loadPreflightPolicy: async () => ({}),
      recordFreeFixUsage: async () => {},
      renderAuditReport: () => "audit report\n",
      renderReport: () => "scan report\n",
      scanProject: async () => [{ ruleId: "frontend-secret", fix: { kind: "credential" } }],
      scanProjectDiff: async () => [],
      verifyFixPermission: async () => ({
        allowed: true,
        tier: "pro",
        receipt: "\u26a0\ufe0f Beta License Active \u2014 Unlocked Pro Auto-Fixes."
      })
    });

    const fixTool = registered.find((tool) => tool.name === "preflight_fix");
    const result = await fixTool.handler({ directory: ".", diff: false });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text:
            "\u26a0\ufe0f Beta License Active \u2014 Unlocked Pro Auto-Fixes.\n" +
            "PreFlight remediation attempted 1 fix(es): 1 applied, 0 skipped, 0 unsupported.\n"
        }
      ]
    });
  });

  test("preflight_fix passes the active rootDir into applyScanFixes for deep patch path resolution", async () => {
    const { registerMcpTools } = require("../src/mcp/server");
    const path = require("node:path");
    const registered = [];
    const fakeServer = {
      registerTool(name, definition, handler) {
        registered.push({ name, definition, handler });
      }
    };
    const cwd = path.join(process.cwd(), "workspace-root");
    let receivedOptions = null;

    registerMcpTools(fakeServer, {
      applyScanFixes: async (_findings, options) => {
        receivedOptions = options;
        return { attempted: 1, applied: 1, skipped: 0, unsupported: 0 };
      },
      auditDependencies: async () => ({ vulnerabilities: { total: 0 }, metadata: {} }),
      cwd,
      loadPreflightPolicy: async () => ({}),
      recordFreeFixUsage: async () => {},
      renderAuditReport: () => "audit report\n",
      renderReport: () => "scan report\n",
      scanProject: async () => [{ ruleId: "llm-reasoning", patchSet: { patches: [] } }],
      scanProjectDiff: async () => [],
      verifyFixPermission: async () => ({ allowed: true, tier: "pro" })
    });

    const fixTool = registered.find((tool) => tool.name === "preflight_fix");
    await fixTool.handler({ directory: "nested/project", diff: false });

    expect(receivedOptions).toMatchObject({
      rootDir: path.resolve(cwd, "nested/project")
    });
    expect(typeof receivedOptions.ask).toBe("function");
  });

  test("MCP tools load policy from the active project root instead of the server cwd", async () => {
    const { registerMcpTools } = require("../src/mcp/server");
    const path = require("node:path");
    const registered = [];
    const fakeServer = {
      registerTool(name, definition, handler) {
        registered.push({ name, definition, handler });
      }
    };
    const cwd = path.join(process.cwd(), "workspace-root");
    const policyRoots = [];

    registerMcpTools(fakeServer, {
      applyScanFixes: async () => ({ attempted: 0, applied: 0, skipped: 0, unsupported: 0 }),
      auditDependencies: async () => ({ vulnerabilities: { total: 0 }, metadata: {} }),
      cwd,
      loadPreflightPolicy: async (policyRoot) => {
        policyRoots.push(policyRoot);
        return {};
      },
      recordFreeFixUsage: async () => {},
      renderAuditReport: () => "audit report\n",
      renderReport: () => "scan report\n",
      scanProject: async () => [],
      scanProjectDiff: async () => [],
      verifyFixPermission: async () => ({ allowed: true, tier: "pro" })
    });

    const scanTool = registered.find((tool) => tool.name === "scan_project");
    const fixTool = registered.find((tool) => tool.name === "preflight_fix");

    await scanTool.handler({ directory: "nested/project", diff: false, format: "text" });
    await fixTool.handler({ directory: "nested/project", diff: false });

    expect(policyRoots).toEqual([
      path.resolve(cwd, "nested/project"),
      path.resolve(cwd, "nested/project")
    ]);
  });
});
