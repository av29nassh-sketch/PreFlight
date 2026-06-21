import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getCursorConfigCandidates,
  mergePreflightMcpServer,
  PREFLIGHT_MCP_SERVER
} from "../src/commands/init";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-init-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("preflight init helpers", () => {
  it("merges the preflight MCP server without deleting existing tools", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "mcp.json");
    await fs.writeFile(filePath, JSON.stringify({
      mcpServers: {
        existing: {
          command: "node",
          args: ["server.js"]
        }
      }
    }), "utf8");

    await mergePreflightMcpServer(filePath, { write: () => true });

    const config = JSON.parse(await fs.readFile(filePath, "utf8"));
    expect(config.mcpServers.existing).toEqual({
      command: "node",
      args: ["server.js"]
    });
    expect(config.mcpServers.preflight).toEqual(PREFLIGHT_MCP_SERVER);
  });

  it("backs up corrupt JSON and writes a fresh config", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "mcp.json");
    await fs.writeFile(filePath, "{ definitely not json", "utf8");
    const warnings: string[] = [];

    await mergePreflightMcpServer(filePath, { write: (chunk) => {
      warnings.push(String(chunk));
      return true;
    } });

    const config = JSON.parse(await fs.readFile(filePath, "utf8"));
    const files = await fs.readdir(dir);
    expect(config.mcpServers.preflight).toEqual(PREFLIGHT_MCP_SERVER);
    expect(files.some((file) => file.includes(".corrupt-") && file.endsWith(".bak"))).toBe(true);
    expect(warnings.join("")).toContain("contained invalid JSON");
  });

  it("uses Cursor's primary global storage path before the fallback path", () => {
    const home = path.join("C:", "Users", "Avii");
    const candidates = getCursorConfigCandidates("win32", home);
    expect(candidates[0]).toContain(path.join("Cursor", "User", "globalStorage", "saamfi.mcp-client", "mcp.json"));
    expect(candidates[1]).toBe(path.join(home, ".cursor", "mcp.json"));
  });
});
