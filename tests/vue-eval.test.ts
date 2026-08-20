import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runVueEval } from "../src/viral-eval.js";

test("runs five Vue repair fixtures through real Vite UI verification", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "buttonprobe-vue-eval-"));
  const result = await runVueEval({ outputDir });
  const written = JSON.parse(await readFile(join(outputDir, "eval-results.json"), "utf8")) as typeof result;

  expect(written.fixture).toBe("fixtures/vue-repair-suite");
  expect(written.summary.total).toBe(5);
  expect(written.summary.passed).toBe(5);
  expect(written.benchmarks.every((benchmark) => benchmark.evidenceStatus === "ui-verified")).toBe(true);
  expect(written.summary.originalRepoPollutionRate).toBe(0);
}, 300_000);
