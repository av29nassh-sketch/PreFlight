import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import * as vscode from 'vscode';
import WebSocket = require('ws');

type PreFlightAlertMessage = {
    type: 'HARD_BLOCK';
    filePath: string;
    line?: number;
    payload?: string;
    message: string;
    issueType: string;
    severity: 'HARD_BLOCK';
    source: 'fuzzer' | 'release-gate';
    detectedAt: string;
};

type PreFlightProxyResponse = {
    code?: string;
    patchedCode?: string;
    replacement?: string;
    sourceCode?: string;
    patch?: string;
    diff?: string;
    content?: Array<{ text?: string }>;
};

const PREFLIGHT_PROXY_ENDPOINT = 'https://preflight-proxy.vercel.app/api/v1/remediation';
const PREFLIGHT_DAEMON_MANIFEST = 'preflight-daemon.json';
const ALERT_POPUP_DEBOUNCE_MS = 250;
const DAEMON_RECONNECT_MS = 750;
const DAEMON_RECONNECT_LIMIT = 20;
const diagnosticsByUri = new Map<string, PreFlightAlertMessage[]>();
const diagnosticObjectsByUri = new Map<string, vscode.Diagnostic[]>();
const pendingAlertPopups = new Map<string, NodeJS.Timeout>();
let managedDaemon: childProcess.ChildProcess | null = null;

function getConfigPath(): string {
    const homeDir = process.env.PREFLIGHT_HOME && process.env.PREFLIGHT_HOME.trim()
        ? process.env.PREFLIGHT_HOME.trim()
        : os.homedir();
    return path.join(homeDir, '.preflight', 'config.json');
}

async function resolveLicenseKey(): Promise<string> {
    const envKey = (process.env.PREFLIGHT_PRO_KEY || process.env.PREFLIGHT_PRO_LICENSE_KEY || '').trim();
    if (envKey) {
        return envKey;
    }

    try {
        const rawConfig = await fs.readFile(getConfigPath(), 'utf8');
        const parsed = JSON.parse(rawConfig) as { licenseKey?: unknown };
        const storedKey = typeof parsed.licenseKey === 'string' ? parsed.licenseKey.trim() : '';
        if (storedKey) {
            return storedKey;
        }
    } catch (error: any) {
        if (error?.code !== 'ENOENT') {
            throw error;
        }
    }

    throw new Error("Auto-Patch requires a Pro license. Run 'preflight auth <your-key>' to activate.");
}

function firstTextBlock(response: PreFlightProxyResponse): string | null {
    const content = Array.isArray(response.content) ? response.content : [];
    const textBlock = content.find((item) => item && typeof item.text === 'string' && item.text.trim());
    return textBlock?.text?.trim() || null;
}

function extractCodeFence(rawText: string): string | null {
    const match = rawText.match(/```(?:[A-Za-z0-9_-]+)?\s*\r?\n([\s\S]*?)```/);
    return match ? match[1].replace(/\s+$/, '\n') : null;
}

function extractRemediationText(rawBody: string): string {
    let parsed: PreFlightProxyResponse | null = null;
    try {
        parsed = JSON.parse(rawBody) as PreFlightProxyResponse;
    } catch {
        parsed = null;
    }

    if (parsed) {
        const directCode = parsed.code || parsed.patchedCode || parsed.replacement || parsed.sourceCode;
        if (typeof directCode === 'string' && directCode.trim()) {
            return directCode;
        }

        const diff = parsed.patch || parsed.diff;
        if (typeof diff === 'string' && diff.trim()) {
            return diff;
        }

        const textBlock = firstTextBlock(parsed);
        if (textBlock) {
            return textBlock;
        }
    }

    return rawBody.trim();
}

function looksLikeUnifiedDiff(text: string): boolean {
    return /(^|\n)(diff --git |--- |\+\+\+ |@@ -\d+)/.test(text);
}

function parseHunkStart(line: string): number | null {
    const match = line.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
    return match ? Number.parseInt(match[1], 10) : null;
}

