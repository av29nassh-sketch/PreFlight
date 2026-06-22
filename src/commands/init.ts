import childProcess from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pc from "picocolors";
import prompts from "prompts";

type JsonObject = Record<string, unknown>;
type Output = Pick<NodeJS.WritableStream, "write">;

export const PREFLIGHT_MCP_SERVER = {
  command: "preflight",
  args: ["mcp"]
};

type InitTarget =
  | "cursor"
  | "windsurf"
  | "claude-desktop"
  | "claude-code"
  | "vscode"
  | "jetbrains"
  | "terminal";

function getAppDataDir(home = os.homedir()): string {
  return process.env.APPDATA || path.join(home, "AppData", "Roaming");
}

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function backupSuffix(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function firstExistingOrPrimary(candidates: string[]): Promise<string> {
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

export function getCursorConfigCandidates(
  platform: NodeJS.Platform = process.platform,
  home = os.homedir()
): string[] {
  if (platform === "win32") {
    const appData = getAppDataDir(home);
    return [
      path.join(appData, "Cursor", "User", "globalStorage", "saamfi.mcp-client", "mcp.json"),
      path.join(home, ".cursor", "mcp.json")
    ];
  }

  if (platform === "darwin") {
    return [
      path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "saamfi.mcp-client", "mcp.json"),
      path.join(home, ".cursor", "mcp.json")
    ];
  }

  return [
    path.join(home, ".cursor", "mcp.json")
  ];
}

export function getWindsurfConfigPath(
  platform: NodeJS.Platform = process.platform,
  home = os.homedir()
): string {
  return path.join(home, ".codeium", "windsurf", "mcp.json");
}

export function getClaudeDesktopConfigPath(
  platform: NodeJS.Platform = process.platform,
  home = os.homedir()
): string {
  if (platform === "win32") {
    return path.join(getAppDataDir(home), "Claude", "claude_desktop_config.json");
  }

  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }

  return path.join(home, ".config", "Claude", "claude_desktop_config.json");
}

async function readJsonConfig(filePath: string, output: Output): Promise<JsonObject> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw.trim()) {
      return {};
    }

    const parsed = JSON.parse(raw);
    if (isPlainObject(parsed)) {
      return parsed;
    }

    const backupPath = `${filePath}.backup-${backupSuffix()}.bak`;
    await fs.copyFile(filePath, backupPath);
    output.write(`${pc.yellow("Warning:")} ${filePath} did not contain a JSON object. Backed it up to ${backupPath} and created a fresh config.\n`);
    return {};
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return {};
    }

    if (error instanceof SyntaxError) {
      const backupPath = `${filePath}.corrupt-${backupSuffix()}.bak`;
      await fs.copyFile(filePath, backupPath);
      output.write(`${pc.yellow("Warning:")} ${filePath} contained invalid JSON. Backed it up to ${backupPath} and created a fresh config.\n`);
      return {};
    }

    throw error;
  }
}

export async function mergePreflightMcpServer(filePath: string, output: Output = process.stdout): Promise<string> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const config = await readJsonConfig(filePath, output);
  const existingServers = isPlainObject(config.mcpServers) ? config.mcpServers : {};

  config.mcpServers = {
    ...existingServers,
    preflight: PREFLIGHT_MCP_SERVER
  };

  await fs.writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return filePath;
}

function printBox(title: string, lines: string[], output: Output = process.stdout): void {
  const visibleLines = [title, ...lines];
  const width = Math.max(...visibleLines.map((line) => line.length), 32) + 4;
  const border = "-".repeat(width - 2);

  output.write(`${pc.cyan(`+${border}+`)}\n`);
  output.write(`${pc.cyan("|")} ${pc.bold(title.padEnd(width - 4))} ${pc.cyan("|")}\n`);
  output.write(`${pc.cyan(`+${border}+`)}\n`);
  for (const line of lines) {
    output.write(`${pc.cyan("|")} ${line.padEnd(width - 4)} ${pc.cyan("|")}\n`);
  }
  output.write(`${pc.cyan(`+${border}+`)}\n`);
}

