import { extname } from "node:path";
import type { RepairAttempt, RepairIssue, ScenarioContract, SourceCandidate } from "./types.js";

export type RepairTemplateId = "empty-onclick-setter" | "missing-route-navigation";

export interface RepairTemplateMatch {
  templateId: RepairTemplateId;
  path: string;
  diff: string;
  reason: string;
}

export interface RepairTemplateContext {
  scenario?: ScenarioContract;
}

export interface RepairTemplateProposal {
  attempt: RepairAttempt;
  templateId: RepairTemplateId;
}

export const TEMPLATE_AUTO_VERIFY_SCORE = 25;

export const repairTemplateDescriptions: Record<RepairTemplateId, string> = {
  "empty-onclick-setter":
    "Wires an empty onClick handler to the component's unique useState setter using the scenario's single text expectation as the new state value.",
  "missing-route-navigation":
    "Wires an empty onClick handler to a navigation call derived from the scenario's urlIncludes expectation."
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findTagEnd(content: string, start: number): number | undefined {
  let quote = "";
  let braces = 0;
  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    if (!character) continue;
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (["\"", "'", "`"].includes(character)) {
      quote = character;
      continue;
    }
    if (character === "{") braces += 1;
    else if (character === "}" && braces > 0) braces -= 1;
    else if (character === ">" && braces === 0) return index;
  }
  return undefined;
}

interface ControlTag {
  tagStart: number;
  tagEnd: number;
}

function findControlTag(content: string, issue: RepairIssue): ControlTag | undefined {
  const identityPatterns = [
    new RegExp(`data-testid\\s*=\\s*["']${escapeRegExp(issue.controlId)}["']`),
    new RegExp(`aria-label\\s*=\\s*["']${escapeRegExp(issue.label.trim())}["']`, "i")
  ];
  for (const pattern of identityPatterns) {
    const identity = pattern.exec(content);
    if (!identity || identity.index === undefined) continue;
    let tagStart = content.lastIndexOf("<", identity.index);
    while (tagStart !== -1 && !/^<[a-zA-Z]/.test(content.slice(tagStart, tagStart + 8))) {
      tagStart = content.lastIndexOf("<", tagStart - 1);
    }
    if (tagStart === -1) continue;
    const tagEnd = findTagEnd(content, tagStart);
    if (tagEnd === undefined || tagEnd < identity.index) continue;
    return { tagStart, tagEnd };
  }
  return undefined;
}

const EMPTY_ONCLICK_PATTERN = /onClick\s*=\s*\{\s*\(\s*\)\s*=>\s*\{\s*\}\s*\}/;

function useStateSetters(content: string): string[] {
  return [...content.matchAll(/(?:const|let)\s+\[[^\]]+,\s*(set[A-Z][\w$]*)\]\s*=\s*(?:React\.)?useState\s*[<(]/g)]
    .map((match) => match[1])
    .filter((setter): setter is string => Boolean(setter));
}

function usesReactRouterNavigate(content: string): boolean {
  return (
    /import\s+[^\n;]*from\s+["']react-router/.test(content) &&
    /const\s+navigate\s*=\s*useNavigate\s*\(\s*\)/.test(content)
  );
}

function singleLineReplacementDiff(filePath: string, content: string, offset: number, replacement: { start: number; end: number; text: string }): string | undefined {
  const lines = content.split("\n");
  if (content.endsWith("\n") && lines[lines.length - 1] === "") lines.pop();
  let consumed = 0;
  let lineIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const lineLength = (lines[index] ?? "").length + 1;
    if (offset >= consumed && offset < consumed + lineLength) {
      lineIndex = index;
      break;
    }
    consumed += lineLength;
  }
  if (lineIndex === -1) return undefined;
  const oldLine = lines[lineIndex] ?? "";
  const matchStartInLine = replacement.start - (content.lastIndexOf("\n", replacement.start - 1) + 1);
  const matchEndInLine = matchStartInLine + (replacement.end - replacement.start);
  if (matchEndInLine > oldLine.length) return undefined;
  const newLine = oldLine.slice(0, matchStartInLine) + replacement.text + oldLine.slice(matchEndInLine);
  const contextSize = 3;
  const start = Math.max(0, lineIndex - contextSize);
  const end = Math.min(lines.length - 1, lineIndex + contextSize);
  const body: string[] = [];
  for (let index = start; index <= end; index += 1) {
    if (index === lineIndex) {
      body.push(`-${oldLine}`);
      body.push(`+${newLine}`);
    } else {
      body.push(` ${lines[index]}`);
    }
  }
  const count = end - start + 1;
  return `--- a/${filePath}\n+++ b/${filePath}\n@@ -${start + 1},${count} +${start + 1},${count} @@\n${body.join("\n")}\n`;
}

