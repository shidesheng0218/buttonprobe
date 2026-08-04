# ButtonProbe v1 Implementation Plan

This plan turns the production roadmap into implementation-ready work. Each task includes scope, files, tests, and acceptance criteria. Follow TDD for behavior changes: write the failing test first, confirm the failure, then implement.

## Current Baseline

- Package: single TypeScript CLI package.
- Runtime modules: scanner, AI client, source locator, patch validator, repair loop, report writer, workflow, CLI.
- Tests: multiple unit, browser, workflow, fixture-eval, and packed-package suites.
- Current baseline: repairs use isolated worktrees by default, public evals emit permanent evidence artifacts, and React source lookup includes a deterministic JSX event-chain fallback plus Vite anchors.

## Phase 1: Stable Schemas And Config

Goal: make future changes compatible and machine-readable.

Tasks:

1. Add `schemaVersion: 1` to `scan.json`, `repairs.json`, AI assessment objects, and report input.
2. Add `buttonprobe.config.json` loading with CLI override precedence.
3. Split CLI commands into `scan`, `analyze`, `fix`, and `eval`; keep `buttonprobe <url>` as a scan alias.
4. Add validation errors that identify the invalid config field and expected type.

Primary files:

- `src/types.ts`
- `src/cli.ts`
- `src/workflow.ts`
- `src/report.ts`

Tests:

- Config file is loaded from the project root.
- CLI flags override config values.
- Missing AI config fails only for `--ai`, `analyze`, or `fix`.
- Legacy `buttonprobe <url>` still scans.
- JSON outputs include `schemaVersion: 1`.

Acceptance:

- `npm test`, `npm run typecheck`, and `npm run build` pass.
- Existing reports remain readable in the browser.

## Phase 2: Evidence Scoring Engine

Goal: replace binary signal presence with defensible verdict scoring.

Tasks:

1. Introduce `EvidenceSignal` with `scope`, `strength`, `confidence`, `relatedToControl`, and `negative`.
2. Replace whole-page `innerHTML` comparison with local-region diff:
   - target element
   - nearest form
   - `aria-controls` target
   - nearest section/main/article/dialog ancestor
   - newly visible dialogs, menus, alerts, popovers, and toasts
3. Track network response status for XHR/fetch.
4. Add stable observation windows:
   - immediate snapshot after click
   - settled snapshot after 1000 ms
   - reject changes that disappear before the settled snapshot unless they are toasts/dialogs.
5. Implement score thresholds:
   - `CRASHED`: page error, console error related to the interaction, failed navigation, or failed mutation.
   - `WORKS`: score >= `0.8`.
   - `INERT`: score = `0` after the settled window.
   - `AMBIGUOUS`: any score between `0` and `0.8`.
6. Save Playwright trace per actionable issue.

Primary files:

- `src/scanner.ts`
- `src/types.ts`
- `src/report.ts`

Tests:

- Analytics-only fetch does not mark a button as `WORKS`.
- Failed mutation response marks the control as `CRASHED`.
- Timer-driven unrelated DOM update is ignored or marked `AMBIGUOUS`, not `WORKS`.
- `aria-expanded` and controlled-region visibility mark dropdowns as `WORKS`.
- Toast that appears and disappears is captured as `WORKS`.
- Trace files are created for `INERT`, `CRASHED`, and `AMBIGUOUS`.

Acceptance:

- Demo scan still reports one inert control, one crashed control, and one skipped dangerous control.
- False-positive fixture rate is below 10% before moving to Phase 3.

## Phase 3: Transactional Worktree Repair

Goal: automatic repair must never leave the original checkout modified on failure.

Tasks:

1. Add `WorktreeRepairSession`.
2. Create temp worktree with `git worktree add --detach <temp> <HEAD>`.
3. Detect package manager by lockfile and install with frozen mode:
   - `npm ci`
   - `pnpm install --frozen-lockfile`
   - `yarn install --immutable` or `yarn install --frozen-lockfile`
   - `bun install --frozen-lockfile`
4. Run start, ready, test, build, and scan commands inside the worktree.
5. On success, write `verified.diff`, `repair-summary.json`, and verification artifacts.
6. Add `--apply`:
   - verify original HEAD unchanged
   - verify original worktree clean except ignored ButtonProbe output
   - verify target file hashes match the baseline
   - apply `verified.diff` with `git apply --3way`
