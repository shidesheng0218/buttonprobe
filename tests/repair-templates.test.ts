import { describe, expect, test } from "vitest";
import { buildTemplateAttempt, matchRepairTemplates, TEMPLATE_AUTO_VERIFY_SCORE } from "../src/repair-templates.js";
import type { RepairIssue, ScenarioContract, SourceCandidate } from "../src/types.js";

const emptyOnclickSource = [
  'import { useState } from "react";',
  "export function App() {",
  '  const [status, setStatus] = useState("idle");',
  '  return <button data-testid="empty-onclick" onClick={() => {}}>Empty onClick</button>;',
  "}",
  ""
].join("\n");

const missingRouteSource = [
  "export function App() {",
  '  return <button data-testid="missing-route" onClick={() => {}}>Missing route navigation</button>;',
  "}",
  ""
].join("\n");

const routerSource = [
  'import { useNavigate } from "react-router-dom";',
  "export function App() {",
  "  const navigate = useNavigate();",
  '  return <button data-testid="missing-route" onClick={() => {}}>Missing route navigation</button>;',
  "}",
  ""
].join("\n");

const noopStateSource = [
  'import { useState } from "react";',
  "export function App() {",
  '  const [status, setStatus] = useState("idle");',
  '  return <button data-testid="noop-state" onClick={() => setStatus(status)}>No-op state update</button>;',
  "}",
  ""
].join("\n");

function makeIssue(controlId: string, label: string): RepairIssue {
  return {
    controlId,
    pageUrl: "http://localhost:5173/",
    label,
    verdict: "INERT",
    evidence: { beforeScreenshot: "before.png", afterScreenshot: "after.png", signals: [] }
  };
}

function makeCandidate(content: string, overrides: Partial<SourceCandidate> = {}): SourceCandidate {
  return {
    path: "src/App.tsx",
    content,
    score: 40,
    reason: "data-testid, JSX event chain",
    strongIdentity: true,
    eventChain: { control: 'button[data-testid="empty-onclick"]', calls: [], imports: [], parentCandidates: [] },
    ...overrides
  };
}

const setterScenario: ScenarioContract = {
  target: '[data-testid="empty-onclick"]',
  actions: [{ type: "click", selector: '[data-testid="empty-onclick"]' }],
  expect: [{ type: "text", value: "fixed" }]
};

const routeScenario: ScenarioContract = {
  target: '[data-testid="missing-route"]',
  actions: [{ type: "click", selector: '[data-testid="missing-route"]' }],
  expect: [{ type: "urlIncludes", value: "/settings" }]
};

const noopScenario: ScenarioContract = {
  target: '[data-testid="noop-state"]',
  actions: [{ type: "click", selector: '[data-testid="noop-state"]' }],
  expect: [{ type: "text", value: "fixed" }]
};

