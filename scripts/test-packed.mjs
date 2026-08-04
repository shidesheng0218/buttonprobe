#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "buttonprobe-packed-e2e-"));
const consumerRoot = join(temporaryRoot, "consumer");

function run(command, args, cwd, allowFailure = false) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env },
    encoding: "utf8",
    stdio: "pipe"
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${output}`);
  }
  return { status: result.status ?? 1, output };
}

try {
  run("npm", ["run", "build"], repoRoot);
  const packed = run("npm", ["pack", "--json", "--pack-destination", temporaryRoot], repoRoot);
  const packResult = JSON.parse(packed.output.trim());
  const filename = packResult[0]?.filename;
  if (!filename) throw new Error("npm pack did not return a tarball filename");
  await writeFile(join(temporaryRoot, "package.json"), JSON.stringify({ private: true }));
  await writeFile(join(temporaryRoot, ".npmrc"), "audit=false\nfund=false\n");
  await writeFile(join(temporaryRoot, "consumer-placeholder"), "ready\n");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(consumerRoot, { recursive: true }));
  await writeFile(join(consumerRoot, "package.json"), JSON.stringify({ private: true }));
  run("npm", ["install", join(temporaryRoot, filename), "--ignore-scripts", "--no-audit", "--no-fund"], consumerRoot);
  const binary = join(consumerRoot, "node_modules", ".bin", "buttonprobe");
  const help = run(binary, ["--help"], consumerRoot);
  if (!help.output.includes("proof-carrying repair loop")) throw new Error("Packed CLI help is incomplete");
  const doctor = run(binary, ["doctor", "http://localhost:5173", "--test-command", "npm test"], consumerRoot, true);
  if (!doctor.output.includes("Node.js") || !doctor.output.includes("Playwright")) {
    throw new Error("Packed doctor did not execute readiness checks");
  }
  const evalOutput = join(consumerRoot, "eval");
  run(binary, ["eval", "viral", "--output", evalOutput], consumerRoot);
  const result = JSON.parse(await readFile(join(evalOutput, "eval-results.json"), "utf8"));
  if (result.summary?.passed !== 5 || result.summary?.originalRepoPollutionRate !== 0) {
    throw new Error(`Packed viral eval gate failed: ${JSON.stringify(result.summary)}`);
  }
  process.stdout.write(`Packed ButtonProbe E2E passed: ${result.summary.passed}/${result.summary.total}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
