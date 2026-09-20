import { createServer, type Server } from "node:http";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { behaviorContractToScenario, verifyBehaviorContract, verifyScenarioContract } from "../src/behavior-contract.js";

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

test("verifies an explicit post-click behavior contract", async () => {
  const url = await listen(
    createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end('<button data-testid="save" onclick="document.querySelector(\'#status\').textContent=\'Saved\'">Save</button><p id="status">Idle</p>');
    })
  );

  const result = await verifyBehaviorContract({
    url,
    selector: '[data-testid="save"]',
    contract: {
      expect: { text: ["Saved"], visible: ["#status"] },
      forbid: { text: ["Error"], consoleError: true }
    },
    timeoutMs: 30
  });

  expect(result.passed, JSON.stringify(result)).toBe(true);
  expect(result.checks).toContain('text "Saved" present');
  expect(result.failures).toEqual([]);
});

test("rejects a click when the required behavior contract is not met", async () => {
  const url = await listen(
    createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end('<button data-testid="save">Save</button><p id="status">Idle</p>');
    })
  );

  const result = await verifyBehaviorContract({
    url,
    selector: '[data-testid="save"]',
    contract: { expect: { text: ["Saved"] } },
    timeoutMs: 30
  });

  expect(result.passed).toBe(false);
  expect(result.failures).toContain('expected text "Saved" was not present');
});

test("verifies scenario actions with expect and forbid checks", async () => {
  const url = await listen(
    createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end([
        '<button data-testid="save" onclick="document.querySelector(\'#toast\').hidden=false; history.pushState({}, \'\', \'/profile?saved=1\')">Save</button>',
        '<p id="toast" data-testid="save-toast" hidden>Saved</p>'
      ].join(""))
    })
  );

  const result = await verifyScenarioContract({
    baseUrl: url,
    scenario: {
      route: "/profile",
      target: "[data-testid='save']",
      actions: [{ type: "click", selector: "[data-testid='save']" }],
      expect: [
        { type: "text", value: "Saved" },
        { type: "visible", selector: "[data-testid='save-toast']" },
        { type: "urlIncludes", value: "/profile" }
      ],
      forbid: [
        { type: "text", value: "Error" },
        { type: "consoleError" },
        { type: "urlIncludes", value: "/login" }
      ]
    },
    timeoutMs: 30
  });

  expect(result.passed).toBe(true);
  expect(result.checks).toContain('scenario text "Saved" present');
  expect(result.failures).toEqual([]);
});

test("rejects scenario when forbidden text, url, or console error appears", async () => {
  const url = await listen(
    createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end('<button data-testid="save" onclick="console.error(\'boom\'); document.body.insertAdjacentHTML(\'beforeend\', \'<p>Error</p>\'); history.pushState({}, \'\', \'/login\')">Save</button>');
    })
  );

  const result = await verifyScenarioContract({
    baseUrl: url,
    scenario: {
      route: "/profile",
      target: "[data-testid='save']",
      actions: [{ type: "click", selector: "[data-testid='save']" }],
      expect: [{ type: "text", value: "Saved" }],
      forbid: [
        { type: "text", value: "Error" },
        { type: "consoleError" },
        { type: "urlIncludes", value: "/login" }
      ]
    },
    timeoutMs: 30
  });

  expect(result.passed).toBe(false);
  expect(result.failures).toContain('expected scenario text "Saved" was not present');
  expect(result.failures).toContain('forbidden scenario text "Error" was present');
  expect(result.failures.some((failure) => failure.includes("console error observed"))).toBe(true);
  expect(result.failures.some((failure) => failure.includes("forbidden scenario url fragment"))).toBe(true);
});

test("converts legacy behavior contracts into a single-action scenario", () => {
  const scenario = behaviorContractToScenario("save", "[data-testid='save']", "/profile", {
    expect: { text: ["Saved"], visible: ["#toast"], urlIncludes: "/profile" },
    forbid: { text: ["Error"], consoleError: true }
  });

  expect(scenario.target).toBe("[data-testid='save']");
  expect(scenario.actions).toEqual([{ type: "click", selector: "[data-testid='save']" }]);
  expect(scenario.expect).toContainEqual({ type: "text", value: "Saved" });
  expect(scenario.expect).toContainEqual({ type: "visible", selector: "#toast" });
  expect(scenario.forbid).toContainEqual({ type: "consoleError" });
});

