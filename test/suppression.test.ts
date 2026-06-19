import { describe, expect, test } from "vitest";

const { parseJavaScript } = require("../taintTracker");

async function fuzzSource(source: string) {
  const { PreFlightCPG } = await import("../src/cpg/index");
  const { PreFlightFuzzer } = await import("../src/fuzzer/PreFlightFuzzer");
  const filePath = "app/api/users/route.ts";
  const tree = await parseJavaScript(source);
  const cpg = new PreFlightCPG({
    astByFile: { [filePath]: tree },
    sourceByFile: { [filePath]: source }
  });

  return new PreFlightFuzzer(cpg).fuzzAll();
}

describe("inline PreFlight suppression directives", () => {
  test("suppresses fuzzer findings when preflight-ignore all precedes the taint source", async () => {
    const source = `
export async function GET(req) {
  // preflight-ignore: all
  const userId = req.query.userId;
  const sql = "SELECT * FROM users WHERE id = " + userId;
  return db.query(sql);
}
`;

    await expect(fuzzSource(source)).resolves.toHaveLength(0);
  });

  test("suppresses matching fuzzer findings when a rule-specific directive precedes the taint source", async () => {
    const source = `
export async function GET(req) {
  // preflight-ignore: SQL_INJECTION
  const userId = req.query.userId;
  const sql = "SELECT * FROM users WHERE id = " + userId;
  return db.query(sql);
}
`;

    await expect(fuzzSource(source)).resolves.toHaveLength(0);
  });
});
