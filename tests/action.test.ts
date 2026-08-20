import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { buildActionArgs, parseActionInputs, shouldFailAction } from "../scripts/action.mjs";

test("parses the zero-model PR verification action inputs", () => {
  const inputs = parseActionInputs({
    INPUT_URL: "http://127.0.0.1:5173",
    INPUT_PATCH_URL: "https://github.com/example/repo/pull/12.diff",
    INPUT_TEST_COMMAND: "npm test",
    INPUT_DEV_COMMAND: "npm run dev -- --port {port}",
    INPUT_BROWSER: "chromium,firefox"
  });

  expect(inputs).toMatchObject({
    url: "http://127.0.0.1:5173",
    patchUrl: "https://github.com/example/repo/pull/12.diff",
    testCommand: "npm test",
    browser: "chromium,firefox",
    failOnUnverified: true
  });
});

test("fails the Action unless the proof reaches ui-verified", () => {
  expect(shouldFailAction("ui-verified", true)).toBe(false);
  expect(shouldFailAction("test-verified", true)).toBe(true);
  expect(shouldFailAction("rejected", false)).toBe(false);
});

test("builds a verification-only command with no apply escape hatch", () => {
  const args = buildActionArgs({
    url: "http://127.0.0.1:5173",
    patchUrl: "https://github.com/example/repo/pull/12.diff",
    testCommand: "npm test",
    devCommand: "npm run dev -- --port {port}",
    projectRoot: ".",
    output: "buttonprobe-proof",
    target: "[data-testid='save']",
    browser: "chromium",
    packageVersion: "0.1.0-alpha.1",
    failOnUnverified: true
  });

  expect(args).toEqual([
    "--yes",
    "buttonprobe@0.1.0-alpha.1",
    "verify",
    "http://127.0.0.1:5173",
    "--patch-url",
    "https://github.com/example/repo/pull/12.diff",
    "--test-command",
    "npm test",
    "--project-root",
    ".",
    "--output",
    "buttonprobe-proof",
    "--browser",
    "chromium",
    "--dev-command",
    "npm run dev -- --port {port}",
    "--target",
    "[data-testid='save']"
  ]);
  expect(args).not.toContain("--apply");
});

test("declares a Node 20 composite-free Action surface", async () => {
  const action = await readFile("action.yml", "utf8");

  expect(action).toContain("using: node20");
  expect(action).toContain("main: scripts/action.mjs");
  expect(action).toContain("fail-on-unverified");
  expect(action).toContain("original-checkout-modified");
  expect(action).toContain("branding:");
  expect(action).toContain("icon: check-circle");
});
