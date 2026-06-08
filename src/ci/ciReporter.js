const fs = require("node:fs/promises");
const path = require("node:path");

function envFlag(value) {
  return value === true || /^(1|true|yes)$/i.test(String(value || ""));
}

function detectCiEnvironment(env = process.env) {
  if (envFlag(env.GITHUB_ACTIONS)) {
    return { isCi: true, provider: "github-actions" };
  }

  if (envFlag(env.GITLAB_CI)) {
    return { isCi: true, provider: "gitlab-ci" };
  }

  if (envFlag(env.CIRCLECI)) {
    return { isCi: true, provider: "circleci" };
  }

  if (envFlag(env.BUILDKITE)) {
    return { isCi: true, provider: "buildkite" };
  }

  if (envFlag(env.TF_BUILD)) {
    return { isCi: true, provider: "azure-pipelines" };
  }

  if (envFlag(env.CI)) {
    return { isCi: true, provider: "generic-ci" };
  }

  return { isCi: false, provider: "local" };
}

function toPosix(filePath) {
  return String(filePath || "").split(path.sep).join("/");
}

function relativeDisplayPath(filePath, rootDir = process.cwd()) {
  if (!filePath) {
    return "unknown";
  }

  const relativePath = path.relative(path.resolve(rootDir), filePath);
  return toPosix(relativePath && !relativePath.startsWith("..") ? relativePath : filePath);
}

function triStateFromFindings(findings = [], options = {}) {
  if (options.state) {
    return options.state;
  }

  if (!findings || findings.length === 0) {
    return "🟢 LIKELY SAFE (Trust Receipt)";
  }

  if (findings.some((finding) => ["critical", "high", "error"].includes(String(finding.severity || "").toLowerCase()))) {
    return "🔴 CONFIRMED FINDING (Hard Block)";
  }

  return "🟡 HIGH-RISK DRIFT (Needs Runtime Check)";
}

function renderFindingsTable(findings = [], options = {}) {
  if (findings.length === 0) {
    return "No findings detected.";
  }

  return [
    "| Severity | Rule | Location | Message |",
    "| :--- | :--- | :--- | :--- |",
    ...findings.slice(0, 50).map((finding) => {
      const severity = finding.severity || finding.kind || "warning";
      const rule = finding.ruleId || finding.kind || "preflight";
      const location = `${relativeDisplayPath(finding.filePath, options.rootDir)}:${finding.line || 1}`;
      const message = String(finding.message || finding.label || finding.evidence || "Review required.").replace(/\r?\n/g, " ");
      return `| ${severity} | \`${rule}\` | \`${location}\` | ${message} |`;
    })
  ].join("\n");
}

function renderCiMarkdownSummary(findings = [], options = {}) {
  const triState = triStateFromFindings(findings, options);
  const fixResult = options.fixResult;
  const lines = [
    "## PreFlight Guardian CI Summary",
    "",
    `**Tri-State Risk Score:** ${triState}`,
    "",
    `**Findings:** ${findings.length}`,
    ""
  ];

  if (fixResult) {
    lines.push(
      "**Remediation:**",
      "",
      `- Attempted: ${fixResult.attempted || 0}`,
      `- Applied: ${fixResult.applied || 0}`,
      `- Skipped: ${fixResult.skipped || 0}`,
      `- Unsupported: ${fixResult.unsupported || 0}`,
      ""
    );
  }

  lines.push(renderFindingsTable(findings, options), "");
  return lines.join("\n");
}

async function writeCiStepSummary(markdown, options = {}) {
  const env = options.env || process.env;
  const ci = detectCiEnvironment(env);
  const summaryPath = env.GITHUB_STEP_SUMMARY;

  if (!ci.isCi || ci.provider !== "github-actions" || !summaryPath) {
    return false;
  }

  await fs.appendFile(summaryPath, `${markdown}\n`, "utf8");
  return true;
}

async function reportCiFindings(findings = [], options = {}) {
  const markdown = renderCiMarkdownSummary(findings, options);
  await writeCiStepSummary(markdown, options);
  return markdown;
}

module.exports = {
  detectCiEnvironment,
  renderCiMarkdownSummary,
  reportCiFindings,
  triStateFromFindings,
  writeCiStepSummary
};
