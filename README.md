# PreFlight

Stop AI Coding Drift before it becomes production technical debt. PreFlight is a local-first safety gate for AI-generated code, built to catch unsafe auth, RLS, SQL, SSRF, command execution, dependency, and secret-handling changes before they get committed.

Website: [https://preflight-vibe.vercel.app](https://preflight-vibe.vercel.app)

## Choose Your Remediation Depth

PreFlight runs in two distinct tiers depending on what your codebase needs.

### Free Tier: PreFlight Guardian

- **What it does:** Unlimited local scanning plus 10 free patch applications across local deterministic fixes and proxy-backed AI fixes.
- **Setup:** Zero config for scanning. A Pro key is only required after the 10 free patches are used.
- **Commands:**

```bash
npm install -g preflight-pro
preflight start
preflight scan . --fix
```

Installing `preflight-pro` exposes the universal `preflight` command in your shell.

### Pro Tier: PreFlight Pro

- **What it does:** Unlimited scans and unlimited fixes, including deep reasoning remediation for complex multi-file architectural flaws, tenant isolation logic, and parametric SQL injections.
- **Setup:** Requires an active `PREFLIGHT_PRO_KEY` or a saved key from `preflight auth`.
- **PowerShell:**

```powershell
$env:PREFLIGHT_PRO_KEY="PREFLIGHT-BETA-XXXXX"
preflight scan . --fix
```

- **Bash / macOS:**

```bash
export PREFLIGHT_PRO_KEY="PREFLIGHT-BETA-XXXXX"
preflight scan . --fix
```

## Installation Flow

PreFlight supports both a terminal-first workflow and an IDE-first workflow. Both paths start with the same global CLI and use `preflight start` to activate The Eye daemon for the current project.

### Path A: CLI

```bash
npm install -g preflight-pro
preflight start
```

Then scan any project from its root:

```bash
preflight scan . --fix
```

### Path B: VS Code / Cursor

1. Install the global CLI command. The VSIX is optional: it gives you the in-editor visual layer, but the engine, daemon, MCP server, Windows fallback popup, and fix pipeline all live in the global `preflight` CLI.

```bash
npm install -g preflight-pro
```

2. Download and install the PreFlight Companion VSIX extension:

- [Download VSIX from the PreFlight website](https://preflight-vibe.vercel.app/downloads/preflight-companion-0.0.4.vsix)
- Or open [GitHub Releases](https://github.com/av29nassh-sketch/PreFlight/releases) and install the latest `preflight-companion` VSIX.
- In VS Code or Cursor, open the Extensions panel, click the `...` menu, choose `Install from VSIX...`, and select the downloaded file.

3. Activate PreFlight once inside the project:

```bash
preflight start
```

4. Open your project in the IDE. The extension connects to The Eye, watches file saves through the daemon, and surfaces PreFlight alerts in-editor.

If the VS Code/Cursor extension is not installed or not connected, The Eye still runs. For terminal-only workflows and desktop AI agents, PreFlight falls back to a native Windows popup when a hard-block vulnerability is detected.

### The Eye and MCP

- **The Eye:** `preflight start` registers the current project and starts PreFlight's local daemon. The VS Code/Cursor extension is the optional visual layer that adds squiggles, IDE alerts, and fix buttons.
- **Windows fallback popup:** When no extension client is connected, the daemon shows a native Windows hard-block notification instead. This covers terminal-only users and desktop-agent users who do not install the VSIX.
- **MCP bridge:** `preflight mcp` is available for supported AI editors so agents can call PreFlight tools without leaving the coding flow.

### Beta / Pro Keys

Free users get unlimited scans and 10 total patches across local fixes and proxy-backed AI fixes. After the 10 free patches are used, unlimited fixes require a Pro/Beta key.

You can activate your key directly:

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

## Usage Metrics

- **Website visits:** tracked through Vercel Web Analytics on [https://preflight-vibe.vercel.app](https://preflight-vibe.vercel.app). View them in the Vercel project dashboard under Analytics.
- **npm downloads:** run the local report command below. npm reports package downloads, not unique human users.

```bash
npm run analytics:npm
```

## Pricing

- **Free Tier:** Unlimited scans, 10 Free Patches (Local + Deep-Reasoning AI).
- **Solo Pro:** $19/mo for unlimited scans and fixes.
- **Teams:** $49/seat/mo for team rollout, shared onboarding, and unlimited scans and fixes.

## Engine Upgrades

PreFlight is now powered by deeper local analysis primitives:

- **Micro-Fuzzer:** Generates focused security payloads for risky data-flow paths, such as SQL injection, command injection, auth bypass, SSRF, and path traversal.
- **Quantized CPG (Code Property Graph):** Builds a compact in-memory graph of syntax, control flow, and data flow so PreFlight can trace untrusted input into dangerous sinks instead of relying on brittle string matching.
- **The Eye daemon:** Runs locally through the CLI/extension workflow and watches file saves so issues appear while the AI coding session is still active. If the extension is not installed, Windows users still receive native popup alerts for hard-block findings.

## Tri-State Risk Score Engine

This is the core PreFlight signal. Every scan resolves into one of three clear outcomes so you know whether to stop, review, or ship.

| Score | Meaning | What It Catches |
| --- | --- | --- |
| 🔴 **Hard Block** | Stop immediately. This change is unsafe to ship. | Exposed frontend secrets, leaking database service roles, command execution, SQL injection, or missing Supabase Row Level Security (RLS). |
| 🟡 **High-Risk Drift** | Review carefully. The code may be structurally wrong even if it runs. | Structural state inconsistencies, un-idempotent webhooks, weak validation, or open CORS contexts. |
| 🟢 **Pass** | Safe to continue. No blocking structural risk was detected. | Standard local edits matching your expected stack rules. |

## 2-Phase Pipeline

PreFlight runs fixes in a strict sequence:

1. **Phase 1: Offline Local AST Sweep**
   PreFlight completes an ultra-fast offline structural pass first and applies any deterministic local fixes it can resolve safely.
2. **Phase 2: PreFlight Pro Deep Reasoning Handoff**
   Remaining SQL, fuzzer, and complex architectural flaws are handed off through the secure proxy-backed reasoning path when a patch requires deeper context.

The first 10 patch applications are free across both phases. After that, a `PREFLIGHT_PRO_KEY` is required.

## Editor & MCP Usage

PreFlight can run directly in the terminal, through the VS Code/Cursor extension, or as an MCP server for AI-native editors.

Start the MCP server locally:

```bash
preflight mcp
```

Available MCP tools include:

- `scan_project`
- `preflight_fix`
- `audit_dependencies`

`scan_project` remains free and unlimited. `preflight_fix` shares the global 10-patch free allowance before a `PREFLIGHT_PRO_KEY` is required.

## Post-Fix Verification Loop

PreFlight is designed to be used as a closed loop, not a one-shot scanner:

1. Generate or modify code with your AI coding assistant.
2. Run `preflight scan .` to classify the change under the Tri-State Risk Score.
3. If PreFlight returns `Hard Block`, stop and repair the structural issue before moving forward.
4. If PreFlight returns `High-Risk Drift`, run `preflight scan . --fix` and inspect every proposed fix before applying it.
5. Re-run `preflight scan .` after each accepted fix to confirm the repository settles into `Pass`.
6. Ship only after the final verification pass is green and the structural receipt matches the architecture boundary you intended.

This verification loop is the product: scan, review, patch, re-scan, then deploy with confidence.
