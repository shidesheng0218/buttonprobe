import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { applyPatch, inspectGitWorkspace } from "./git-workspace.js";
import { verifyScenarioContract } from "./behavior-contract.js";
import { interactionChangesAfterClick } from "./regression-test.js";
import { writeReport } from "./report.js";
import { scanApplication } from "./scanner.js";
import { createWorktreeRepairSession } from "./worktree-repair.js";
import type {
  AIUsageSummary,
  BusinessProfile,
  ProofStatus,
  RepairAttemptRecord,
  RepairLoopResult,
  ScanControl,
  BrowserName,
  UIVerification
} from "./types.js";

export interface PatchVerificationOptions {
  baseUrl: string;
  patchPath?: string;
  patchUrl?: string;
  projectRoot: string;
  outputDir: string;
  testCommand: string;
  devCommand?: string;
  interactionTimeoutMs?: number;
  unsafe?: boolean;
  apply?: boolean;
  profile?: BusinessProfile;
  scenarios?: Record<string, import("./types.js").ScenarioContract>;
  browsers?: Array<"chromium" | "firefox" | "webkit">;
  targetSelector?: string;
  workingDirectory?: string;
}

export interface PatchProofResult {
  status: ProofStatus;
  proofPath: string;
  reportPath: string;
  verifiedDiffPath?: string;
  reason: string;
  originalCheckoutModified: boolean;
  usageSummary: AIUsageSummary;
  ui?: UIVerification;
}

