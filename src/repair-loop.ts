import { createHash } from "node:crypto";
import type {
  RepairAttempt,
  RepairAttemptRecord,
  RepairDependencies,
  RepairIssue,
  RepairLoopResult
} from "./types.js";

export interface RepairLoopOptions {
  maxRounds?: number;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value.trim()).digest("hex");
}

interface EvaluatedAttempt {
  record: RepairAttemptRecord;
  accepted: boolean;
}

async function evaluatePatchAttempt(
  dependencies: RepairDependencies,
  issue: RepairIssue,
  attempt: RepairAttempt,
  round: number,
  meta: Pick<RepairAttemptRecord, "patchSource" | "templateId" | "templateFallback">
): Promise<EvaluatedAttempt> {
  const validation = await dependencies.validatePatch(attempt.patch);
  if (!validation.ok) {
    return {
      accepted: false,
      record: {
        round,
        attempt,
        validation,
        decision: "rejected",
        reason: validation.reason ?? "Patch validation failed",
        ...meta
      }
    };
  }

  await dependencies.applyPatch(attempt.patch);
  const tests = await dependencies.runTests();
  if (!tests.passed) {
    await dependencies.rollbackPatch(attempt.patch);
    return {
      accepted: false,
      record: {
        round,
        attempt,
        validation,
        tests,
        decision: "rolled-back",
        reason: meta.patchSource === "template" ? "Template patch failed the test gate" : "Test command failed",
        ...meta
      }
    };
  }

  const ui = await dependencies.verifyUI(issue);
  if (!ui.targetWorks || ui.regressions.length > 0) {
    await dependencies.rollbackPatch(attempt.patch);
    return {
      accepted: false,
      record: {
        round,
        attempt,
        validation,
        tests,
        ui,
        decision: "rolled-back",
        reason: ui.regressions.length > 0 ? "UI regressions detected" : "Target behavior did not improve",
        ...meta
      }
    };
  }

  return {
    accepted: true,
    record: {
      round,
      attempt,
      validation,
      tests,
      ui,
      decision: "accepted",
      reason:
        meta.patchSource === "template"
          ? "Deterministic template patch passed tests and UI verification with 0 model calls"
          : "Tests and UI verification passed",
      ...meta
    }
  };
}

export async function runRepairLoop(
  issue: RepairIssue,
  dependencies: RepairDependencies,
  options: RepairLoopOptions = {}
): Promise<RepairLoopResult> {
  const maxRounds = Math.min(Math.max(options.maxRounds ?? 3, 1), 3);
  const attempts: RepairAttemptRecord[] = [];
  const patchFingerprints = new Set<string>();
  const sources = await dependencies.locateSources(issue);

  if (sources.length === 0) {
    return { status: "blocked", attempts, stopReason: "No credible source candidates found" };
  }

  let templateFailed = false;
  if (dependencies.templateRepair) {
    const proposal = await dependencies.templateRepair(issue, sources);
    if (proposal) {
      patchFingerprints.add(fingerprint(proposal.attempt.patch));
      const evaluated = await evaluatePatchAttempt(dependencies, issue, proposal.attempt, 0, {
        patchSource: "template",
        templateId: proposal.templateId
      });
      attempts.push(evaluated.record);
      if (evaluated.accepted) {
        return {
          status: "fixed",
          attempts,
          stopReason: "Deterministic template patch verified without model calls"
        };
      }
      templateFailed = true;
    }
  }

  for (let round = 1; round <= maxRounds; round += 1) {
    const attempt = await dependencies.requestRepair({
      issue,
      sources: sources.slice(0, 5),
      round,
      previousAttempts: attempts
    });

    if (attempt.risk === "high") {
      attempts.push({
        round,
        attempt,
        decision: "rejected",
        reason: "High-risk patch requires manual review",
        patchSource: "model",
        ...(templateFailed ? { templateFallback: true } : {})
      });
      return { status: "blocked", attempts, stopReason: "Model produced a high-risk patch" };
    }

    const currentFingerprint = fingerprint(attempt.patch);
    if (patchFingerprints.has(currentFingerprint)) {
      attempts.push({
        round,
        attempt,
        decision: "rejected",
        reason: "Repeated equivalent patch",
        patchSource: "model",
        ...(templateFailed ? { templateFallback: true } : {})
      });
      return { status: "blocked", attempts, stopReason: "Repair loop repeated an equivalent patch" };
    }
    patchFingerprints.add(currentFingerprint);

    const evaluated = await evaluatePatchAttempt(dependencies, issue, attempt, round, {
      patchSource: "model",
      ...(templateFailed ? { templateFallback: true } : {})
    });
    attempts.push(evaluated.record);
    if (evaluated.accepted) {
      return { status: "fixed", attempts, stopReason: "Target control works without regressions" };
    }
    if (evaluated.record.decision === "rejected") continue;
  }

  return { status: "exhausted", attempts, stopReason: `Reached the ${maxRounds}-round limit` };
}
