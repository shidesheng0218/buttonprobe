import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { validatePatch } from "../src/patch-validator.js";

async function createRepo() {
  const root = await mkdtemp(join(tmpdir(), "buttonprobe-patch-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/App.tsx"), "export const value = 1;\n");
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.name=ButtonProbe", "-c", "user.email=test@example.com", "commit", "-m", "initial"],
    { cwd: root }
  );
  return root;
}

describe("validatePatch", () => {
  test("accepts a small source-only patch that git can apply", async () => {
    const root = await createRepo();
    const patch =
      "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n";

    const result = await validatePatch(root, patch);
    expect(result.ok).toBe(true);
    expect(result.files).toEqual(["src/App.tsx"]);
  });

  test("rejects patches that touch protected files", async () => {
    const root = await createRepo();
    const patch =
      "--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-SECRET=old\n+SECRET=new\n";

    const result = await validatePatch(root, patch);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("protected");
  });

  test("rejects high-risk or oversized patches before git apply", async () => {
    const root = await createRepo();
    const patch = [
      "--- a/src/App.tsx",
      "+++ b/src/App.tsx",
      "@@ -1 +1,152 @@",
      "-export const value = 1;",
      ...Array.from({ length: 152 }, (_, index) => `+export const value${index} = ${index};`),
      ""
    ].join("\n");

    const result = await validatePatch(root, patch);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("150");
  });
});
