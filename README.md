<div align="center">

# 🛑 PreFlight Check

<img src="demo.gif" alt="PreFlight Terminal Demo" width="800"/>

**Stop AI coding drift before it becomes technical debt.**

</div>

Cursor and Claude can generate hundreds of lines before your coffee cools. That speed is the point, but it makes human review the bottleneck.

PreFlight Check is the local safety gate for fast-moving founders and vibecoders building with Next.js and Supabase. It catches the scary stuff before you commit: **silently modified database writes, altered auth logic, billing route changes, exposed secrets, and tenant-boundary drift**. Then it explains the risk in plain English so you do not have to reverse-engineer your own app at midnight.

## 🚦 The Tri-State Risk Score

PreFlight Check parses **structural logic**, not just regex matches. It looks at what changed, where it changed, and whether the diff touched security-sensitive code paths.

### 🔴 CONFIRMED FINDING (Hard Block)

AI injected a fatal flaw.

Examples: **exposed frontend secrets**, raw database writes, hardcoded billing keys, or missing Supabase RLS protections.

The commit is blocked. PreFlight explains the issue and requires explicit approval before applying an auto-patch.

### 🟡 HIGH-RISK DRIFT (Needs Runtime Check)

AI modified a sensitive boundary that cannot be proven safe from the local diff alone.

Examples: auth wrappers, tenant helpers, Supabase RPC calls, checkout routes, webhook handlers, or permission logic.

The CLI pauses the commit and outputs a **plain-English QA instruction** that tells you what deployed consequence to test before shipping.

### 🟢 LIKELY SAFE (Trust Receipt)

Structural security guards were verified.

The commit proceeds cleanly and PreFlight prints a receipt so you know the local guard actually ran.

## ⚡ Why PreFlight? (The Vibecoder Reality)

- **Zero-Latency Safety:** Runs locally in your terminal or as an MCP server, right where AI-generated code enters your workflow.
- **The "Plain-English" Translation:** Translates what the AI changed so devs do not have to reverse-engineer their own apps.
- **Zero Source Upload:** Runs entirely locally. Your code never leaves your machine.

## Quick Start

```bash
# Run a safe, read-only structural scan on uncommitted changes
npx preflight-guardian scan . --diff

# Run an interactive scan that lets you safely review and auto-patch findings
npx preflight-guardian scan --fix

# Hook it directly into Claude Code / Cursor via MCP
preflight install-mcp
```

## Built For The Messy Middle

PreFlight Check is not trying to be another dashboard you forget to open.

It is for the moment right before `git commit`, when your AI agent has touched a login route, a Supabase query, or a Stripe webhook and you need to know one thing:

**Did the AI just make my app easier to break?**

PreFlight answers that locally, quickly, and in language a builder can act on.
