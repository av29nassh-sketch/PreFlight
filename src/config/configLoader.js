const fs = require("node:fs");
const path = require("node:path");

const PREFLIGHT_JSON_CONFIG_FILE = "preflight.config.json";
const PREFLIGHT_YAML_CONFIG_FILES = ["preflight.config.yml", "preflight.config.yaml"];

const PREFLIGHT_CONFIG_TEMPLATE = `${JSON.stringify({
  ignoreRules: [],
  ignorePaths: [],
  custom_rules: [
    {
      name: "No direct Supabase service role clients in route handlers",
      severity: "block",
      target_files: ["app/api/**/*.ts", "app/api/**/*.tsx"],
      forbidden_pattern: {
        type: "forbidden_import",
        import_path: "@supabase/supabase-js"
      }
    },
    {
      name: "Route handlers require tenant guard wrapper",
      severity: "warn",
      target_files: ["app/api/**/*.ts", "app/api/**/*.tsx"],
      forbidden_pattern: {
        type: "required_wrapper",
        wrapper: "withTenantGuard"
      }
    }
  ]
}, null, 2)}\n`;

function defaultConfig() {
  return {
    ignorePaths: [],
    ignoreRules: [],
    customRules: []
  };
}

function normalizeStringArray(value) {
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
}

function normalizeSeverity(value) {
  if (value === "warn") {
    return "warn";
  }

  if (value === "block") {
    return "block";
  }

  return null;
}

function normalizeForbiddenPattern(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  if (value.type === "forbidden_import" && typeof value.import_path === "string" && value.import_path.trim()) {
    return {
      type: "forbidden_import",
      importPath: value.import_path.trim()
    };
  }

  if (value.type === "forbidden_method_call" && typeof value.method === "string" && value.method.trim()) {
    return {
      type: "forbidden_method_call",
      ...(typeof value.object === "string" && value.object.trim() ? { object: value.object.trim() } : {}),
      method: value.method.trim()
    };
  }

  if (value.type === "required_wrapper" && typeof value.wrapper === "string" && value.wrapper.trim()) {
    return {
      type: "required_wrapper",
      wrapper: value.wrapper.trim()
    };
  }

  return null;
}

function normalizeCustomRule(rule, options = {}) {
  const warn = options.warn || (() => {});
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
    warn("Warning: a custom rule was ignored because it is not an object.");
    return null;
  }

  const name = typeof rule.name === "string" && rule.name.trim() ? rule.name.trim() : null;
  if (!name) {
    warn("Warning: a custom rule was ignored because name is required.");
    return null;
  }

  const severity = normalizeSeverity(rule.severity);
  if (!severity) {
    warn(`Warning: custom rule ${name} was ignored because severity must be block or warn.`);
    return null;
  }

  const targetFiles = normalizeStringArray(rule.target_files);
  if (targetFiles.length === 0) {
    warn(`Warning: custom rule ${name} was ignored because target_files is required.`);
    return null;
  }

  const forbiddenPattern = normalizeForbiddenPattern(rule.forbidden_pattern);
  if (!forbiddenPattern) {
    warn(`Warning: custom rule ${name} was ignored because forbidden_pattern is invalid.`);
    return null;
  }

  return {
    name,
    severity,
    targetFiles,
    forbiddenPattern
  };
}

function normalizePreflightConfig(config = {}, options = {}) {
  const warn = options.warn || (() => {});
  const rawRules = Array.isArray(config.custom_rules) ? config.custom_rules : [];

  return {
    ignorePaths: normalizeStringArray(config.ignorePaths),
    ignoreRules: normalizeStringArray(config.ignoreRules),
    customRules: rawRules
      .map((rule) => normalizeCustomRule(rule, { warn }))
      .filter(Boolean)
  };
}

