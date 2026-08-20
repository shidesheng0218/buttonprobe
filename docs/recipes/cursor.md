# Cursor Recipe

Create `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "buttonprobe": {
      "command": "npx",
      "args": ["buttonprobe", "mcp"]
    }
  }
}
```

Example session:

```text
You: Scan localhost:5173 for dead controls.
Cursor: Calls buttonprobe_scan and shows the candidate controls.
You: Verify my current UI patch using npm test and npm run dev -- --port {port}.
Cursor: Calls buttonprobe_verify, then links the generated proof artifacts.
```

Use the verified diff as the review artifact; do not treat `test-verified` as a confirmed UI repair.

See the [MCP overview](../../README.md#mcp-server) for the tool contract.
