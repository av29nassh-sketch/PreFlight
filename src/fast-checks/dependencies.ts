import fs from "node:fs/promises";
import type { FastCheckFinding } from "./types";

type DependencyBlock = Record<string, string>;

const DEPENDENCY_BLOCKS = ["dependencies", "devDependencies"] as const;

function classifyDependencyVersion(version: string): { issue: string; severity: "WARNING" | "HARD_BLOCK" } | null {
  const normalizedVersion = version.trim().toLowerCase();

  if (normalizedVersion === "*" || normalizedVersion === "latest") {
    return {
      issue: `uses '${version}', which is completely unpinned.`,
      severity: "HARD_BLOCK"
    };
  }

  if (/(^|[.\-])x($|[.\-])/.test(normalizedVersion) || normalizedVersion.includes("*")) {
    return {
      issue: `uses wildcard version '${version}'.`,
      severity: "HARD_BLOCK"
    };
  }

  if (/^[\^~><=]/.test(normalizedVersion) || /\s+-\s+/.test(normalizedVersion) || /\|\|/.test(normalizedVersion)) {
    return {
      issue: `uses unpinned range '${version}'.`,
      severity: "WARNING"
    };
  }

  return null;
}

function getDependencyBlock(value: unknown): DependencyBlock {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

export async function scanPackageJson(filePath: string): Promise<FastCheckFinding[]> {
  const rawPackageJson = (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
  const parsedPackageJson = JSON.parse(rawPackageJson) as Record<string, unknown>;
  const findings: FastCheckFinding[] = [];

  for (const blockName of DEPENDENCY_BLOCKS) {
    const dependencies = getDependencyBlock(parsedPackageJson[blockName]);

    for (const [packageName, version] of Object.entries(dependencies)) {
      const classification = classifyDependencyVersion(version);

      if (!classification) {
        continue;
      }

      findings.push({
        file: filePath,
        issue: `${blockName}.${packageName} ${classification.issue}`,
        severity: classification.severity
      });
    }
  }

  return findings;
}
