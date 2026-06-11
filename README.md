# PreFlight

Stop AI Coding Drift before it becomes production technical debt. PreFlight is a local-first safety gate and deterministic orchestration engine designed to catch risky, hallucinated, or unverified AI-generated code snippets inside modern AI coding workflows.

## The Tri-State Risk Score Engine

PreFlight parses your code down to an Abstract Syntax Tree (AST) using Tree-Sitter, passing ambiguous findings through deep reasoning layers to enforce explicit architectural contracts:

- Hard Block: Exposed frontend secrets, leaking database service roles, or missing Supabase Row Level Security (RLS).
- High-Risk Drift: Structural state inconsistencies, un-idempotent webhooks, or open CORS contexts.
- Likely Safe: Standard algorithmic changes matching your pre-defined stack rules.

## Product Tiers

- PreFlight Guardian: Our free-tier local engine. Protects against basic structural defects and provides up to 5 auto-fixes.
- PreFlight Pro: Our premium engine unlocking unlimited deep reasoning auto-fixes powered by PreFlight's advanced cloud reasoning model.

## Installation & Beta Activation

PreFlight works completely out of the box for free immediate local AST scanning. Unlocking the premium PreFlight Pro Deep Reasoning pipeline requires an issued beta key set to your environment variables.

### 🚀 PreFlight Pro Quick Start

1. Install PreFlight globally:

```bash
npm install -g preflight-cli
```

2. Set your private Pro Engine Key:

```powershell
# PowerShell
$env:PREFLIGHT_PRO_KEY="PREFLIGHT-BETA-XXXXX"
```

```bash
# Bash / macOS
export PREFLIGHT_PRO_KEY="PREFLIGHT-BETA-XXXXX"
```

3. Fire the multi-tier auto-fix engine:

```bash
preflight scan ./your-project-dir --fix
```

👉 💡 Pro-Tip: Once installed globally, you never have to mess with relative script paths again. You can directly invoke `preflight scan .` from inside any project directory on your machine to scan it instantly.

## PreFlight Pro (Paid Tier / Beta)

PreFlight Pro is the paid tier of the product and is currently running as an invite-only beta.

### Pricing Transparency

- Free Tier: 100% offline AST syntax scanning and basic structural auto-fixes.
- Solo Founder Tier: `$19/month`. Unlocks the premium Deep Reasoning Pipeline.
- Team Tier: `$49/seat/month`. Unlocks the premium Deep Reasoning Pipeline for collaborative rollout.

### Pro Command Runtime

If you are part of the closed beta, set your Pro key inside the same shell session before running `--fix`.

```powershell
$env:PREFLIGHT_PRO_KEY="PREFLIGHT-BETA-YYYYMMDD-XXXX"
preflight scan . --fix
```

```bash
export PREFLIGHT_PRO_KEY="PREFLIGHT-BETA-YYYYMMDD-XXXX"
preflight scan ./path-to-code --fix
```

### 2-Phase Pipeline

PreFlight Pro now runs as a strict 2-phase remediation pipeline:

1. Phase 1: Offline Local AST Sweep
   PreFlight completes an ultra-fast offline structural pass first and applies any local-only fixes it can resolve without calling the cloud reasoning layer.
2. Phase 2: PreFlight Pro Deep Reasoning Handoff
   Only the remaining SQL and complex architectural flaws are handed off through the secure proxy-backed Pro Engine reasoning path for premium remediation suggestions.

## Editor & MCP Usage

PreFlight can run directly in the terminal or as an MCP server for AI-native editors.

Start the MCP server locally:

```bash
node index.js mcp
```

Available MCP tools include:

- `scan_project`
- `preflight_fix`
- `audit_dependencies`

## Post-Fix Verification Loop

PreFlight is designed to be used as a closed loop, not a one-shot scanner:

1. Generate or modify code with your AI coding assistant.
2. Run `preflight scan .` to classify the change under the Tri-State Risk Score.
3. If PreFlight returns `Hard Block`, stop and repair the structural issue before moving forward.
4. If PreFlight returns `High-Risk Drift`, run `preflight scan . --fix` and inspect every proposed fix before applying it.
5. Re-run `preflight scan .` after each accepted fix to confirm the repository settles into `Likely Safe`.
6. Ship only after the final verification pass is green and the structural receipt matches the architecture boundary you intended.

This verification loop is the product: scan, review, patch, re-scan, then deploy with confidence.
