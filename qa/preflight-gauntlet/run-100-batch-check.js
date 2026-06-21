const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { scanProject } = require("../../index");

const cases = [];

function addCase(name, files, expectedRuleIds = []) {
  cases.push({ name, files, expectedRuleIds });
}

function writeProject(rootDir, files) {
  for (const [relativePath, source] of Object.entries(files)) {
    const filePath = path.join(rootDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source, "utf8");
  }
}

function apiJs(source) {
  return { "api/case.js": source };
}

function apiTs(source) {
  return { "api/case.ts": source };
}

function packageJson(name, dependencies) {
  return {
    "package.json": `${JSON.stringify({
      name,
      version: "1.0.0",
      dependencies
    }, null, 2)}\n`
  };
}

function migration(name, source) {
  return { [`supabase/migrations/${name}.sql`]: source };
}

for (let index = 0; index < 10; index += 1) {
  const verbs = ["SELECT * FROM users WHERE id = ", "DELETE FROM sessions WHERE id = ", "UPDATE accounts SET plan = 'pro' WHERE id = "];
  const requestExpr = index % 2 === 0 ? "req.query.id" : "req.body.accountId";
  addCase(`sql-concat-${index + 1}`, apiJs(`
router.post("/sql-${index}", (req, res) => {
  const userInput = ${requestExpr};
  const query = "${verbs[index % verbs.length]}" + userInput;
  db.query(query, (_error, rows) => res.json(rows));
});
`), ["sql-injection"]);
}

for (let index = 0; index < 10; index += 1) {
  const callee = index % 3 === 0 ? "execSync" : "exec";
  const requestExpr = index % 2 === 0 ? "req.query.ip" : "req.body.host";
  const assignment = index % 4 === 0
    ? `${callee}("ping -c 4 " + ${requestExpr});`
    : `const command = "nslookup " + ${requestExpr};\n  ${callee}(command, (_error, stdout) => res.send(stdout));`;
  addCase(`command-injection-${index + 1}`, apiJs(`
const { exec, execSync } = require("child_process");
router.post("/cmd-${index}", (req, res) => {
  ${assignment}
});
`), ["command-injection"]);
}

for (let index = 0; index < 10; index += 1) {
  const sourceExpr = index % 3 === 0
    ? "body.previewUrl"
    : index % 3 === 1
      ? "request.nextUrl.searchParams.get(\"url\")"
      : "request.headers.get(\"x-target-url\")";
  const weakGuard = index % 2 === 0 ? "if (!/.+/.test(previewUrl)) return Response.json({ error: 'bad' });" : "";
  addCase(`ssrf-${index + 1}`, apiTs(`
export async function POST(request: Request) {
  const body = await request.json();
  const previewUrl = ${sourceExpr};
  ${weakGuard}
  const response = await fetch(previewUrl);
  return Response.json({ text: await response.text() });
}
`), ["ssrf"]);
}

for (let index = 0; index < 10; index += 1) {
  const requestExpr = index % 2 === 0 ? "url.searchParams.get(\"file\")" : "body.fileName";
  const bodyLine = index % 2 === 0 ? "const url = new URL(request.url);" : "const body = await request.json();";
  addCase(`path-traversal-${index + 1}`, apiTs(`
import fs from "node:fs/promises";
import path from "node:path";
export async function GET(request: Request) {
  ${bodyLine}
  const fileName = ${requestExpr};
  const filePath = path.join(process.cwd(), "uploads", fileName || "readme.txt");
  const contents = await fs.readFile(filePath, "utf8");
  return Response.json({ contents });
}
`), ["path-traversal"]);
}

for (let index = 0; index < 10; index += 1) {
  const method = ["updateBillingPlan", "updateProfile", "updateAccount", "deleteAccount", "transferOwnership"][index % 5];
  const idName = ["accountId", "targetUserId", "organizationId", "tenantId", "userId"][index % 5];
  addCase(`auth-bypass-${index + 1}`, apiTs(`
const auth = false;
export async function POST(request: Request) {
  const body = await request.json();
  await db.${method}(body.${idName}, body.value || "premium");
  return Response.json({ ok: true });
}
`), ["auth-bypass"]);
}

for (let index = 0; index < 10; index += 1) {
  addCase(`backend-secret-${index + 1}`, apiTs(`
export async function GET() {
  const serviceRoleKey${index} = "service_role_PREFLIGHT_DUMMY_KEY_12345${index}";
  return Response.json({ ok: Boolean(serviceRoleKey${index}) });
}
`), ["backend-secret"]);
}

const badVersions = ["latest", "*", "18.x", "^4.17.21", "~5.0.0", ">=1.0.0", "1.x", "2.*"];
for (let index = 0; index < 8; index += 1) {
  addCase(`dependency-unpinned-${index + 1}`, packageJson(`bad-deps-${index}`, {
    [`pkg-${index}`]: badVersions[index]
  }), ["dependency-unpinned"]);
}

for (let index = 0; index < 4; index += 1) {
  addCase(`missing-rls-${index + 1}`, migration(`20260621${String(index).padStart(4, "0")}_missing_rls`, `
CREATE TABLE public.audit_${index} (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL
);
`), ["missing-rls"]);
}

