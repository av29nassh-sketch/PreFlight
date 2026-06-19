import path from "node:path";
import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { ReleaseFuzzerFinding } from "../fuzzer/runFuzzer";
import type { ReleaseGateFinding, ReleaseGateScanResult, ReleaseGateStatus } from "../release-gate/model";
import { MISSING_PRO_LICENSE_MESSAGE, remediateFuzzerFinding } from "../remediation/patcher";
import { applyAutoPatch } from "../release-gate/patcher";

type PatchState = "idle" | "patching" | "success" | "error";

interface DisplayFinding {
  finding: ReleaseGateFinding;
  globalIndex: number;
}

interface DisplayFuzzerFinding {
  finding: ReleaseFuzzerFinding;
  globalIndex: number;
}

type SelectableFinding =
  | {
      kind: "fuzzer";
      finding: ReleaseFuzzerFinding;
    }
  | {
      kind: "release-gate";
      finding: ReleaseGateFinding;
    };

export interface DashboardProps {
  result: ReleaseGateScanResult;
  inputEnabled?: boolean;
  onPatchApplied?: () => Promise<void>;
}

function getStatusColor(status: ReleaseGateStatus): "green" | "yellow" | "red" {
  if (status === "PASSED") {
    return "green";
  }

  if (status === "WARNING") {
    return "yellow";
  }

  return "red";
}

function getDisplayStatus(status: ReleaseGateStatus): string {
  return status === "HARD_BLOCK" ? "HARD BLOCK" : status;
}

function getFindingKey(finding: ReleaseGateFinding): string {
  return `${finding.file}:${finding.line ?? ""}:${finding.issue}`;
}

function getFuzzerFindingKey(finding: ReleaseFuzzerFinding): string {
  return `${finding.file}:${finding.type}:${finding.payload}:${finding.issue}`;
}

function buildOrderedFindings(findings: ReleaseGateFinding[]): ReleaseGateFinding[] {
  return [
    ...findings.filter((finding) => finding.severity === "HARD_BLOCK"),
    ...findings.filter((finding) => finding.severity === "WARNING")
  ];
}

function clampSelectedIndex(index: number, total: number): number {
  if (total <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(index, total - 1));
}

function FuzzerFindingItem({
  finding,
  globalIndex,
  selectedIndex
}: {
  finding: ReleaseFuzzerFinding;
  globalIndex: number;
  selectedIndex: number;
}) {
  const isSelected = globalIndex === selectedIndex;
  const trailPreview = finding.trail.slice(0, 3);

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text>
        <Text color={isSelected ? "green" : "red"}>{isSelected ? "> " : "- "}</Text>
        <Text bold color={isSelected ? "green" : "red"}>
          {finding.type}
        </Text>
        <Text dimColor> in </Text>
        <Text bold color={isSelected ? "green" : undefined}>
          {finding.file}
        </Text>
      </Text>
      <Text color="red">[PAYLOAD]: {finding.payload}</Text>
      {trailPreview.map((trailItem, index) => (
        <Text key={`${finding.file}-${globalIndex}-trail-${index}`} dimColor={!isSelected} color={isSelected ? "green" : undefined}>
          {index === 0 ? "trail: " : "       "}
          {trailItem}
        </Text>
      ))}
    </Box>
  );
}

function FuzzerFindingGroup({
  findings,
  selectedIndex
}: {
  findings: DisplayFuzzerFinding[];
  selectedIndex: number;
}) {
  if (findings.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="red">
        Micro-Fuzzer Hard Blocks
      </Text>
      {findings.map(({ finding, globalIndex }) => (
        <FuzzerFindingItem
          key={`${finding.file}-${finding.type}-${finding.payload}-${globalIndex}`}
          finding={finding}
          globalIndex={globalIndex}
          selectedIndex={selectedIndex}
        />
      ))}
    </Box>
  );
}

