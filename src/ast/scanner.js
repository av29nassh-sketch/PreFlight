const readline = require("node:readline");

const STATES = Object.freeze({
  CONFIRMED_FINDING: "confirmed-finding",
  NEEDS_RUNTIME_CHECK: "needs-runtime-check",
  LIKELY_SAFE: "likely-safe"
});

const SAFE_RECEIPT = "🟢 LIKELY SAFE (Trust Receipt)\nStructural security guards verified. Commit may proceed.";
const CONFIRMED_FINDING_MESSAGE = "🔴 CONFIRMED FINDING (Hard Block)";
const HIGH_RISK_DRIFT_MESSAGE = "🟡 HIGH-RISK DRIFT (Needs Runtime Check)";
const FUZZY_CONTEXT_MESSAGE = HIGH_RISK_DRIFT_MESSAGE;

const CONSEQUENCES = Object.freeze({
  confirmed: {
    deployedConsequence: "If you deploy this, secrets or injectable queries can be abused in production before review catches them.",
    actionRequired: "Reject this commit or accept the explicit Auto-Heal prompt after reviewing the patch."
  },
  fuzzy: {
    deployedConsequence: "If you deploy this, tenant isolation or auth behavior can change across files without a visible route-level failure.",
    actionRequired: "Run the affected flow locally as User A and User B, then verify cross-tenant reads and writes return 403 or an empty result."
  },
  middleware: {
    deployedConsequence: "If you deploy this, anyone can bypass your authentication via the client tab.",
    actionRequired: "Log in manually as User A and verify a 403 response."
  },
  rls: {
    deployedConsequence: "If you deploy this, Supabase can allow users to read or mutate rows they do not own.",
    actionRequired: "Run the affected query as User A against User B data and verify Supabase returns 403 or zero rows."
  },
  billing: {
    deployedConsequence: "If you deploy this, retried webhook events can double-charge customers or mutate billing state twice.",
    actionRequired: "Replay the same webhook event ID twice locally and verify the second request is ignored."
  }
});

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
  /\b(?:SELECT|INSERT|UPDATE|DELETE)\b[\s\S]{0,160}\+/i,
  /\+\s*['"`][\s\S]{0,160}\b(?:SELECT|INSERT|UPDATE|DELETE)\b/i
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

function toDisplayPath(filePath) {
  return filePath || "unknown";
}

function parseDiff(diff) {
  const normalized = normalizeDiff(diff);
  const files = [];
  let current = null;
  let nextLineNumber = null;

  for (const rawLine of normalized.split("\n")) {
    const diffHeader = /^diff --git a\/(.+?) b\/(.+)$/.exec(rawLine);
    if (diffHeader) {
      current = {
        filePath: diffHeader[2],
        added: [],
        rawLines: []
      };
      files.push(current);
      nextLineNumber = null;
      continue;
    }

    if (!current) {
      current = {
        filePath: "unknown",
        added: [],
        rawLines: []
      };
      files.push(current);
    }

    const newPath = /^\+\+\+ b\/(.+)$/.exec(rawLine);
    if (newPath) {
      current.filePath = newPath[1];
      current.rawLines.push(rawLine);
      continue;
    }

    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
    if (hunk) {
      nextLineNumber = Number.parseInt(hunk[1], 10);
      current.rawLines.push(rawLine);
      continue;
    }

    current.rawLines.push(rawLine);

    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      const fallbackLine = current.added.length + 1;
      current.added.push({
        filePath: current.filePath,
        line: nextLineNumber || fallbackLine,
        text: rawLine.slice(1)
      });
      if (nextLineNumber !== null) {
        nextLineNumber += 1;
      }
      continue;
    }

    if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
      continue;
    }

    if (nextLineNumber !== null) {
      nextLineNumber += 1;
    }
  }

  return {
    files,
    addedLines: files.flatMap((file) => file.added)
  };
}

function findSecretFindings(addedLines) {
  const findings = [];
  for (const addedLine of addedLines) {
    for (const pattern of SECRET_PATTERNS) {
      pattern.regex.lastIndex = 0;
      let match;
      while ((match = pattern.regex.exec(addedLine.text)) !== null) {
        findings.push({
          kind: "secret",
          label: pattern.label,
          line: addedLine.line,
          filePath: addedLine.filePath,
          patternId: pattern.id,
          redacted: pattern.replacement,
          ...CONSEQUENCES.confirmed
        });
      }
    }
  }
  return findings;
}

function findRawSqlFindings(addedLines) {
  const findings = [];
  for (const addedLine of addedLines) {
    if (RAW_SQL_PATTERNS.some((pattern) => pattern.test(addedLine.text))) {
      findings.push({
        kind: "raw-sql",
        label: "Raw SQL concatenation",
        line: addedLine.line,
        filePath: addedLine.filePath,
        ...CONSEQUENCES.confirmed
      });
    }
  }
  return findings;
}

