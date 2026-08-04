import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./git-workspace.js";
import type { RepairEvidenceStatus, TestResult, UIVerification } from "./types.js";

export interface WorktreeRepairSessionOptions {
  projectRoot: string;
  outputDir: string;
}

export interface VerifyPatchOptions {
  patch: string;
  testCommand: string;
  devCommand?: string;
  verifyUI?: (baseUrl: string) => Promise<UIVerification>;
}

export interface VerifyPatchResult {
  ok: boolean;
  worktreePath: string;
  verifiedDiffPath?: string;
  tests: TestResult;
  evidenceStatus: RepairEvidenceStatus;
  ui?: UIVerification;
  reason?: string;
}

export interface WorktreeRepairSession {
  verifyPatch(options: VerifyPatchOptions): Promise<VerifyPatchResult>;
}

async function createTempWorktree(projectRoot: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "buttonprobe-worktree-"));
  const worktreePath = join(parent, "repo");
  const result = await runCommand("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], {
    cwd: projectRoot
  });
  if (result.code !== 0) {
    await rm(parent, { recursive: true, force: true });
    throw new Error(`Failed to create repair worktree: ${result.stderr.trim()}`);
  }
  const originalModules = join(projectRoot, "node_modules");
  const worktreeModules = join(worktreePath, "node_modules");
  if (await access(originalModules).then(() => true).catch(() => false)) {
    await symlink(originalModules, worktreeModules, "dir").catch(() => undefined);
  }
  return worktreePath;
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a localhost port"));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForHttp(url: string, timeoutMs = 20_000): Promise<void> {
  const startedAt = Date.now();
  let lastError = "not ready";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = (error as Error).message;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error(`Timed out waiting for patched development server: ${lastError}`);
}

function startDevServer(command: string, cwd: string, port: number): ChildProcess {
  return spawn(command.replaceAll("{port}", String(port)), {
    cwd,
    env: { ...process.env, PORT: String(port), BUTTONPROBE_PORT: String(port) },
    shell: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function stopDevServer(child: ChildProcess): Promise<void> {
  return new Promise((resolveStop) => {
    if (child.exitCode !== null || child.killed) {
      resolveStop();
      return;
    }
    child.once("close", () => resolveStop());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 1000).unref();
  });
}

async function removeWorktree(projectRoot: string, worktreePath: string): Promise<void> {
  await runCommand("git", ["worktree", "remove", "--force", worktreePath], { cwd: projectRoot });
  await rm(join(worktreePath, ".."), { recursive: true, force: true });
}

export async function createWorktreeRepairSession(
  options: WorktreeRepairSessionOptions
): Promise<WorktreeRepairSession> {
  await mkdir(options.outputDir, { recursive: true });
  return {
    async verifyPatch(verifyOptions): Promise<VerifyPatchResult> {
      const worktreePath = await createTempWorktree(options.projectRoot);
      try {
        const apply = await runCommand("git", ["apply", "-"], {
          cwd: worktreePath,
          input: verifyOptions.patch
        });
        if (apply.code !== 0) {
          return {
            ok: false,
            worktreePath,
            tests: { passed: false, command: "git apply", output: apply.stderr.trim() },
            evidenceStatus: "failed",
            reason: "Patch failed to apply in repair worktree"
          };
        }

        const test = await runCommand(verifyOptions.testCommand, [], {
          cwd: worktreePath,
          shell: true,
          timeoutMs: 120_000
        });
        const tests: TestResult = {
          passed: test.code === 0,
          command: verifyOptions.testCommand,
          output: `${test.stdout}${test.stderr}`.trim().slice(-20_000)
        };
        if (!tests.passed) {
          return {
            ok: false,
            worktreePath,
            tests,
            evidenceStatus: "failed",
            reason: "Test command failed in repair worktree"
          };
        }

        const diff = await runCommand("git", ["diff", "--binary"], { cwd: worktreePath });
        const verifiedDiffPath = join(options.outputDir, "verified.diff");
        await writeFile(verifiedDiffPath, diff.stdout);
        if (!verifyOptions.devCommand || !verifyOptions.verifyUI) {
          return { ok: true, worktreePath, verifiedDiffPath, tests, evidenceStatus: "test-verified" };
        }

        const port = await freePort();
        const baseUrl = `http://127.0.0.1:${port}`;
        const server = startDevServer(verifyOptions.devCommand, worktreePath, port);
        try {
          await waitForHttp(baseUrl);
          const ui = await verifyOptions.verifyUI(baseUrl);
          if (!ui.targetWorks || ui.regressions.length > 0) {
            return {
              ok: false,
              worktreePath,
              verifiedDiffPath,
              tests,
              evidenceStatus: "test-verified",
              ui,
              reason: ui.regressions.length > 0
                ? "Patched worktree introduced UI regressions"
                : "Patched worktree did not improve the target control"
            };
          }
          return {
            ok: true,
            worktreePath,
            verifiedDiffPath,
            tests,
            evidenceStatus: "ui-verified",
            ui
          };
        } catch (error) {
          return {
            ok: false,
            worktreePath,
            verifiedDiffPath,
            tests,
            evidenceStatus: "test-verified",
            reason: (error as Error).message
          };
        } finally {
          await stopDevServer(server);
        }
      } finally {
        await removeWorktree(options.projectRoot, worktreePath);
      }
    }
  };
}
