import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

test("publishes the Vite instrumentation adapter as a package subpath", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  expect(packageJson.exports["./vite"]).toEqual({
    types: "./dist/vite.d.ts",
    default: "./dist/vite.js"
  });
});