function findSupabaseRlsFindings(addedLines) {
  const findings = [];
  for (const addedLine of addedLines) {
    const text = addedLine.text;
    if (/\busing\s*\(\s*true\s*\)/i.test(text) || /\bwith\s+check\s*\(\s*true\s*\)/i.test(text)) {
      findings.push({
        kind: "supabase-rls",
        label: "Supabase policy allows all rows",
        line: addedLine.line,
        filePath: addedLine.filePath,
        ...CONSEQUENCES.rls
      });
      continue;
    }

    if (/\.update\s*\(\s*\{[^}]*\buser_id\s*:\s*(?:data|body|req|request|input|params)\b/i.test(text)) {
      findings.push({
        kind: "supabase-rls",
        label: "Client-controlled user_id update",
        line: addedLine.line,
        filePath: addedLine.filePath,
        ...CONSEQUENCES.rls
      });
    }
  }
  return findings;
}

function findMiddlewareBypassFindings(files) {
  const findings = [];
  for (const file of files) {
    const normalizedPath = file.filePath.replace(/\\/g, "/");
    if (!/(^|\/)middleware\.(?:js|ts)$/.test(normalizedPath)) {
      continue;
    }

    const addedText = file.added.map((line) => line.text).join("\n");
    const hasBypassReturn = /\bNextResponse\.next\s*\(/.test(addedText);
    const hasAuthGuard = /\b(?:getToken|getUser|getSession|auth\.uid|supabase\.auth|clerkMiddleware|authMiddleware)\b/.test(addedText);
    if (hasBypassReturn && !hasAuthGuard) {
      const firstLine = file.added.find((line) => /\bNextResponse\.next\s*\(/.test(line.text)) || file.added[0];
      findings.push({
        kind: "middleware-auth-bypass",
        label: "Next.js middleware allows requests through without an auth guard",
        line: firstLine?.line || 1,
        filePath: file.filePath,
        ...CONSEQUENCES.middleware
      });
    }
  }
  return findings;
}

function findFuzzyContextFindings(addedLines) {
  const findings = [];
  for (const addedLine of addedLines) {
    const matchedPattern = FUZZY_CONTEXT_PATTERNS.find((pattern) => pattern.test(addedLine.text));
    if (matchedPattern) {
      findings.push({
        kind: "fuzzy-context",
        label: matchedPattern.source,
        line: addedLine.line,
        filePath: addedLine.filePath,
        ...CONSEQUENCES.fuzzy
      });
    }
  }
  return findings;
}

function findBillingWebhookDrift(files) {
  const findings = [];
  for (const file of files) {
    const normalizedPath = file.filePath.replace(/\\/g, "/").toLowerCase();
    const addedText = file.added.map((line) => line.text).join("\n");
    const touchesBillingPath = /\/api\/webhooks(?:\/|$)/.test(normalizedPath);
    const touchesBillingSdk = /\bfrom\s+['"]stripe['"]|\brequire\s*\(\s*['"]stripe['"]\s*\)|\bnew\s+Stripe\s*\(/i.test(addedText);
    const hasIdempotency = /\bidempot(?:ent|ency)|event\.id|constructEvent|webhook_events|processed_events/i.test(addedText);

    if ((touchesBillingPath || touchesBillingSdk) && !hasIdempotency) {
      const firstLine = file.added.find((line) => /stripe|webhook|POST|handler/i.test(line.text)) || file.added[0];
      findings.push({
        kind: "billing-webhook-drift",
        label: "Billing or webhook code changed without an idempotency guard",
        line: firstLine?.line || 1,
        filePath: file.filePath,
        ...CONSEQUENCES.billing
      });
    }
  }
  return findings;
}

function redactSecrets(text) {
  let fixed = normalizeDiff(text);
  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    fixed = fixed.replace(pattern.regex, pattern.replacement);
  }
  return fixed;
}

function buildAutoPatch(parsedDiff) {
  const patchLines = [];
  for (const file of parsedDiff.files) {
    const replacements = file.added
      .map((line) => ({
        before: redactSecrets(line.text),
        after: redactSecrets(line.text).replace(/(["'])sk_(?:live|test)_REDACTED_BY_PREFLIGHT\1/g, "process.env.STRIPE_SECRET_KEY")
      }))
      .filter((line) => line.before !== line.after);

    if (replacements.length === 0) {
      continue;
    }

    patchLines.push(`--- a/${toDisplayPath(file.filePath)}`);
    patchLines.push(`+++ b/${toDisplayPath(file.filePath)}`);
    for (const replacement of replacements) {
      patchLines.push(`-${replacement.before}`);
      patchLines.push(`+${replacement.after}`);
    }
  }

  return patchLines.length > 0 ? patchLines.join("\n") : null;
}

function color(text, code, enabled) {
  return enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
}

function colorizeUnifiedDiff(patch, options = {}) {
  const enabled = options.color !== false;
  return redactSecrets(String(patch || ""))
    .split("\n")
    .map((line) => {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        return color(line, 32, enabled);
      }
      if (line.startsWith("-") && !line.startsWith("---")) {
        return color(line, 31, enabled);
      }
      if (/^(?:---|\+\+\+|@@)/.test(line)) {
        return color(line, 36, enabled);
      }
      return line;
    })
    .join("\n");
}

async function askWithReadline(question, options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const rl = readline.createInterface({ input, output });
  try {
    return await new Promise((resolve) => {
      rl.question(question, resolve);
    });
  } finally {
    rl.close();
  }
}

async function promptForAutoHeal(patch, options = {}) {
  const output = options.output || process.stdout;
  const question = "[y/n] Accept and Auto-Heal? ";
  output.write("Proposed Auto-Heal Patch:\n");
  output.write(`${colorizeUnifiedDiff(patch, options)}\n\n`);

  let answer;
  if (options.ask) {
    output.write(question);
    answer = await options.ask(question);
  } else {
    answer = await askWithReadline(question, {
      input: options.input,
      output
    });
  }

  return String(answer || "").trim().toLowerCase() === "y";
}

function firstExplanation(findings, fallback) {
  return findings.find((finding) => finding.deployedConsequence && finding.actionRequired) || fallback;
}

function renderFindings(findings) {
  if (!findings || findings.length === 0) {
    return [];
  }

  return [
    "Findings:",
    ...findings.map((finding) => `- ${finding.kind} at ${toDisplayPath(finding.filePath)}:${finding.line}`)
  ];
}

function renderScanReceipt(result) {
  if (!result || typeof result !== "object") {
    throw new TypeError("renderScanReceipt requires a scan result object.");
  }

  if (result.state === STATES.LIKELY_SAFE) {
    return `${SAFE_RECEIPT}\n`;
  }

  if (result.state === STATES.NEEDS_RUNTIME_CHECK) {
    const explanation = firstExplanation(result.findings || [], CONSEQUENCES.fuzzy);
    return `${[
      HIGH_RISK_DRIFT_MESSAGE,
      "PreFlight Scavenger found AI coding drift in a sensitive architectural boundary.",
      "",
      `[Deployed Consequence]: "${explanation.deployedConsequence}"`,
      `[Action Required]: "${explanation.actionRequired}"`,
      "",
      ...renderFindings(result.findings),
      ""
    ].join("\n")}`;
  }

  const explanation = firstExplanation(result.findings || [], CONSEQUENCES.confirmed);
  return `${[
    CONFIRMED_FINDING_MESSAGE,
    "PreFlight Scavenger blocked this commit because AI-generated code introduced a confirmed production risk.",
    "",
    `[Deployed Consequence]: "${explanation.deployedConsequence}"`,
    `[Action Required]: "${explanation.actionRequired}"`,
    "",
    ...renderFindings(result.findings),
    ""
  ].join("\n")}`;
}

function scanDiff(diff, options = {}) {
  const normalizedDiff = normalizeDiff(diff);
  const parsedDiff = parseDiff(normalizedDiff);
  const confirmedFindings = [
    ...findSecretFindings(parsedDiff.addedLines),
    ...findRawSqlFindings(parsedDiff.addedLines),
    ...findSupabaseRlsFindings(parsedDiff.addedLines),
    ...findMiddlewareBypassFindings(parsedDiff.files)
  ];

  if (confirmedFindings.length > 0) {
    const fixedDiff = options.autoFix === true ? redactSecrets(normalizedDiff) : null;
    const autoPatch = options.autoFix === true ? buildAutoPatch(parsedDiff) : null;
    const result = {
      autoFixed: false,
      autoPatch,
      findings: confirmedFindings,
      fixedDiff,
      message: CONFIRMED_FINDING_MESSAGE,
      ok: false,
      state: STATES.CONFIRMED_FINDING
    };
    return result;
  }

  const fuzzyFindings = [
    ...findBillingWebhookDrift(parsedDiff.files),
    ...findFuzzyContextFindings(parsedDiff.addedLines)
  ];
  if (fuzzyFindings.length > 0) {
    return {
      findings: fuzzyFindings,
      fixedDiff: null,
      message: HIGH_RISK_DRIFT_MESSAGE,
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
  CONFIRMED_FINDING_MESSAGE,
  FUZZY_CONTEXT_MESSAGE,
  HIGH_RISK_DRIFT_MESSAGE,
  promptForAutoHeal,
  redactSecrets,
  renderScanReceipt,
  SAFE_RECEIPT,
  scanDiff,
  STATES,
  colorizeUnifiedDiff
};
