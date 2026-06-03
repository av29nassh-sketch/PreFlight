# PreFlight MCP Integration

Use this guide to connect `mcp-server.js` to Claude Desktop or Cursor while keeping PreFlight local.

## 1. Install PreFlight dependencies

```bash
npm install
```

## 2. Confirm the MCP server path

Use the absolute path to your local server file:

```text
C:\ABSOLUTE\PATH\TO\PreFlight\mcp-server.js
```

## 3. Configure Claude Desktop

Open `claude_desktop_config.json` and add this server entry:

```json
{
  "mcpServers": {
    "preflight": {
      "command": "node",
      "args": ["C:\\ABSOLUTE\\PATH\\TO\\PreFlight\\mcp-server.js"],
      "env": {
        "OPENAI_API_KEY": "YOUR_OPENAI_API_KEY"
      }
    }
  }
}
```

Restart Claude Desktop after saving the file.

## 4. Configure Cursor

In Cursor, open MCP settings and add a new server using the same command, args, and env values:

```json
{
  "command": "node",
  "args": ["C:\\ABSOLUTE\\PATH\\TO\\PreFlight\\mcp-server.js"],
  "env": {
    "OPENAI_API_KEY": "YOUR_OPENAI_API_KEY"
  }
}
```

## 5. Verify locally

Run a scan from your project before relying on the MCP workflow:

```bash
preflight scan .
```

For LLM SQL remediation, pass the OpenAI key through the MCP `env` block above, a local `.env` file, or the CLI flag:

```bash
preflight scan . --fix --openai-key=YOUR_OPENAI_API_KEY
```
