import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const root = resolve(import.meta.dirname, "..");

test("keeps the long-running Vue eval out of fast CI and in scheduled evaluation", async () => {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const evalWorkflow = await readFile(resolve(root, ".github/workflows/eval.yml"), "utf8");

  expect(packageJson.scripts["test:ci"]).toContain("--exclude tests/vue-eval.test.ts");
  expect(evalWorkflow).toContain("npm run eval:vue");
});

test("pins nanoid to the patched security release", async () => {
  const lockfile = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8")) as {
    packages: Record<string, { version?: string }>;
  };

  expect(lockfile.packages["node_modules/nanoid"]?.version).toBe("3.3.18");
});
