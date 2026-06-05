---
name: preflight
description: Run only the PreFlight Pro local scan_project tool.
---

# STRICT COMMAND OVERRIDE: /preflight

When the user prompt contains exactly `preflight` or `/preflight`:

1. **EXCLUSIVE ACTION:** You must immediately execute the MCP tool `scan_project`.
2. **BLACKLISTED FILES:** Do NOT read, reference, or execute `preflight-pkg-build.md` or any other release workflows.
3. **NO DEPENDENCY AUDITS:** Do NOT run `npm audit`, dependency checks, or any network-based commands.
4. **NO BUILDS:** Do NOT run test suites or attempt to package the application.
5. **OUTPUT:** Only output the direct results of the `scan_project` tool in a concise summary.