for (let index = 0; index < 4; index += 1) {
  addCase(`safe-sql-${index + 1}`, apiJs(`
router.get("/safe-sql-${index}", (req, res) => {
  const allowedTables = new Set(["users", "admins"]);
  const requestedTable = req.query.table;
  const table = allowedTables.has(requestedTable) ? requestedTable : "users";
  const query = \`SELECT id, email FROM \${table} WHERE email = ?\`;
  db.execute(query, [req.query.email], (_error, rows) => res.json(rows));
});
`));
}

for (let index = 0; index < 6; index += 1) {
  addCase(`safe-ssrf-${index + 1}`, apiTs(`
const allowedHosts = new Set(["api.example.com"]);
export async function POST(request: Request) {
  const body = await request.json();
  const parsed = new URL(body.previewUrl);
  if (parsed.protocol !== "https:" || !allowedHosts.has(parsed.hostname)) {
    return Response.json({ error: "blocked" }, { status: 400 });
  }
  const response = await fetch(parsed.toString());
  return Response.json({ text: await response.text() });
}
`));
}

for (let index = 0; index < 3; index += 1) {
  addCase(`safe-command-${index + 1}`, apiJs(`
const { execFile } = require("child_process");
router.post("/safe-cmd-${index}", (req, res) => {
  const ip = req.body.ip;
  if (!/^(?:\\d{1,3}\\.){3}\\d{1,3}$/.test(ip)) return res.status(400).send("bad");
  execFile("ping", ["-c", "4", ip], (_error, stdout) => res.send(stdout));
});
`));
}

for (let index = 0; index < 3; index += 1) {
  addCase(`safe-path-${index + 1}`, apiTs(`
import fs from "node:fs/promises";
import path from "node:path";
const allowedRoot = path.resolve(process.cwd(), "uploads");
export async function GET(request: Request) {
  const url = new URL(request.url);
  const file = url.searchParams.get("file") || "readme.txt";
  const safePath = path.resolve(allowedRoot, file);
  if (!safePath.startsWith(allowedRoot)) return Response.json({ error: "blocked" }, { status: 400 });
  const text = await fs.readFile(safePath, "utf8");
  return Response.json({ text });
}
`));
}

for (let index = 0; index < 4; index += 1) {
  addCase(`safe-auth-${index + 1}`, apiTs(`
export async function POST(request: Request) {
  const user = await requireAuth(request);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = await request.json();
  await db.updateBillingPlan(body.accountId, body.newPlan);
  return Response.json({ ok: true });
}
`));
}

for (let index = 0; index < 4; index += 1) {
  addCase(`safe-rls-${index + 1}`, migration(`20260622${String(index).padStart(4, "0")}_rls_ok`, `
CREATE TABLE public.member_${index} (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL
);

ALTER TABLE public.member_${index} ENABLE ROW LEVEL SECURITY;
`));
}

for (let index = 0; index < 4; index += 1) {
  addCase(`safe-deps-${index + 1}`, packageJson(`safe-deps-${index}`, {
    express: "4.19.2",
    react: "18.2.0"
  }));
}

async function main() {
  if (cases.length !== 100) {
    throw new Error(`Expected exactly 100 cases, got ${cases.length}`);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-100-batch-"));
  const failures = [];

  try {
    for (let index = 0; index < cases.length; index += 1) {
      const testCase = cases[index];
      const projectRoot = path.join(root, `${String(index + 1).padStart(3, "0")}-${testCase.name}`);
      fs.mkdirSync(projectRoot, { recursive: true });
      writeProject(projectRoot, testCase.files);

      const findings = await scanProject(projectRoot);
      const ruleIds = findings.map((finding) => finding.ruleId);

      if (testCase.expectedRuleIds.length === 0 && findings.length > 0) {
        failures.push({
          name: testCase.name,
          reason: "false-positive",
          ruleIds,
          findings: findings.map((finding) => `${finding.ruleId}:${finding.line}:${finding.message}${finding.evidence ? ` | ${finding.evidence}` : ""}`)
        });
        continue;
      }

      for (const expected of testCase.expectedRuleIds) {
        if (!ruleIds.includes(expected)) {
          failures.push({
            name: testCase.name,
            reason: `missing ${expected}`,
            ruleIds,
            findings: findings.map((finding) => `${finding.ruleId}:${finding.line}:${finding.message}${finding.evidence ? ` | ${finding.evidence}` : ""}`)
          });
        }
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`PreFlight 100-batch check failed: ${failures.length} failure(s).`);
    for (const failure of failures.slice(0, 20)) {
      console.error(`- ${failure.name}: ${failure.reason}`);
      console.error(`  rules: ${failure.ruleIds.join(", ") || "(none)"}`);
      for (const finding of failure.findings.slice(0, 4)) {
        console.error(`  finding: ${finding}`);
      }
    }
    process.exitCode = 1;
    return;
  }

  console.log("PreFlight 100-batch check passed.");
  console.log("Vulnerable cases detected and safe cases stayed clean.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
