# Contributing

ButtonProbe is intentionally narrow: local React/Vite UI control scanning, dead-button repair evidence, and independent patch verification.

## Development

```bash
npm ci
npx playwright install chromium
npm test
npm run typecheck
npm run build
```

Before opening a PR, run:

```bash
npm test
npm run typecheck
npm run build
npm run eval:viral
npm run eval:react
npm run test:packed
npm pack --dry-run
```

## Scope

Good contributions improve deterministic evidence: source mapping, scenario contracts, worktree verification, report clarity, fixtures, or provider compatibility.

Please do not add hosted backends, telemetry, dependency-installing repair steps, production-site mutation support, payment flows, deletion flows, or broad framework claims without public eval evidence.
