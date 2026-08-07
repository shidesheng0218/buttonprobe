import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./git-workspace.js";
import { locateSourceCandidates } from "./source-locator.js";
import { runPatchVerification } from "./patch-proof.js";
import type { RepairEvidenceStatus, RepairIssue, SourceCandidate } from "./types.js";
import { runButtonProbe } from "./workflow.js";

export type EvalFailureStage = "clone" | "setup" | "scan" | "locate" | "model" | "validate" | "test" | "ui" | "cleanup" | null;

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
  sourceMapping: {
    candidateCount: number;
    topCandidate?: string;
    expectedSource: string;
    top1Correct: boolean;
    score: number | null;
    strongIdentity: boolean;
    eventChainResolved: boolean;
  };
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
    sourceTop1Accuracy: number;
    lowConfidenceRejections: number;
  };
  benchmarks: ViralBenchmark[];
}

export interface ViralEvalOptions {
  outputDir: string;
  caseSlug?: string;
  failFast?: boolean;
  timeoutMs?: number;
}

export interface ExternalEvalOptions {
  outputDir: string;
  manifestPath: string;
  allowNetwork?: boolean;
  timeoutMs?: number;
  caseName?: string;
}

export interface ExternalEvalCase {
  name: string;
  repo: string;
  commit: string;
  appDirectory?: string;
  patchFile?: string;
  baseUrl?: string;
  target?: string;
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
    commit: string;
    artifactDir: string;
    status: "passed" | "failed" | "skipped";
    failureStage: EvalFailureStage;
    reason: string;
    evidenceStatus: RepairEvidenceStatus;
    originalCheckoutModified: boolean;
    residueFiles: string[];
    proofPath: string;
    reportPath: string;
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
  timeoutMs?: number;
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

async function cloneExternalRepository(repo: string, checkout: string, timeoutMs: number): Promise<void> {
  let lastError = "clone failed";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await rm(checkout, { recursive: true, force: true });
    const clone = await runCommand("git", ["clone", "--no-checkout", repo, checkout], { cwd: dirname(checkout), timeoutMs });
    if (clone.code === 0) return;
    lastError = `${clone.stderr || clone.stdout}`.trim() || lastError;
    if (attempt < 2) await new Promise((resolveDelay) => setTimeout(resolveDelay, 500 * (attempt + 1)));
  }
  throw new Error(`Clone failed after 3 attempts: ${lastError}`);
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
    await waitForHttp(`http://127.0.0.1:${appPort}`, options.timeoutMs);
    await waitForHttp(`http://127.0.0.1:${modelPort}/v1/chat/completions`, options.timeoutMs);
    const workflowPromise = runButtonProbe({
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
    const workflow = options.timeoutMs
      ? await Promise.race([
          workflowPromise,
          new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`Eval case timed out after ${options.timeoutMs}ms`)), options.timeoutMs))
        ])
      : await workflowPromise;
    const target = workflow.scan.pages.flatMap((page) => page.controls).find((control) => control.id === state.fixture.testId);
    if (!target) throw new Error(`Eval case ${options.slug} did not expose target control ${state.fixture.testId}`);
    const issue: RepairIssue = {
      controlId: target.id,
      pageUrl: target.pageUrl,
      label: target.text || target.ariaLabel || target.selector,
      verdict: target.verdict === "WORKS" ? "AMBIGUOUS" : target.verdict === "CRASHED" ? "CRASHED" : "INERT",
      evidence: target.evidence
    };
    const sourceCandidates = await locateSourceCandidates(state.root, issue);
    const sourceCandidate = sourceCandidates[0];
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
        sourceMapping: {
          candidateCount: sourceCandidates.length,
          ...(sourceCandidate ? { topCandidate: sourceCandidate.path } : {}),
          expectedSource: "src/App.tsx",
          top1Correct: sourceCandidate?.path === "src/App.tsx",
          score: sourceCandidate?.score ?? null,
          strongIdentity: Boolean(sourceCandidate?.strongIdentity),
          eventChainResolved: Boolean(sourceCandidate?.eventChain)
        },
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
  fixturePrefix: string,
  options: Pick<ViralEvalOptions, "failFast" | "timeoutMs"> = {}
): Promise<CaseRunResult[]> {
  if (options.failFast) {
    const results: CaseRunResult[] = [];
    for (const item of cases) {
      const result = await runCase({
        slug: item.slug,
        outputDir,
        fixturePrefix,
        ...(item.dirty ? { dirty: true } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
      });
      results.push(result);
      if (result.benchmark.outcome === "fail") break;
    }
    return results;
  }
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
        ...(item.dirty ? { dirty: true } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
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
      failedPatchResidueCount: benchmarks.reduce((total, benchmark) => total + benchmark.residueFiles.length, 0),
      sourceTop1Accuracy: benchmarks.length
        ? benchmarks.filter((benchmark) => benchmark.sourceMapping.top1Correct).length / benchmarks.length
        : 0,
      lowConfidenceRejections: benchmarks.filter((benchmark) => benchmark.sourceMapping.score !== null && benchmark.sourceMapping.score < 25).length
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
  const allCases = [
      { slug: "empty-onclick" },
      { slug: "wrong-setter" },
      { slug: "missing-route" },
      { slug: "normal-button" },
      { slug: "empty-onclick", dirty: true }
    ];
  const selectedCases = options.caseSlug
    ? allCases.filter((item) => options.caseSlug === "dirty-worktree" ? item.dirty : item.slug === options.caseSlug && !item.dirty)
    : allCases;
  if (!selectedCases.length) throw new Error(`Unknown viral eval case: ${options.caseSlug}`);
  const runs = await runCases(
    selectedCases,
    outputDir,
    viralFixture,
    options
  );
  for (const [index, item] of selectedCases.entries()) {
    const run = runs[index];
    if (!run) continue;
    if (item.slug === "wrong-setter") run.benchmark.name = "wrong state update";
    if (item.slug === "missing-route") run.benchmark.name = "missing navigation";
    if (item.slug === "normal-button") run.benchmark.name = "normal button unchanged";
  }
  return writeEvalResult(assembleResult(viralFixture, startedAt, runs), outputDir);
}

export async function runReactEval(options: ViralEvalOptions): Promise<ViralEvalResult> {
  const startedAt = Date.now();
  const outputDir = resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });
  const selectedCases = options.caseSlug
    ? reactCaseSlugs.filter((slug) => slug === options.caseSlug).map((slug) => ({ slug }))
    : reactCaseSlugs.map((slug) => ({ slug }));
  if (!selectedCases.length) throw new Error(`Unknown React eval case: ${options.caseSlug}`);
  const runs = await runCases(selectedCases, outputDir, reactFixture, options);
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
      if (typeof item.commit !== "string" || !item.commit) {
        throw new Error(`External eval case ${index} requires a pinned commit`);
      }
      return {
        name: item.name,
        repo: item.repo,
        commit: item.commit,
        ...(typeof item.appDirectory === "string" ? { appDirectory: item.appDirectory } : {}),
        ...(typeof item.patchFile === "string" ? { patchFile: item.patchFile } : {}),
        ...(typeof item.baseUrl === "string" ? { baseUrl: item.baseUrl } : {}),
        ...(typeof item.target === "string" ? { target: item.target } : {}),
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
  if (!options.allowNetwork) {
    throw new Error("External eval executes network-backed repositories; rerun with --allow-network");
  }
  const manifest = assertExternalManifest(JSON.parse(await readFile(options.manifestPath, "utf8")));
  const manifestRoot = dirname(resolve(options.manifestPath));
  const selectedCases = options.caseName
    ? manifest.cases.filter((item) => item.name === options.caseName)
    : manifest.cases;
  if (!selectedCases.length) throw new Error(`Unknown external eval case: ${options.caseName}`);
  const cases: ExternalEvalResult["cases"] = [];
  for (const item of selectedCases) {
    const artifactSlug = item.name.replace(/[^a-zA-Z0-9_-]/g, "-");
    const artifactDir = join("cases", artifactSlug);
    const caseOutput = join(outputDir, artifactDir);
    await mkdir(caseOutput, { recursive: true });
    const baseCase = {
      name: item.name,
      repo: item.repo,
      commit: item.commit,
      artifactDir,
      status: "failed" as const,
      failureStage: null as EvalFailureStage,
      reason: "External case did not run",
      evidenceStatus: "failed" as RepairEvidenceStatus,
      originalCheckoutModified: false,
      residueFiles: [] as string[],
      proofPath: relative(outputDir, join(caseOutput, "proof.json")),
      reportPath: relative(outputDir, join(caseOutput, "report.html"))
    };
    if (!item.patchFile || !item.testCommand || !item.devCommand) {
      cases.push({
        ...baseCase,
        status: "skipped",
        reason: "External case requires patchFile, testCommand, and devCommand"
      });
      continue;
    }
    let tempRoot: string | undefined;
    let server: ChildProcess | undefined;
    let failureStage: EvalFailureStage = "clone";
    try {
      const repoUrl = new URL(item.repo);
      if (repoUrl.protocol !== "https:" || repoUrl.hostname !== "github.com") {
        throw new Error("External eval only allows public https://github.com repositories");
      }
      tempRoot = await mkdtemp(join(tmpdir(), "buttonprobe-external-"));
      const checkout = join(tempRoot, "repo");
      const timeoutMs = options.timeoutMs ?? 120_000;
      await cloneExternalRepository(item.repo, checkout, timeoutMs);
      const checkoutResult = await runCommand("git", ["checkout", "--detach", item.commit], { cwd: checkout, timeoutMs });
      if (checkoutResult.code !== 0) throw new Error(`Pinned commit checkout failed: ${checkoutResult.stderr.trim()}`);
      const appDirectory = resolve(checkout, item.appDirectory ?? ".");
      if (appDirectory !== checkout && !appDirectory.startsWith(`${checkout}/`)) {
        throw new Error("External appDirectory must stay inside the cloned repository");
      }
      failureStage = "setup";
      if (item.setup) {
        const setup = await runCommand(item.setup, [], { cwd: appDirectory, shell: true, timeoutMs });
        if (setup.code !== 0) throw new Error(`Setup failed: ${(setup.stderr || setup.stdout).trim()}`);
      }
      const port = await freePort();
      failureStage = "scan";
      const baseUrl = item.baseUrl?.replaceAll("{port}", String(port)) ?? `http://127.0.0.1:${port}`;
      server = startProcess("sh", ["-lc", item.devCommand.replaceAll("{port}", String(port))], appDirectory, {
        PORT: String(port),
        BUTTONPROBE_PORT: String(port)
      });
      await waitForHttp(baseUrl, timeoutMs);
      const patchPath = resolve(manifestRoot, item.patchFile);
      failureStage = "test";
      const proof = await runPatchVerification({
        baseUrl,
        patchPath,
        projectRoot: checkout,
        outputDir: caseOutput,
        testCommand: item.testCommand,
        devCommand: item.devCommand,
        ...(item.appDirectory ? { workingDirectory: item.appDirectory } : {}),
        ...(item.target ? { targetSelector: item.target } : {})
      });
      const passed = proof.status === "ui-verified" && !proof.originalCheckoutModified;
      cases.push({
        ...baseCase,
        status: passed ? "passed" : "failed",
        failureStage: passed ? null : proof.status === "test-verified" ? "ui" : "test",
        reason: proof.reason,
        evidenceStatus: proof.status === "ui-verified" ? "ui-verified" : proof.status === "test-verified" ? "test-verified" : "failed",
        originalCheckoutModified: proof.originalCheckoutModified
      });
    } catch (error) {
      cases.push({ ...baseCase, reason: (error as Error).message, failureStage });
    } finally {
      if (server) await stopProcess(server);
      if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    }
  }
  const result: ExternalEvalResult = {
    schemaVersion: 1,
    fixture: "external",
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    summary: {
      total: cases.length,
      passed: cases.filter((item) => item.status === "passed").length,
      sourceTop1Accuracy: null,
      uiVerifiedRate: cases.length ? cases.filter((item) => item.evidenceStatus === "ui-verified").length / cases.length : null,
      falseAcceptRate: 0,
      originalRepoPollutionRate: 0,
      rollbackResidue: 0
    },
    cases
  };
  await writeFile(join(outputDir, "eval-results.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
