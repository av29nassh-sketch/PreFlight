const STATES = Object.freeze({
  CONFIRMED_FINDING: "confirmed-finding",
  NEEDS_RUNTIME_CHECK: "needs-runtime-check",
  LIKELY_SAFE: "likely-safe"
});

const SAFE_RECEIPT = "🟢 Safe: Local syntax and basic guards verified.";
const FUZZY_CONTEXT_MESSAGE = [
  "⚠️  Complex Architecture Detected (Fuzzy Context)",
  "PreFlight's local engine found complex multi-file tenant wrappers or RPC blocks that require deep architectural reasoning.",
  "",
  "👉 To resolve this, run:",
  "   preflight upgrade",
  "",
  "This will show you how to unlock the Cloud AI Engine ($19/mo) for automated contextual patching and deep security tracing."
].join("\n");

const SECRET_PATTERNS = [
  {
    id: "stripe-secret",
    label: "Stripe secret key",
    regex: /\bsk_(?:live|test)_[A-Za-z0-9_=-]{8,}\b/g,
    replacement: "sk_live_REDACTED_BY_PREFLIGHT"
  },
  {
    id: "openai-project-key",
    label: "OpenAI project key",
    regex: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g,
    replacement: "sk-proj_REDACTED_BY_PREFLIGHT"
  },
  {
    id: "github-token",
    label: "GitHub token",
    regex: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{30,}\b/g,
    replacement: "github_pat_REDACTED_BY_PREFLIGHT"
  }
];

const RAW_SQL_PATTERNS = [
  /\b(?:SELECT|INSERT|UPDATE|DELETE)\b[\s\S]{0,120}\+/i,
  /\+\s*['"`][\s\S]{0,120}\b(?:SELECT|INSERT|UPDATE|DELETE)\b/i
];

const FUZZY_CONTEXT_PATTERNS = [
  /\bsupabase\.auth\b/i,
  /\.rpc\s*\(/i,
  /\bcreateContext\s*\(/i
];

function normalizeDiff(diff) {
  if (typeof diff !== "string") {
    throw new TypeError("scanDiff requires a diff string.");
  }

  return diff.replace(/\r\n/g, "\n");
}

function getAddedLines(diff) {
  return normalizeDiff(diff)
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"));
}

function findSecretFindings(addedLines) {
  const findings = [];
  for (const [lineIndex, line] of addedLines.entries()) {
    for (const pattern of SECRET_PATTERNS) {
      pattern.regex.lastIndex = 0;
      let match;
      while ((match = pattern.regex.exec(line)) !== null) {
        findings.push({
          kind: "secret",
          label: pattern.label,
          line: lineIndex + 1,
          patternId: pattern.id,
          redacted: pattern.replacement
        });
      }
    }
  }
  return findings;
}

function findRawSqlFindings(addedLines) {
  const findings = [];
  for (const [lineIndex, line] of addedLines.entries()) {
    if (RAW_SQL_PATTERNS.some((pattern) => pattern.test(line))) {
      findings.push({
        kind: "raw-sql",
        label: "Raw SQL concatenation",
        line: lineIndex + 1
      });
    }
  }
  return findings;
}

function findFuzzyContextFindings(addedLines) {
  const findings = [];
  for (const [lineIndex, line] of addedLines.entries()) {
    const matchedPattern = FUZZY_CONTEXT_PATTERNS.find((pattern) => pattern.test(line));
    if (matchedPattern) {
      findings.push({
        kind: "fuzzy-context",
        label: matchedPattern.source,
        line: lineIndex + 1
      });
    }
  }
  return findings;
}

function redactSecrets(diff) {
  let fixedDiff = normalizeDiff(diff);
  for (const pattern of SECRET_PATTERNS) {
    fixedDiff = fixedDiff.replace(pattern.regex, pattern.replacement);
  }
  return fixedDiff;
}

function renderScanReceipt(result) {
  if (!result || typeof result !== "object") {
    throw new TypeError("renderScanReceipt requires a scan result object.");
  }

  if (result.state === STATES.LIKELY_SAFE) {
    return `${SAFE_RECEIPT}\n`;
  }

  if (result.state === STATES.NEEDS_RUNTIME_CHECK) {
    return `${FUZZY_CONTEXT_MESSAGE}\n`;
  }

  const lines = ["🔴 Confirmed Finding: PreFlight blocked this commit."];
  for (const finding of result.findings || []) {
    lines.push(`- ${finding.kind}: ${finding.label} on added line ${finding.line}`);
  }
  return `${lines.join("\n")}\n`;
}

function scanDiff(diff, options = {}) {
  const normalizedDiff = normalizeDiff(diff);
  const addedLines = getAddedLines(normalizedDiff);
  const confirmedFindings = [
    ...findSecretFindings(addedLines),
    ...findRawSqlFindings(addedLines)
  ];

  if (confirmedFindings.length > 0) {
    const result = {
      autoFixed: options.autoFix === true,
      findings: confirmedFindings,
      fixedDiff: options.autoFix === true ? redactSecrets(normalizedDiff) : null,
      message: "🔴 Confirmed Finding: PreFlight blocked this commit.",
      ok: false,
      state: STATES.CONFIRMED_FINDING
    };
    return result;
  }

  const fuzzyFindings = findFuzzyContextFindings(addedLines);
  if (fuzzyFindings.length > 0) {
    return {
      findings: fuzzyFindings,
      fixedDiff: null,
      message: FUZZY_CONTEXT_MESSAGE,
      ok: false,
      state: STATES.NEEDS_RUNTIME_CHECK
    };
  }

  return {
    findings: [],
    fixedDiff: null,
    message: SAFE_RECEIPT,
    ok: true,
    state: STATES.LIKELY_SAFE
  };
}

module.exports = {
  FUZZY_CONTEXT_MESSAGE,
  redactSecrets,
  renderScanReceipt,
  SAFE_RECEIPT,
  scanDiff,
  STATES
};
