# ButtonProbe v0.1.0-alpha.1

ButtonProbe is now public as a local-first proof layer for UI repair diffs.

## Highlights

- Finds inert or crashing controls in localhost web apps.
- Generates React/Vite dead-button repair diffs with BYOK models.
- Verifies diffs in isolated Git worktrees before touching the current checkout.
- Adds `buttonprobe verify --patch` for Claude/Codex/Cursor/human-generated diffs with 0 model calls.
- Produces `verified.diff`, `proof.json`, screenshots, test logs, and an HTML report.
- Supports GPT/OpenAI-compatible endpoints, DeepSeek, Claude, OpenRouter-compatible APIs, and local Ollama.

## Eval Snapshot

- Viral suite: 5/5 passing
- React repair suite: 9/10 passing
- Original repo pollution rate: 0
- Packed tarball E2E: 5/5 passing

## Scope

Automatic repair is intentionally narrow in this Alpha: React JavaScript/TypeScript, Vite-first local development, and dead-button or broken-click-handler cases. Scanning is broader, but repair claims stay tied to public eval evidence.
