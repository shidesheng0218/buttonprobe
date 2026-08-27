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
    cases: []
  })).toBe(true);
});
