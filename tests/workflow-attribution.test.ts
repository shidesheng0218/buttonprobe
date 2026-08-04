import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { runButtonProbe } from "../src/workflow.js";

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

test("does not spend model calls or attempt a frontend repair for backend failures", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "buttonprobe-attribution-workflow-"));
  await mkdir(join(projectRoot, "src"));
  await writeFile(join(projectRoot, "src", "App.tsx"), "export const App = () => null;\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: projectRoot });
  execFileSync("git", ["add", "."], { cwd: projectRoot });
  execFileSync("git", ["-c", "user.name=ButtonProbe", "-c", "user.email=test@example.com", "commit", "-m", "initial"], {
    cwd: projectRoot
  });

  const appUrl = await listen(
    createServer((request, response) => {
      if (request.url === "/api/save") {
        response.statusCode = 500;
        response.end("backend failed");
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end('<button data-testid="save" onclick="fetch(\'/api/save\', { method: \'POST\' })">Save</button>');
    })
  );
  let modelCalls = 0;
  const modelUrl = `${await listen(
    createServer((_request, response) => {
      modelCalls += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ assessments: [] }) } }] }));
    })
  )}/v1`;

  const result = await runButtonProbe({
    baseUrl: appUrl,
    outputDir: join(projectRoot, ".buttonprobe"),
    projectRoot,
    maxPages: 1,
    interactionTimeoutMs: 25,
    unsafe: true,
    profile: { networkMode: "sandbox", resetCommand: 'node -e "process.exit(0)"' },
    ai: true,
    fix: true,
    testCommand: 'node -e "process.exit(0)"',
    maxRounds: 3,
    images: false,
    apiBaseUrl: modelUrl,
    model: "mock"
  });

  expect(result.scan.pages[0]?.controls[0]?.verdict).toBe("BACKEND_ERROR");
  expect(result.repairs).toEqual([]);
  expect(result.usageSummary.modelCalls).toBe(0);
  expect(modelCalls).toBe(0);
});
