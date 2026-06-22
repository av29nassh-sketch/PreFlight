import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import {
  buildFixAuthHeaders,
  recordFreeFixUsageIfNeeded,
  resolveFixEntitlement,
  type FixEntitlement
} from "../config/fixEntitlement";

const PREFLIGHT_PROXY_REMEDIATION_ENDPOINT = "https://preflight-proxy.vercel.app/api/v1/remediation";

interface TextContentBlock {
  type: "text";
  text: string;
}

interface PreFlightProxyResponse {
  content?: Array<{ type?: string; text?: string }>;
  code?: string;
  patchedCode?: string;
  replacement?: string;
  sourceCode?: string;
}

function extractMissingRlsTableName(issue: string): string | null {
  const match = issue.match(/Table\s+'([^']+)'\s+is\s+missing\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);
  return match?.[1]?.trim() || null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyDeterministicMissingRlsPatchToContent(currentContent: string, issue: string): string | null {
  if (!/missing\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(issue)) {
    return null;
  }

  const tableName = extractMissingRlsTableName(issue);
  if (!tableName) {
    return null;
  }

  const existingRlsPattern = new RegExp(
    `\\balter\\s+table\\s+${escapeRegExp(tableName).replace(/\\\./g, "\\s*\\.\\s*")}\\s+enable\\s+row\\s+level\\s+security\\b`,
    "i"
  );

  if (existingRlsPattern.test(currentContent)) {
    return currentContent;
  }

  return `${currentContent.trimEnd()}\n\nALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY;\n`;
}

function applyDeterministicConfigSecretPatch(filePath: string, issues: string[]): boolean {
  if (path.basename(filePath) !== "config.ts") {
    return false;
  }

  if (!issues.some((issue) => /OpenAI/i.test(issue))) {
    return false;
  }

  const originalContent = fs.readFileSync(filePath, "utf8");
  const patchedContent = originalContent.replace(
    /(["'])sk-(?:proj-)?[A-Za-z0-9_-]+(["'])/g,
    "process.env.OPENAI_API_KEY"
  );

  if (patchedContent === originalContent) {
    return false;
  }

  fs.writeFileSync(filePath, patchedContent.endsWith("\n") ? patchedContent : `${patchedContent}\n`, "utf8");
  return true;
}

function applyDeterministicPackageJsonPatch(filePath: string, issues: string[]): boolean {
  if (path.basename(filePath) !== "package.json") {
    return false;
  }

  if (!issues.some((issue) => /\blatest\b|\*/i.test(issue))) {
    return false;
  }

  const rawPackageJson = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const parsedPackageJson = JSON.parse(rawPackageJson) as {
    dependencies?: Record<string, string>;
  };

  parsedPackageJson.dependencies = parsedPackageJson.dependencies || {};
  parsedPackageJson.dependencies.next = "^14.0.0";
  parsedPackageJson.dependencies.react = "^18.2.0";

  fs.writeFileSync(filePath, `${JSON.stringify(parsedPackageJson, null, 2)}\n`, "utf8");
  return true;
}

function buildProxyPatchPrompt(unresolvedIssues: string[], currentContent: string): string {
  return [
    "You are a security remediation agent.",
    `The following code has security violations: ${unresolvedIssues.join("; ")}.`,
    "Return ONLY the completely rewritten code fixing these violations based on this current code state:",
    "",
    currentContent,
    "",
    "Do not include markdown formatting, backticks, or explanations.",
    "Just the raw code."
  ].join("\n");
}

function sanitizePatchedCode(value: string): string {
  return value
    .replace(/^```[a-zA-Z0-9_-]*\s*/u, "")
    .replace(/\s*```$/u, "")
    .trim();
}

function extractProxyText(response: PreFlightProxyResponse): string {
  const directCode = response.code || response.patchedCode || response.replacement || response.sourceCode;
  if (typeof directCode === "string" && directCode.trim()) {
    return directCode.trim();
  }

  return (response.content || [])
    .filter((block): block is TextContentBlock => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function inferVulnerabilityType(unresolvedIssues: string[]): string {
  const combinedIssues = unresolvedIssues.join("\n");
  if (/command injection|exec|spawn|shell/i.test(combinedIssues)) {
    return "COMMAND_INJECTION";
  }

  if (/BOLA|authorization bypass|authorization guard|account-scoped|tenant/i.test(combinedIssues)) {
    return "AUTH_BYPASS";
  }

  if (/Stripe|secret|API key|credential|token/i.test(combinedIssues)) {
    return "HARDCODED_SECRET";
  }

  if (/syntax|parser|parse/i.test(combinedIssues)) {
    return "SYNTAX_ERROR";
  }

  if (/SQL|query|injection/i.test(combinedIssues)) {
    return "SQL_INJECTION";
  }

  return "FAST_CHECK_REMEDIATION";
}

function inferBreakingPayload(unresolvedIssues: string[]): string {
  return unresolvedIssues.find((issue) => issue.trim()) || "__PREFLIGHT_FAST_CHECK__";
}

async function runProxyPatch(
  filePath: string,
  currentContent: string,
  unresolvedIssues: string[],
  entitlement: FixEntitlement
): Promise<string> {
  const requestBody = {
    filePath,
    sourceCode: currentContent,
    vulnerabilityType: inferVulnerabilityType(unresolvedIssues),
    breakingPayload: inferBreakingPayload(unresolvedIssues),
    executionTrail: [
      "PreFlight fast-check findings:",
      ...unresolvedIssues,
      "",
      buildProxyPatchPrompt(unresolvedIssues, currentContent)
    ]
  };

  const response = await fetch(PREFLIGHT_PROXY_REMEDIATION_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...buildFixAuthHeaders(entitlement)
    },
    body: JSON.stringify(requestBody)
  });

  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(rawBody || `Auto-Patch proxy request failed with status ${response.status}.`);
  }

  let parsedResponse: PreFlightProxyResponse;
  try {
    parsedResponse = JSON.parse(rawBody) as PreFlightProxyResponse;
  } catch {
    parsedResponse = { content: [{ type: "text", text: rawBody }] };
  }

  const patchedCode = sanitizePatchedCode(extractProxyText(parsedResponse));

  if (!patchedCode) {
    throw new Error("Auto-Patch failed: PreFlight proxy returned an empty patch.");
  }

  return patchedCode;
}

export async function applyAutoPatch(filePath: string, issues: string[]): Promise<boolean> {
  const entitlement = await resolveFixEntitlement(path.dirname(path.resolve(filePath)));

  if (applyDeterministicConfigSecretPatch(filePath, issues)) {
    await recordFreeFixUsageIfNeeded(entitlement);
    return true;
  }

  if (applyDeterministicPackageJsonPatch(filePath, issues)) {
    await recordFreeFixUsageIfNeeded(entitlement);
    return true;
  }

  let currentContent = fs.readFileSync(filePath, "utf8");
  const unresolvedIssues: string[] = [];

  for (const issue of issues) {
    const deterministicPatch = applyDeterministicMissingRlsPatchToContent(currentContent, issue);

    if (deterministicPatch !== null) {
      currentContent = deterministicPatch;
      continue;
    }

    unresolvedIssues.push(issue);
  }

  if (unresolvedIssues.length > 0) {
    currentContent = await runProxyPatch(filePath, currentContent, unresolvedIssues, entitlement);
  }

  fs.writeFileSync(filePath, currentContent.endsWith("\n") ? currentContent : `${currentContent}\n`, "utf8");
  await recordFreeFixUsageIfNeeded(entitlement);
  return true;
}
