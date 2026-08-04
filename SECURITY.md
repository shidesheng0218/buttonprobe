# Security Policy

ButtonProbe runs locally and does not operate a hosted backend. API keys must be supplied through environment variables and should never be committed to configuration files.

## Supported Versions

Only the latest Alpha is currently supported with security fixes.

## Reporting A Vulnerability

Please open a private security advisory on GitHub or email the maintainer listed in the repository profile. Include reproduction steps, affected commands, and whether the issue can expose source code, screenshots, model prompts, API keys, or live mutation requests.

## Safety Boundaries

ButtonProbe refuses non-localhost scans by default, blocks mutation requests in observe mode, redacts common secrets from source snippets and DOM evidence, and verifies patches in detached Git worktrees. It must not install dependencies, modify lockfiles, run model-suggested shell commands, or handle payment, deletion, permission, database, or production flows.
