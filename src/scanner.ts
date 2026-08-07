import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, firefox, webkit, type Browser, type BrowserType, type Locator, type Page } from "playwright";
import { classifyDangerousControl } from "./danger.js";
import type { BrowserName, ControlSignal, FailureClass, NetworkSafetyMode, PageScan, ScanControl, ScanResult } from "./types.js";

export interface ScanOptions {
  baseUrl: string;
  outputDir: string;
  maxPages?: number;
  interactionTimeoutMs?: number;
  unsafe?: boolean;
  networkMode?: NetworkSafetyMode;
  storageState?: string;
  routes?: string[];
  replayHar?: string;
  browserName?: BrowserName;
}

export function browserTypeForName(browserName: BrowserName = "chromium"): BrowserType {
  return browserName === "firefox" ? firefox : browserName === "webkit" ? webkit : chromium;
}

interface ControlDescriptor {
  index: number;
  id: string;
  probeId: string;
  testId: string;
  domId: string;
  text: string;
  ariaLabel: string;
  tagName: string;
  type: string;
  selector: string;
}

const interactiveSelector =
  'button, a[href], input[type="button"], input[type="submit"], [role="button"], [onclick]';

export async function retryTransientPageRead<T>(
  operation: () => Promise<T>,
  onRetry: () => Promise<void> = async () => undefined
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const message = (error as Error).message;
    if (!/execution context was destroyed|most likely because of a navigation/i.test(message)) {
      throw error;
    }
    await onRetry();
    return operation();
  }
}

function ensureLocalUrl(raw: string): URL {
  const url = new URL(raw);
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (!localHosts.has(url.hostname)) {
    throw new Error("ButtonProbe only scans localhost targets by default");
  }
  return url;
}

