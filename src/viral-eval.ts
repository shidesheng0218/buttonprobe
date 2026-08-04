import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./git-workspace.js";
import { locateSourceCandidates } from "./source-locator.js";
import type { RepairEvidenceStatus, RepairIssue, SourceCandidate } from "./types.js";
import { runButtonProbe } from "./workflow.js";

export type EvalFailureStage = "scan" | "locate" | "model" | "validate" | "test" | "ui" | "cleanup" | null;

export interface ViralBenchmark {
  name: string;
  fixtureName: string;
  detectedIssueCount: number;
  repairStatus: "verified" | "unchanged" | "patch-only" | "failed";
  evidenceStatus: RepairEvidenceStatus;
  counterfactualVerified: boolean;
  testResult: "passed" | "failed" | "not-run";
  originalCheckoutModified: boolean;
  artifactDir: string;
  residueFiles: string[];
  sourceCandidate: Pick<SourceCandidate, "path" | "score" | "reason"> | null;
  failureStage: EvalFailureStage;
  verifiedDiffPath: string;
  testLogPath: string;
  beforeScreenshot: string;
  afterScreenshot: string;
  outcome: "pass" | "fail";
}

export interface ViralEvalResult {
  schemaVersion: 2;
  fixture: string;
  generatedAt: string;
  durationMs: number;
  modelProvider: string;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costEstimateUsd: number | null;
  summary: {
    total: number;
    passed: number;
    originalRepoPollutionRate: number;
    failedPatchResidueCount: number;
  };
  benchmarks: ViralBenchmark[];
}

export interface ViralEvalOptions {
  outputDir: string;
}

export interface ExternalEvalOptions {
  outputDir: string;
  manifestPath: string;
}

export interface ExternalEvalCase {
  name: string;
  repo: string;
  commit?: string;
  setup?: string;
  devCommand?: string;
  testCommand?: string;
  scenario?: string;
}

export interface ExternalEvalResult {
  schemaVersion: 1;
  fixture: "external";
  generatedAt: string;
  durationMs: number;
  summary: {
    total: number;
    passed: number;
    sourceTop1Accuracy: number | null;
    uiVerifiedRate: number | null;
    falseAcceptRate: number;
    originalRepoPollutionRate: number;
    rollbackResidue: number;
  };
  cases: Array<{
    name: string;
    repo: string;
    commit?: string;
    artifactDir: string;
    status: "pending" | "failed";
    failureStage: EvalFailureStage;
    reason: string;
  }>;
}

interface FixtureCase {
  name: string;
  testId: string;
  label: string;
  source: string;
  fixedSource: string;
  normal?: boolean;
  forceUiFailure?: boolean;
}

interface CaseRunOptions {
  slug: string;
  outputDir: string;
  fixturePrefix: string;
  dirty?: boolean;
}

interface CaseRunResult {
  benchmark: ViralBenchmark;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costEstimateUsd: number | null;
}

const viralFixture = "fixtures/viral-demo-react" as const;
const reactFixture = "fixtures/react-repair-suite" as const;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const suiteRoot = resolve(repoRoot, reactFixture);
const harnessFiles = ["fixture-server.mjs", "fixture-test.mjs", "fixture-model.mjs"];
const reactCaseSlugs = [
  "empty-onclick",
  "noop-state",
  "stale-closure",
  "missing-route",
  "wrong-setter",
  "disabled-submit",
  "missing-callback",
  "modal-open",
  "async-swallow",
  "normal-button"
] as const;

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a localhost port"));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForHttp(url: string, timeoutMs = 20_000): Promise<void> {
  const startedAt = Date.now();
  let lastError = "not ready";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = (error as Error).message;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

function startProcess(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): ChildProcess {
  const processEnv = { ...process.env, ...env };
  delete processEnv.VITEST;
  return spawn(command, args, { cwd, env: processEnv, stdio: ["ignore", "pipe", "pipe"] });
}

function stopProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolveStop) => {
    if (child.exitCode !== null || child.killed) {
      resolveStop();
      return;
    }
    child.once("close", () => resolveStop());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 1000).unref();
  });
}

