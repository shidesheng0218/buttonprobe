import { expect, test } from "vitest";
import { mutationReleaseGatePassed, validateMutationManifest, type MutationManifest } from "../src/mutation-eval.js";

test("requires explicit commands and expectation evidence for external mutation cases", () => {
  expect(() => validateMutationManifest({ cases: [{
    name: "save",
    target: ".",
    selector: '[data-testid="save"]',
    mutation: "noop-state-update"
  }] } as unknown as MutationManifest)).toThrow("testCommand");
});

test("only admits a clean 100 percent built-in mutation result through the release gate", () => {
  expect(mutationReleaseGatePassed({
    schemaVersion: 1,
    target: "fixture:react",
    framework: "react",
    generatedAt: "2026-08-27T00:00:00.000Z",
    totalRequested: 3,
    injected: 3,
    skipped: 0,
    detected: 3,
    uiVerified: 3,
    detectionRate: 1,
    repairRate: 1,
    baselineUnexpectedIssueCount: 0,
    originalCheckoutModified: false,
    residueFiles: [],
    modelCalls: 0,
    cases: [
      {
        name: "fixture/react/empty-onclick",
        mutation: "empty-onclick-setter",
        selector: '[data-testid="empty-onclick"]',
        status: "passed",
        detected: true,
        uiVerified: true,
        modelCalls: 0,
        artifactDir: "cases/empty-onclick",
        residueFiles: [],
        originalCheckoutModified: false
      },
      {
        name: "fixture/react/noop-state",
        mutation: "noop-state-update",
        selector: '[data-testid="noop-state"]',
        status: "passed",
        detected: true,
        uiVerified: true,
        modelCalls: 0,
        artifactDir: "cases/noop-state",
        residueFiles: [],
        originalCheckoutModified: false
      },
      {
        name: "fixture/react/missing-route",
        mutation: "missing-route-navigation",
        selector: '[data-testid="missing-route"]',
        status: "passed",
        detected: true,
        uiVerified: true,
        modelCalls: 0,
        artifactDir: "cases/missing-route",
        residueFiles: [],
        originalCheckoutModified: false
      }
    ]
  })).toBe(true);
});
