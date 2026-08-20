# Codex Recipe

Add ButtonProbe to `~/.codex/config.toml`:

```toml
[mcp_servers.buttonprobe]
command = "npx"
args = ["buttonprobe", "mcp"]
```

Example session:

```text
You: Inspect the broken profile button in my local app.
Codex: Calls buttonprobe_scan and uses the returned control id and evidence.
You: Verify the diff in /tmp/profile.diff before changing my checkout.
Codex: Calls buttonprobe_verify with apply=false and reports the proof status.
```

ButtonProbe does not apply a diff unless `apply: true` is explicit and the proof reaches `ui-verified`.

See the [MCP overview](../../README.md#mcp-server) for the tool contract.
