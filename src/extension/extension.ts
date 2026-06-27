import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
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

type PreFlightPatchResultMessage = {
    type: 'PATCH_RESULT';
    ok: boolean;
    filePath?: string;
    message: string;
    detectedAt: string;
};

const PREFLIGHT_DAEMON_MANIFEST = 'preflight-daemon.json';
const ALERT_POPUP_DEBOUNCE_MS = 250;
const DAEMON_RECONNECT_MS = 750;
const DAEMON_RECONNECT_LIMIT = 20;
const DAEMON_PORT_PROBE_MS = 750;
const diagnosticsByUri = new Map<string, PreFlightAlertMessage[]>();
const diagnosticObjectsByUri = new Map<string, vscode.Diagnostic[]>();
const pendingAlertPopups = new Map<string, NodeJS.Timeout>();
const pendingVerificationResolvers = new Map<string, Array<() => void>>();
const pendingPatchResultResolvers = new Map<string, Array<(message: PreFlightPatchResultMessage) => void>>();
let managedDaemon: childProcess.ChildProcess | null = null;
type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'missing-cli';

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

function waitForPostFixVerification(uri: vscode.Uri, timeoutMs = 6000): Promise<void> {
    const uriKey = uri.toString();

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            const resolvers = pendingVerificationResolvers.get(uriKey) || [];
            pendingVerificationResolvers.set(
                uriKey,
                resolvers.filter((candidate) => candidate !== onClear)
            );
            reject(new Error('PreFlight saved the fix, but the daemon has not confirmed the vulnerability is gone yet.'));
        }, timeoutMs);

        const onClear = () => {
            clearTimeout(timeout);
            resolve();
        };

        const resolvers = pendingVerificationResolvers.get(uriKey) || [];
        resolvers.push(onClear);
        pendingVerificationResolvers.set(uriKey, resolvers);
    });
}

function waitForPatchResult(uri: vscode.Uri, timeoutMs = 30_000): Promise<PreFlightPatchResultMessage> {
    const uriKey = uri.toString();

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            const resolvers = pendingPatchResultResolvers.get(uriKey) || [];
            pendingPatchResultResolvers.set(
                uriKey,
                resolvers.filter((candidate) => candidate !== onResult)
            );
            reject(new Error('PreFlight daemon did not return a patch result in time.'));
        }, timeoutMs);

        const onResult = (message: PreFlightPatchResultMessage) => {
            clearTimeout(timeout);
            resolve(message);
        };

        const resolvers = pendingPatchResultResolvers.get(uriKey) || [];
        resolvers.push(onResult);
        pendingPatchResultResolvers.set(uriKey, resolvers);
    });
}

function resolvePatchResult(message: PreFlightPatchResultMessage): void {
    if (!message.filePath) {
        return;
    }

    const uriKey = vscode.Uri.file(message.filePath).toString();
    const resolvers = pendingPatchResultResolvers.get(uriKey) || [];
    pendingPatchResultResolvers.delete(uriKey);
    for (const resolve of resolvers) {
        resolve(message);
    }
}

function getWorkspaceRoot(): string | null {
    const activeDocumentUri = vscode.window.activeTextEditor?.document.uri;
    if (activeDocumentUri) {
        const activeWorkspace = vscode.workspace.getWorkspaceFolder(activeDocumentUri);
        if (activeWorkspace) {
            return activeWorkspace.uri.fsPath;
        }
    }

    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
}

function getDaemonManifestPath(): string | null {
    const workspaceRoot = getWorkspaceRoot();
    return workspaceRoot ? path.join(workspaceRoot, '.vscode', PREFLIGHT_DAEMON_MANIFEST) : null;
}

