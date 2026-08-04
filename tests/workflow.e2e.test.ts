import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runButtonProbe } from "../src/workflow.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return `http://127.0.0.1:${address.port}`;
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "buttonprobe-workflow-"));
  await mkdir(join(root, "src"));
  const sourcePath = join(root, "src/App.tsx");
  await writeFile(
    sourcePath,
    [
      "export function App() {",
      "  const enabled = false;",
      '  return <button data-testid="increment">Increment</button>;',
      "}",
      ""
    ].join("\n")
  );
  await writeFile(
    join(root, "server.mjs"),
    [
      'import { createServer } from "node:http";',
      'import { readFileSync } from "node:fs";',
      'createServer((_request, response) => {',
      '  const source = readFileSync("src/App.tsx", "utf8");',
      '  const enabled = source.includes("const enabled = true");',
      '  response.setHeader("content-type", "text/html");',
      '  response.end(`<button data-testid="increment" onclick="${enabled ? "this.textContent=\\\'Incremented\\\'" : ""}">Increment</button>`);',
      '}).listen(Number(process.env.PORT), "127.0.0.1");'
    ].join("\n")
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.name=ButtonProbe", "-c", "user.email=test@example.com", "commit", "-m", "initial"],
    { cwd: root }
  );

  const appUrl = await listen(
    createServer(async (_request, response) => {
      const source = await readFile(sourcePath, "utf8");
      const enabled = source.includes("const enabled = true");
      response.setHeader("content-type", "text/html");
      response.end(
        `<button data-testid="increment" onclick="${enabled ? "this.textContent='Incremented'" : ""}">Increment</button>`
      );
    })
  );
  return { root, sourcePath, appUrl };
}

function modelServer(patch: string) {
  return createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const isAnalysis = body.includes("Analyze every supplied UI control");
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: isAnalysis
                ? JSON.stringify({
                    assessments: [
                      {
                        controlId: "increment",
                        expectedBehavior: "Increment the value",
                        observedBehavior: "No observable change",
                        verdict: "INERT",
                        confidence: 0.96,
                        explanation: "The button produced no signal."
                      }
                    ]
                  })
                : JSON.stringify({
                    diagnosis: "The click behavior is disabled.",
                    sourceConfidence: 0.98,
                    expectedOutcome: "The button changes after click.",
                    patch,
                    affectedControls: ["increment"],
                    risk: "low"
                  })
            }
          }
        ]
      })
    );
  });
}

