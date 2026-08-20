# External React Eval Manifest

External eval cases are public, pinned patch-verification benchmarks on repositories ButtonProbe does not control. ButtonProbe clones each public GitHub repository into a temporary directory, checks out the exact commit, runs only the commands declared below, verifies the supplied patch in an isolated worktree, and writes proof artifacts outside the clone.

## Current suite status

The suite currently contains 1 verified third-party case (`bitovi/trainings-use-toggle`). Self-referential cases pointing at the ButtonProbe repository itself were removed: a benchmark that grades its own fixtures is not evidence.

Building this suite is deliberately hard, and the constraints are documented here so contributors know what qualifies:

- The scanner inspects the landing page of the app under test. The broken control must be visible there.
- The scanner interacts with `button`, `a[href]`, `input[type=button|submit]`, `[role=button]`, and `[onclick]` elements. Custom controls rendered as plain `div`/`span` without button semantics are invisible to it (a known scanner limitation tracked for a future release).
- The app must boot with only the manifest-declared setup/dev commands and must not require a backend, login, or third-party API for the target control's behavior.
- The bug must be observable from a single click: DOM/URL/dialog/console evidence before vs after.
- Setup must fit the per-case eval budget (use `--timeout` for slow installs).

In a survey of ~25 candidate repositories (famous app repos, workshop/exercise repos, and code search for shipped empty `onClick` handlers), almost all real button bugs were either behind auth, deep routes, backend calls, non-button elements, or fixed upstream already. Intentionally broken states in teaching repositories remain the densest honest source of cases. If you know a public React/Vite app that ships a genuinely dead button on its landing page, that is exactly the case this suite wants.

## License policy

New cases should come from repositories with an OSI license (MIT, Apache-2.0, BSD-3-Clause). One exception is documented and grandfathered:

- `bitovi/trainings` publishes no license file. It is retained because the broken state is an intentional exercise with an official solution, and the case is pinned to an immutable commit. `license: "NOASSERTION"` is recorded verbatim in the manifest. This exception does not extend to new cases.

## Contributing a case

1. Find a public GitHub repository with a control that is broken at a specific commit (issue archaeology: a merged fix for a dead control is ideal — pin the parent of the fix commit and adapt the fix as `patchFile`).
2. Verify the control is scanner-visible and broken on the landing page.
3. Add the manifest entry below, the patch under `patches/`, and run:

```bash
buttonprobe eval external --manifest fixtures/external-react/manifest.json --allow-network --case <name> --timeout 600000
```

4. The case must reach `ui-verified` with zero original-checkout pollution and complete artifacts before it is accepted.

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
