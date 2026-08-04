import type { RepairRequestContext } from "./types.js";
import { redactSensitiveText } from "./privacy.js";

const outputSchema = {
  diagnosis: "string",
  sourceConfidence: "number between 0 and 1",
  expectedOutcome: "string",
  patch: "unified diff string",
  affectedControls: ["control id"],
  risk: "low | medium | high"
};

function compactPreviousAttempts(context: RepairRequestContext): unknown[] {
  return context.previousAttempts.map((record) => ({
    round: record.round,
    decision: record.decision,
    reason: record.reason,
    patch: record.attempt?.patch,
    testOutput: record.tests?.output,
    regressions: record.ui?.regressions
  }));
}

export function buildRepairPrompt(context: RepairRequestContext): string {
  let remainingCharacters = 30_000;
  const sources = context.sources.slice(0, 5).map((source) => {
    const header = `FILE: ${source.path}\n`;
    const allowance = Math.max(0, Math.min(source.content.length, remainingCharacters - header.length));
    remainingCharacters -= header.length + allowance;
    return `${header}${source.content.slice(0, allowance)}`;
  });

  return [
    "You repair one UI interaction in a TypeScript/JavaScript React application.",
    "Return JSON only. The patch must be a valid unified diff rooted at the repository.",
    "Do not install dependencies, edit configuration, change package scripts, or return shell commands.",
    "Keep the change minimal and preserve controls that already work.",
    `Round: ${context.round} of 3`,
    `Issue: ${redactSensitiveText(JSON.stringify(context.issue))}`,
    `Previous attempts: ${JSON.stringify(compactPreviousAttempts(context))}`,
    `Allowed source candidates:\n${sources.join("\n\n")}`,
    `Required output schema: ${JSON.stringify(outputSchema)}`
  ].join("\n\n");
}
