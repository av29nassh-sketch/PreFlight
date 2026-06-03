# 🛫 PreFlight

**The local security gate for AI-generated code.**

AI coding agents (Codex, Cursor, Copilot) are incredibly fast, but they consistently make catastrophic deployment mistakes. PreFlight is a zero-knowledge, local CLI tool that uses `tree-sitter` AST parsing to catch these hallucinations before they get merged into your codebase.

### 🛡️ What it catches
* **Frontend Leaks:** Hardcoded `sk_live_` keys in Next.js client components.
* **Backend Leaks:** Exposed Database URLs and JWT secrets in `/api` routes.
* **Open Databases:** Supabase migrations missing `ENABLE ROW LEVEL SECURITY`.

---

## 🚀 The Free Scanner
The PreFlight scanner runs 100% locally. It never uploads your code to the cloud. You can run it manually or drop it directly into your GitHub Actions CI/CD pipeline to block dangerous PRs.

**Download the latest executable for your OS in the [Releases tab](https://github.com/av29nassh-sketch/PreFlight/releases/tag/v0.1.0).**

### Usage
Scan a specific directory:
```bash
preflight scan ./my-project
```

Scan only files recently changed by an AI agent (Git Diff):
```bash
preflight scan --diff
```

Block CI/CD pipelines with SARIF output:
```bash
preflight scan --diff --format=sarif
```

---

## 🛠️ The Auto-Fix Orchestrator (Pro)
If the scanner catches a vulnerability, you don't have to fix it manually. The **Auto-Fix Orchestrator** will safely isolate the broken file in a Git branch and queue an auto-repair prompt directly to your IDE. 

The Auto-Fix workflow is currently included in the 100% Free Beta while we battle-test the scanner and patching engine against real projects. Unlimited auto-patching will eventually become a paid feature, but final pricing is TBD.

No cloud telemetry. No source upload. Review every generated patch before deploying.

### Usage
```bash
preflight apply-fix ./my-project
```

---

## ⚙️ Configuration
You can ignore specific mock folders or rules by adding a `preflight.config.json` file to your project root:
```json
{
  "ignorePaths": ["tests", "mocks"],
  "ignoreRules": ["frontend-secret"]
}
```

---

## Pricing & Beta Status

PreFlight is currently in a 100% Free Beta while we battle-test the AI scanning and remediation workflow against real projects.

The scanner is free to use during this beta, and unlimited auto-patching is also available for testing. In the future, unlimited auto-patching will become a paid feature. Final pricing is still TBD.

---

## Disclaimer & Liability

This software is provided "AS IS", without warranties of any kind, express or implied, including but not limited to warranties of merchantability, fitness for a particular purpose, and non-infringement.

PreFlight may generate or suggest code patches using AI-assisted workflows. Users are solely responsible for reviewing, testing, and approving any AI-generated patches before deploying them to production or merging them into a codebase.
