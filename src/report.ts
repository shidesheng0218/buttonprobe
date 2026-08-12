import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AIPageAssessment,
  AIUsageSummary,
  ModelDataManifest,
  ProofArtifacts,
  RepairLoopResult,
  ScanResult,
  SourceCandidateEvidence,
  UIBrowserResult
} from "./types.js";

export interface ReportData {
  assessments: AIPageAssessment[];
  repairs: Array<{ controlId: string; result: RepairLoopResult; sourceCandidates?: SourceCandidateEvidence[] }>;
  usageSummary?: AIUsageSummary;
  modelDataManifest?: ModelDataManifest;
  aiError?: string;
  originalCheckoutModified?: boolean;
  browsers?: UIBrowserResult[];
  artifacts?: ProofArtifacts;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function badge(verdict: string): string {
  return `<span class="badge ${verdict.toLowerCase()}">${escapeHtml(verdict)}</span>`;
}

function repairTimeline(result: RepairLoopResult): string {
  const attempts = result.attempts
    .map(
      (attempt) => `<details>
        <summary>Round ${attempt.round}: ${escapeHtml(attempt.decision)}</summary>
        <p>${escapeHtml(attempt.reason)}</p>
        ${attempt.attempt?.patch ? `<pre><code>${escapeHtml(attempt.attempt.patch)}</code></pre>` : ""}
        ${
          attempt.tests
            ? `<p><strong>Test gate:</strong> ${attempt.tests.passed ? "passed" : "failed"} · ${escapeHtml(attempt.tests.command)}</p>
               <pre><code>${escapeHtml(attempt.tests.output)}</code></pre>`
            : ""
        }
        ${
          attempt.ui
            ? `<p><strong>UI verification:</strong> ${attempt.ui.targetWorks ? "target works" : "target unresolved"}${attempt.ui.regressions.length ? ` · regressions: ${escapeHtml(attempt.ui.regressions.join(", "))}` : ""}</p>
               ${
                 attempt.ui.counterfactual
                   ? `<p><strong>Counterfactual:</strong> ${
                       attempt.ui.counterfactual.baselineFailed
                         ? "baseline click unchanged"
                         : "baseline click changed"
                     }; ${
                       attempt.ui.counterfactual.patchedPassed
                         ? "patched click changed"
                         : "patched click unchanged"
                     }</p>`
                   : ""
               }`
            : ""
        }
        ${
          attempt.ui?.behaviorContract
            ? `<p><strong>Behavior contract:</strong> ${attempt.ui.behaviorContract.passed ? "passed" : "failed"}
               ${attempt.ui.behaviorContract.failures.length ? ` · ${escapeHtml(attempt.ui.behaviorContract.failures.join("; "))}` : ""}</p>`
            : ""
        }
        ${
          attempt.ui?.browsers?.length
            ? `<p><strong>Browser matrix:</strong> ${attempt.ui.browsers
                .map((browser) => `${escapeHtml(browser.browser)}: ${escapeHtml(browser.status)}`)
                .join(" · ")}</p>`
            : ""
        }
      </details>`
    )
    .join("");
  return `<section class="repair">
    <strong>Repair loop: ${escapeHtml(result.status)}</strong>
    <p>Evidence: ${escapeHtml(result.evidenceStatus ?? "failed")}</p>
    <p>${escapeHtml(result.stopReason)}</p>
    ${attempts}
  </section>`;
}

export async function writeReport(
  outputDir: string,
  scan: ScanResult,
  data: ReportData
): Promise<string> {
  const assessmentMap = new Map(
    data.assessments.flatMap((page) => page.assessments.map((item) => [item.controlId, item] as const))
  );
  const repairMap = new Map(data.repairs.map((item) => [item.controlId, item] as const));
  const controls = scan.pages.flatMap((page) =>
    page.controls.map((control) => {
      const assessment = assessmentMap.get(control.id);
      const repairEntry = repairMap.get(control.id);
      const repair = repairEntry?.result;
      const signals = control.evidence.signals.length
        ? control.evidence.signals
            .map((signal) => `<li><strong>${escapeHtml(signal.type)}</strong>: ${escapeHtml(signal.detail)}</li>`)
            .join("")
        : "<li>No observable effect</li>";
      return `<article class="control">
        <header>
          <div><span class="control-id">${escapeHtml(control.id)}</span><h2>${escapeHtml(control.text || control.ariaLabel || control.selector)}</h2></div>
          ${badge(control.verdict)}
        </header>
        <div class="evidence">
          <figure><img src="${escapeHtml(control.evidence.beforeScreenshot)}" alt="Before click"><figcaption>Before</figcaption></figure>
          <figure><img src="${escapeHtml(control.evidence.afterScreenshot)}" alt="After click"><figcaption>After</figcaption></figure>
        </div>
        <ul>${signals}</ul>
        ${
          assessment
            ? `<section class="ai"><strong>AI assessment</strong><p>${escapeHtml(assessment.explanation)}</p><p>Expected: ${escapeHtml(assessment.expectedBehavior)}</p></section>`
            : ""
        }
        ${
          repair
            ? repairTimeline(repair)
            : ""
        }
        ${
          repairEntry?.sourceCandidates?.length
            ? `<section class="ai"><strong>Source candidates</strong><ul>${repairEntry.sourceCandidates
                .map((candidate) => `<li>${escapeHtml(candidate.path)} score ${candidate.score ?? 0}: ${escapeHtml(candidate.reason ?? "no reason")}${
                  candidate.eventChain
                    ? `<br><code>${escapeHtml([
                        candidate.eventChain.control,
                        candidate.eventChain.handler ? `handler ${candidate.eventChain.handler}` : "",
                        candidate.eventChain.calls.length ? `calls ${candidate.eventChain.calls.join(" -> ")}` : "",
                        candidate.eventChain.parentCandidates.length ? `parents ${candidate.eventChain.parentCandidates.join(", ")}` : ""
                      ].filter(Boolean).join(" | "))}</code>`
                    : ""
                }</li>`)
                .join("")}</ul></section>`
            : ""
        }
      </article>`;
    })
  );
  const counts = scan.pages
    .flatMap((page) => page.controls)
    .reduce<Record<string, number>>((result, control) => {
      result[control.verdict] = (result[control.verdict] ?? 0) + 1;
      return result;
    }, {});
  const verifiedDiffs = data.repairs.reduce(
    (count, repair) => count + repair.result.attempts.filter((attempt) => attempt.decision === "accepted").length,
    0
  );
  const modelCalls = data.usageSummary?.modelCalls ??
    data.assessments.length + data.repairs.reduce((count, repair) => count + repair.result.attempts.length, 0);
  const originalCheckoutModified = data.originalCheckoutModified === undefined
    ? "unknown"
    : String(data.originalCheckoutModified);
  const browsers = data.browsers ?? data.repairs.flatMap((repair) =>
    repair.result.attempts.flatMap((attempt) => attempt.ui?.browsers ?? [])
  );
  const artifactLines = [
    data.artifacts?.verifiedDiff ? `verified diff: ${data.artifacts.verifiedDiff}` : "",
    data.artifacts?.proof ? `proof: ${data.artifacts.proof}` : "",
    data.artifacts?.testLog ? `test log: ${data.artifacts.testLog}` : "",
    ...(data.artifacts?.screenshots?.map((screenshot) => `screenshot: ${screenshot}`) ?? [])
  ].filter(Boolean);

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ButtonProbe report</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #17202a; background: #f4f6f7; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    main { width: min(1100px, calc(100% - 32px)); margin: 0 auto; padding: 32px 0 56px; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; margin: 24px 0; }
    .repair-summary { background: white; border: 1px solid #dfe6e9; border-radius: 8px; padding: 18px; margin: 24px 0; }
    .repair-summary h2 { margin-bottom: 12px; }
    .commands { display: grid; gap: 8px; margin-top: 12px; }
    .command { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px; background: #f8f9f9; border: 1px solid #e5e7e9; border-radius: 6px; font: 12px ui-monospace, monospace; }
    .metric, .control { background: white; border: 1px solid #dfe6e9; border-radius: 8px; }
    .metric { padding: 14px; } .metric strong { display: block; font-size: 24px; }
    .control { padding: 18px; margin: 12px 0; }
    .control header { display: flex; align-items: start; justify-content: space-between; gap: 16px; }
    h1, h2, p { margin-top: 0; } h2 { font-size: 18px; margin-bottom: 12px; }
    .control-id { color: #68737d; font: 12px ui-monospace, monospace; }
    .badge { padding: 4px 8px; border-radius: 4px; font: 700 12px ui-monospace, monospace; }
    .works { background: #d5f5e3; color: #196f3d; } .inert { background: #fdebd0; color: #9c640c; }
    .crashed, .backend_error, .network_error { background: #fadbd8; color: #922b21; }
    .auth_required, .rate_limited, .blocked_mutation { background: #fce4ec; color: #8e244d; }
    .ambiguous, .skipped { background: #eaecee; color: #424949; }
    .evidence { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    figure { margin: 0; } img { width: 100%; max-height: 260px; object-fit: contain; background: #f8f9f9; border: 1px solid #e5e7e9; }
    figcaption { color: #68737d; font-size: 12px; margin-top: 4px; }
    .ai, .repair { border-top: 1px solid #edf0f2; padding-top: 12px; margin-top: 12px; }
    details { margin-top: 8px; } summary { cursor: pointer; font-weight: 700; }
    pre { max-height: 300px; overflow: auto; padding: 12px; background: #17202a; color: #f8f9f9; border-radius: 4px; font-size: 12px; }
    .error { color: #922b21; }
    @media (max-width: 640px) { .evidence { grid-template-columns: 1fr; } main { width: min(100% - 20px, 1100px); padding-top: 20px; } }
  </style>
</head>
<body><main>
  <h1>ButtonProbe</h1>
  <p>${escapeHtml(scan.baseUrl)} · ${scan.pages.length} page(s) · ${scan.durationMs}ms</p>
  ${data.aiError ? `<p class="error">AI unavailable: ${escapeHtml(data.aiError)}</p>` : ""}
  <section class="repair-summary">
    <h2>Repair summary</h2>
    <div class="summary">
      <div class="metric">Detected issues<strong>${(counts.INERT ?? 0) + (counts.CRASHED ?? 0) + (counts.AMBIGUOUS ?? 0)}</strong></div>
      <div class="metric">Verified diffs<strong>${verifiedDiffs}</strong></div>
      <div class="metric">Model calls<strong>${modelCalls}</strong></div>
      <div class="metric">Input tokens<strong>${data.usageSummary?.inputTokens ?? 0}</strong></div>
      <div class="metric">Output tokens<strong>${data.usageSummary?.outputTokens ?? 0}</strong></div>
      <div class="metric">Cache hits<strong>${data.usageSummary?.cacheHits ?? 0}</strong></div>
      <div class="metric">Cost estimate<strong>${data.usageSummary?.estimatedCostUsd === undefined ? "unknown" : `$${data.usageSummary.estimatedCostUsd.toFixed(4)}`}</strong></div>
    </div>
    <p>original checkout modified: ${originalCheckoutModified}</p>
    ${browsers.length ? `<p><strong>Browser matrix:</strong> ${browsers.map((browser) => `${escapeHtml(browser.browser)}: ${escapeHtml(browser.status)}`).join(" · ")}</p>` : ""}
    ${data.modelDataManifest ? `<p>Model data: ${escapeHtml(data.modelDataManifest.endpointHost)} · ${data.modelDataManifest.sourceFiles.length} source file(s) · ${data.modelDataManifest.screenshotCount} screenshot(s) · redaction ${data.modelDataManifest.redactionApplied ? "enabled" : "disabled"}</p>` : ""}
    ${artifactLines.length ? `<p><strong>Proof artifacts:</strong> ${artifactLines.map(escapeHtml).join(" · ")}</p>` : ""}
    <p>baseline -&gt; locate -&gt; diagnose -&gt; validate -&gt; worktree test -&gt; counterfactual UI -&gt; verified.diff</p>
    <div class="commands">
      <div class="command"><span>Rerun scan</span><code>buttonprobe scan ${escapeHtml(scan.baseUrl)}</code></div>
      <div class="command"><span>Apply verified diff</span><code>git apply .buttonprobe/repairs/&lt;control&gt;/verified.diff</code></div>
      <div class="command"><span>Open verified diff path</span><code>open .buttonprobe/repairs/&lt;control&gt;/verified.diff</code></div>
    </div>
  </section>
  <section class="summary">
    ${[
      "WORKS",
      "INERT",
      "CRASHED",
      "AMBIGUOUS",
      "BACKEND_ERROR",
      "AUTH_REQUIRED",
      "RATE_LIMITED",
      "NETWORK_ERROR",
      "BLOCKED_MUTATION",
      "SKIPPED"
    ]
      .map((value) => `<div class="metric">${value}<strong>${counts[value] ?? 0}</strong></div>`)
      .join("")}
  </section>
  ${controls.join("")}
</main></body></html>`;

  const path = join(outputDir, "report.html");
  await writeFile(path, html);
  return path;
}
