# External React Eval Manifest

External eval cases are public, pinned patch-verification benchmarks. ButtonProbe clones each public GitHub repository into a temporary directory, checks out the exact commit, runs only the commands declared below, verifies the supplied patch in an isolated worktree, and writes proof artifacts outside the clone.

Each case requires:

```json
{
  "name": "owner/repo/save-button",
  "framework": "react",
  "repo": "https://github.com/owner/repo",
  "commit": "full-immutable-git-sha",
  "license": "MIT",
  "expectedSource": "src/ProfileForm.tsx",
  "appDirectory": "optional/path/to/nested-app",
  "patchFile": "patches/save-button.diff",
  "testCommand": "npm test",
  "devCommand": "npm run dev -- --host 127.0.0.1 --port {port}",
  "baseUrl": "http://127.0.0.1:{port}"
}
```

`patchFile` is resolved relative to the manifest. `framework`, `license`, and `expectedSource` make the benchmark auditable: ButtonProbe records source Top-1 accuracy instead of treating a patch pass as evidence of correct source mapping. `NOASSERTION` is allowed only when a public repository contains no license file; it is deliberately visible rather than guessed. `appDirectory`, when present, is a repository-relative directory used for setup, test, and development-server commands; its `node_modules` directory is reused read-only by the isolated worktree. ButtonProbe never follows a branch head, installs an unrequested dependency, or executes a model-provided command. Cases without all required proof inputs are reported as `skipped` and make the eval exit non-zero.

Run one case while developing a benchmark:

```bash
buttonprobe eval external --manifest fixtures/external-react/manifest.json --allow-network --case owner/repo/save-button
```
