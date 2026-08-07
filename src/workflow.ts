import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { AIClient } from "./ai-client.js";
import { applyPatch, inspectGitWorkspace, rollbackPatch, runCommand, runTestCommand } from "./git-workspace.js";
import { validatePatch } from "./patch-validator.js";
import { redactSensitiveText } from "./privacy.js";
import { verifyBehaviorContract, verifyScenarioContract } from "./behavior-contract.js";
import { buildInteractionRegressionTest, interactionChangesAfterClick } from "./regression-test.js";
import { buildRepairPrompt } from "./repair-prompt.js";
import { runRepairLoop } from "./repair-loop.js";
import { writeReport } from "./report.js";
import { scanApplication } from "./scanner.js";
import { isTrustedSourceCandidate, locateSourceCandidates } from "./source-locator.js";
import { createWorktreeRepairSession } from "./worktree-repair.js";
import type {
  AIPageAssessment,
  AIUsageSummary,
  ModelDataManifest,
  RepairAttemptRecord,
  RepairIssue,
  RepairLoopResult,
  ScanControl,
  ScanResult,
  SourceCandidate,
  SourceCandidateEvidence,
  BusinessProfile,
  BrowserName
} from "./types.js";

export interface WorkflowOptions {
  provider?: "openai-compatible" | "anthropic" | undefined;
  baseUrl: string;
  outputDir: string;
  projectRoot: string;
  maxPages: number;
  interactionTimeoutMs: number;
  unsafe: boolean;
  ai: boolean;
  fix: boolean;
  testCommand?: string | undefined;
  devCommand?: string | undefined;
  maxRounds: number;
  images: boolean;
  apiBaseUrl?: string | undefined;
  apiKey?: string | undefined;
  model?: string | undefined;
  analysisModel?: string | undefined;
  repairModel?: string | undefined;
  analyzeMaxTokens?: number | undefined;
  repairMaxTokens?: number | undefined;
  maxModelCalls?: number | undefined;
  maxFixIssues?: number | undefined;
  apply?: boolean | undefined;
  profile?: BusinessProfile | undefined;
  behaviorContracts?: Record<string, import("./types.js").BehaviorContract> | undefined;
  scenarios?: Record<string, import("./types.js").ScenarioContract> | undefined;
  browsers?: BrowserName[] | undefined;
}

export interface WorkflowResult {
  reportPath: string;
  scan: ScanResult;
  assessments: AIPageAssessment[];
  repairs: Array<{ controlId: string; result: RepairLoopResult; sourceCandidates?: SourceCandidateEvidence[] }>;
  usageSummary: AIUsageSummary;
  modelDataManifest: ModelDataManifest;
  aiError?: string;
}

