import { describe, expect, test } from "vitest";

const PROXY_URL = "https://preflight-proxy.vercel.app/api/v1/remediation";
const PREFLIGHT_BETA_KEY = "PREFLIGHT-BETA-AVINASH";
const REQUEST_TIMEOUT_MS = 70000;

const DEEP_REMEDIATION_SYSTEM_PROMPT =
  `You are an automated CLI remediation engine. Your output is consumed directly by a terminal interface.
RULES:
- You MUST start your response EXACTLY with the phrase "Root Cause: " followed by one complete, grammatically correct sentence.
- Then provide EXACTLY one markdown code block.
- DO NOT output anything else.`;

const FALLBACK_ROOT_CAUSE =
  "Root Cause: Architectural vulnerabilities and async/state mutations resolved.";

const EXPLANATION_BLACKLIST = [
  "remediated",
  "here's",
  "here is",
  "corrected",
  "version",
  "below",
  "fixed"
] as const;

const brokenCode = `
var sharedCache = {};
var globalCounter = 0;
var pendingUsers = [];

function loadUserProfile(userId, done) {
  globalCounter = globalCounter + 1;

  if (!sharedCache[userId]) {
    sharedCache[userId] = { loading: true, data: null };
  }

  setTimeout(function () {
    fetchUser(userId, function (err, user) {
      if (err) {
        done(err);
        return;
      }

      sharedCache[userId].data = user;
      sharedCache[userId].loading = false;
      pendingUsers.push(userId);

      return done(null, user);
    });
  }, 10);
}

function refreshDashboard(ids, done) {
  var results = [];

  ids.forEach(function (id) {
    loadUserProfile(id, function (err, user) {
      if (err) {
        done(err);
        return;
      }

      results.push(user.name + "-" + globalCounter);
    });
  });

  setTimeout(function () {
    if (results.length === ids.length) {
      return done(null, results.join(","));
    }
  }, 5);
}

async function syncReports(ids) {
  ids.map(function (id) {
    loadUserProfile(id, function () {});
  });

  const report = saveAuditTrail(ids);
  sharedCache.lastReport = report;

  return report;
}
`;

