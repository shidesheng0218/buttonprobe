import { spawn } from "node:child_process";
import type { TestResult } from "./types.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; input?: string; shell?: boolean; timeoutMs?: number }
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: options.shell ?? false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const timer = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          forceTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
        }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      resolve({
        code: code ?? 1,
        stdout,
        stderr: timedOut ? `${stderr}\nCommand timed out after ${options.timeoutMs}ms` : stderr
      });
    });
    child.stdin.end(options.input);
  });
}

export interface GitWorkspaceStatus {
  isRepository: boolean;
  clean: boolean;
  status: string;
}

export async function inspectGitWorkspace(root: string): Promise<GitWorkspaceStatus> {
  const repository = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root });
  if (repository.code !== 0 || repository.stdout.trim() !== "true") {
    return { isRepository: false, clean: false, status: repository.stderr.trim() };
  }
  const status = await runCommand("git", ["status", "--porcelain"], { cwd: root });
  return {
    isRepository: true,
    clean: status.code === 0 && status.stdout.trim() === "",
    status: status.stdout.trim()
  };
}

export async function applyPatch(root: string, patch: string): Promise<void> {
  const result = await runCommand("git", ["apply", "-"], { cwd: root, input: patch });
  if (result.code !== 0) throw new Error(`Failed to apply patch: ${result.stderr.trim()}`);
}

export async function rollbackPatch(root: string, patch: string): Promise<void> {
  const result = await runCommand("git", ["apply", "--reverse", "-"], { cwd: root, input: patch });
  if (result.code !== 0) throw new Error(`Failed to roll back patch: ${result.stderr.trim()}`);
}

export async function runTestCommand(
  root: string,
  command: string,
  timeoutMs = 120_000
): Promise<TestResult> {
  const result = await runCommand(command, [], { cwd: root, shell: true, timeoutMs });
  const output = `${result.stdout}${result.stderr}`.trim().slice(-20_000);
  return { passed: result.code === 0, command, output };
}
