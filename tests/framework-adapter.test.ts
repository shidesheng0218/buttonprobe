import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createButtonProbeVitePlugin, frameworkAdapterForPath, instrumentSource } from "../src/framework-adapter.js";

test("instruments React controls with stable local source identities", () => {
  const source = [
    "export function Counter() {",
    '  return <button data-testid="increment" onClick={() => {}}>Increment</button>; ',
    "}"
  ].join("\n");

  const result = instrumentSource(source, "/repo/src/Counter.tsx", "/repo");

  expect(result.code).toContain('data-bp-id="bp_');
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]).toMatchObject({
    framework: "react",
    path: "src/Counter.tsx",
    identity: "increment",
    label: "Increment"
  });
  expect(instrumentSource(source, "/repo/src/Counter.tsx", "/repo").entries[0]?.id).toBe(result.entries[0]?.id);
});

test("writes a local manifest for Vue and Svelte controls", async () => {
  const root = await mkdtemp(join(tmpdir(), "buttonprobe-adapter-"));
  const plugin = createButtonProbeVitePlugin({ root, manifestPath: ".buttonprobe/source-manifest.json" });
  await plugin.configResolved?.({ root });
  await plugin.transform?.('<button aria-label="Save">Save</button>', join(root, "src", "Save.vue"));
  await plugin.transform?.('<button>Cancel</button>', join(root, "src", "Cancel.svelte"));
  await plugin.buildEnd?.();

  const manifest = JSON.parse(await readFile(join(root, ".buttonprobe", "source-manifest.json"), "utf8"));
  expect(manifest.schemaVersion).toBe(1);
  expect(manifest.entries.map((entry: { framework: string }) => entry.framework)).toEqual(["svelte", "vue"]);
  expect(manifest.entries.every((entry: { id: string }) => entry.id.startsWith("bp_"))).toBe(true);
});

test("does not inject source metadata into Vite production builds", async () => {
  const root = await mkdtemp(join(tmpdir(), "buttonprobe-production-adapter-"));
  const plugin = createButtonProbeVitePlugin({ root });
  await plugin.configResolved?.({ root, command: "build", mode: "production" });

  const result = await plugin.transform?.('<button data-testid="save">Save</button>', join(root, "src", "Save.tsx"));

  expect(result).toBeUndefined();
});

test("recognizes Vue and Svelte click bindings through framework adapters", () => {
  expect(frameworkAdapterForPath("/repo/src/Save.vue").eventBinding('<button @click="save">Save</button>')).toMatchObject({
    expression: "save",
    kind: "vue-click"
  });
  expect(frameworkAdapterForPath("/repo/src/Save.svelte").eventBinding('<button on:click={save}>Save</button>')).toMatchObject({
    expression: "save",
    kind: "svelte-click"
  });
});