7. Trap SIGINT/SIGTERM and clean up child processes and temp worktrees.

Primary files:

- `src/git-workspace.ts`
- `src/repair-loop.ts`
- `src/workflow.ts`
- `src/cli.ts`

Tests:

- Failed patch leaves original file content unchanged.
- Failed test leaves original file content unchanged.
- Failed UI verification leaves original file content unchanged.
- SIGINT during test cleans up the worktree.
- Successful fix writes `verified.diff` but does not apply by default.
- `--apply` refuses if original HEAD changed.
- `--apply` refuses if target file hash changed.

Acceptance:

- Original repository pollution rate is zero across repair fixtures.
- Current reverse-patch rollback remains only as an internal worktree fallback, not as the primary safety mechanism.

## Phase 4: Vite Instrumentation Package

Goal: make source mapping accurate for React, Vue, and Svelte in Vite projects.

Tasks:

1. Convert to npm workspaces:
   - `packages/core`
   - `packages/cli`
   - `packages/instrument-vite`
   - `packages/eval`
2. Move current shared runtime into `packages/core`.
3. Add `@buttonprobe/instrument-vite`.
4. React transform:
   - parse JSX/TSX with Babel
   - inject source metadata into interactive elements and custom components with likely interactive props.
5. Vue transform:
   - parse SFC templates with Vue compiler APIs
   - inject metadata into interactive template nodes.
6. Svelte transform:
   - use Svelte compiler/preprocess plus MagicString
   - inject metadata into interactive markup.
7. Add runtime stripping guard so metadata is only emitted for development/test builds.

Primary files:

- workspace package manifests
- `packages/instrument-vite/src/*`
- `packages/core/src/source-locator.ts`

Tests:

- React button receives `data-bp-source`.
- Vue button receives `data-bp-source`.
- Svelte button receives `data-bp-source`.
- Fragments, conditional rendering, slots, and nested components preserve metadata.
- Production build does not include `data-bp-source`.
- Scanner prefers instrumented metadata over keyword source search.

Acceptance:

- Source mapping accuracy >= 97% on Vite fixtures.
- Repair is blocked when source confidence < `0.85`.

## Phase 5: Next.js Experimental Adapter

Goal: support Next.js without weakening Vite quality.

Tasks:

1. Add `@buttonprobe/instrument-next`.
2. Implement webpack loader.
3. Implement Turbopack rules export.
4. Cover app router and pages router fixtures.
5. Document unsupported cases explicitly.

Primary files:

- `packages/instrument-next/src/*`
- Next fixture apps under `fixtures/next-*`

Tests:

- Next app router client component metadata is injected.
- Next pages router metadata is injected.
- Server components are not incorrectly marked as browser controls.
- Turbopack fixture scans with metadata.
- webpack fixture scans with metadata.

Acceptance:

- Next is labeled experimental until it meets the same mapping and repair thresholds as Vite frameworks.

## Phase 6: Authenticated Scanning And Privacy

Goal: support real SaaS screens without leaking credentials or user data.

Tasks:

1. Add config fields:
   - `storageState`
   - `authSetupCommand`
   - `redactSelectors`
   - `sensitiveHeaders`
2. Apply storage state to scan contexts.
3. Run auth setup before scan when configured.
4. Redact form values, passwords, tokens, emails, authorization headers, cookies, and configured selectors from:
   - screenshots when possible
   - DOM summaries
   - network summaries
   - AI prompts
   - reports
   - cache keys and cache values
5. Set generated auth file permissions to `0600`.

Primary files:

- `src/scanner.ts`
- `src/workflow.ts`
- `src/ai-client.ts`
- `src/report.ts`

Tests:

- Storage state can access a protected fixture page.
- Password and token values do not appear in prompt payloads.
- Cookie and authorization headers do not appear in report JSON.
- User-provided redact selectors are masked.
- Auth setup failure stops before model calls.

Acceptance:

- Auth fixtures pass without leaking seeded secrets into report, cache, or test output.

## Phase 7: AI Robustness And Cost Controls

Goal: make model use bounded, resumable, and auditable.