export async function redactSensitivePage(page: Page): Promise<void> {
  await page.locator('input:not([type="button"]):not([type="submit"]), textarea').evaluateAll((elements) => {
    for (const element of elements) {
      const field = element as HTMLInputElement | HTMLTextAreaElement;
      field.value = "";
      field.setAttribute("value", "");
    }
  });
  await page.locator("body").evaluate((body) => {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (node.nodeValue) {
        node.nodeValue = node.nodeValue
          .replace(/\bAuthorization\s*:\s*Bearer\s+[^\s"']+/gi, "Authorization: Bearer [REDACTED]")
          .replace(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
          .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED]");
      }
      node = walker.nextNode();
    }
  });
}

async function describeControls(page: Page, pageIndex: number): Promise<ControlDescriptor[]> {
  return page.locator(interactiveSelector).evaluateAll((elements, index) => {
    return elements
      .filter((element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      })
      .map((element, controlIndex) => {
        const html = element as HTMLElement;
        const input = element as HTMLInputElement;
        const probeId = html.getAttribute("data-bp-id") ?? "";
        const testId = html.getAttribute("data-testid") ?? "";
        const domId = html.id ?? "";
        const text = (html.innerText || input.value || html.getAttribute("title") || "").trim();
        const tagName = html.tagName.toLowerCase();
        const type = input.type || html.getAttribute("role") || tagName;
        const selector = probeId
          ? `[data-bp-id="${CSS.escape(probeId)}"]`
          : testId
            ? `[data-testid="${CSS.escape(testId)}"]`
          : domId
            ? `#${CSS.escape(domId)}`
            : `${tagName}:nth-of-type(${controlIndex + 1})`;
        return {
          index: controlIndex,
          id: probeId || testId || domId || `control-${index + 1}-${controlIndex + 1}`,
          probeId,
          testId,
          domId,
          text,
          ariaLabel: html.getAttribute("aria-label") ?? "",
          tagName,
          type,
          selector
        };
      });
  }, pageIndex);
}

function controlLocator(page: Page, descriptor: ControlDescriptor): Locator {
  if (descriptor.probeId) return page.locator(`[data-bp-id="${descriptor.probeId.replaceAll('"', '\\"')}"]`).first();
  if (descriptor.testId) return page.locator(`[data-testid="${descriptor.testId.replaceAll('"', '\\"')}"]`).first();
  if (descriptor.domId) return page.locator(`#${descriptor.domId.replaceAll('"', '\\"')}`).first();
  return page.locator(interactiveSelector).nth(descriptor.index);
}

async function collectRoutes(page: Page, base: URL, maxPages: number): Promise<string[]> {
  const hrefs = await page.locator("a[href]").evaluateAll((anchors) =>
    anchors.map((anchor) => (anchor as HTMLAnchorElement).href)
  );
  const routes = [base.href];
  for (const href of hrefs) {
    try {
      const candidate = new URL(href);
      candidate.hash = "";
      if (candidate.origin !== base.origin || routes.includes(candidate.href)) continue;
      routes.push(candidate.href);
      if (routes.length >= maxPages) break;
    } catch {
      // Ignore malformed application links.
    }
  }
  return routes;
}

function configuredRoutes(base: URL, routes: string[] | undefined, maxPages: number): string[] | undefined {
  if (!routes?.length) return undefined;
  const result = [base.href];
  for (const route of routes) {
    try {
      const candidate = new URL(route, base);
      candidate.hash = "";
      if (candidate.origin === base.origin && !result.includes(candidate.href)) result.push(candidate.href);
      if (result.length >= maxPages) break;
    } catch {
      // Invalid configured routes do not expand the scan scope.
    }
  }
  return result;
}

async function screenshotControl(locator: Locator, path: string, page: Page): Promise<void> {
  try {
    await locator.screenshot({ path });
  } catch {
    await page.screenshot({ path, fullPage: false });
  }
}

async function scanControl(
  browser: Browser,
  pageUrl: string,
  descriptor: ControlDescriptor,
  outputDir: string,
  interactionTimeoutMs: number,
  unsafe: boolean,
  networkMode: NetworkSafetyMode,
  storageState: string | undefined,
  replayHar: string | undefined
): Promise<ScanControl> {
  const safeName = descriptor.id.replace(/[^a-zA-Z0-9_-]/g, "-");
  const beforeRelative = `screenshots/${safeName}-before.png`;
  const afterRelative = `screenshots/${safeName}-after.png`;
  const dangerousReason = classifyDangerousControl({ text: descriptor.text, type: descriptor.type });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1280, height: 800 },
    ...(storageState ? { storageState } : {})
  });
  const page = await context.newPage();
  const signals: ControlSignal[] = [];
  const errors: string[] = [];
  let interactionStarted = false;
  let blockedMutation = false;
  let responseFailure: FailureClass | undefined;

  if (networkMode === "replay" && replayHar) {
    await context.routeFromHAR(replayHar, { notFound: "abort", update: false });
  }

  await context.route("**/*", async (route) => {
    const request = route.request();
    if (
      networkMode === "observe" &&
      interactionStarted &&
      ["POST", "PUT", "PATCH", "DELETE"].includes(request.method())
    ) {
      blockedMutation = true;
      signals.push({ type: "network", detail: `BLOCKED_MUTATION ${request.method()} ${request.url()}` });
      await route.abort();
      return;
    }
    await route.fallback();
  });

  page.on("pageerror", (error) => {
    if (interactionStarted) errors.push(error.message);
  });
  page.on("console", (message) => {
    if (interactionStarted && message.type() === "error") errors.push(message.text());
  });
  page.on("request", (request) => {
    if (!interactionStarted) return;
    if (["xhr", "fetch"].includes(request.resourceType())) {
      signals.push({ type: "network", detail: `${request.method()} ${request.url()}` });
    }
  });
  page.on("response", (response) => {
    if (!interactionStarted) return;
    const request = response.request();
    if (!["xhr", "fetch"].includes(request.resourceType())) return;
    const status = response.status();
    if (status < 400) return;
    signals.push({ type: "network", detail: `${request.method()} ${request.url()} -> HTTP ${status}` });
    if (status === 401 || status === 403) responseFailure = "AUTH_REQUIRED";
    else if (status === 429) responseFailure = "RATE_LIMITED";
    else if (status >= 500) responseFailure = "BACKEND_5XX";
    else responseFailure = "BACKEND_4XX";
  });
  context.on("page", () => {
    if (interactionStarted) signals.push({ type: "popup", detail: "Opened a new page" });
  });

  await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
  await redactSensitivePage(page);
  const locator = controlLocator(page, descriptor);
  await locator.waitFor({ state: "visible", timeout: 5_000 });
  await screenshotControl(locator, join(outputDir, beforeRelative), page);

  if (dangerousReason && !unsafe) {
    await screenshotControl(locator, join(outputDir, afterRelative), page);
    await context.close();
    return {
      id: descriptor.id,
      pageUrl,
      selector: descriptor.selector,
      tagName: descriptor.tagName,
      type: descriptor.type,
      text: descriptor.text,
      ariaLabel: descriptor.ariaLabel,
      testId: descriptor.testId,
      ...(descriptor.probeId ? { probeId: descriptor.probeId } : {}),
      verdict: "SKIPPED",
      dangerousReason,
      evidence: { beforeScreenshot: beforeRelative, afterScreenshot: afterRelative, signals }
    };
  }

  const beforeUrl = page.url();
  const beforeHtml = await page.locator("body").innerHTML();
  const beforeState = await locator.evaluate((element) => ({
    expanded: element.getAttribute("aria-expanded"),
    pressed: element.getAttribute("aria-pressed"),
    checked: element.getAttribute("aria-checked")
  }));
  const beforeLayers = await page.locator('[role="dialog"]:visible, dialog[open], [role="menu"]:visible, [role="alert"]:visible').count();

  interactionStarted = true;
  try {
    await locator.click({ timeout: 5_000 });
  } catch (error) {
    errors.push((error as Error).message);
  }
  await page.waitForTimeout(interactionTimeoutMs);

  if (page.url() !== beforeUrl) signals.push({ type: "url", detail: `${beforeUrl} -> ${page.url()}` });
  const afterHtml = await page.locator("body").innerHTML().catch(() => "");
  if (afterHtml && afterHtml !== beforeHtml) signals.push({ type: "dom", detail: "Visible page structure changed" });
  const afterLayers = await page
    .locator('[role="dialog"]:visible, dialog[open], [role="menu"]:visible, [role="alert"]:visible')
    .count()
    .catch(() => beforeLayers);
  if (afterLayers > beforeLayers) signals.push({ type: "dialog", detail: "A dialog, menu, or alert became visible" });

  if (await locator.count().catch(() => 0)) {
    const afterState = await locator.evaluate((element) => ({
      expanded: element.getAttribute("aria-expanded"),
      pressed: element.getAttribute("aria-pressed"),
      checked: element.getAttribute("aria-checked")
    }));
    if (JSON.stringify(afterState) !== JSON.stringify(beforeState)) {
      signals.push({ type: "aria", detail: "ARIA state changed" });
    }
  }
  for (const error of errors) signals.push({ type: "console", detail: error });
  await screenshotControl(locator, join(outputDir, afterRelative), page);

  const failureClass = blockedMutation
    ? "BLOCKED_MUTATION"
    : responseFailure ?? (errors.length > 0 ? "FRONTEND_CRASH" : undefined);
  const verdict = failureClass === "BLOCKED_MUTATION"
    ? "BLOCKED_MUTATION"
    : failureClass === "AUTH_REQUIRED"
      ? "AUTH_REQUIRED"
      : failureClass === "RATE_LIMITED"
        ? "RATE_LIMITED"
        : failureClass === "BACKEND_4XX" || failureClass === "BACKEND_5XX"
          ? "BACKEND_ERROR"
          : failureClass === "FRONTEND_CRASH"
            ? "CRASHED"
            : signals.length > 0
              ? "WORKS"
              : "INERT";
  await context.close();
  return {
    id: descriptor.id,
    pageUrl,
    selector: descriptor.selector,
    tagName: descriptor.tagName,
    type: descriptor.type,
    text: descriptor.text,
    ariaLabel: descriptor.ariaLabel,
    testId: descriptor.testId,
    ...(descriptor.probeId ? { probeId: descriptor.probeId } : {}),
    verdict,
    ...(failureClass ? { failureClass } : {}),
    evidence: { beforeScreenshot: beforeRelative, afterScreenshot: afterRelative, signals }
  };
}

