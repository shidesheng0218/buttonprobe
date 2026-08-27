import { appendFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

function input(env, name, fallback = "") {
  return (env[`INPUT_${name.replaceAll("-", "_").toUpperCase()}`] ?? fallback).trim();
}

export function parseActionInputs(env = process.env) {
  const url = input(env, "url");
  const patch = input(env, "patch");
  const patchUrl = input(env, "patch-url");
  const testCommand = input(env, "test-command");
  if (!url || !testCommand || (!patch && !patchUrl) || (patch && patchUrl)) {
    throw new Error("ButtonProbe Action requires url, test-command, and exactly one of patch or patch-url");
  }
  return {
    url,
    ...(patch ? { patch } : {}),
    ...(patchUrl ? { patchUrl } : {}),
    testCommand,
    devCommand: input(env, "dev-command"),
    projectRoot: input(env, "project-root", "."),
    output: input(env, "output", "buttonprobe-proof"),
    target: input(env, "target"),
    browser: input(env, "browser", "chromium"),
    packageVersion: input(env, "buttonprobe-version", "latest"),
    failOnUnverified: input(env, "fail-on-unverified", "true") !== "false",
    comment: input(env, "comment", "false") === "true",
    githubToken: input(env, "github-token")
  };
}

export function shouldFailAction(status, failOnUnverified) {
  return failOnUnverified && status !== "ui-verified";
}

export function buildActionArgs(values) {
  const args = ["--yes", `buttonprobe@${values.packageVersion}`, "verify", values.url];
  if (values.patch) args.push("--patch", values.patch);
  if (values.patchUrl) args.push("--patch-url", values.patchUrl);
  args.push("--test-command", values.testCommand, "--project-root", values.projectRoot, "--output", values.output, "--browser", values.browser);
  if (values.devCommand) args.push("--dev-command", values.devCommand);
  if (values.target) args.push("--target", values.target);
  return args;
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function setOutput(env, name, value) {
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

const commentMarker = "<!-- buttonprobe-proof-comment -->";

function redact(value) {
  return String(value ?? "")
    .replace(/(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{8,}\b/g, "[redacted]");
}

export function buildProofComment(proof, values) {
  const browsers = (proof.ui?.browsers ?? proof.browsers ?? [])
    .map((browser) => `${browser.browser}: ${browser.status}`)
    .join(" | ") || "not run";
  const scenario = proof.ui?.behaviorContract
    ? proof.ui.behaviorContract.passed ? "passed" : "failed"
    : "not configured";
  const reason = proof.rejectionReason && !/secret|token|key/i.test(proof.rejectionReason)
    ? `\n- rejection: ${redact(proof.rejectionReason).slice(0, 500)}`
    : "";
  return `${commentMarker}
## ButtonProbe UI proof

- status: **${proof.status}**
- model calls: ${proof.modelCalls ?? proof.usageSummary?.modelCalls ?? 0}
- original checkout modified: ${String(Boolean(proof.originalCheckoutModified))}
- browsers: ${browsers}
- scenario: ${scenario}
- report: \`${values.output}/${proof.artifacts?.report ?? "report.html"}\`${reason}

Run artifacts are attached to this workflow when the workflow uploads \`${values.output}\`.`;
}

async function githubRequest(token, method, path, body, env) {
  const base = env.GITHUB_API_URL ?? "https://api.github.com";
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`GitHub API ${method} ${path} failed: HTTP ${response.status}`);
  return data;
}

export async function publishPullRequestComment({ env, token, proof, request, event, values = { output: "buttonprobe-proof" } }) {
  if (!token) return { status: "warning", warning: "comment enabled but github-token is unavailable" };
  if (env.GITHUB_EVENT_NAME !== "pull_request") return { status: "skipped", warning: "comment is only available for pull_request events" };
  if (!env.GITHUB_REPOSITORY) return { status: "warning", warning: "GITHUB_REPOSITORY is unavailable" };
  const payload = event ?? JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
  const number = payload.number ?? payload.pull_request?.number;
  if (!number) return { status: "warning", warning: "pull request number is unavailable" };
  const call = request ?? ((method, path, body) => githubRequest(token, method, path, body, env));
  try {
    const viewer = await call("GET", "/user");
    const commentsResponse = await call("GET", `/repos/${env.GITHUB_REPOSITORY}/issues/${number}/comments?per_page=100`);
    const comments = Array.isArray(commentsResponse) ? commentsResponse : commentsResponse.data ?? [];
    const existing = comments.find((comment) => comment.user?.login === viewer.login && String(comment.body ?? "").includes(commentMarker));
    const body = buildProofComment(proof, values);
    if (existing?.id) {
      const updated = await call("PATCH", `/repos/${env.GITHUB_REPOSITORY}/issues/comments/${existing.id}`, { body });
      return { status: "updated", url: updated.html_url };
    }
    const created = await call("POST", `/repos/${env.GITHUB_REPOSITORY}/issues/${number}/comments`, { body });
    return { status: "posted", url: created.html_url };
  } catch (error) {
    return { status: "warning", warning: redact(error.message) };
  }
}

async function writeSummary(env, proof, values, comment) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  const commentLine = comment ? `\n- PR comment: ${comment.status}${comment.url ? ` (${comment.url})` : comment.warning ? ` (${comment.warning})` : ""}` : "";
  await appendFile(
    env.GITHUB_STEP_SUMMARY,
    `## ButtonProbe UI proof\n\n- Status: **${proof.status}**\n- Model calls: ${proof.modelCalls ?? proof.usageSummary?.modelCalls ?? 0}\n- Original checkout modified: ${String(Boolean(proof.originalCheckoutModified))}\n- Report: \`${values.output}/${proof.artifacts?.report ?? "report.html"}\`${commentLine}\n`
  );
}

async function runAction(env = process.env) {
  const values = parseActionInputs(env);
  const args = buildActionArgs(values);
  const code = await run("npx", args, env.GITHUB_WORKSPACE ?? process.cwd());
  const proof = JSON.parse(await (await import("node:fs/promises")).readFile(`${values.output}/proof.json`, "utf8"));
  const comment = values.comment
    ? await publishPullRequestComment({ env, token: values.githubToken, proof, values })
    : { status: "skipped" };
  await writeSummary(env, proof, values, comment);
  await Promise.all([
    setOutput(env, "status", proof.status),
    setOutput(env, "proof-path", `${values.output}/proof.json`),
    setOutput(env, "report-path", `${values.output}/${proof.artifacts?.report ?? "report.html"}`),
    setOutput(env, "verified-diff-path", proof.artifacts?.verifiedDiff ? `${values.output}/${proof.artifacts.verifiedDiff}` : ""),
    setOutput(env, "model-calls", String(proof.modelCalls ?? proof.usageSummary?.modelCalls ?? 0)),
    setOutput(env, "original-checkout-modified", String(proof.originalCheckoutModified)),
    setOutput(env, "comment-status", comment.status),
    setOutput(env, "comment-url", comment.url ?? "")
  ]);
  if (shouldFailAction(proof.status, values.failOnUnverified) || code !== 0) process.exitCode = 1;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  runAction().catch((error) => {
    process.stderr.write(`ButtonProbe Action error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
