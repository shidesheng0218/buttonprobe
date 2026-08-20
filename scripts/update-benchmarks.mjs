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

function externalMetric(result) {
  const cases = Array.isArray(result.cases) ? result.cases : [];
  return {
    generatedAt: result.generatedAt,
    passed: result.summary?.passed ?? 0,
    total: result.summary?.total ?? 0,
    uiVerifiedRate: result.summary?.uiVerifiedRate ?? null,
    sourceTop1Accuracy: result.summary?.sourceTop1Accuracy ?? null,
    originalRepoPollutionRate: result.summary?.originalRepoPollutionRate ?? 1,
    rollbackResidue: result.summary?.rollbackResidue ?? 0,
    repos: [...new Set(cases.map((item) => (item.repo ?? "").replace("https://github.com/", "")).filter(Boolean))]
  };
}

function readmeBlock(snapshot) {
  const vueRow = snapshot.vue
    ? [`| Vue | ${snapshot.vue.uiVerified}/${snapshot.vue.total} UI-verified | ${snapshot.vue.sourceTop1Accuracy ?? "unknown"} | ${snapshot.vue.failedPatchResidueCount} | ${dateOnly(snapshot.vue.generatedAt)} |`]
    : [];
  const externalRow = snapshot.external
    ? [
        `| External | ${snapshot.external.passed}/${snapshot.external.total} UI-verified | ${snapshot.external.sourceTop1Accuracy ?? "unknown"} | ${snapshot.external.rollbackResidue} | ${dateOnly(snapshot.external.generatedAt)} |`
      ]
    : [];
  return [
    "<!-- benchmark:start -->",
    `**${snapshot.viral.passed}/${snapshot.viral.total} viral cases passing. ${snapshot.react.uiVerified}/${snapshot.react.total} React cases UI-verified. ${snapshot.vue ? `${snapshot.vue.uiVerified}/${snapshot.vue.total} Vue cases UI-verified. ` : ""}${snapshot.external ? `${snapshot.external.passed}/${snapshot.external.total} external third-party cases UI-verified. ` : ""}Original repo pollution rate: ${snapshot.react.originalRepoPollutionRate}.**`,
    "",
    "| Suite | Result | Source Top-1 | Residue | Evidence date |",
    "| --- | --- | --- | --- | --- |",
    `| Viral | ${snapshot.viral.passed}/${snapshot.viral.total} passing | ${snapshot.viral.sourceTop1Accuracy ?? "unknown"} | ${snapshot.viral.failedPatchResidueCount} | ${dateOnly(snapshot.viral.generatedAt)} |`,
    `| React | ${snapshot.react.uiVerified}/${snapshot.react.total} UI-verified | ${snapshot.react.sourceTop1Accuracy ?? "unknown"} | ${snapshot.react.failedPatchResidueCount} | ${dateOnly(snapshot.react.generatedAt)} |`,
    ...vueRow,
    ...externalRow,
    "",
    "Generated from real local eval artifacts in `benchmarks/latest.json`.",
    "<!-- benchmark:end -->"
  ].join("\n");
}

export async function updateBenchmarkSummary({ viralPath, reactPath, vuePath, externalPath, outputPath, readmePath }) {
  const [viral, react, vue, external] = await Promise.all([
    readFile(viralPath, "utf8").then(JSON.parse),
    readFile(reactPath, "utf8").then(JSON.parse),
    vuePath ? readFile(vuePath, "utf8").then(JSON.parse) : Promise.resolve(null),
    externalPath ? readFile(externalPath, "utf8").then(JSON.parse) : Promise.resolve(null)
  ]);
  const snapshot = {
    schemaVersion: 1,
    viral: metric(viral),
    react: metric(react),
    ...(vue ? { vue: metric(vue) } : {}),
    ...(external ? { external: externalMetric(external) } : {})
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
    vuePath: value(process.argv, "--vue"),
    externalPath: value(process.argv, "--external"),
    outputPath: value(process.argv, "--output") ?? "benchmarks/latest.json",
    readmePath: value(process.argv, "--readme") ?? "README.md"
  };
  if (!options.viralPath || !options.reactPath) {
    throw new Error("Usage: node scripts/update-benchmarks.mjs --viral <eval-results.json> --react <eval-results.json> [--external <eval-results.json>]");
  }
  await updateBenchmarkSummary(options);
}
