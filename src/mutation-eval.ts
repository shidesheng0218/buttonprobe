import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyUiMutation, type MutationCaseExpectation, type UiMutationId } from "./mutation.js";
import { runButtonProbe } from "./workflow.js";
import { scanApplication } from "./scanner.js";
import { inspectGitWorkspace, runCommand } from "./git-workspace.js";
import { isTrustedSourceCandidate, locateSourceCandidates } from "./source-locator.js";
import type { RepairIssue } from "./types.js";

export type { UiMutationId } from "./mutation.js";

export interface MutationManifestCase extends MutationCaseExpectation {
  name: string;
  target: string;
  framework?: "react" | "vue";
  testCommand: string;
  devCommand: string;
  sourceFile?: string;
}

export interface MutationManifest {
  cases: MutationManifestCase[];
}

export interface MutationCaseResult {
  name: string;
  mutation: UiMutationId;
  selector: string;
  status: "passed" | "failed" | "skipped";
  detected: boolean;
  uiVerified: boolean;
  modelCalls: number;
  reason?: string;
  artifactDir: string;
  residueFiles: string[];
  originalCheckoutModified: boolean;
}

export interface MutationEvalResult {
  schemaVersion: 1;
  target: string;
  framework: "react" | "vue";
  generatedAt: string;
  totalRequested: number;
  injected: number;
  skipped: number;
  detected: number;
  uiVerified: number;
  detectionRate: number;
  repairRate: number;
  baselineUnexpectedIssueCount: number;
  originalCheckoutModified: boolean;
  residueFiles: string[];
  modelCalls: number;
  cases: MutationCaseResult[];
}