function dataUrl(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

async function imageFor(outputDir: string, relativePath: string): Promise<string> {
  const path = isAbsolute(relativePath) ? relativePath : join(outputDir, relativePath);
  return dataUrl(await readFile(path));
}

function issueFromControl(
  control: ScanControl,
  behaviorContracts?: WorkflowOptions["behaviorContracts"]
): RepairIssue {
  return {
    controlId: control.id,
    pageUrl: control.pageUrl,
    selector: control.selector,
    label: control.text || control.ariaLabel || control.selector,
    verdict: control.verdict === "CRASHED" ? "CRASHED" : control.verdict === "AMBIGUOUS" ? "AMBIGUOUS" : "INERT",
    evidence: control.evidence,
    ...(behaviorContracts?.[control.id] ? { behaviorContract: behaviorContracts[control.id] } : {})
  };
}

function analysisCacheKey(pageUrl: string, controls: ScanControl[]): string {
  return createHash("sha256")
    .update(pageUrl)
    .update(
      JSON.stringify(
        controls.map((control) => ({
          id: control.id,
          verdict: control.verdict,
          signals: control.evidence.signals
        }))
      )
    )
    .digest("hex");
}

function patchOnlyResult(
  round: number,
  attempt: NonNullable<RepairAttemptRecord["attempt"]>,
  reason: string
): RepairLoopResult {
  return {
    status: "blocked",
    stopReason: reason,
    attempts: [{ round, attempt, decision: "rejected", reason }],
    evidenceStatus: "generated"
  };
}

function safeArtifactName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function profileScanOptions(profile: BusinessProfile | undefined): {
  storageState?: string;
  routes?: string[];
  networkMode?: NonNullable<BusinessProfile["networkMode"]>;
  replayHar?: string;
} {
  return {
    ...(profile?.storageState ? { storageState: profile.storageState } : {}),
    ...(profile?.routes ? { routes: profile.routes } : {}),
    ...(profile?.networkMode ? { networkMode: profile.networkMode } : {}),
    ...(profile?.replayHar ? { replayHar: profile.replayHar } : {})
  };
}

function scenarioForControl(
  controlId: string,
  selector: string | undefined,
  pageUrl: string,
  scenarios: WorkflowOptions["scenarios"]
): import("./types.js").ScenarioContract | undefined {
  if (!scenarios) return undefined;
  const route = `${new URL(pageUrl).pathname}${new URL(pageUrl).search}`;
  for (const scenario of Object.values(scenarios)) {
    const matchesTarget = scenario.target === selector ||
      scenario.target.includes(controlId) ||
      scenario.actions.some((action) => action.selector === selector || action.selector.includes(controlId));
    if (!matchesTarget) continue;
    return {
      ...scenario,
      route: scenario.route ?? route
    };
  }
  return undefined;
}

async function writeRegressionTest(outputDir: string, control: ScanControl): Promise<string> {
  const directory = join(outputDir, "repairs", safeArtifactName(control.id));
  const path = join(directory, "regression.spec.ts");
  const pageUrl = new URL(control.pageUrl);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path,
    buildInteractionRegressionTest({
      controlId: control.id,
      label: control.text || control.ariaLabel || control.id,
      route: `${pageUrl.pathname}${pageUrl.search}`,
      selector: control.selector
    })
  );
  return path;
}

async function requestPatchOnly(
  client: AIClient,
  issue: RepairIssue,
  projectRoot: string,
  outputDir: string,
  reason: string,
  suppliedSources?: SourceCandidate[]
): Promise<RepairLoopResult> {
  const sources = suppliedSources ?? (await locateSourceCandidates(projectRoot, issue));
  if (sources.length === 0) {
    return { status: "blocked", attempts: [], stopReason: "No credible source candidates found" };
  }
  const prompt = buildRepairPrompt({ issue, sources, round: 1, previousAttempts: [] });
  const images: string[] = [];
  for (const path of [issue.evidence.beforeScreenshot, issue.evidence.afterScreenshot]) {
    try {
      images.push(await imageFor(outputDir, path));
    } catch {
      // Text evidence remains sufficient for patch-only mode.
    }
  }
  const response = await client.repair({ prompt, imageDataUrls: images });
  const patchesDir = join(outputDir, "patches");
  await mkdir(patchesDir, { recursive: true });
  await writeFile(join(patchesDir, `${safeArtifactName(issue.controlId)}.diff`), response.attempt.patch);
  return patchOnlyResult(1, response.attempt, reason);
}

