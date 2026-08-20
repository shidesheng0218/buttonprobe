# GitHub Action Marketplace Checklist

Use this checklist after a version tag is pushed.

1. Confirm `action.yml` is at the repository root and includes `name`, `description`, `runs`, and `branding`.
2. Push a semver release tag, for example `v0.1.0`, then move the major tag `v0` to the same commit.
3. Open the repository's **Actions** tab and select the ButtonProbe UI Proof workflow or an example workflow run.
4. In repository **Settings**, verify the public repository description, homepage, topics, license, and release notes are current.
5. Open the Action's Marketplace preview from GitHub and verify the icon, description, inputs, and README usage block render correctly.
6. Keep the first Action version verification-only: no model calls, no `--apply`, and no `pull-requests: write` permission.

The Action becomes a required status check in branch protection after a successful run has appeared for the target branch.
