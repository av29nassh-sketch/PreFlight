import net from "node:net";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text } from "ink";
import type { DaemonState, DaemonToClientMessage } from "../daemon/protocol";
import { encodeIpcMessage, getPreflightSocketPath, parseIpcLines } from "../daemon/protocol";
import type { ReleaseGateScanResult } from "../release-gate/model";
import { Dashboard, type SelectableFinding } from "./Dashboard";

export interface IpcDashboardProps {
  targetDir?: string;
  socketPath?: string;
}

const EMPTY_RESULT: ReleaseGateScanResult = {
  status: "PASSED",
  targetDir: process.cwd(),
  scannedAt: new Date().toISOString(),
  eye: {
    active: false,
    changedFiles: []
  },
  findings: [],
  fuzzFindings: []
};

function resultFromState(state: DaemonState | null): ReleaseGateScanResult {
  return state?.result || EMPTY_RESULT;
}

export function IpcDashboard({ targetDir = process.cwd(), socketPath = getPreflightSocketPath(targetDir) }: IpcDashboardProps) {
  const socketRef = useRef<net.Socket | null>(null);
  const [state, setState] = useState<DaemonState | null>(null);
  const [connectionState, setConnectionState] = useState<"connecting" | "connected" | "error">("connecting");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    let buffered = "";
    const socket = net.createConnection(socketPath);
    socketRef.current = socket;

    socket.on("connect", () => {
      if (!isMounted) return;
      setConnectionState("connected");
      socket.write(encodeIpcMessage({ type: "hello" }));
    });

    socket.on("data", (chunk) => {
      if (!isMounted) return;

      buffered += chunk.toString("utf8");
      const parsed = parseIpcLines(buffered);
      buffered = parsed.rest;

      for (const line of parsed.lines) {
        if (!isMounted) return;

        const event = JSON.parse(line) as DaemonToClientMessage;
        if (event.type === "state") {
          setState(event.state);
        } else if (event.type === "patch_result") {
          setMessage(event.ok ? event.message : `Patch failed: ${event.message}`);
        } else if (event.type === "hard_block") {
          setMessage(`HARD_BLOCK: ${event.finding.file}`);
        } else if (event.type === "log") {
          setMessage(event.message);
        }
      }
    });

    socket.on("error", (error) => {
      if (!isMounted) return;

      setConnectionState("error");
      setMessage(error instanceof Error ? error.message : String(error));
    });

    socket.on("close", () => {
      if (!isMounted) return;

      setConnectionState((current) => (current === "error" ? "error" : "connecting"));
    });

    return () => {
      isMounted = false;
      socket.removeAllListeners();
      socket.destroy();
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
  }, [socketPath]);

  const result = useMemo(() => resultFromState(state), [state]);

  async function sendPatch(selected: SelectableFinding): Promise<void> {
    const socket = socketRef.current;
    if (!socket || socket.destroyed || connectionState !== "connected") {
      throw new Error("PreFlight daemon is not connected.");
    }

    socket.write(encodeIpcMessage({ type: "patch", target: selected }));
  }

  if (connectionState !== "connected" && !state) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color={connectionState === "error" ? "red" : "yellow"}>
          PreFlight daemon: {connectionState}
        </Text>
        <Text dimColor>Socket: {socketPath}</Text>
        <Text dimColor>Start it with: preflight daemon {targetDir}</Text>
        {message && <Text color={connectionState === "error" ? "red" : "yellow"}>{message}</Text>}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Text dimColor>
          Daemon socket: {socketPath} | tracked files: {state?.trackedFiles ?? 0} | scan: {state?.scanProgress ?? "unknown"}
        </Text>
      </Box>
      {message && (
        <Box paddingX={1}>
          <Text color={message.startsWith("Patch failed") ? "red" : "cyan"}>{message}</Text>
        </Box>
      )}
      <Dashboard result={result} onPatchFinding={sendPatch} />
    </Box>
  );
}
