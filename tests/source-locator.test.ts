import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { isTrustedSourceCandidate, locateSourceCandidates } from "../src/source-locator.js";
import type { RepairIssue } from "../src/types.js";

test("locates React source by visible label and test id", async () => {
  const root = await mkdtemp(join(tmpdir(), "buttonprobe-source-"));
  await mkdir(join(root, "src"));
  await writeFile(
    join(root, "src/App.tsx"),
    '<button data-testid="increment-button" onClick={() => {}}>Increment</button>\n'
  );
  await writeFile(join(root, "src/Other.tsx"), "<div>Unrelated content</div>\n");

  const issue: RepairIssue = {
    controlId: "increment-button",
    pageUrl: "http://localhost:3000/counter",
    label: "Increment",
    verdict: "INERT",
    evidence: { beforeScreenshot: "before.png", afterScreenshot: "after.png", signals: [] }
  };

  const candidates = await locateSourceCandidates(root, issue);
  expect(candidates[0]?.path).toBe("src/App.tsx");
  expect(candidates[0]?.content).toContain("Increment");
  expect(candidates[0]?.reason).toContain("data-testid");
  expect(candidates[0]?.score).toBeGreaterThan(10);
});

test("adds deterministic JSX-aware source candidate reasons", async () => {
  const root = await mkdtemp(join(tmpdir(), "buttonprobe-jsx-source-"));
  await mkdir(join(root, "src"));
  await writeFile(
    join(root, "src", "SettingsPanel.tsx"),
    [
      'import { useState } from "react";',
      'import { useNavigate } from "react-router-dom";',
      "export function SettingsPanel() {",
      "  const navigate = useNavigate();",
      "  const [open, setOpen] = useState(false);",
      "  const openSettings = () => { setOpen(true); navigate('/settings'); };",
      '  return <button aria-label="Open settings" onClick={openSettings}>Open settings</button>;',
      "}"
    ].join("\n")
  );
  await writeFile(join(root, "src", "Decoy.tsx"), "<button>Open settings</button>\n");

  const issue: RepairIssue = {
    controlId: "open-settings",
    pageUrl: "http://localhost:3000/settings",
    label: "Open settings",
    verdict: "INERT",
    evidence: { beforeScreenshot: "before.png", afterScreenshot: "after.png", signals: [] }
  };

  const [candidate] = await locateSourceCandidates(root, issue);

  expect(candidate?.path).toBe("src/SettingsPanel.tsx");
  expect(candidate?.reason).toContain("aria-label");
  expect(candidate?.reason).toContain("nearby JSX event handler");
  expect(candidate?.reason).toContain("hook setter");
  expect(candidate?.reason).toContain("router call");
  expect(candidate?.reason).toContain("component file name");
  expect(candidate?.reason).toContain("imported component context");
  expect(isTrustedSourceCandidate(candidate)).toBe(true);
});

test("traces a matched JSX control through its named handler and React state setter", async () => {
  const root = await mkdtemp(join(tmpdir(), "buttonprobe-ast-source-"));
  await mkdir(join(root, "src"));
  await writeFile(
    join(root, "src", "ProfileForm.tsx"),
    [
      'import { useState } from "react";',
      "export function ProfileForm() {",
      "  const [saved, setSaved] = useState(false);",
      "  const saveProfile = () => setSaved(true);",
      '  return <button data-testid="save-profile" onClick={saveProfile}>Save profile</button>;',
      "}"
    ].join("\n")
  );
  await writeFile(
    join(root, "src", "Decoy.tsx"),
    'const saveProfile = () => undefined; export const Decoy = () => <button>Save profile</button>;\n'
  );

  const [candidate] = await locateSourceCandidates(root, {
    controlId: "save-profile",
    pageUrl: "http://localhost:3000/profile",
    label: "Save profile",
    verdict: "INERT",
    evidence: { beforeScreenshot: "before.png", afterScreenshot: "after.png", signals: [] }
  });

  expect(candidate?.path).toBe("src/ProfileForm.tsx");
  expect(candidate?.reason).toContain("JSX event chain");
  expect(candidate?.reason).toContain("handler saveProfile");
  expect(candidate?.reason).toContain("handler calls setSaved");
  expect(candidate?.eventChain).toMatchObject({
    control: "button[data-testid=\"save-profile\"]",
    handler: "saveProfile",
    calls: ["setSaved"]
  });
  expect(candidate?.score).toBeGreaterThanOrEqual(30);
  expect(isTrustedSourceCandidate(candidate)).toBe(true);
});

test("traces a callback prop through parent and imported child component candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "buttonprobe-callback-source-"));
  await mkdir(join(root, "src", "components"), { recursive: true });
  await writeFile(
    join(root, "src", "App.tsx"),
    [
      'import { SaveButton } from "./components/SaveButton";',
      "export function App() {",
      "  const saveProfile = () => setStatus('Saved');",
      '  return <SaveButton onSave={saveProfile} />;',
      "}"
    ].join("\n")
  );
  await writeFile(
    join(root, "src", "components", "SaveButton.tsx"),
    [
      "export function SaveButton({ onSave }: { onSave: () => void }) {",
      '  return <button data-testid="save-profile" onClick={onSave}>Save profile</button>;',
      "}"
    ].join("\n")
  );

  const [candidate] = await locateSourceCandidates(root, {
    controlId: "save-profile",
    pageUrl: "http://localhost:3000/profile",
    label: "Save profile",
    verdict: "INERT",
    evidence: { beforeScreenshot: "before.png", afterScreenshot: "after.png", signals: [] }
  });

  expect(candidate?.path).toBe("src/components/SaveButton.tsx");
  expect(candidate?.eventChain?.handler).toBe("onSave");
  expect(candidate?.eventChain?.parentCandidates).toContain("src/App.tsx");
  expect(candidate?.reason).toContain("callback prop");
  expect(isTrustedSourceCandidate(candidate)).toBe(true);
});

