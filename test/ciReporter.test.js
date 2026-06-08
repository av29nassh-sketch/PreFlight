const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const roots = [];

function makeTempDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-ci-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop(), { recursive: true, force: true });
  }
});

describe("ciReporter", () => {
  test("detects common CI environments", () => {
    const { detectCiEnvironment } = require("../src/ci/ciReporter");

    expect(detectCiEnvironment({ CI: "true" })).toMatchObject({ isCi: true, provider: "generic-ci" });
    expect(detectCiEnvironment({ GITHUB_ACTIONS: "true" })).toMatchObject({ isCi: true, provider: "github-actions" });
    expect(detectCiEnvironment({ GITLAB_CI: "true" })).toMatchObject({ isCi: true, provider: "gitlab-ci" });
    expect(detectCiEnvironment({})).toEqual({ isCi: false, provider: "local" });
  });

  test("renders and writes a GitHub Step Summary", async () => {
    const {
      renderCiMarkdownSummary,
      writeCiStepSummary
    } = require("../src/ci/ciReporter");
    const root = makeTempDir();
    const summaryPath = path.join(root, "summary.md");
    const findings = [
      {
        ruleId: "frontend-secret",
        severity: "critical",
        filePath: path.join(root, "app/page.tsx"),
        line: 3,
        message: "Secret exposed.",
        evidence: "Stripe Secret Key"
      }
    ];

    const markdown = renderCiMarkdownSummary(findings, { rootDir: root });
    await writeCiStepSummary(markdown, {
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_STEP_SUMMARY: summaryPath
      }
    });

    expect(markdown).toContain("## PreFlight Guardian CI Summary");
    expect(markdown).toContain("Tri-State Risk Score");
    expect(markdown).toContain("frontend-secret");
    expect(fs.readFileSync(summaryPath, "utf8")).toBe(`${markdown}\n`);
  });
});
