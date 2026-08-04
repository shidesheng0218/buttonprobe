import { chromium } from "playwright";
import { expect, test } from "vitest";
import { redactSensitivePage } from "../src/scanner.js";

test("redacts sensitive visible text and form values before screenshots", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <p>owner@example.com</p>
      <p>Authorization: Bearer abc.def.ghi</p>
      <input value="sk-secret-value">
    `);

    await redactSensitivePage(page);

    const html = await page.locator("body").innerHTML();
    expect(html).not.toContain("owner@example.com");
    expect(html).not.toContain("abc.def.ghi");
    expect(await page.locator("input").inputValue()).toBe("");
    expect(html).toContain("[REDACTED]");
  } finally {
    await browser.close();
  }
});