function parseScalar(value) {
  const trimmed = value.trim();
  if (/^["'].*["']$/.test(trimmed)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInlineStringArray(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return null;
  }

  return trimmed
    .slice(1, -1)
    .split(",")
    .map((item) => parseScalar(item))
    .filter(Boolean);
}

function parseLimitedYaml(raw) {
  const result = {};
  let currentRule = null;
  let inCustomRules = false;
  let inForbiddenPattern = false;

  for (const rawLine of String(raw || "").split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "");
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (/^custom_rules\s*:\s*$/.test(trimmed)) {
      inCustomRules = true;
      result.custom_rules = [];
      continue;
    }

    const topLevel = /^([A-Za-z_][\w]*)\s*:\s*(.*)$/.exec(trimmed);
    if (!inCustomRules && topLevel) {
      result[topLevel[1]] = parseInlineStringArray(topLevel[2]) || parseScalar(topLevel[2]);
      continue;
    }

    if (inCustomRules && trimmed.startsWith("- ")) {
      currentRule = {};
      result.custom_rules.push(currentRule);
      inForbiddenPattern = false;
      const inline = /^-\s+([A-Za-z_][\w]*)\s*:\s*(.*)$/.exec(trimmed);
      if (inline) {
        currentRule[inline[1]] = parseInlineStringArray(inline[2]) || parseScalar(inline[2]);
      }
      continue;
    }

    if (!currentRule) {
      continue;
    }

    const pair = /^([A-Za-z_][\w]*)\s*:\s*(.*)$/.exec(trimmed);
    if (!pair) {
      continue;
    }

    if (pair[1] === "forbidden_pattern") {
      currentRule.forbidden_pattern = {};
      inForbiddenPattern = true;
      continue;
    }

    const target = inForbiddenPattern ? currentRule.forbidden_pattern : currentRule;
    target[pair[1]] = parseInlineStringArray(pair[2]) || parseScalar(pair[2]);
  }

  return result;
}

async function readConfigFile(rootDir) {
  const resolvedRoot = path.resolve(rootDir || process.cwd());
  const jsonPath = path.join(resolvedRoot, PREFLIGHT_JSON_CONFIG_FILE);

  try {
    return {
      configPath: jsonPath,
      parsed: JSON.parse(await fs.promises.readFile(jsonPath, "utf8"))
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  for (const fileName of PREFLIGHT_YAML_CONFIG_FILES) {
    const yamlPath = path.join(resolvedRoot, fileName);
    try {
      return {
        configPath: yamlPath,
        parsed: parseLimitedYaml(await fs.promises.readFile(yamlPath, "utf8"))
      };
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return null;
}

async function loadPreflightConfig(rootDir = process.cwd(), options = {}) {
  const warn = options.warn || (() => {});

  try {
    const loaded = await readConfigFile(rootDir);
    if (!loaded) {
      return defaultConfig();
    }

    return {
      ...normalizePreflightConfig(loaded.parsed, { warn }),
      configPath: loaded.configPath
    };
  } catch (_error) {
    warn("Warning: preflight.config.json contains invalid JSON and was ignored.");
    return defaultConfig();
  }
}

async function writePreflightConfigTemplate(rootDir = process.cwd(), options = {}) {
  const configPath = path.join(path.resolve(rootDir), PREFLIGHT_JSON_CONFIG_FILE);
  const overwrite = options.overwrite === true;

  try {
    await fs.promises.writeFile(configPath, PREFLIGHT_CONFIG_TEMPLATE, {
      encoding: "utf8",
      flag: overwrite ? "w" : "wx",
      mode: 0o600
    });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`PreFlight config already exists: ${configPath}`);
    }
    throw error;
  }

  return configPath;
}

module.exports = {
  loadPreflightConfig,
  normalizePreflightConfig,
  PREFLIGHT_CONFIG_TEMPLATE,
  PREFLIGHT_JSON_CONFIG_FILE,
  PREFLIGHT_YAML_CONFIG_FILES,
  writePreflightConfigTemplate
};
