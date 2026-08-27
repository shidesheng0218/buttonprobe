import { describe, expect, test } from "vitest";
import { applyUiMutation, validateMutationCase } from "../src/mutation.js";

describe("UI mutations", () => {
  test("turns a React state setter into a no-op only for the selected control", () => {
    const source = [
      'const [status, setStatus] = useState("idle");',
      '<button data-testid="save" onClick={() => setStatus("Saved")}>Save</button>'
    ].join("\n");

    const result = applyUiMutation({
      source,
      filePath: "src/App.tsx",
      selector: '[data-testid="save"]',
      mutation: "noop-state-update"
    });

    expect(result?.source).toContain("onClick={() => setStatus(status)}");
    expect(result?.patch).toContain("setStatus(status)");
  });

  test("injects an empty React handler when a unique state setter exists", () => {
    const result = applyUiMutation({
      source: 'const [status, setStatus] = useState("idle");\n<button data-testid="save" onClick={() => setStatus("Saved")}>Save</button>',
      filePath: "src/App.tsx",
      selector: '[data-testid="save"]',
      mutation: "empty-onclick-setter"
    });

    expect(result?.source).toContain("onClick={() => {}}");
  });

  test("rejects a route mutation without a route expectation", () => {
    expect(() => validateMutationCase({
      selector: '[data-testid="go"]',
      mutation: "missing-route-navigation",
      expectText: "Opened"
    })).toThrow("expectUrlIncludes");
  });
});