export async function scanApplication(options: ScanOptions): Promise<ScanResult> {
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const base = ensureLocalUrl(options.baseUrl);
  const maxPages = Math.min(Math.max(options.maxPages ?? 5, 1), 5);
  const interactionTimeoutMs = options.interactionTimeoutMs ?? 750;
  await mkdir(join(options.outputDir, "screenshots"), { recursive: true });

  const browser = await browserTypeForName(options.browserName).launch({ headless: true });
  try {
    const discoveryContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      ...(options.storageState ? { storageState: options.storageState } : {})
    });
    if (options.networkMode === "replay" && options.replayHar) {
      await discoveryContext.routeFromHAR(options.replayHar, { notFound: "abort", update: false });
    }
    const discoveryPage = await discoveryContext.newPage();
    await discoveryPage.goto(base.href, { waitUntil: "domcontentloaded" });
    const routes = await retryTransientPageRead(
      async () => configuredRoutes(base, options.routes, maxPages) ?? collectRoutes(discoveryPage, base, maxPages),
      async () => {
        await discoveryPage.waitForLoadState("domcontentloaded");
      }
    );
    await discoveryContext.close();

    const pages: PageScan[] = [];
    for (let pageIndex = 0; pageIndex < routes.length; pageIndex += 1) {
      const route = routes[pageIndex];
      if (!route) continue;
      const pageContext = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        ...(options.storageState ? { storageState: options.storageState } : {})
      });
      if (options.networkMode === "replay" && options.replayHar) {
        await pageContext.routeFromHAR(options.replayHar, { notFound: "abort", update: false });
      }
      const page = await pageContext.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(route, { waitUntil: "domcontentloaded" });
      const { title, descriptors } = await retryTransientPageRead(
        async () => {
          await redactSensitivePage(page);
          return { title: await page.title(), descriptors: await describeControls(page, pageIndex) };
        },
        async () => {
          await page.waitForLoadState("domcontentloaded");
        }
      );
      const pageScreenshot = `screenshots/page-${pageIndex + 1}.png`;
      await page.screenshot({ path: join(options.outputDir, pageScreenshot), fullPage: true });
      await pageContext.close();

      const controls: ScanControl[] = [];
      for (const descriptor of descriptors.slice(0, 100)) {
        controls.push(
          await scanControl(
            browser,
            route,
            descriptor,
            options.outputDir,
            interactionTimeoutMs,
            options.unsafe ?? false,
            options.networkMode ?? "observe",
            options.storageState,
            options.replayHar
          )
        );
      }
      pages.push({ url: route, title, screenshot: pageScreenshot, controls, errors });
    }

    return {
      schemaVersion: 1,
      startedAt: startedAtIso,
      durationMs: Date.now() - startedAt,
      baseUrl: base.href,
      pages
    };
  } finally {
    await browser.close();
  }
}