export interface PatchInput {
  source: string;
  content: string;
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

function firstTarget(controls: ScanControl[], targetSelector?: string): ScanControl | undefined {
  const failing = controls.filter((control) => control.verdict === "INERT" || control.verdict === "CRASHED" || control.verdict === "AMBIGUOUS");
  if (!targetSelector) return failing[0];
  return failing.find((control) => control.selector === targetSelector || control.id === targetSelector);
}

function scenarioForControl(
  controlId: string,
  selector: string,
  pageUrl: string,
  scenarios: PatchVerificationOptions["scenarios"]
): import("./types.js").ScenarioContract | undefined {
  if (!scenarios) return undefined;
  const route = `${new URL(pageUrl).pathname}${new URL(pageUrl).search}`;
  for (const scenario of Object.values(scenarios)) {
    const matchesTarget = scenario.target === selector ||
      scenario.target.includes(controlId) ||
      scenario.actions.some((action) => action.selector === selector || action.selector.includes(controlId));
    if (matchesTarget) return { ...scenario, route: scenario.route ?? route };
  }
  return undefined;
}

function proofUsage(): AIUsageSummary {
  return {
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
    cacheHits: 0,
    cacheMisses: 0,
    estimatedCostUsd: 0,
    events: []
  };
}

function looksLikeUnifiedDiff(value: string): boolean {
  return /^diff --git /m.test(value) || /^---\s+(?:a\/|\S)/m.test(value) && /^\+\+\+\s+(?:b\/|\S)/m.test(value);
}

export async function loadPatchInput(options: { patchPath?: string; patchUrl?: string }): Promise<PatchInput> {
  if (options.patchPath && options.patchUrl) {
    throw new Error("Use either --patch or --patch-url, not both");
  }
  if (!options.patchPath && !options.patchUrl) {
    throw new Error("buttonprobe verify requires --patch or --patch-url");
  }
  if (options.patchUrl) {
    const url = new URL(options.patchUrl);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
      throw new Error("--patch-url must use https or localhost");
    }
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download patch URL: HTTP ${response.status}`);
    const content = await response.text();
    if (!looksLikeUnifiedDiff(content)) throw new Error("Patch URL did not return a unified diff");
    return { source: url.href, content };
  }
  const source = resolve(options.patchPath!);
  const content = await readFile(source, "utf8");
  if (!looksLikeUnifiedDiff(content)) throw new Error("Patch file must contain a unified diff");
  return { source, content };
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

function resolveArtifactPath(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path);
}

export async function validateProofArtifacts(proofPath: string, artifactRoot = dirname(proofPath)): Promise<void> {
  const proof = JSON.parse(await readFile(proofPath, "utf8")) as {
    reportPath?: string;
    verifiedDiffPath?: string;
    ui?: UIVerification;
  };
  const required = [proofPath, proof.reportPath, proof.verifiedDiffPath].filter(Boolean) as string[];
  for (const browser of proof.ui?.browsers ?? []) {
    if (browser.screenshot) required.push(join("ui-verification", browser.screenshot));
  }
  if (proof.ui?.evidence?.beforeScreenshot) required.push(join("ui-verification", proof.ui.evidence.beforeScreenshot));
  if (proof.ui?.evidence?.afterScreenshot) required.push(join("ui-verification", proof.ui.evidence.afterScreenshot));
  for (const artifact of required) {
    const candidate = resolveArtifactPath(artifactRoot, artifact);
    if (!(await exists(candidate))) {
      throw new Error(`Missing proof artifact: ${artifact}`);
    }
  }
}

export async function runPatchVerification(options: PatchVerificationOptions): Promise<PatchProofResult> {
  const outputDir = resolve(options.outputDir);
  const projectRoot = resolve(options.projectRoot);
  const interactionTimeoutMs = options.interactionTimeoutMs ?? 750;
  await mkdir(outputDir, { recursive: true });

  const workspaceBefore = await inspectGitWorkspace(projectRoot);
  if (!workspaceBefore.isRepository) throw new Error("buttonprobe verify requires a Git repository");
  if (options.apply && !workspaceBefore.clean) throw new Error("--apply requires a clean Git worktree");

  const patchInput = await loadPatchInput({
    ...(options.patchPath ? { patchPath: options.patchPath } : {}),
    ...(options.patchUrl ? { patchUrl: options.patchUrl } : {})
  });
  const patch = patchInput.content;
  const baseline = await scanApplication({
    baseUrl: options.baseUrl,
    outputDir: join(outputDir, "baseline"),
    maxPages: 1,
    interactionTimeoutMs,
    unsafe: options.unsafe ?? false,
    ...profileScanOptions(options.profile)
  });
  const baselineControls = baseline.pages[0]?.controls ?? [];
  const target = firstTarget(baselineControls, options.targetSelector);
  const baselineWorking = new Set(
    baselineControls.filter((control) => control.verdict === "WORKS").map((control) => control.id)
  );
  const attempts: RepairAttemptRecord[] = [];
  let status: ProofStatus = "patch-generated";
  let reason = "Patch was generated but not verified";
  let ui: UIVerification | undefined;
  let verifiedDiffPath: string | undefined;

  if (!target) {
    status = "rejected";
    reason = "No failing target control was found in the baseline scan";
  } else {
    const baselineFailed = !(await interactionChangesAfterClick({
      url: target.pageUrl,
      selector: target.selector,
      timeoutMs: interactionTimeoutMs
    }));
    const session = await createWorktreeRepairSession({
      projectRoot,
      outputDir,
      ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {})
    });
    const verified = await session.verifyPatch({
      patch,
      testCommand: options.testCommand,
      ...(options.devCommand
        ? {
            devCommand: options.devCommand,
            browsers: options.browsers ?? ["chromium"],
            verifyUI: async (baseUrl: string, browserName: BrowserName) => {
              const originalUrl = new URL(target.pageUrl);
              const verificationUrl = new URL(`${originalUrl.pathname}${originalUrl.search}`, baseUrl).href;
              const verification = await scanApplication({
                baseUrl: verificationUrl,
                outputDir: join(outputDir, "ui-verification"),
                maxPages: 1,
                interactionTimeoutMs,
                unsafe: options.unsafe ?? false,
                browserName,
                ...profileScanOptions(options.profile)
              });
              const currentControls = verification.pages[0]?.controls ?? [];
              const patchedTarget = currentControls.find((control) => control.id === target.id);
              const patchedPassed = await interactionChangesAfterClick({
                url: verificationUrl,
                selector: target.selector,
                timeoutMs: interactionTimeoutMs,
                browserName
              });
              const scenario = scenarioForControl(target.id, target.selector, target.pageUrl, options.scenarios);
              const behaviorContract = scenario
                ? await verifyScenarioContract({
                    baseUrl,
                    scenario,
                    timeoutMs: interactionTimeoutMs,
                    allowMutations: options.profile?.networkMode === "sandbox",
                    browserName
                  })
                : undefined;
              const regressions = currentControls
                .filter((control) => baselineWorking.has(control.id) && control.verdict !== "WORKS")
                .map((control) => control.id);
              return {
                targetWorks: patchedTarget?.verdict === "WORKS" && baselineFailed && patchedPassed && (behaviorContract?.passed ?? true),
                regressions,
                ...(patchedTarget ? { evidence: patchedTarget.evidence } : {}),
                counterfactual: { baselineFailed, patchedPassed },
                ...(behaviorContract ? { behaviorContract } : {})
              };
            }
          }
        : {})
    });
    verifiedDiffPath = verified.verifiedDiffPath;
    ui = verified.ui;
    status = verified.evidenceStatus === "ui-verified"
      ? "ui-verified"
      : verified.evidenceStatus === "test-verified"
        ? "test-verified"
        : verified.tests.command === "git apply"
          ? "rejected"
          : "patch-applies";
    if (!verified.ok && verified.ui) status = "rejected";
    reason = verified.reason ??
      (verified.ok
        ? "Patch verified in an isolated worktree; current checkout was not modified"
        : "Patch was rejected in isolated verification");
    attempts.push({
      round: 1,
      tests: verified.tests,
      ...(verified.ui ? { ui: verified.ui } : {}),
      decision: verified.ok ? "accepted" : "rejected",
      reason
    });
    if (verified.ok && verified.evidenceStatus === "ui-verified" && options.apply && verified.verifiedDiffPath) {
      await applyPatch(projectRoot, patch);
      reason = "Patch was UI-verified and applied to the current checkout";
    }
  }

  if (verifiedDiffPath) {
    await copyFile(verifiedDiffPath, join(outputDir, "verified.diff")).catch(() => undefined);
    verifiedDiffPath = join(outputDir, "verified.diff");
  }

  const usageSummary = proofUsage();
  const repairResult: RepairLoopResult = {
    status: status === "ui-verified" ? "fixed" : "blocked",
    stopReason: reason,
    attempts,
    evidenceStatus: status === "ui-verified" ? "ui-verified" : status === "test-verified" ? "test-verified" : "failed",
    ...(ui?.counterfactual?.baselineFailed && ui.counterfactual.patchedPassed ? { counterfactualVerified: true } : {})
  };
  const workspaceAfter = await inspectGitWorkspace(projectRoot);
  const originalCheckoutModified = options.apply
    ? !workspaceAfter.clean
    : workspaceAfter.status !== workspaceBefore.status;
  const reportPath = await writeReport(outputDir, baseline, {
    assessments: [],
    repairs: target ? [{ controlId: target.id, result: repairResult }] : [],
    usageSummary,
    modelDataManifest: {
      endpointHost: "none",
      sourceFiles: [],
      screenshotCount: 0,
      redactionApplied: true
    },
    originalCheckoutModified,
    ...(ui?.browsers ? { browsers: ui.browsers } : {}),
    artifacts: {
      ...(verifiedDiffPath ? { verifiedDiff: verifiedDiffPath } : {}),
      proof: join(outputDir, "proof.json"),
      screenshots: baselineControls.flatMap((control) => [
        join(outputDir, "baseline", control.evidence.beforeScreenshot),
        join(outputDir, "baseline", control.evidence.afterScreenshot)
      ])
    }
  });
  const proofPath = join(outputDir, "proof.json");
  const proof = {
    schemaVersion: 1,
    status,
    reason,
    baseUrl: options.baseUrl,
    patchSource: patchInput.source,
    verifiedDiffPath,
    testCommand: options.testCommand,
    devCommand: options.devCommand,
    browsers: options.browsers ?? ["chromium"],
    originalCheckoutModified,
    usageSummary,
    ui,
    reportPath
  };
  await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
  await validateProofArtifacts(proofPath, outputDir);
  return {
    status,
    proofPath,
    reportPath,
    ...(verifiedDiffPath ? { verifiedDiffPath } : {}),
    reason,
    originalCheckoutModified,
    usageSummary,
    ...(ui ? { ui } : {})
  };
}
