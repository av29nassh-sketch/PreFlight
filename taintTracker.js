const fs = require("node:fs");
const path = require("node:path");
const ParserBinding = require("web-tree-sitter");

const Parser = ParserBinding.Parser || ParserBinding.default?.Parser || ParserBinding.default || ParserBinding;
const Language = ParserBinding.Language || ParserBinding.default?.Language;
const TAINT_NAME_PATTERN = /(?:SECRET|KEY|TOKEN|URI)/i;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

let parserReady;
let javascriptLanguage;
let typescriptLanguage;
let tsxLanguage;

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

async function loadLanguageForFile(filePath = "") {
  await initializeParser();
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".tsx") {
    if (!tsxLanguage) {
      tsxLanguage = await Language.load(path.join(__dirname, "wasm", "tree-sitter-tsx.wasm"));
    }

    return tsxLanguage;
  }

  if (extension === ".ts") {
    if (!typescriptLanguage) {
      typescriptLanguage = await Language.load(path.join(__dirname, "wasm", "tree-sitter-typescript.wasm"));
    }

    return typescriptLanguage;
  }

  return javascriptLanguage;
}

async function parseSourceCode(sourceCode, filePath = "") {
  const language = await loadLanguageForFile(filePath);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser.parse(sourceCode);
}

function getNodeText(node, sourceCode) {
  return sourceCode.slice(node.startIndex, node.endIndex);
}

