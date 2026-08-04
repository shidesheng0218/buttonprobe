import { describe, expect, test, vi } from "vitest";
import { runRepairLoop } from "../src/repair-loop.js";
import type { RepairAttempt, RepairDependencies, RepairIssue } from "../src/types.js";

const issue: RepairIssue = {
  controlId: "button-1",
  pageUrl: "http://localhost:3000",
  label: "Increment",
  verdict: "INERT",
  evidence: {
    beforeScreenshot: "before.png",
    afterScreenshot: "after.png",
    signals: []
  }
};

function dependencies(overrides: Partial<RepairDependencies> = {}): RepairDependencies {
  return {
    locateSources: vi.fn(async () => [{ path: "src/App.tsx", content: "export function App() {}" }]),
    requestRepair: vi.fn(async (): Promise<RepairAttempt> => ({
      diagnosis: "Missing click behavior",
      sourceConfidence: 0.9,
      expectedOutcome: "Increment",
      patch: "patch-1",
      affectedControls: ["button-1"],
      risk: "low"
    })),
    validatePatch: vi.fn(async () => ({ ok: true, files: ["src/App.tsx"], changedLines: 2 })),
    applyPatch: vi.fn(async () => undefined),
    rollbackPatch: vi.fn(async () => undefined),
    runTests: vi.fn(async () => ({ passed: true, command: "npm test", output: "ok" })),
    verifyUI: vi.fn(async () => ({ targetWorks: true, regressions: [] })),
    ...overrides
  };
}

describe("runRepairLoop", () => {
  test("accepts a patch only after tests and UI verification pass", async () => {
    const deps = dependencies();
    const result = await runRepairLoop(issue, deps, { maxRounds: 3 });

    expect(result.status).toBe("fixed");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.decision).toBe("accepted");
    expect(deps.rollbackPatch).not.toHaveBeenCalled();
  });

  test("rolls back a failing patch and retries up to three rounds", async () => {
    const deps = dependencies({
      runTests: vi
        .fn()
        .mockResolvedValueOnce({ passed: false, command: "npm test", output: "failed one" })
        .mockResolvedValueOnce({ passed: false, command: "npm test", output: "failed two" })
        .mockResolvedValueOnce({ passed: false, command: "npm test", output: "failed three" }),
      requestRepair: vi.fn(async ({ round }): Promise<RepairAttempt> => ({
        diagnosis: `Attempt ${round}`,
        sourceConfidence: 0.9,
        expectedOutcome: "Increment",
        patch: `patch-${round}`,
        affectedControls: ["button-1"],
        risk: "low"
      }))
    });

    const result = await runRepairLoop(issue, deps, { maxRounds: 3 });

    expect(result.status).toBe("exhausted");
    expect(result.attempts).toHaveLength(3);
    expect(deps.rollbackPatch).toHaveBeenCalledTimes(3);
  });

  test("rejects high-risk patches without applying them", async () => {
    const deps = dependencies({
      requestRepair: vi.fn(async (): Promise<RepairAttempt> => ({
        diagnosis: "Rewrite the app",
        sourceConfidence: 0.9,
        expectedOutcome: "Increment",
        patch: "patch",
        affectedControls: ["button-1"],
        risk: "high"
      }))
    });

    const result = await runRepairLoop(issue, deps, { maxRounds: 3 });

    expect(result.status).toBe("blocked");
    expect(deps.applyPatch).not.toHaveBeenCalled();
  });
});
