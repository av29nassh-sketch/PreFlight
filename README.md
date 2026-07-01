# PreFlight

PreFlight helps AI-built Next.js, Supabase, Vercel, Cursor, Lovable, Bolt, and Claude-assisted codebases catch launch-blocking repo risk before production.

It combines a local AST security daemon, Micro-Fuzzer, Quantized Code Property Graph, MCP bridge, VS Code/Cursor companion extension, and native Windows fallback alerts to catch unsafe auth, RLS, SQL, SSRF, command execution, dependency, and secret-handling drift before it ships.

Website: [https://preflight-vibe.vercel.app](https://preflight-vibe.vercel.app)

## PreFlight Repo Risk Report

The current paid offer is a private, manually verified report for one public repo.

**Price:** `$49 global / ₹2,999 India`

**Delivery:** `48-72 hours`

**Included:** `1 month of PreFlight Pro access`
**Guarantee:** If the report does not contain at least one useful, verified issue, you get a full refund. No scanner noise.

What you get:

- Top 5 verified findings
- Exact file paths and severity
- Why each issue matters
- Suggested fix direction
- A short private report you can send to a founder, CTO, client, or engineering lead
- One month of PreFlight Pro so you can run the local guardrail after the report

Order from the website: [https://preflight-vibe.vercel.app](https://preflight-vibe.vercel.app)

## What PreFlight Checks

PreFlight is designed for the failure modes AI coding tools often introduce when they generate database, auth, payment, and backend code:

- Missing Supabase Row-Level Security (RLS)
- Unsafe or theatrical RLS policies such as broad `USING (true)` access
- Service-role keys leaking into client or route code
- Auth checks drifting out of scope
- Unsafe database mutations and IDOR-style ownership gaps
- Stripe/webhook integrity regressions
- Command injection, SQL injection, SSRF, and path traversal
- Hardcoded secrets and unsafe dependency ranges

## Tri-State Risk Score Engine

This is the core PreFlight signal. Every scan resolves into one of three clear outcomes so you know whether to stop, review, or ship.

| Score | Meaning | What It Catches |
| --- | --- | --- |
| 🔴 **Hard Block** | Stop immediately. This change is unsafe to ship. | Exposed frontend secrets, leaking database service roles, command execution, SQL injection, or missing Supabase Row Level Security (RLS). |
| 🟡 **High-Risk Drift** | Review carefully. The code may be structurally wrong even if it runs. | Structural state inconsistencies, un-idempotent webhooks, weak validation, or open CORS contexts. |
| 🟢 **Pass** | Safe to continue. No blocking structural risk was detected. | Standard local edits matching your expected stack rules. |

## Local CLI: PreFlight Guardian

Developers can also install the local CLI directly.

Free local usage includes:

- Unlimited local scans
- The Eye background daemon
- Native Windows popup fallback when no extension is connected
- MCP scan tooling
- 10 total patch applications across local deterministic fixes and proxy-backed AI fixes

Install and start The Eye:

```bash
npm install -g preflight-pro@latest
preflight start
```

Run a one-shot scan:

```bash
preflight scan .
```

Run scan with fixes:

```bash
preflight scan . --fix
```

## VS Code / Cursor Companion

The VS Code/Cursor extension is the optional visual layer. The core engine, daemon, MCP server, Windows fallback popup, and fix pipeline all live in the global `preflight` CLI.

1. Install the CLI:

```bash
npm install -g preflight-pro@latest
preflight start
```

2. Install the companion extension:

- [Download VSIX from the PreFlight website](https://preflight-vibe.vercel.app/downloads/preflight-companion-0.0.11.vsix)
- Or open [GitHub Releases](https://github.com/av29nassh-sketch/PreFlight/releases) and install the latest `preflight-companion` VSIX.
- In VS Code or Cursor, open the Extensions panel, click the `...` menu, choose `Install from VSIX...`, and select the downloaded file.

3. Save a file. The extension connects to The Eye daemon and surfaces PreFlight alerts in-editor.

If the extension is not installed or not connected, The Eye still runs. For terminal-only workflows and desktop AI agents, PreFlight falls back to a native Windows hard-block popup.

## Pro / Beta Keys

Free users get unlimited scans and 10 total patches across local fixes and proxy-backed AI fixes.

After the 10 free patches are used, unlimited fixes require a Pro/Beta key. Repo Risk Report buyers receive temporary PreFlight Pro access as part of the report package.

Activate a key:

```bash
preflight auth PREFLIGHT-BETA-XXXXX
```

For one terminal session, you can also set it manually:

```powershell
$env:PREFLIGHT_PRO_KEY="PREFLIGHT-BETA-XXXXX"
```

```bash
export PREFLIGHT_PRO_KEY="PREFLIGHT-BETA-XXXXX"
```

## The Eye and MCP

- **The Eye:** `preflight start` registers the current project and starts PreFlight's local daemon.
- **Windows fallback popup:** When no extension client is connected, the daemon shows a native Windows hard-block notification. This covers terminal-only users and desktop-agent users.
- **MCP bridge:** `preflight mcp` is available for supported AI editors so agents can call PreFlight tools without leaving the coding flow.

Start the MCP server locally:

```bash
preflight mcp
```

Available MCP tools include:

- `scan_project`
- `preflight_fix`
- `audit_dependencies`

`scan_project` remains free and unlimited. `preflight_fix` shares the global 10-patch free allowance before a `PREFLIGHT_PRO_KEY` is required.

## Engine Upgrades

PreFlight is powered by deeper local analysis primitives:

- **Micro-Fuzzer:** Generates focused security payloads for risky data-flow paths, such as SQL injection, command injection, auth bypass, SSRF, and path traversal.
- **Quantized CPG (Code Property Graph):** Builds a compact in-memory graph of syntax, control flow, and data flow so PreFlight can trace untrusted input into dangerous sinks instead of relying on brittle string matching.
- **The Eye daemon:** Runs locally through the CLI/extension workflow and watches file saves so issues appear while the AI coding session is still active. If the extension is not installed, Windows users still receive native popup alerts for hard-block findings.

## 2-Phase Fix Pipeline

PreFlight runs fixes in a strict sequence:

1. **Phase 1: Offline Local AST Sweep**
   PreFlight completes an ultra-fast offline structural pass first and applies any deterministic local fixes it can resolve safely.
2. **Phase 2: PreFlight Pro Deep Reasoning Handoff**
   Remaining SQL, fuzzer, and complex architectural flaws are handed off through the secure proxy-backed reasoning path when a patch requires deeper context.

The first 10 patch applications are free across both phases. After that, a `PREFLIGHT_PRO_KEY` is required.

## Post-Fix Verification Loop

PreFlight is designed to be used as a closed loop, not a one-shot scanner:

1. Generate or modify code with your AI coding assistant.
2. Run `preflight scan .` to classify the change under the Tri-State Risk Score.
3. If PreFlight returns `Hard Block`, stop and repair the structural issue before moving forward.
4. If PreFlight returns `High-Risk Drift`, run `preflight scan . --fix` and inspect every proposed fix before applying it.
5. Re-run `preflight scan .` after each accepted fix to confirm the repository settles into `Pass`.
6. Ship only after the final verification pass is green and the structural receipt matches the architecture boundary you intended.

This verification loop is the product: scan, review, patch, re-scan, then deploy with confidence.

## Usage Metrics

- **Website visits:** tracked through Vercel Web Analytics on [https://preflight-vibe.vercel.app](https://preflight-vibe.vercel.app). View them in the Vercel project dashboard under Analytics.
- **npm downloads:** run the local report command below. npm reports package downloads, not unique human users.

```bash
npm run analytics:npm
```

## Beta Architecture & Safety Notice

PreFlight Pro is currently in active Beta. While the local AST daemon is designed to catch severe structural anomalies, hallucinated syntax, and potential Supabase RLS drift in real time, it does not guarantee 100% error elimination.

AI-assisted code should always be explicitly reviewed by a senior engineer before being pushed to production. Use PreFlight as an advanced automated guardrail, not a replacement for manual code review.
