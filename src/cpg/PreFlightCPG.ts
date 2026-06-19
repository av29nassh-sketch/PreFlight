import type {
  CPGBuildInput,
  CPGEdge,
  CPGEdgeType,
  CPGNode,
  CPGNodeType,
  TaintTraceResult,
  TreeSitterInput,
  TreeSitterSyntaxNode
} from "./types";

interface FileIndex {
  filePath: string;
  rootNode: TreeSitterSyntaxNode;
  sourceCode: string;
  symbols: Map<string, string>;
  functionScopes: Map<string, Set<string>>;
}

interface DataFlowReference {
  symbol: string;
  nodeId: string;
}

const SOURCE_PATTERN =
  /\b(?:req|request)\s*\.\s*(?:query|body|params|headers|cookies|json|formData|nextUrl)|\bsearchParams\b|\bformData\b|\bheaders\s*\(/i;

const CRITICAL_SINK_PATTERN =
  /\.(?:query|execute|raw|rpc)\s*\(|\b(?:query|execute|executeRaw|queryRaw|unsafe)\s*\(|\bsupabase\s*\.\s*rpc\s*\(/i;

const FILE_SYSTEM_SINK_PATTERN = /\b(?:fs\.)?(?:readFile|readFileSync|writeFile|writeFileSync|createReadStream|createWriteStream|unlink|unlinkSync)\s*\(/i;

const AUTH_BOUNDARY_SINK_PATTERN =
  /\b(?:authorize|authenticate|requireRole|requirePermission|checkPermission|verifySession|validateSession|isAdmin|hasRole)\s*\(/i;

const SQL_TEXT_PATTERN = /\b(?:select|insert|update|delete|drop|alter)\b[\s\S]*(?:\+|\$\{)/i;

function rootNodeFromInput(input: TreeSitterInput): TreeSitterSyntaxNode {
  return "rootNode" in input ? input.rootNode : input;
}

function asIterableMap<T>(value: Map<string, T> | Record<string, T>): Map<string, T> {
  return value instanceof Map ? value : new Map(Object.entries(value));
}

function normalizeNodeType(treeSitterType: string): CPGNodeType {
  if (treeSitterType === "program") return "PROGRAM";
  if (treeSitterType === "identifier" || treeSitterType === "shorthand_property_identifier") return "IDENTIFIER";
  if (treeSitterType === "property_identifier") return "PROPERTY_IDENTIFIER";
  if (treeSitterType === "call_expression") return "CALL_EXPRESSION";
  if (treeSitterType === "member_expression" || treeSitterType === "subscript_expression") return "MEMBER_EXPRESSION";
  if (treeSitterType === "variable_declarator") return "VARIABLE_DECLARATOR";
  if (treeSitterType === "assignment_expression" || treeSitterType === "augmented_assignment_expression") return "ASSIGNMENT";
  if (/function|method|arrow_function/.test(treeSitterType)) return "FUNCTION";
  if (treeSitterType === "formal_parameter" || treeSitterType === "required_parameter" || treeSitterType === "optional_parameter") {
    return "PARAMETER";
  }
  if (treeSitterType === "return_statement") return "RETURN";
  if (treeSitterType === "if_statement" || treeSitterType === "ternary_expression") return "IF";
  if (/^(?:for|while|do)_statement$/.test(treeSitterType)) return "LOOP";
  if (/string|number|true|false|null|undefined|template_string/.test(treeSitterType)) return "LITERAL";
  if (treeSitterType === "object" || treeSitterType === "object_pattern") return "OBJECT";
  if (treeSitterType === "array" || treeSitterType === "array_pattern") return "ARRAY";
  return "UNKNOWN";
}

function childForField(node: TreeSitterSyntaxNode, fieldName: string): TreeSitterSyntaxNode | null {
  return typeof node.childForFieldName === "function" ? node.childForFieldName(fieldName) : null;
}

function namedChildren(node: TreeSitterSyntaxNode): TreeSitterSyntaxNode[] {
  const children: TreeSitterSyntaxNode[] = [];
  for (let index = 0; index < node.namedChildCount; index += 1) {
    const child = node.namedChild(index);
    if (child) {
      children.push(child);
    }
  }
  return children;
}

function sourceText(node: TreeSitterSyntaxNode, sourceCode: string): string {
  return sourceCode ? sourceCode.slice(node.startIndex, node.endIndex) : "";
}

function symbolFromNode(node: TreeSitterSyntaxNode, sourceCode: string): string | undefined {
  if (node.type !== "identifier" && node.type !== "property_identifier" && node.type !== "shorthand_property_identifier") {
    return undefined;
  }
  return sourceText(node, sourceCode).trim() || undefined;
}

function collectIdentifierReferences(
  node: TreeSitterSyntaxNode | null,
  sourceCode: string,
  getNodeId: (node: TreeSitterSyntaxNode) => string | undefined,
  references: DataFlowReference[] = []
): DataFlowReference[] {
  if (!node) {
    return references;
  }

  const symbol = symbolFromNode(node, sourceCode);
  const nodeId = getNodeId(node);
  if (symbol && nodeId) {
    references.push({ symbol, nodeId });
  }

  for (const child of namedChildren(node)) {
    collectIdentifierReferences(child, sourceCode, getNodeId, references);
  }

  return references;
}

function stableSyntaxKey(filePath: string, node: TreeSitterSyntaxNode): string {
  return `${filePath}:${node.startIndex}:${node.endIndex}:${node.type}`;
}

export class PreFlightCPG {
  readonly nodes = new Map<string, CPGNode>();
  readonly edges: CPGEdge[] = [];

  private readonly nodeOrder: CPGNode[] = [];
  private readonly nodeIdBySyntaxKey = new Map<string, string>();
  private readonly edgeKeys = new Set<string>();
  private readonly outEdgeIndexesByNumericId = new Map<number, number[]>();
  private readonly pdgOutByNodeId = new Map<string, string[]>();
  private readonly fileIndexes = new Map<string, FileIndex>();

  constructor(input?: CPGBuildInput) {
    if (input) {
      this.ingest(input.astByFile, input.sourceByFile);
    }
  }

  ingest(
    astByFile: Map<string, TreeSitterInput> | Record<string, TreeSitterInput>,
    sourceByFile: Map<string, string> | Record<string, string> = {}
  ): this {
    const astEntries = asIterableMap(astByFile);
    const sourceEntries = asIterableMap(sourceByFile);

    for (const [filePath, astInput] of astEntries) {
      const rootNode = rootNodeFromInput(astInput);
      const sourceCode = sourceEntries.get(filePath) || "";
      const fileIndex: FileIndex = {
        filePath,
        rootNode,
        sourceCode,
        symbols: new Map(),
        functionScopes: new Map()
      };
      this.fileIndexes.set(filePath, fileIndex);
      this.buildAstLayer(fileIndex, rootNode, null);
      this.buildCfgLayer(fileIndex, rootNode);
      this.buildPdgLayer(fileIndex, rootNode);
    }

    return this;
  }

  getNode(id: string): CPGNode | undefined {
    return this.nodes.get(id);
  }

  getNodes(): CPGNode[] {
    return [...this.nodeOrder];
  }

  getEdges(edgeType?: CPGEdgeType): CPGEdge[] {
    return edgeType ? this.edges.filter((edge) => edge.edgeType === edgeType) : [...this.edges];
  }

  getNodeIdForSyntaxNode(filePath: string, node: TreeSitterSyntaxNode): string | undefined {
    return this.nodeIdBySyntaxKey.get(stableSyntaxKey(filePath, node));
  }

  findTaintSources(): CPGNode[] {
    return this.nodeOrder.filter((node) => node.isTaintSource);
  }

  findCriticalSinks(): CPGNode[] {
    return this.nodeOrder.filter((node) => node.isCriticalSink);
  }

  traceTaint(sourceNodeId: string): CPGNode[] {
    return this.traceTaintDetailed(sourceNodeId).path;
  }

  traceTaintDetailed(sourceNodeId: string): TaintTraceResult {
    const sourceNode = this.nodes.get(sourceNodeId);
    if (!sourceNode) {
      return { reachedSink: false, path: [] };
    }

    const queue: string[][] = [[sourceNodeId]];
    const visited = new Set<string>([sourceNodeId]);

    while (queue.length > 0) {
      const path = queue.shift() || [];
      const currentNodeId = path[path.length - 1];
      const currentNode = this.nodes.get(currentNodeId);
      if (!currentNode) {
        continue;
      }

      if (currentNode.isCriticalSink && currentNodeId !== sourceNodeId) {
        const resolvedPath = path.map((nodeId) => this.nodes.get(nodeId)).filter((node): node is CPGNode => Boolean(node));
        return { reachedSink: true, path: resolvedPath, sink: currentNode };
      }

      for (const nextNodeId of this.pdgOutByNodeId.get(currentNodeId) || []) {
        if (visited.has(nextNodeId)) {
          continue;
        }

        visited.add(nextNodeId);
        queue.push([...path, nextNodeId]);
      }
    }

    return { reachedSink: false, path: [] };
  }

  private buildAstLayer(fileIndex: FileIndex, node: TreeSitterSyntaxNode, parentNodeId: string | null): string {
    const nodeId = this.addNode(fileIndex, node);
    if (parentNodeId) {
      this.addEdge(parentNodeId, nodeId, "AST_EDGE", "child");
    }

    for (const child of namedChildren(node)) {
      this.buildAstLayer(fileIndex, child, nodeId);
    }

    return nodeId;
  }

  private buildCfgLayer(fileIndex: FileIndex, node: TreeSitterSyntaxNode): void {
    const children = namedChildren(node);
    const executableChildren = children.filter((child) =>
      /statement|declaration|call_expression|assignment_expression|variable_declarator|if_statement|for_statement|while_statement/.test(child.type)
    );

    for (let index = 0; index < executableChildren.length - 1; index += 1) {
      const from = this.getNodeIdForSyntaxNode(fileIndex.filePath, executableChildren[index]);
      const to = this.getNodeIdForSyntaxNode(fileIndex.filePath, executableChildren[index + 1]);
      if (from && to) {
        this.addEdge(from, to, "CFG_EDGE", "next");
      }
    }

    for (const child of children) {
      this.buildCfgLayer(fileIndex, child);
    }
  }

  private buildPdgLayer(fileIndex: FileIndex, rootNode: TreeSitterSyntaxNode): void {
    this.walk(rootNode, (node) => {
      this.indexFunctionScopes(fileIndex, node);
      this.indexTaintAndSinkNodes(fileIndex, node);
      this.linkVariableDeclarator(fileIndex, node);
      this.linkAssignment(fileIndex, node);
      this.linkCallArguments(fileIndex, node);
      this.linkReturnValue(fileIndex, node);
    });
  }

  private indexFunctionScopes(fileIndex: FileIndex, node: TreeSitterSyntaxNode): void {
    if (!/function|method|arrow_function/.test(node.type)) {
      return;
    }

    const functionNodeId = this.getNodeIdForSyntaxNode(fileIndex.filePath, node);
    if (!functionNodeId) {
      return;
    }

    const parameterNames = new Set<string>();
    const parametersNode = childForField(node, "parameters");
    for (const parameter of namedChildren(parametersNode || node)) {
      const symbol = symbolFromNode(parameter, fileIndex.sourceCode);
      if (symbol) {
        parameterNames.add(symbol);
        const parameterNodeId = this.getNodeIdForSyntaxNode(fileIndex.filePath, parameter);
        if (parameterNodeId) {
          fileIndex.symbols.set(symbol, parameterNodeId);
        }
      }
    }

    fileIndex.functionScopes.set(functionNodeId, parameterNames);
  }

  private indexTaintAndSinkNodes(fileIndex: FileIndex, node: TreeSitterSyntaxNode): void {
    const nodeId = this.getNodeIdForSyntaxNode(fileIndex.filePath, node);
    const cpgNode = nodeId ? this.nodes.get(nodeId) : undefined;
    if (!cpgNode) {
      return;
    }

    const text = sourceText(node, fileIndex.sourceCode);
    const canBeTaintSource =
      node.type === "member_expression" ||
      node.type === "subscript_expression" ||
      node.type === "call_expression" ||
      node.type === "identifier" ||
      node.type === "property_identifier";

    if (canBeTaintSource && SOURCE_PATTERN.test(text)) {
      cpgNode.isTaintSource = true;
    }

    if (node.type === "call_expression" && CRITICAL_SINK_PATTERN.test(text)) {
      cpgNode.isCriticalSink = true;
      cpgNode.sinkKind = "critical-call";
    }

    if (node.type === "call_expression" && FILE_SYSTEM_SINK_PATTERN.test(text)) {
      cpgNode.isCriticalSink = true;
      cpgNode.sinkKind = "file-system";
    }

    if (node.type === "call_expression" && AUTH_BOUNDARY_SINK_PATTERN.test(text)) {
      cpgNode.isCriticalSink = true;
      cpgNode.sinkKind = "auth-boundary";
    }

    if ((node.type === "binary_expression" || node.type === "template_string") && SQL_TEXT_PATTERN.test(text)) {
      cpgNode.isCriticalSink = true;
      cpgNode.sinkKind = "raw-sql-construction";
    }
  }

  private linkVariableDeclarator(fileIndex: FileIndex, node: TreeSitterSyntaxNode): void {
    if (node.type !== "variable_declarator") {
      return;
    }

    const nameNode = childForField(node, "name");
    const valueNode = childForField(node, "value");
    const nameSymbol = nameNode ? symbolFromNode(nameNode, fileIndex.sourceCode) : undefined;
    const nameNodeId = nameNode ? this.getNodeIdForSyntaxNode(fileIndex.filePath, nameNode) : undefined;
    if (!nameSymbol || !nameNodeId) {
      return;
    }

    fileIndex.symbols.set(nameSymbol, nameNodeId);

    const references = collectIdentifierReferences(valueNode, fileIndex.sourceCode, (syntaxNode) =>
      this.getNodeIdForSyntaxNode(fileIndex.filePath, syntaxNode)
    );

    if (valueNode) {
      const valueNodeId = this.getNodeIdForSyntaxNode(fileIndex.filePath, valueNode);
      if (valueNodeId) {
        this.addEdge(valueNodeId, nameNodeId, "PDG_EDGE", "defines");
      }
    }

    for (const reference of references) {
      const sourceDefinitionId = fileIndex.symbols.get(reference.symbol) || reference.nodeId;
      this.addEdge(sourceDefinitionId, nameNodeId, "PDG_EDGE", `flows-to:${nameSymbol}`);
    }
  }

  private linkAssignment(fileIndex: FileIndex, node: TreeSitterSyntaxNode): void {
    if (node.type !== "assignment_expression" && node.type !== "augmented_assignment_expression") {
      return;
    }

    const leftNode = childForField(node, "left") || node.namedChild(0);
    const rightNode = childForField(node, "right") || node.namedChild(1);
    const leftReferences = collectIdentifierReferences(leftNode, fileIndex.sourceCode, (syntaxNode) =>
      this.getNodeIdForSyntaxNode(fileIndex.filePath, syntaxNode)
    );
    const rightReferences = collectIdentifierReferences(rightNode, fileIndex.sourceCode, (syntaxNode) =>
      this.getNodeIdForSyntaxNode(fileIndex.filePath, syntaxNode)
    );

    for (const left of leftReferences) {
      fileIndex.symbols.set(left.symbol, left.nodeId);
      for (const right of rightReferences) {
        const sourceDefinitionId = fileIndex.symbols.get(right.symbol) || right.nodeId;
        this.addEdge(sourceDefinitionId, left.nodeId, "PDG_EDGE", `assigned-to:${left.symbol}`);
      }
    }
  }

  private linkCallArguments(fileIndex: FileIndex, node: TreeSitterSyntaxNode): void {
    if (node.type !== "call_expression") {
      return;
    }

    const callNodeId = this.getNodeIdForSyntaxNode(fileIndex.filePath, node);
    if (!callNodeId) {
      return;
    }

    const argumentsNode = childForField(node, "arguments");
    const references = collectIdentifierReferences(argumentsNode, fileIndex.sourceCode, (syntaxNode) =>
      this.getNodeIdForSyntaxNode(fileIndex.filePath, syntaxNode)
    );

    for (const reference of references) {
      const sourceDefinitionId = fileIndex.symbols.get(reference.symbol) || reference.nodeId;
      this.addEdge(sourceDefinitionId, callNodeId, "PDG_EDGE", "argument");
    }
  }

  private linkReturnValue(fileIndex: FileIndex, node: TreeSitterSyntaxNode): void {
    if (node.type !== "return_statement") {
      return;
    }

    const returnNodeId = this.getNodeIdForSyntaxNode(fileIndex.filePath, node);
    if (!returnNodeId) {
      return;
    }

    const references = collectIdentifierReferences(node, fileIndex.sourceCode, (syntaxNode) =>
      this.getNodeIdForSyntaxNode(fileIndex.filePath, syntaxNode)
    );

    for (const reference of references) {
      const sourceDefinitionId = fileIndex.symbols.get(reference.symbol) || reference.nodeId;
      this.addEdge(sourceDefinitionId, returnNodeId, "PDG_EDGE", "return");
    }
  }

  private addNode(fileIndex: FileIndex, syntaxNode: TreeSitterSyntaxNode): string {
    const syntaxKey = stableSyntaxKey(fileIndex.filePath, syntaxNode);
    const existingNodeId = this.nodeIdBySyntaxKey.get(syntaxKey);
    if (existingNodeId) {
      return existingNodeId;
    }

    const numericId = this.nodeOrder.length;
    const id = `cpg:${numericId}`;
    const text = sourceText(syntaxNode, fileIndex.sourceCode);
    const node: CPGNode = {
      id,
      numericId,
      filePath: fileIndex.filePath,
      treeSitterType: syntaxNode.type,
      nodeType: normalizeNodeType(syntaxNode.type),
      startIndex: syntaxNode.startIndex,
      endIndex: syntaxNode.endIndex,
      line: syntaxNode.startPosition ? syntaxNode.startPosition.row + 1 : undefined,
      column: syntaxNode.startPosition ? syntaxNode.startPosition.column + 1 : undefined,
      text: text || undefined,
      symbol: symbolFromNode(syntaxNode, fileIndex.sourceCode)
    };

    this.nodes.set(id, node);
    this.nodeOrder.push(node);
    this.nodeIdBySyntaxKey.set(syntaxKey, id);
    return id;
  }

  private addEdge(from: string, to: string, edgeType: CPGEdgeType, label?: string): void {
    const fromNode = this.nodes.get(from);
    const toNode = this.nodes.get(to);
    if (!fromNode || !toNode) {
      return;
    }

    const edgeKey = `${from}->${to}:${edgeType}:${label || ""}`;
    if (this.edgeKeys.has(edgeKey)) {
      return;
    }

    const edge: CPGEdge = {
      id: `edge:${this.edges.length}`,
      from,
      to,
      fromNumericId: fromNode.numericId,
      toNumericId: toNode.numericId,
      edgeType,
      label
    };
    this.edgeKeys.add(edgeKey);
    this.edges.push(edge);

    const outEdgeIndexes = this.outEdgeIndexesByNumericId.get(fromNode.numericId) || [];
    outEdgeIndexes.push(this.edges.length - 1);
    this.outEdgeIndexesByNumericId.set(fromNode.numericId, outEdgeIndexes);

    if (edgeType === "PDG_EDGE") {
      const pdgOut = this.pdgOutByNodeId.get(from) || [];
      pdgOut.push(to);
      this.pdgOutByNodeId.set(from, pdgOut);
    }
  }

  private walk(node: TreeSitterSyntaxNode | null, visitor: (node: TreeSitterSyntaxNode) => void): void {
    if (!node) {
      return;
    }

    visitor(node);
    for (const child of namedChildren(node)) {
      this.walk(child, visitor);
    }
  }
}
