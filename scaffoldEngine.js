const fs = require("node:fs/promises");
const path = require("node:path");
const ParserBinding = require("web-tree-sitter");

const Parser = ParserBinding.Parser || ParserBinding.default?.Parser || ParserBinding.default || ParserBinding;
const Language = ParserBinding.Language || ParserBinding.default?.Language;
const SERVER_ONLY_MODULES = new Set(["fs", "node:fs", "pg", "child_process", "node:child_process"]);
const CUSTOM_BACKEND_PATTERN = /(?:^|\/)(?:server|backend|db|data|database)(?:\/|$)/i;

let parserReady;
let javascriptLanguage;

async function initializeParser() {
  if (!parserReady) {
    parserReady = Parser.init?.();
  }

  if (parserReady) {
    await parserReady;
  }

  if (!javascriptLanguage) {
    const wasmPath = require.resolve("tree-sitter-javascript/tree-sitter-javascript.wasm");
    javascriptLanguage = await Language.load(wasmPath);
  }
}

async function parseJavaScript(sourceCode) {
  await initializeParser();
  const parser = new Parser();
  parser.setLanguage(javascriptLanguage);
  return parser.parse(sourceCode);
}

function getNodeText(node, sourceCode) {
  return sourceCode.slice(node.startIndex, node.endIndex);
}

function toByteIndex(sourceCode, stringIndex) {
  return Buffer.byteLength(sourceCode.slice(0, stringIndex), "utf8");
}

function toByteRange(sourceCode, node) {
  const raw = getNodeText(node, sourceCode);
  const startIndex = toByteIndex(sourceCode, node.startIndex);
  return {
    startIndex,
    endIndex: startIndex + Buffer.byteLength(raw, "utf8"),
    raw
  };
}

function childByFieldName(node, fieldName) {
  return typeof node.childForFieldName === "function" ? node.childForFieldName(fieldName) : null;
}

