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

**Pricing:**
* **Global License:** $49 (One-time lifetime access)
* **India Localized License:** ₹1,999 (One-time lifetime access)

No subscriptions. No cloud telemetry. 

👉 **[Get notified when the Auto-Fix licenses go live this Friday!](https://github.com/av29nassh-sketch/PreFlight/issues/1)**
*(Note: The Auto-Fix engine is currently in final beta, but the scanner is 100% free to use today).*

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
