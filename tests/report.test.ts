import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { writeReport } from "../src/report.js";
import type { ScanResult } from "../src/types.js";

test("writes a self-contained report with verdicts and repair history", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "buttonprobe-report-"));
  const scan: ScanResult = {
    schemaVersion: 1,
    startedAt: "2026-07-30T00:00:00.000Z",
    durationMs: 120,
    baseUrl: "http://localhost:3000",
    pages: [
      {
        url: "http://localhost:3000",
        title: "Demo",
        screenshot: "page.png",
        errors: [],
        controls: [
          {
            id: "control-1",
            pageUrl: "http://localhost:3000",
            selector: "[data-testid='save']",
            tagName: "button",
            type: "button",
            text: "Save",
            ariaLabel: "",
            testId: "save",
            verdict: "INERT",
            evidence: {
              beforeScreenshot: "before.png",
              afterScreenshot: "after.png",
              signals: []
            }
          },
          {
            id: "blocked-save",
            pageUrl: "http://localhost:3000",
            selector: "[data-testid='save-live']",
            tagName: "button",
            type: "button",
            text: "Save live",
            ariaLabel: "",
            testId: "save-live",
            verdict: "BLOCKED_MUTATION",
            evidence: {
              beforeScreenshot: "before-blocked.png",
              afterScreenshot: "after-blocked.png",
              signals: [{ type: "network", detail: "BLOCKED_MUTATION POST http://localhost:3000/api/save" }]
            }
          },
          {
            id: "backend-save",
            pageUrl: "http://localhost:3000",
            selector: "[data-testid='save-api']",
            tagName: "button",
            type: "button",
            text: "Save API",
            ariaLabel: "",
            testId: "save-api",
            verdict: "BACKEND_ERROR",
            failureClass: "BACKEND_5XX",
            evidence: {
              beforeScreenshot: "before-backend.png",
              afterScreenshot: "after-backend.png",
              signals: [{ type: "network", detail: "POST /api/save -> HTTP 500" }]
            }
          }
        ]
      }
    ]
  };

  const path = await writeReport(outputDir, scan, {
    assessments: [],
    repairs: [
      {
        controlId: "control-1",
        sourceCandidates: [
          {
            path: "src/App.tsx",
            score: 26,
            reason: "data-testid, exact visible text, nearby JSX event handler"
          }
        ],
        result: {
          status: "blocked",
          evidenceStatus: "test-verified",
          stopReason: "Patch verified in isolated worktree; rerun with --apply to update the current checkout and run UI verification",
          attempts: [
            {
              round: 1,
              decision: "accepted",
              reason: "Patch verified in an isolated worktree; current checkout was not modified",
              attempt: {
                diagnosis: "Missing click behavior",
                sourceConfidence: 0.96,
                expectedOutcome: "Save status changes",
                patch: "--- a/src/App.tsx\n+++ b/src/App.tsx\n",
                affectedControls: ["control-1"],
                risk: "low"
              },
              tests: {
                passed: true,
                command: "npm test",
                output: "ok"
              },
              ui: {
                targetWorks: true,
                regressions: [],
                browsers: [
                  {
                    browser: "chromium",
                    status: "passed",
                    targetWorks: true,
                    regressions: []
                  },
                  {
                    browser: "firefox",
                    status: "unavailable",
                    targetWorks: false,
                    regressions: [],
                    error: "browser executable missing"
                  }
                ],
                counterfactual: {
                  baselineFailed: true,
                  patchedPassed: true
                },
                behaviorContract: {
                  passed: true,
                  checks: ['text "Saved" present'],
                  failures: []
                }
              }
            }
          ]
        }
      }
    ],
    usageSummary: {
      modelCalls: 2,
      inputTokens: 200,
      outputTokens: 80,
      latencyMs: 120,
      cacheHits: 1,
      cacheMisses: 2,
      estimatedCostUsd: 0,
      events: []
    },
    modelDataManifest: {
      endpointHost: "127.0.0.1:11434",
      sourceFiles: ["src/App.tsx"],
      screenshotCount: 2,
      redactionApplied: true
    },
    originalCheckoutModified: false,
    proofStatus: "test-verified",
    rejectionReason: "Firefox browser executable missing",
    artifacts: {
      verifiedDiff: ".buttonprobe/verify/verified.diff",
      proof: ".buttonprobe/verify/proof.json",
      testLog: ".buttonprobe/verify/test.log",
      screenshots: [".buttonprobe/verify/baseline/screenshots/save-before.png"]
    }
  });
  const html = await readFile(path, "utf8");

  expect(html).toContain("ButtonProbe");
  expect(html).toContain("INERT");
  expect(html).toContain("Repair summary");
  expect(html).toContain("Verified diffs");
  expect(html).toContain("Model calls");
  expect(html).toContain("original checkout modified: false");
  expect(html).toContain("Proof status<strong>test-verified</strong>");
  expect(html).toContain("Rejection reason: Firefox browser executable missing");
  expect(html).toContain("Browser matrix");
  expect(html).toContain("chromium: passed");
  expect(html).toContain("firefox: unavailable");
  expect(html).toContain("baseline -&gt; locate -&gt; diagnose -&gt; validate -&gt; worktree test -&gt; counterfactual UI -&gt; verified.diff");
  expect(html).toContain("Apply verified diff");
  expect(html).toContain("src/App.tsx score 26");
  expect(html).toContain("data-testid, exact visible text, nearby JSX event handler");
  expect(html).toContain("Input tokens");
  expect(html).toContain("Cache hits");
  expect(html).toContain("127.0.0.1:11434");
  expect(html).toContain("Proof artifacts");
  expect(html).toContain("verified diff: .buttonprobe/verify/verified.diff");
  expect(html).toContain("proof: .buttonprobe/verify/proof.json");
  expect(html).toContain("test log: .buttonprobe/verify/test.log");
  expect(html).toContain("$0.0000");
  expect(html).toContain("Evidence: test-verified");
  expect(html).toContain("Counterfactual:</strong> baseline click unchanged; patched click changed");
  expect(html).toContain("Behavior contract:</strong> passed");
  expect(html).toContain("BLOCKED_MUTATION<strong>1</strong>");
  expect(html).toContain("BACKEND_ERROR<strong>1</strong>");
});
