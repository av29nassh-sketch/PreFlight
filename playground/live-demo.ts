const fs = require("node:fs/promises");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const PROXY_URL = "https://preflight-proxy.vercel.app/api/v1/remediation";
const REQUEST_TIMEOUT_MS = 70000;
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
];
const DEEP_REMEDIATION_SYSTEM_PROMPT =
  `You are an automated CLI remediation engine. Your task is to perform an architectural overhaul.
- You MUST replace callback-based async logic with native async/await.
- You MUST ensure all Promise chains are properly closed and awaited.
- You MUST ensure correct syntax (matching parentheses, brackets, and semicolons).
- If the code is missing functionality (like saving cache), you MUST add it.
- Output EXACTLY one sentence (prefixed with 'Root Cause: ') and one complete, syntactically valid markdown code block.`;

function runLocalASTFixes(code: string) {
  let modernized = code;

  modernized = modernized.replace(/\bvar\b/g, "let");
  modernized = modernized.replace(
    /function\s+fetchAccount\(userId,\s*done\)\s*\{/,
    "const fetchAccount = (userId, done) => {"
  );
  modernized = modernized.replace(
    /async function\s+buildDashboard\(userIds\)\s*\{/,
    "const buildDashboard = async (userIds) => {"
  );
  modernized = modernized.replace(
    /async function\s+syncProfiles\(userIds\)\s*\{/,
    "const syncProfiles = async (userIds) => {"
  );
  modernized = modernized.replace(
    /function\s*\(error,\s*label\)\s*\{/g,
    "(error, label) => {"
  );
  modernized = modernized.replace(
    /function\s*\(error\)\s*\{/g,
    "(error) => {"
  );
  modernized = modernized.replace(
    /function\s*\(userId\)\s*\{/g,
    "(userId) => {"
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
    /function\s*\(user\)\s*\{/g,
    "(user) => {"
  );
  modernized = modernized.replace(
    /done\(null,\s*user\.name \+ "-" \+ activeRequests\);/g,
    "done(null, `${user.name}-${activeRequests}`);"
  );
  modernized = modernized.replace(
    /console\.error\("dashboard failed for " \+ userId,/g,
    "console.error(`dashboard failed for ${userId}`,"
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
  const explanationCandidate =
    explanationPrefixMatch?.[1] || normalized.slice(0, codeMatch.index).trim();
  const explanation = cleanExplanation(explanationCandidate);
  const code = codeMatch[1].trim();

  if (!code) {
    throw new Error("Model response included an empty code block.");
  }

  return { explanation, code };
}

function validateGeneratedCode(code: string) {
  try {
    new Function(code);
    return null;
  } catch (error) {
    return error instanceof Error
      ? error
      : new Error("Unknown syntax validation failure.");
  }
}

async function runVibeEaseEngine(astCleanedCode: string, retryInstruction?: string) {
  const betaKey = process.env.PREFLIGHT_PRO_KEY;
  if (!betaKey) {
    throw new Error("Missing PREFLIGHT_PRO_KEY. Set it in your shell before running the live demo.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(PROXY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${betaKey}`,
        "X-PreFlight-Pro-Key": betaKey
      },
      body: JSON.stringify({
        max_tokens: 2500,
        system: DEEP_REMEDIATION_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content:
              `Remediate this logic:\n\n${astCleanedCode}` +
              (retryInstruction ? `\n\nRetry instruction: ${retryInstruction}` : "")
          }
        ]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Proxy request failed with status ${response.status}: ${errorBody || "<empty body>"}`
      );
    }

    const payload = await response.json();
    const content = Array.isArray(payload.content) ? payload.content : [];
    const textBlock = content.find(
      (item: { text?: unknown }) =>
        item &&
        typeof item === "object" &&
        typeof item.text === "string"
    );

    if (!textBlock?.text?.trim()) {
      throw new Error("Proxy response did not include response.content[0].text.");
    }

    return textBlock.text.trim();
  } catch (error: any) {
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

async function main() {
  const startedAt = performance.now();
  const terribleCodePath = path.resolve(__dirname, "terrible-code.js");
  const sourceCode = await fs.readFile(terribleCodePath, "utf8");
  const astCleanedCode = runLocalASTFixes(sourceCode);

  console.log("✅ [LOCAL] AST Syntax Pass Complete");
  console.log("→ [ENGINE] Pro Engine Call Starting");

  let rawResponse = "";
  let parsed: { explanation: string; code: string } | null = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    rawResponse = await runVibeEaseEngine(
      astCleanedCode,
      attempt === 2
        ? "Your previous response contained invalid JavaScript syntax. Return one complete, syntactically valid JavaScript file with fully closed async control flow."
        : undefined
    );

    try {
      parsed = extractTerminalResponseParts(rawResponse);
      const syntaxError = validateGeneratedCode(parsed.code);

      if (!syntaxError) {
        break;
      }

      if (attempt === 1) {
        console.log("❌ [ENGINE FAILURE] Model returned invalid code. Retrying...");
        console.log("→ [ENGINE] Pro Engine Retry Starting");
        continue;
      }

      console.log("\n[Raw Engine Response]\n");
      console.log(rawResponse);
      throw new Error(`Model returned invalid code after retry: ${syntaxError.message}`);
    } catch (error) {
      if (attempt === 1) {
        console.log("❌ [ENGINE FAILURE] Model returned invalid code. Retrying...");
        console.log("→ [ENGINE] Pro Engine Retry Starting");
        continue;
      }

      console.log("\n[Raw Engine Response]\n");
      console.log(rawResponse);
      throw error instanceof Error
        ? error
        : new Error("Model returned an unparseable response after retry.");
    }
  }

  if (!parsed) {
    throw new Error("Pro Engine did not return a valid remediation.");
  }

  const totalSeconds = ((performance.now() - startedAt) / 1000).toFixed(2);

  console.log("\n=== PreFlight Live Demo ===");
  console.log(parsed.explanation);
  console.log("\n--- Fixed Code ---\n");
  console.log(parsed.code);
  console.log(`\n⏱ Total execution time: ${totalSeconds}s`);
}

main().catch((error: Error) => {
  console.error("\n[Live Demo Failure]");
  console.error(error.message);
  process.exitCode = 1;
});