function applyUnifiedDiff(originalCode: string, diffText: string): string {
    const originalLines = originalCode.split(/\r?\n/);
    const diffLines = diffText.split(/\r?\n/);
    const output: string[] = [];
    let originalIndex = 0;
    let appliedHunk = false;

    for (let index = 0; index < diffLines.length; index += 1) {
        const line = diffLines[index];
        if (!line.startsWith('@@ ')) {
            continue;
        }

        const oldStart = parseHunkStart(line);
        if (!oldStart) {
            throw new Error('Proxy returned an unsupported unified diff hunk.');
        }

        const targetIndex = oldStart - 1;
        while (originalIndex < targetIndex) {
            output.push(originalLines[originalIndex]);
            originalIndex += 1;
        }

        index += 1;
        while (index < diffLines.length && !diffLines[index].startsWith('@@ ')) {
            const hunkLine = diffLines[index];

            if (hunkLine.startsWith('\\ No newline')) {
                index += 1;
                continue;
            }

            if (hunkLine.startsWith('+') && !hunkLine.startsWith('+++')) {
                output.push(hunkLine.slice(1));
            } else if (hunkLine.startsWith('-') && !hunkLine.startsWith('---')) {
                originalIndex += 1;
            } else if (hunkLine.startsWith(' ')) {
                output.push(originalLines[originalIndex] ?? hunkLine.slice(1));
                originalIndex += 1;
            }

            index += 1;
        }

        index -= 1;
        appliedHunk = true;
    }

    if (!appliedHunk) {
        throw new Error('Proxy returned a unified diff without an applicable hunk.');
    }

    while (originalIndex < originalLines.length) {
        output.push(originalLines[originalIndex]);
        originalIndex += 1;
    }

    return output.join('\n');
}

function resolvePatchedCode(originalCode: string, remediationText: string): string {
    if (looksLikeUnifiedDiff(remediationText)) {
        return applyUnifiedDiff(originalCode, remediationText);
    }

    const fencedCode = extractCodeFence(remediationText);
    return fencedCode || remediationText;
}

function getLineText(sourceCode: string, line?: number): string {
    if (!line || line < 1) {
        return '';
    }

    return sourceCode.split(/\r?\n/)[line - 1] || '';
}

