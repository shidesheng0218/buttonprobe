# Claude Code Recipe

Register ButtonProbe as a local MCP server:

```bash
claude mcp add buttonprobe -- npx buttonprobe mcp
```

Example session:

```text
You: Find the inert save control in my local app.
Claude: Calls buttonprobe_scan with the localhost URL.
You: I made a diff. Prove it before applying it.
Claude: Calls buttonprobe_verify with patchPath, testCommand, and devCommand.
Claude: Reads proof.json only when status is ui-verified.
```

`buttonprobe_verify` makes zero model calls. It returns absolute paths for `proof.json`, `report.html`, and `verified.diff`.

See the [MCP overview](../../README.md#mcp-server) for the tool contract.
