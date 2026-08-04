# ButtonProbe

ButtonProbe verifies whether a UI repair actually works before it touches your repo.

Find dead buttons. Get verified patches. Keep your repo untouched.

![ButtonProbe verified repair demo](docs/buttonprobe-demo.gif)

```bash
BUTTONPROBE_BASE_URL=http://localhost:11434/v1 \
BUTTONPROBE_MODEL=your-local-model \
npx buttonprobe fix http://localhost:5173 \
  --test-command "npm test"
```

5/5 viral cases passing. 10 independent React cases, 8 UI-verified repairs, pollution rate 0.

Last verified: August 4, 2026.

ButtonProbe scans controls in any local web app. Its verified repair loop is production-focused on React JavaScript/TypeScript today: it finds inert or crashing controls, asks your own model for a unified diff, verifies that diff in an isolated Git worktree, and gives you a safe `verified.diff`.

It can also verify a patch from Claude, Codex, Cursor, or a human reviewer without calling any model:

```bash
npx buttonprobe verify http://localhost:5173 \
  --patch agent.diff \
  --test-command "npm test" \
  --dev-command "npm run dev -- --host 127.0.0.1 --port {port}"
```

## 10 Second Quickstart

```bash
npx playwright install chromium
npx buttonprobe eval viral
```

This zero-cost benchmark uses the packaged OpenAI-compatible mock endpoint and static fixture server. It does not need an API key, Vite, React, or a hosted backend.

## Why This Is Safe

- No backend, no hosted model proxy, no telemetry, no database.
- Bring your own OpenAI-compatible endpoint, native Anthropic Claude API, or local Ollama model.
- `verify --patch` does not call a model at all; it is a deterministic proof layer for external diffs.
- The model only returns JSON and unified diffs; it never runs commands.
- Repair defaults to a temporary detached Git worktree and reuses the original checkout's `node_modules` without installing dependencies.
- With `--dev-command`, ButtonProbe starts the patched worktree app and requires browser evidence before marking a repair `ui-verified`.
- Your current checkout is unchanged unless you explicitly pass `--apply`.
- Dirty worktrees automatically degrade to patch-only mode.
- The default `observe` network mode aborts clicked `POST`, `PUT`, `PATCH`, and `DELETE` requests and reports `BLOCKED_MUTATION` instead of treating a live write as proof that a button works.

Original repo pollution rate: 0

## What It Can Fix Today

ButtonProbe is intentionally narrow: verified repair targets local React JavaScript/TypeScript apps with broken click handlers and inert controls. Local scanning is framework-agnostic; Vite source anchors are available for React, Vue, and Svelte, while Next.js and Angular remain experimental.

ButtonProbe does not promise to repair every UI bug. Its public promise is narrower: produce or verify proof-carrying UI repair diffs with tests, browser evidence, screenshots, and a report.

| Fixture | Result |
| --- | --- |
| empty `onClick` | pass |
| wrong state update | pass |
| missing navigation | pass |
| normal button unchanged | pass |
| dirty worktree patch-only | pass |

Run the public benchmarks:

```bash
npx buttonprobe eval viral
npx buttonprobe eval react
```

The React suite runs 10 isolated Git fixtures. Eight repairs reach `ui-verified`, one intentionally fails UI verification, and one working control is preserved. Every case writes its own screenshots, test log, source candidate, diff, failure stage, pollution result, and residue list.

## Vite Source Anchors

Add the local development plugin to a Vite app. It adds a stable `data-bp-id` only while Vite is serving or testing, and writes a local `.buttonprobe/source-manifest.json`. Production builds do not receive ButtonProbe attributes.

```ts
import { defineConfig } from "vite";
import { createButtonProbeVitePlugin } from "buttonprobe/vite";

export default defineConfig({
  plugins: [createButtonProbeVitePlugin()]
});
```

When a scanned control has that ID, ButtonProbe maps it directly to its source file and line, scores it at `100`, and permits worktree verification. Without an anchor, keyword matching remains available but low-confidence locations stay patch-only.

## Business Profiles

Profiles make complex local SaaS screens reproducible without asking the model to invent a workflow. Each profile uses your own Playwright `storageState`, explicit same-origin routes, and one of three network safety modes.

```json
{
  "baseUrl": "http://localhost:5173",
  "profiles": {
    "reviewer": {
      "storageState": ".buttonprobe/auth/reviewer.json",
      "routes": ["/orders", "/orders/42"],
      "networkMode": "replay",
      "replayHar": ".buttonprobe/fixtures/orders.har"
    },
    "sandbox-admin": {
      "storageState": ".buttonprobe/auth/admin.json",
      "routes": ["/users"],
      "networkMode": "sandbox",
      "setupCommand": "node scripts/seed-buttonprobe.mjs",
      "resetCommand": "node scripts/reset-buttonprobe.mjs"
    }
  }
}
```

Run a profile with `npx buttonprobe scan http://localhost:5173 --profile reviewer`.