function normalizeFsPathForCompare(filePath: string): string {
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isDaemonUrlReachable(daemonUrl: string, expectedTargetDir?: string): Promise<boolean> {
    try {
        const parsed = new URL(daemonUrl);
        if (!/^wss?:$/.test(parsed.protocol)) {
            return Promise.resolve(false);
        }
    } catch {
        return Promise.resolve(false);
    }

    return new Promise((resolve) => {
        const socket = new WebSocket(daemonUrl);
        const timeout = setTimeout(() => finish(false), DAEMON_PORT_PROBE_MS);
        let openFallbackTimeout: NodeJS.Timeout | undefined;
        let settled = false;
        const finish = (reachable: boolean) => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timeout);
            if (openFallbackTimeout) {
                clearTimeout(openFallbackTimeout);
            }
            socket.removeAllListeners();
            socket.terminate();
            resolve(reachable);
        };

        socket.once('message', (rawMessage) => {
            try {
                const message = JSON.parse(rawMessage.toString());
                const rawTargetDir = message?.targetDir || message?.state?.targetDir;
                const daemonTargetDir = typeof rawTargetDir === 'string'
                    ? normalizeFsPathForCompare(rawTargetDir)
                    : null;
                finish(message?.type === 'STATE' && (!expectedTargetDir || daemonTargetDir === normalizeFsPathForCompare(expectedTargetDir)));
            } catch {
                finish(false);
            }
        });
        socket.once('open', () => {
            openFallbackTimeout = setTimeout(() => finish(true), Math.max(150, Math.floor(DAEMON_PORT_PROBE_MS / 2)));
            try {
                socket.send(JSON.stringify({
                    type: 'editor_probe',
                    expectedTargetDir
                }));
            } catch {
                // The open fallback still proves the daemon is alive.
            }
        });
        socket.once('error', () => finish(false));
        socket.once('close', () => finish(false));
    });
}

async function removeStaleDaemonManifest(manifestPath: string): Promise<void> {
    try {
        await fs.rm(manifestPath, { force: true });
    } catch {
        // Best-effort cleanup. A fresh daemon start will rewrite the manifest.
    }
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
        const targetDir = typeof manifest.targetDir === 'string' ? normalizeFsPathForCompare(manifest.targetDir) : null;
        if (workspaceRoot && targetDir && targetDir !== normalizeFsPathForCompare(workspaceRoot)) {
            return null;
        }

        const daemonUrl = typeof manifest.websocketUrl === 'string' && manifest.websocketUrl.trim()
            ? manifest.websocketUrl.trim()
            : null;
        if (!daemonUrl) {
            return null;
        }

        return daemonUrl;
    } catch (error: any) {
        if (error?.code === 'ENOENT') {
            return null;
        }

        console.warn('PreFlight could not read daemon manifest:', error);
        return null;
    }
}

type DaemonSpawnCommand = {
    command: string;
    args: string[];
    description: string;
};

function getPreFlightCommand(): string {
    if (process.env.PREFLIGHT_CLI_COMMAND?.trim()) {
        return process.env.PREFLIGHT_CLI_COMMAND.trim();
    }

    if (process.platform === 'win32') {
        const appData = process.env.APPDATA;
        if (appData) {
            const npmShim = path.join(appData, 'npm', 'preflight.cmd');
            if (fsSync.existsSync(npmShim)) {
                return npmShim;
            }
        }

        return 'preflight.cmd';
    }

    return 'preflight';
}

function getLocalDevelopmentCliPath(extensionPath: string): string | null {
    const candidate = path.resolve(extensionPath, '..', '..', 'cli.js');
    return fsSync.existsSync(candidate) ? candidate : null;
}

function getDaemonSpawnCommand(workspaceRoot: string, extensionPath: string): DaemonSpawnCommand {
    const localCliPath = getLocalDevelopmentCliPath(extensionPath);
    if (localCliPath) {
        return {
            command: process.execPath,
            args: [localCliPath, 'daemon', workspaceRoot],
            description: `${process.execPath} ${localCliPath} daemon ${workspaceRoot}`
        };
    }

    const preflightCommand = getPreFlightCommand();

    if (process.platform !== 'win32') {
        return {
            command: preflightCommand,
            args: ['daemon', workspaceRoot],
            description: `${preflightCommand} daemon ${workspaceRoot}`
        };
    }

    return {
        command: 'cmd.exe',
        args: ['/d', '/s', '/c', `"${preflightCommand}" daemon "${workspaceRoot}"`],
        description: `${preflightCommand} daemon ${workspaceRoot}`
    };
}

async function promptInstallCli(): Promise<void> {
    const selection = await vscode.window.showErrorMessage(
        "PreFlight's core engine is missing. Install the CLI to enable AI security scanning.",
        'Install CLI'
    );

    if (selection !== 'Install CLI') {
        return;
    }

    const terminal = vscode.window.createTerminal('PreFlight Setup');
    terminal.show();
    terminal.sendText('npm install -g preflight-pro; preflight start');
}

