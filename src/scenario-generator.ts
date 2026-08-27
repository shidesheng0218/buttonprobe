import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium } from "playwright";
import { classifyDangerousControl } from "./danger.js";
import type { ScenarioContract } from "./types.js";

export type ScenarioDraftConfidence = "high" | "insufficient-evidence";

export interface ScenarioDraft {
  name: string;
  confidence: ScenarioDraftConfidence;
  baseUrl: string;
  controlId: string;
  selector: string;
  generatedAt: string;
  scenario?: ScenarioContract;
  evidence: { observations: string[]; rejectionReason?: string };
}

export interface GeneratedScenarios {
  schemaVersion: 1;
  drafts: ScenarioDraft[];
}

export interface ScenarioObservationInput {
  name: string;
  baseUrl: string;
  controlId: string;
  selector: string;
  beforeText: string;
  afterText: string;
  beforeUrl?: string;
  afterUrl?: string;
  consoleErrors: string[];
  pageErrors: string[];
  network: string[];
  visibleSelectors?: string[];
}

export function mergeScenarioDraft(current: GeneratedScenarios, draft: ScenarioDraft): GeneratedScenarios {
  const index = current.drafts.findIndex((candidate) => candidate.controlId === draft.controlId);
  const drafts = [...current.drafts];
  if (index >= 0) drafts[index] = draft;
  else drafts.push(draft);
  return { schemaVersion: 1, drafts };
}

function introducedText(beforeText: string, afterText: string): string | undefined {
  const before = new Set(beforeText.split(/\s+/).filter(Boolean));
  const candidates = afterText.split(/\s+/).filter((word) => word && !before.has(word));
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function synthesizeScenarioDraft(input: ScenarioObservationInput): ScenarioDraft {
  const observations = [
    ...(input.beforeUrl && input.afterUrl && input.beforeUrl !== input.afterUrl ? [`url changed to ${input.afterUrl}`] : []),
    ...input.network.map((entry) => `network ${entry}`),
    ...input.consoleErrors.map((entry) => `console error ${entry}`),
    ...input.pageErrors.map((entry) => `page error ${entry}`)
  ];
  const text = introducedText(input.beforeText, input.afterText);
  const url = input.beforeUrl && input.afterUrl && input.beforeUrl !== input.afterUrl
    ? new URL(input.afterUrl).pathname
    : undefined;
  const hasErrors = input.consoleErrors.length > 0 || input.pageErrors.length > 0;
  const expect = [
    ...(text ? [{ type: "text" as const, value: text }] : []),
    ...(input.visibleSelectors?.length === 1 ? [{ type: "visible" as const, selector: input.visibleSelectors[0]! }] : []),
    ...(url && url !== "/" ? [{ type: "urlIncludes" as const, value: url }] : []),
    ...(input.network.length === 1 ? [{ type: "network" as const, value: input.network[0]! }] : []),
    ...(!hasErrors ? [{ type: "consoleClean" as const }] : [])
  ];
  if ((!text && !url) || hasErrors) {
    return {
      name: input.name,
      confidence: "insufficient-evidence",
      baseUrl: input.baseUrl,
      controlId: input.controlId,
      selector: input.selector,
      generatedAt: new Date().toISOString(),
      evidence: {
        observations,
        rejectionReason: hasErrors ? "Interaction produced console or page errors" : "No unique observable success state was found"
      }
    };
  }
  return {
    name: input.name,
    confidence: "high",
    baseUrl: input.baseUrl,
    controlId: input.controlId,
    selector: input.selector,
    generatedAt: new Date().toISOString(),
    scenario: { target: input.selector, actions: [{ type: "click", selector: input.selector }], expect },
    evidence: { observations }
  };
}

function ensureLocalUrl(raw: string): URL {
  const url = new URL(raw);
  if (!new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(url.hostname)) {
    throw new Error("ButtonProbe scenario generation only supports localhost targets");
  }
  return url;
}

function stableControlId(attributes: { probeId: string | null; testId: string | null; domId: string | null }, selector: string): string {
  return attributes.probeId ?? attributes.testId ?? attributes.domId ?? (selector.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+|-+$/g, "") || "control");
}

export interface GenerateScenarioOptions {
  baseUrl: string;
  selector: string;
  name?: string;
  timeoutMs?: number;
  unsafe?: boolean;
}

