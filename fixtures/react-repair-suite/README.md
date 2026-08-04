# React Repair Suite

This directory contains 10 independent case definitions plus a zero-dependency static app, test, and OpenAI-compatible model harness.

Each `cases/<name>/case.json` is copied into its own temporary Git repository. ButtonProbe scans it, requests one repair, applies the diff in an isolated worktree, runs the case test, starts the patched worktree server, performs browser verification, and checks cleanup residue.

```bash
npx buttonprobe eval react
```

The suite contains eight expected UI-verified repairs, one intentional UI-verification failure, and one working regression guard.
