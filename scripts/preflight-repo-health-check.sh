#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
E2E_DIR="$ROOT_DIR/.preflight-e2e"
CLI_BIN="${PREFLIGHT_CLI:-preflight}"

log() {
  printf '\n\033[1;36m==> %s\033[0m\n' "$*"
}

fail() {
  printf '\n\033[1;31mQA FAILED:\033[0m %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    printf '%s\n' "$haystack" >&2
    fail "Expected $label to contain: $needle"
  fi
}

run_expect_status() {
  local expected="$1"
  shift
  set +e
  local output
  output="$("$@" 2>&1)"
  local status=$?
  set -e
  printf '%s' "$output"
  if [[ "$status" -ne "$expected" ]]; then
    fail "Expected exit $expected but got $status for: $*"
  fi
}

cd "$ROOT_DIR"

log "Phase 1: dependency and build verification"
rm -rf node_modules package-lock.json dist
npm install
npm run build:bin:win

log "Phase 2: core test suite execution"
npm test

log "Phase 3: global CLI binary test through npm link"
npm link
command -v preflight >/dev/null || fail "preflight binary was not linked"
command -v preflight-guardian >/dev/null || fail "preflight-guardian binary was not linked"

if command -v preflight-guardian >/dev/null 2>&1; then
  printf 'Package-name alias found: preflight-guardian\n'
else
  printf 'Note: package name is preflight-guardian, but the package-name bin was not linked.\n'
  printf 'Using %s for global binary checks.\n' "$CLI_BIN"
fi

"$CLI_BIN" --help >/tmp/preflight-help.txt
"$CLI_BIN" --version >/tmp/preflight-version.txt
assert_contains "$(cat /tmp/preflight-help.txt)" "Usage:" "--help output"
assert_contains "$(cat /tmp/preflight-version.txt)" "$(node -p "require('./package.json').version")" "--version output"

log "Phase 4: E2E mock directory execution"
rm -rf "$E2E_DIR"
mkdir -p "$E2E_DIR/supabase/migrations" "$E2E_DIR/app/api/webhooks/stripe" "$E2E_DIR/app/safe"
cd "$E2E_DIR"
git init -q -b main
git config user.email "qa@preflight.local"
git config user.name "PreFlight QA"

cat > package.json <<'JSON'
{
  "name": "preflight-e2e-fixture",
  "private": true,
  "scripts": {
    "test": "echo fixture"
  }
}
JSON

cat > app/safe/page.ts <<'TS'
export function SafePage() {
  return "safe";
}
TS

git add .
git commit -q -m "baseline"

cat > supabase/migrations/001_open_policy.sql <<'SQL'
create policy "open update" on profiles
for update
using (true);
SQL

cat > app/api/webhooks/stripe/route.ts <<'TS'
import Stripe from "stripe";

export async function POST(req: Request) {
  return Response.json({ ok: true });
}
TS

cat > app/safe/card.ts <<'TS'
export const cardTitle = "PreFlight safe fixture";
TS

log "Legacy static scanner on changed files"
set +e
legacy_output="$("$CLI_BIN" scan . --diff --no-color 2>&1)"
legacy_status=$?
set -e
printf '%s\n' "$legacy_output"
if [[ "$legacy_status" -ne 1 ]]; then
  fail "Expected legacy scan . --diff to exit 1 for the RLS bypass fixture"
fi
assert_contains "$legacy_output" "missing-rls" "legacy scan output"

diff_payload="$(git diff -- .)"

log "Tri-State red hard block"
set +e
red_output="$(printf '%s' "$diff_payload" | "$CLI_BIN" scan-diff --stdin 2>&1)"
red_status=$?
set -e
printf '%s\n' "$red_output"
if [[ "$red_status" -ne 1 ]]; then
  fail "Expected red scan-diff to exit 1"
fi
assert_contains "$red_output" "🔴 CONFIRMED FINDING (Hard Block)" "red TUI"
assert_contains "$red_output" "[Deployed Consequence]:" "red deployed consequence"
assert_contains "$red_output" "[Action Required]:" "red action required"

log "Tri-State yellow high-risk drift"
yellow_payload="$(git diff -- app/api/webhooks/stripe/route.ts)"
set +e
yellow_output="$(printf '%s' "$yellow_payload" | "$CLI_BIN" scan-diff --stdin 2>&1)"
yellow_status=$?
set -e
printf '%s\n' "$yellow_output"
if [[ "$yellow_status" -ne 1 ]]; then
  fail "Expected yellow scan-diff to exit 1"
fi
assert_contains "$yellow_output" "🟡 HIGH-RISK DRIFT (Needs Runtime Check)" "yellow TUI"
assert_contains "$yellow_output" "Replay the same webhook event ID twice locally" "yellow manual QA line"

log "Tri-State green trust receipt"
green_payload="$(git diff -- app/safe/card.ts)"
set +e
green_output="$(printf '%s' "$green_payload" | "$CLI_BIN" scan-diff --stdin 2>&1)"
green_status=$?
set -e
printf '%s\n' "$green_output"
if [[ "$green_status" -ne 0 ]]; then
  fail "Expected green scan-diff to exit 0"
fi
assert_contains "$green_output" "🟢 LIKELY SAFE (Trust Receipt)" "green TUI"

log "Interactive Auto-Heal prompt gate"
PREFLIGHT_CLI_BIN="$CLI_BIN" node - <<'NODE'
const { spawn } = require("node:child_process");
const bin = process.platform === "win32" ? `${process.env.PREFLIGHT_CLI_BIN}.cmd` : process.env.PREFLIGHT_CLI_BIN;
const diff = [
  "diff --git a/app/api/pay/route.ts b/app/api/pay/route.ts",
  "+++ b/app/api/pay/route.ts",
  "+const stripe = \"sk_live_1234567890abcdef\";"
].join("\n");

const child = spawn(bin, ["scan-diff", "--stdin", "--auto-fix"], {
  stdio: ["pipe", "pipe", "pipe"]
});

let output = "";
let sawPrompt = false;
let exitedEarly = false;

child.stdout.on("data", (chunk) => {
  output += chunk.toString();
  if (output.includes("[y/n] Accept and Auto-Heal?")) {
    sawPrompt = true;
  }
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
});
child.on("exit", () => {
  exitedEarly = true;
});

child.stdin.end(diff);

setTimeout(() => {
  child.kill();
  if (!sawPrompt) {
    console.error(output);
    console.error("Auto-Heal prompt did not render.");
    process.exit(1);
  }
  if (exitedEarly) {
    console.error(output);
    console.error("Auto-Heal did not halt for explicit user input.");
    process.exit(1);
  }
  console.log(output);
  console.log("Auto-Heal prompt rendered and halted for explicit input.");
}, 1500);
NODE

log "Phase 5: MCP server initialization dry run"
cd "$ROOT_DIR"
node - <<'NODE'
const { spawn } = require("node:child_process");
const child = spawn(process.platform === "win32" ? "preflight.cmd" : "preflight", ["mcp"], {
  stdio: ["pipe", "pipe", "pipe"]
});

let settled = false;
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

child.on("exit", (code) => {
  if (settled) return;
  settled = true;
  console.error(stderr);
  console.error(`MCP server exited early with code ${code}`);
  process.exit(1);
});

setTimeout(() => {
  if (settled) return;
  settled = true;
  child.kill();
  console.log("MCP server stayed alive for 1500ms without immediate init crash.");
}, 1500);
NODE

log "Repository health check passed"