async function configureCursor(output: Output): Promise<void> {
  const filePath = await firstExistingOrPrimary(getCursorConfigCandidates());
  await mergePreflightMcpServer(filePath, output);
  output.write(`${pc.green("[OK]")} Cursor MCP configured at ${filePath}\n`);
  output.write(`${pc.bold("Restart Cursor")} to load the PreFlight MCP server.\n`);
}

async function configureWindsurf(output: Output): Promise<void> {
  const filePath = getWindsurfConfigPath();
  await mergePreflightMcpServer(filePath, output);
  output.write(`${pc.green("[OK]")} Windsurf MCP configured at ${filePath}\n`);
  output.write(`${pc.bold("Restart Windsurf")} to load the PreFlight MCP server.\n`);
}

async function configureClaudeDesktop(output: Output): Promise<void> {
  const filePath = getClaudeDesktopConfigPath();
  await mergePreflightMcpServer(filePath, output);
  output.write(`${pc.green("[OK]")} Claude Desktop MCP configured at ${filePath}\n`);
  output.write(`${pc.bold("Restart Claude Desktop")} to load the PreFlight MCP server.\n`);
}

function configureClaudeCode(output: Output): void {
  childProcess.execSync("claude mcp add preflight -- preflight mcp", {
    stdio: "inherit"
  });
  output.write(`${pc.green("[OK]")} Claude Code MCP server registered as ${pc.bold("preflight")}.\n`);
}

function printVsCodeGuide(output: Output): void {
  printBox("VS Code Extensions", [
    "- For GitHub Copilot / Codex: Simply install the PreFlight VS Code Extension (.vsix).",
    "  It automatically registers via VS Code's native Language Model MCP API. No configuration needed!",
    "- For Roo Code / Cline / Devins: Open your AI extension settings inside VS Code, navigate",
    "  to 'MCP Resource/Servers Configuration', and add 'preflight mcp' manually."
  ], output);
}

function printJetBrainsGuide(output: Output): void {
  printBox("JetBrains MCP Setup", [
    "1. Open your JetBrains IDE settings.",
    "2. Install the official 'Model Context Protocol (MCP)' plugin from the Marketplace.",
    "3. Go to Settings > Tools > MCP and click '+' to add a server.",
    "4. Name: preflight | Type: command | Command: preflight mcp"
  ], output);
}

function printTerminalGuide(output: Output): void {
  printBox("Pure Terminal / Custom Scripting", [
    "PreFlight core engine is globally accessible!",
    "Run 'preflight scan .' for standard human reports, or call 'preflight mcp'",
    "to pipe standard JSON RPC 2.0 streaming into your custom local terminal scripts or AI pipelines."
  ], output);
}

export async function runInitWizard(output: Output = process.stdout): Promise<void> {
  const response = await prompts({
    type: "select",
    name: "target",
    message: "Which AI assistant or IDE should PreFlight connect to?",
    choices: [
      { title: "Cursor", value: "cursor" },
      { title: "Windsurf (Codeium)", value: "windsurf" },
      { title: "Claude Desktop App", value: "claude-desktop" },
      { title: "Claude Code (Terminal Only CLI)", value: "claude-code" },
      { title: "VS Code Extensions (GitHub Copilot / Codex / Roo Code / Cline)", value: "vscode" },
      { title: "JetBrains IDEs (WebStorm, IntelliJ, Rider)", value: "jetbrains" },
      { title: "Pure Terminal / Custom Scripting", value: "terminal" }
    ]
  }, {
    onCancel: () => {
      throw new Error("PreFlight init cancelled.");
    }
  }) as { target?: InitTarget };

  switch (response.target) {
    case "cursor":
      await configureCursor(output);
      return;
    case "windsurf":
      await configureWindsurf(output);
      return;
    case "claude-desktop":
      await configureClaudeDesktop(output);
      return;
    case "claude-code":
      configureClaudeCode(output);
      return;
    case "vscode":
      printVsCodeGuide(output);
      return;
    case "jetbrains":
      printJetBrainsGuide(output);
      return;
    case "terminal":
      printTerminalGuide(output);
      return;
    default:
      throw new Error("No PreFlight init target selected.");
  }
}