test("consoleClean expectation passes on a quiet console and fails after console.error", async () => {
  const cleanUrl = await listen(
    createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end('<button data-testid="save" onclick="document.querySelector(\'#status\').textContent=\'Saved\'">Save</button><p id="status">Idle</p>');
    })
  );
  const clean = await verifyScenarioContract({
    baseUrl: cleanUrl,
    scenario: {
      target: "[data-testid='save']",
      actions: [{ type: "click", selector: "[data-testid='save']" }],
      expect: [{ type: "text", value: "Saved" }, { type: "consoleClean" }]
    },
    timeoutMs: 30
  });
  expect(clean.passed).toBe(true);
  expect(clean.checks).toContain("scenario console stayed clean after interaction");

  const noisyUrl = await listen(
    createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end('<button data-testid="save" onclick="console.error(\'swallowed failure\')">Save</button><p id="status">Idle</p>');
    })
  );
  const noisy = await verifyScenarioContract({
    baseUrl: noisyUrl,
    scenario: {
      target: "[data-testid='save']",
      actions: [{ type: "click", selector: "[data-testid='save']" }],
      expect: [{ type: "consoleClean" }],
      forbid: [{ type: "consoleError" }]
    },
    timeoutMs: 30
  });
  expect(noisy.passed).toBe(false);
  expect(noisy.failures.some((failure) => failure.includes("expected a clean console"))).toBe(true);
  expect(noisy.failures.some((failure) => failure.includes("console error observed"))).toBe(true);
});

test("converts consoleClean expectations from legacy behavior contracts", () => {
  const scenario = behaviorContractToScenario("save", "[data-testid='save']", "/", {
    expect: { consoleClean: true },
    forbid: { consoleError: true }
  });
  expect(scenario.expect).toContainEqual({ type: "consoleClean" });
  expect(scenario.forbid).toContainEqual({ type: "consoleError" });
});

test("executes a multi-step form scenario and evaluates control-state expectations", async () => {
  const url = await listen(
    createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end([
        '<form><input data-testid="name" value="" oninput="this.parentElement.querySelector(\'button\').disabled=false">',
        '<select data-testid="role"><option value="viewer">Viewer</option><option value="admin">Admin</option></select>',
        '<input data-testid="terms" type="checkbox">',
        '<button type="button" data-testid="submit" disabled onclick="this.parentElement.querySelector(\'p\').textContent=\'Saved\'">Save</button>',
        '<p class="status" hidden>Saved</p>',
        '<input data-testid="command" onkeydown="if(event.key===\'Enter\'){ this.parentElement.querySelector(\'p\').hidden=false }"></form>'
      ].join(""));
    })
  );

  const result = await verifyScenarioContract({
    baseUrl: url,
    scenario: {
      target: '[data-testid="name"]',
      actions: [
        { type: "fill", selector: '[data-testid="name"]', value: "Ada" },
        { type: "select", selector: '[data-testid="role"]', value: "admin" },
        { type: "check", selector: '[data-testid="terms"]', checked: true },
        { type: "click", selector: '[data-testid="submit"]' },
        { type: "press", selector: '[data-testid="command"]', key: "Enter" },
        { type: "waitFor", selector: ".status", state: "visible", timeoutMs: 500 }
      ],
      expect: [
        { type: "text", value: "Saved" },
        { type: "enabled", selector: '[data-testid="submit"]' },
        { type: "value", selector: '[data-testid="name"]', value: "Ada" },
        { type: "checked", selector: '[data-testid="terms"]', checked: true }
      ]
    },
    timeoutMs: 30
  });

  expect(result.passed).toBe(true);
  expect(result.checks).toContain('scenario value "Ada" present for "[data-testid="name"]"');
  expect(result.checks).toContain('scenario selector "[data-testid="submit"]" enabled');
});

test("reports the exact scenario step when an action fails", async () => {
  const artifactDir = await mkdtemp(join(tmpdir(), "buttonprobe-scenario-step-"));
  const url = await listen(createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end('<button data-testid="save">Save</button>');
  }));

  const result = await verifyScenarioContract({
    baseUrl: url,
    scenario: {
      target: '[data-testid="save"]',
      actions: [
        { type: "click", selector: '[data-testid="save"]' },
        { type: "fill", selector: "#missing", value: "x" }
      ]
    },
    artifactDir
  });

  expect(result.passed).toBe(false);
  expect(result.failures.some((failure) => failure.includes('scenario step 2 fill "#missing" failed'))).toBe(true);
  const failedStep = result.steps?.find((step) => step.status === "failed");
  expect(failedStep?.screenshot).toBe("screenshots/scenario-step-2-fill-failed.png");
  expect(failedStep?.consoleErrors).toEqual([]);
  expect(failedStep?.network).toEqual([]);
  await stat(join(artifactDir, failedStep?.screenshot ?? ""));
});