async function requestVerifiedPatchInWorktree(
  client: AIClient,
  issue: RepairIssue,
  projectRoot: string,
  outputDir: string,
  testCommand: string,
  images: boolean,
  devCommand: string | undefined,
  baselineWorking: Set<string>,
  interactionTimeoutMs: number,
  unsafe: boolean,
  profile: BusinessProfile | undefined,
  maxRounds: number,
  behaviorContracts: WorkflowOptions["behaviorContracts"],
  scenarios: WorkflowOptions["scenarios"],
  browsers: BrowserName[]
): Promise<RepairLoopResult> {
  const sources = await locateSourceCandidates(projectRoot, issue);
  if (sources.length === 0) {
    return { status: "blocked", attempts: [], stopReason: "No credible source candidates found", evidenceStatus: "failed" };
  }
  if (!isTrustedSourceCandidate(sources[0])) {
    return requestPatchOnly(
      client,
      issue,
      projectRoot,
      outputDir,
      "Deterministic source confidence is below the automatic verification threshold; generated patch only",
      sources
    );
  }

  const imageDataUrls = images
    ? await Promise.all(
        [issue.evidence.beforeScreenshot, issue.evidence.afterScreenshot].map((path) => imageFor(outputDir, path))
      )
    : [];
  const repairOutputDir = join(outputDir, "repairs", safeArtifactName(issue.controlId));
  const attempts: RepairAttemptRecord[] = [];
  const fingerprints = new Set<string>();
  let lastEvidenceStatus: RepairLoopResult["evidenceStatus"] = "failed";
  const boundedRounds = Math.min(Math.max(maxRounds, 1), 3);
  const baselineFailed = issue.selector
    ? !(await interactionChangesAfterClick({ url: issue.pageUrl, selector: issue.selector, timeoutMs: interactionTimeoutMs }))
    : false;

  for (let round = 1; round <= boundedRounds; round += 1) {
    const prompt = buildRepairPrompt({ issue, sources: sources.slice(0, 5), round, previousAttempts: attempts });
    const attempt = (await client.repair({ prompt, imageDataUrls })).attempt;
    if (attempt.risk === "high") {
      attempts.push({ round, attempt, decision: "rejected", reason: "High-risk patch requires manual review" });
      return { status: "blocked", attempts, stopReason: "Model produced a high-risk patch", evidenceStatus: lastEvidenceStatus };
    }
    const fingerprint = createHash("sha256").update(attempt.patch.trim()).digest("hex");
    if (fingerprints.has(fingerprint)) {
      attempts.push({ round, attempt, decision: "rejected", reason: "Repeated equivalent patch" });
      return { status: "blocked", attempts, stopReason: "Repair loop repeated an equivalent patch", evidenceStatus: lastEvidenceStatus };
    }
    fingerprints.add(fingerprint);

    const validation = await validatePatch(projectRoot, attempt.patch);
    if (!validation.ok) {
      attempts.push({
        round,
        attempt,
        validation,
        decision: "rejected",
        reason: validation.reason ?? "Patch validation failed"
      });
      continue;
    }

    const roundOutputDir = join(repairOutputDir, `round-${round}`);
    const session = await createWorktreeRepairSession({ projectRoot, outputDir: roundOutputDir });
    const verified = await session.verifyPatch({
      patch: attempt.patch,
      testCommand,
      ...(devCommand
        ? {
            devCommand,
            browsers,
            verifyUI: async (baseUrl: string, browserName: BrowserName) => {
              const originalUrl = new URL(issue.pageUrl);
              const verificationUrl = new URL(`${originalUrl.pathname}${originalUrl.search}`, baseUrl).href;
              const verificationDir = join(roundOutputDir, "ui-verification");
              const verification = await scanApplication({
                baseUrl: verificationUrl,
                outputDir: verificationDir,
                maxPages: 1,
                interactionTimeoutMs,
                unsafe,
                browserName,
                ...profileScanOptions(profile)
              });
              const currentControls = verification.pages[0]?.controls ?? [];
              const target = currentControls.find((candidate) => candidate.id === issue.controlId);
              const patchedPassed = issue.selector
                ? await interactionChangesAfterClick({
                    url: verificationUrl,
                    selector: issue.selector,
                    timeoutMs: interactionTimeoutMs,
                    browserName
                  })
                : false;
              const contract = behaviorContracts?.[issue.controlId];
              const scenario = scenarioForControl(issue.controlId, issue.selector, issue.pageUrl, scenarios);
              const behaviorContract = scenario
                ? await verifyScenarioContract({
                    baseUrl,
                    scenario,
                    timeoutMs: interactionTimeoutMs,
                    allowMutations: profile?.networkMode === "sandbox",
                    browserName
                  })
                : contract && issue.selector
                  ? await verifyBehaviorContract({
                      url: verificationUrl,
                      selector: issue.selector,
                      contract,
                      timeoutMs: interactionTimeoutMs,
                      allowMutations: profile?.networkMode === "sandbox",
                      browserName
                    })
                  : undefined;
              const regressions = currentControls
                .filter((candidate) => baselineWorking.has(candidate.id) && candidate.verdict !== "WORKS")
                .map((candidate) => candidate.id);
              return {
                targetWorks: target?.verdict === "WORKS" && baselineFailed && patchedPassed && (behaviorContract?.passed ?? true),
                regressions,
                ...(target ? { evidence: target.evidence } : {})
                ,
                counterfactual: { baselineFailed, patchedPassed },
                ...(behaviorContract ? { behaviorContract } : {})
              };
            }
          }
        : {})
    });
    lastEvidenceStatus = verified.evidenceStatus;
    const record: RepairAttemptRecord = {
      round,
      attempt,
      validation,
      tests: verified.tests,
      ...(verified.ui ? { ui: verified.ui } : {}),
      decision: verified.ok ? "accepted" : "rolled-back",
      reason: verified.ok
        ? "Patch verified in an isolated worktree; current checkout was not modified"
        : verified.reason ?? "Patch failed in an isolated worktree"
    };
    attempts.push(record);

    if (verified.ok) {
      if (verified.verifiedDiffPath) {
        await mkdir(repairOutputDir, { recursive: true });
        await copyFile(verified.verifiedDiffPath, join(repairOutputDir, "verified.diff"));
      }
      return {
        status: verified.evidenceStatus === "ui-verified" ? "fixed" : "blocked",
        attempts,
        evidenceStatus: verified.evidenceStatus,
        ...(verified.ui?.counterfactual?.baselineFailed && verified.ui.counterfactual.patchedPassed
          ? { counterfactualVerified: true }
          : {}),
        stopReason: verified.evidenceStatus === "ui-verified"
          ? "Patch UI-verified in an isolated worktree; current checkout was not modified"
          : "Patch test-verified in an isolated worktree; UI verification was not completed"
      };
    }
  }

  return {
    status: "exhausted",
    attempts,
    evidenceStatus: lastEvidenceStatus,
    stopReason: `Reached the ${boundedRounds}-round isolated worktree limit`
  };
}

