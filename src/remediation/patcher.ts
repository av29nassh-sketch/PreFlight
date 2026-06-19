import fs from "node:fs";
import path from "node:path";

const { parseJavaScript } = require("../../taintTracker");

const DEFAULT_REMEDIATION_ENDPOINT = "https://preflight-vibe.vercel.app/api/v1/remediation";

export interface FuzzerRemediationFinding {
  file: string;
  payload: string;
  type: string;
  trail: string[];
  severity?: string;
  issue?: string;
}

interface RemediationResponseShape {
  code?: string;
  patchedCode?: string;
  replacement?: string;
  sourceCode?: string;
  patch?: string;
  diff?: string;
  content?: Array<{ text?: string }>;
}

function resolveEndpoint(): string {
  return (
    process.env.PREFLIGHT_REMEDIATION_ENDPOINT ||
    process.env.PREFLIGHT_PROXY_ENDPOINT ||
    DEFAULT_REMEDIATION_ENDPOINT
  ).trim();
}

function resolveLicenseKey(): string {
  const licenseKey = (process.env.PREFLIGHT_PRO_KEY || process.env.PREFLIGHT_PRO_LICENSE_KEY || "").trim();
  if (!licenseKey) {
    throw new Error("Fuzzer remediation requires PREFLIGHT_PRO_KEY.");
  }

  return licenseKey;
}

function firstTextBlock(response: RemediationResponseShape): string | null {
  const content = Array.isArray(response.content) ? response.content : [];
  const textBlock = content.find((item) => item && typeof item.text === "string" && item.text.trim());
  return textBlock?.text?.trim() || null;
}

function extractCodeFence(rawText: string): string | null {
  const match = rawText.match(/```(?:[A-Za-z0-9_-]+)?\s*\r?\n([\s\S]*?)```/);
  return match ? match[1].replace(/\s+$/, "\n") : null;
}

function extractRemediationText(rawBody: string): string {
  let parsed: RemediationResponseShape | null = null;
  try {
    parsed = JSON.parse(rawBody) as RemediationResponseShape;
  } catch {
    parsed = null;
  }

  if (parsed) {
    const directCode = parsed.code || parsed.patchedCode || parsed.replacement || parsed.sourceCode;
    if (typeof directCode === "string" && directCode.trim()) {
      return directCode;
    }

    const diff = parsed.patch || parsed.diff;
    if (typeof diff === "string" && diff.trim()) {
      return diff;
    }

    const textBlock = firstTextBlock(parsed);
    if (textBlock) {
      return textBlock;
    }
  }

  return rawBody.trim();
}

function looksLikeUnifiedDiff(text: string): boolean {
  return /(^|\n)(diff --git |--- |\+\+\+ |@@ -\d+)/.test(text);
}

function parseHunkStart(line: string): number | null {
  const match = line.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function applyUnifiedDiff(originalCode: string, diffText: string): string {
  const originalLines = originalCode.split(/\r?\n/);
  const diffLines = diffText.split(/\r?\n/);
  const output: string[] = [];
  let originalIndex = 0;
  let appliedHunk = false;

  for (let index = 0; index < diffLines.length; index += 1) {
    const line = diffLines[index];
    if (!line.startsWith("@@ ")) {
      continue;
    }

    const oldStart = parseHunkStart(line);
    if (!oldStart) {
      throw new Error("Proxy returned an unsupported unified diff hunk.");
    }

    const targetIndex = oldStart - 1;
    while (originalIndex < targetIndex) {
      output.push(originalLines[originalIndex]);
      originalIndex += 1;
    }

    index += 1;
    while (index < diffLines.length && !diffLines[index].startsWith("@@ ")) {
      const hunkLine = diffLines[index];

      if (hunkLine.startsWith("\\ No newline")) {
        index += 1;
        continue;
      }

      if (hunkLine.startsWith("+") && !hunkLine.startsWith("+++")) {
        output.push(hunkLine.slice(1));
      } else if (hunkLine.startsWith("-") && !hunkLine.startsWith("---")) {
        originalIndex += 1;
      } else if (hunkLine.startsWith(" ")) {
        output.push(originalLines[originalIndex] ?? hunkLine.slice(1));
        originalIndex += 1;
      }

      index += 1;
    }

    index -= 1;
    appliedHunk = true;
  }

  if (!appliedHunk) {
    throw new Error("Proxy returned a unified diff without an applicable hunk.");
  }

  while (originalIndex < originalLines.length) {
    output.push(originalLines[originalIndex]);
    originalIndex += 1;
  }

  return output.join("\n");
}

function resolvePatchedCode(originalCode: string, remediationText: string): string {
  if (looksLikeUnifiedDiff(remediationText)) {
    return applyUnifiedDiff(originalCode, remediationText);
  }

  const fencedCode = extractCodeFence(remediationText);
  return fencedCode || remediationText;
}

function hasParseError(node: any): boolean {
  if (!node) {
    return false;
  }

  if (node.type === "ERROR" || node.hasError === true) {
    return true;
  }

  for (let index = 0; index < (node.childCount || 0); index += 1) {
    if (hasParseError(node.child(index))) {
      return true;
    }
  }

  return false;
}

async function assertSyntaxSafe(filePath: string, patchedCode: string): Promise<void> {
  const extension = path.extname(filePath).toLowerCase();
  if (![".js", ".jsx", ".ts", ".tsx"].includes(extension)) {
    return;
  }

  const tree = await parseJavaScript(patchedCode);
  if (hasParseError(tree?.rootNode)) {
    throw new Error("Fuzzer remediation returned code that failed syntax validation.");
  }
}

export async function remediateFuzzerFinding(finding: FuzzerRemediationFinding): Promise<boolean> {
  const filePath = path.resolve(finding.file);
  const sourceCode = fs.readFileSync(filePath, "utf8");
  const licenseKey = resolveLicenseKey();
  const response = await fetch(resolveEndpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${licenseKey}`,
      "X-PreFlight-Pro-Key": licenseKey
    },
    body: JSON.stringify({
      filePath,
      sourceCode,
      vulnerabilityType: finding.type,
      breakingPayload: finding.payload,
      executionTrail: finding.trail
    })
  });

  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(rawBody || `Fuzzer remediation failed with status ${response.status}.`);
  }

  const remediationText = extractRemediationText(rawBody);
  const patchedCode = resolvePatchedCode(sourceCode, remediationText);
  await assertSyntaxSafe(filePath, patchedCode);
  fs.writeFileSync(filePath, patchedCode);
  return true;
}
