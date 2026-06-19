import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";

const CLAUDE_PATCH_MODEL = "claude-sonnet-4-6";

interface TextContentBlock {
  type: "text";
  text: string;
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

function buildClaudePatchPrompt(unresolvedIssues: string[], currentContent: string): string {
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

function extractClaudeText(response: Awaited<ReturnType<Anthropic["messages"]["create"]>>): string {
  return response.content
    .filter((block): block is TextContentBlock => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

async function runClaudePatch(currentContent: string, unresolvedIssues: string[]): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error("Auto-Patch failed: ANTHROPIC_API_KEY is required for complex Claude fixes.");
  }

  const anthropic = new Anthropic({ apiKey });
  const response = await anthropic.messages.create({
    model: CLAUDE_PATCH_MODEL,
    max_tokens: 3000,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: buildClaudePatchPrompt(unresolvedIssues, currentContent)
      }
    ]
  });
  const patchedCode = sanitizePatchedCode(extractClaudeText(response));

  if (!patchedCode) {
    throw new Error("Auto-Patch failed: Claude returned an empty patch.");
  }

  return patchedCode;
}

export async function applyAutoPatch(filePath: string, issues: string[]): Promise<boolean> {
  if (applyDeterministicConfigSecretPatch(filePath, issues)) {
    return true;
  }

  if (applyDeterministicPackageJsonPatch(filePath, issues)) {
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
    currentContent = await runClaudePatch(currentContent, unresolvedIssues);
  }

  fs.writeFileSync(filePath, currentContent.endsWith("\n") ? currentContent : `${currentContent}\n`, "utf8");
  return true;
}
