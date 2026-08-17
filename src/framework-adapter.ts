import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";

export type SupportedFramework = "react" | "vue" | "svelte" | "next" | "angular" | "unknown";

export interface SourceManifestEntry {
  id: string;
  framework: SupportedFramework;
  path: string;
  line: number;
  column: number;
  identity: string;
  label: string;
}

export interface SourceManifest {
  schemaVersion: 1;
  entries: SourceManifestEntry[];
}

export interface InstrumentSourceResult {
  code: string;
  entries: SourceManifestEntry[];
}

export interface FrameworkEventBinding {
  kind: "react-click" | "vue-click" | "svelte-click" | "unknown";
  expression?: string;
}

export interface FrameworkSourceAdapter {
  framework: Exclude<SupportedFramework, "angular" | "unknown">;
  instrument(source: string, filePath: string, projectRoot: string): InstrumentSourceResult;
  eventBinding(attributes: string): FrameworkEventBinding;
}

export interface ButtonProbeVitePluginOptions {
  root?: string;
  manifestPath?: string;
}

export interface VitePluginLike {
  name: string;
  enforce?: "pre" | "post";
  configResolved?: (config: { root: string; command?: "serve" | "build"; mode?: string }) => void | Promise<void>;
  transform?: (code: string, id: string) => { code: string; map: null } | undefined | Promise<{ code: string; map: null } | undefined>;
  buildEnd?: () => void | Promise<void>;
}

const sourceExtensions = new Set([".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte", ".html"]);
const interactiveStart = /<(button|a|input|select|textarea)(?=[\s/>])/gi;

function frameworkForPath(path: string): SupportedFramework {
  const extension = extname(path).toLowerCase();
  if (extension === ".vue") return "vue";
  if (extension === ".svelte") return "svelte";
  if (extension === ".html") return "angular";
  if (/(?:^|\/)app\//.test(path.replaceAll("\\", "/"))) return "next";
  if ([".tsx", ".jsx"].includes(extension)) return "react";
  return "unknown";
}

function bracedAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*=\\s*\\{([^}]+)\\}`).exec(attributes);
  return match?.[1]?.trim();
}

function quotedAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*=\\s*["']([^"']+)["']`).exec(attributes);
  return match?.[1]?.trim();
}

export function frameworkAdapterForPath(filePath: string): FrameworkSourceAdapter {
  const framework = frameworkForPath(filePath);
  const supported = framework === "vue" || framework === "svelte" || framework === "next" ? framework : "react";
  return {
    framework: supported,
    instrument: instrumentSource,
    eventBinding(attributes) {
      if (supported === "vue") {
        const expression = quotedAttribute(attributes, "@click") ?? quotedAttribute(attributes, "v-on:click");
        return expression ? { kind: "vue-click", expression } : { kind: "unknown" };
      }
      if (supported === "svelte") {
        const expression = bracedAttribute(attributes, "on:click") ?? bracedAttribute(attributes, "onclick");
        return expression ? { kind: "svelte-click", expression } : { kind: "unknown" };
      }
      const expression = bracedAttribute(attributes, "onClick");
      return expression ? { kind: "react-click", expression } : { kind: "unknown" };
    }
  };
}

function findTagEnd(source: string, start: number): number | undefined {
  let quote = "";
  let braceDepth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (!character) continue;
    if (quote) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") {
      braceDepth += 1;
      continue;
    }
    if (character === "}" && braceDepth > 0) {
      braceDepth -= 1;
      continue;
    }
    if (character === ">" && braceDepth === 0) return index;
  }
  return undefined;
}

function attributeValue(attributes: string, name: string): string | undefined {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match?.[1]?.trim();
}

function textAfterTag(source: string, tagEnd: number, tagName: string): string {
  if (["input", "select", "textarea"].includes(tagName)) return "";
  const closing = new RegExp(`</${tagName}\\s*>`, "i");
  const tail = source.slice(tagEnd + 1);
  const match = closing.exec(tail);
  if (!match?.index) return "";
  return tail.slice(0, match.index).replace(/<[^>]+>/g, " ").replace(/\{[^}]*\}/g, " ").replace(/\s+/g, " ").trim();
}

function lineAndColumn(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, offset);
  const lastBreak = before.lastIndexOf("\n");
  return { line: before.split("\n").length, column: offset - lastBreak };
}

function controlId(framework: SupportedFramework, sourcePath: string, line: number, column: number, identity: string): string {
  const digest = createHash("sha256")
    .update(`${framework}:${sourcePath}:${line}:${column}:${identity}`)
    .digest("hex")
    .slice(0, 16);
  return `bp_${digest}`;
}

export function instrumentSource(source: string, filePath: string, projectRoot: string): InstrumentSourceResult {
  const path = relative(projectRoot, filePath).replaceAll("\\", "/");
  const framework = frameworkForPath(path);
  if (!sourceExtensions.has(extname(filePath).toLowerCase())) return { code: source, entries: [] };

  const entries: SourceManifestEntry[] = [];
  const insertions: Array<{ position: number; text: string }> = [];
  for (const match of source.matchAll(interactiveStart)) {
    const tagName = match[1]?.toLowerCase();
    const start = match.index;
    if (!tagName || start === undefined) continue;
    const tagEnd = findTagEnd(source, start + match[0].length);
    if (tagEnd === undefined) continue;
    const attributes = source.slice(start + match[0].length, tagEnd);
    if (/\bdata-bp-id\s*=/.test(attributes)) continue;
    const position = source[tagEnd - 1] === "/" ? tagEnd - 1 : tagEnd;
    const coordinates = lineAndColumn(source, start);
    const label = textAfterTag(source, tagEnd, tagName);
    const identity = (
      attributeValue(attributes, "data-testid") ??
      attributeValue(attributes, "aria-label") ??
      attributeValue(attributes, "id") ??
      label
    ) || tagName;
    const id = controlId(framework, path, coordinates.line, coordinates.column, identity);
    entries.push({ id, framework, path, ...coordinates, identity, label });
    insertions.push({ position, text: ` data-bp-id="${id}"` });
  }
  let code = source;
  for (const insertion of insertions.sort((left, right) => right.position - left.position)) {
    code = `${code.slice(0, insertion.position)}${insertion.text}${code.slice(insertion.position)}`;
  }
  return { code, entries };
}

export function createButtonProbeVitePlugin(options: ButtonProbeVitePluginOptions = {}): VitePluginLike {
  let root = resolve(options.root ?? process.cwd());
  let enabled = true;
  const entries = new Map<string, SourceManifestEntry>();
  const manifestPath = (): string => resolve(root, options.manifestPath ?? ".buttonprobe/source-manifest.json");

  return {
    name: "buttonprobe:source-instrumentation",
    enforce: "pre",
    configResolved(config) {
      root = resolve(config.root);
      enabled = config.command !== "build" || config.mode === "test";
    },
    transform(source, id) {
      if (!enabled) return undefined;
      const cleanId = id.split("?", 1)[0];
      if (!cleanId || cleanId.includes("/node_modules/")) return undefined;
      const result = instrumentSource(source, cleanId, root);
      for (const entry of result.entries) entries.set(entry.id, entry);
      return result.entries.length > 0 ? { code: result.code, map: null } : undefined;
    },
    async buildEnd() {
      const manifest: SourceManifest = {
        schemaVersion: 1,
        entries: [...entries.values()].sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line)
      };
      const path = manifestPath();
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
    }
  };
}
