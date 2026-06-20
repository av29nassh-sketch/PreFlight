import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FuzzResult } from "../src/fuzzer/PreFlightFuzzer";

const { parseJavaScript } = require("../taintTracker");

const originalFetch = globalThis.fetch;
const originalPreflightProKey = process.env.PREFLIGHT_PRO_KEY;
const originalRemediationEndpoint = process.env.PREFLIGHT_REMEDIATION_ENDPOINT;
const originalProxyEndpoint = process.env.PREFLIGHT_PROXY_ENDPOINT;

async function runAstCpgFuzzerPipeline(filePath: string): Promise<FuzzResult[]> {
  const { PreFlightCPG } = await import("../src/cpg/index");
  const { PreFlightFuzzer } = await import("../src/fuzzer/PreFlightFuzzer");
  const sourceCode = await fs.readFile(filePath, "utf8");
  const tree = await parseJavaScript(sourceCode);
  const cpg = new PreFlightCPG({
    astByFile: { [filePath]: tree },
    sourceByFile: { [filePath]: sourceCode }
  });
  const fuzzer = new PreFlightFuzzer(cpg);

  return fuzzer.fuzzAll();
}

function toRemediationFinding(result: FuzzResult) {
  return {
    file: result.sink.filePath,
    type: result.vulnerabilityType,
    severity: result.classification,
    payload: result.payload,
    trail: result.executionTrail.map((node) => node.text || node.nodeType),
    issue: result.reason
  };
}

describe("PreFlight E2E security pipeline", () => {
  let workspaceDir: string;
  let routeFile: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-e2e-pipeline-"));
    routeFile = path.join(workspaceDir, "app", "api", "users", "route.ts");
    await fs.mkdir(path.dirname(routeFile), { recursive: true });
    await fs.writeFile(
      routeFile,
      [
        "export async function GET(req) {",
        "  const userId = req.query.userId;",
        "  const sql = \"SELECT * FROM users WHERE id = \" + userId;",
        "  return db.query(sql);",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );

    process.env.PREFLIGHT_PRO_KEY = "PREFLIGHT-BETA-20260611-E2E";
    delete process.env.PREFLIGHT_REMEDIATION_ENDPOINT;
    delete process.env.PREFLIGHT_PROXY_ENDPOINT;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    process.env.PREFLIGHT_PRO_KEY = originalPreflightProKey;
    process.env.PREFLIGHT_REMEDIATION_ENDPOINT = originalRemediationEndpoint;
    process.env.PREFLIGHT_PROXY_ENDPOINT = originalProxyEndpoint;
    vi.restoreAllMocks();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  test("AST -> CPG -> Fuzzer -> remediation handoff -> AST re-verification", async () => {
    const { remediateFuzzerFinding } = await import("../src/remediation/patcher");
    const initialResults = await runAstCpgFuzzerPipeline(routeFile);
    const hardBlock = initialResults[0];

    expect(initialResults).toHaveLength(1);
    expect(hardBlock.classification).toBe("HARD_BLOCK");
    expect(hardBlock.vulnerabilityType).toBe("SQL_INJECTION");
    expect(hardBlock.payload).toBe("' OR '1'='1");
    expect(hardBlock.executionTrail.map((node) => node.text).join("\n")).toContain("req.query.userId");
    expect(hardBlock.executionTrail.map((node) => node.text).join("\n")).toContain("db.query");

    const patchedRoute = [
      "export async function GET(req) {",
      "  const userId = req.query.userId;",
      "  return db.query(\"SELECT * FROM users WHERE id = $1\", [userId]);",
      "}",
      ""
    ].join("\n");
    let capturedUrl = "";
    let capturedBody: any;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ code: patchedRoute }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const remediated = await remediateFuzzerFinding(toRemediationFinding(hardBlock));

    expect(remediated).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(capturedUrl).toBe("https://preflight-proxy.vercel.app/api/v1/remediation");
    expect(capturedBody).toMatchObject({
      filePath: routeFile,
      vulnerabilityType: "SQL_INJECTION",
      breakingPayload: "' OR '1'='1"
    });
    expect(capturedBody.sourceCode).toContain('"SELECT * FROM users WHERE id = " + userId');
    expect(capturedBody.executionTrail.join("\n")).toContain("db.query");
    await expect(fs.readFile(routeFile, "utf8")).resolves.toBe(patchedRoute);

    const postRemediationResults = await runAstCpgFuzzerPipeline(routeFile);
    expect(postRemediationResults).toHaveLength(0);
  });
});
