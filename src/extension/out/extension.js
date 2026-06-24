"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
const fs = __importStar(require("node:fs/promises"));
const fsSync = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const childProcess = __importStar(require("node:child_process"));
const vscode = __importStar(require("vscode"));
const WebSocket = require("ws");
const PREFLIGHT_DAEMON_MANIFEST = 'preflight-daemon.json';
const ALERT_POPUP_DEBOUNCE_MS = 250;
const DAEMON_RECONNECT_MS = 750;
const DAEMON_RECONNECT_LIMIT = 20;
const DAEMON_PORT_PROBE_MS = 750;
const diagnosticsByUri = new Map();
const diagnosticObjectsByUri = new Map();
const pendingAlertPopups = new Map();
const pendingVerificationResolvers = new Map();
const pendingPatchResultResolvers = new Map();
let managedDaemon = null;
function getPrimaryAlert(uri) {
    return diagnosticsByUri.get(uri.toString())?.[0];
}
function upsertAlert(uri, alert) {
    const uriKey = uri.toString();
    const existingAlerts = diagnosticsByUri.get(uriKey) || [];
    const withoutDuplicate = existingAlerts.filter((candidate) => {
        return !(candidate.issueType === alert.issueType &&
            candidate.line === alert.line &&
            candidate.message === alert.message);
    });
    const nextAlerts = [alert, ...withoutDuplicate];
    diagnosticsByUri.set(uriKey, nextAlerts);
    return nextAlerts;
}
function upsertDiagnostic(uri, diagnostic) {
    const uriKey = uri.toString();
    const existingDiagnostics = diagnosticObjectsByUri.get(uriKey) || [];
    const withoutDuplicate = existingDiagnostics.filter((candidate) => {
        return !(candidate.source === diagnostic.source &&
            candidate.code === diagnostic.code &&
            candidate.range.isEqual(diagnostic.range) &&
            candidate.message === diagnostic.message);
    });
    const nextDiagnostics = [diagnostic, ...withoutDuplicate];
    diagnosticObjectsByUri.set(uriKey, nextDiagnostics);
    return nextDiagnostics;
}
function scheduleConsolidatedPopup(uri, lineRange) {
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
        void vscode.window.showErrorMessage(title, 'Open File', 'Fix with PreFlight AI').then((choice) => {
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
function waitForPostFixVerification(uri, timeoutMs = 6000) {
    const uriKey = uri.toString();
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            const resolvers = pendingVerificationResolvers.get(uriKey) || [];
            pendingVerificationResolvers.set(uriKey, resolvers.filter((candidate) => candidate !== onClear));
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
function waitForPatchResult(uri, timeoutMs = 30000) {
    const uriKey = uri.toString();
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            const resolvers = pendingPatchResultResolvers.get(uriKey) || [];
            pendingPatchResultResolvers.set(uriKey, resolvers.filter((candidate) => candidate !== onResult));
            reject(new Error('PreFlight daemon did not return a patch result in time.'));
        }, timeoutMs);
        const onResult = (message) => {
            clearTimeout(timeout);
            resolve(message);
        };
        const resolvers = pendingPatchResultResolvers.get(uriKey) || [];
        resolvers.push(onResult);
        pendingPatchResultResolvers.set(uriKey, resolvers);
    });
}
function resolvePatchResult(message) {
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
function getWorkspaceRoot() {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
}
function getDaemonManifestPath() {
    const workspaceRoot = getWorkspaceRoot();
    return workspaceRoot ? path.join(workspaceRoot, '.vscode', PREFLIGHT_DAEMON_MANIFEST) : null;
}
function isDaemonUrlReachable(daemonUrl, expectedTargetDir) {
    try {
        const parsed = new URL(daemonUrl);
        if (!/^wss?:$/.test(parsed.protocol)) {
            return Promise.resolve(false);
        }
    }
    catch {
        return Promise.resolve(false);
    }
    return new Promise((resolve) => {
        const socket = new WebSocket(daemonUrl);
        const timeout = setTimeout(() => finish(false), DAEMON_PORT_PROBE_MS);
        let settled = false;
        const finish = (reachable) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            socket.removeAllListeners();
            socket.terminate();
            resolve(reachable);
        };
        socket.once('message', (rawMessage) => {
            try {
                const message = JSON.parse(rawMessage.toString());
                const rawTargetDir = message?.targetDir || message?.state?.targetDir;
                const daemonTargetDir = typeof rawTargetDir === 'string'
                    ? path.resolve(rawTargetDir)
                    : null;
                finish(message?.type === 'STATE' && (!expectedTargetDir || daemonTargetDir === path.resolve(expectedTargetDir)));
            }
            catch {
                finish(false);
            }
        });
        socket.once('error', () => finish(false));
        socket.once('close', () => finish(false));
    });
}
async function removeStaleDaemonManifest(manifestPath) {
    try {
        await fs.rm(manifestPath, { force: true });
    }
    catch {
        // Best-effort cleanup. A fresh daemon start will rewrite the manifest.
    }
}
async function readWorkspaceDaemonUrl() {
    const manifestPath = getDaemonManifestPath();
    if (!manifestPath) {
        return null;
    }
    try {
        const rawManifest = await fs.readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(rawManifest);
        const workspaceRoot = getWorkspaceRoot();
        const targetDir = typeof manifest.targetDir === 'string' ? path.resolve(manifest.targetDir) : null;
        if (workspaceRoot && targetDir && targetDir !== path.resolve(workspaceRoot)) {
            return null;
        }
        const daemonUrl = typeof manifest.websocketUrl === 'string' && manifest.websocketUrl.trim()
            ? manifest.websocketUrl.trim()
            : null;
        if (!daemonUrl) {
            return null;
        }
        const isReachable = await isDaemonUrlReachable(daemonUrl, workspaceRoot || undefined);
        if (!isReachable) {
            await removeStaleDaemonManifest(manifestPath);
            return null;
        }
        return daemonUrl;
    }
    catch (error) {
        if (error?.code === 'ENOENT') {
            return null;
        }
        console.warn('PreFlight could not read daemon manifest:', error);
        return null;
    }
}
function getPreFlightCommand() {
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
function getLocalDevelopmentCliPath(extensionPath) {
    const candidate = path.resolve(extensionPath, '..', '..', 'cli.js');
    return fsSync.existsSync(candidate) ? candidate : null;
}
function getDaemonSpawnCommand(workspaceRoot, extensionPath) {
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
function startManagedDaemon(extensionPath) {
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
            void vscode.window.showErrorMessage(`PreFlight daemon exited before startup. Command: ${spawnCommand.description}`);
        }
    });
    managedDaemon.once('error', (error) => {
        managedDaemon = null;
        if (error.code === 'ENOENT') {
            void vscode.window.showErrorMessage('PreFlight CLI not found. Please install it globally via npm install -g preflight-pro or ensure it is in your PATH.');
            return;
        }
        void vscode.window.showErrorMessage(`PreFlight daemon failed to start: ${error.message}`);
    });
}
function activate(context) {
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('preflight');
    context.subscriptions.push(diagnosticCollection);
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.name = 'PreFlight';
    statusBarItem.tooltip = 'PreFlight detected security issues. Click to fix the current file.';
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    context.subscriptions.push(statusBarItem);
    const updateStatusBar = (preferredUri) => {
        const activeEntries = Array.from(diagnosticsByUri.entries()).filter(([, alerts]) => alerts.length > 0);
        const activeCount = activeEntries.reduce((total, [, alerts]) => total + alerts.length, 0);
        if (activeCount === 0) {
            statusBarItem.hide();
            return;
        }
        const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
        const targetUri = preferredUri ||
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
    let ws = null;
    let reconnectTimer = null;
    let daemonStartAttempted = false;
    let disposed = false;
    // 1. The Lightbulb (Strictly filtered to PreFlight)
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, {
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
            if (fallbackPreflightDiagnostics.length === 0)
                return [];
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
    });
    // 2. The Auto-Fix Command
    vscode.commands.registerCommand('preflight.fixIssue', async (filePath) => {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'PreFlight AI: Remediating vulnerability...',
            cancellable: false
        }, async () => {
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
        }).then(() => vscode.window.showInformationMessage('Vulnerability remediated by PreFlight AI.'), (error) => vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)));
    });
    const handleWebSocketMessage = async (data) => {
        const message = JSON.parse(data.toString());
        console.log('PreFlight WebSocket received:', message);
        if (message.type === 'PATCH_RESULT') {
            resolvePatchResult(message);
            return;
        }
        if (message.type === 'CLEAR' && message.filePath) {
            const uri = vscode.Uri.file(message.filePath);
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
            return;
        }
        if (message.type !== 'HARD_BLOCK')
            return;
        try {
            const alert = message;
            const uri = vscode.Uri.file(alert.filePath);
            const document = await vscode.workspace.openTextDocument(uri);
            const targetLine = Math.max(0, (alert.line ?? 1) - 1);
            const safeLine = Math.min(targetLine, document.lineCount - 1);
            const lineRange = document.lineAt(safeLine).range;
            const diagnostic = new vscode.Diagnostic(lineRange, alert.message || 'PreFlight vulnerability detected', vscode.DiagnosticSeverity.Error);
            diagnostic.source = 'PreFlight';
            diagnostic.code = 'preflight-hard-block';
            upsertAlert(uri, alert);
            diagnosticCollection.set(uri, upsertDiagnostic(uri, diagnostic));
            updateStatusBar(uri);
            scheduleConsolidatedPopup(uri, lineRange);
            console.log('PreFlight squiggle deployed:', uri.fsPath);
        }
        catch (error) {
            console.error('PreFlight Error:', error);
        }
    };
    // 3. The WebSocket Connection (auto-starts The Eye if the daemon is not running)
    const connectToDaemon = async (attempt = 0) => {
        if (disposed) {
            return;
        }
        const daemonUrl = process.env.PREFLIGHT_DAEMON_URL?.trim() || await readWorkspaceDaemonUrl();
        if (!daemonUrl) {
            if (!daemonStartAttempted) {
                daemonStartAttempted = true;
                startManagedDaemon(context.extensionPath);
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
            ws?.send(JSON.stringify({
                type: 'editor_hello',
                client: 'vscode'
            }));
        });
        ws.on('message', handleWebSocketMessage);
        ws.on('error', () => {
            if (!daemonStartAttempted) {
                daemonStartAttempted = true;
                startManagedDaemon(context.extensionPath);
            }
        });
        ws.on('close', () => {
            if (disposed || attempt >= DAEMON_RECONNECT_LIMIT) {
                return;
            }
            daemonStartAttempted = false;
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
            managedDaemon = null;
        }
    });
}
//# sourceMappingURL=extension.js.map