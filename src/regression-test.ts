import { chromium } from "playwright";

export interface InteractionRegressionInput {
  controlId: string;
  label: string;
  route: string;
  selector: string;
}

export interface InteractionRegressionRun {
  url: string;
  selector: string;
  timeoutMs?: number;
}

export async function interactionChangesAfterClick(input: InteractionRegressionRun): Promise<boolean> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(input.url, { waitUntil: "domcontentloaded" });
    const target = page.locator(input.selector).first();
    await target.waitFor({ state: "visible", timeout: 5_000 });
    const snapshot = async () => ({
      url: page.url(),
      body: await page.locator("body").innerHTML(),
      aria: await target.evaluate((element) => ({
        expanded: element.getAttribute("aria-expanded"),
        pressed: element.getAttribute("aria-pressed"),
        checked: element.getAttribute("aria-checked")
      }))
    });
    const before = await snapshot();
    await target.click();
    await page.waitForTimeout(input.timeoutMs ?? 500);
    return JSON.stringify(await snapshot()) !== JSON.stringify(before);
  } catch {
    return false;
  } finally {
    await browser.close();
  }
}

function safeTestName(value: string): string {
  return value.replace(/[\r\n"]/g, " ").trim() || "interaction";
}

export function buildInteractionRegressionTest(input: InteractionRegressionInput): string {
  const route = JSON.stringify(input.route);
  const selector = JSON.stringify(input.selector);
  const name = JSON.stringify(`ButtonProbe regression: ${safeTestName(input.label)}`);
  return [
    'import { expect, test } from "playwright/test";',
    "",
    `test(${name}, async ({ page }) => {`,
    '  const baseUrl = process.env.BUTTONPROBE_BASE_URL ?? "http://localhost:5173";',
    `  await page.goto(new URL(${route}, baseUrl).href);`,
    `  const target = page.locator(${selector}).first();`,
    "  await expect(target).toBeVisible();",
    "  const before = {",
    "    url: page.url(),",
    "    body: await page.locator(\"body\").innerHTML(),",
    "    aria: await target.evaluate((element) => ({",
    "      expanded: element.getAttribute(\"aria-expanded\"),",
    "      pressed: element.getAttribute(\"aria-pressed\"),",
    "      checked: element.getAttribute(\"aria-checked\")",
    "    }))",
    "  };",
    "  await target.click();",
    "  await expect.poll(async () => ({",
    "    url: page.url(),",
    "    body: await page.locator(\"body\").innerHTML(),",
    "    aria: await target.evaluate((element) => ({",
    "      expanded: element.getAttribute(\"aria-expanded\"),",
    "      pressed: element.getAttribute(\"aria-pressed\"),",
    "      checked: element.getAttribute(\"aria-checked\")",
    "    }))",
    "  })).not.toEqual(before);",
    "});",
    ""
  ].join("\n");
}