async function analyzePages(
  client: AIClient,
  scan: ScanResult,
  outputDir: string,
  images: boolean
): Promise<AIPageAssessment[]> {
  const assessments: AIPageAssessment[] = [];
  for (const page of scan.pages) {
    const controls = page.controls.filter(
      (control) =>
        control.verdict !== "SKIPPED" &&
        control.verdict !== "BLOCKED_MUTATION" &&
        control.verdict !== "BACKEND_ERROR" &&
        control.verdict !== "AUTH_REQUIRED" &&
        control.verdict !== "RATE_LIMITED" &&
        control.verdict !== "NETWORK_ERROR"
    );
    if (controls.length === 0) continue;
    const imageDataUrl = images ? await imageFor(outputDir, page.screenshot) : undefined;
    assessments.push(
      await client.analyzeControls({
        pageUrl: page.url,
        controls: controls.map((control) => ({
          id: control.id,
          label: redactSensitiveText(control.text || control.ariaLabel || control.selector),
          verdict: control.verdict,
          signals: control.evidence.signals.map((signal) => redactSensitiveText(`${signal.type}: ${signal.detail}`))
        })),
        cacheKey: analysisCacheKey(page.url, controls),
        ...(imageDataUrl ? { imageDataUrl } : {})
      })
    );
  }
  return assessments;
}

