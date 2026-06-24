import type { PreFlightCPG } from "../cpg/PreFlightCPG";
import type { CPGNode, TaintTraceResult } from "../cpg/types";

export type FuzzClassification = "HARD_BLOCK" | "PASSED";

export type FuzzVulnerabilityType = "SQL_INJECTION" | "COMMAND_INJECTION" | "PATH_TRAVERSAL" | "AUTH_BYPASS" | "UNKNOWN_TAINT";

export interface FuzzEntryPoint {
  sourceNode: CPGNode;
  inferredKeys: string[];
  inferredSchema: Record<string, "string" | "unknown">;
}

export interface FuzzPayload {
  vulnerabilityType: FuzzVulnerabilityType;
  value: string;
}

export interface FuzzResult {
  classification: FuzzClassification;
  vulnerabilityType: FuzzVulnerabilityType;
  payload: string;
  executionTrail: CPGNode[];
  source: CPGNode;
  sink: CPGNode;
  reason: string;
}

const SQL_INJECTION_PAYLOADS = [
  "' OR '1'='1",
  "' UNION SELECT NULL --",
  "\" OR \"1\"=\"1",
  "1; RESET MASTER; --",
  "admin'/**/OR/**/'1'='1"
];

const PATH_TRAVERSAL_PAYLOADS = ["../../../../etc/passwd", "..\\..\\..\\Windows\\win.ini", "%2e%2e/%2e%2e/.env"];

const COMMAND_INJECTION_PAYLOADS = ["127.0.0.1; cat /etc/passwd", "127.0.0.1 && whoami", "127.0.0.1 | id"];

const AUTH_BYPASS_PAYLOADS = ["admin", "true", "00000000-0000-0000-0000-000000000000", "' OR role = 'admin"];