/**
 * Deterministic, zero-model repair templates. A template only fires when the
 * top candidate carries strong identity, a resolved event chain, a score at or
 * above the auto-verify threshold, and scenario evidence that fully determines
 * the replacement. Anything ambiguous returns null and falls back to a model.
 */
export function matchRepairTemplates(
  issue: RepairIssue,
  candidates: SourceCandidate[],
  context: RepairTemplateContext = {}
): RepairTemplateMatch | null {
  const candidate = candidates[0];
  if (!candidate) return null;
  if (!candidate.strongIdentity) return null;
  if ((candidate.score ?? 0) < TEMPLATE_AUTO_VERIFY_SCORE) return null;
  if (!candidate.eventChain) return null;
  const extension = extname(candidate.path).toLowerCase();
  if (extension !== ".tsx" && extension !== ".jsx") return null;
  const content = candidate.content;
  const tag = findControlTag(content, issue);
  if (!tag) return null;
  const attributes = content.slice(tag.tagStart, tag.tagEnd + 1);
  const emptyOnClick = EMPTY_ONCLICK_PATTERN.exec(attributes);
  if (!emptyOnClick || emptyOnClick.index === undefined) return null;
  const matchStart = tag.tagStart + emptyOnClick.index;
  const matchEnd = matchStart + emptyOnClick[0].length;

  const expectations = context.scenario?.expect ?? [];
  const routeExpectation = expectations.find((expectation) => expectation.type === "urlIncludes");
  const textExpectations = expectations.filter((expectation) => expectation.type === "text");

  if (routeExpectation && routeExpectation.type === "urlIncludes") {
    const path = routeExpectation.value;
    if (!path.startsWith("/")) return null;
    const expression = usesReactRouterNavigate(content)
      ? `navigate(${JSON.stringify(path)})`
      : `window.history.pushState({}, "", ${JSON.stringify(path)})`;
    const diff = singleLineReplacementDiff(candidate.path, content, matchStart, {
      start: matchStart,
      end: matchEnd,
      text: `onClick={() => ${expression}}`
    });
    if (!diff) return null;
    return {
      templateId: "missing-route-navigation",
      path: candidate.path,
      diff,
      reason: `empty onClick replaced with ${expression} using scenario urlIncludes evidence "${path}"`
    };
  }

  if (textExpectations.length === 1 && textExpectations[0]?.type === "text") {
    const setters = useStateSetters(content);
    if (setters.length !== 1 || !setters[0]) return null;
    const value = textExpectations[0].value;
    const expression = `${setters[0]}(${JSON.stringify(value)})`;
    const diff = singleLineReplacementDiff(candidate.path, content, matchStart, {
      start: matchStart,
      end: matchEnd,
      text: `onClick={() => ${expression}}`
    });
    if (!diff) return null;
    return {
      templateId: "empty-onclick-setter",
      path: candidate.path,
      diff,
      reason: `empty onClick wired to unique useState setter ${setters[0]} using scenario text expectation "${value}"`
    };
  }

  return null;
}

export function buildTemplateAttempt(match: RepairTemplateMatch, issue: RepairIssue): RepairAttempt {
  return {
    diagnosis: `Deterministic template ${match.templateId}: ${match.reason}`,
    sourceConfidence: 1,
    expectedOutcome: "The target control changes visible UI state without regressions.",
    patch: match.diff,
    affectedControls: [issue.controlId],
    risk: "low"
  };
}
