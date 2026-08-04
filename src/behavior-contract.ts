import { chromium, firefox, webkit } from "playwright";
import type { BehaviorContract, BehaviorContractVerification, ScenarioContract } from "./types.js";

export interface BehaviorContractRun {
  url: string;
  selector: string;
  contract: BehaviorContract;
  timeoutMs?: number;
  allowMutations?: boolean;
}

export interface ScenarioContractRun {
  baseUrl: string;
  scenario: ScenarioContract;
  timeoutMs?: number;
  allowMutations?: boolean;
  browserName?: "chromium" | "firefox" | "webkit";
}

function includesText(body: string, expected: string): boolean {
  return body.includes(expected);
}

export function behaviorContractToScenario(
  id: string,
  selector: string,
  route: string,
  contract: BehaviorContract
): ScenarioContract {
  return {
    route,
    target: selector,
    actions: [{ type: "click", selector }],
    expect: [
      ...(contract.expect?.text ?? []).map((value) => ({ type: "text" as const, value })),
      ...(contract.expect?.visible ?? []).map((visibleSelector) => ({ type: "visible" as const, selector: visibleSelector })),
      ...(contract.expect?.urlIncludes ? [{ type: "urlIncludes" as const, value: contract.expect.urlIncludes }] : []),
      ...(contract.expect?.network ?? []).map((value) => ({ type: "network" as const, value }))
    ],
    forbid: [
      ...(contract.forbid?.text ?? []).map((value) => ({ type: "text" as const, value })),
      ...(contract.forbid?.urlIncludes ? [{ type: "urlIncludes" as const, value: contract.forbid.urlIncludes }] : []),
      ...(contract.forbid?.consoleError ? [{ type: "consoleError" as const }] : [])
    ]
  };
}

export async function verifyScenarioContract(input: ScenarioContractRun): Promise<BehaviorContractVerification> {
  const browserType = input.browserName === "firefox" ? firefox : input.browserName === "webkit" ? webkit : chromium;
  const browser = await browserType.launch({ headless: true });
  const checks: string[] = [];
  const failures: string[] = [];
  const network: string[] = [];
  const consoleErrors: string[] = [];
  let interactionStarted = false;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    if (!input.allowMutations) {
      await context.route("**/*", async (route) => {
        const request = route.request();
        if (interactionStarted && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) {
          network.push(`BLOCKED_MUTATION ${request.method()} ${request.url()}`);
          await route.abort();
          return;
        }
        await route.fallback();
      });
    }
    const page = await context.newPage();
    page.on("console", (message) => {
      if (interactionStarted && message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("request", (request) => {
      if (interactionStarted && ["xhr", "fetch"].includes(request.resourceType())) {
        network.push(`${request.method()} ${request.url()}`);
      }
    });
    const startUrl = new URL(input.scenario.route ?? "/", input.baseUrl).href;
    await page.goto(startUrl, { waitUntil: "domcontentloaded" });
    await page.locator(input.scenario.target).first().waitFor({ state: "visible", timeout: 5_000 });
    interactionStarted = true;
    for (const action of input.scenario.actions) {
      if (action.type === "click") {
        await page.locator(action.selector).first().click({ timeout: 5_000 });
      }
    }
    await page.waitForTimeout(input.timeoutMs ?? 500);

    const body = await page.locator("body").innerText();
    const currentUrl = page.url();
    for (const expected of input.scenario.expect ?? []) {
      if (expected.type === "text") {
        if (includesText(body, expected.value)) checks.push(`scenario text "${expected.value}" present`);
        else failures.push(`expected scenario text "${expected.value}" was not present`);
      } else if (expected.type === "visible") {
        if (await page.locator(expected.selector).first().isVisible().catch(() => false)) {
          checks.push(`scenario selector "${expected.selector}" visible`);
        } else {
          failures.push(`expected scenario selector "${expected.selector}" was not visible`);
        }
      } else if (expected.type === "urlIncludes") {
        if (currentUrl.includes(expected.value)) checks.push(`scenario url includes "${expected.value}"`);
        else failures.push(`expected scenario url to include "${expected.value}" but got "${currentUrl}"`);
      } else if (expected.type === "network") {
        if (network.some((entry) => entry.includes(expected.value))) checks.push(`scenario network "${expected.value}" observed`);
        else failures.push(`expected scenario network "${expected.value}" was not observed`);
      }
    }
    for (const forbidden of input.scenario.forbid ?? []) {
      if (forbidden.type === "text") {
        if (includesText(body, forbidden.value)) failures.push(`forbidden scenario text "${forbidden.value}" was present`);
        else checks.push(`forbidden scenario text "${forbidden.value}" absent`);
      } else if (forbidden.type === "urlIncludes") {
        if (currentUrl.includes(forbidden.value)) failures.push(`forbidden scenario url fragment "${forbidden.value}" was present`);
        else checks.push(`forbidden scenario url fragment "${forbidden.value}" absent`);
      } else if (forbidden.type === "consoleError") {
        if (consoleErrors.length > 0) failures.push(`console error observed: ${consoleErrors.join(" | ")}`);
        else checks.push("no console error observed");
      } else if (forbidden.type === "network") {
        if (network.some((entry) => entry.includes(forbidden.value))) failures.push(`forbidden scenario network "${forbidden.value}" was observed`);
        else checks.push(`forbidden scenario network "${forbidden.value}" absent`);
      }
    }
    await context.close();
  } catch (error) {
    failures.push(`scenario execution failed: ${(error as Error).message}`);
  } finally {
    await browser.close();
  }
  return { passed: failures.length === 0, checks, failures };
}

export async function verifyBehaviorContract(input: BehaviorContractRun): Promise<BehaviorContractVerification> {
  const routeUrl = new URL(input.url);
  const result = await verifyScenarioContract({
    baseUrl: input.url,
    scenario: behaviorContractToScenario(input.selector, input.selector, `${routeUrl.pathname}${routeUrl.search}`, input.contract),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.allowMutations !== undefined ? { allowMutations: input.allowMutations } : {})
  });
  return {
    passed: result.passed,
    checks: result.checks.map((check) => check.replace(/^scenario /, "")),
    failures: result.failures.map((failure) =>
      failure
        .replace(/^expected scenario /, "expected ")
        .replace(/^forbidden scenario /, "forbidden ")
        .replace(/^scenario execution failed:/, "behavior contract execution failed:")
    )
  };
}