async function prepareCase(slug: string): Promise<{
  parent: string;
  root: string;
  fixture: FixtureCase;
  originalHash: string;
}> {
  const parent = await mkdtemp(join(tmpdir(), `buttonprobe-eval-${slug}-`));
  const root = join(parent, "repo");
  const fixture = JSON.parse(
    await readFile(join(suiteRoot, "cases", slug, "case.json"), "utf8")
  ) as FixtureCase;
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "case.json"), `${JSON.stringify(fixture, null, 2)}\n`);
  await writeFile(join(root, "src", "App.tsx"), fixture.source);
  await writeFile(join(root, "notes.txt"), "clean\n");
  await writeFile(join(root, ".gitignore"), ".buttonprobe\nnode_modules\n");
  for (const file of harnessFiles) await cp(join(suiteRoot, file), join(root, file));
  await runCommand("git", ["init", "-b", "main"], { cwd: root });
  await runCommand("git", ["add", "."], { cwd: root });
  await runCommand(
    "git",
    ["-c", "user.name=ButtonProbe", "-c", "user.email=test@example.com", "commit", "-m", "initial"],
    { cwd: root }
  );
  return {
    parent,
    root,
    fixture,
    originalHash: createHash("sha256").update(fixture.source).digest("hex")
  };
}

async function gitStatus(root: string): Promise<string[]> {
  const result = await runCommand("git", ["status", "--porcelain"], { cwd: root });
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean).sort();
}

async function worktreeResidue(root: string): Promise<string[]> {
  const result = await runCommand("git", ["worktree", "list", "--porcelain"], { cwd: root });
  const paths = result.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  return paths.slice(1).map((path) => `worktree:${path}`);
}

function candidateSummary(candidate: SourceCandidate | undefined): ViralBenchmark["sourceCandidate"] {
  if (!candidate) return null;
  return {
    path: candidate.path,
    ...(candidate.score !== undefined ? { score: candidate.score } : {}),
    ...(candidate.reason !== undefined ? { reason: candidate.reason } : {})
  };
}

