import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PREFLIGHT_APP_ID = "PreFlight";
const PREFLIGHT_APP_NAME = "PreFlight";
const PREFLIGHT_PROTOCOL = "preflight";

export interface WindowsHardBlockToastOptions {
  filePath: string;
  relativeFile: string;
  issueTypes: string[];
  line?: number;
  iconPath?: string;
  cliPath?: string;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function runHiddenPowerShell(script: string): { ok: boolean; error?: string } {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encodePowerShell(script)],
    {
      encoding: "utf8",
      windowsHide: true
    }
  );

  if (result.status === 0) {
    return { ok: true };
  }

  return {
    ok: false,
    error: result.stderr?.trim() || result.stdout?.trim() || result.error?.message || `PowerShell exited with code ${result.status}`
  };
}

function getCliPath(cliPath?: string): string {
  return cliPath || path.resolve(__dirname, "..", "..", "cli.js");
}

function quoteVbsString(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function getProtocolLauncherPath(): string {
  const baseDir = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || osFallbackHome(), "AppData", "Local");
  return path.join(baseDir, "PreFlight", "preflight-uri-handler.vbs");
}

function osFallbackHome(): string {
  return process.env.HOME || process.cwd();
}

function writeHiddenProtocolLauncher(cliPath: string): string {
  const launcherPath = getProtocolLauncherPath();
  const launcherDir = path.dirname(launcherPath);
  fs.mkdirSync(launcherDir, { recursive: true });

  const script = [
    "Option Explicit",
    "Dim shell, uri, command, nodePath, cliPath",
    "If WScript.Arguments.Count = 0 Then WScript.Quit 0",
    `nodePath = ${quoteVbsString(process.execPath)}`,
    `cliPath = ${quoteVbsString(cliPath)}`,
    "uri = WScript.Arguments(0)",
    "Set shell = CreateObject(\"WScript.Shell\")",
    "command = Chr(34) & nodePath & Chr(34) & \" \" & Chr(34) & cliPath & Chr(34) & \" handle-uri \" & Chr(34) & uri & Chr(34)",
    "shell.Run command, 0, False"
  ].join("\r\n");

  fs.writeFileSync(launcherPath, script, "utf8");
  return launcherPath;
}

export function registerPreFlightProtocolHandler(cliPath?: string): void {
  if (process.platform !== "win32") {
    return;
  }

  const resolvedCliPath = getCliPath(cliPath);
  const launcherPath = writeHiddenProtocolLauncher(resolvedCliPath);
  const command = `"wscript.exe" "${launcherPath}" "%1"`;
  const registryBase = `HKCU\\Software\\Classes\\${PREFLIGHT_PROTOCOL}`;

  const commands: string[][] = [
    ["add", registryBase, "/ve", "/d", "URL:PreFlight Protocol", "/f"],
    ["add", registryBase, "/v", "URL Protocol", "/d", "", "/f"],
    ["add", `${registryBase}\\DefaultIcon`, "/ve", "/d", resolvedCliPath, "/f"],
    ["add", `${registryBase}\\shell\\open\\command`, "/ve", "/d", command, "/f"]
  ];

  for (const args of commands) {
    spawnSync("reg.exe", args, {
      stdio: "ignore",
      windowsHide: true
    });
  }
}

export function registerPreFlightToastApp(cliPath?: string, iconPath?: string): { ok: boolean; error?: string } {
  if (process.platform !== "win32") {
    return { ok: false, error: "Windows toast registration is only supported on Windows." };
  }

  const resolvedCliPath = getCliPath(cliPath);
  const shortcutPath = path.join(
    process.env.APPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Roaming"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    `${PREFLIGHT_APP_NAME}.lnk`
  );
  const resolvedIconPath = iconPath && fs.existsSync(iconPath) ? iconPath : resolvedCliPath;

  const script = `
$shortcutPath = ${quotePowerShell(shortcutPath)}
$targetPath = ${quotePowerShell(process.execPath)}
$arguments = ${quotePowerShell(`"${resolvedCliPath}" daemon`)}
$iconPath = ${quotePowerShell(resolvedIconPath)}
$directory = Split-Path -Parent $shortcutPath
New-Item -ItemType Directory -Force -Path $directory | Out-Null

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $targetPath
$shortcut.Arguments = $arguments
$shortcut.WorkingDirectory = ${quotePowerShell(path.dirname(resolvedCliPath))}
$shortcut.IconLocation = $iconPath
$shortcut.Save()
`;

  return runHiddenPowerShell(script);
}

export function showWindowsHardBlockToast(options: WindowsHardBlockToastOptions): boolean {
  if (process.platform !== "win32") {
    return false;
  }

  registerPreFlightProtocolHandler(options.cliPath);
  const registration = registerPreFlightToastApp(options.cliPath, options.iconPath);
  if (!registration.ok) {
    return false;
  }

  const line = options.line ? `:${options.line}` : "";
  const issueSummary = options.issueTypes.join(", ");
  const body = `Vulnerabilities found in ${options.relativeFile}${line}`;
  const detail = issueSummary || "Hard block detected";
  const copyUri = `${PREFLIGHT_PROTOCOL}://copy-fix?file=${encodeURIComponent(options.filePath)}`;
  const imageAttribute = options.iconPath && fs.existsSync(options.iconPath)
    ? ` placement="appLogoOverride" src="${escapeXml(options.iconPath)}"`
    : "";

  const toastXml = `<toast activationType="protocol" launch="${escapeXml(copyUri)}">
  <visual>
    <binding template="ToastGeneric">
      <text>PreFlight HARD BLOCK</text>
      <text>${escapeXml(body)}</text>
      <text>${escapeXml(detail)}</text>
      ${imageAttribute ? `<image${imageAttribute}/>` : ""}
    </binding>
  </visual>
  <actions>
    <action content="Copy Fix Command" activationType="protocol" arguments="${escapeXml(copyUri)}"/>
  </actions>
</toast>`;

  const script = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml(${quotePowerShell(toastXml)})
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${quotePowerShell(PREFLIGHT_APP_ID)}).Show($toast)
`;

  return runHiddenPowerShell(script).ok;
}
