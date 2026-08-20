import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const fixture = JSON.parse(readFileSync("case.json", "utf8"));
const port = Number(process.env.PORT ?? 11435);

function unifiedDiff(filePath, before, after) {
  const oldLines = before.trimEnd().split("\n");
  const newLines = after.trimEnd().split("\n");
  const lines = [];
  const length = Math.max(oldLines.length, newLines.length);
  for (let index = 0; index < length; index += 1) {
    const oldLine = oldLines[index];
    const newLine = newLines[index];
    if (oldLine === newLine && oldLine !== undefined) lines.push(` ${oldLine}`);
    else {
      if (oldLine !== undefined) lines.push(`-${oldLine}`);
      if (newLine !== undefined) lines.push(`+${newLine}`);
    }
  }
  return `--- a/${filePath}\n+++ b/${filePath}\n@@ -1,${oldLines.length} +1,${newLines.length} @@\n${lines.join("\n")}\n`;
}

createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const analysis = body.includes("Analyze every supplied UI control");
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({
    choices: [{ message: { content: analysis
      ? JSON.stringify({ assessments: [
          {
            controlId: fixture.testId,
            expectedBehavior: "Change visible UI state",
            observedBehavior: fixture.normal ? "Visible state changed" : "No visible effect",
            verdict: fixture.normal ? "WORKS" : "INERT",
            confidence: 0.95,
            explanation: fixture.normal ? "The target control works." : "The target handler is inert."
          },
          {
            controlId: "regression-guard",
            expectedBehavior: "Change visible UI state",
            observedBehavior: "Visible state changed",
            verdict: "WORKS",
            confidence: 0.99,
            explanation: "The regression guard works."
          }
        ] })
      : JSON.stringify({
          diagnosis: `Repair ${fixture.name}`,
          sourceConfidence: 0.99,
          expectedOutcome: "The target control changes visible UI state.",
          patch: unifiedDiff(fixture.sourceFile ?? "src/App.tsx", fixture.source, fixture.fixedSource),
          affectedControls: [fixture.testId],
          risk: "low"
        }) } }],
    usage: { prompt_tokens: 240, completion_tokens: analysis ? 80 : 160 }
  }));
}).listen(port, "127.0.0.1");
