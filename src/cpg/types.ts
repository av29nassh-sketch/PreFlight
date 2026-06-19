export type CPGNodeType =
  | "PROGRAM"
  | "IDENTIFIER"
  | "PROPERTY_IDENTIFIER"
  | "CALL_EXPRESSION"
  | "MEMBER_EXPRESSION"
  | "VARIABLE_DECLARATOR"
  | "ASSIGNMENT"
  | "FUNCTION"
  | "PARAMETER"
  | "RETURN"
  | "IF"
  | "LOOP"
  | "LITERAL"
  | "OBJECT"
  | "ARRAY"
  | "UNKNOWN";

export type CPGEdgeType = "AST_EDGE" | "CFG_EDGE" | "PDG_EDGE";

export interface TreeSitterPoint {
  row: number;
  column: number;
}

export interface TreeSitterSyntaxNode {
  type: string;
  startIndex: number;
  endIndex: number;
  startPosition?: TreeSitterPoint;
  endPosition?: TreeSitterPoint;
  childCount: number;
  namedChildCount: number;
  child(index: number): TreeSitterSyntaxNode | null;
  namedChild(index: number): TreeSitterSyntaxNode | null;
  childForFieldName?(fieldName: string): TreeSitterSyntaxNode | null;
}

export interface TreeSitterTreeLike {
  rootNode: TreeSitterSyntaxNode;
}

export type TreeSitterInput = TreeSitterTreeLike | TreeSitterSyntaxNode;

export interface CPGNode {
  id: string;
  numericId: number;
  filePath: string;
  treeSitterType: string;
  nodeType: CPGNodeType;
  startIndex: number;
  endIndex: number;
  line?: number;
  column?: number;
  text?: string;
  symbol?: string;
  scopeId?: string;
  isTaintSource?: boolean;
  isCriticalSink?: boolean;
  sinkKind?: string;
}

export interface CPGEdge {
  id: string;
  from: string;
  to: string;
  fromNumericId: number;
  toNumericId: number;
  edgeType: CPGEdgeType;
  label?: string;
}

export interface CPGBuildInput {
  astByFile: Map<string, TreeSitterInput> | Record<string, TreeSitterInput>;
  sourceByFile?: Map<string, string> | Record<string, string>;
}

export interface TaintTraceResult {
  reachedSink: boolean;
  path: CPGNode[];
  sink?: CPGNode;
}