describe("matchRepairTemplates", () => {
  test("wires an empty onClick to the unique useState setter using scenario text evidence", () => {
    const issue = makeIssue("empty-onclick", "Empty onClick");
    const match = matchRepairTemplates(issue, [makeCandidate(emptyOnclickSource)], { scenario: setterScenario });

    expect(match?.templateId).toBe("empty-onclick-setter");
    expect(match?.path).toBe("src/App.tsx");
    expect(match?.diff).toContain(
      '+  return <button data-testid="empty-onclick" onClick={() => setStatus("fixed")}>Empty onClick</button>;'
    );
    expect(match?.diff).toContain(
      '-  return <button data-testid="empty-onclick" onClick={() => {}}>Empty onClick</button>;'
    );
    expect(match?.diff).toContain("--- a/src/App.tsx");
    expect(match?.diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
  });

  test("is deterministic for identical inputs", () => {
    const issue = makeIssue("empty-onclick", "Empty onClick");
    const first = matchRepairTemplates(issue, [makeCandidate(emptyOnclickSource)], { scenario: setterScenario });
    const second = matchRepairTemplates(issue, [makeCandidate(emptyOnclickSource)], { scenario: setterScenario });
    expect(first?.diff).toBe(second?.diff);
  });

  test("rejects candidates below the strong identity or score gates", () => {
    const issue = makeIssue("empty-onclick", "Empty onClick");
    expect(matchRepairTemplates(issue, [makeCandidate(emptyOnclickSource, { strongIdentity: false })], { scenario: setterScenario })).toBeNull();
    expect(
      matchRepairTemplates(issue, [makeCandidate(emptyOnclickSource, { score: TEMPLATE_AUTO_VERIFY_SCORE - 1 })], {
        scenario: setterScenario
      })
    ).toBeNull();
    const { eventChain: _eventChain, ...withoutChain } = makeCandidate(emptyOnclickSource);
    expect(matchRepairTemplates(issue, [withoutChain], { scenario: setterScenario })).toBeNull();
  });

  test("returns null without scenario evidence instead of guessing", () => {
    const issue = makeIssue("empty-onclick", "Empty onClick");
    expect(matchRepairTemplates(issue, [makeCandidate(emptyOnclickSource)])).toBeNull();
  });

  test("returns null when the setter is ambiguous", () => {
    const issue = makeIssue("empty-onclick", "Empty onClick");
    const ambiguous = emptyOnclickSource.replace(
      'const [status, setStatus] = useState("idle");',
      'const [status, setStatus] = useState("idle");\n  const [other, setOther] = useState("other");'
    );
    expect(matchRepairTemplates(issue, [makeCandidate(ambiguous)], { scenario: setterScenario })).toBeNull();
  });

  test("returns null with multiple text expectations", () => {
    const issue = makeIssue("empty-onclick", "Empty onClick");
    const scenario: ScenarioContract = {
      ...setterScenario,
      expect: [
        { type: "text", value: "fixed" },
        { type: "text", value: "other" }
      ]
    };
    expect(matchRepairTemplates(issue, [makeCandidate(emptyOnclickSource)], { scenario })).toBeNull();
  });

  test("wires an empty onClick to history navigation using scenario urlIncludes evidence", () => {
    const issue = makeIssue("missing-route", "Missing route navigation");
    const match = matchRepairTemplates(issue, [makeCandidate(missingRouteSource)], { scenario: routeScenario });

    expect(match?.templateId).toBe("missing-route-navigation");
    expect(match?.diff).toContain(
      '+  return <button data-testid="missing-route" onClick={() => window.history.pushState({}, "", "/settings")}>Missing route navigation</button>;'
    );
  });

  test("prefers react-router navigate when the file already uses useNavigate", () => {
    const issue = makeIssue("missing-route", "Missing route navigation");
    const match = matchRepairTemplates(issue, [makeCandidate(routerSource)], { scenario: routeScenario });

    expect(match?.templateId).toBe("missing-route-navigation");
    expect(match?.diff).toContain('onClick={() => navigate("/settings")}');
  });

  test("rejects route expectations that are not absolute paths", () => {
    const issue = makeIssue("missing-route", "Missing route navigation");
    const scenario: ScenarioContract = {
      ...routeScenario,
      expect: [{ type: "urlIncludes", value: "settings" }]
    };
    expect(matchRepairTemplates(issue, [makeCandidate(missingRouteSource)], { scenario })).toBeNull();
  });

  test("repairs only a useState self-assignment with one scenario text expectation", () => {
    const issue = makeIssue("noop-state", "No-op state update");
    const match = matchRepairTemplates(issue, [makeCandidate(noopStateSource)], { scenario: noopScenario });

    expect(match?.templateId).toBe("noop-state-update");
    expect(match?.diff).toContain('onClick={() => setStatus("fixed")}');
    expect(match?.reason).toContain("self-assigning setStatus(status)");
  });

  test("rejects noop-looking handlers without a matching useState pair or unique scenario text", () => {
    const issue = makeIssue("noop-state", "No-op state update");
    const nonState = noopStateSource.replace('const [status, setStatus] = useState("idle");', "const status = \"idle\";");
    expect(matchRepairTemplates(issue, [makeCandidate(nonState)], { scenario: noopScenario })).toBeNull();
    expect(matchRepairTemplates(issue, [makeCandidate(noopStateSource)])).toBeNull();
    expect(
      matchRepairTemplates(issue, [makeCandidate(noopStateSource)], {
        scenario: { ...noopScenario, expect: [{ type: "text", value: "one" }, { type: "text", value: "two" }] }
      })
    ).toBeNull();
  });

  test("does not rewrite a setter that receives a different expression", () => {
    const issue = makeIssue("noop-state", "No-op state update");
    const functionalUpdate = noopStateSource.replace("setStatus(status)", "setStatus(status + \"!\")");
    expect(matchRepairTemplates(issue, [makeCandidate(functionalUpdate)], { scenario: noopScenario })).toBeNull();
  });

  test("ignores non-JSX files", () => {
    const issue = makeIssue("empty-onclick", "Empty onClick");
    expect(
      matchRepairTemplates(issue, [makeCandidate(emptyOnclickSource, { path: "src/App.ts" })], {
        scenario: setterScenario
      })
    ).toBeNull();
  });
});

describe("buildTemplateAttempt", () => {
  test("produces a low-risk attempt carrying the template diff", () => {
    const issue = makeIssue("empty-onclick", "Empty onClick");
    const match = matchRepairTemplates(issue, [makeCandidate(emptyOnclickSource)], { scenario: setterScenario });
    expect(match).not.toBeNull();
    const attempt = buildTemplateAttempt(match!, issue);
    expect(attempt.risk).toBe("low");
    expect(attempt.patch).toBe(match!.diff);
    expect(attempt.affectedControls).toEqual(["empty-onclick"]);
    expect(attempt.diagnosis).toContain("empty-onclick-setter");
  });
});
