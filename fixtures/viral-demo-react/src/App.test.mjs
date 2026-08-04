import { readFileSync } from "node:fs";

if (process.env.VITEST) {
  const { test } = await import("vitest");
  test.skip("fixture repair check runs through node, not Vitest", () => {});
} else {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  const expectations = [
    "onClick={() => setEmptyFixed(true)}",
    "onClick={() => setCount((value) => value + 1)}",
    "onClick={() => setRoute(\"settings\")}",
    "onClick={() => setNormalSaved(true)}"
  ];

  for (const expected of expectations) {
    if (!source.includes(expected)) {
      console.error(`Missing repaired source marker: ${expected}`);
      process.exit(1);
    }
  }
}
