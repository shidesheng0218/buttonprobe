import { expect, test } from "vitest";
import { buildInteractionRegressionTest } from "../src/regression-test.js";

test("generates a stable Playwright regression test from a control identity", () => {
  const source = buildInteractionRegressionTest({
    controlId: "bp_increment",
    label: "Increment",
    route: "/counter",
    selector: '[data-bp-id="bp_increment"]'
  });

  expect(source).toContain('test("ButtonProbe regression: Increment"');
  expect(source).toContain('const baseUrl = process.env.BUTTONPROBE_BASE_URL ?? "http://localhost:5173"');
  expect(source).toContain('await page.goto(new URL("/counter", baseUrl).href);');
  expect(source).toContain('page.locator("[data-bp-id=\\\"bp_increment\\\"]")');
  expect(source).toContain("await target.click();");
  expect(source).toContain("expect.poll(async () => ({");
  expect(source).toContain("})).not.toEqual(before);");
});