function relativeArtifact(outputDir: string, path: string): string {
  return relative(outputDir, path).replaceAll("\\", "/");
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

function failureStageFor(evidenceStatus: RepairEvidenceStatus, hasCandidate: boolean): EvalFailureStage {
  if (!hasCandidate) return "locate";
  if (evidenceStatus === "test-verified") return "ui";
  if (evidenceStatus === "generated") return "validate";
  return "test";
}

async function runCase(options: CaseRunOptions): Promise<CaseRunResult> {
  const state = await prepareCase(options.slug);
  const artifactSlug = options.dirty ? `${options.slug}-dirty` : options.slug;
  const artifactRoot = join(options.outputDir, "cases", artifactSlug);
  await mkdir(artifactRoot, { recursive: true });
  if (options.dirty) await writeFile(join(state.root, "notes.txt"), "intentionally dirty\n");
  const initialStatus = await gitStatus(state.root);
  const appPort = await freePort();
  const modelPort = await freePort();
  const app = startProcess(process.execPath, ["fixture-server.mjs"], state.root, { PORT: String(appPort) });
  const model = startProcess(process.execPath, ["fixture-model.mjs"], state.root, { PORT: String(modelPort) });
  try {
    await waitForHttp(`http://127.0.0.1:${appPort}`);
    await waitForHttp(`http://127.0.0.1:${modelPort}/v1/chat/completions`);
    const workflow = await runButtonProbe({
      baseUrl: `http://127.0.0.1:${appPort}`,
      outputDir: artifactRoot,
      projectRoot: state.root,
      maxPages: 1,
      interactionTimeoutMs: 80,
      unsafe: false,
      ai: true,
      fix: true,
      testCommand: "node fixture-test.mjs",
      devCommand: "node fixture-server.mjs",
      maxRounds: 1,
      images: false,
      apiBaseUrl: `http://127.0.0.1:${modelPort}/v1`,
      model: "buttonprobe-eval-mock",
      maxFixIssues: 1
    });
    const target = workflow.scan.pages.flatMap((page) => page.controls).find((control) => control.id === state.fixture.testId);
    if (!target) throw new Error(`Eval case ${options.slug} did not expose target control ${state.fixture.testId}`);
    const issue: RepairIssue = {
      controlId: target.id,
      pageUrl: target.pageUrl,
      label: target.text || target.ariaLabel || target.selector,
      verdict: target.verdict === "WORKS" ? "AMBIGUOUS" : target.verdict === "CRASHED" ? "CRASHED" : "INERT",
      evidence: target.evidence
    };
    const sourceCandidate = (await locateSourceCandidates(state.root, issue))[0];
    const repair = workflow.repairs.find((item) => item.controlId === state.fixture.testId)?.result;
    const attempt = repair?.attempts.find((candidate) => candidate.decision === "accepted") ?? repair?.attempts.at(-1);
    const evidenceStatus: RepairEvidenceStatus = state.fixture.normal
      ? target.verdict === "WORKS" ? "ui-verified" : "failed"
      : repair?.evidenceStatus ?? "failed";
    const testResult = attempt?.tests ? (attempt.tests.passed ? "passed" : "failed") : "not-run";
    const counterfactualVerified = Boolean(repair?.counterfactualVerified);
    const testLogPath = join(artifactRoot, "test.log");
    await writeFile(testLogPath, attempt?.tests?.output ?? (state.fixture.normal ? "No repair required; baseline UI works.\n" : "No test executed.\n"));
    const verifiedDiffAbsolute = join(artifactRoot, "repairs", state.fixture.testId, "verified.diff");
    const verifiedDiffPath = await pathExists(verifiedDiffAbsolute)
      ? relativeArtifact(options.outputDir, verifiedDiffAbsolute)
      : "";
    const uiEvidence = attempt?.ui?.evidence;
    const uiVerificationRoot = attempt
      ? join(artifactRoot, "repairs", state.fixture.testId, `round-${attempt.round}`, "ui-verification")
      : undefined;
    const beforeScreenshot = relativeArtifact(options.outputDir, join(artifactRoot, target.evidence.beforeScreenshot));
    const afterScreenshot = uiEvidence
      ? relativeArtifact(
          options.outputDir,
          join(uiVerificationRoot!, uiEvidence.afterScreenshot)
        )
      : relativeArtifact(options.outputDir, join(artifactRoot, target.evidence.afterScreenshot));
    const afterSource = await readFile(join(state.root, "src", "App.tsx"));
    const originalCheckoutModified = createHash("sha256").update(afterSource).digest("hex") !== state.originalHash;
    const finalStatus = await gitStatus(state.root);
    const residueFiles = [
      ...finalStatus.filter((entry) => !initialStatus.includes(entry)),
      ...(await worktreeResidue(state.root))
    ];
    const patchPath = join(artifactRoot, "patches", `${state.fixture.testId}.diff`);
    const patchGenerated = await pathExists(patchPath);
    const repairStatus: ViralBenchmark["repairStatus"] = state.fixture.normal
      ? "unchanged"
      : evidenceStatus === "generated"
        ? "patch-only"
        : evidenceStatus === "ui-verified" && counterfactualVerified
          ? "verified"
          : "failed";
    const expectedPass = state.fixture.normal
      ? target.verdict === "WORKS" && workflow.repairs.length === 0
      : options.dirty
        ? evidenceStatus === "generated" && patchGenerated
        : !state.fixture.forceUiFailure && evidenceStatus === "ui-verified" && counterfactualVerified;
    const outcome = expectedPass && !originalCheckoutModified && residueFiles.length === 0 ? "pass" : "fail";
    const usage = workflow.usageSummary;
    return {
      benchmark: {
        name: options.dirty ? "dirty worktree patch-only" : state.fixture.name,
        fixtureName: `${options.fixturePrefix}/cases/${artifactSlug}`,
        detectedIssueCount: workflow.scan.pages.flatMap((page) => page.controls).filter((control) => control.verdict === "INERT" || control.verdict === "CRASHED").length,
        repairStatus,
        evidenceStatus,
        counterfactualVerified,
        testResult,
        originalCheckoutModified,
        artifactDir: relativeArtifact(options.outputDir, artifactRoot),
        residueFiles,
        sourceCandidate: candidateSummary(sourceCandidate),
        failureStage: outcome === "fail" ? failureStageFor(evidenceStatus, Boolean(sourceCandidate)) : null,
        verifiedDiffPath,
        testLogPath: relativeArtifact(options.outputDir, testLogPath),
        beforeScreenshot,
        afterScreenshot,
        outcome
      },
      modelCalls: usage?.modelCalls ?? workflow.assessments.length + workflow.repairs.reduce((count, item) => count + item.result.attempts.length, 0),
      inputTokens: usage?.inputTokens ?? workflow.assessments.reduce((total, page) => total + page.usage.inputTokens, 0),
      outputTokens: usage?.outputTokens ?? workflow.assessments.reduce((total, page) => total + page.usage.outputTokens, 0),
      costEstimateUsd: usage?.estimatedCostUsd ?? 0
    };
  } finally {
    await Promise.all([stopProcess(app), stopProcess(model)]);
    await rm(state.parent, { recursive: true, force: true });
  }
}

async function runCases(
  cases: Array<{ slug: string; dirty?: boolean }>,
  outputDir: string,
  fixturePrefix: string
): Promise<CaseRunResult[]> {
  const results = new Array<CaseRunResult>(cases.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < cases.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = cases[index];
      if (!item) continue;
      results[index] = await runCase({
        slug: item.slug,
        outputDir,
        fixturePrefix,
        ...(item.dirty ? { dirty: true } : {})
      });
    }
  }
  await Promise.all([worker(), worker()]);
  return results;
}