function isCommandInjectionContext(alert: PreFlightAlertMessage, sourceCode: string): boolean {
    const issueText = `${alert.issueType} ${alert.message} ${alert.payload || ''}`;
    if (/command[-_\s]?injection|command-execution|child_process|\bexec\b|\bspawn\b/i.test(issueText)) {
        return true;
    }

    const lineText = getLineText(sourceCode, alert.line);
    return /\b(?:exec|execSync|spawn|spawnSync)\s*\(/.test(lineText) || /require\(['"]child_process['"]\)/.test(sourceCode);
}

function normalizeChildProcessImportForExecFile(code: string): string {
    return code.replace(
        /const\s*\{\s*exec\s*\}\s*=\s*require\((['"])child_process\1\);?/,
        "const { execFile } = require('child_process');"
    );
}

function hardenCommandInjectionPatch(originalCode: string, patchedCode: string): string {
    const originallyUsedChildProcess = /require\(['"]child_process['"]\)/.test(originalCode);
    if (!originallyUsedChildProcess) {
        return patchedCode;
    }

    let nextCode = normalizeChildProcessImportForExecFile(patchedCode);

    nextCode = nextCode.replace(
        /\bexec\s*\(\s*(['"])ping(?:\s+-c\s+4)?\s+\1\s*\+\s*([A-Za-z_$][\w$]*)\s*,/g,
        "execFile('ping', ['-c', '4', $2],"
    );

    const commandAssignmentPattern = /const\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])ping(?:\s+-c\s+4)?\s+\2\s*\+\s*([A-Za-z_$][\w$]*)\s*;?/g;
    const commandVariables = new Map<string, string>();
    nextCode = nextCode.replace(commandAssignmentPattern, (_match, commandName: string, _quote: string, inputName: string) => {
        commandVariables.set(commandName, inputName);
        return '';
    });

    for (const [commandName, inputName] of commandVariables) {
        nextCode = nextCode.replace(
            new RegExp(`\\bexec\\s*\\(\\s*${commandName}\\s*,`, 'g'),
            `execFile('ping', ['-c', '4', ${inputName}],`
        );
    }

    return nextCode;
}

async function requestPreFlightRemediation(alert: PreFlightAlertMessage, sourceCode: string): Promise<string> {
    const licenseKey = await resolveLicenseKey();
    const isCommandInjection = isCommandInjectionContext(alert, sourceCode);
    const vulnerabilityType = isCommandInjection ? 'COMMAND_INJECTION' : alert.issueType;
    const breakingPayload = (
        alert.payload ||
        (isCommandInjection ? 'user-controlled input reaches child_process execution' : '') ||
        alert.message ||
        alert.issueType ||
        'PreFlight vulnerability'
    ).trim();
    const response = await fetch(PREFLIGHT_PROXY_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${licenseKey}`,
            'X-PreFlight-Pro-Key': licenseKey
        },
        body: JSON.stringify({
            filePath: alert.filePath,
            sourceCode,
            vulnerabilityType,
            breakingPayload,
            executionTrail: [`${alert.filePath}:${alert.line ?? 1}`, alert.message, getLineText(sourceCode, alert.line)].filter(Boolean)
        })
    });

    const rawBody = await response.text();
    if (!response.ok) {
        throw new Error(rawBody || `PreFlight remediation failed with status ${response.status}.`);
    }

    const patchedCode = resolvePatchedCode(sourceCode, extractRemediationText(rawBody));
    return isCommandInjection ? hardenCommandInjectionPatch(sourceCode, patchedCode) : patchedCode;
}

function getPrimaryAlert(uri: vscode.Uri): PreFlightAlertMessage | undefined {
    return diagnosticsByUri.get(uri.toString())?.[0];
}

function upsertAlert(uri: vscode.Uri, alert: PreFlightAlertMessage): PreFlightAlertMessage[] {
    const uriKey = uri.toString();
    const existingAlerts = diagnosticsByUri.get(uriKey) || [];
    const withoutDuplicate = existingAlerts.filter((candidate) => {
        return !(
            candidate.issueType === alert.issueType &&
            candidate.line === alert.line &&
            candidate.message === alert.message
        );
    });
    const nextAlerts = [alert, ...withoutDuplicate];
    diagnosticsByUri.set(uriKey, nextAlerts);
    return nextAlerts;
}

function upsertDiagnostic(uri: vscode.Uri, diagnostic: vscode.Diagnostic): vscode.Diagnostic[] {
    const uriKey = uri.toString();
    const existingDiagnostics = diagnosticObjectsByUri.get(uriKey) || [];
    const withoutDuplicate = existingDiagnostics.filter((candidate) => {
        return !(
            candidate.source === diagnostic.source &&
            candidate.code === diagnostic.code &&
            candidate.range.isEqual(diagnostic.range) &&
            candidate.message === diagnostic.message
        );
    });
    const nextDiagnostics = [diagnostic, ...withoutDuplicate];
    diagnosticObjectsByUri.set(uriKey, nextDiagnostics);
    return nextDiagnostics;
}

function scheduleConsolidatedPopup(uri: vscode.Uri, lineRange: vscode.Range): void {
    const uriKey = uri.toString();
    const existingTimer = pendingAlertPopups.get(uriKey);
    if (existingTimer) {
        clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
        pendingAlertPopups.delete(uriKey);
        const alerts = diagnosticsByUri.get(uriKey) || [];
        if (alerts.length === 0) {
            return;
        }

        const uniqueTypes = Array.from(new Set(alerts.map((alert) => alert.issueType)));
        const relativeFile = vscode.workspace.asRelativePath(uri);
        const title = alerts.length === 1
            ? `PreFlight HARD BLOCK: ${uniqueTypes[0]} in ${relativeFile}:${alerts[0].line ?? '?'}`
            : `PreFlight HARD BLOCK: ${alerts.length} vulnerabilities in ${relativeFile}`;

        void vscode.window.showErrorMessage(
            title,
            'Open File',
            'Fix with PreFlight AI'
        ).then((choice) => {
            if (choice === 'Open File') {
                void vscode.window.showTextDocument(uri, { selection: lineRange });
            }

            if (choice === 'Fix with PreFlight AI') {
                void vscode.commands.executeCommand('preflight.fixIssue', uri.fsPath);
            }
        });
    }, ALERT_POPUP_DEBOUNCE_MS);

    pendingAlertPopups.set(uriKey, timer);
}

async function replaceDocument(document: vscode.TextDocument, patchedCode: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length)
    );

    edit.replace(document.uri, fullRange, patchedCode);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
        throw new Error('VS Code rejected the PreFlight remediation edit.');
    }

    await document.save();
}

function getWorkspaceRoot(): string | null {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
}

function getDaemonManifestPath(): string | null {
    const workspaceRoot = getWorkspaceRoot();
    return workspaceRoot ? path.join(workspaceRoot, '.vscode', PREFLIGHT_DAEMON_MANIFEST) : null;
}

async function readWorkspaceDaemonUrl(): Promise<string | null> {
    const manifestPath = getDaemonManifestPath();
    if (!manifestPath) {
        return null;
    }

    try {
        const rawManifest = await fs.readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(rawManifest) as { websocketUrl?: unknown; targetDir?: unknown };
        const workspaceRoot = getWorkspaceRoot();
        const targetDir = typeof manifest.targetDir === 'string' ? path.resolve(manifest.targetDir) : null;
        if (workspaceRoot && targetDir && targetDir !== path.resolve(workspaceRoot)) {
            return null;
        }

        return typeof manifest.websocketUrl === 'string' && manifest.websocketUrl.trim()
            ? manifest.websocketUrl.trim()
            : null;
    } catch (error: any) {
        if (error?.code === 'ENOENT') {
            return null;
        }

        console.warn('PreFlight could not read daemon manifest:', error);
        return null;
    }
}

function getPreFlightCommand(): string {
    if (process.env.PREFLIGHT_CLI_COMMAND?.trim()) {
        return process.env.PREFLIGHT_CLI_COMMAND.trim();
    }

    return process.platform === 'win32' ? 'preflight.cmd' : 'preflight';
}

function getDaemonSpawnCommand(workspaceRoot: string): { command: string; args: string[] } {
    const preflightCommand = getPreFlightCommand();

    if (process.platform !== 'win32') {
        return {
            command: preflightCommand,
            args: ['daemon', workspaceRoot]
        };
    }

    return {
        command: 'cmd.exe',
        args: ['/d', '/s', '/c', `"${preflightCommand}" daemon "${workspaceRoot}"`]
    };
}

function startManagedDaemon(): void {
    if (managedDaemon && !managedDaemon.killed) {
        return;
    }

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        void vscode.window.showWarningMessage('PreFlight could not start The Eye because no workspace folder is open.');
        return;
    }

    const spawnCommand = getDaemonSpawnCommand(workspaceRoot);
    managedDaemon = childProcess.spawn(spawnCommand.command, spawnCommand.args, {
        cwd: workspaceRoot,
        env: {
            ...process.env,
            PREFLIGHT_DAEMON_WS_PORT: '0'
        },
        stdio: 'ignore',
        windowsHide: true
    });

    managedDaemon.once('exit', () => {
        managedDaemon = null;
    });

    managedDaemon.once('error', (error: NodeJS.ErrnoException) => {
        managedDaemon = null;
        if (error.code === 'ENOENT') {
            void vscode.window.showErrorMessage(
                'PreFlight CLI not found. Please install it globally via npm install -g preflight-pro or ensure it is in your PATH.'
            );
            return;
        }

        void vscode.window.showErrorMessage(`PreFlight daemon failed to start: ${error.message}`);
    });
}

export function activate(context: vscode.ExtensionContext) {
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('preflight');
    context.subscriptions.push(diagnosticCollection);
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.name = 'PreFlight';
    statusBarItem.tooltip = 'PreFlight detected security issues. Click to fix the current file.';
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    context.subscriptions.push(statusBarItem);

    const updateStatusBar = (preferredUri?: vscode.Uri) => {
        const activeEntries = Array.from(diagnosticsByUri.entries()).filter(([, alerts]) => alerts.length > 0);
        const activeCount = activeEntries.reduce((total, [, alerts]) => total + alerts.length, 0);
        if (activeCount === 0) {
            statusBarItem.hide();
            return;
        }

        const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
        const targetUri =
            preferredUri ||
            (activeEditorUri && diagnosticsByUri.has(activeEditorUri.toString()) ? activeEditorUri : undefined) ||
            vscode.Uri.parse(activeEntries[0][0]);

        statusBarItem.text = activeCount === 1
            ? '$(shield) PreFlight: Fix issue'
            : `$(shield) PreFlight: Fix ${activeCount} issues`;
        statusBarItem.command = {
            command: 'preflight.fixIssue',
            title: 'Fix with PreFlight AI',
            arguments: [targetUri.fsPath]
        };
        statusBarItem.show();
    };

    // 1. The Lightbulb (Strictly filtered to PreFlight)
    vscode.languages.registerCodeActionsProvider(
        { scheme: 'file' },
        {
            provideCodeActions(document, range, context) {
                const uriKey = document.uri.toString();
                const storedDiagnostics = diagnosticObjectsByUri.get(uriKey) || [];
                const preflightDiagnostics = [
                    ...context.diagnostics.filter(d => d.source === 'PreFlight'),
                    ...storedDiagnostics.filter((diagnostic) => diagnostic.range.intersection(range))
                ];
                const fallbackPreflightDiagnostics = preflightDiagnostics.length > 0
                    ? preflightDiagnostics
                    : storedDiagnostics;

                if (fallbackPreflightDiagnostics.length === 0) return [];

                const fixAction = new vscode.CodeAction('\uD83D\uDEA8 Fix vulnerability with PreFlight AI', vscode.CodeActionKind.QuickFix);
                fixAction.command = {
                    command: 'preflight.fixIssue',
                    title: 'Fix with AI',
                    arguments: [document.uri.fsPath, fallbackPreflightDiagnostics[0].range]
                };
                fixAction.diagnostics = fallbackPreflightDiagnostics;
                fixAction.isPreferred = true;
                return [fixAction];
            }
        }
    );

    // 2. The Auto-Fix Command
    vscode.commands.registerCommand('preflight.fixIssue', async (filePath?: string) => {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'PreFlight AI: Remediating vulnerability...',
                cancellable: false
            },
            async () => {
                const uri = filePath ? vscode.Uri.file(filePath) : vscode.window.activeTextEditor?.document.uri;
                if (!uri) {
                    throw new Error('PreFlight could not determine which file to fix.');
                }

                const alert = getPrimaryAlert(uri);
                if (!alert) {
                    throw new Error('No active PreFlight diagnostic found for this file.');
                }

                const document = await vscode.workspace.openTextDocument(uri);
                const sourceCode = document.getText();
                const patchedCode = await requestPreFlightRemediation(alert, sourceCode);
                await replaceDocument(document, patchedCode);
                diagnosticCollection.delete(uri);
                diagnosticsByUri.delete(uri.toString());
                diagnosticObjectsByUri.delete(uri.toString());
            }
        ).then(
            () => vscode.window.showInformationMessage('Vulnerability remediated by PreFlight AI.'),
            (error) => vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error))
        );
    });

    const handleWebSocketMessage = async (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString());
        console.log('PreFlight WebSocket received:', message);

        if (message.type === 'CLEAR' && message.filePath) {
            const uri = vscode.Uri.file(message.filePath);
            diagnosticCollection.delete(uri);
            diagnosticsByUri.delete(uri.toString());
            diagnosticObjectsByUri.delete(uri.toString());
            updateStatusBar();
            const pendingTimer = pendingAlertPopups.get(uri.toString());
            if (pendingTimer) {
                clearTimeout(pendingTimer);
                pendingAlertPopups.delete(uri.toString());
            }
            return;
        }

        if (message.type !== 'HARD_BLOCK') return;

        try {
            const alert = message as PreFlightAlertMessage;
            const uri = vscode.Uri.file(alert.filePath);
            const document = await vscode.workspace.openTextDocument(uri);

            const targetLine = Math.max(0, (alert.line ?? 1) - 1);
            const safeLine = Math.min(targetLine, document.lineCount - 1);
            const lineRange = document.lineAt(safeLine).range;

            const diagnostic = new vscode.Diagnostic(
                lineRange,
                alert.message || 'PreFlight vulnerability detected',
                vscode.DiagnosticSeverity.Error
            );

            diagnostic.source = 'PreFlight';
            diagnostic.code = 'preflight-hard-block';

            upsertAlert(uri, alert);
            diagnosticCollection.set(uri, upsertDiagnostic(uri, diagnostic));
            updateStatusBar(uri);
            scheduleConsolidatedPopup(uri, lineRange);
            console.log('PreFlight squiggle deployed:', uri.fsPath);
        } catch (error) {
            console.error('PreFlight Error:', error);
        }
    };

    // 3. The WebSocket Connection (auto-starts The Eye if the daemon is not running)
    let ws: WebSocket | null = null;
    let reconnectTimer: NodeJS.Timeout | null = null;
    let daemonStartAttempted = false;
    let disposed = false;

    const connectToDaemon = async (attempt = 0): Promise<void> => {
        if (disposed) {
            return;
        }

        const daemonUrl = process.env.PREFLIGHT_DAEMON_URL?.trim() || await readWorkspaceDaemonUrl();
        if (!daemonUrl) {
            if (!daemonStartAttempted) {
                daemonStartAttempted = true;
                startManagedDaemon();
            }

            if (attempt < DAEMON_RECONNECT_LIMIT) {
                reconnectTimer = setTimeout(() => {
                    void connectToDaemon(attempt + 1);
                }, DAEMON_RECONNECT_MS);
            }
            return;
        }

        ws = new WebSocket(daemonUrl);

        ws.on('open', () => {
            console.log('PreFlight daemon connected.');
        });

        ws.on('message', handleWebSocketMessage);

        ws.on('error', () => {
            if (!daemonStartAttempted) {
                daemonStartAttempted = true;
                startManagedDaemon();
            }
        });

        ws.on('close', () => {
            if (disposed || attempt >= DAEMON_RECONNECT_LIMIT) {
                return;
            }

            reconnectTimer = setTimeout(() => {
                void connectToDaemon(attempt + 1);
            }, DAEMON_RECONNECT_MS);
        });
    };

    void connectToDaemon();

    context.subscriptions.push({
        dispose: () => {
            disposed = true;
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
            }
            ws?.close();
            managedDaemon?.kill();
            managedDaemon = null;
        }
    });
}
