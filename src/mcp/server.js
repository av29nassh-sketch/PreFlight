const path = require("node:path");
const {
  recordFreeFixUsage: defaultRecordFreeFixUsage,
  verifyFixPermission: defaultVerifyFixPermission
} = require("../licensing/licenseManager");

async function startMcpServer(options = {}) {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { z } = await import("zod");

  const {
    applyScanFixes,
    auditDependencies,
    cwd = process.cwd(),
    loadPreflightPolicy,
    renderAuditReport,
    renderReport,
    scanProject,
    scanProjectDiff,
    transport = new StdioServerTransport(),
    version = "0.0.0"
  } = options;

  if (!applyScanFixes || !auditDependencies || !loadPreflightPolicy || !renderAuditReport || !renderReport || !scanProject || !scanProjectDiff) {
    throw new Error("PreFlight MCP server requires scanner dependencies.");
  }

  const server = new McpServer({
    name: "preflight-pro",
    version
  });

  registerMcpTools(server, {
    applyScanFixes,
    auditDependencies,
    cwd,
    loadPreflightPolicy,
    renderAuditReport,
    renderReport,
    scanProject,
    scanProjectDiff,
    z
  });

  await server.connect(transport);
  return server;
}

function makeScanProjectSchema(z) {
  return z
    ? z.object({
        directory: z.string().optional().describe("Project directory to scan. Defaults to the current working directory."),
        diff: z.boolean().optional().describe("Scan only changed Git files."),
        format: z.enum(["text", "json"]).optional().describe("Response format.")
      })
    : undefined;
}

function makeAuditDependenciesSchema(z) {
  return z
    ? z.object({
        directory: z.string().optional().describe("Project directory to audit. Defaults to the current working directory."),
        format: z.enum(["text", "json"]).optional().describe("Response format.")
      })
    : undefined;
}

function makePreflightFixSchema(z) {
  return z
    ? z.object({
        directory: z.string().optional().describe("Project directory to fix. Defaults to the current working directory."),
        diff: z.boolean().optional().describe("Fix only changed Git files.")
      })
    : undefined;
}

function registerMcpTools(server, options = {}) {
  const {
    applyScanFixes,
    auditDependencies,
    cwd = process.cwd(),
    loadPreflightPolicy,
    recordFreeFixUsage = defaultRecordFreeFixUsage,
    renderAuditReport,
    renderReport,
    scanProject,
    scanProjectDiff,
    verifyFixPermission = defaultVerifyFixPermission,
    z
  } = options;

  server.registerTool(
    "scan_project",
    {
      title: "Scan Project",
      description: "Run local AST parsing and SQL injection detection only. This tool never runs npm audit or network dependency checks.",
      inputSchema: makeScanProjectSchema(z)
    },
    async ({ directory, diff = false, format = "text" }) => {
      const rootDir = path.resolve(cwd, directory || ".");
      const policy = await loadPreflightPolicy(options.rootDir || rootDir || process.cwd());
      const findings = diff ? await scanProjectDiff(rootDir, { policy }) : await scanProject(rootDir, { policy });
      const text = format === "json" ? JSON.stringify(findings, null, 2) : renderReport(findings, { color: false });

      return {
        content: [{ type: "text", text }]
      };
    }
  );

  server.registerTool(
    "preflight_fix",
    {
      title: "PreFlight Fix",
      description: "Apply supported local PreFlight fixes. This tool is freemium-gated; scan_project remains free.",
      inputSchema: makePreflightFixSchema(z)
    },
    async ({ directory, diff = false }) => {
      const rootDir = path.resolve(cwd, directory || ".");
      const permission = await verifyFixPermission({ cwd: rootDir });
      if (!permission.allowed) {
        return {
          isError: true,
          content: [{ type: "text", text: permission.message }]
        };
      }

      const policy = await loadPreflightPolicy(options.rootDir || rootDir || process.cwd());
      const findings = diff ? await scanProjectDiff(rootDir, { policy }) : await scanProject(rootDir, { policy });
      const fixResult = await applyScanFixes(findings, {
        ask: async () => "y",
        rootDir: options.rootDir || rootDir || process.cwd()
      });

      if (permission.tier === "free" && (fixResult?.applied || 0) > 0) {
        await recordFreeFixUsage();
      }

      return {
        content: [
          {
            type: "text",
            text:
              `${permission.receipt ? `${permission.receipt}\n` : ""}` +
              `PreFlight remediation attempted ${fixResult?.attempted || 0} fix(es): ` +
              `${fixResult?.applied || 0} applied, ${fixResult?.skipped || 0} skipped, ${fixResult?.unsupported || 0} unsupported.\n`
          }
        ]
      };
    }
  );

  server.registerTool(
    "audit_dependencies",
    {
      title: "Audit Dependencies",
      description: "Explicitly run dependency auditing through npm audit. This is separate from scan_project.",
      inputSchema: makeAuditDependenciesSchema(z)
    },
    async ({ directory, format = "text" }) => {
      const rootDir = path.resolve(cwd, directory || ".");
      const result = await auditDependencies(rootDir);
      const text = format === "json" ? JSON.stringify(result, null, 2) : renderAuditReport(result, { color: false });

      return {
        content: [{ type: "text", text }]
      };
    }
  );
}

module.exports = {
  registerMcpTools,
  startMcpServer
};
