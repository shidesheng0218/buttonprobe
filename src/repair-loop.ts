import { createHash } from "node:crypto";
import type {
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
        reason: "High-risk patch requires manual review"
      });
      return { status: "blocked", attempts, stopReason: "Model produced a high-risk patch" };
    }

    const currentFingerprint = fingerprint(attempt.patch);
    if (patchFingerprints.has(currentFingerprint)) {
      attempts.push({
        round,
        attempt,
        decision: "rejected",
        reason: "Repeated equivalent patch"
      });
      return { status: "blocked", attempts, stopReason: "Repair loop repeated an equivalent patch" };
    }
    patchFingerprints.add(currentFingerprint);

    const validation = await dependencies.validatePatch(attempt.patch);
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

    await dependencies.applyPatch(attempt.patch);
    const tests = await dependencies.runTests();
    if (!tests.passed) {
      await dependencies.rollbackPatch(attempt.patch);
      attempts.push({
        round,
        attempt,
        validation,
        tests,
        decision: "rolled-back",
        reason: "Test command failed"
      });
      continue;
    }

    const ui = await dependencies.verifyUI(issue);
    if (!ui.targetWorks || ui.regressions.length > 0) {
      await dependencies.rollbackPatch(attempt.patch);
      attempts.push({
        round,
        attempt,
        validation,
        tests,
        ui,
        decision: "rolled-back",
        reason: ui.regressions.length > 0 ? "UI regressions detected" : "Target behavior did not improve"
      });
      continue;
    }

    attempts.push({
      round,
      attempt,
      validation,
      tests,
      ui,
      decision: "accepted",
      reason: "Tests and UI verification passed"
    });
    return { status: "fixed", attempts, stopReason: "Target control works without regressions" };
  }

  return { status: "exhausted", attempts, stopReason: `Reached the ${maxRounds}-round limit` };
}