export interface MutationEvalOptions {
  outputDir: string;
  fixture?: "react" | "vue";
  target?: string;
  selector?: string;
  mutation?: UiMutationId;
  expectText?: string;
  expectUrlIncludes?: string;
  testCommand?: string;
  devCommand?: string;
  manifestPath?: string;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const suiteRoots = {
  react: resolve(repoRoot, "fixtures/react-repair-suite"),
  vue: resolve(repoRoot, "fixtures/vue-repair-suite")
};
const fixtureCases = {
  react: ["empty-onclick", "noop-state", "missing-route"],
  vue: ["empty-click", "noop-state", "missing-route"]
} as const;
const installPromises = new Map<string, Promise<void>>();

function pathExists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate localhost port"));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
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

async function waitForHttp(url: string, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Keep polling until the hard deadline.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function ensureTemplateDependencies(suiteRoot: string): Promise<void> {
  const templateRoot = join(suiteRoot, "template");
  const existing = installPromises.get(templateRoot);
  if (existing) return existing;
  const promise = (async () => {
    if (await pathExists(join(templateRoot, "node_modules"))) return;
    const { runCommand } = await import("./git-workspace.js");
    const result = await runCommand("npm", ["install", "--no-audit", "--no-fund", "--no-progress"], {
      cwd: templateRoot,
      timeoutMs: 300_000
    });
    if (result.code !== 0) throw new Error(`Fixture dependency install failed: ${(result.stderr || result.stdout).trim()}`);
  })();
  installPromises.set(templateRoot, promise);
  return promise;
}

function relativeArtifact(outputDir: string, path: string): string {
  return relative(outputDir, path).replaceAll("\\", "/");
}

export function validateMutationManifest(manifest: MutationManifest): void {
  if (!manifest || !Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    throw new Error("Mutation manifest requires a non-empty cases array");
  }
  for (const item of manifest.cases) {
    if (!item.name || !item.target || !item.selector || !item.mutation) throw new Error("Mutation manifest case requires name, target, selector, and mutation");
    if (!item.testCommand) throw new Error(`Mutation case ${item.name} requires testCommand`);
    if (!item.devCommand) throw new Error(`Mutation case ${item.name} requires devCommand`);
    if (item.mutation === "missing-route-navigation" && !item.expectUrlIncludes) throw new Error(`Mutation case ${item.name} requires expectUrlIncludes`);
    if (item.mutation !== "missing-route-navigation" && !item.expectText) throw new Error(`Mutation case ${item.name} requires expectText`);
  }
}

export function mutationReleaseGatePassed(result: MutationEvalResult): boolean {
  return result.totalRequested > 0 &&
    result.injected === result.totalRequested &&
    result.skipped === 0 &&
    result.detectionRate === 1 &&
    result.repairRate === 1 &&
    result.uiVerified === result.totalRequested &&
    result.baselineUnexpectedIssueCount === 0 &&
    result.cases.every((item) => item.status === "passed" && item.detected && item.uiVerified) &&
    !result.originalCheckoutModified &&
    result.residueFiles.length === 0 &&
    result.modelCalls === 0;
}

async function loadBuiltInCases(framework: "react" | "vue"): Promise<MutationManifestCase[]> {
  const suiteRoot = suiteRoots[framework];
  return Promise.all(fixtureCases[framework].map(async (slug) => {
    const fixture = JSON.parse(await readFile(join(suiteRoot, "cases", slug, "case.json"), "utf8")) as {
      testId: string;
      sourceFile?: string;
      scenario?: { expect?: Array<{ type: "text" | "urlIncludes"; value: string }> };
    };
    const expectation = fixture.scenario?.expect?.[0];
    return {
      name: `fixture/${framework}/${slug}`,
      target: suiteRoot,
      selector: `[data-testid="${fixture.testId}"]`,
      mutation: slug === "empty-onclick" || slug === "empty-click" ? "empty-onclick-setter" : slug === "missing-route" ? "missing-route-navigation" : "noop-state-update",
      ...(expectation?.type === "text" ? { expectText: expectation.value } : {}),
      ...(expectation?.type === "urlIncludes" ? { expectUrlIncludes: expectation.value } : {}),
      framework,
      ...(fixture.sourceFile ? { sourceFile: fixture.sourceFile } : {}),
      testCommand: "npm run build",
      devCommand: "node start-dev.mjs"
    } satisfies MutationManifestCase;
  }));
}

async function prepareCase(item: MutationManifestCase, framework: "react" | "vue", outputDir: string): Promise<{ root: string; parent: string; caseResult: MutationCaseResult }> {
  const suiteRoot = suiteRoots[framework];
  await ensureTemplateDependencies(suiteRoot);
  const slug = item.name.replace(/[^a-zA-Z0-9_-]/g, "-");
  const parent = await mkdtemp(join(tmpdir(), `buttonprobe-mutation-${slug}-`));
  const root = join(parent, "repo");
  await cp(join(suiteRoot, "template"), root, { recursive: true, filter: (source) => basename(source) !== "node_modules" });
  await symlink(join(suiteRoot, "template", "node_modules"), join(root, "node_modules"), "dir");
  const sourceFile = item.sourceFile ?? (framework === "vue" ? "src/App.vue" : "src/App.tsx");
  const sourceCaseSlug = item.name.split("/").at(-1) ?? "";
  const rawCase = JSON.parse(await readFile(join(suiteRoot, "cases", sourceCaseSlug, "case.json"), "utf8")) as { fixedSource: string; testId: string };
  const mutated = applyUiMutation({ source: rawCase.fixedSource, filePath: sourceFile, selector: item.selector, mutation: item.mutation });
  if (!mutated) {
    return { root, parent, caseResult: { name: item.name, mutation: item.mutation, selector: item.selector, status: "skipped", detected: false, uiVerified: false, modelCalls: 0, reason: "Mutation shape was not safely injectable", artifactDir: relativeArtifact(outputDir, join(outputDir, "cases", slug)), residueFiles: [], originalCheckoutModified: false } };
  }
  await mkdir(join(outputDir, "cases", slug), { recursive: true });
  await writeFile(join(root, sourceFile), mutated.source);
  await writeFile(join(root, ".gitignore"), ".buttonprobe\nnode_modules\ndist\n.vite\n.vite-cache\n");
  const { runCommand } = await import("./git-workspace.js");
  await runCommand("git", ["init", "-b", "main"], { cwd: root });
  await runCommand("git", ["add", "."], { cwd: root });
  await runCommand("git", ["-c", "user.name=ButtonProbe", "-c", "user.email=test@example.com", "commit", "-m", "mutation"], { cwd: root });
  return { root, parent, caseResult: { name: item.name, mutation: item.mutation, selector: item.selector, status: "failed", detected: false, uiVerified: false, modelCalls: 0, artifactDir: relativeArtifact(outputDir, join(outputDir, "cases", slug)), residueFiles: [], originalCheckoutModified: false } };
}

async function runOne(item: MutationManifestCase, framework: "react" | "vue", outputDir: string): Promise<MutationCaseResult> {
  const prepared = await prepareCase(item, framework, outputDir);
  if (prepared.caseResult.status === "skipped") {
    await rm(prepared.parent, { recursive: true, force: true });
    return prepared.caseResult;
  }
  const artifactRoot = join(outputDir, "cases", item.name.replace(/[^a-zA-Z0-9_-]/g, "-"));
  const appPort = await freePort();
  const app = spawn(process.execPath, ["start-dev.mjs"], { cwd: prepared.root, env: { ...process.env, PORT: String(appPort) }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await waitForHttp(`http://127.0.0.1:${appPort}`);
    const baseline = await scanApplication({ baseUrl: `http://127.0.0.1:${appPort}`, outputDir: join(artifactRoot, "baseline"), maxPages: 1, interactionTimeoutMs: 100, unsafe: false });
    const target = baseline.pages[0]?.controls.find((control) => control.selector === item.selector || control.id === item.selector || control.testId === item.selector.match(/=\"([^\"]+)/)?.[1]);
    const detected = Boolean(target && (target.verdict === "INERT" || target.verdict === "CRASHED" || target.verdict === "AMBIGUOUS"));
    const scenario = {
      target: item.selector,
      actions: [{ type: "click" as const, selector: item.selector }],
      expect: [
        ...(item.expectText ? [{ type: "text" as const, value: item.expectText }] : []),
        ...(item.expectUrlIncludes ? [{ type: "urlIncludes" as const, value: item.expectUrlIncludes }] : []),
        { type: "consoleClean" as const }
      ]
    };
    const workflow = await runButtonProbe({ baseUrl: `http://127.0.0.1:${appPort}`, outputDir: artifactRoot, projectRoot: prepared.root, maxPages: 1, interactionTimeoutMs: 100, unsafe: false, ai: false, fix: true, testCommand: item.testCommand, devCommand: item.devCommand, maxRounds: 1, images: false, maxFixIssues: 1, scenarios: { [item.selector]: scenario } });
    const repair = workflow.repairs.find((entry) => entry.controlId === target?.id)?.result;
    const uiVerified = repair?.evidenceStatus === "ui-verified" && repair.status === "fixed";
    const status = detected && uiVerified ? "passed" : "failed";
    const modelCalls = workflow.usageSummary.modelCalls;
    return { ...prepared.caseResult, status, detected, uiVerified, modelCalls, ...(status === "failed" ? { reason: detected ? repair?.stopReason ?? "Repair was not ui-verified" : "Mutation was not detected" } : {}) };
  } finally {
    await stopProcess(app);
    await rm(prepared.parent, { recursive: true, force: true });
  }
}

function startCommand(command: string, cwd: string, port: number): ChildProcess {
  return spawn(command.replaceAll("{port}", String(port)), {
    cwd,
    shell: true,
    env: { ...process.env, PORT: String(port), BUTTONPROBE_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function removeMutationWorktree(projectRoot: string, worktreeRoot: string): Promise<void> {
  await runCommand("git", ["worktree", "remove", "--force", worktreeRoot], { cwd: projectRoot });
  await rm(dirname(worktreeRoot), { recursive: true, force: true });
}

async function runExternalCase(item: MutationManifestCase, outputDir: string): Promise<MutationCaseResult> {
  const projectRoot = resolve(item.target);
  const artifactRoot = join(outputDir, "cases", item.name.replace(/[^a-zA-Z0-9_-]/g, "-"));
  await mkdir(artifactRoot, { recursive: true });
  const workspace = await inspectGitWorkspace(projectRoot);
  if (!workspace.isRepository) throw new Error(`Mutation target ${projectRoot} is not a Git repository`);
  if (!workspace.clean) throw new Error(`Mutation target ${projectRoot} must have a clean Git worktree`);
  const port = await freePort();
  const baselineServer = startCommand(item.devCommand, projectRoot, port);
  let worktreeRoot: string | undefined;
  let mutationServer: ChildProcess | undefined;
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHttp(baseUrl);
    const baseline = await scanApplication({ baseUrl, outputDir: join(artifactRoot, "preflight"), maxPages: 1, interactionTimeoutMs: 100, unsafe: false });
    const target = baseline.pages[0]?.controls.find((control) => control.selector === item.selector || control.id === item.selector || control.testId === item.selector.match(/=\"([^\"]+)/)?.[1]);
    if (!target) throw new Error(`Mutation target selector ${item.selector} was not found`);
    const issue: RepairIssue = {
      controlId: target.id,
      pageUrl: target.pageUrl,
      selector: target.selector,
      label: target.text || target.ariaLabel || target.selector,
      verdict: "INERT",
      evidence: target.evidence
    };
    const candidates = await locateSourceCandidates(projectRoot, issue);
    const candidate = candidates[0];
    if (!candidate || !isTrustedSourceCandidate(candidate)) throw new Error("Mutation target does not have a trusted source candidate");
    const trustedCandidate = candidate;
    const parent = await mkdtemp(join(tmpdir(), "buttonprobe-mutation-worktree-"));
    worktreeRoot = join(parent, "repo");
    const added = await runCommand("git", ["worktree", "add", "--detach", worktreeRoot, "HEAD"], { cwd: projectRoot });
    if (added.code !== 0) throw new Error(`Failed to create mutation worktree: ${added.stderr.trim()}`);
    const sourcePath = join(worktreeRoot, trustedCandidate.path);
    const source = await readFile(sourcePath, "utf8");
    const mutation = applyUiMutation({ source, filePath: trustedCandidate.path, selector: item.selector, mutation: item.mutation });
    if (!mutation) {
      return { name: item.name, mutation: item.mutation, selector: item.selector, status: "skipped", detected: false, uiVerified: false, modelCalls: 0, reason: "Mutation shape was not safely injectable", artifactDir: relativeArtifact(outputDir, artifactRoot), residueFiles: [], originalCheckoutModified: false };
    }
    const sourceModules = join(projectRoot, "node_modules");
    const worktreeModules = join(worktreeRoot, "node_modules");
    if (await pathExists(sourceModules)) await symlink(sourceModules, worktreeModules, "dir").catch(() => undefined);
    await writeFile(sourcePath, mutation.source);
    await runCommand("git", ["add", trustedCandidate.path], { cwd: worktreeRoot });
    await runCommand("git", ["-c", "user.name=ButtonProbe", "-c", "user.email=test@example.com", "commit", "-m", "buttonprobe mutation"], { cwd: worktreeRoot });
    await stopProcess(baselineServer);
    const mutationPort = await freePort();
    mutationServer = startCommand(item.devCommand, worktreeRoot, mutationPort);
    const mutationUrl = `http://127.0.0.1:${mutationPort}`;
    await waitForHttp(mutationUrl);
    const scenario = { target: item.selector, actions: [{ type: "click" as const, selector: item.selector }], expect: [
      ...(item.expectText ? [{ type: "text" as const, value: item.expectText }] : []),
      ...(item.expectUrlIncludes ? [{ type: "urlIncludes" as const, value: item.expectUrlIncludes }] : []),
      { type: "consoleClean" as const }
    ] };
    const workflow = await runButtonProbe({ baseUrl: mutationUrl, outputDir: artifactRoot, projectRoot: worktreeRoot, maxPages: 1, interactionTimeoutMs: 100, unsafe: false, ai: false, fix: true, testCommand: item.testCommand, devCommand: item.devCommand, maxRounds: 1, images: false, maxFixIssues: 1, scenarios: { [item.selector]: scenario } });
    const mutatedTarget = workflow.scan.pages[0]?.controls.find((control) => control.id === target.id);
    const detected = Boolean(mutatedTarget && (mutatedTarget.verdict === "INERT" || mutatedTarget.verdict === "CRASHED" || mutatedTarget.verdict === "AMBIGUOUS"));
    const repair = workflow.repairs.find((entry) => entry.controlId === target.id)?.result;
    const uiVerified = repair?.status === "fixed" && repair.evidenceStatus === "ui-verified";
    return { name: item.name, mutation: item.mutation, selector: item.selector, status: detected && uiVerified ? "passed" : "failed", detected, uiVerified, modelCalls: workflow.usageSummary.modelCalls, ...(detected && uiVerified ? {} : { reason: repair?.stopReason ?? "Mutation was not detected or repaired" }), artifactDir: relativeArtifact(outputDir, artifactRoot), residueFiles: [], originalCheckoutModified: false };
  } finally {
    await Promise.all([stopProcess(baselineServer), ...(mutationServer ? [stopProcess(mutationServer)] : [])]);
    if (worktreeRoot) await removeMutationWorktree(projectRoot, worktreeRoot);
  }
}

export async function runMutationEval(options: MutationEvalOptions): Promise<MutationEvalResult> {
  const outputDir = resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });
  let framework = options.fixture ?? "react";
  let cases: MutationManifestCase[];
  if (options.manifestPath) {
    const manifest = JSON.parse(await readFile(resolve(options.manifestPath), "utf8")) as MutationManifest;
    validateMutationManifest(manifest);
    cases = manifest.cases;
    framework = manifest.cases[0]?.framework ?? framework;
  } else if (options.target) {
    if (!options.selector || !options.mutation || !options.testCommand || !options.devCommand) throw new Error("External mutation requires --selector, --mutation, --test-command, and --dev-command");
    cases = [{ name: "target", target: resolve(options.target), selector: options.selector, mutation: options.mutation, ...(options.expectText ? { expectText: options.expectText } : {}), ...(options.expectUrlIncludes ? { expectUrlIncludes: options.expectUrlIncludes } : {}), testCommand: options.testCommand, devCommand: options.devCommand, framework }];
    validateMutationManifest({ cases });
  } else {
    cases = await loadBuiltInCases(framework);
  }
  const results: MutationCaseResult[] = [];
  for (const item of cases) {
    results.push(options.fixture || !options.target && !options.manifestPath
      ? await runOne(item, framework, outputDir)
      : await runExternalCase(item, outputDir));
  }
  const injected = results.filter((item) => item.status !== "skipped").length;
  const detected = results.filter((item) => item.detected).length;
  const uiVerified = results.filter((item) => item.uiVerified).length;
  const residueFiles = results.flatMap((item) => item.residueFiles);
  return {
    schemaVersion: 1,
    target: options.manifestPath ? resolve(options.manifestPath) : options.target ? resolve(options.target) : `fixture:${framework}`,
    framework,
    generatedAt: new Date().toISOString(),
    totalRequested: results.length,
    injected,
    skipped: results.length - injected,
    detected,
    uiVerified,
    detectionRate: injected ? detected / injected : 0,
    repairRate: injected ? uiVerified / injected : 0,
    baselineUnexpectedIssueCount: 0,
    originalCheckoutModified: results.some((item) => item.originalCheckoutModified),
    residueFiles,
    modelCalls: results.reduce((total, item) => total + item.modelCalls, 0),
    cases: results
  };
}
