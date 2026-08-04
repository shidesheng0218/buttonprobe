# Reddit Launch Draft

I made a local-first CLI for React apps that finds dead buttons and verifies AI-generated fixes without touching your repo by default.

Workflow:

```text
scan localhost UI -> find inert controls -> locate React source -> ask your model for a diff -> validate patch -> verify in detached Git worktree -> write verified.diff
```

It supports OpenAI-compatible APIs, DeepSeek, and Ollama. The project is intentionally narrow right now: dead buttons and broken click handlers, not broad autonomous code editing.