function assembleResult(fixture: string, startedAt: number, runs: CaseRunResult[]): ViralEvalResult {
  const benchmarks = runs.map((run) => run.benchmark);
  const polluted = benchmarks.filter((benchmark) => benchmark.originalCheckoutModified).length;
  const knownCosts = runs.map((run) => run.costEstimateUsd).filter((value): value is number => value !== null);
  return {
    schemaVersion: 2,
    fixture,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    modelProvider: "openai-compatible-mock",
    modelCalls: runs.reduce((total, run) => total + run.modelCalls, 0),
    inputTokens: runs.reduce((total, run) => total + run.inputTokens, 0),
    outputTokens: runs.reduce((total, run) => total + run.outputTokens, 0),
    costEstimateUsd: knownCosts.length === runs.length ? knownCosts.reduce((total, cost) => total + cost, 0) : null,
    summary: {
      total: benchmarks.length,
      passed: benchmarks.filter((benchmark) => benchmark.outcome === "pass").length,
      originalRepoPollutionRate: benchmarks.length ? polluted / benchmarks.length : 0,
      failedPatchResidueCount: benchmarks.reduce((total, benchmark) => total + benchmark.residueFiles.length, 0)
    },
    benchmarks
  };
}

export function releaseGatePassed(result: ViralEvalResult, suite: "viral" | "react"): boolean {
  const requiredPasses = suite === "viral" ? 5 : 8;
  return result.summary.passed >= requiredPasses &&
    result.summary.originalRepoPollutionRate === 0 &&
    result.summary.failedPatchResidueCount === 0 &&
    result.benchmarks
      .filter((benchmark) => benchmark.repairStatus === "verified")
      .every((benchmark) => benchmark.counterfactualVerified);
}

export async function validateEvalArtifacts(result: ViralEvalResult, outputDir: string): Promise<void> {
  for (const benchmark of result.benchmarks) {
    if (benchmark.repairStatus === "verified" && !benchmark.counterfactualVerified) {
      throw new Error(`Verified eval repair is missing counterfactual evidence: ${benchmark.name}`);
    }
    const paths = [benchmark.artifactDir, benchmark.beforeScreenshot, benchmark.afterScreenshot, benchmark.testLogPath];
    if (benchmark.evidenceStatus === "test-verified" || benchmark.evidenceStatus === "ui-verified") {
      paths.push(benchmark.verifiedDiffPath);
    }
    for (const path of paths.filter(Boolean)) {
      if (!(await pathExists(resolve(outputDir, path)))) throw new Error(`Missing eval artifact: ${path}`);
    }
  }
}

