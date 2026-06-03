const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const STRIPE_KEY = "sk" + "_live_1234567890abcdef";
const OPENAI_KEY = "sk" + "-proj-abcdef1234567890ABCDEF1234567890";

const roots = [];

function makeProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-malicious-"));
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

describe("malicious PreFlight Pro edge cases", () => {
  test("Byte-Collision Attack: overlapping SQL and credential fixes abort before writing", async () => {
    const { applyScanFixes, scanProject } = require("../index");
    const sourceCode =
      "const db = \"SELECT * FROM users WHERE id = \" + \"" + OPENAI_KEY + "\";\n";
    const root = makeProject({
      "lib/db.js": sourceCode
    });
    const filePath = path.join(root, "lib/db.js");
    const findings = await scanProject(root);

    await expect(
      applyScanFixes(findings, {
        ask: async () => "y",
        generateParameterizedFix: async () => "client.query(\"SELECT * FROM users WHERE id = $1\", [id])"
      })
    ).rejects.toThrow("Overlapping PreFlight fixes");
    expect(fs.readFileSync(filePath, "utf8")).toBe(sourceCode);
  });

  test("UTF-8 Offset Trap: complex emojis before SQL do not shift byte-splice targets", async () => {
    const { applyScanFixes, scanProject } = require("../index");
    const emojiPrefix = "const emojiWall = \"👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦\";";
    const vulnerableSql = "const query = \"SELECT * FROM users WHERE id = \" + userId;";
    const sourceCode = [emojiPrefix, vulnerableSql, "export const marker = true;", ""].join("\n");
    const root = makeProject({
      "lib/db.js": sourceCode
    });
    const filePath = path.join(root, "lib/db.js");
    const findings = await scanProject(root);

    await applyScanFixes(findings, {
      ask: async () => "y",
      generateParameterizedFix: async () => "client.query(\"SELECT * FROM users WHERE id = $1\", [userId])"
    });

    const fixed = fs.readFileSync(filePath, "utf8");
    expect(fixed).toContain(emojiPrefix);
    expect(fixed).toContain("const query = client.query(\"SELECT * FROM users WHERE id = $1\", [userId]);");
    expect(fixed).toContain("export const marker = true;");
    expect(fixed).not.toContain("\"SELECT * FROM users WHERE id = \" + userId");
  });

  test("Taint Evasion: wildcard barrel re-export still leaks into a client component", async () => {
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
      "lib/server.ts": "export const SERVER_SECRET = \"" + STRIPE_KEY + "\";\n",
      "lib/index.ts": "export * from \"./server\";\n",
      "app/Client.tsx": [
        "\"use client\";",
        "import { SERVER_SECRET } from \"../lib\";",
        "export default function Client() {",
        "  return <main>{SERVER_SECRET}</main>;",
        "}"
      ].join("\n")
    });
    const files = [
      path.join(root, "lib/server.ts"),
      path.join(root, "lib/index.ts"),
      path.join(root, "app/Client.tsx")
    ];
    const projectGraph = {};

    for (const filePath of files) {
      const sourceCode = fs.readFileSync(filePath, "utf8");
      const tree = await parseJavaScript(sourceCode);
      try {
        const boundaries = parseModuleBoundaries(tree.rootNode, sourceCode);
        projectGraph[filePath] = {
          isClient: isClientComponent(tree.rootNode, sourceCode),
          taintedSources: findTaintSources(tree.rootNode, sourceCode, credentialRegexes),
          imports: boundaries.imports.map((item) => ({
            ...item,
            source: resolveImportPath(filePath, item.source) || item.source
          })),
          reExports: boundaries.reExports.map((item) => ({
            ...item,
            source: resolveImportPath(filePath, item.source) || item.source
          })),
          exports: boundaries.exports
        };
      } finally {
        tree.delete?.();
      }
    }

    expect(analyzeTaintGraph(projectGraph)).toEqual([
      {
        status: "VIOLATION",
        variable: "SERVER_SECRET",
        sourceFile: path.join(root, "lib/index.ts"),
        leakedFile: path.join(root, "app/Client.tsx")
      }
    ]);
  });

  test("Rollback Sabotage: actions.ts cleanup still runs when client bridge write fails", async () => {
    const { applyScaffoldTransaction } = require("../scaffoldEngine");
    const originalWriteFile = fsPromises.writeFile;
    const root = makeProject({
      "app/Dashboard.tsx": "\"use client\";\nconst placeholder = true;\n"
    });
    const clientPath = path.join(root, "app/Dashboard.tsx");
    const actionsPath = path.join(root, "app/actions.ts");
    const originalClient = fs.readFileSync(clientPath, "utf8");
    const leak = {
      functionName: "loadServerLogs",
      rawFunctionText: "const loadServerLogs = async () => {\n  return \"logs\";\n};",
      startIndex: Buffer.byteLength("\"use client\";\n", "utf8"),
      endIndex: Buffer.byteLength("\"use client\";\nconst placeholder = true;", "utf8"),
      dependencies: []
    };

    fsPromises.writeFile = async (filePath, contents, options) => {
      if (filePath === clientPath) {
        throw new Error("Permission Denied");
      }

      return originalWriteFile.call(fsPromises, filePath, contents, options);
    };

    try {
      await expect(applyScaffoldTransaction(clientPath, leak)).rejects.toThrow("Permission Denied");
      expect(fs.existsSync(actionsPath)).toBe(false);
      expect(fs.readFileSync(clientPath, "utf8")).toBe(originalClient);
    } finally {
      fsPromises.writeFile = originalWriteFile;
    }
  });
});
