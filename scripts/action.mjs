import { appendFile } from "node:fs/promises";
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
    failOnUnverified: input(env, "fail-on-unverified", "true") !== "false"
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

async function runAction(env = process.env) {
  const values = parseActionInputs(env);
  const args = buildActionArgs(values);
  const code = await run("npx", args, env.GITHUB_WORKSPACE ?? process.cwd());
  const proof = JSON.parse(await (await import("node:fs/promises")).readFile(`${values.output}/proof.json`, "utf8"));
  await Promise.all([
    setOutput(env, "status", proof.status),
    setOutput(env, "proof-path", `${values.output}/proof.json`),
    setOutput(env, "report-path", `${values.output}/${proof.artifacts?.report ?? "report.html"}`),
    setOutput(env, "verified-diff-path", proof.artifacts?.verifiedDiff ? `${values.output}/${proof.artifacts.verifiedDiff}` : ""),
    setOutput(env, "model-calls", String(proof.modelCalls ?? proof.usageSummary?.modelCalls ?? 0)),
    setOutput(env, "original-checkout-modified", String(proof.originalCheckoutModified))
  ]);
  if (shouldFailAction(proof.status, values.failOnUnverified) || code !== 0) process.exitCode = 1;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  runAction().catch((error) => {
    process.stderr.write(`ButtonProbe Action error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
