import { describe, expect, test } from "vitest";

const { parseJavaScript } = require("../taintTracker");

describe("PreFlightFuzzer", () => {
  test("hard-blocks raw SQL flow from request input to database query", async () => {
    const { PreFlightCPG } = await import("../src/cpg/index");
    const { PreFlightFuzzer } = await import("../src/fuzzer/PreFlightFuzzer");
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
    const fuzzer = new PreFlightFuzzer(cpg);
    const sourceNode = cpg.findTaintSources()[0];
    const sinkNode = cpg.findCriticalSinks().find((node) => node.text?.includes("db.query"));

    expect(sourceNode).toBeTruthy();
    expect(sinkNode).toBeTruthy();

    const result = fuzzer.fuzzPath(sourceNode.numericId, sinkNode!.numericId);

    expect(result?.classification).toBe("HARD_BLOCK");
    expect(result?.vulnerabilityType).toBe("SQL_INJECTION");
    expect(result?.payload).toBe("' OR '1'='1");
    expect(result?.executionTrail.some((node) => node.text?.includes("db.query"))).toBe(true);
  });

  test("does not flag parameterized SQL as an exploitable fuzz path", async () => {
    const { PreFlightCPG } = await import("../src/cpg/index");
    const { PreFlightFuzzer } = await import("../src/fuzzer/PreFlightFuzzer");
    const filePath = "app/api/users/route.ts";
    const source = `
export async function GET(req) {
  const userId = req.query.userId;
  return db.query("SELECT * FROM users WHERE id = $1", [userId]);
}
`;
    const tree = await parseJavaScript(source);
    const cpg = new PreFlightCPG({
      astByFile: { [filePath]: tree },
      sourceByFile: { [filePath]: source }
    });
    const fuzzer = new PreFlightFuzzer(cpg);
    const sourceNode = cpg.findTaintSources()[0];
    const sinkNode = cpg.findCriticalSinks().find((node) => node.text?.includes("db.query"));

    expect(sourceNode).toBeTruthy();
    expect(sinkNode).toBeTruthy();
    expect(fuzzer.fuzzPath(sourceNode.numericId, sinkNode!.numericId)).toBeNull();
  });

  test("infers request parameter keys from taint sources", async () => {
    const { PreFlightCPG } = await import("../src/cpg/index");
    const { PreFlightFuzzer } = await import("../src/fuzzer/PreFlightFuzzer");
    const filePath = "app/api/search/route.ts";
    const source = `
export async function GET(req) {
  const term = req.query.searchTerm;
  return db.query("SELECT * FROM posts WHERE title LIKE '%" + term + "%'");
}
`;
    const tree = await parseJavaScript(source);
    const cpg = new PreFlightCPG({
      astByFile: { [filePath]: tree },
      sourceByFile: { [filePath]: source }
    });
    const fuzzer = new PreFlightFuzzer(cpg);

    expect(fuzzer.extractEntryPoints()[0]?.inferredKeys).toContain("searchTerm");
  });

  test("generates traversal payloads for file-system sinks", async () => {
    const { PreFlightCPG } = await import("../src/cpg/index");
    const { PreFlightFuzzer } = await import("../src/fuzzer/PreFlightFuzzer");
    const filePath = "app/api/files/route.ts";
    const source = `
export async function GET(req) {
  const fileName = req.query.fileName;
  return fs.readFileSync(fileName, "utf8");
}
`;
    const tree = await parseJavaScript(source);
    const cpg = new PreFlightCPG({
      astByFile: { [filePath]: tree },
      sourceByFile: { [filePath]: source }
    });
    const fuzzer = new PreFlightFuzzer(cpg);
    const sourceNode = cpg.findTaintSources()[0];
    const sinkNode = cpg.findCriticalSinks().find((node) => node.text?.includes("readFileSync"));

    expect(sourceNode).toBeTruthy();
    expect(sinkNode).toBeTruthy();

    const result = fuzzer.fuzzPath(sourceNode.numericId, sinkNode!.numericId);

    expect(result?.classification).toBe("HARD_BLOCK");
    expect(result?.vulnerabilityType).toBe("PATH_TRAVERSAL");
    expect(result?.payload).toContain("..");
  });

  test("does not flag validated execFile argument arrays as shell command injection", async () => {
    const { PreFlightCPG } = await import("../src/cpg/index");
    const { PreFlightFuzzer } = await import("../src/fuzzer/PreFlightFuzzer");
    const filePath = "app/api/payment.js";
    const source = `
const { execFile } = require("child_process");

export function POST(req) {
  const paymentProviderHost = req.body.host;
  const hostPattern = /^[a-zA-Z0-9.-]+$/;
  if (!hostPattern.test(paymentProviderHost)) {
    throw new Error("Invalid host");
  }
  return execFile("ping", ["-c", "4", paymentProviderHost]);
}
`;
    const tree = await parseJavaScript(source);
    const cpg = new PreFlightCPG({
      astByFile: { [filePath]: tree },
      sourceByFile: { [filePath]: source }
    });
    const fuzzer = new PreFlightFuzzer(cpg);

    expect(fuzzer.fuzzAll()).toEqual([]);
  });
});
