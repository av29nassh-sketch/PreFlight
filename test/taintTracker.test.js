const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STRIPE_KEY = "sk" + "_live_1234567890abcdef";

const roots = [];

function makeProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taint-tracker-"));
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

describe("taintTracker", () => {
  test("detects top-level use client directives", async () => {
    const { isClientComponent, parseJavaScript } = require("../taintTracker");
    const sourceCode = [
      "\"use client\";",
      "",
      "export default function Checkout() {",
      "  return null;",
      "}"
    ].join("\n");
    const tree = await parseJavaScript(sourceCode);

    expect(isClientComponent(tree.rootNode, sourceCode)).toBe(true);
  });

  test("finds taint sources by sensitive variable name and credential regex value", async () => {
    const { findTaintSources, parseJavaScript } = require("../taintTracker");
    const credentialRegexes = [
      /\bsk_(?:test|live)_[A-Za-z0-9_=-]{8,}\b/,
      /\bAKIA[0-9A-Z]{16}\b/
    ];
    const sourceCode = [
      "const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;",
      "const publicLabel = \"" + STRIPE_KEY + "\";",
      "const normalName = \"safe\";"
    ].join("\n");
    const tree = await parseJavaScript(sourceCode);

    const taintedSources = findTaintSources(tree.rootNode, sourceCode, credentialRegexes);

    expect([...taintedSources].sort()).toEqual(["STRIPE_SECRET", "publicLabel"]);
  });

  test("parses import and export module boundaries", async () => {
    const { parseModuleBoundaries, parseJavaScript } = require("../taintTracker");
    const sourceCode = [
      "import defaultConfig, { STRIPE_SECRET as localSecret, PUBLIC_KEY } from \"../config\";",
      "import * as db from \"./db\";",
      "export const exposedToken = \"value\";",
      "const localOnly = \"private\";",
      "export { localOnly as renamedLocal };"
    ].join("\n");
    const tree = await parseJavaScript(sourceCode);

    const boundaries = parseModuleBoundaries(tree.rootNode, sourceCode);

    expect(boundaries.imports).toEqual([
      { imported: "default", local: "defaultConfig", source: "../config" },
      { imported: "STRIPE_SECRET", local: "localSecret", source: "../config" },
      { imported: "PUBLIC_KEY", local: "PUBLIC_KEY", source: "../config" },
      { imported: "*", local: "db", source: "./db" }
    ]);
    expect([...boundaries.exports].sort()).toEqual(["exposedToken", "renamedLocal"]);
  });

  test("resolves extensionless relative imports to existing absolute files", () => {
    const { resolveImportPath } = require("../taintTracker");
    const root = makeProject({
      "app/client.tsx": "\"use client\";\n",
      "lib/config.ts": "export const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;\n",
      "lib/db/index.js": "export const DATABASE_URI = process.env.DATABASE_URL;\n"
    });

    expect(resolveImportPath(path.join(root, "app/client.tsx"), "../lib/config")).toBe(
      path.join(root, "lib/config.ts")
    );
    expect(resolveImportPath(path.join(root, "app/client.tsx"), "../lib/db")).toBe(
      path.join(root, "lib/db/index.js")
    );
    expect(resolveImportPath(path.join(root, "app/client.tsx"), "react")).toBe(null);
  });

  test("analyzeTaintGraph flags client imports of server-side tainted exports", () => {
    const { analyzeTaintGraph } = require("../taintTracker");
    const serverFile = path.resolve("lib/config.ts");
    const clientFile = path.resolve("app/checkout.tsx");
    const projectGraph = {
      [serverFile]: {
        isClient: false,
        taintedSources: new Set(["STRIPE_SECRET"]),
        imports: [],
        exports: new Set(["STRIPE_SECRET"])
      },
      [clientFile]: {
        isClient: true,
        taintedSources: new Set(),
        imports: [{ imported: "STRIPE_SECRET", local: "clientSecret", source: serverFile }],
        exports: new Set()
      }
    };

    const violations = analyzeTaintGraph(projectGraph);

    expect(violations).toEqual([
      {
        status: "VIOLATION",
        variable: "clientSecret",
        sourceFile: serverFile,
        leakedFile: clientFile
      }
    ]);
    expect(projectGraph[clientFile].taintedSources.has("clientSecret")).toBe(true);
  });

  test("builds a taint graph from parsed files and resolved relative imports", async () => {
    const {
      analyzeTaintGraph,
      findTaintSources,
      isClientComponent,
      parseJavaScript,
      parseModuleBoundaries,
      resolveImportPath
    } = require("../taintTracker");
    const credentialRegexes = [/\bsk_(?:test|live)_[A-Za-z0-9_=-]{8,}\b/];
    const root = makeProject({
      "app/checkout.tsx": [
        "\"use client\";",
        "import { STRIPE_SECRET } from \"../lib/config\";",
        "export function Checkout() {",
        "  return STRIPE_SECRET;",
        "}"
      ].join("\n"),
      "lib/config.ts": "export const STRIPE_SECRET = \"" + STRIPE_KEY + "\";\n"
    });
    const files = [path.join(root, "app/checkout.tsx"), path.join(root, "lib/config.ts")];
    const projectGraph = {};

    for (const filePath of files) {
      const sourceCode = fs.readFileSync(filePath, "utf8");
      const tree = await parseJavaScript(sourceCode);
      const boundaries = parseModuleBoundaries(tree.rootNode, sourceCode);
      projectGraph[filePath] = {
        isClient: isClientComponent(tree.rootNode, sourceCode),
        taintedSources: findTaintSources(tree.rootNode, sourceCode, credentialRegexes),
        imports: boundaries.imports.map((imported) => ({
          ...imported,
          source: resolveImportPath(filePath, imported.source) || imported.source
        })),
        exports: boundaries.exports
      };
    }

    expect(analyzeTaintGraph(projectGraph)).toEqual([
      {
        status: "VIOLATION",
        variable: "STRIPE_SECRET",
        sourceFile: path.join(root, "lib/config.ts"),
        leakedFile: path.join(root, "app/checkout.tsx")
      }
    ]);
  });

  test("analyzeTaintGraph propagates taint through wildcard barrel re-exports", async () => {
    const {
      analyzeTaintGraph,
      findTaintSources,
      isClientComponent,
      parseJavaScript,
      parseModuleBoundaries,
      resolveImportPath
    } = require("../taintTracker");
    const credentialRegexes = [/\bsk_(?:test|live)_[A-Za-z0-9_=-]{8,}\b/];
    const root = makeProject({
      "app/checkout.tsx": [
        "\"use client\";",
        "import { STRIPE_SECRET } from \"../lib/barrel\";",
        "export function Checkout() {",
        "  return STRIPE_SECRET;",
        "}"
      ].join("\n"),
      "lib/barrel.ts": "export * from \"./secrets\";\n",
      "lib/secrets.ts": "export const STRIPE_SECRET = \"" + STRIPE_KEY + "\";\n"
    });
    const files = [
      path.join(root, "app/checkout.tsx"),
      path.join(root, "lib/barrel.ts"),
      path.join(root, "lib/secrets.ts")
    ];
    const projectGraph = {};

    for (const filePath of files) {
      const sourceCode = fs.readFileSync(filePath, "utf8");
      const tree = await parseJavaScript(sourceCode);
      const boundaries = parseModuleBoundaries(tree.rootNode, sourceCode);
      projectGraph[filePath] = {
        isClient: isClientComponent(tree.rootNode, sourceCode),
        taintedSources: findTaintSources(tree.rootNode, sourceCode, credentialRegexes),
        imports: boundaries.imports.map((imported) => ({
          ...imported,
          source: resolveImportPath(filePath, imported.source) || imported.source
        })),
        reExports: boundaries.reExports.map((item) => ({
          ...item,
          source: resolveImportPath(filePath, item.source) || item.source
        })),
        exports: boundaries.exports
      };
    }

    expect(analyzeTaintGraph(projectGraph)).toEqual([
      {
        status: "VIOLATION",
        variable: "STRIPE_SECRET",
        sourceFile: path.join(root, "lib/barrel.ts"),
        leakedFile: path.join(root, "app/checkout.tsx")
      }
    ]);
  });
});
