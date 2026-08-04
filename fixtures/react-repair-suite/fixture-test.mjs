import { readFileSync } from "node:fs";

const fixture = JSON.parse(readFileSync("case.json", "utf8"));
const source = readFileSync("src/App.tsx", "utf8");
if (!fixture.normal && source !== fixture.fixedSource) {
  console.error(`Expected repaired source for ${fixture.name}`);
  process.exit(1);
}
