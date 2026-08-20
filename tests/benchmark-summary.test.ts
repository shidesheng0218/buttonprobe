import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { updateBenchmarkSummary } from "../scripts/update-benchmarks.mjs";

const evalResult = (fixture: string, passed: number, total: number) => ({
  schemaVersion: 2,
  fixture,
  generatedAt: "2026-08-17T00:00:00.000Z",
  durationMs: 1200,
  summary: {
    passed,
    total,
    originalRepoPollutionRate: 0,
    failedPatchResidueCount: 0,
    sourceTop1Accuracy: 1
  }
});

test("creates a README benchmark block from actual eval JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "buttonprobe-benchmarks-"));
  const viral = join(root, "viral.json");
  const react = join(root, "react.json");
  const vue = join(root, "vue.json");
  const output = join(root, "latest.json");
  const readme = join(root, "README.md");
  await Promise.all([
    writeFile(viral, JSON.stringify(evalResult("fixtures/viral-demo-react", 5, 5))),
    writeFile(react, JSON.stringify(evalResult("fixtures/react-repair-suite", 9, 10))),
    writeFile(vue, JSON.stringify(evalResult("fixtures/vue-repair-suite", 5, 5))),
    writeFile(readme, "before\n<!-- benchmark:start -->\nold\n<!-- benchmark:end -->\nafter\n")
  ]);

  await updateBenchmarkSummary({ viralPath: viral, reactPath: react, vuePath: vue, outputPath: output, readmePath: readme });

  const latest = JSON.parse(await readFile(output, "utf8"));
  const updatedReadme = await readFile(readme, "utf8");
  expect(latest).toMatchObject({ schemaVersion: 1, viral: { passed: 5, total: 5 }, react: { passed: 9, total: 10 }, vue: { passed: 5, total: 5 } });
  expect(updatedReadme).toContain("5/5 viral cases passing");
  expect(updatedReadme).toContain("9/10 React cases UI-verified");
  expect(updatedReadme).toContain("5/5 Vue cases UI-verified");
  expect(updatedReadme).toContain("2026-08-17");
});
