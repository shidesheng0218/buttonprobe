import { expect, test } from "vitest";
import { externalCloneArguments, parseExternalEvalManifest, remainingBudget } from "../src/viral-eval.js";

const validCase = {
  name: "owner/repo/save-button",
  framework: "react",
  repo: "https://github.com/owner/repo",
  commit: "a".repeat(40),
  license: "MIT",
  patchFile: "patches/save-button.diff",
  expectedSource: "src/ProfileForm.tsx",
  testCommand: "npm test",
  devCommand: "npm run dev -- --port {port}"
};

test("requires framework, license, and expected source for public benchmark cases", () => {
  expect(() => parseExternalEvalManifest({ cases: [{ ...validCase, framework: undefined }] })).toThrow("framework");
  expect(() => parseExternalEvalManifest({ cases: [{ ...validCase, license: undefined }] })).toThrow("license");
  expect(() => parseExternalEvalManifest({ cases: [{ ...validCase, expectedSource: undefined }] })).toThrow("expectedSource");
});

test("preserves evidence metadata for a reproducible public benchmark", () => {
  expect(parseExternalEvalManifest({ cases: [validCase] }).cases[0]).toMatchObject({
    framework: "react",
    license: "MIT",
    expectedSource: "src/ProfileForm.tsx"
  });
});

test("treats the external eval timeout as one case-wide budget", () => {
  expect(remainingBudget(10_000, 9_250)).toBe(750);
  expect(remainingBudget(10_000, 10_001)).toBe(0);
});

test("uses a partial clone for public benchmark repositories", () => {
  expect(externalCloneArguments("https://github.com/owner/repo", "/tmp/repo")).toEqual([
    "clone",
    "--filter=blob:none",
    "--no-checkout",
    "https://github.com/owner/repo",
    "/tmp/repo"
  ]);
});
