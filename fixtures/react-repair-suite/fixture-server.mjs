import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const fixture = JSON.parse(readFileSync("case.json", "utf8"));
const port = Number(process.env.PORT ?? process.argv[2] ?? 5173);

createServer((_request, response) => {
  const source = readFileSync("src/App.tsx", "utf8");
  const repaired = fixture.normal || source === fixture.fixedSource;
  const targetWorks = repaired && !fixture.forceUiFailure;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html><html><body>
    <main>
      <h1>${fixture.name}</h1>
      <button data-testid="${fixture.testId}" ${targetWorks ? "onclick=\"document.getElementById('target-status').textContent='fixed'\"" : ""}>${fixture.label}</button>
      <span id="target-status">idle</span>
      <button data-testid="regression-guard" onclick="document.getElementById('guard-status').textContent='works'">Regression guard</button>
      <span id="guard-status">ready</span>
    </main>
  </body></html>`);
}).listen(port, "127.0.0.1");
