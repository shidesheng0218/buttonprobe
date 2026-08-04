import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  applyPatch,
  inspectGitWorkspace,
  rollbackPatch,
  runTestCommand
} from "../src/git-workspace.js";

async function createRepo() {
  const root = await mkdtemp(join(tmpdir(), "buttonprobe-git-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/App.tsx"), "export const value = 1;\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.name=ButtonProbe", "-c", "user.email=test@example.com", "commit", "-m", "initial"],
    { cwd: root }
  );
  return root;
}

describe("git workspace operations", () => {
  test("detects a clean and dirty repository", async () => {
    const root = await createRepo();
    expect(await inspectGitWorkspace(root)).toMatchObject({ isRepository: true, clean: true });

    await writeFile(join(root, "src/App.tsx"), "export const value = 2;\n");
    expect(await inspectGitWorkspace(root)).toMatchObject({ isRepository: true, clean: false });
  });

  test("applies and precisely reverses a patch", async () => {
    const root = await createRepo();
    const patch =
      "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n";

    await applyPatch(root, patch);
    expect(await readFile(join(root, "src/App.tsx"), "utf8")).toContain("value = 2");
    await rollbackPatch(root, patch);
    expect(await readFile(join(root, "src/App.tsx"), "utf8")).toContain("value = 1");
  });

  test("runs only the caller-provided test command and captures output", async () => {
    const root = await createRepo();
    const result = await runTestCommand(root, 'node -e "console.log(\'verified\')"');

    expect(result.passed).toBe(true);
    expect(result.output).toContain("verified");
  });
});
