import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { releaseGatePassed, runReactEval, runViralEval, validateEvalArtifacts } from "../src/viral-eval.js";

describe("viral eval", () => {
  test("writes reproducible benchmark evidence for the GitHub launch demo", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "buttonprobe-viral-eval-"));

    const result = await runViralEval({ outputDir });
    const written = JSON.parse(await readFile(join(outputDir, "eval-results.json"), "utf8")) as typeof result;

    expect(written.schemaVersion).toBe(2);
    expect(written.fixture).toBe("fixtures/viral-demo-react");
    expect(written.summary.total).toBe(5);
    expect(written.summary.passed).toBe(5);
    expect(written.summary.originalRepoPollutionRate).toBe(0);
    expect(written.durationMs).toBeGreaterThan(0);
    expect(written.modelProvider).toBe("openai-compatible-mock");
    expect(written.modelCalls).toBeGreaterThan(0);
    expect(written.inputTokens).toBeGreaterThanOrEqual(0);
    expect(written.outputTokens).toBeGreaterThanOrEqual(0);
    expect(written.costEstimateUsd).toBe(0);
    expect(written.benchmarks.map((benchmark) => benchmark.name)).toEqual([
      "empty onClick",
      "wrong state update",
      "missing navigation",
      "normal button unchanged",
      "dirty worktree patch-only"
    ]);
    expect(written.benchmarks.every((benchmark) => benchmark.outcome === "pass")).toBe(true);
    expect(written.benchmarks.every((benchmark) => typeof benchmark.verifiedDiffPath === "string")).toBe(true);
    expect(
      written.benchmarks
        .filter((benchmark) => benchmark.repairStatus === "verified")
        .every((benchmark) => benchmark.counterfactualVerified)
    ).toBe(true);
    expect(written.benchmarks[0]?.beforeScreenshot).toMatch(/before/);
    expect(written.benchmarks[0]?.afterScreenshot).toMatch(/after/);
    for (const benchmark of written.benchmarks) {
      expect(benchmark.artifactDir).not.toMatch(/^\//);
      expect(benchmark.residueFiles).toEqual([]);
      await stat(join(outputDir, benchmark.beforeScreenshot));
      await stat(join(outputDir, benchmark.afterScreenshot));
    }
    await expect(validateEvalArtifacts(written, outputDir)).resolves.toBeUndefined();
  }, 30_000);

  test("ships the viral React fixture and launch GIF referenced by the README", async () => {
    const readme = await readFile("README.md", "utf8");

    expect(readme).toContain("Find dead buttons. Get verified patches. Keep your repo untouched.");
    expect(readme).toContain("![ButtonProbe verified repair demo](docs/buttonprobe-demo.gif)");
    expect(readme).toContain("Original repo pollution rate: 0");
    expect(readme).toContain("npx buttonprobe fix http://localhost:5173");
    expect(readme).toContain("10 independent React cases");
    expect(readme).toContain("8 UI-verified repairs");
    expect(readme).toContain("Last verified: August 4, 2026");
    expect(readme).toContain("npx buttonprobe eval viral");

    const gif = await readFile("docs/buttonprobe-demo.gif");
    expect(gif.subarray(0, 6).toString("ascii")).toMatch(/^GIF8[79]a$/);
    await stat("fixtures/viral-demo-react/src/App.tsx");
    await stat("fixtures/viral-demo-react/src/App.test.mjs");
    await stat("fixtures/viral-demo-react/mock-openai-compatible.mjs");
    await stat("docs/providers.md");
    expect(await readFile("docs/providers.md", "utf8")).toContain("Anthropic Claude");
    await stat("docs/launch/hn-post.md");
    await stat("docs/launch/x-thread.md");
    await stat("docs/launch/reddit-post.md");
    await stat("docs/launch/demo-script.md");
    await stat("scripts/record-demo.mjs");
  });

  test("runs the React repair suite as a real E2E benchmark", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "buttonprobe-react-eval-"));

    const result = await runReactEval({ outputDir });
    const written = JSON.parse(await readFile(join(outputDir, "eval-results.json"), "utf8")) as typeof result;

    expect(written.fixture).toBe("fixtures/react-repair-suite");
    expect(written.summary.total).toBe(10);
    expect(written.summary.passed).toBeGreaterThanOrEqual(8);
    expect(written.summary.originalRepoPollutionRate).toBe(0);
    expect(written.durationMs).toBeGreaterThan(0);
    expect(written.modelCalls).toBeGreaterThan(0);
    expect(written.benchmarks).toHaveLength(10);
    const rejectedUiCase = written.benchmarks.find((benchmark) => benchmark.name === "async handler swallows error");
    expect(rejectedUiCase?.repairStatus).toBe("failed");
    expect(rejectedUiCase?.evidenceStatus).toBe("test-verified");
    expect(rejectedUiCase?.counterfactualVerified).toBe(false);
    expect(rejectedUiCase?.failureStage).toBe("ui");
    expect(written.benchmarks.filter((benchmark) => benchmark.evidenceStatus === "ui-verified").length).toBeGreaterThanOrEqual(8);
    expect(new Set(written.benchmarks.map((benchmark) => benchmark.fixtureName)).size).toBe(10);
    expect(new Set(written.benchmarks.map((benchmark) => benchmark.artifactDir)).size).toBe(10);
    for (const benchmark of written.benchmarks) {
      expect(benchmark.fixtureName).toContain("fixtures/react-repair-suite/cases/");
      expect(benchmark.originalCheckoutModified).toBe(false);
      expect(benchmark.residueFiles).toEqual([]);
      expect(benchmark.sourceCandidate?.score ?? 0).toBeGreaterThanOrEqual(20);
      await stat(join(outputDir, benchmark.beforeScreenshot));
      await stat(join(outputDir, benchmark.afterScreenshot));
      if (benchmark.evidenceStatus === "ui-verified") {
        await stat(join(outputDir, benchmark.verifiedDiffPath));
        await stat(join(outputDir, benchmark.testLogPath));
        if (benchmark.repairStatus === "verified") expect(benchmark.counterfactualVerified).toBe(true);
      }
      if (benchmark.outcome === "fail") expect(benchmark.failureStage).not.toBeNull();
    }
    expect(releaseGatePassed(written, "react")).toBe(true);
    await expect(validateEvalArtifacts(written, outputDir)).resolves.toBeUndefined();
  }, 60_000);

  test("rejects eval evidence when a referenced screenshot is missing", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "buttonprobe-eval-integrity-"));
    const result = await runViralEval({ outputDir });
    const screenshot = result.benchmarks[0]?.beforeScreenshot;
    expect(screenshot).toBeTruthy();
    await rm(join(outputDir, screenshot!), { force: true });

    await expect(validateEvalArtifacts(result, outputDir)).rejects.toThrow("Missing eval artifact");
  }, 30_000);
});
