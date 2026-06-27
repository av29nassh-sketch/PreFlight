import type { FastCheckFinding } from "./types";

const { parseSourceCode } = require("../../taintTracker");

const COMMAND_CONSTRUCTION_PATTERN =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*["'`][^"'`]*(?:ping|curl|wget|ssh|scp|tar|zip|unzip|rm|cat|ls|cmd|powershell)[^"'`]*["'`]\s*\+\s*([A-Za-z_$][\w$]*)/gi;
const EXEC_CALL_PATTERN = /\b(?:exec|execSync|spawn|spawnSync)\s*\(\s*([A-Za-z_$][\w$]*)/gi;
const REQUEST_VAR_PATTERN = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*req\.(?:query|body|params)\.[A-Za-z_$][\w$]*/gi;
const ROUTE_BLOCK_PATTERN = /router\.(?:post|put|patch|delete)\s*\([\s\S]*?\}\s*\)\s*;/gi;
const BILLING_UPDATE_PATTERN = /\bUPDATE\s+(?:billing|accounts?|organizations?|users?)\b[\s\S]*?\bWHERE\b[\s\S]*?\b(?:account_id|organization_id|tenant_id|user_id|id)\b/i;
const ACCOUNT_MUTATION_CALL_PATTERN = /\b(?:updateBillingPlan|updateProfile|updateAccount|deleteAccount|transferOwnership)\s*\(/i;
const ACCOUNT_MUTATION_INVOCATION_PATTERN =
  /\b[A-Za-z_$][\w$]*\s*\.\s*(?:updateBillingPlan|updateProfile|updateAccount|deleteAccount|transferOwnership)\s*\(/gi;
const USER_CONTROLLED_ID_PATTERN = /\b(?:accountId|organizationId|orgId|tenantId|targetUserId|userId)\b/;
const AUTH_GUARD_PATTERN =
  /\b(?:req\.user|req\.session|session|auth|authorize|requireRole|requirePermission|checkPermission|verifySession|validateSession|isAdmin|hasRole|ownerId|authenticatedUserId)\b/i;

function getLineNumber(fileContent: string, index: number): number {
  return fileContent.slice(0, index).split(/\r?\n/).length;
}

function findMatchingClosingBrace(source: string, openIndex: number): number {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function getEnclosingBlockText(source: string, index: number): string {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (source[cursor] !== "{") {
      continue;
    }

    const closeIndex = findMatchingClosingBrace(source, cursor);
    if (closeIndex >= index) {
      return source.slice(cursor, closeIndex + 1);
    }
  }

  return source;
}

function firstSyntaxErrorLine(node: any): number | undefined {
  if (!node) {
    return undefined;
  }

  if (node.type === "ERROR") {
    return node.startPosition ? node.startPosition.row + 1 : undefined;
  }

  for (let index = 0; index < (node.childCount || 0); index += 1) {
    const line = firstSyntaxErrorLine(node.child(index));
    if (line) {
      return line;
    }
  }

  if (node.hasError === true) {
    return node.startPosition ? node.startPosition.row + 1 : undefined;
  }

  return undefined;
}

async function scanForSyntaxErrors(fileContent: string, filePath: string): Promise<FastCheckFinding[]> {
  try {
    const tree = await parseSourceCode(fileContent, filePath);
    const line = firstSyntaxErrorLine(tree?.rootNode);
    if (line) {
      console.warn(
        `[PreFlight] Soft syntax warning ignored for daemon alerts: ${filePath}:${line}`
      );
    }

    return [];
  } catch (error) {
    console.warn(
      `[PreFlight] Soft parser warning ignored for daemon alerts: ${filePath} - ${
        error instanceof Error ? error.message : String(error)
      }`
    );

    return [];
  }
}

function scanForCommandInjection(fileContent: string, filePath: string): FastCheckFinding[] {
  const findings: FastCheckFinding[] = [];
  const requestVars = new Set<string>();
  const commandVars = new Set<string>();
  let match: RegExpExecArray | null;

  REQUEST_VAR_PATTERN.lastIndex = 0;
  while ((match = REQUEST_VAR_PATTERN.exec(fileContent)) !== null) {
    requestVars.add(match[1]);
  }

  COMMAND_CONSTRUCTION_PATTERN.lastIndex = 0;
  while ((match = COMMAND_CONSTRUCTION_PATTERN.exec(fileContent)) !== null) {
    if (requestVars.has(match[2])) {
      commandVars.add(match[1]);
    }
  }

  EXEC_CALL_PATTERN.lastIndex = 0;
  while ((match = EXEC_CALL_PATTERN.exec(fileContent)) !== null) {
    if (!commandVars.has(match[1])) {
      continue;
    }

    findings.push({
      file: filePath,
      line: getLineNumber(fileContent, match.index),
      issue: `Command injection risk: user-controlled input flows into ${match[0].trim()}.`,
      severity: "HARD_BLOCK"
    });
  }

  return findings;
}

function scanForBola(fileContent: string, filePath: string): FastCheckFinding[] {
  const findings: FastCheckFinding[] = [];
  let match: RegExpExecArray | null;

  ROUTE_BLOCK_PATTERN.lastIndex = 0;
  while ((match = ROUTE_BLOCK_PATTERN.exec(fileContent)) !== null) {
    const routeBlock = match[0];
    if (
      !(BILLING_UPDATE_PATTERN.test(routeBlock) || ACCOUNT_MUTATION_CALL_PATTERN.test(routeBlock)) ||
      !USER_CONTROLLED_ID_PATTERN.test(routeBlock) ||
      AUTH_GUARD_PATTERN.test(routeBlock)
    ) {
      continue;
    }

    findings.push({
      file: filePath,
      line: getLineNumber(fileContent, match.index),
      issue: "Potential BOLA/authorization bypass: route updates account-scoped data from request body without an obvious authorization guard.",
      severity: "HARD_BLOCK"
    });
  }

  const exportedRoutePattern = /\bexport\s+async\s+function\s+(?:POST|PUT|PATCH|DELETE)\s*\([^)]*\)\s*\{[\s\S]*?\n\}/g;
  exportedRoutePattern.lastIndex = 0;
  while ((match = exportedRoutePattern.exec(fileContent)) !== null) {
    const routeBlock = match[0];
    if (
      !(BILLING_UPDATE_PATTERN.test(routeBlock) || ACCOUNT_MUTATION_CALL_PATTERN.test(routeBlock)) ||
      !USER_CONTROLLED_ID_PATTERN.test(routeBlock) ||
      AUTH_GUARD_PATTERN.test(routeBlock)
    ) {
      continue;
    }

    findings.push({
      file: filePath,
      line: getLineNumber(fileContent, match.index),
      issue: "Potential BOLA/authorization bypass: route updates account-scoped data from request body without an obvious authorization guard.",
      severity: "HARD_BLOCK"
    });
  }

  ACCOUNT_MUTATION_INVOCATION_PATTERN.lastIndex = 0;
  while ((match = ACCOUNT_MUTATION_INVOCATION_PATTERN.exec(fileContent)) !== null) {
    const routeBlock = getEnclosingBlockText(fileContent, match.index);
    if (
      !USER_CONTROLLED_ID_PATTERN.test(routeBlock) ||
      AUTH_GUARD_PATTERN.test(routeBlock)
    ) {
      continue;
    }

    findings.push({
      file: filePath,
      line: getLineNumber(fileContent, match.index),
      issue: "Potential BOLA/authorization bypass: account-scoped mutation uses a client-controlled identifier without an obvious authorization guard.",
      severity: "HARD_BLOCK"
    });
  }

  return findings;
}

export async function scanCodeSafety(fileContent: string, filePath: string): Promise<FastCheckFinding[]> {
  return [
    ...(await scanForSyntaxErrors(fileContent, filePath)),
    ...scanForCommandInjection(fileContent, filePath),
    ...scanForBola(fileContent, filePath)
  ];
}
