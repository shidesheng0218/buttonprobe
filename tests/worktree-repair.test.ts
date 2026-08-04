import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createWorktreeRepairSession } from "../src/worktree-repair.js";

async function createRepo() {
  const root = await mkdtemp(join(tmpdir(), "buttonprobe-worktree-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/App.tsx"), "export const enabled = false;\n");
  await writeFile(join(root, ".gitignore"), "node_modules\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.name=ButtonProbe", "-c", "user.email=test@example.com", "commit", "-m", "initial"],
    { cwd: root }
  );
  await mkdir(join(root, "node_modules", "buttonprobe-marker"), { recursive: true });
  await writeFile(join(root, "node_modules", "buttonprobe-marker", "ready"), "ok\n");
  return root;
}

describe("worktree repair session", () => {
  test("validates a patch in an isolated worktree and leaves original files unchanged", async () => {
    const root = await createRepo();
    const outputDir = await mkdtemp(join(tmpdir(), "buttonprobe-worktree-output-"));
    const original = await readFile(join(root, "src/App.tsx"), "utf8");
    const session = await createWorktreeRepairSession({ projectRoot: root, outputDir });
    const patch =
      "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1 +1 @@\n-export const enabled = false;\n+export const enabled = true;\n";

    const result = await session.verifyPatch({
      patch,
      testCommand:
        "node -e \"const fs=require('fs');if(!fs.readFileSync('src/App.tsx','utf8').includes('enabled = true'))process.exit(1)\""
    });

    expect(result.ok).toBe(true);
    expect(result.evidenceStatus).toBe("test-verified");
    expect(result.verifiedDiffPath).toBeTruthy();
    expect(await readFile(join(root, "src/App.tsx"), "utf8")).toBe(original);
    await expect(stat(result.worktreePath)).rejects.toThrow();
  });

  test("does not write verified diff when the test command fails", async () => {
    const root = await createRepo();
    const outputDir = await mkdtemp(join(tmpdir(), "buttonprobe-worktree-output-"));
    const session = await createWorktreeRepairSession({ projectRoot: root, outputDir });

    const result = await session.verifyPatch({
      patch:
        "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1 +1 @@\n-export const enabled = false;\n+export const enabled = true;\n",
      testCommand: "node -e \"process.exit(1)\""
    });

    expect(result.ok).toBe(false);
    expect(result.verifiedDiffPath).toBeUndefined();
    expect(result.evidenceStatus).toBe("failed");
  });

  test("starts the patched worktree server and upgrades evidence to ui-verified", async () => {
    const root = await createRepo();
    const outputDir = await mkdtemp(join(tmpdir(), "buttonprobe-worktree-output-"));
    await writeFile(
      join(root, "server.mjs"),
      [
        'import { createServer } from "node:http";',
        'import { readFileSync } from "node:fs";',
        'const port = Number(process.env.PORT);',
        'createServer((_request, response) => {',
        '  const source = readFileSync("src/App.tsx", "utf8");',
        '  response.end(source.includes("enabled = true") ? "patched" : "original");',
        '}).listen(port, "127.0.0.1");'
      ].join("\n")
    );
    execFileSync("git", ["add", "server.mjs"], { cwd: root });
    execFileSync(
      "git",
      ["-c", "user.name=ButtonProbe", "-c", "user.email=test@example.com", "commit", "-m", "server"],
      { cwd: root }
    );
    const session = await createWorktreeRepairSession({ projectRoot: root, outputDir });

    const result = await session.verifyPatch({
      patch:
        "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1 +1 @@\n-export const enabled = false;\n+export const enabled = true;\n",
      testCommand:
        "node -e \"const fs=require('fs');if(!fs.existsSync('node_modules/buttonprobe-marker/ready'))process.exit(1)\"",
      devCommand: "node server.mjs",
      verifyUI: async (baseUrl) => ({
        targetWorks: (await fetch(baseUrl).then((response) => response.text())) === "patched",
        regressions: []
      })
    });

    expect(result.ok).toBe(true);
    expect(result.evidenceStatus).toBe("ui-verified");
    expect(result.ui?.targetWorks).toBe(true);
  });

  test("keeps test-verified evidence when patched UI verification fails", async () => {
    const root = await createRepo();
    const outputDir = await mkdtemp(join(tmpdir(), "buttonprobe-worktree-output-"));
    await writeFile(
      join(root, "server.mjs"),
      'import { createServer } from "node:http"; createServer((_request, response) => response.end("ready")).listen(Number(process.env.PORT), "127.0.0.1");\n'
    );
    execFileSync("git", ["add", "server.mjs"], { cwd: root });
    execFileSync(
      "git",
      ["-c", "user.name=ButtonProbe", "-c", "user.email=test@example.com", "commit", "-m", "server"],
      { cwd: root }
    );
    const session = await createWorktreeRepairSession({ projectRoot: root, outputDir });

    const result = await session.verifyPatch({
      patch:
        "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1 +1 @@\n-export const enabled = false;\n+export const enabled = true;\n",
      testCommand: "node -e \"process.exit(0)\"",
      devCommand: "node server.mjs",
      verifyUI: async () => ({ targetWorks: false, regressions: [] })
    });

    expect(result.ok).toBe(false);
    expect(result.evidenceStatus).toBe("test-verified");
    expect(result.verifiedDiffPath).toBeTruthy();
  });
});
