import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadPatchInput, runPatchVerification, validateProofArtifacts } from "../src/patch-proof.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return `http://127.0.0.1:${address.port}`;
}

async function createRepo() {
  const root = await mkdtemp(join(tmpdir(), "buttonprobe-proof-"));
  await mkdir(join(root, "src"));
  await writeFile(
    join(root, "src", "App.tsx"),
    [
      "export const enabled = false;",
      "export const breakNormal = false;",
      ""
    ].join("\n")
  );
  await writeFile(
    join(root, "server.mjs"),
    [
      'import { createServer } from "node:http";',
      'import { readFileSync } from "node:fs";',
      'const port = Number(process.env.PORT);',
      'createServer((_request, response) => {',
      '  const source = readFileSync("src/App.tsx", "utf8");',
      '  const enabled = source.includes("enabled = true");',
      '  const breakNormal = source.includes("breakNormal = true");',
      '  response.setHeader("content-type", "text/html");',
      '  response.end(`<button data-testid="save" onclick="${enabled ? "this.textContent=\\\'Saved\\\'" : ""}">Save</button><button data-testid="normal" onclick="${breakNormal ? "" : "this.textContent=\\\'Normal done\\\'"}">Normal</button>`);',
      '}).listen(port, "127.0.0.1");'
    ].join("\n")
  );
  await writeFile(join(root, ".gitignore"), ".buttonprobe\nnode_modules\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=ButtonProbe", "-c", "user.email=test@example.com", "commit", "-m", "initial"], {
    cwd: root
  });
  return root;
}

describe("patch proof verification", () => {
  test("verifies an external patch without model calls or current checkout writes", async () => {
    const root = await createRepo();
    const original = await readFile(join(root, "src", "App.tsx"), "utf8");
    const app = await listen(createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end('<button data-testid="save">Save</button><button data-testid="normal" onclick="this.textContent=\'Normal done\'">Normal</button>');
    }));
    const outputDir = join(root, ".buttonprobe", "proof");
    const patch = join(root, "agent.diff");
    await writeFile(
      patch,
      "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1,2 +1,2 @@\n-export const enabled = false;\n+export const enabled = true;\n export const breakNormal = false;\n"
    );

    const result = await runPatchVerification({
      baseUrl: app,
      patchPath: patch,
      projectRoot: root,
      outputDir,
      testCommand: "node -e \"const fs=require('fs');if(!fs.readFileSync('src/App.tsx','utf8').includes('enabled = true'))process.exit(1)\"",
      devCommand: "node server.mjs",
      interactionTimeoutMs: 40
    });

    expect(result.status).toBe("ui-verified");
    expect(result.usageSummary.modelCalls).toBe(0);
    expect(result.originalCheckoutModified).toBe(false);
    expect(await readFile(join(root, "src", "App.tsx"), "utf8")).toBe(original);
    await stat(join(outputDir, "proof.json"));
    await expect(readFile(join(outputDir, "verified.diff"), "utf8")).resolves.toContain("enabled = true");
    await expect(validateProofArtifacts(join(outputDir, "proof.json"), outputDir)).resolves.toBeUndefined();
  });

  test("rejects an external patch that breaks a same-page working control", async () => {
    const root = await createRepo();
    const app = await listen(createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end('<button data-testid="save">Save</button><button data-testid="normal" onclick="this.textContent=\'Normal done\'">Normal</button>');
    }));
    const outputDir = join(root, ".buttonprobe", "proof-regression");
    const patch = join(root, "agent.diff");
    await writeFile(
      patch,
      "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1,2 +1,2 @@\n-export const enabled = false;\n-export const breakNormal = false;\n+export const enabled = true;\n+export const breakNormal = true;\n"
    );

    const result = await runPatchVerification({
      baseUrl: app,
      patchPath: patch,
      projectRoot: root,
      outputDir,
      testCommand: "node -e \"process.exit(0)\"",
      devCommand: "node server.mjs",
      interactionTimeoutMs: 40
    });

    expect(result.status).toBe("rejected");
    expect(result.ui?.regressions).toContain("normal");
    expect(result.reason).toContain("regressions");
  });

  test("loads a GitHub-style remote diff without using the model", async () => {
    const patchText = "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1 +1 @@\n-old\n+new\n";
    const patchServer = await listen(createServer((_request, response) => {
      response.setHeader("content-type", "text/plain");
      response.end(patchText);
    }));

    const patch = await loadPatchInput({ patchUrl: `${patchServer}/pull/1.diff` });

    expect(patch.source).toContain("/pull/1.diff");
    expect(patch.content).toBe(patchText);
  });

  test("rejects non-unified remote patch content", async () => {
    const patchServer = await listen(createServer((_request, response) => {
      response.setHeader("content-type", "text/plain");
      response.end("not a diff");
    }));

    await expect(loadPatchInput({ patchUrl: `${patchServer}/pull/1.diff` })).rejects.toThrow("unified diff");
  });
});
