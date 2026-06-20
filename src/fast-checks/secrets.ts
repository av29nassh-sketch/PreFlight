import type { FastCheckFinding } from "./types";

interface SecretPattern {
  type: string;
  pattern: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    type: "OpenAI API key",
    pattern: /\bsk-[a-zA-Z0-9]{48}\b/g
  },
  {
    type: "OpenAI project API key",
    pattern: /\bsk-proj-[a-zA-Z0-9\-_]{20,}\b/g
  },
  {
    type: "Anthropic API key",
    pattern: /\bsk-ant-api03-[a-zA-Z0-9\-_]{70,}\b/g
  },
  {
    type: "Authorization bearer token",
    pattern: /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi
  }
];

function getLineNumber(fileContent: string, index: number): number {
  return fileContent.slice(0, index).split(/\r?\n/).length;
}

export function scanForSecrets(fileContent: string, filePath: string): FastCheckFinding[] {
  const findings: FastCheckFinding[] = [];

  for (const { type, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(fileContent)) !== null) {
      findings.push({
        file: filePath,
        line: getLineNumber(fileContent, match.index),
        issue: `${type} detected in source content.`,
        severity: "HARD_BLOCK"
      });
    }
  }

  return findings;
}
