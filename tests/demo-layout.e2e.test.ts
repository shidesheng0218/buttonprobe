import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";

let vite: ViteDevServer;
let browser: Browser;
let url: string;

beforeAll(async () => {
  vite = await createServer({
    root: join(process.cwd(), "demo"),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 }
  });
  await vite.listen();
  const address = vite.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Missing Vite address");
  url = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
  await vite.close();
});

test("uses icon-only navigation on mobile without overlapping items", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(url, { waitUntil: "networkidle" });

  const labels = page.locator("nav button .nav-label");
  expect(await labels.count()).toBe(3);
  for (const label of await labels.all()) expect(await label.isHidden()).toBe(true);

  const boxes = await page.locator("nav > *").evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right };
    })
  );
  for (let index = 1; index < boxes.length; index += 1) {
    expect(boxes[index]!.left).toBeGreaterThanOrEqual(boxes[index - 1]!.right);
  }
  await page.close();
});
