import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { frameworkAdapterForPath, type SourceManifest } from "./framework-adapter.js";
import { redactSensitiveText } from "./privacy.js";
import type { RepairIssue, SourceCandidate } from "./types.js";

const roots = ["src", "app", "pages", "components", "test", "tests", "__tests__"];
const extensions = new Set([".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte"]);

async function walk(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (extensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findMatchingBrace(source: string, start: number): number | undefined {
  let depth = 0;
  let quote = "";
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
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
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function findJsxTagEnd(source: string, start: number): number | undefined {
  let quote = "";
  let braces = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
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

function jsxAttribute(attributes: string, name: string): string | undefined {
  const quoted = attributes.match(new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*["']([^"']+)["']`, "i"));
  if (quoted?.[1]) return quoted[1];
  return undefined;
}

function clickExpression(attributes: string): string | undefined {
  const match = attributes.match(/\bonClick\s*=\s*\{/);
  if (!match?.index && match?.index !== 0) return undefined;
  const start = match.index + match[0].length - 1;
  const end = findMatchingBrace(attributes, start);
  return end === undefined ? undefined : attributes.slice(start + 1, end).trim();
}

function handlerBody(source: string, name: string): string | undefined {
  const declaration = new RegExp(`(?:const|let|var)\\s+${escapeRegExp(name)}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>\\s*`, "m").exec(source);
  const functionDeclaration = new RegExp(`function\\s+${escapeRegExp(name)}\\s*\\([^)]*\\)\\s*`, "m").exec(source);
  const match = declaration ?? functionDeclaration;
  if (!match?.index && match?.index !== 0) return undefined;
  const start = match.index + match[0].length;
  const next = source.slice(start).match(/^\s*/)?.[0].length ?? 0;
  const bodyStart = start + next;
  if (source[bodyStart] === "{") {
    const bodyEnd = findMatchingBrace(source, bodyStart);
    return bodyEnd === undefined ? undefined : source.slice(bodyStart + 1, bodyEnd);
  }
  const bodyEnd = source.indexOf(";", bodyStart);
  return bodyEnd === -1 ? undefined : source.slice(bodyStart, bodyEnd);
}

function handlerEvidence(
  expression: string,
  source: string,
  setters: Set<string>,
  stateVariables: Set<string> = new Set()
): { score: number; reasons: string[]; handler?: string; calls: string[] } {
  const named = expression.match(/^[A-Za-z_$][\w$]*$/)?.[0];
  const body = named ? handlerBody(source, named) : expression;
  if (!body && !named) return { score: 0, reasons: [], calls: [] };
  let score = named ? 8 : 5;
  const reasons = [named ? `handler ${named}` : "inline click handler"];
  const calls: string[] = [];
  const searchableBody = body ?? "";
  for (const setter of setters) {
    if (new RegExp(`\\b${escapeRegExp(setter)}\\s*\\(`).test(searchableBody)) {
      score += 10;
      reasons.push(`handler calls ${setter}`);
      calls.push(setter);
    }
  }
  for (const stateVariable of stateVariables) {
    if (new RegExp(`\\b${escapeRegExp(stateVariable)}(?:\\.value)?\\s*=`).test(searchableBody)) {
      score += 10;
      reasons.push(`handler updates ${stateVariable}`);
      calls.push(stateVariable);
    }
  }
  const routerCall = searchableBody.match(/\b(navigate|push|replace)\s*\(|\b(?:router|history)\.(push|replace)\s*\(/);
  if (routerCall) {
    score += 10;
    reasons.push("handler calls router");
    calls.push(routerCall[1] ?? routerCall[2] ?? "router");
  }
  for (const hookCall of searchableBody.matchAll(/\b(use[A-Z][\w$]*)\s*\(/g)) {
    if (hookCall[1]) {
      score += 4;
      reasons.push(`handler calls custom hook ${hookCall[1]}`);
      calls.push(hookCall[1]);
    }
  }
  if (!body && named && /^on[A-Z]/.test(named)) {
    score += 8;
    reasons.push("callback prop");
    calls.push(named);
  }
  return { score, reasons, ...(named ? { handler: named } : {}), calls: [...new Set(calls)] };
}

function frameworkEventChainScore(content: string, path: string, issue: RepairIssue): {
  score: number;
  reasons: string[];
  eventChain?: SourceCandidate["eventChain"];
} {
  if (![".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte"].includes(extname(path).toLowerCase())) {
    return { score: 0, reasons: [] };
  }
  const adapter = frameworkAdapterForPath(path);
  const setters = new Set(
    [...content.matchAll(/(?:const|let)\s+\[[^\]]+,\s*(set[A-Z][\w$]*)\]\s*=\s*(?:React\.)?useState\s*\(/g)]
      .map((match) => match[1])
      .filter((setter): setter is string => Boolean(setter))
  );
  const stateVariables = new Set([
    ...content.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*ref\s*\(/g),
    ...(adapter.framework === "svelte"
      ? [...content.matchAll(/\blet\s+([A-Za-z_$][\w$]*)\s*=/g)]
      : [])
  ].map((match) => match[1]).filter((name): name is string => Boolean(name)));
  let score = 0;
  const reasons: string[] = [];
  let eventChain: SourceCandidate["eventChain"] | undefined;
  const tagPattern = /<(button|a|input|select|textarea)(?=[\s/>])/gi;
  for (const match of content.matchAll(tagPattern)) {
    const tag = match[1]?.toLowerCase();
    const start = match.index;
    if (!tag || start === undefined) continue;
    const end = findJsxTagEnd(content, start + match[0].length);
    if (end === undefined) continue;
    const attributes = content.slice(start + match[0].length, end);
    const closing = content.indexOf(`</${tag}>`, end + 1);
    const visibleText = closing === -1
      ? ""
      : content.slice(end + 1, closing).replace(/<[^>]+>|\{[^}]*\}/g, " ").replace(/\s+/g, " ").trim();
    const matched = jsxAttribute(attributes, "data-testid") === issue.controlId ||
      jsxAttribute(attributes, "aria-label") === issue.label.trim() || visibleText === issue.label.trim();
    if (!matched) continue;
    const binding = adapter.eventBinding(attributes);
    if (!binding.expression) continue;
    score += 12;
    reasons.push(
      binding.kind === "vue-click"
        ? "Vue event chain"
        : binding.kind === "svelte-click"
          ? "Svelte event chain"
          : "JSX event chain"
    );
    const controlIdentity = jsxAttribute(attributes, "data-testid")
      ? `${tag}[data-testid="${jsxAttribute(attributes, "data-testid")}"]`
      : jsxAttribute(attributes, "aria-label")
        ? `${tag}[aria-label="${jsxAttribute(attributes, "aria-label")}"]`
        : `${tag}[text="${visibleText}"]`;
    eventChain = {
      control: controlIdentity,
      calls: [],
      imports: [...content.matchAll(/\bimport\s+(?:\{[^}]+\}|[A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/g)]
        .map((importMatch) => importMatch[1])
        .filter((importPath): importPath is string => Boolean(importPath)),
      parentCandidates: []
    };
    const detail = handlerEvidence(binding.expression, content, setters, stateVariables);
    score += detail.score;
    reasons.push(...detail.reasons);
    eventChain = {
      ...eventChain,
      ...(detail.handler ? { handler: detail.handler } : {}),
      calls: detail.calls
    };
  }
  return { score, reasons: [...new Set(reasons)], ...(eventChain ? { eventChain } : {}) };
}

function sourceScore(content: string, issue: RepairIssue, path: string): { score: number; reasons: string[]; eventChain?: SourceCandidate["eventChain"] } {
  let score = 0;
  const reasons: string[] = [];
  const lower = content.toLowerCase();
  const label = issue.label.trim().toLowerCase();
  const id = issue.controlId.trim().toLowerCase();
  const exactVisibleText = Boolean(
    label && new RegExp(`>\\s*${escapeRegExp(issue.label.trim())}\\s*<`, "i").test(content)
  );
  if (label && lower.includes(label)) {
    score += 10;
    reasons.push(exactVisibleText ? "exact visible text" : "visible text");
  }
  let strongIdentity = exactVisibleText;
  if (id && lower.includes(id)) {
    const exactTestId = new RegExp(`data-testid\\s*=\\s*["']${escapeRegExp(issue.controlId)}["']`).test(content);
    score += exactTestId ? 14 : 8;
    reasons.push(exactTestId ? "data-testid" : "control id");
    strongIdentity ||= exactTestId;
  }
  if (
    issue.label.trim() &&
    new RegExp(`aria-label\\s*=\\s*["']${escapeRegExp(issue.label.trim())}["']`, "i").test(content)
  ) {
    score += 8;
    reasons.push("aria-label");
    strongIdentity = true;
  }
  const route = new URL(issue.pageUrl).pathname.split("/").filter(Boolean).pop()?.toLowerCase();
  if (route && lower.includes(route)) {
    score += 2;
    reasons.push("route path");
  }
  if (/<button[\s\S]{0,500}(?:\bonClick\s*=|@click\s*=|v-on:click\s*=|on:click\s*=|\bonclick\s*=)|<[^>]+(?:\bonClick\s*=|@click\s*=|v-on:click\s*=|on:click\s*=|\bonclick\s*=)/i.test(content)) {
    score += 1;
    reasons.push([".vue", ".svelte"].includes(extname(path).toLowerCase())
      ? "nearby framework event handler"
      : "nearby JSX event handler");
  }
  const setters = [...content.matchAll(/const\s+\[[^\]]+,\s*(set[A-Z]\w*)\]\s*=\s*useState/g)].map((match) => match[1]);
  if (setters.some((setter) => setter && new RegExp(`\\b${escapeRegExp(setter)}\\s*\\(`).test(content))) {
    score += 3;
    reasons.push("hook setter");
  }
  if (/\b(navigate|router\.(push|replace)|history\.push)\s*\(/.test(content)) {
    score += 4;
    reasons.push("router call");
  }
  const fileName = basename(path, extname(path)).toLowerCase();
  const labelWords = label.split(/\s+/).filter((word) => word.length >= 4);
  if ((route && fileName.includes(route)) || labelWords.some((word) => fileName.includes(word))) {
    score += 3;
    reasons.push("component file name");
  }
  if (/\bimport\s+.*from\b/.test(content)) {
    score += 1;
    reasons.push("imported component context");
  }
  const eventChain = frameworkEventChainScore(content, path, issue);
  score += eventChain.score;
  reasons.push(...eventChain.reasons);
  if (strongIdentity) reasons.push("strong identity");
  return { score, reasons: [...new Set(reasons)], ...(eventChain.eventChain ? { eventChain: eventChain.eventChain } : {}) };
}

export function isTrustedSourceCandidate(candidate: SourceCandidate | undefined): boolean {
  return Boolean(
    candidate &&
      (candidate.score ?? 0) >= 25 &&
      candidate.strongIdentity &&
      (candidate.eventChain || candidate.reason?.includes("compiler instrumentation"))
  );
}

async function instrumentedCandidate(projectRoot: string, issue: RepairIssue): Promise<SourceCandidate | undefined> {
  let manifest: SourceManifest;
  try {
    manifest = JSON.parse(await readFile(join(projectRoot, ".buttonprobe", "source-manifest.json"), "utf8")) as SourceManifest;
  } catch {
    return undefined;
  }
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries)) return undefined;
  const entry = manifest.entries.find((candidate) => candidate.id === issue.controlId);
  if (!entry || entry.path.startsWith("../") || !extensions.has(extname(entry.path))) return undefined;
  try {
    const sourcePath = join(projectRoot, entry.path);
    const content = await readFile(sourcePath, "utf8");
    return {
      path: entry.path,
      content: redactSensitiveText(content.length > 12_000 ? `${content.slice(0, 12_000)}\n/* truncated */` : content),
      score: 100,
      reason: `compiler instrumentation: ${entry.framework} ${entry.path}:${entry.line}:${entry.column}`,
      strongIdentity: true,
      eventChain: {
        control: `data-bp-id:${entry.id}`,
        calls: [],
        imports: [],
        parentCandidates: []
      }
    };
  } catch {
    return undefined;
  }
}

export async function locateSourceCandidates(
  projectRoot: string,
  issue: RepairIssue
): Promise<SourceCandidate[]> {
  const instrumented = await instrumentedCandidate(projectRoot, issue);
  if (instrumented) return [instrumented];
  const files = (
    await Promise.all(roots.map((root) => walk(join(projectRoot, root))))
  ).flat();
  const fileContents = new Map<string, string>();
  for (const path of files) fileContents.set(path, await readFile(path, "utf8"));
  const candidates: SourceCandidate[] = [];
  for (const path of files) {
    const content = fileContents.get(path) ?? "";
    const { score, reasons, eventChain } = sourceScore(content, issue, path);
    if (score === 0) continue;
    const relativePath = relative(projectRoot, path);
    const componentName = basename(path, extname(path));
    const parentCandidates = eventChain?.handler
      ? [...fileContents.entries()]
          .filter(([parentPath, parentContent]) =>
            parentPath !== path &&
            parentContent.includes(componentName) &&
            parentContent.includes(eventChain.handler!)
          )
          .map(([parentPath]) => relative(projectRoot, parentPath))
      : [];
    const enrichedEventChain = eventChain
      ? { ...eventChain, parentCandidates: [...new Set(parentCandidates)] }
      : undefined;
    if (parentCandidates.length > 0 && !reasons.includes("callback prop")) reasons.push("callback prop");
    candidates.push({
      path: relativePath,
      content: redactSensitiveText(content.length > 12_000 ? `${content.slice(0, 12_000)}\n/* truncated */` : content),
      score,
      reason: reasons.join(", "),
      strongIdentity: reasons.includes("strong identity"),
      ...(enrichedEventChain ? { eventChain: enrichedEventChain } : {})
    });
  }
  return candidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 5);
}