test("requires a strong identity and event chain for automatic verification", () => {
  expect(isTrustedSourceCandidate({
    path: "src/App.tsx",
    content: "",
    score: 30,
    strongIdentity: true,
    reason: "data-testid, exact visible text"
  })).toBe(false);
  expect(isTrustedSourceCandidate({
    path: "src/App.tsx",
    content: "",
    score: 30,
    strongIdentity: true,
    reason: "data-testid, JSX event chain",
    eventChain: { control: "button[data-testid=\"save\"]", calls: [], imports: [], parentCandidates: [] }
  })).toBe(true);
});

test("rejects automatic verification when source identity is weak", async () => {
  const root = await mkdtemp(join(tmpdir(), "buttonprobe-weak-source-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "Copy.tsx"), "export const copy = 'Open settings';\n");
  const issue: RepairIssue = {
    controlId: "open-settings",
    pageUrl: "http://localhost:3000/settings",
    label: "Open settings",
    verdict: "INERT",
    evidence: { beforeScreenshot: "before.png", afterScreenshot: "after.png", signals: [] }
  };

  const [candidate] = await locateSourceCandidates(root, issue);

  expect(candidate?.score).toBeLessThan(20);
  expect(isTrustedSourceCandidate(candidate)).toBe(false);
});

test("uses a compiler instrumentation manifest as the highest-confidence source mapping", async () => {
  const root = await mkdtemp(join(tmpdir(), "buttonprobe-manifest-source-"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, ".buttonprobe"));
  await writeFile(join(root, "src", "Checkout.tsx"), 'export const Checkout = () => <button data-bp-id="bp_checkout">Pay</button>;\n');
  await writeFile(
    join(root, ".buttonprobe", "source-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      entries: [
        {
          id: "bp_checkout",
          framework: "react",
          path: "src/Checkout.tsx",
          line: 1,
          column: 31,
          identity: "checkout",
          label: "Pay"
        }
      ]
    })
  );
  const issue: RepairIssue = {
    controlId: "bp_checkout",
    pageUrl: "http://localhost:3000/checkout",
    label: "Pay",
    verdict: "INERT",
    evidence: { beforeScreenshot: "before.png", afterScreenshot: "after.png", signals: [] }
  };

  const [candidate] = await locateSourceCandidates(root, issue);

  expect(candidate).toMatchObject({ path: "src/Checkout.tsx", score: 100, strongIdentity: true });
  expect(candidate?.reason).toContain("compiler instrumentation");
  expect(isTrustedSourceCandidate(candidate)).toBe(true);
});

test("traces a Vue click handler through a ref state update", async () => {
  const root = await mkdtemp(join(tmpdir(), "buttonprobe-vue-source-"));
  await mkdir(join(root, "src"));
  await writeFile(
    join(root, "src", "ProfileForm.vue"),
    [
      '<script setup lang="ts">',
      'import { ref } from "vue";',
      'const saved = ref(false);',
      'const saveProfile = () => { saved.value = true; };',
      '</script>',
      '<template><button data-testid="save-profile" @click="saveProfile">Save profile</button></template>'
    ].join("\n")
  );

  const [candidate] = await locateSourceCandidates(root, {
    controlId: "save-profile",
    pageUrl: "http://localhost:5173/profile",
    label: "Save profile",
    verdict: "INERT",
    evidence: { beforeScreenshot: "before.png", afterScreenshot: "after.png", signals: [] }
  });

  expect(candidate?.path).toBe("src/ProfileForm.vue");
  expect(candidate?.reason).toContain("Vue event chain");
  expect(candidate?.eventChain).toMatchObject({ handler: "saveProfile", calls: ["saved"] });
  expect(isTrustedSourceCandidate(candidate)).toBe(true);
});

test("traces a Svelte click handler through a reactive assignment", async () => {
  const root = await mkdtemp(join(tmpdir(), "buttonprobe-svelte-source-"));
  await mkdir(join(root, "src"));
  await writeFile(
    join(root, "src", "ProfileForm.svelte"),
    [
      '<script>',
      'let saved = false;',
      'function saveProfile() { saved = true; }',
      '</script>',
      '<button data-testid="save-profile" on:click={saveProfile}>Save profile</button>'
    ].join("\n")
  );

  const [candidate] = await locateSourceCandidates(root, {
    controlId: "save-profile",
    pageUrl: "http://localhost:5173/profile",
    label: "Save profile",
    verdict: "INERT",
    evidence: { beforeScreenshot: "before.png", afterScreenshot: "after.png", signals: [] }
  });

  expect(candidate?.path).toBe("src/ProfileForm.svelte");
  expect(candidate?.reason).toContain("Svelte event chain");
  expect(candidate?.eventChain).toMatchObject({ handler: "saveProfile", calls: ["saved"] });
  expect(isTrustedSourceCandidate(candidate)).toBe(true);
});