export async function generateScenarioDraft(options: GenerateScenarioOptions): Promise<ScenarioDraft> {
  const base = ensureLocalUrl(options.baseUrl);
  const browser = await chromium.launch({ headless: true });
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const network: string[] = [];
  let interactionStarted = false;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (interactionStarted && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) {
        await route.abort();
        return;
      }
      await route.fallback();
    });
    const page = await context.newPage();
    page.on("console", (message) => {
      if (interactionStarted && message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => {
      if (interactionStarted) pageErrors.push(error.message);
    });
    page.on("response", (response) => {
      if (!interactionStarted || response.status() < 200 || response.status() >= 300) return;
      const request = response.request();
      if (!["xhr", "fetch"].includes(request.resourceType())) return;
      try {
        const responseUrl = new URL(response.url());
        if (responseUrl.origin === base.origin) network.push(`${request.method()} ${responseUrl.pathname}`);
      } catch {
        // Invalid response URLs do not become scenario evidence.
      }
    });
    await page.goto(base.href, { waitUntil: "domcontentloaded" });
    const locator = page.locator(options.selector).first();
    await locator.waitFor({ state: "visible", timeout: 5_000 });
    const details = await locator.evaluate((element) => {
      const html = element as HTMLElement;
      const input = element as HTMLInputElement;
      return {
        text: (html.innerText || input.value || html.getAttribute("title") || "").trim(),
        type: input.type || html.getAttribute("role") || html.tagName.toLowerCase(),
        probeId: html.getAttribute("data-bp-id"),
        testId: html.getAttribute("data-testid"),
        domId: html.id || null
      };
    });
    const dangerous = classifyDangerousControl({ text: details.text, type: details.type });
    if (dangerous && !options.unsafe) {
      return {
        name: options.name ?? stableControlId(details, options.selector),
        confidence: "insufficient-evidence",
        baseUrl: base.href,
        controlId: stableControlId(details, options.selector),
        selector: options.selector,
        generatedAt: new Date().toISOString(),
        evidence: { observations: [], rejectionReason: `Control is classified as dangerous: ${dangerous}` }
      };
    }
    const beforeText = await page.locator("body").innerText();
    const beforeUrl = page.url();
    const beforeTestIds = await page.locator("[data-testid]").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-testid")).filter(Boolean));
    interactionStarted = true;
    await locator.click({ timeout: 5_000 });
    await page.waitForTimeout(options.timeoutMs ?? 500);
    const afterText = await page.locator("body").innerText();
    const afterUrl = page.url();
    const afterTestIds = await page.locator("[data-testid]").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-testid")).filter(Boolean));
    const added = afterTestIds.filter((id) => !beforeTestIds.includes(id));
    const draft = synthesizeScenarioDraft({
      name: options.name ?? stableControlId(details, options.selector),
      baseUrl: base.href,
      controlId: stableControlId(details, options.selector),
      selector: options.selector,
      beforeText,
      afterText,
      beforeUrl,
      afterUrl,
      consoleErrors,
      pageErrors,
      network: [...new Set(network)],
      ...(added.length === 1 ? { visibleSelectors: [`[data-testid="${added[0]}"]`] } : {})
    });
    if (draft.scenario) draft.scenario.route = `${new URL(beforeUrl).pathname}${new URL(beforeUrl).search}`;
    await context.close();
    return draft;
  } finally {
    await browser.close();
  }
}

export async function writeScenarioDraft(path: string, draft: ScenarioDraft): Promise<GeneratedScenarios> {
  let current: GeneratedScenarios = { schemaVersion: 1, drafts: [] };
  if (await access(path).then(() => true).catch(() => false)) {
    current = JSON.parse(await readFile(path, "utf8")) as GeneratedScenarios;
    if (current.schemaVersion !== 1 || !Array.isArray(current.drafts)) throw new Error("Invalid generated scenario file");
  }
  const next = mergeScenarioDraft(current, draft);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function acceptScenarioDraft(input: {
  config: Record<string, unknown>;
  generated: GeneratedScenarios;
  name: string;
  force?: boolean;
}): { scenarios: Record<string, ScenarioContract>; [key: string]: unknown } {
  const draft = input.generated.drafts.find((candidate) => candidate.name === input.name);
  if (!draft) throw new Error(`Scenario draft "${input.name}" was not found`);
  if (draft.confidence !== "high" || !draft.scenario) throw new Error(`Scenario draft "${input.name}" is not high confidence`);
  const scenarios = { ...((input.config.scenarios as Record<string, ScenarioContract> | undefined) ?? {}) };
  if (scenarios[input.name] && !input.force) throw new Error(`Scenario "${input.name}" already exists; pass --force to overwrite it`);
  scenarios[input.name] = draft.scenario;
  return { ...input.config, scenarios };
}
