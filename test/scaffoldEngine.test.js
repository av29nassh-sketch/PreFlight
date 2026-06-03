const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const roots = [];

function makeProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scaffold-engine-"));
  roots.push(root);

  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, contents);
  }

  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop(), { recursive: true, force: true });
  }
});

describe("scaffoldEngine", () => {
  test("findServerSideLeaks extracts server-only functions from client components", async () => {
    const { findServerSideLeaks, parseJavaScript } = require("../scaffoldEngine");
    const sourceCode = [
      "\"use client\";",
      "",
      "import fs from \"fs\";",
      "import { Pool } from \"pg\";",
      "",
      "const loadCheckout = async (userId: string) => {",
      "  const pool = new Pool();",
      "  return fs.readFileSync(\"./secret.txt\", \"utf8\") + userId;",
      "};",
      "",
      "export function Checkout() {",
      "  return null;",
      "}",
      ""
    ].join("\r\n");
    const tree = await parseJavaScript(sourceCode);

    const leaks = findServerSideLeaks(tree.rootNode, sourceCode);

    expect(leaks).toHaveLength(1);
    expect(leaks[0]).toMatchObject({
      functionName: "loadCheckout",
      rawFunctionText: [
        "const loadCheckout = async (userId: string) => {",
        "  const pool = new Pool();",
        "  return fs.readFileSync(\"./secret.txt\", \"utf8\") + userId;",
        "};"
      ].join("\r\n"),
      dependencies: [
        "import fs from \"fs\";",
        "import { Pool } from \"pg\";"
      ]
    });
    expect(leaks[0].startIndex).toBe(
      Buffer.byteLength(sourceCode.slice(0, sourceCode.indexOf("const loadCheckout")), "utf8")
    );
    expect(leaks[0].endIndex).toBe(leaks[0].startIndex + Buffer.byteLength(leaks[0].rawFunctionText, "utf8"));
  });

  test("scaffoldServerActionFile writes use server, dependencies, and exported function text", async () => {
    const { scaffoldServerActionFile } = require("../scaffoldEngine");
    const root = makeProject({
      "app/checkout/page.tsx": "\"use client\";\n"
    });
    const originalFilePath = path.join(root, "app/checkout/page.tsx");

    const actionPath = await scaffoldServerActionFile(
      originalFilePath,
      "const loadCheckout = async () => {\n  return fs.readFileSync(\"./secret.txt\", \"utf8\");\n};",
      "loadCheckout",
      {
        dependencies: ["import fs from \"fs\";"]
      }
    );

    expect(actionPath).toBe(path.join(root, "app/checkout/actions.ts"));
    expect(fs.readFileSync(actionPath, "utf8")).toBe([
      "\"use server\";",
      "",
      "import fs from \"fs\";",
      "",
      "export const loadCheckout = async () => {",
      "  return fs.readFileSync(\"./secret.txt\", \"utf8\");",
      "};",
      ""
    ].join("\n"));
  });

  test("injectActionBridge removes the backend function and preserves use client directive", () => {
    const { injectActionBridge } = require("../scaffoldEngine");
    const functionText = "const loadCheckout = async () => {\n  return db.query(\"select 1\");\n};";
    const originalSource = [
      "\"use client\";",
      "",
      "import { db } from \"../lib/db\";",
      "",
      functionText,
      "",
      "export function Checkout() {",
      "  return null;",
      "}",
      ""
    ].join("\n");
    const startIndex = Buffer.byteLength(originalSource.slice(0, originalSource.indexOf(functionText)), "utf8");
    const endIndex = startIndex + Buffer.byteLength(functionText, "utf8");

    const updated = injectActionBridge(originalSource, startIndex, endIndex, "loadCheckout");

    expect(updated).toContain("\"use client\";\nimport { loadCheckout } from './actions';");
    expect(updated).not.toContain("return db.query");
    expect(updated).toContain("export function Checkout()");
  });

  test("applyScaffoldTransaction writes both files when parsed output is safe", async () => {
    const { applyScaffoldTransaction, findServerSideLeaks, parseJavaScript } = require("../scaffoldEngine");
    const root = makeProject({
      "app/checkout/page.tsx": [
        "\"use client\";",
        "import fs from \"fs\";",
        "",
        "const loadCheckout = async () => {",
        "  return fs.readFileSync(\"./secret.txt\", \"utf8\");",
        "};",
        "",
        "export function Checkout() {",
        "  return null;",
        "}",
        ""
      ].join("\n")
    });
    const clientPath = path.join(root, "app/checkout/page.tsx");
    const sourceCode = fs.readFileSync(clientPath, "utf8");
    const tree = await parseJavaScript(sourceCode);
    const [leak] = findServerSideLeaks(tree.rootNode, sourceCode);

    const result = await applyScaffoldTransaction(clientPath, leak);

    expect(result).toEqual({
      status: "APPLIED",
      clientFile: clientPath,
      actionFile: path.join(root, "app/checkout/actions.ts")
    });
    expect(fs.readFileSync(clientPath, "utf8")).toContain("import { loadCheckout } from './actions';");
    expect(fs.readFileSync(clientPath, "utf8")).not.toContain("fs.readFileSync");
    expect(fs.readFileSync(path.join(root, "app/checkout/actions.ts"), "utf8")).toContain("export const loadCheckout");
  });

  test("applyScaffoldTransaction rolls back if generated files fail syntax validation", async () => {
    const { applyScaffoldTransaction } = require("../scaffoldEngine");
    const root = makeProject({
      "app/page.tsx": "\"use client\";\nconst existing = true;\n"
    });
    const clientPath = path.join(root, "app/page.tsx");
    const originalClient = fs.readFileSync(clientPath, "utf8");
    const leak = {
      functionName: "broken",
      rawFunctionText: "const broken = async () => {\n  return 1;\n};",
      startIndex: Buffer.byteLength("\"use client\";\n", "utf8"),
      endIndex: Buffer.byteLength("\"use client\";\nconst existing = true;", "utf8"),
      dependencies: ["import { broken from \"./broken\";"]
    };

    await expect(applyScaffoldTransaction(clientPath, leak)).rejects.toThrow("Scaffold Syntax Violation");

    expect(fs.readFileSync(clientPath, "utf8")).toBe(originalClient);
    expect(fs.existsSync(path.join(root, "app/actions.ts"))).toBe(false);
  });

  test("applyScaffoldTransaction removes orphaned actions file even if client rollback fails", async () => {
    const fsPromises = require("node:fs/promises");
    const { applyScaffoldTransaction } = require("../scaffoldEngine");
    const originalWriteFile = fsPromises.writeFile;
    const root = makeProject({
      "app/page.tsx": "\"use client\";\nconst existing = true;\n"
    });
    const clientPath = path.join(root, "app/page.tsx");
    const actionsPath = path.join(root, "app/actions.ts");
    const leak = {
      functionName: "loadLogs",
      rawFunctionText: "const loadLogs = async () => {\n  return 1;\n};",
      startIndex: Buffer.byteLength("\"use client\";\n", "utf8"),
      endIndex: Buffer.byteLength("\"use client\";\nconst existing = true;", "utf8"),
      dependencies: []
    };

    fsPromises.writeFile = async (filePath, contents, options) => {
      if (filePath === clientPath) {
        throw new Error("simulated client permission failure");
      }
      return originalWriteFile.call(fsPromises, filePath, contents, options);
    };

    try {
      await expect(applyScaffoldTransaction(clientPath, leak)).rejects.toThrow("simulated client permission failure");
      expect(fs.existsSync(actionsPath)).toBe(false);
    } finally {
      fsPromises.writeFile = originalWriteFile;
    }
  });
});