function FindingGroup({
  title,
  findings,
  color,
  selectedIndex
}: {
  title: string;
  findings: DisplayFinding[];
  color: "red" | "yellow";
  selectedIndex: number;
}) {
  if (findings.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color={color}>
        {title}
      </Text>
      {findings.map(({ finding, globalIndex }) => {
        const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
        const isSelected = globalIndex === selectedIndex;

        return (
          <Box key={`${location}-${finding.issue}-${globalIndex}`} flexDirection="column" marginLeft={2}>
            <Text>
              <Text color={isSelected ? "green" : color}>{isSelected ? "> " : "- "}</Text>
              <Text bold color={isSelected ? "green" : undefined}>
                {location}
              </Text>
              <Text dimColor> [{finding.source}]</Text>
            </Text>
            <Text color={isSelected ? "green" : undefined} dimColor={!isSelected}>
              {finding.issue}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

export function Dashboard({ result, inputEnabled = true, onPatchApplied }: DashboardProps) {
  const { exit } = useApp();
  const [patchState, setPatchState] = useState<PatchState>("idle");
  const [patchMessage, setPatchMessage] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [fuzzFindings, setFuzzFindings] = useState<ReleaseFuzzerFinding[]>(result.fuzzFindings ?? []);
  const [hiddenFindingKeys, setHiddenFindingKeys] = useState<Set<string>>(() => new Set());
  const [hiddenFuzzerFindingKeys, setHiddenFuzzerFindingKeys] = useState<Set<string>>(() => new Set());

  const visibleFindings = useMemo(
    () => buildOrderedFindings(result.findings.filter((finding) => !hiddenFindingKeys.has(getFindingKey(finding)))),
    [hiddenFindingKeys, result.findings]
  );
  const visibleFuzzFindings = useMemo(
    () => fuzzFindings.filter((finding) => !hiddenFuzzerFindingKeys.has(getFuzzerFindingKey(finding))),
    [fuzzFindings, hiddenFuzzerFindingKeys]
  );
  const selectableFindings = useMemo<SelectableFinding[]>(
    () => [
      ...visibleFuzzFindings.map((finding) => ({ kind: "fuzzer" as const, finding })),
      ...visibleFindings.map((finding) => ({ kind: "release-gate" as const, finding }))
    ],
    [visibleFindings, visibleFuzzFindings]
  );
  const fuzzerDisplayFindings = useMemo(
    () => visibleFuzzFindings.map((finding, globalIndex) => ({ finding, globalIndex })),
    [visibleFuzzFindings]
  );
  const hardBlocks = useMemo(
    () =>
      visibleFindings
        .map((finding, index) => ({ finding, globalIndex: visibleFuzzFindings.length + index }))
        .filter(({ finding }) => finding.severity === "HARD_BLOCK"),
    [visibleFindings, visibleFuzzFindings.length]
  );
  const warnings = useMemo(
    () =>
      visibleFindings
        .map((finding, index) => ({ finding, globalIndex: visibleFuzzFindings.length + index }))
        .filter(({ finding }) => finding.severity === "WARNING"),
    [visibleFindings, visibleFuzzFindings.length]
  );

  useEffect(() => {
    setFuzzFindings(result.fuzzFindings ?? []);
  }, [result.fuzzFindings]);

  useEffect(() => {
    setSelectedIndex((current) => clampSelectedIndex(current, selectableFindings.length));
  }, [selectableFindings.length]);

  useEffect(() => {
    if (patchState !== "success" && patchState !== "error") {
      return;
    }

    const timer = setTimeout(() => {
      setPatchState("idle");
      setPatchMessage(null);
    }, 2200);
    return () => clearTimeout(timer);
  }, [patchState]);

  async function triggerAutoPatch(): Promise<void> {
    const selected = selectableFindings[selectedIndex];

    if (!selected || patchState !== "idle") {
      return;
    }

    setPatchState("patching");
    setPatchMessage(null);

    try {
      if (selected.kind === "fuzzer") {
        const patched = await remediateFuzzerFinding({
          ...selected.finding,
          file: path.resolve(result.targetDir, selected.finding.file)
        });
        if (!patched) {
          throw new Error("Fuzzer remediation did not apply a patch.");
        }

        setHiddenFuzzerFindingKeys((current) => {
          const next = new Set(current);
          next.add(getFuzzerFindingKey(selected.finding));
          return next;
        });
        if (onPatchApplied) {
          await onPatchApplied();
        }

        setPatchState("success");
        setPatchMessage("Micro-fuzzer remediation applied.");
        return;
      }

      const finding = selected.finding;
      const absoluteFilePath = path.resolve(result.targetDir, finding.file);
      const fileFindings = visibleFindings.filter((item) => item.file === finding.file);
      const fileIssues = fileFindings.map((item) => item.issue);
      const patched = await applyAutoPatch(absoluteFilePath, fileIssues);

      if (patched) {
        setHiddenFindingKeys((current) => {
          const next = new Set(current);
          for (const fileFinding of fileFindings) {
            next.add(getFindingKey(fileFinding));
          }
          return next;
        });
      }

      if (onPatchApplied) {
        await onPatchApplied();
      }

      setPatchState("success");
      setPatchMessage("MCP successfully patched vulnerability!");
    } catch (error) {
      setPatchState("error");
      const message = error instanceof Error ? error.message : String(error);
      setPatchMessage(message.includes("Pro license") ? MISSING_PRO_LICENSE_MESSAGE : message);
    }
  }

  useInput(
    (input, key) => {
      const normalizedInput = input.toLowerCase();

      if (normalizedInput === "q") {
        exit();
        return;
      }

      if (key.upArrow) {
        setSelectedIndex((current) => clampSelectedIndex(current - 1, selectableFindings.length));
        return;
      }

      if (key.downArrow) {
        setSelectedIndex((current) => clampSelectedIndex(current + 1, selectableFindings.length));
        return;
      }

      if (normalizedInput === "p" && patchState === "idle") {
        void triggerAutoPatch();
      }
    },
    { isActive: inputEnabled }
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="round" borderColor={getStatusColor(result.status)} paddingX={2} paddingY={1} flexDirection="column">
        <Text bold>PreFlight Scan Status</Text>
        <Text bold color={getStatusColor(result.status)}>
          {getDisplayStatus(result.status)}
        </Text>
        <Text dimColor>Target: {result.targetDir}</Text>
        <Text dimColor>Last scan: {new Date(result.scannedAt).toLocaleTimeString()}</Text>
      </Box>

      <Box borderStyle="single" borderColor="cyan" marginTop={1} paddingX={2} paddingY={1} flexDirection="column">
        <Text bold>The Eye Status</Text>
        <Text>
          Background daemon:{" "}
          <Text color={result.eye.active ? "green" : "yellow"}>{result.eye.active ? "watching" : "inactive"}</Text>
        </Text>
        <Text dimColor>
          Changed files: {result.eye.changedFiles.length > 0 ? result.eye.changedFiles.join(", ") : "none yet"}
        </Text>
      </Box>

      <Box
        borderStyle="single"
        borderColor={selectableFindings.length > 0 ? "red" : "green"}
        marginTop={1}
        paddingX={2}
        paddingY={1}
        flexDirection="column"
      >
        <Text bold>Security Violations</Text>
        {selectableFindings.length === 0 ? (
          <Text color="green">No local release-gate or fuzzer issues found.</Text>
        ) : (
          <>
            <Text dimColor>Use Up/Down to select a violation, then press P to patch it.</Text>
            <FuzzerFindingGroup findings={fuzzerDisplayFindings} selectedIndex={selectedIndex} />
            <FindingGroup title="Hard Blocks" findings={hardBlocks} color="red" selectedIndex={selectedIndex} />
            <FindingGroup title="Warnings" findings={warnings} color="yellow" selectedIndex={selectedIndex} />
          </>
        )}
      </Box>

      <Box marginTop={1}>
        {patchState === "patching" && <Text color="cyan">Patching...</Text>}
        {patchState === "success" && <Text color="green">{patchMessage}</Text>}
        {patchState === "error" && <Text color="red">Auto-Patch failed: {patchMessage}</Text>}
        {patchState === "idle" && (
          <Text dimColor>
            Footer Actions: {inputEnabled ? "[Up/Down] Select | [Q] Quit | [P] Trigger Auto-Patch via MCP" : "interactive hotkeys unavailable in non-TTY mode"}
          </Text>
        )}
      </Box>
    </Box>
  );
}
