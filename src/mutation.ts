export type UiMutationId = "empty-onclick-setter" | "noop-state-update" | "missing-route-navigation";

export interface UiMutationInput {
  source: string;
  filePath: string;
  selector: string;
  mutation: UiMutationId;
}

export interface UiMutationResult {
  mutation: UiMutationId;
  source: string;
  patch: string;
}

export interface MutationCaseExpectation {
  selector: string;
  mutation: UiMutationId;
  expectText?: string;
  expectUrlIncludes?: string;
}

function selectorIdentity(selector: string): { attribute: string; value: string } | null {
  const match = /^\[([\w-]+)=["']([^"']+)["']\]$/.exec(selector.trim());
  return match ? { attribute: match[1] ?? "", value: match[2] ?? "" } : null;
}

function tagForSelector(source: string, selector: string): { start: number; end: number; tag: string } | null {
  const identity = selectorIdentity(selector);
  if (!identity) return null;
  const escaped = identity.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`${identity.attribute}\\s*=\\s*["']${escaped}["']`, "g");
  const match = expression.exec(source);
  if (!match || match.index === undefined) return null;
  const start = source.lastIndexOf("<", match.index);
  if (start < 0) return null;
  let quote = "";
  let braces = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") braces += 1;
    else if (character === "}" && braces > 0) braces -= 1;
    else if (character === ">" && braces === 0) {
      const end = index + 1;
      return { start, end, tag: source.slice(start, end) };
    }
  }
  return null;
}

function singleLinePatch(filePath: string, before: string, after: string): string {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const index = beforeLines.findIndex((line, lineIndex) => line !== afterLines[lineIndex]);
  if (index < 0) return "";
  const start = Math.max(0, index - 1);
  const end = Math.min(beforeLines.length - 1, index + 1);
  const body: string[] = [];
  for (let cursor = start; cursor <= end; cursor += 1) {
    if (cursor === index) {
      body.push(`-${beforeLines[cursor] ?? ""}`);
      body.push(`+${afterLines[cursor] ?? ""}`);
    } else {
      body.push(` ${beforeLines[cursor] ?? ""}`);
    }
  }
  const count = end - start + 1;
  return `--- a/${filePath}\n+++ b/${filePath}\n@@ -${start + 1},${count} +${start + 1},${count} @@\n${body.join("\n")}\n`;
}

function reactStatePair(source: string): { state: string; setter: string } | null {
  const match = /(?:const|let)\s+\[\s*([A-Za-z_$][\w$]*)\s*,\s*(set[A-Z][\w$]*)\s*\]\s*=\s*(?:React\.)?useState/.exec(source);
  return match ? { state: match[1] ?? "", setter: match[2] ?? "" } : null;
}

function reactHandler(tag: string): RegExpExecArray | null {
  const start = /onClick\s*=\s*\{/.exec(tag);
  if (!start || start.index === undefined) return null;
  let depth = 0;
  for (let index = start.index + start[0].length - 1; index < tag.length; index += 1) {
    const character = tag[index] ?? "";
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        const full = tag.slice(start.index, index + 1);
        const body = /^onClick\s*=\s*\{\s*\(\s*\)\s*=>\s*([\s\S]*?)\s*\}$/.exec(full);
        if (!body) return null;
        const result = [...body] as RegExpExecArray;
        result.index = start.index;
        result.input = tag;
        return result;
      }
    }
  }
  return null;
}

function vueHandlerName(tag: string): string | undefined {
  return /(?:@click|v-on:click)\s*=\s*["']\s*([A-Za-z_$][\w$]*)\s*["']/.exec(tag)?.[1];
}

function vueHandlerBody(source: string, handler: string): { start: number; end: number; body: string } | null {
  const match = new RegExp(`function\\s+${handler}\\s*\\([^)]*\\)\\s*\\{`, "m").exec(source);
  if (!match || match.index === undefined) return null;
  const start = match.index + match[0].length;
  let depth = 1;
  let quote = "";
  for (let index = start; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return { start, end: index, body: source.slice(start, index) };
    }
  }
  return null;
}

export function validateMutationCase(input: MutationCaseExpectation): void {
  if (!selectorIdentity(input.selector)) throw new Error("Mutation selector must be an exact attribute selector");
  if (input.mutation === "missing-route-navigation" && !input.expectUrlIncludes) {
    throw new Error("missing-route-navigation requires expectUrlIncludes");
  }
  if (input.mutation !== "missing-route-navigation" && !input.expectText) {
    throw new Error(`${input.mutation} requires expectText`);
  }
}

export function applyUiMutation(input: UiMutationInput): UiMutationResult | null {
  const tag = tagForSelector(input.source, input.selector);
  if (!tag) return null;
  const reactPair = reactStatePair(input.source);
  let next = input.source;
  if (input.mutation === "empty-onclick-setter") {
    const handler = reactHandler(tag.tag);
    if (handler && reactPair) {
      next = `${input.source.slice(0, tag.start)}${tag.tag.replace(handler[0], "onClick={() => {}}")}${input.source.slice(tag.end)}`;
    } else if (/\.vue$/.test(input.filePath)) {
      const handler = vueHandlerName(tag.tag);
      const body = handler ? vueHandlerBody(input.source, handler) : null;
      if (!body) return null;
      next = `${input.source.slice(0, body.start)}${input.source.slice(body.end)}`;
    } else return null;
  } else if (input.mutation === "noop-state-update") {
    const handler = reactHandler(tag.tag);
    if (handler && reactPair && new RegExp(`${reactPair.setter}\\s*\\(`).test(handler[1] ?? "")) {
      next = `${input.source.slice(0, tag.start)}${tag.tag.replace(handler[0], `onClick={() => ${reactPair.setter}(${reactPair.state})}`)}${input.source.slice(tag.end)}`;
    } else if (/\.vue$/.test(input.filePath)) {
      const handler = vueHandlerName(tag.tag);
      const body = handler ? vueHandlerBody(input.source, handler) : null;
      const assignment = body?.body.match(/\b([A-Za-z_$][\w$]*)\.value\s*=\s*[^;]+;?/);
      if (!body || !assignment?.[1]) return null;
      const state = assignment[1];
      const nextBody = body.body.replace(assignment[0], `${state}.value = ${state}.value;`);
      next = `${input.source.slice(0, body.start)}${nextBody}${input.source.slice(body.end)}`;
    } else return null;
  } else {
    const handler = reactHandler(tag.tag);
    if (handler) {
      next = `${input.source.slice(0, tag.start)}${tag.tag.replace(handler[0], "onClick={() => {}}")}${input.source.slice(tag.end)}`;
    } else if (/\.vue$/.test(input.filePath)) {
      const handler = vueHandlerName(tag.tag);
      const body = handler ? vueHandlerBody(input.source, handler) : null;
      if (!body) return null;
      next = `${input.source.slice(0, body.start)}${input.source.slice(body.end)}`;
    } else return null;
  }
  return { mutation: input.mutation, source: next, patch: singleLinePatch(input.filePath, input.source, next) };
}