- `observe` is the default and blocks mutation requests after a click.
- `replay` serves network traffic from your HAR and aborts misses, so no live external API is used.
- `sandbox` permits mutations only when you provide an explicit reset command for a disposable environment.

Auth state, cookies, input values, and model API keys are not included in model prompts, reports, or cache keys. ButtonProbe does not repair backend code, database migrations, payments, deletions, permissions, or production hosts.

## Scenario Contracts

For a high-value control, add an explicit scenario contract. ButtonProbe verifies these deterministic expectations after the candidate patch and rejects the patch when an expectation is missing or a forbidden signal appears.

```json
{
  "scenarios": {
    "save-profile": {
      "route": "/profile",
      "target": "[data-testid='save-profile']",
      "actions": [
        { "type": "click", "selector": "[data-testid='save-profile']" }
      ],
      "expect": [
        { "type": "text", "value": "Saved" },
        { "type": "visible", "selector": "[data-testid='save-toast']" },
        { "type": "urlIncludes", "value": "/profile" }
      ],
      "forbid": [
        { "type": "text", "value": "Error" },
        { "type": "consoleError" },
        { "type": "urlIncludes", "value": "/login" }
      ]
    }
  }
}
```

Contracts are deterministic evidence, not model instructions. Legacy `behaviorContracts` still work and are internally converted to single-click scenarios. Mutation expectations require an explicit `sandbox` profile; the default observer still blocks live writes.

## BYOK And Ollama

OpenAI-compatible endpoints and the native Anthropic Claude API can be used. Claude setup:

```bash
export BUTTONPROBE_PROVIDER=anthropic
export BUTTONPROBE_BASE_URL=https://api.anthropic.com
export ANTHROPIC_API_KEY=your-anthropic-key
export BUTTONPROBE_MODEL=claude-sonnet-5
```

For OpenAI-compatible endpoints:

```bash
export BUTTONPROBE_BASE_URL=https://your-provider.example/v1
export BUTTONPROBE_API_KEY=your-key
export BUTTONPROBE_MODEL=your-model

npx buttonprobe analyze http://localhost:5173
```

Ollama can run locally without hosted API cost:

```bash
export BUTTONPROBE_BASE_URL=http://localhost:11434/v1
export BUTTONPROBE_MODEL=your-local-model

npx buttonprobe fix http://localhost:5173 \
  --test-command "npm test" \
  --dev-command "npm run dev -- --host 127.0.0.1 --port {port}"
```

For a deterministic OpenAI-compatible demo endpoint:

```bash
node fixtures/viral-demo-react/mock-openai-compatible.mjs
```

Provider recipes: [docs/providers.md](docs/providers.md).

## CLI

```bash
npx buttonprobe scan http://localhost:5173
npx buttonprobe analyze http://localhost:5173
npx buttonprobe fix http://localhost:5173 --test-command "npm test"
npx buttonprobe verify http://localhost:5173 --patch agent.diff --test-command "npm test" --dev-command "npm run dev -- --port {port}"
npx buttonprobe scan http://localhost:5173 --profile reviewer
npx buttonprobe eval viral
npx buttonprobe eval react
npx buttonprobe doctor http://localhost:5173 --test-command "npm test"
npx buttonprobe init --url http://localhost:5173 --test-command "npm test"
```

Legacy scan mode is still supported:

```bash
npx buttonprobe http://localhost:5173
```

Use `--no-images` to send only structured interaction evidence. API keys are read from environment variables and are never written to reports.

## Output

```text
.buttonprobe/
  report.html
  scan.json
  repairs.json
  eval/viral/eval-results.json
  cache/
  patches/
  repairs/
  screenshots/
  source-manifest.json
  verification/
```

The report includes deterministic verdicts, AI assessments, repair diffs, test output, UI verification, regressions, and loop stop reasons.

## Launch Story

Launch title:

> I built a CLI that clicks every button in your React app and asks AI to repair the dead ones safely

Positioning:

- Not an agent swarm.
- It does not silently edit your repo.
- The CLI owns validation, tests, browser evidence, and rollback.
- Local-first, BYOK, Ollama-friendly, zero backend.

## Roadmap

Short-term priority is the GitHub launch surface:

1. viral fixture suite
2. `buttonprobe eval`
3. README, GIF, and benchmark evidence
4. OpenAI-compatible mock and Ollama demo
5. React/Vite source mapping improvements

Current next milestones are public framework fixtures for Vue and Svelte, deterministic profile scenario fixtures, and an experimental Next.js adapter. Automatic repair remains deliberately narrower than scanning until those fixture gates are public.

The production roadmap is tracked in [ROADMAP.md](./ROADMAP.md). The implementation breakdown is in [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).

## Development

```bash
npm install
npx playwright install chromium
npm test
npm run typecheck
npm run build
npm run eval:viral
npm run eval:react
npm run test:packed
npm pack --dry-run
```

## License

MIT