const SANITIZER_PATTERN =
  /\b(?:zod|safeParse|parse|encodeURIComponent|escape|sanitize|validator|isUUID|isEmail|Number|parseInt|parameterized|prepared|allowlist|allowedHosts|allowedTables|hostPattern)\b|(?:\.test|\.has)\s*\(/i;

const PARAMETERIZED_SINK_PATTERN = /\$\d+|\?|:\w+|values\s*:|\.eq\s*\(|\.match\s*\(|\.filter\s*\(/i;

function nodeText(node: CPGNode | undefined): string {
  return node?.text || "";
}

function normalizeIgnoreRule(rawRule: string): string {
  return rawRule.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function isIgnoredForVulnerability(node: CPGNode | undefined, vulnerabilityType?: FuzzVulnerabilityType): boolean {
  if (!node) {
    return false;
  }

  if (node.ignored) {
    return true;
  }

  const ignoreRules = node.ignoreRules || [];
  if (ignoreRules.includes("all") || ignoreRules.includes("fuzzer")) {
    return true;
  }

  return vulnerabilityType ? ignoreRules.includes(normalizeIgnoreRule(vulnerabilityType)) : false;
}

function traceContainsIgnoredNode(trace: CPGNode[], vulnerabilityType: FuzzVulnerabilityType): boolean {
  return trace.some((node) => isIgnoredForVulnerability(node, vulnerabilityType));
}

function inferKeyFromSourceText(text: string): string[] {
  const keys = new Set<string>();
  const propertyMatches = text.matchAll(/\b(?:query|body|params|searchParams)\s*\.\s*([A-Za-z_$][\w$]*)/g);
  for (const match of propertyMatches) {
    keys.add(match[1]);
  }

  const bracketMatches = text.matchAll(/\b(?:query|body|params|searchParams)\s*\[\s*["']([^"']+)["']\s*\]/g);
  for (const match of bracketMatches) {
    keys.add(match[1]);
  }

  const getterMatches = text.matchAll(/\.get\s*\(\s*["']([^"']+)["']\s*\)/g);
  for (const match of getterMatches) {
    keys.add(match[1]);
  }

  return [...keys];
}

function classifySink(sink: CPGNode): FuzzVulnerabilityType {
  const text = nodeText(sink);

  if (sink.sinkKind === "command-execution" || /\b(?:exec|execSync|spawn|spawnSync|execFile)\s*\(/i.test(text)) {
    return "COMMAND_INJECTION";
  }

  if (sink.sinkKind === "file-system" || /\b(?:readFile|writeFile|createReadStream|unlink)\s*\(/i.test(text)) {
    return "PATH_TRAVERSAL";
  }

  if (sink.sinkKind === "auth-boundary" || /auth|role|session|permission|admin/i.test(text)) {
    return "AUTH_BYPASS";
  }

  if (
    sink.sinkKind === "raw-sql-construction" ||
    /\b(?:sql|select|insert|update|delete|rpc|supabase)\b/i.test(text) ||
    /\b(?:db|pool|client|connection|database)\s*\.\s*(?:query|execute)\s*\(/i.test(text)
  ) {
    return "SQL_INJECTION";
  }

  return "UNKNOWN_TAINT";
}

function payloadsForSink(sink: CPGNode): FuzzPayload[] {
  const vulnerabilityType = classifySink(sink);
  if (vulnerabilityType === "SQL_INJECTION") {
    return SQL_INJECTION_PAYLOADS.map((value) => ({ vulnerabilityType, value }));
  }

  if (vulnerabilityType === "PATH_TRAVERSAL") {
    return PATH_TRAVERSAL_PAYLOADS.map((value) => ({ vulnerabilityType, value }));
  }

  if (vulnerabilityType === "COMMAND_INJECTION") {
    return COMMAND_INJECTION_PAYLOADS.map((value) => ({ vulnerabilityType, value }));
  }

  if (vulnerabilityType === "AUTH_BYPASS") {
    return AUTH_BYPASS_PAYLOADS.map((value) => ({ vulnerabilityType, value }));
  }

  return [{ vulnerabilityType, value: "__PREFLIGHT_TAINT_PROBE__" }];
}

function containsSanitizer(trace: CPGNode[]): boolean {
  return trace.some((node) => SANITIZER_PATTERN.test(nodeText(node)));
}

function isParameterizedSink(trace: CPGNode[], sink: CPGNode): boolean {
  const combinedText = [...trace.map(nodeText), nodeText(sink)].join("\n");
  return PARAMETERIZED_SINK_PATTERN.test(combinedText) && !/(?:\+|\$\{)/.test(combinedText);
}

function isNonShellCommandArgumentSink(sink: CPGNode): boolean {
  const text = nodeText(sink);
  return /\b(?:execFile|execFileSync)\s*\(\s*["'][^"']+["']\s*,\s*\[/.test(text) && !/\bshell\s*:\s*true\b/i.test(text);
}

function dangerousPayloadSurvives(payload: FuzzPayload, trace: CPGNode[], sink: CPGNode): boolean {
  if (containsSanitizer(trace)) {
    return false;
  }

  if (isParameterizedSink(trace, sink)) {
    return false;
  }

  const sinkLayout = trace.map(nodeText).join("\n");
  if (payload.vulnerabilityType === "SQL_INJECTION") {
    return /(?:\+|\$\{)/.test(sinkLayout) || /query|execute|rpc/i.test(nodeText(sink));
  }

  if (payload.vulnerabilityType === "PATH_TRAVERSAL") {
    return /readFile|writeFile|createReadStream|path|file/i.test(sinkLayout);
  }

  if (payload.vulnerabilityType === "COMMAND_INJECTION") {
    if (isNonShellCommandArgumentSink(sink)) {
      return false;
    }

    return /(?:\+|\$\{)/.test(sinkLayout) || /exec|execSync|spawn|spawnSync|execFile|shell/i.test(nodeText(sink));
  }

  if (payload.vulnerabilityType === "AUTH_BYPASS") {
    return /auth|role|session|permission|admin/i.test(sinkLayout);
  }

  return true;
}

export class PreFlightFuzzer {
  constructor(private readonly cpg: PreFlightCPG) {}

  extractEntryPoints(): FuzzEntryPoint[] {
    return this.cpg
      .findTaintSources()
      .filter((sourceNode) => !isIgnoredForVulnerability(sourceNode))
      .map((sourceNode) => {
        const inferredKeys = inferKeyFromSourceText(nodeText(sourceNode));
        return {
          sourceNode,
          inferredKeys,
          inferredSchema: Object.fromEntries(inferredKeys.map((key) => [key, "string" as const]))
        };
      });
  }

  generatePayloadsForSink(sinkNodeId: string | number): FuzzPayload[] {
    const sink = this.resolveNode(sinkNodeId);
    return sink ? payloadsForSink(sink) : [];
  }

  fuzzAll(): FuzzResult[] {
    const results: FuzzResult[] = [];
    for (const source of this.cpg.findTaintSources()) {
      if (isIgnoredForVulnerability(source)) {
        continue;
      }

      const trace = this.cpg.traceTaintDetailed(source.id);
      if (trace.reachedSink && trace.sink) {
        const result = this.fuzzTrace(source, trace.sink, trace);
        if (result) {
          results.push(result);
        }
      }
    }

    return results;
  }

  fuzzPath(sourceNodeId: string | number, sinkNodeId: string | number): FuzzResult | null {
    const source = this.resolveNode(sourceNodeId);
    const sink = this.resolveNode(sinkNodeId);
    if (!source || !sink) {
      return null;
    }

    if (isIgnoredForVulnerability(source)) {
      return null;
    }

    const trace = this.cpg.traceTaintDetailed(source.id);
    if (!trace.reachedSink || !trace.sink || trace.sink.id !== sink.id) {
      return null;
    }

    return this.fuzzTrace(source, sink, trace);
  }

  private fuzzTrace(source: CPGNode, sink: CPGNode, trace: TaintTraceResult): FuzzResult | null {
    const executionTrail = trace.path.length > 0 ? trace.path : [source, sink];
    for (const payload of payloadsForSink(sink)) {
      if (traceContainsIgnoredNode(executionTrail, payload.vulnerabilityType) || isIgnoredForVulnerability(sink, payload.vulnerabilityType)) {
        continue;
      }

      if (!dangerousPayloadSurvives(payload, executionTrail, sink)) {
        continue;
      }

      return {
        classification: "HARD_BLOCK",
        vulnerabilityType: payload.vulnerabilityType,
        payload: payload.value,
        executionTrail,
        source,
        sink,
        reason: `${payload.vulnerabilityType} payload reaches ${sink.sinkKind || sink.nodeType} without sanitizer or parameterization.`
      };
    }

    return null;
  }

  private resolveNode(nodeId: string | number): CPGNode | undefined {
    if (typeof nodeId === "string") {
      return this.cpg.getNode(nodeId);
    }

    return this.cpg.getNodes().find((node) => node.numericId === nodeId);
  }
}