async function runButtonProbeInner(options: WorkflowOptions): Promise<WorkflowResult> {
  const outputDir = resolve(options.outputDir);
  const projectRoot = resolve(options.projectRoot);
  const initialWorkspace = options.fix ? await inspectGitWorkspace(projectRoot) : undefined;
  await mkdir(outputDir, { recursive: true });

  let scan = await scanApplication({
    baseUrl: options.baseUrl,
    outputDir,
    maxPages: options.maxPages,
    interactionTimeoutMs: options.interactionTimeoutMs,
    unsafe: options.unsafe,
    ...profileScanOptions(options.profile)
  });
  const assessments: AIPageAssessment[] = [];
  const repairs: Array<{ controlId: string; result: RepairLoopResult; sourceCandidates?: SourceCandidateEvidence[] }> = [];
  let aiError: string | undefined;

  let client: AIClient | undefined;
  if (options.ai) {
    if (!options.apiBaseUrl || !options.model) {
      throw new Error("AI mode requires BUTTONPROBE_BASE_URL and BUTTONPROBE_MODEL");
    }
    client = new AIClient({
      ...(options.provider ? { provider: options.provider } : {}),
      baseUrl: options.apiBaseUrl,
      model: options.model,
      cacheDir: join(outputDir, "cache"),
      ...(options.analysisModel ? { analysisModel: options.analysisModel } : {}),
      ...(options.repairModel ? { repairModel: options.repairModel } : {}),
      analyzeMaxTokens: options.analyzeMaxTokens ?? 1200,
      repairMaxTokens: options.repairMaxTokens ?? 3000,
      maxModelCalls: options.maxModelCalls ?? 14,
      ...(options.apiKey ? { apiKey: options.apiKey } : {})
    });
    try {
      assessments.push(...(await analyzePages(client, scan, outputDir, options.images)));
    } catch (error) {
      aiError = (error as Error).message;
    }
  }

  if (options.fix) {
    if (!client) throw new Error("Fix mode requires AI configuration");
    const workspace = initialWorkspace ?? (await inspectGitWorkspace(projectRoot));
    const canApply = workspace.isRepository && workspace.clean && Boolean(options.testCommand);
    const blockedReason = !workspace.isRepository
      ? "Not a Git repository; generated patch was not applied"
      : !workspace.clean
        ? "Git worktree is dirty; generated patch was not applied"
        : !options.testCommand
          ? "No --test-command was provided; generated patch was not applied"
          : "";
    const issues = scan.pages
      .flatMap((page) => page.controls)
      .filter(
        (control): control is ScanControl & { verdict: "INERT" | "CRASHED" | "AMBIGUOUS" } =>
          control.verdict === "INERT" || control.verdict === "CRASHED" || control.verdict === "AMBIGUOUS"
      )
      .slice(0, options.maxFixIssues ?? 3);

    for (const control of issues) {
      const issue = issueFromControl(control, options.behaviorContracts);
      const baselinePage = scan.pages.find((page) => page.url === issue.pageUrl);
      const baselineWorking = new Set(
        baselinePage?.controls.filter((candidate) => candidate.verdict === "WORKS").map((candidate) => candidate.id) ?? []
      );
      if (!canApply) {
        try {
          repairs.push({
            controlId: control.id,
            result: await requestPatchOnly(client, issue, projectRoot, outputDir, blockedReason)
          });
        } catch (error) {
          repairs.push({
            controlId: control.id,
            result: { status: "blocked", attempts: [], stopReason: (error as Error).message, evidenceStatus: "failed" }
          });
        }
        continue;
      }

      if (!options.apply) {
        try {
          const result = await requestVerifiedPatchInWorktree(
            client,
            issue,
            projectRoot,
            outputDir,
            options.testCommand!,
            options.images,
            options.devCommand,
            baselineWorking,
            options.interactionTimeoutMs,
            options.unsafe,
            options.profile,
            options.maxRounds,
            options.behaviorContracts,
            options.scenarios,
            options.browsers ?? ["chromium"]
          );
          if (result.evidenceStatus === "ui-verified") {
            result.regressionTestPath = await writeRegressionTest(outputDir, control);
          }
          repairs.push({
            controlId: control.id,
            result
          });
        } catch (error) {
          repairs.push({
            controlId: control.id,
            result: { status: "blocked", attempts: [], stopReason: (error as Error).message, evidenceStatus: "failed" }
          });
        }
        continue;
      }

      const applySources = await locateSourceCandidates(projectRoot, issue);
      if (!isTrustedSourceCandidate(applySources[0])) {
        repairs.push({
          controlId: control.id,
          result: await requestPatchOnly(
            client,
            issue,
            projectRoot,
            outputDir,
            "Deterministic source confidence is below the automatic verification threshold; generated patch only",
            applySources
          )
        });
        continue;
      }
      const baselineFailed = issue.selector
        ? !(await interactionChangesAfterClick({
            url: issue.pageUrl,
            selector: issue.selector,
            timeoutMs: options.interactionTimeoutMs
          }))
        : false;
      const result = await runRepairLoop(
        issue,
        {
          locateSources: (target) => locateSourceCandidates(projectRoot, target),
          requestRepair: async (context) => {
            const prompt = buildRepairPrompt(context);
            const imageDataUrls = options.images
              ? await Promise.all(
                  [issue.evidence.beforeScreenshot, issue.evidence.afterScreenshot].map((path) =>
                    imageFor(outputDir, path)
                  )
                )
              : [];
            return (await client.repair({ prompt, imageDataUrls })).attempt;
          },
          validatePatch: (patch) => validatePatch(projectRoot, patch),
          applyPatch: (patch) => applyPatch(projectRoot, patch),
          rollbackPatch: (patch) => rollbackPatch(projectRoot, patch),
          runTests: () => runTestCommand(projectRoot, options.testCommand!),
          verifyUI: async () => {
            const verificationDir = join(outputDir, "verification", control.id);
            const verification = await scanApplication({
              baseUrl: issue.pageUrl,
              outputDir: verificationDir,
              maxPages: 1,
              interactionTimeoutMs: options.interactionTimeoutMs,
              unsafe: options.unsafe,
              ...profileScanOptions(options.profile)
            });
            const currentControls = verification.pages[0]?.controls ?? [];
            const target = currentControls.find((candidate) => candidate.id === control.id);
            const patchedPassed = issue.selector
              ? await interactionChangesAfterClick({
                  url: issue.pageUrl,
                  selector: issue.selector,
                  timeoutMs: options.interactionTimeoutMs
                })
              : false;
            const contract = options.behaviorContracts?.[issue.controlId];
            const scenario = scenarioForControl(issue.controlId, issue.selector, issue.pageUrl, options.scenarios);
            const behaviorContract = scenario
              ? await verifyScenarioContract({
                  baseUrl: options.baseUrl,
                  scenario,
                  timeoutMs: options.interactionTimeoutMs,
                  allowMutations: options.profile?.networkMode === "sandbox"
                })
              : contract && issue.selector
                ? await verifyBehaviorContract({
                    url: issue.pageUrl,
                    selector: issue.selector,
                    contract,
                    timeoutMs: options.interactionTimeoutMs,
                    allowMutations: options.profile?.networkMode === "sandbox"
                  })
                : undefined;
            const regressions = currentControls
              .filter((candidate) => baselineWorking.has(candidate.id) && candidate.verdict !== "WORKS")
              .map((candidate) => candidate.id);
            return {
              targetWorks: target?.verdict === "WORKS" && baselineFailed && patchedPassed && (behaviorContract?.passed ?? true),
              regressions,
              ...(target ? { evidence: target.evidence } : {}),
              counterfactual: { baselineFailed, patchedPassed },
              ...(behaviorContract ? { behaviorContract } : {})
            };
          }
        },
        { maxRounds: options.maxRounds }
      );
      result.evidenceStatus = result.status === "fixed" ? "ui-verified" : "failed";
      if (result.evidenceStatus === "ui-verified") {
        const accepted = result.attempts.find((attempt) => attempt.decision === "accepted");
        if (accepted?.ui?.counterfactual?.baselineFailed && accepted.ui.counterfactual.patchedPassed) {
          result.counterfactualVerified = true;
        }
        result.regressionTestPath = await writeRegressionTest(outputDir, control);
      }
      repairs.push({ controlId: control.id, result });
    }

    if (repairs.some((repair) => repair.result.status === "fixed")) {
      scan = await scanApplication({
        baseUrl: options.baseUrl,
        outputDir,
        maxPages: options.maxPages,
        interactionTimeoutMs: options.interactionTimeoutMs,
        unsafe: options.unsafe,
        ...profileScanOptions(options.profile)
      });
    }
  }

  for (const repair of repairs) {
    const control = scan.pages.flatMap((page) => page.controls).find((candidate) => candidate.id === repair.controlId);
    if (!control) continue;
    repair.sourceCandidates = (await locateSourceCandidates(projectRoot, issueFromControl(control, options.behaviorContracts))).map((candidate) => ({
      path: candidate.path,
      ...(candidate.score !== undefined ? { score: candidate.score } : {}),
      ...(candidate.reason !== undefined ? { reason: candidate.reason } : {}),
      ...(candidate.strongIdentity !== undefined ? { strongIdentity: candidate.strongIdentity } : {}),
      ...(candidate.eventChain !== undefined ? { eventChain: candidate.eventChain } : {})
    }));
  }
  const usageSummary: AIUsageSummary = client?.getUsageSummary() ?? {
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
    cacheHits: 0,
    cacheMisses: 0,
    events: []
  };
  const sourceFiles = new Set<string>();
  for (const repair of repairs) {
    for (const candidate of repair.sourceCandidates ?? []) sourceFiles.add(candidate.path);
  }
  const modelDataManifest: ModelDataManifest = {
    endpointHost: options.apiBaseUrl ? new URL(options.apiBaseUrl).host : "none",
    sourceFiles: [...sourceFiles].sort(),
    screenshotCount: options.images
      ? assessments.length + usageSummary.events.filter((event) => event.kind === "repair" && !event.cached && event.success).length * 2
      : 0,
    redactionApplied: true
  };
  const finalWorkspace = await inspectGitWorkspace(projectRoot);
  const originalCheckoutModified = initialWorkspace
    ? finalWorkspace.status !== initialWorkspace.status
    : false;

  const reportPath = await writeReport(outputDir, scan, {
    assessments,
    repairs,
    usageSummary,
    modelDataManifest,
    originalCheckoutModified,
    ...(aiError ? { aiError } : {})
  });
  await writeFile(join(outputDir, "scan.json"), JSON.stringify(scan, null, 2));
  await writeFile(
    join(outputDir, "repairs.json"),
    JSON.stringify({ schemaVersion: 1, repairs, usageSummary, modelDataManifest }, null, 2)
  );
  return {
    reportPath,
    scan,
    assessments,
    repairs,
    usageSummary,
    modelDataManifest,
    ...(aiError ? { aiError } : {})
  };
}

async function runProfileCommand(command: string, projectRoot: string, stage: "setup" | "reset"): Promise<void> {
  const result = await runCommand(command, [], { cwd: projectRoot, shell: true, timeoutMs: 120_000 });
  if (result.code !== 0) {
    const output = `${result.stdout}${result.stderr}`.trim().slice(-2_000);
    throw new Error(`Profile ${stage} command failed${output ? `: ${output}` : ""}`);
  }
}

export async function runButtonProbe(options: WorkflowOptions): Promise<WorkflowResult> {
  const profile = options.profile;
  if (profile?.networkMode === "sandbox" && !profile.resetCommand) {
    throw new Error("Sandbox profiles require an explicit resetCommand");
  }
  if (profile?.networkMode === "replay" && !profile.replayHar) {
    throw new Error("Replay profiles require a replayHar file");
  }
  if (profile?.setupCommand) await runProfileCommand(profile.setupCommand, options.projectRoot, "setup");
  try {
    return await runButtonProbeInner(options);
  } finally {
    if (profile?.resetCommand) await runProfileCommand(profile.resetCommand, options.projectRoot, "reset");
  }
}