Tasks:

1. Add provider capability detection:
   - supports vision
   - supports usage
   - supports JSON mode or structured output
2. Retry malformed structured output once with validation errors.
3. Validate AI assessment IDs:
   - complete set
   - no duplicates
   - no unknown IDs
4. Isolate page-level AI failures.
5. Add global budgets:
   - max model calls
   - max input characters
   - max repair issues
   - max total runtime
6. Include model, prompt version, schema version, source hash, and evidence hash in cache keys.

Primary files:

- `src/ai-client.ts`
- `src/workflow.ts`
- `src/repair-prompt.ts`

Tests:

- Duplicate AI assessment IDs fail validation.
- Unknown AI assessment ID fails validation.
- One page AI failure does not discard other page results.
- Malformed model JSON retries once.
- Budget exhaustion stops repair with a clear reason.
- Same unchanged evidence does not create a second model request.

Acceptance:

- AI unavailable mode still writes deterministic reports.
- Report includes model calls, cache hits, token usage when available, and stop reason.

## Phase 8: Evaluation Suite

Goal: prove v1 quality publicly.

Tasks:

1. Add `fixtures/` with at least 60 cases:
   - React Vite: 15
   - Vue Vite: 15
   - Svelte/SvelteKit: 15
   - Next.js: 15
2. Add `golden.json` for each fixture:
   - expected controls
   - expected verdicts
   - expected source path
   - repairable or not
   - expected post-repair behavior
3. Add `buttonprobe eval`.
4. Emit `eval-report.json` and `eval-report.md`.
5. Add benchmark badges to README.

Fixture categories:

- Empty click handler.
- Missing route navigation.
- Wrong state update.
- Async mutation success.
- Async mutation failure.
- Toast success.
- Modal open.
- Dropdown expand.
- Crash on click.
- Analytics-only request.
- Timer-driven unrelated DOM update.
- Dangerous text button.
- Dangerous icon-only button.
- Login-required page.
- Low-confidence source mapping.

Primary files:

- `packages/eval/src/*`
- `fixtures/**`
- `README.md`

Tests:

- Eval runner fails when fixture output differs from golden results.
- Eval metrics calculate precision, recall, source accuracy, repair success, and pollution rate.
- Fixture setup and teardown are deterministic.

Acceptance:

- Scanner precision >= 95%.
- Scanner recall >= 90%.
- Source mapping accuracy >= 97%.
- Supported-fixture repair success rate >= 75%.
- Original repository pollution rate = 0.

## Phase 9: CI, Docs, And Launch

Goal: make the project credible and easy to adopt.

Tasks:

1. Add GitHub Actions:
   - unit and typecheck
   - browser e2e
   - fixture eval smoke
   - nightly cross-browser matrix
2. Add docs:
   - configuration reference
   - adapter setup for Vite
   - adapter setup for Next.js
   - auth scanning guide
   - safety model
   - troubleshooting
   - migration from alpha
3. Add README first-screen assets:
   - short demo GIF
   - benchmark badge
   - one-command scan
   - one-command verified repair
4. Add `CONTRIBUTING.md` and issue templates.

Tests:

- Documentation commands are checked where feasible.
- GitHub Action examples reference valid package names and commands.

Acceptance:

- `npm pack --dry-run` includes only intended files.
- Fresh clone quickstart succeeds on a fixture app.

## Release Criteria Checklist

- `npm test` passes.
- `npm run typecheck` passes.
- `npm run build` passes.
- `buttonprobe eval` meets v1 thresholds.
- `npm pack --dry-run` contains no fixtures unless explicitly packaged.
- A verified repair on at least one fixture produces `verified.diff` and leaves the original checkout untouched.
- `--apply` modifies the original checkout only after HEAD and target-file hash checks.
- README documents all safety limits honestly.

## Recommended Execution Order

1. Phase 1.
2. Phase 3.
3. Phase 2.
4. Phase 4.
5. Phase 8 partial fixture runner for Vite.
6. Phase 6.
7. Phase 7.
8. Phase 5.
9. Phase 8 full matrix.
10. Phase 9.

The ordering intentionally moves transactional repair before deeper scanning and adapters, because repository safety is the highest-risk current gap.
