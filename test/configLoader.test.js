const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const roots = [];

function makeProject(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-config-"));
  roots.push(root);

  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, contents);
  }

  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop(), { recursive: true, force: true });
  }
});

describe("configLoader", () => {
  test("loads and normalizes custom team rules from preflight.config.json", async () => {
    const {
      loadPreflightConfig,
      PREFLIGHT_CONFIG_TEMPLATE
    } = require("../src/config/configLoader");
    const root = makeProject({
      "preflight.config.json": JSON.stringify({
        ignoreRules: ["frontend-secret"],
        custom_rules: [
          {
            name: "No direct Supabase client imports",
            severity: "block",
            target_files: "app/api/**/*.ts",
            forbidden_pattern: {
              type: "forbidden_import",
              import_path: "@supabase/supabase-js"
            }
          }
        ]
      })
    });

    const config = await loadPreflightConfig(root);

    expect(PREFLIGHT_CONFIG_TEMPLATE).toContain("\"custom_rules\"");
    expect(config.ignoreRules).toEqual(["frontend-secret"]);
    expect(config.customRules).toEqual([
      {
        name: "No direct Supabase client imports",
        severity: "block",
        targetFiles: ["app/api/**/*.ts"],
        forbiddenPattern: {
          type: "forbidden_import",
          importPath: "@supabase/supabase-js"
        }
      }
    ]);
  });

  test("ignores invalid custom rules and warns without throwing", async () => {
    const { loadPreflightConfig } = require("../src/config/configLoader");
    const warnings = [];
    const root = makeProject({
      "preflight.config.json": JSON.stringify({
        custom_rules: [
          {
            name: "Missing pattern",
            severity: "block",
            target_files: "app/**/*.ts"
          }
        ]
      })
    });

    const config = await loadPreflightConfig(root, {
      warn: (message) => warnings.push(message)
    });

    expect(config.customRules).toEqual([]);
    expect(warnings).toContain("Warning: custom rule Missing pattern was ignored because forbidden_pattern is invalid.");
  });

  test("loads the supported schema from preflight.config.yml", async () => {
    const { loadPreflightConfig } = require("../src/config/configLoader");
    const root = makeProject({
      "preflight.config.yml": [
        "ignoreRules: [frontend-secret]",
        "custom_rules:",
        "  - name: No direct tenant delete",
        "    severity: warn",
        "    target_files: [app/api/**/*.ts]",
        "    forbidden_pattern:",
        "      type: forbidden_method_call",
        "      object: tenantClient",
        "      method: delete",
        ""
      ].join("\n")
    });

    const config = await loadPreflightConfig(root);

    expect(config.ignoreRules).toEqual(["frontend-secret"]);
    expect(config.customRules).toEqual([
      {
        name: "No direct tenant delete",
        severity: "warn",
        targetFiles: ["app/api/**/*.ts"],
        forbiddenPattern: {
          type: "forbidden_method_call",
          object: "tenantClient",
          method: "delete"
        }
      }
    ]);
  });
});