function unquote(value) {
  return value.trim().replace(/;$/, "").trim().replace(/^['"`]|['"`]$/g, "");
}

function walk(node, visitor) {
  if (!node) {
    return;
  }

  visitor(node);
  for (let index = 0; index < node.childCount; index += 1) {
    walk(node.child(index), visitor);
  }
}

function isClientDirective(rootNode, sourceCode) {
  for (let index = 0; index < rootNode.namedChildCount; index += 1) {
    const child = rootNode.namedChild(index);
    if (child.type === "expression_statement" && unquote(getNodeText(child, sourceCode)) === "use client") {
      return true;
    }
  }

  return false;
}

function isServerModule(source) {
  return SERVER_ONLY_MODULES.has(source) || CUSTOM_BACKEND_PATTERN.test(source);
}

function getImportSource(node, sourceCode) {
  for (let index = 0; index < node.namedChildCount; index += 1) {
    const child = node.namedChild(index);
    if (child.type === "string") {
      return unquote(getNodeText(child, sourceCode));
    }
  }

  return null;
}

function collectIdentifiers(node, sourceCode, names = new Set()) {
  if (!node) {
    return names;
  }

  if (node.type === "identifier") {
    names.add(getNodeText(node, sourceCode));
  }

  for (let index = 0; index < node.namedChildCount; index += 1) {
    collectIdentifiers(node.namedChild(index), sourceCode, names);
  }

  return names;
}

function collectServerDependencies(rootNode, sourceCode) {
  const dependencies = [];
  const identifiers = new Set();

  for (let index = 0; index < rootNode.namedChildCount; index += 1) {
    const node = rootNode.namedChild(index);
    if (node.type !== "import_statement") {
      continue;
    }

    const source = getImportSource(node, sourceCode);
    if (!source || !isServerModule(source)) {
      continue;
    }

    dependencies.push(getNodeText(node, sourceCode).trim().replace(/;?$/, ";"));
    for (const identifier of collectIdentifiers(node, sourceCode)) {
      identifiers.add(identifier);
    }
  }

  return { dependencies, identifiers };
}

function nodeContainsServerIdentifier(node, sourceCode, serverIdentifiers) {
  let found = false;
  walk(node, (child) => {
    if (found || child.type !== "identifier") {
      return;
    }

    if (serverIdentifiers.has(getNodeText(child, sourceCode))) {
      found = true;
    }
  });

  return found;
}

function findFunctionContainer(node) {
  let current = node;
  while (current) {
    if (current.type === "function_declaration") {
      return current;
    }

    if (current.type === "lexical_declaration" && isFunctionValuedLexicalDeclaration(current)) {
      return current;
    }

    if (current.type === "arrow_function") {
      let parent = current.parent;
      while (parent) {
        if (parent.type === "lexical_declaration") {
          return parent;
        }
        parent = parent.parent;
      }
      return current;
    }

    current = current.parent;
  }

  return null;
}

function isFunctionValuedLexicalDeclaration(node) {
  for (let index = 0; index < node.namedChildCount; index += 1) {
    const child = node.namedChild(index);
    if (child.type !== "variable_declarator") {
      continue;
    }

    const value = childByFieldName(child, "value");
    if (value?.type === "arrow_function" || value?.type === "function_expression") {
      return true;
    }
  }

  return false;
}

function getFunctionName(container, sourceCode) {
  if (container.type === "function_declaration") {
    const name = childByFieldName(container, "name");
    return name ? getNodeText(name, sourceCode) : "serverAction";
  }

  const declarator = container.type === "lexical_declaration"
    ? Array.from({ length: container.namedChildCount }, (_, index) => container.namedChild(index))
        .find((child) => child.type === "variable_declarator")
    : null;
  const name = declarator ? childByFieldName(declarator, "name") : null;
  return name ? getNodeText(name, sourceCode) : "serverAction";
}

function normalizeExportedFunction(functionText, functionName) {
  const trimmed = functionText.trim();

  if (/^export\s+/.test(trimmed)) {
    return trimmed;
  }

  if (/^(?:const|let|var)\s+/.test(trimmed)) {
    return trimmed.replace(/^(?:const|let|var)\s+/, "export const ");
  }

  if (/^async\s+function\s+/.test(trimmed) || /^function\s+/.test(trimmed)) {
    return trimmed.replace(/^(async\s+)?function\s+([A-Za-z_$][\w$]*)?/, (match, asyncPrefix = "", name = functionName) => {
      return `export const ${name} = ${asyncPrefix || ""}function`;
    });
  }

  return `export const ${functionName} = ${trimmed}`;
}

function findServerSideLeaks(rootNode, sourceCode) {
  if (!isClientDirective(rootNode, sourceCode)) {
    return [];
  }

  const { dependencies, identifiers } = collectServerDependencies(rootNode, sourceCode);
  if (identifiers.size === 0) {
    return [];
  }

  const seen = new Set();
  const leaks = [];
  walk(rootNode, (node) => {
    if (node.type !== "call_expression" && node.type !== "new_expression" && node.type !== "member_expression") {
      return;
    }

    if (!nodeContainsServerIdentifier(node, sourceCode, identifiers)) {
      return;
    }

    const container = findFunctionContainer(node);
    if (!container) {
      return;
    }

    const range = toByteRange(sourceCode, container);
    const seenKey = `${range.startIndex}:${range.endIndex}`;
    if (seen.has(seenKey)) {
      return;
    }

    seen.add(seenKey);
    leaks.push({
      startIndex: range.startIndex,
      endIndex: range.endIndex,
      rawFunctionText: range.raw,
      functionName: getFunctionName(container, sourceCode),
      dependencies: [...new Set(dependencies)]
    });
  });

  return leaks;
}

async function scaffoldServerActionFile(originalFilePath, functionText, functionName, options = {}) {
  const actionFilePath = path.join(path.dirname(originalFilePath), "actions.ts");
  const dependencies = [...new Set(options.dependencies || [])];
  const lines = [
    "\"use server\";",
    "",
    ...dependencies,
    ...(dependencies.length > 0 ? [""] : []),
    normalizeExportedFunction(functionText, functionName),
    ""
  ];

  await fs.writeFile(actionFilePath, lines.join("\n"), "utf8");
  return actionFilePath;
}

function byteSplice(source, startIndex, endIndex, replacement = "") {
  const sourceBytes = Buffer.from(source, "utf8");
  const replacementBytes = Buffer.from(replacement, "utf8");
  return Buffer.concat([
    sourceBytes.subarray(0, startIndex),
    replacementBytes,
    sourceBytes.subarray(endIndex)
  ]).toString("utf8");
}

function getBridgeImportInsertionIndex(source) {
  const directiveMatch = source.match(/^\s*["']use client["']\s*;?[ \t]*(?:\r?\n)?/);
  return directiveMatch ? directiveMatch[0].length : 0;
}

function injectActionBridge(originalSource, startIndex, endIndex, functionName) {
  const withoutFunction = byteSplice(originalSource, startIndex, endIndex, "");
  const bridgeImport = `import { ${functionName} } from './actions';\n`;

  if (withoutFunction.includes(bridgeImport.trim())) {
    return withoutFunction;
  }

  const insertionIndex = getBridgeImportInsertionIndex(withoutFunction);
  return `${withoutFunction.slice(0, insertionIndex)}${bridgeImport}${withoutFunction.slice(insertionIndex)}`;
}

function treeContainsUnsafeNode(node) {
  if (!node) {
    return false;
  }

  const isMissing = typeof node.isMissing === "function" ? node.isMissing() : node.isMissing === true;
  if (node.type === "ERROR" || node.type === "MISSING" || isMissing) {
    return true;
  }

  for (let index = 0; index < node.childCount; index += 1) {
    if (treeContainsUnsafeNode(node.child(index))) {
      return true;
    }
  }

  return false;
}

async function assertSyntaxSafe(sourceCode) {
  const tree = await parseJavaScript(sourceCode);
  try {
    if (treeContainsUnsafeNode(tree.rootNode)) {
      throw new Error("Scaffold Syntax Violation");
    }
  } finally {
    tree.delete?.();
  }
}

async function readExistingFile(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function restoreFile(filePath, contents) {
  if (contents === null) {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    return;
  }

  await fs.writeFile(filePath, contents, "utf8");
}

async function applyScaffoldTransaction(originalFilePath, leak) {
  const actionFilePath = path.join(path.dirname(originalFilePath), "actions.ts");
  const originalClient = await fs.readFile(originalFilePath, "utf8");
  const originalActions = await readExistingFile(actionFilePath);

  try {
    await scaffoldServerActionFile(originalFilePath, leak.rawFunctionText, leak.functionName, {
      dependencies: leak.dependencies || []
    });
    const nextClient = injectActionBridge(originalClient, leak.startIndex, leak.endIndex, leak.functionName);
    await fs.writeFile(originalFilePath, nextClient, "utf8");

    await assertSyntaxSafe(await fs.readFile(actionFilePath, "utf8"));
    await assertSyntaxSafe(await fs.readFile(originalFilePath, "utf8"));

    return {
      status: "APPLIED",
      clientFile: originalFilePath,
      actionFile: actionFilePath
    };
  } catch (error) {
    const rollbackErrors = [];
    for (const [filePath, contents] of [
      [actionFilePath, originalActions],
      [originalFilePath, originalClient]
    ]) {
      try {
        await restoreFile(filePath, contents);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      error.rollbackErrors = rollbackErrors;
    }
    throw error;
  }
}

module.exports = {
  applyScaffoldTransaction,
  findServerSideLeaks,
  injectActionBridge,
  parseJavaScript,
  scaffoldServerActionFile
};
