# PreFlight Hackathon Module Scaffold

This scaffold keeps the hackathon features isolated from the current production scanner until each module is approved and wired in.

## Package Runtime

- CLI binary remains `preflight` through `cli.js`.
- Package remains CommonJS for compatibility with the current published CLI.
- TypeScript is available for new isolated modules, but existing JavaScript runtime paths are untouched.
- `chokidar`, `ink`, and `react` are added for Watch Mode and the TUI Release Gate.
- `pgsql-ast-parser` and existing Tree-sitter packages remain the SQL/code parsing layer.

## Proposed Folder Layout

```text
src/
  eye/
    watcher.ts
    eventQueue.ts
    ignoreRules.ts
    mutationGuard.ts

  migrations/
    supabaseMigrationParser.ts
    rlsPolicyRules.ts
    sqlFindingTypes.ts

  fast-checks/
    secretsInterceptor.ts
    supplyChainUnpinner.ts
    fastCheckTypes.ts

  tui/
    ReleaseGateApp.tsx
    FindingGroup.tsx
    RiskBadge.tsx
    keybindings.ts

  release-gate/
    releaseGateModel.ts
    mcpPatchHandoff.ts
    scanResultAdapter.ts
```

## Module Boundaries

### The Eye

Owns file-system watching only. It should debounce, dedupe, ignore noisy directories, and call the existing scan pipeline. It should not implement scanner rules directly.

### Supabase Migration Parser

Owns SQL migration inspection. It should detect `CREATE TABLE`, verify `ENABLE ROW LEVEL SECURITY`, and flag unsafe policies such as tautological `using (true)` conditions.

### 0-Token Fast Checkers

Owns cheap local checks that never call a model. It should run before any expensive or MCP-backed remediation path.

### TUI Release Gate

Owns rendering and keyboard interaction only. It receives normalized findings from the scan pipeline and emits user actions such as `patch-requested`.

### Release Gate Adapter

Owns conversion between existing PreFlight findings and the TUI/MCP handoff model. This keeps the UI from depending directly on scanner internals.

