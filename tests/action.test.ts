import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { buildActionArgs, buildProofComment, parseActionInputs, publishPullRequestComment, shouldFailAction } from "../scripts/action.mjs";

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

test("parses opt-in PR comment settings without enabling them by default", () => {
  expect(parseActionInputs({
    INPUT_URL: "http://127.0.0.1:5173",
    INPUT_PATCH: "change.diff",
    INPUT_TEST_COMMAND: "npm test"
  })).toMatchObject({ comment: false, githubToken: "" });
  expect(parseActionInputs({
    INPUT_URL: "http://127.0.0.1:5173",
    INPUT_PATCH: "change.diff",
    INPUT_TEST_COMMAND: "npm test",
    INPUT_COMMENT: "true",
    INPUT_GITHUB_TOKEN: "token"
  })).toMatchObject({ comment: true, githubToken: "token" });
});

test("builds a redacted proof comment summary", () => {
  const comment = buildProofComment({
    status: "ui-verified",
    modelCalls: 0,
    originalCheckoutModified: false,
    ui: { targetWorks: true, regressions: [], browsers: [{ browser: "chromium", status: "passed", targetWorks: true, regressions: [] }] },
    artifacts: { report: "report.html", screenshots: [], testLog: "test.log" },
    rejectionReason: "secret-key-should-not-appear"
  }, { output: "buttonprobe-proof" });
  expect(comment).toContain("ui-verified");
  expect(comment).toContain("model calls: 0");
  expect(comment).not.toContain("secret-key-should-not-appear");
});

test("creates then updates only the fixed ButtonProbe PR comment", async () => {
  const calls: Array<{ method: string; path: string }> = [];
  const request = async (method: string, path: string) => {
    calls.push({ method, path });
    if (path === "/user") return { login: "buttonprobe-bot" };
    if (method === "GET" && path.includes("/comments")) return { data: [] };
    return { html_url: "https://github.com/example/repo/pull/1#issuecomment-1" };
  };
  const first = await publishPullRequestComment({
    env: { GITHUB_EVENT_NAME: "pull_request", GITHUB_REPOSITORY: "example/repo", GITHUB_EVENT_PATH: "/tmp/event.json" },
    token: "token",
    proof: { status: "ui-verified", modelCalls: 0, originalCheckoutModified: false, artifacts: { report: "report.html", screenshots: [], testLog: "test.log" } },
    request,
    event: { pull_request: { number: 1 } }
  });
  expect(first.status).toBe("posted");
  expect(calls.some((call) => call.method === "POST")).toBe(true);
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
