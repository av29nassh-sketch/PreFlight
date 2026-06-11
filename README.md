# PreFlight 🚀

Stop AI Coding Drift before it becomes production technical debt. PreFlight is a local-first safety gate and deterministic orchestration engine designed to catch risky, hallucinated, or unverified AI-generated code snippets inside Claude, Cursor, and Copilot workflows.

## 🧠 The Tri-State Risk Score Engine
PreFlight parses your code down to an Abstract Syntax Tree (AST) using Tree-Sitter, passing ambiguous findings through deep reasoning layers to enforce explicit architectural contracts:
- 🔴 **Hard Block**: Exposed frontend secrets, leaking database service roles, or missing Supabase Row Level Security (RLS).
- 🟡 **High-Risk Drift**: Structural state inconsistencies, un-idempotent webhooks, or open CORS contexts.
- 🟢 **Likely Safe**: Standard algorithmic changes matching your pre-defined stack rules.

## 📦 Product Tiers
- **PreFlight Guardian**: Our free-tier local engine. Protects against basic structural defects and provides up to 5 auto-fixes.
- **PreFlight Pro**: Our premium engine unlocking unlimited deep reasoning auto-fixes powered by optimized `claude-sonnet-4-6` routing.

## 🛠️ Installation & Beta Activation

To participate in the PreFlight Pro Closed Beta, clone the repository locally:

```bash
git clone https://github.com/av29nassh-sketch/PreFlight.git
cd PreFlight
npm install
```

Run a local Guardian scan:

```bash
node index.js scan .
```

Run an interactive remediation pass:

```bash
node index.js scan . --fix
```

## 🚀 PreFlight Pro (Paid Tier / Beta)

PreFlight Pro is the paid tier of the product and is currently running as an invite-only beta.

### Pricing Transparency
- **Free Tier**: 100% offline AST syntax scanning and basic structural auto-fixes.
- **Pro Tier**: `$29/month` per developer. Unlocks the Claude Deep Reasoning pipeline.

### Pro Command Runtime

If you are part of the closed beta, set your Pro key inside the same shell session before running `--fix`.

Note: the current CLI runtime reads `PREFLIGHT_PRO_KEY`.

```bash
$env:PREFLIGHT_PRO_KEY="PREFLIGHT-BETA-YYYYMMDD-XXXX"
node index.js scan . --fix
```

```bash
export PREFLIGHT_PRO_KEY="PREFLIGHT-BETA-YYYYMMDD-XXXX"
node ./index.js scan ./path-to-code --fix
```

### 2-Phase Pipeline

PreFlight Pro now runs as a strict 2-phase remediation pipeline:

1. **Phase 1: Offline Local AST Sweep**
   PreFlight completes an ultra-fast offline structural pass first and applies any local-only fixes it can resolve without calling Claude.
2. **Phase 2: Claude Deep Reasoning Handoff**
   Only the remaining SQL and complex architectural flaws are handed off through the secure proxy-backed Claude reasoning path for premium remediation suggestions.

## 🔌 Editor & MCP Usage

PreFlight can run directly in the terminal or as an MCP server for AI-native editors.

Start the MCP server locally:

```bash
node index.js mcp
```

Available MCP tools include:
- `scan_project`
- `preflight_fix`
- `audit_dependencies`

## ✅ Post-Fix Verification Loop

PreFlight is designed to be used as a closed loop, not a one-shot scanner:

1. Generate or modify code with Claude, Cursor, Copilot, or another AI assistant.
2. Run `node index.js scan .` to classify the change under the Tri-State Risk Score.
3. If PreFlight returns `🔴 Hard Block`, stop and repair the structural issue before moving forward.
4. If PreFlight returns `🟡 High-Risk Drift`, run `node index.js scan . --fix` and inspect every proposed fix before applying it.
5. Re-run `node index.js scan .` after each accepted fix to confirm the repository settles into `🟢 Likely Safe`.
6. Ship only after the final verification pass is green and the structural receipt matches the architecture boundary you intended.

This verification loop is the product: scan, review, patch, re-scan, then deploy with confidence.