function unquote(value) {
  return value.trim().replace(/;$/, "").trim().replace(/^['"`]|['"`]$/g, "");
}

function childByFieldName(node, fieldName) {
  return typeof node.childForFieldName === "function" ? node.childForFieldName(fieldName) : null;
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

function isClientComponent(rootNode, sourceCode) {
  for (let index = 0; index < rootNode.namedChildCount; index += 1) {
    const child = rootNode.namedChild(index);
    if (child.type !== "expression_statement") {
      continue;
    }

    if (unquote(getNodeText(child, sourceCode)) === "use client") {
      return true;
    }
  }

  return false;
}

function getDeclaratorName(node, sourceCode) {
  const nameNode = childByFieldName(node, "name");
  return nameNode ? getNodeText(nameNode, sourceCode) : null;
}

function getDeclaratorValue(node) {
  return childByFieldName(node, "value");
}

function matchesAnyCredentialRegex(value, credentialRegexes = []) {
  return credentialRegexes.some((regex) => {
    if (!(regex instanceof RegExp)) {
      return false;
    }

    regex.lastIndex = 0;
    return regex.test(value);
  });
}

function findTaintSources(rootNode, sourceCode, credentialRegexes = []) {
  const taintedSources = new Set();

  walk(rootNode, (node) => {
    if (node.type !== "variable_declarator") {
      return;
    }

    const variableName = getDeclaratorName(node, sourceCode);
    if (!variableName) {
      return;
    }

    const valueNode = getDeclaratorValue(node);
    const value = valueNode ? getNodeText(valueNode, sourceCode) : "";
    if (TAINT_NAME_PATTERN.test(variableName) || matchesAnyCredentialRegex(value, credentialRegexes)) {
      taintedSources.add(variableName);
    }
  });

  return taintedSources;
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

function getImportSource(node, sourceCode) {
  for (let index = 0; index < node.namedChildCount; index += 1) {
    const child = node.namedChild(index);
    if (child.type === "string") {
      return unquote(getNodeText(child, sourceCode));
    }
  }

  return null;
}

function collectImportClause(node, sourceCode, source, imports) {
  if (!node || node.type === "string") {
    return;
  }

  if (node.type === "identifier") {
    imports.push({ imported: "default", local: getNodeText(node, sourceCode), source });
    return;
  }

  if (node.type === "import_specifier") {
    const nameNode = childByFieldName(node, "name");
    const aliasNode = childByFieldName(node, "alias");
    if (nameNode) {
      imports.push({
        imported: getNodeText(nameNode, sourceCode),
        local: getNodeText(aliasNode || nameNode, sourceCode),
        source
      });
    }
    return;
  }

  if (node.type === "namespace_import") {
    const name = [...collectIdentifiers(node, sourceCode)][0];
    if (name) {
      imports.push({ imported: "*", local: name, source });
    }
    return;
  }

  for (let index = 0; index < node.namedChildCount; index += 1) {
    collectImportClause(node.namedChild(index), sourceCode, source, imports);
  }
}

function collectExportNames(node, sourceCode, exports) {
  if (!node) {
    return;
  }

  if (node.type === "variable_declarator") {
    const name = getDeclaratorName(node, sourceCode);
    if (name) {
      exports.add(name);
    }
    return;
  }

  if (node.type === "export_specifier") {
    const aliasNode = childByFieldName(node, "alias");
    const nameNode = childByFieldName(node, "name");
    const name = aliasNode || nameNode;
    if (name) {
      exports.add(getNodeText(name, sourceCode));
    }
    return;
  }

  if (node.type === "function_declaration" || node.type === "class_declaration") {
    const name = childByFieldName(node, "name");
    if (name) {
      exports.add(getNodeText(name, sourceCode));
    }
    return;
  }

  for (let index = 0; index < node.namedChildCount; index += 1) {
    collectExportNames(node.namedChild(index), sourceCode, exports);
  }
}

function collectReExportSpecifiers(node, sourceCode, source, reExports) {
  if (!node) {
    return;
  }

  if (node.type === "export_specifier") {
    const nameNode = childByFieldName(node, "name");
    const aliasNode = childByFieldName(node, "alias");
    if (nameNode) {
      const imported = getNodeText(nameNode, sourceCode);
      reExports.push({
        imported,
        exported: getNodeText(aliasNode || nameNode, sourceCode),
        source
      });
    }
    return;
  }

  for (let index = 0; index < node.namedChildCount; index += 1) {
    collectReExportSpecifiers(node.namedChild(index), sourceCode, source, reExports);
  }
}

function parseModuleBoundaries(rootNode, sourceCode) {
  const imports = [];
  const exports = new Set();
  const reExports = [];

  for (let index = 0; index < rootNode.namedChildCount; index += 1) {
    const node = rootNode.namedChild(index);

    if (node.type === "import_statement") {
      const source = getImportSource(node, sourceCode);
      if (source) {
        for (let childIndex = 0; childIndex < node.namedChildCount; childIndex += 1) {
          collectImportClause(node.namedChild(childIndex), sourceCode, source, imports);
        }
      }
    }

    if (node.type === "export_statement") {
      const source = getImportSource(node, sourceCode);
      if (source) {
        const text = getNodeText(node, sourceCode);
        if (/^\s*export\s+\*/.test(text)) {
          reExports.push({ imported: "*", exported: "*", source });
        } else {
          collectReExportSpecifiers(node, sourceCode, source, reExports);
        }
      }
      collectExportNames(node, sourceCode, exports);
    }
  }

  return { imports, exports, reExports };
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveImportPath(fromFile, importSource) {
  if (!importSource.startsWith(".")) {
    return null;
  }

  const basePath = path.resolve(path.dirname(fromFile), importSource);
  const extension = path.extname(basePath);
  const candidates = extension
    ? [basePath]
    : [
        ...SOURCE_EXTENSIONS.map((ext) => `${basePath}${ext}`),
        ...SOURCE_EXTENSIONS.map((ext) => path.join(basePath, `index${ext}`))
      ];

  return candidates.find(fileExists) || null;
}

function resolveGraphImport(sourceFile, imported) {
  if (imported.source && path.isAbsolute(imported.source)) {
    return imported.source;
  }

  if (imported.source && imported.source.startsWith(".")) {
    return resolveImportPath(sourceFile, imported.source);
  }

  return null;
}

function analyzeTaintGraph(projectGraph) {
  const violations = [];
  let changed = true;

  while (changed) {
    changed = false;

    for (const [filePath, fileNode] of Object.entries(projectGraph)) {
      for (const reExport of fileNode.reExports || []) {
        const sourceFile = resolveGraphImport(filePath, reExport);
        const sourceNode = sourceFile ? projectGraph[sourceFile] : null;
        if (!sourceNode) {
          continue;
        }

        if (reExport.imported === "*") {
          for (const taintedName of sourceNode.taintedSources || []) {
            if (!fileNode.taintedSources.has(taintedName)) {
              fileNode.taintedSources.add(taintedName);
              fileNode.exports?.add?.(taintedName);
              changed = true;
            }
          }
          continue;
        }

        if (sourceNode.taintedSources?.has(reExport.imported) && !fileNode.taintedSources.has(reExport.exported)) {
          fileNode.taintedSources.add(reExport.exported);
          fileNode.exports?.add?.(reExport.exported);
          changed = true;
        }
      }

      for (const imported of fileNode.imports || []) {
        const sourceFile = resolveGraphImport(filePath, imported);
        const sourceNode = sourceFile ? projectGraph[sourceFile] : null;
        if (!sourceNode) {
          continue;
        }

        const sourceName = imported.imported === "default" || imported.imported === "*" ? imported.local : imported.imported;
        if (sourceNode.taintedSources?.has(sourceName) && !fileNode.taintedSources.has(imported.local)) {
          fileNode.taintedSources.add(imported.local);
          changed = true;
        }
      }
    }
  }

  for (const [filePath, fileNode] of Object.entries(projectGraph)) {
    if (!fileNode.isClient) {
      continue;
    }

    for (const imported of fileNode.imports || []) {
      const sourceFile = resolveGraphImport(filePath, imported);
      const sourceNode = sourceFile ? projectGraph[sourceFile] : null;
      if (!sourceNode) {
        continue;
      }

      const sourceName = imported.imported === "default" || imported.imported === "*" ? imported.local : imported.imported;
      if (sourceNode.taintedSources?.has(sourceName)) {
        violations.push({
          status: "VIOLATION",
          variable: imported.local,
          sourceFile,
          leakedFile: filePath
        });
      }
    }
  }

  return violations;
}

module.exports = {
  analyzeTaintGraph,
  findTaintSources,
  isClientComponent,
  parseJavaScript,
  parseSourceCode,
  parseModuleBoundaries,
  resolveImportPath
};
