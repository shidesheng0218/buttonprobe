import { readFile, stat } from "node:fs/promises";
import { expect, test } from "vitest";

test("ships a packed-package E2E command and zero-dependency eval harness", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts: Record<string, string>;
    files: string[];
  };

  expect(packageJson.scripts["test:packed"]).toBe("node scripts/test-packed.mjs");
  expect(packageJson.files).toContain("fixtures/react-repair-suite");
  expect(packageJson.files).toContain("fixtures/vue-repair-suite");
  expect(packageJson.files).toContain("docs/recipes");
  await stat("scripts/test-packed.mjs");
  await stat("fixtures/react-repair-suite/template/package.json");
  await stat("fixtures/react-repair-suite/template/start-dev.mjs");
  await stat("fixtures/react-repair-suite/template/fixture-test.mjs");
  await stat("fixtures/react-repair-suite/fixture-model.mjs");
  await stat("fixtures/react-repair-suite/cases/empty-onclick/case.json");
  await stat("fixtures/vue-repair-suite/template/package.json");
  await stat("docs/recipes/claude-code.md");
});
