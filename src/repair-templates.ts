import { extname } from "node:path";
import type { RepairAttempt, RepairIssue, ScenarioContract, SourceCandidate } from "./types.js";

export type RepairTemplateId = "empty-onclick-setter" | "missing-route-navigation" | "noop-state-update";

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
    "Wires an empty onClick handler to a navigation call derived from the scenario's urlIncludes expectation.",
  "noop-state-update":
    "Replaces a self-assigning onClick setter call (setX(x) where x is the same useState state identifier) with the scenario's single text expectation as the new state value."
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
const NOOP_STATE_PATTERN = /onClick\s*=\s*\{\s*\(\s*\)\s*=>\s*(set[A-Z][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\}/;

function useStateSetters(content: string): string[] {
  return [...content.matchAll(/(?:const|let)\s+\[[^\]]+,\s*(set[A-Z][\w$]*)\]\s*=\s*(?:React\.)?useState\s*[<(]/g)]
    .map((match) => match[1])
    .filter((setter): setter is string => Boolean(setter));
}

function useStatePairs(content: string): Array<{ state: string; setter: string }> {
  return [...content.matchAll(/(?:const|let)\s+\[\s*([A-Za-z_$][\w$]*)\s*,\s*(set[A-Z][\w$]*)\s*\]\s*=\s*(?:React\.)?useState\s*[<(]/g)]
    .map((match) => ({ state: match[1] ?? "", setter: match[2] ?? "" }))
    .filter((pair) => pair.state && pair.setter);
}

function vueRefNames(content: string): string[] {
  return [...content.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*ref\s*\(/g)]
    .map((match) => match[1])
    .filter((name): name is string => Boolean(name));
}

function vueClickHandler(attributes: string): string | undefined {
  const match = attributes.match(/(?:@click|v-on:click)\s*=\s*["']\s*([A-Za-z_$][\w$]*)\s*["']/);
  return match?.[1];
}

function vueFunctionBody(content: string, name: string): { start: number; end: number; body: string } | undefined {
  const declaration = new RegExp(`function\\s+${escapeRegExp(name)}\\s*\\([^)]*\\)\\s*\\{`, "m").exec(content);
  if (!declaration || declaration.index === undefined) return undefined;
  const bodyStart = declaration.index + declaration[0].length;
  const bodyEnd = content.indexOf("}", bodyStart);
  if (bodyEnd === -1) return undefined;
  return { start: bodyStart, end: bodyEnd, body: content.slice(bodyStart, bodyEnd) };
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
  if (extension !== ".tsx" && extension !== ".jsx" && extension !== ".vue") return null;
  const content = candidate.content;
  const tag = findControlTag(content, issue);
  if (!tag) return null;
  const attributes = content.slice(tag.tagStart, tag.tagEnd + 1);
  const expectations = context.scenario?.expect ?? [];
  const routeExpectation = expectations.find((expectation) => expectation.type === "urlIncludes");
  const textExpectations = expectations.filter((expectation) => expectation.type === "text");

  if (extension === ".vue") {
    const handlerName = vueClickHandler(attributes);
    const handler = handlerName ? vueFunctionBody(content, handlerName) : undefined;
    const refs = vueRefNames(content);
    if (!handlerName || !handler) return null;
    const refName = refs[0];
    const replaceHandlerBody = (body: string, templateId: RepairTemplateId, reason: string): RepairTemplateMatch | null => {
      const next = `${content.slice(0, handler.start)}${body}${content.slice(handler.end)}`;
      const diff = singleLineReplacementDiff(candidate.path, content, handler.start, {
        start: handler.start,
        end: handler.end,
        text: body
      });
      return diff ? { templateId, path: candidate.path, diff, reason } : null;
    };
    if (handler.body.trim() === "") {
      if (routeExpectation && routeExpectation.type === "urlIncludes" && routeExpectation.value.startsWith("/")) {
        const path = routeExpectation.value;
        return replaceHandlerBody(
          ` window.history.pushState({}, "", ${JSON.stringify(path)}); `,
          "missing-route-navigation",
          `empty Vue handler ${handlerName} replaced with history navigation to "${path}"`
        );
      }
      if (refs.length === 1 && textExpectations.length === 1 && textExpectations[0]?.type === "text") {
        const value = textExpectations[0].value;
        return replaceHandlerBody(
          ` ${refName}.value = ${JSON.stringify(value)}; `,
          "empty-onclick-setter",
          `empty Vue handler ${handlerName} wired to ref ${refName} using scenario text expectation "${value}"`
        );
      }
      return null;
    }
    const noop = /\b([A-Za-z_$][\w$]*)\.value\s*=\s*\1\.value\s*;?/.exec(handler.body);
    if (noop && refs.includes(noop[1] ?? "") && textExpectations.length === 1 && textExpectations[0]?.type === "text") {
      const value = textExpectations[0].value;
      const noopRef = noop[1] ?? "";
      const body = handler.body.slice(0, noop.index) + `${noopRef}.value = ${JSON.stringify(value)};` + handler.body.slice(noop.index + noop[0].length);
      return replaceHandlerBody(
        body,
        "noop-state-update",
        `self-assigning Vue ref ${noopRef} replaced with the scenario text expectation "${value}"`
      );
    }
    return null;
  }

  const emptyOnClick = EMPTY_ONCLICK_PATTERN.exec(attributes);
  if (emptyOnClick && emptyOnClick.index !== undefined) {
    const matchStart = tag.tagStart + emptyOnClick.index;
    const matchEnd = matchStart + emptyOnClick[0].length;

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

  const noopState = NOOP_STATE_PATTERN.exec(attributes);
  if (noopState && noopState.index !== undefined) {
    const setter = noopState[1] ?? "";
    const argument = noopState[2] ?? "";
    const statePair = useStatePairs(content).find((pair) => pair.setter === setter);
    if (!statePair || statePair.state !== argument) return null;
    if (textExpectations.length !== 1 || textExpectations[0]?.type !== "text") return null;
    const value = textExpectations[0].value;
    const matchStart = tag.tagStart + noopState.index;
    const matchEnd = matchStart + noopState[0].length;
    const diff = singleLineReplacementDiff(candidate.path, content, matchStart, {
      start: matchStart,
      end: matchEnd,
      text: `onClick={() => ${setter}(${JSON.stringify(value)})}`
    });
    if (!diff) return null;
    return {
      templateId: "noop-state-update",
      path: candidate.path,
      diff,
      reason: `self-assigning ${setter}(${argument}) replaced with ${setter}(${JSON.stringify(value)}) using scenario text expectation "${value}"`
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
