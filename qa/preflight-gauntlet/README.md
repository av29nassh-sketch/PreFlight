# PreFlight Gauntlet

This folder is an intentionally vulnerable local corpus for testing PreFlight before release.
It includes two groups:

- `vulnerable/`: should trigger PreFlight findings.
- `safe/`: should stay quiet or avoid hard blocks. These files are false-positive traps.

Run from the repository root:

```powershell
node .\index.js scan .\qa\preflight-gauntlet
```

Run the release-gate/daemon-style scanner without patching:

```powershell
npx tsx -e "import { runReleaseGateScan } from './src/release-gate/pipeline'; (async () => { const r = await runReleaseGateScan({ targetDir: './qa/preflight-gauntlet', eyeActive: false }); console.log(JSON.stringify({ status: r.status, findings: r.findings.map(f => ({ file: f.file, line: f.line, severity: f.severity, issue: f.issue })), fuzzFindings: r.fuzzFindings.map(f => ({ file: f.file, line: f.line, severity: f.severity, type: f.type, issue: f.issue })) }, null, 2)); })();"
```

Run the Supabase migration parser directly:

```powershell
npx tsx src\migrations\index.ts .\qa\preflight-gauntlet\vulnerable\supabase\migrations
npx tsx src\migrations\index.ts .\qa\preflight-gauntlet\safe\supabase\migrations
```

Do not run `--fix` unless you intentionally want PreFlight to mutate these fixtures.

High-value things this corpus checks:

- Command injection across direct and multi-step flows.
- SQL injection across concatenation, template interpolation, and intermediate variables.
- SSRF from request-controlled URLs.
- Path traversal into filesystem reads.
- Hardcoded credential-shaped constants.
- Supabase service role leakage in client-like code.
- Missing Supabase RLS in migrations.
- Unsafe permissive RLS policies.
- Unpinned package dependencies.
- Safe parameterized SQL and validated command execution false-positive traps.

## Current Baseline On 2026-06-21

Legacy scanner:

- Catches command injection, SSRF, path traversal through `path.join(...)`, raw SQL concatenation, hardcoded backend secrets, account-scoped mutation without an auth guard, unpinned dependencies, and nested Supabase migrations missing RLS.
- Suppresses redundant `ambiguous-ast` warnings when a stronger local rule already proves the same issue.
- Does not flag the safe SQL template interpolation fixture where the table name is allowlisted and values remain parameterized.

Release-gate / daemon scanner:

- Catches unpinned dependencies, OpenAI-shaped test secret, bearer-shaped test token, broken auth/BOLA, command injection, path traversal, and SQL injection.
- Does not flag the allowlisted table interpolation false-positive trap.
- Parses TypeScript route fixtures cleanly without noisy soft syntax warnings.

Migration parser:

- Correctly hard-blocks missing RLS and unsafe `USING (true)` / `WITH CHECK (true)`.
- Correctly passes the safe RLS migration.