function runLocalASTFixes(code: string) {
  let modernized = code;

  modernized = modernized.replace(/\bvar\b/g, "let");
  modernized = modernized.replace(
    /function\s+loadUserProfile\(userId,\s*done\)\s*\{/,
    "const loadUserProfile = (userId, done) => {"
  );
  modernized = modernized.replace(
    /function\s+refreshDashboard\(ids,\s*done\)\s*\{/,
    "const refreshDashboard = (ids, done) => {"
  );
  modernized = modernized.replace(
    /function\s*\(err,\s*user\)\s*\{/g,
    "(err, user) => {"
  );
  modernized = modernized.replace(
    /function\s*\(\)\s*\{\}/g,
    "() => {}"
  );
  modernized = modernized.replace(
    /function\s*\(\)\s*\{/g,
    "() => {"
  );
  modernized = modernized.replace(
    /function\s*\(id\)\s*\{/g,
    "(id) => {"
  );
  modernized = modernized.replace(
    /function\s*\(err\)\s*\{/g,
    "(err) => {"
  );
  modernized = modernized.replace(
    /user\.name \+ "-" \+ globalCounter/g,
    "`${user.name}-${globalCounter}`"
  );

  return modernized;
}

function cleanExplanation(rawExplanation: string) {
  const withoutMarkdown = rawExplanation
    .replace(/[#*>`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const withoutPrefix = withoutMarkdown.replace(/^Root Cause:\s*/i, "").trim();
  const firstAlphaNumericIndex = withoutPrefix.search(/[A-Za-z0-9]/);

  if (firstAlphaNumericIndex === -1) {
    return FALLBACK_ROOT_CAUSE;
  }

  const candidate = withoutPrefix.slice(firstAlphaNumericIndex).trim();
  const candidateLower = candidate.toLowerCase();

  const hasBlacklistedPhrase = EXPLANATION_BLACKLIST.some((phrase) =>
    candidateLower.includes(phrase)
  );
  const hasRejectedEnding = /:\.$|:\s*$/.test(candidate);
  const hasHeadingLikeCaps = /\b[A-Z]{2,}\b/.test(candidate);

  if (hasBlacklistedPhrase || hasRejectedEnding || hasHeadingLikeCaps) {
    return FALLBACK_ROOT_CAUSE;
  }

  const firstPeriodIndex = candidate.indexOf(".");
  let sentence =
    firstPeriodIndex >= 0
      ? candidate.slice(0, firstPeriodIndex + 1)
      : candidate;

  sentence = sentence.replace(/\s+/g, " ").trim();

  if (sentence.length < 15) {
    return FALLBACK_ROOT_CAUSE;
  }

  if (!sentence.endsWith(".")) {
    sentence = `${sentence}.`;
  }

  return `Root Cause: ${sentence}`;
}

function extractTerminalResponseParts(rawText: string) {
  const normalized = rawText.trim();
  const codeMatch = normalized.match(/```(?:[A-Za-z0-9_-]+)?\r?\n([\s\S]*?)```/);

  if (!codeMatch) {
    throw new Error("Model response did not contain a markdown code block.");
  }

  const explanationPrefixMatch = normalized.match(/Root Cause:\s*([\s\S]*?)```/i);
  const explanationCandidate = explanationPrefixMatch?.[1] || normalized.slice(0, codeMatch.index).trim();
  const explanation = cleanExplanation(explanationCandidate);
  const code = codeMatch[1].trim();

  if (!code) {
    throw new Error("Model response included an empty code block.");
  }

  return { explanation, code };
}

async function runVibeEaseEngine(astCleanedCode: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(PROXY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PREFLIGHT_BETA_KEY}`,
        "X-PreFlight-Pro-Key": PREFLIGHT_BETA_KEY
      },
      body: JSON.stringify({
        max_tokens: 2500,
        system: DEEP_REMEDIATION_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Remediate this logic:\n\n${astCleanedCode}`
          }
        ]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Proxy request failed with status ${response.status}: ${errorBody || "<empty body>"}`);
    }

    const responseText = await response.text();
    let payload: Record<string, unknown>;

    try {
      payload = JSON.parse(responseText) as Record<string, unknown>;
    } catch {
      throw new Error(`Proxy response was not valid JSON: ${responseText || "<empty body>"}`);
    }

    const content = Array.isArray(payload.content) ? payload.content : [];
    const textBlock = content.find(
      (item) =>
        item &&
        typeof item === "object" &&
        "text" in item &&
        typeof (item as { text?: unknown }).text === "string"
    ) as { text: string } | undefined;

    if (!textBlock?.text?.trim()) {
      throw new Error("Proxy response did not include response.content[0].text.");
    }

    return textBlock.text.trim();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `Proxy request timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)} seconds.`
      );
    }

    throw error instanceof Error
      ? error
      : new Error("Unknown proxy communication failure.");
  } finally {
    clearTimeout(timeout);
  }
}

describe("VibeEase pipeline smoke fixture", () => {
  test("parses a perfect Sonnet response without using the fallback", () => {
    const response = [
      "Root Cause: Asynchronous callbacks complete out of order, leaving shared state mutated before dependent work finishes.",
      "```javascript",
      "const value = await Promise.resolve('fixed');",
      "```"
    ].join("\n");

    const parsed = extractTerminalResponseParts(response);

    expect(parsed.explanation).toBe(
      "Root Cause: Asynchronous callbacks complete out of order, leaving shared state mutated before dependent work finishes."
    );
    expect(parsed.explanation).not.toBe(FALLBACK_ROOT_CAUSE);
    expect(parsed.code).toBe("const value = await Promise.resolve('fixed');");
  });

  test("rejects garbage Sonnet explanation text and applies the deterministic fallback", () => {
    const response = [
      "Root Cause: ### Here's the remediated code below: corrected version of the fix",
      "```ts",
      "export const fixed = true;",
      "```"
    ].join("\n");

    const parsed = extractTerminalResponseParts(response);

    expect(parsed.explanation).toBe(FALLBACK_ROOT_CAUSE);
    expect(parsed.code).toBe("export const fixed = true;");
  });

  const liveProxyTest =
    process.env.PREFLIGHT_RUN_LIVE_PIPELINE === "1" ? test : test.skip;

  liveProxyTest("hits the live Vercel proxy with AST-cleaned code", async () => {
    const astCleanedCode = runLocalASTFixes(brokenCode);
    const rawResponse = await runVibeEaseEngine(astCleanedCode);
    const parsed = extractTerminalResponseParts(rawResponse);

    expect(parsed.explanation.startsWith("Root Cause: ")).toBe(true);
    expect(parsed.code.length).toBeGreaterThan(40);
    expect(parsed.code).toMatch(/async|Promise|await|const|class/);
  }, 120000);
});