function startManagedDaemon(extensionPath: string): void {
    if (managedDaemon && !managedDaemon.killed) {
        return;
    }

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        void vscode.window.showWarningMessage('PreFlight could not start The Eye because no workspace folder is open.');
        return;
    }

    const spawnCommand = getDaemonSpawnCommand(workspaceRoot, extensionPath);
    managedDaemon = childProcess.spawn(spawnCommand.command, spawnCommand.args, {
        cwd: workspaceRoot,
        env: {
            ...process.env,
            PREFLIGHT_DAEMON_WS_PORT: '0'
        },
        detached: true,
        stdio: 'ignore',
        windowsHide: true
    });
    managedDaemon.unref();

    managedDaemon.once('exit', (code) => {
        managedDaemon = null;
        if (code && code !== 0) {
            console.warn(`PreFlight managed daemon exited with code ${code}. The extension will keep trying to reconnect.`);
        }
    });

    managedDaemon.once('error', (error: NodeJS.ErrnoException) => {
        managedDaemon = null;
        if (error.code === 'ENOENT') {
            void promptInstallCli();
            return;
        }

        void vscode.window.showErrorMessage(`PreFlight daemon failed to start: ${error.message}`);
    });
}

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('PreFlight');
    context.subscriptions.push(outputChannel);

    const logConnection = (message: string) => {
        outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
    };

    logConnection(`Extension activated. Workspace root: ${getWorkspaceRoot() || '<none>'}`);

    const diagnosticCollection = vscode.languages.createDiagnosticCollection('preflight');
    context.subscriptions.push(diagnosticCollection);

    const connectionStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    connectionStatusBarItem.name = 'PreFlight Connection';
    connectionStatusBarItem.command = 'preflight.showOutput';
    context.subscriptions.push(connectionStatusBarItem);

    context.subscriptions.push(vscode.commands.registerCommand('preflight.showOutput', () => {
        outputChannel.show(true);
    }));

    const updateConnectionStatus = (state: ConnectionState, daemonUrl?: string) => {
        if (state === 'connected') {
            connectionStatusBarItem.text = '$(shield) PreFlight: Watching';
            connectionStatusBarItem.tooltip = `The Eye is connected to this workspace${daemonUrl ? ` (${daemonUrl})` : ''}. Native popup fallback is suppressed while the VS Code Companion is attached.`;
            connectionStatusBarItem.backgroundColor = undefined;
        } else if (state === 'missing-cli') {
            connectionStatusBarItem.text = '$(error) PreFlight: CLI missing';
            connectionStatusBarItem.tooltip = 'Install the PreFlight CLI to enable local scanning.';
            connectionStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        } else if (state === 'reconnecting') {
            connectionStatusBarItem.text = '$(sync~spin) PreFlight: Reconnecting';
            connectionStatusBarItem.tooltip = 'Waiting for the local PreFlight daemon to reconnect.';
            connectionStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
            connectionStatusBarItem.text = '$(sync~spin) PreFlight: Connecting';
            connectionStatusBarItem.tooltip = 'Starting or discovering the local PreFlight daemon for this workspace.';
            connectionStatusBarItem.backgroundColor = undefined;
        }

        connectionStatusBarItem.show();
    };

    updateConnectionStatus('connecting');

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

    let ws: WebSocket | null = null;
    let reconnectTimer: NodeJS.Timeout | null = null;
    let daemonStartAttempted = false;
    let disposed = false;

    const scheduleReconnect = (attempt: number) => {
        if (disposed || reconnectTimer) {
            return;
        }

        const delay = Math.min(DAEMON_RECONNECT_MS * Math.max(1, attempt + 1), 5000);
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            void connectToDaemon(attempt + 1);
        }, delay);
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

                if (!ws || ws.readyState !== WebSocket.OPEN) {
                    throw new Error('PreFlight daemon is not connected yet. Save the file again or reload the window.');
                }

                const alert = getPrimaryAlert(uri);
                if (!alert) {
                    throw new Error('No active PreFlight diagnostic found for this file.');
                }

                const verifiedClear = waitForPostFixVerification(uri);
                const patchResult = waitForPatchResult(uri);
                ws.send(JSON.stringify({
                    type: 'patch_file',
                    filePath: uri.fsPath
                }));

                const result = await patchResult;
                if (!result.ok) {
                    void verifiedClear.catch(() => undefined);
                    throw new Error(result.message);
                }

                await verifiedClear;
            }
        ).then(
            () => vscode.window.showInformationMessage('Vulnerability remediated by PreFlight AI.'),
            (error) => vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error))
        );
    });

    const renderHardBlockAlert = async (alert: PreFlightAlertMessage) => {
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
    };

    const clearFileAlert = (filePath: string) => {
        const uri = vscode.Uri.file(filePath);
        const uriKey = uri.toString();
        const resolvers = pendingVerificationResolvers.get(uriKey) || [];
        pendingVerificationResolvers.delete(uriKey);
        for (const resolve of resolvers) {
            resolve();
        }
        diagnosticCollection.delete(uri);
        diagnosticsByUri.delete(uriKey);
        diagnosticObjectsByUri.delete(uriKey);
        updateStatusBar();
        const pendingTimer = pendingAlertPopups.get(uriKey);
        if (pendingTimer) {
            clearTimeout(pendingTimer);
            pendingAlertPopups.delete(uriKey);
        }
    };

    const handleWebSocketMessage = async (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString());
        console.log('PreFlight WebSocket received:', message);

        if (message.type === 'PATCH_RESULT') {
            resolvePatchResult(message as PreFlightPatchResultMessage);
            return;
        }

        if (message.type === 'STATE') {
            if (message.lastHardBlock) {
                await renderHardBlockAlert(message.lastHardBlock as PreFlightAlertMessage);
            }
            return;
        }

        if (message.type === 'CLEAR' && message.filePath) {
            clearFileAlert(message.filePath);
            return;
        }

        if (message.type !== 'HARD_BLOCK') return;

        try {
            await renderHardBlockAlert(message as PreFlightAlertMessage);
        } catch (error) {
            console.error('PreFlight Error:', error);
        }
    };

    // 3. The WebSocket Connection (auto-starts The Eye if the daemon is not running)
    const connectToDaemon = async (attempt = 0): Promise<void> => {
        if (disposed) {
            return;
        }

        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
            return;
        }

        const workspaceDaemonUrl = await readWorkspaceDaemonUrl();
        const envDaemonUrl = process.env.PREFLIGHT_DAEMON_URL?.trim();
        const daemonUrl = workspaceDaemonUrl || (envDaemonUrl && await isDaemonUrlReachable(envDaemonUrl, getWorkspaceRoot() || undefined) ? envDaemonUrl : null);
        logConnection(`Connect attempt ${attempt}. workspaceDaemonUrl=${workspaceDaemonUrl || '<none>'} envDaemonUrl=${envDaemonUrl ? '<set>' : '<none>'} selected=${daemonUrl || '<none>'}`);
        if (!daemonUrl) {
            updateConnectionStatus(attempt === 0 ? 'connecting' : 'reconnecting');
            if (!daemonStartAttempted) {
                daemonStartAttempted = true;
                logConnection('No reachable daemon manifest found. Starting managed daemon.');
                startManagedDaemon(context.extensionPath);
            }

            scheduleReconnect(attempt);
            return;
        }

        updateConnectionStatus('connecting');
        const socket = new WebSocket(daemonUrl);
        ws = socket;

        socket.on('open', () => {
            if (ws !== socket) {
                return;
            }

            console.log('PreFlight daemon connected.');
            logConnection(`WebSocket open: ${daemonUrl}`);
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            updateConnectionStatus('connected', daemonUrl);
            daemonStartAttempted = false;
            ws?.send(JSON.stringify({
                type: 'editor_hello',
                client: 'vscode'
            }));
        });

        socket.on('message', handleWebSocketMessage);

        socket.on('error', (error) => {
            if (ws !== socket) {
                return;
            }

            logConnection(`WebSocket error: ${error instanceof Error ? error.message : String(error)}`);
            updateConnectionStatus('reconnecting');
            if (!daemonStartAttempted) {
                daemonStartAttempted = true;
                logConnection('WebSocket errored. Starting managed daemon fallback.');
                startManagedDaemon(context.extensionPath);
            }

            ws = null;
            scheduleReconnect(attempt);
        });

        socket.on('close', (code, reason) => {
            if (ws !== socket) {
                return;
            }

            logConnection(`WebSocket close: code=${code} reason=${reason?.toString() || '<none>'}`);
            if (disposed) {
                return;
            }

            updateConnectionStatus('reconnecting');
            ws = null;
            daemonStartAttempted = false;
            scheduleReconnect(attempt);
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
            managedDaemon = null;
        }
    });
}