describe("proof-carrying workflow", () => {
  test("verifies a successful patch in an isolated worktree by default", async () => {
    const fixture = await createFixture();
    const original = await readFile(fixture.sourcePath, "utf8");
    const outputDir = join(fixture.root, ".buttonprobe");
    const modelUrl = `${await listen(
      modelServer(
        "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1,4 +1,4 @@\n export function App() {\n-  const enabled = false;\n+  const enabled = true;\n   return <button data-testid=\"increment\">Increment</button>;\n }\n"
      )
    )}/v1`;

    const result = await runButtonProbe({
      baseUrl: fixture.appUrl,
      outputDir,
      projectRoot: fixture.root,
      maxPages: 1,
      interactionTimeoutMs: 50,
      unsafe: false,
      ai: true,
      fix: true,
      testCommand: `node -e "const fs=require('fs');if(!fs.readFileSync('src/App.tsx','utf8').includes('enabled = true'))process.exit(1)"`,
      maxRounds: 1,
      images: false,
      apiBaseUrl: modelUrl,
      model: "mock"
    });

    expect(result.repairs[0]?.result.stopReason).toContain("isolated worktree");
    expect(result.repairs[0]?.result.evidenceStatus).toBe("test-verified");
    expect(await readFile(fixture.sourcePath, "utf8")).toBe(original);
    expect(await readFile(join(outputDir, "repairs", "increment", "verified.diff"), "utf8")).toContain(
      "enabled = true"
    );
  });

  test("UI-verifies a patch using a development server in the isolated worktree", async () => {
    const fixture = await createFixture();
    const modelUrl = `${await listen(
      modelServer(
        "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1,4 +1,4 @@\n export function App() {\n-  const enabled = false;\n+  const enabled = true;\n   return <button data-testid=\"increment\">Increment</button>;\n }\n"
      )
    )}/v1`;

    const result = await runButtonProbe({
      baseUrl: fixture.appUrl,
      outputDir: join(fixture.root, ".buttonprobe"),
      projectRoot: fixture.root,
      maxPages: 1,
      interactionTimeoutMs: 50,
      unsafe: false,
      ai: true,
      fix: true,
      testCommand: `node -e "const fs=require('fs');if(!fs.readFileSync('src/App.tsx','utf8').includes('enabled = true'))process.exit(1)"`,
      devCommand: "node server.mjs",
      maxRounds: 1,
      images: false,
      apiBaseUrl: modelUrl,
      model: "mock"
    });

    expect(result.repairs[0]?.result.evidenceStatus).toBe("ui-verified");
    expect(result.repairs[0]?.result.attempts[0]?.ui?.targetWorks).toBe(true);
    expect(Reflect.get(result.repairs[0]?.result ?? {}, "counterfactualVerified")).toBe(true);
    const regressionPath = join(fixture.root, ".buttonprobe", "repairs", "increment", "regression.spec.ts");
    expect(await readFile(regressionPath, "utf8")).toContain("ButtonProbe regression: Increment");
  });

  test("retries failed UI verification in fresh isolated worktrees before accepting a later patch", async () => {
    const fixture = await createFixture();
    let repairCalls = 0;
    const modelUrl = `${await listen(
      createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        const isAnalysis = body.includes("Analyze every supplied UI control");
        const patch = repairCalls === 0
          ? "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1,4 +1,5 @@\n export function App() {\n   const enabled = false;\n+  const firstAttempt = true;\n   return <button data-testid=\"increment\">Increment</button>;\n }\n"
          : "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1,4 +1,4 @@\n export function App() {\n-  const enabled = false;\n+  const enabled = true;\n   return <button data-testid=\"increment\">Increment</button>;\n }\n";
        if (!isAnalysis) repairCalls += 1;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ choices: [{ message: { content: isAnalysis
          ? JSON.stringify({ assessments: [{
              controlId: "increment",
              expectedBehavior: "Increment the value",
              observedBehavior: "No observable change",
              verdict: "INERT",
              confidence: 0.96,
              explanation: "The button produced no signal."
            }] })
          : JSON.stringify({
              diagnosis: "Try the next bounded repair.",
              sourceConfidence: 0.98,
              expectedOutcome: "The button changes after click.",
              patch,
              affectedControls: ["increment"],
              risk: "low"
            })
        } }] }));
      })
    )}/v1`;

    const result = await runButtonProbe({
      baseUrl: fixture.appUrl,
      outputDir: join(fixture.root, ".buttonprobe"),
      projectRoot: fixture.root,
      maxPages: 1,
      interactionTimeoutMs: 50,
      unsafe: false,
      ai: true,
      fix: true,
      testCommand: 'node -e "process.exit(0)"',
      devCommand: "node server.mjs",
      maxRounds: 3,
      images: false,
      apiBaseUrl: modelUrl,
      model: "mock"
    });

    expect(result.repairs[0]?.result.evidenceStatus).toBe("ui-verified");
    expect(result.repairs[0]?.result.attempts).toHaveLength(2);
    expect(result.repairs[0]?.result.attempts.map((attempt) => attempt.decision)).toEqual(["rolled-back", "accepted"]);
    expect(repairCalls).toBe(2);
    await expect(stat(join(fixture.root, ".buttonprobe", "repairs", "increment", "round-1", "verified.diff"))).resolves.toBeDefined();
  });

  test("keeps low-confidence source matches in patch-only mode", async () => {
    const fixture = await createFixture();
    await writeFile(fixture.sourcePath, "export const message = 'Increment';\n");
    execFileSync("git", ["add", "src/App.tsx"], { cwd: fixture.root });
    execFileSync(
      "git",
      ["-c", "user.name=ButtonProbe", "-c", "user.email=test@example.com", "commit", "-m", "weak source"],
      { cwd: fixture.root }
    );
    const modelUrl = `${await listen(
      modelServer(
        "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1 +1 @@\n-export const message = 'Increment';\n+export const message = 'Incremented';\n"
      )
    )}/v1`;
    const outputDir = join(fixture.root, ".buttonprobe");

    const result = await runButtonProbe({
      baseUrl: fixture.appUrl,
      outputDir,
      projectRoot: fixture.root,
      maxPages: 1,
      interactionTimeoutMs: 50,
      unsafe: false,
      ai: true,
      fix: true,
      testCommand: "node -e \"process.exit(0)\"",
      devCommand: "node server.mjs",
      maxRounds: 1,
      images: false,
      apiBaseUrl: modelUrl,
      model: "mock"
    });

    expect(result.repairs[0]?.result.evidenceStatus).toBe("generated");
    expect(result.repairs[0]?.result.stopReason).toContain("source confidence");
    await stat(join(outputDir, "patches", "increment.diff"));
    await expect(stat(join(outputDir, "repairs", "increment", "verified.diff"))).rejects.toThrow();
  });

  test("applies a patch only when tests and UI verification pass", async () => {
    const fixture = await createFixture();
    const modelUrl = `${await listen(
      modelServer(
        "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1,4 +1,4 @@\n export function App() {\n-  const enabled = false;\n+  const enabled = true;\n   return <button data-testid=\"increment\">Increment</button>;\n }\n"
      )
    )}/v1`;

    const result = await runButtonProbe({
      baseUrl: fixture.appUrl,
      outputDir: join(fixture.root, ".buttonprobe"),
      projectRoot: fixture.root,
      maxPages: 1,
      interactionTimeoutMs: 50,
      unsafe: false,
      ai: true,
      fix: true,
      testCommand: `node -e "const fs=require('fs');if(!fs.readFileSync('src/App.tsx','utf8').includes('enabled = true'))process.exit(1)"`,
      maxRounds: 3,
      images: false,
      apply: true,
      behaviorContracts: {
        increment: { expect: { text: ["Incremented"] }, forbid: { text: ["Error"] } }
      },
      apiBaseUrl: modelUrl,
      model: "mock"
    });

    expect(result.repairs[0]?.result.status).toBe("fixed");
    expect(Reflect.get(result.repairs[0]?.result ?? {}, "counterfactualVerified")).toBe(true);
    expect(await readFile(fixture.sourcePath, "utf8")).toContain("enabled = true");
    expect(await readFile(result.reportPath, "utf8")).toContain("Repair loop: fixed");
  });

  test("reverses the exact patch when the test gate fails", async () => {
    const fixture = await createFixture();
    const original = await readFile(fixture.sourcePath, "utf8");
    const modelUrl = `${await listen(
      modelServer(
        "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1,4 +1,4 @@\n export function App() {\n-  const enabled = false;\n+  const enabled = true;\n   return <button data-testid=\"increment\">Increment</button>;\n }\n"
      )
    )}/v1`;

    const result = await runButtonProbe({
      baseUrl: fixture.appUrl,
      outputDir: join(fixture.root, ".buttonprobe"),
      projectRoot: fixture.root,
      maxPages: 1,
      interactionTimeoutMs: 50,
      unsafe: false,
      ai: true,
      fix: true,
      testCommand: 'node -e "process.exit(1)"',
      maxRounds: 1,
      images: false,
      apiBaseUrl: modelUrl,
      model: "mock"
    });

    expect(result.repairs[0]?.result.status).toBe("exhausted");
    expect(await readFile(fixture.sourcePath, "utf8")).toBe(original);
  });
});
