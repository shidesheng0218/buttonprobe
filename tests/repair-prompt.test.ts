import { expect, test } from "vitest";
import { buildRepairPrompt } from "../src/repair-prompt.js";
import type { RepairIssue, SourceCandidate } from "../src/types.js";

test("builds a bounded repair prompt with evidence, sources, and prior failures", () => {
  const issue: RepairIssue = {
    controlId: "save",
    pageUrl: "http://localhost:3000/settings",
    label: "Save",
    verdict: "INERT",
    evidence: {
      beforeScreenshot: "before.png",
      afterScreenshot: "after.png",
      signals: []
    }
  };
  const sources: SourceCandidate[] = Array.from({ length: 7 }, (_, index) => ({
    path: `src/File${index}.tsx`,
    content: `export const value${index} = ${index};`
  }));

  const prompt = buildRepairPrompt({
    issue,
    sources,
    round: 2,
    previousAttempts: [
      {
        round: 1,
        decision: "rolled-back",
        reason: "Test command failed",
        tests: { passed: false, command: "npm test", output: "expected 2, received 1" }
      }
    ]
  });

  expect(prompt).toContain("src/File0.tsx");
  expect(prompt).toContain("src/File4.tsx");
  expect(prompt).not.toContain("src/File5.tsx");
  expect(prompt).toContain("expected 2, received 1");
  expect(prompt).toContain("unified diff");
});
