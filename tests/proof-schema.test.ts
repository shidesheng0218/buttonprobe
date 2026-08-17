import { expect, test } from "vitest";
import { createRepairProofV2, proofArtifactPaths } from "../src/proof-schema.js";

test("creates a relative, machine-readable UI-verified proof", () => {
  const proof = createRepairProofV2({
    status: "ui-verified",
    patch: { source: "/tmp/agent.diff", content: "--- a/src/App.tsx\n+++ b/src/App.tsx\n" },
    target: {
      id: "save",
      selector: '[data-testid="save"]',
      baseline: "inert",
      patchedWorks: true
    },
    tests: { passed: true, command: "npm test", log: "test.log" },
    browsers: [{ browser: "chromium", status: "passed", targetWorks: true, regressions: [] }],
    regressions: [],
    originalCheckoutModified: false,
    modelCalls: 0,
    artifacts: {
      report: "report.html",
      verifiedDiff: "verified.diff",
      screenshots: ["baseline/screenshots/save-before.png"],
      testLog: "test.log"
    }
  });

  expect(proof.schemaVersion).toBe(2);
  expect(proof.patch.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(proof.status).toBe("ui-verified");
  expect(proofArtifactPaths(proof)).toEqual([
    "report.html",
    "verified.diff",
    "baseline/screenshots/save-before.png",
    "test.log"
  ]);
});

test("rejects an unverified proof that claims the target was fixed", () => {
  expect(() => createRepairProofV2({
    status: "test-verified",
    patch: { source: "agent.diff", content: "diff --git a/a b/a" },
    target: { id: "save", selector: "#save", baseline: "inert", patchedWorks: true },
    tests: { passed: true, command: "npm test", log: "test.log" },
    browsers: [],
    regressions: [],
    originalCheckoutModified: false,
    modelCalls: 0,
    artifacts: { report: "report.html", screenshots: [], testLog: "test.log" }
  })).toThrow("ui-verified");
});
