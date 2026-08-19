# ButtonProbe v0.1.0-alpha.2

> Your AI writes the UI diff. ButtonProbe decides whether it is safe to merge.

## Highlights

### MCP server: agents can now prove their own UI patches

`buttonprobe mcp` starts a Model Context Protocol stdio server with three tools, and every one of them makes **zero model calls**:

- `buttonprobe_scan` — clicks every control in your localhost app and reports dead buttons.
- `buttonprobe_verify` — proves a diff from Claude, Codex, Cursor, or a human in an isolated Git worktree with tests plus real browser evidence. It never applies a patch unless it reaches `ui-verified` with explicit `apply`.
- `buttonprobe_doctor` — readiness checks with actionable fixes.

Claude Code:

```bash
claude mcp add buttonprobe -- npx buttonprobe mcp
```

Cursor (`.cursor/mcp.json`) and Codex (`~/.codex/config.toml`) snippets are in the README.

### Zero-model deterministic repair

Two built-in templates now fix unambiguous dead-button patterns with **0 API calls**, then run through the exact same isolated worktree test + browser UI verification gate as model patches:

- `empty-onclick-setter` — empty `onClick` wired to the component's unique `useState` setter.
- `missing-route-navigation` — empty `onClick` wired to a navigation call from scenario evidence.

Templates only fire with strong identity, a resolved event chain, and scenario evidence. A template that fails verification escalates to your model; without any model configured, `buttonprobe fix` still works when a template matches.

### Evidence in this release

- Viral eval: **5/5 passing**, original repo pollution **0**.
- React eval: **9/10 UI-verified** — two of them with zero model calls; one intentional failure kept.
- Template eval cases run with no model endpoint and are schema-validated to reach `ui-verified` with zero model calls.
- Packed E2E: the zero-cost demo passes from a fresh `npm pack` install.
- `verify --patch` still runs with 0 model calls and never touches your checkout.

## Changes

- Added `buttonprobe mcp` (scan / verify / doctor tools, zero model calls).
- Added deterministic repair templates; patch-only mode uses them too.
- Eval records `repairStrategy`, `patchSource`, and `templateId`.
- Repair attempts carry `patchSource` / `templateId` / `templateFallback`; report timeline labels template rounds.
- Doctor reports the built-in templates.

## Try it

```bash
npx playwright install chromium
npx buttonprobe eval viral
```

Full changelog: [CHANGELOG.md](https://github.com/shidesheng0218/buttonprobe/blob/main/CHANGELOG.md)
