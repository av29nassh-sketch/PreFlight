import { describe, expect, test } from "vitest";

const { parseJavaScript } = require("../taintTracker");

describe("PreFlightCPG", () => {
  test("traces request input through a variable into a raw database sink", async () => {
    const { PreFlightCPG } = await import("../src/cpg/index");
    const filePath = "app/api/users/route.ts";
    const source = `
export async function GET(req) {
  const userId = req.query.userId;
  const sql = "SELECT * FROM users WHERE id = " + userId;
  return db.query(sql);
}
`;
    const tree = await parseJavaScript(source);
    const cpg = new PreFlightCPG({
      astByFile: { [filePath]: tree },
      sourceByFile: { [filePath]: source }
    });

    const sourceNode = cpg.findTaintSources()[0];
    expect(sourceNode).toBeTruthy();

    const trace = cpg.traceTaintDetailed(sourceNode.id);
    expect(trace.reachedSink).toBe(true);
    expect(trace.sink?.text).toContain("db.query");
    expect(trace.path.map((node) => node.nodeType)).toContain("CALL_EXPRESSION");
  });

  test("exposes AST, CFG, and PDG edge families", async () => {
    const { PreFlightCPG } = await import("../src/cpg/index");
    const filePath = "app/actions.ts";
    const source = `
export async function action(request) {
  const body = await request.json();
  const id = body.id;
  return supabase.rpc("lookup", { id });
}
`;
    const tree = await parseJavaScript(source);
    const cpg = new PreFlightCPG({
      astByFile: { [filePath]: tree },
      sourceByFile: { [filePath]: source }
    });

    expect(cpg.getEdges("AST_EDGE").length).toBeGreaterThan(0);
    expect(cpg.getEdges("CFG_EDGE").length).toBeGreaterThan(0);
    expect(cpg.getEdges("PDG_EDGE").length).toBeGreaterThan(0);
  });
});
