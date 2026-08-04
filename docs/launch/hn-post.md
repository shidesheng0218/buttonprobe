# Hacker News Launch Draft

Show HN: ButtonProbe clicks every button in your React app and asks AI to repair the dead ones safely

ButtonProbe is a local-first CLI for React developers. It scans localhost UI controls with Playwright, finds inert buttons, asks your own OpenAI-compatible model for a unified diff, then verifies that diff in a detached Git worktree before your checkout is touched.

The model does not run commands. It only returns JSON and a diff. The CLI owns validation, tests, browser evidence, and rollback.

Current Alpha v1 focus: dead buttons and broken click handlers in local React apps. BYOK, Ollama-friendly, no backend.
