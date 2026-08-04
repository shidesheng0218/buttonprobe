# X Thread Draft

1. I built ButtonProbe: a CLI that clicks every button in your local React app and asks your own AI model to repair the dead ones safely.
2. It is not an agent swarm. The model only returns JSON + unified diff.
3. ButtonProbe verifies patches in a detached Git worktree, so your checkout stays untouched by default.
4. It supports OpenAI-compatible endpoints, DeepSeek, and local Ollama.
5. Current target: inert buttons, broken click handlers, and regression-protected verified diffs.
6. Viral eval: 5/5 fixtures passing, original repo pollution rate 0.
