import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function metric(result) {
  const benchmarks = Array.isArray(result.benchmarks) ? result.benchmarks : [];
  return {
    generatedAt: result.generatedAt,
    passed: result.summary?.passed ?? 0,
    total: result.summary?.total ?? 0,
    uiVerified: benchmarks.length
      ? benchmarks.filter((benchmark) => benchmark.evidenceStatus === "ui-verified").length
      : result.summary?.passed ?? 0,
    originalRepoPollutionRate: result.summary?.originalRepoPollutionRate ?? 1,
    failedPatchResidueCount: result.summary?.failedPatchResidueCount ?? 0,
    sourceTop1Accuracy: result.summary?.sourceTop1Accuracy ?? null
  };
}

function dateOnly(iso) {
  return typeof iso === "string" ? iso.slice(0, 10) : "unknown";
}

function readmeBlock(snapshot) {
  return [
    "<!-- benchmark:start -->",
    `**${snapshot.viral.passed}/${snapshot.viral.total} viral cases passing. ${snapshot.react.uiVerified}/${snapshot.react.total} React cases UI-verified. Original repo pollution rate: ${snapshot.react.originalRepoPollutionRate}.**`,
    "",
    "| Suite | Result | Source Top-1 | Residue | Evidence date |",
    "| --- | --- | --- | --- | --- |",
    `| Viral | ${snapshot.viral.passed}/${snapshot.viral.total} passing | ${snapshot.viral.sourceTop1Accuracy ?? "unknown"} | ${snapshot.viral.failedPatchResidueCount} | ${dateOnly(snapshot.viral.generatedAt)} |`,
    `| React | ${snapshot.react.uiVerified}/${snapshot.react.total} UI-verified | ${snapshot.react.sourceTop1Accuracy ?? "unknown"} | ${snapshot.react.failedPatchResidueCount} | ${dateOnly(snapshot.react.generatedAt)} |`,
    "",
    "Generated from real local eval artifacts in `benchmarks/latest.json`.",
    "<!-- benchmark:end -->"
  ].join("\n");
}

export async function updateBenchmarkSummary({ viralPath, reactPath, outputPath, readmePath }) {
  const [viral, react] = await Promise.all([
    readFile(viralPath, "utf8").then(JSON.parse),
    readFile(reactPath, "utf8").then(JSON.parse)
  ]);
  const snapshot = {
    schemaVersion: 1,
    viral: metric(viral),
    react: metric(react)
  };
  const readme = await readFile(readmePath, "utf8");
  const marker = /<!-- benchmark:start -->[\s\S]*<!-- benchmark:end -->/;
  if (!marker.test(readme)) throw new Error("README is missing the benchmark marker block");
  await mkdir(dirname(outputPath), { recursive: true });
  await Promise.all([
    writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`),
    writeFile(readmePath, readme.replace(marker, readmeBlock(snapshot)))
  ]);
  return snapshot;
}

function value(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const options = {
    viralPath: value(process.argv, "--viral"),
    reactPath: value(process.argv, "--react"),
    outputPath: value(process.argv, "--output") ?? "benchmarks/latest.json",
    readmePath: value(process.argv, "--readme") ?? "README.md"
  };
  if (!options.viralPath || !options.reactPath) {
    throw new Error("Usage: node scripts/update-benchmarks.mjs --viral <eval-results.json> --react <eval-results.json>");
  }
  await updateBenchmarkSummary(options);
}
