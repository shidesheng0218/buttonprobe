# Changelog

## 0.1.0-alpha.2

- Added deterministic zero-model repair templates (`empty-onclick-setter`, `missing-route-navigation`) that run through the same isolated worktree + browser verification gate as model patches and fall back to the model when verification fails.
- `buttonprobe fix` now works with no model configured when a template matches; patch-only mode uses templates too.
- Added `buttonprobe mcp`: a Model Context Protocol stdio server exposing `buttonprobe_scan`, `buttonprobe_verify`, and `buttonprobe_doctor` for Claude Code, Cursor, and Codex. All tools make zero model calls and `verify` never applies a patch unless it reaches `ui-verified` with explicit `apply`.
- Eval records `repairStrategy`, `patchSource`, and `templateId`; template-strategy cases run with no model endpoint and are validated to reach `ui-verified` with zero model calls.
- Repair attempts carry `patchSource`/`templateId`/`templateFallback`; report timeline labels deterministic template rounds.
- Doctor reports the built-in deterministic templates.
- Vitest no longer collects tests shipped inside dependency packages.

## 0.1.0-alpha.1

- Added local control scanning with Playwright evidence.
- Added BYOK OpenAI-compatible, Anthropic Claude, and Ollama-friendly model support.
- Added proof-carrying repair loop with isolated Git worktree verification.
- Added `verified.diff`, report timeline, viral eval, React repair eval, doctor, init, and packed-package smoke tests.
