# ButtonProbe Roadmap

ButtonProbe is currently an alpha CLI: it can scan local UI controls, optionally ask a bring-your-own model to analyze them, run a bounded repair loop, and verify candidate patches in an isolated Git worktree. The immediate target is a GitHub launch surface for React developers before broad framework expansion.

## Launch Positioning

The public hook is intentionally narrow:

> Find dead buttons. Get verified patches. Keep your repo untouched.

ButtonProbe should be easy to understand in one GIF: a local React button does nothing, ButtonProbe finds it, the user's own model returns a diff, the CLI verifies the diff in a detached worktree, and the current checkout stays unchanged.

Short-term priorities:

1. Keep `fixtures/viral-demo-react` reproducible.
2. Keep `buttonprobe eval viral` and `npm run eval:viral` green.
3. Put the GIF, quickstart, safety model, and benchmark table above deeper docs.
4. Maintain an OpenAI-compatible mock endpoint and Ollama setup path.
5. Improve React/Vite source attribution before adding more frameworks.

Deferred until after the launch surface is stronger: Vue/Svelte production repair, authenticated scanning, deep Next.js support, and commercial packaging. GitHub Actions are now included as a release verification workflow.

## v1 Outcome

Production v1 should make this claim defensible:

> ButtonProbe can identify inert, crashing, ambiguous, and dangerous UI controls with evidence, map them back to source, and verify AI-generated repairs in isolation before the user's repository is touched.

The v1 scope is local-first and zero-backend. Users provide their own model endpoint or local Ollama-compatible service. ButtonProbe does not host accounts, telemetry, reports, model proxies, or billing.

## Product Pillars

**Evidence First**

- Playwright captures observable behavior: local DOM changes, ARIA state changes, visible layer changes, navigation, popups, downloads, network responses, console errors, page errors, screenshots, and traces.
- AI never converts an unsupported guess into a passing verdict.
- Reports preserve deterministic scanner output, AI interpretation, repair attempts, test output, UI verification, and stop reasons.

**Source Precision**

- Instrumented development builds attach stable source metadata to interactive controls.
- Source mapping prefers Vite compiler anchors and includes a deterministic JSX event-chain fallback for React files; raw keyword lookup remains the lowest-confidence fallback.
- Keyword source lookup remains a fallback, never the primary v1 repair path.

**Transactional Repair**

- Automatic repair happens in a temporary Git worktree.
- Failed repair attempts are discarded by removing the temporary worktree.
- Successful repair produces a verified diff. The original repository is modified only with explicit `--apply` and repository state checks.

**Cost And Privacy Control**

- All AI calls use the user's configured OpenAI-compatible endpoint or Ollama.
- The scanner works without AI.
- Model requests are cached by evidence, source, prompt, schema, and model version.
- Auth state, secrets, form values, and sensitive headers are excluded from model prompts and reports.

## Version Milestones

## v0.2: Reliability And Safety

Focus: reduce false positives and eliminate risky current-worktree repair.

- Add evidence scoring with `WORKS`, `INERT`, `CRASHED`, `AMBIGUOUS`, and `SKIPPED` thresholds.
- Use local DOM regions instead of whole-page HTML equality.
- Track network response status and classify failed mutations as errors.
- Add Playwright trace output per issue.
- Add broader dangerous-action classification using visible text, ARIA labels, title, form metadata, HTTP methods, and icon context.
- Move automatic repair to temporary worktrees.
- Default repair delivery to `verified.diff`; require explicit `--apply` to update the original checkout.

Release gate:

- Current 28 tests still pass.
- New transaction tests prove the original checkout is unchanged after failed repair.
- Scanner precision on internal fixtures is at least 90%.

## v0.3: Instrumented Source Mapping

Focus: accurate source-to-control attribution for Vite frameworks.

- Add `@buttonprobe/instrument-vite`.
- Support React TSX/JSX with Babel AST transforms.
- Support Vue SFC with Vue compiler APIs.
- Support Svelte with Svelte compiler/preprocess and MagicString.
- Inject `data-bp-source`, `data-bp-control-id`, and optional component metadata only in development/test builds.
- Remove injected metadata from production builds.
- Add fallback source-map and keyword lookup when instrumentation is unavailable.

Release gate:

- Source mapping accuracy is at least 97% on Vite fixture apps.
- Repair auto-apply is blocked when source confidence is below `0.85`.

## v0.4: Next.js Experimental

Focus: add Next.js without destabilizing Vite support.

- Add `@buttonprobe/instrument-next`.
- Support webpack loader configuration.
- Support Turbopack rules separately.
- Cover app router, pages router, client components, and server/client boundaries.
- Mark Next.js repair support experimental until the fixture matrix is stable.

Release gate:

- Next.js scanning and source mapping pass the fixture suite.
- Known unsupported patterns are documented.

## v0.5: Authenticated Scanning And CI

Focus: support real SaaS flows.

- Support Playwright `storageState`.
- Support a user-provided auth setup command.
- Support start/ready/test/build command orchestration.
- Add GitHub Action templates for scan-only, analyze, and verified-diff workflows.
- Add report artifacts and machine-readable JSON output with `schemaVersion`.

Release gate:

- Auth state is never included in model prompts, reports, or cache files.
- CI examples run against fixture apps.

## v1.0: Public Production Release

Focus: prove reliability with public benchmarks.

- Ship `buttonprobe eval`.
- Include at least 60 fixtures across React, Vue, Svelte, and Next.js.
- Publish benchmark output in the repository.
- Freeze `schemaVersion: 1`.
- Publish migration notes from alpha CLI flags to v1 command groups.

Release gate:

- Scanner precision >= 95%.
- Scanner recall >= 90%.
- Instrumented source mapping accuracy >= 97%.
- Supported-fixture repair success rate >= 75%.
- Original repository pollution rate = 0.
- Five pages and 100 controls scan in under 3 minutes without AI on a typical laptop.
- Re-running unchanged evidence produces no new model calls.

## v1 Non-Goals

- No hosted dashboard.
- No default telemetry.
- No cloud model proxy.
- No billing system.
- No production-site crawling by default.
- No real payment, deletion, permission, or destructive workflow execution.
- No Angular support in v1.
- No automatic database migrations or backend business-logic repair.

## Framework Support Policy

Vite React, Vite Vue, and Svelte/SvelteKit are production targets for v1. Next.js is included in the v1 codebase but may remain experimental until its webpack and Turbopack adapters both meet the same fixture bar.

Adapters must be tested independently. A framework is not considered supported until it passes scan, source-map, repair, build, and report fixtures.
