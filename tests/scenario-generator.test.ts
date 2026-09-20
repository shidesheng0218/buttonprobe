import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { acceptScenarioDraft, mergeScenarioDraft, recordScenarioDraft, recordedActionsToScenario, synthesizeScenarioDraft } from "../src/scenario-generator.js";

const servers: Server[] = [];

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

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

  test("keeps stable recorded actions but rejects drafts with sensitive input values", () => {
    const clean = recordedActionsToScenario({
      target: '[data-testid="save"]',
      actions: [
        { type: "fill", selector: '[data-testid="name"]', value: "Ada", sensitive: false },
        { type: "click", selector: '[data-testid="save"]', sensitive: false }
      ]
    });
    expect(clean.actions).toEqual([
      { type: "fill", selector: '[data-testid="name"]', value: "Ada" },
      { type: "click", selector: '[data-testid="save"]' }
    ]);
    expect(clean.hasSensitiveInput).toBe(false);

    const sensitive = recordedActionsToScenario({
      target: '[data-testid="login"]',
      actions: [{ type: "fill", selector: '[data-testid="password"]', value: "secret", sensitive: true }]
    });
    expect(sensitive.actions).toEqual([]);
    expect(sensitive.hasSensitiveInput).toBe(true);
  });

  test("records a real local workflow with data-bp-id selectors", async () => {
    const baseUrl = await listen(createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end('<input data-bp-id="bp-name" data-testid="name" id="name"><button data-bp-id="bp-save" data-testid="save" onclick="document.querySelector(\'#status\').textContent=\'Saved\'">Save</button><p id="status">Idle</p>');
    }));

    const draft = await recordScenarioDraft({ baseUrl, name: "save-profile", timeoutMs: 20 }, {
      headless: true,
      interact: async (page) => {
        await page.locator('[data-testid="name"]').fill("Ada");
        await page.locator('[data-testid="save"]').click();
      }
    });

    expect(draft.confidence).toBe("high");
    expect(draft.selector).toBe('[data-bp-id="bp-save"]');
    expect(draft.scenario?.actions).toEqual([
      { type: "fill", selector: '[data-bp-id="bp-name"]', value: "Ada" },
      { type: "click", selector: '[data-bp-id="bp-save"]' }
    ]);
    expect(draft.scenario?.expect).toContainEqual({ type: "text", value: "Saved" });
  });

  test("does not persist sensitive values from a real recorded workflow", async () => {
    const baseUrl = await listen(createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end('<input data-bp-id="bp-password" type="password" name="password"><button data-bp-id="bp-login" onclick="document.querySelector(\'#status\').textContent=\'Logged in\'">Log in</button><p id="status">Idle</p>');
    }));

    const draft = await recordScenarioDraft({ baseUrl, name: "login", timeoutMs: 20 }, {
      headless: true,
      interact: async (page) => {
        await page.locator('[data-bp-id="bp-password"]').fill("super-secret-value");
        await page.locator('[data-bp-id="bp-login"]').click();
      }
    });

    expect(draft.confidence).toBe("insufficient-evidence");
    expect(draft.scenario).toBeUndefined();
    expect(draft.evidence.rejectionReason).toContain("Sensitive input");
    expect(JSON.stringify(draft)).not.toContain("super-secret-value");
  });

  test("continues recording after a full-page local navigation", async () => {
    const baseUrl = await listen(createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      if (request.url === "/next") {
        response.end('<button data-bp-id="bp-save" onclick="document.querySelector(\'#status\').textContent=\'Saved\'">Save</button><p id="status">Idle</p>');
        return;
      }
      response.end('<a id="next" href="/next">Next</a>');
    }));

    const draft = await recordScenarioDraft({ baseUrl, name: "navigate-and-save", timeoutMs: 20 }, {
      headless: true,
      interact: async (page) => {
        await page.locator("#next").click();
        await page.waitForURL("**/next");
        await page.locator('[data-bp-id="bp-save"]').click();
      }
    });

    expect(draft.scenario?.actions).toEqual([
      { type: "click", selector: "#next" },
      { type: "click", selector: '[data-bp-id="bp-save"]' }
    ]);
  });
});