async function writeEvalResult(result: ViralEvalResult, outputDir: string): Promise<ViralEvalResult> {
  await validateEvalArtifacts(result, outputDir);
  await writeFile(join(outputDir, "eval-results.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export async function runViralEval(options: ViralEvalOptions): Promise<ViralEvalResult> {
  const startedAt = Date.now();
  const outputDir = resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });
  const runs = await runCases(
    [
      { slug: "empty-onclick" },
      { slug: "wrong-setter" },
      { slug: "missing-route" },
      { slug: "normal-button" },
      { slug: "empty-onclick", dirty: true }
    ],
    outputDir,
    viralFixture
  );
  runs[1]!.benchmark.name = "wrong state update";
  runs[2]!.benchmark.name = "missing navigation";
  runs[3]!.benchmark.name = "normal button unchanged";
  return writeEvalResult(assembleResult(viralFixture, startedAt, runs), outputDir);
}

export async function runReactEval(options: ViralEvalOptions): Promise<ViralEvalResult> {
  const startedAt = Date.now();
  const outputDir = resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });
  const runs = await runCases(reactCaseSlugs.map((slug) => ({ slug })), outputDir, reactFixture);
  return writeEvalResult(assembleResult(reactFixture, startedAt, runs), outputDir);
}

function assertExternalManifest(value: unknown): { cases: ExternalEvalCase[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("External eval manifest must be an object");
  }
  const cases = (value as { cases?: unknown }).cases;
  if (!Array.isArray(cases)) throw new Error('External eval manifest requires a "cases" array');
  return {
    cases: cases.map((rawCase, index) => {
      if (!rawCase || typeof rawCase !== "object" || Array.isArray(rawCase)) {
        throw new Error(`External eval case ${index} must be an object`);
      }
      const item = rawCase as Record<string, unknown>;
      if (typeof item.name !== "string" || !item.name) throw new Error(`External eval case ${index} requires name`);
      if (typeof item.repo !== "string" || !item.repo) throw new Error(`External eval case ${index} requires repo`);
      return {
        name: item.name,
        repo: item.repo,
        ...(typeof item.commit === "string" ? { commit: item.commit } : {}),
        ...(typeof item.setup === "string" ? { setup: item.setup } : {}),
        ...(typeof item.devCommand === "string" ? { devCommand: item.devCommand } : {}),
        ...(typeof item.testCommand === "string" ? { testCommand: item.testCommand } : {}),
        ...(typeof item.scenario === "string" ? { scenario: item.scenario } : {})
      };
    })
  };
}

export async function runExternalEval(options: ExternalEvalOptions): Promise<ExternalEvalResult> {
  const startedAt = Date.now();
  const outputDir = resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });
  const manifest = assertExternalManifest(JSON.parse(await readFile(options.manifestPath, "utf8")));
  const cases = [];
  for (const item of manifest.cases) {
    const artifactSlug = item.name.replace(/[^a-zA-Z0-9_-]/g, "-");
    const artifactDir = join("cases", artifactSlug);
    await mkdir(join(outputDir, artifactDir), { recursive: true });
    cases.push({
      name: item.name,
      repo: item.repo,
      ...(item.commit ? { commit: item.commit } : {}),
      artifactDir,
      status: "pending" as const,
      failureStage: null,
      reason: "External benchmark case registered. Clone/setup/repair execution is intentionally separate from packaged CI to avoid network-dependent false greens."
    });
  }
  const result: ExternalEvalResult = {
    schemaVersion: 1,
    fixture: "external",
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    summary: {
      total: cases.length,
      passed: 0,
      sourceTop1Accuracy: null,
      uiVerifiedRate: null,
      falseAcceptRate: 0,
      originalRepoPollutionRate: 0,
      rollbackResidue: 0
    },
    cases
  };
  await writeFile(join(outputDir, "eval-results.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
