import { describe, expect, test } from "vitest";
import { acceptScenarioDraft, mergeScenarioDraft, synthesizeScenarioDraft } from "../src/scenario-generator.js";

describe("scenario generation", () => {
  test("creates a high-confidence scenario from a stable text and clean console", () => {
    const draft = synthesizeScenarioDraft({
      name: "save",
      baseUrl: "http://127.0.0.1:5173/profile",
      controlId: "save",
      selector: '[data-testid="save"]',
      beforeText: "Save idle",
      afterText: "Save Saved",
      consoleErrors: [],
      pageErrors: [],
      network: []
    });

    expect(draft.confidence).toBe("high");
    expect(draft.scenario?.expect).toEqual([
      { type: "text", value: "Saved" },
      { type: "consoleClean" }
    ]);
  });

  test("marks a click with no observable success as insufficient evidence", () => {
    const draft = synthesizeScenarioDraft({
      name: "save",
      baseUrl: "http://127.0.0.1:5173",
      controlId: "save",
      selector: '[data-testid="save"]',
      beforeText: "Save",
      afterText: "Save",
      consoleErrors: [],
      pageErrors: [],
      network: []
    });

    expect(draft.confidence).toBe("insufficient-evidence");
    expect(draft.scenario).toBeUndefined();
  });

  test("refuses to overwrite an existing scenario unless force is explicit", () => {
    const generated = {
      schemaVersion: 1 as const,
      drafts: [{
        name: "save",
        confidence: "high" as const,
        baseUrl: "http://127.0.0.1:5173",
        controlId: "save",
        selector: '[data-testid="save"]',
        generatedAt: "2026-08-27T00:00:00.000Z",
        scenario: { target: '[data-testid="save"]', actions: [{ type: "click" as const, selector: '[data-testid="save"]' }] },
        evidence: { observations: [] }
      }]
    };
    expect(() => acceptScenarioDraft({
      config: { scenarios: { save: { target: "#old", actions: [{ type: "click", selector: "#old" }] } }, maxPages: 5 },
      generated,
      name: "save"
    })).toThrow("already exists");
    expect(acceptScenarioDraft({
      config: { scenarios: { save: { target: "#old", actions: [{ type: "click", selector: "#old" }] } }, maxPages: 5 },
      generated,
      name: "save",
      force: true
    }).scenarios.save?.target).toBe('[data-testid="save"]');
  });

  test("merges a generated draft by stable control id without changing unrelated drafts", () => {
    const current = {
      schemaVersion: 1 as const,
      drafts: [{
        name: "old",
        confidence: "high" as const,
        baseUrl: "http://127.0.0.1:5173",
        controlId: "old",
        selector: "#old",
        generatedAt: "2026-08-27T00:00:00.000Z",
        scenario: { target: "#old", actions: [{ type: "click" as const, selector: "#old" }] },
        evidence: { observations: [] }
      }]
    };
    const next = synthesizeScenarioDraft({
      name: "save",
      baseUrl: "http://127.0.0.1:5173",
      controlId: "save",
      selector: "#save",
      beforeText: "Save",
      afterText: "Save Saved",
      consoleErrors: [],
      pageErrors: [],
      network: []
    });
    expect(mergeScenarioDraft(current, next).drafts).toHaveLength(2);
  });
});
