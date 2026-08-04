import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runButtonProbe } from "../src/workflow.js";

const servers: Array<ReturnType<typeof createServer>> = [];

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

async function demoUrl() {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end('<button data-testid="save" onclick="">Save</button>');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return `http://127.0.0.1:${address.port}`;
}

describe("schemaVersion", () => {
  test("writes schemaVersion to scan and repairs JSON outputs", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "buttonprobe-schema-"));
    await runButtonProbe({
      baseUrl: await demoUrl(),
      outputDir,
      projectRoot: outputDir,
      maxPages: 1,
      interactionTimeoutMs: 50,
      unsafe: false,
      ai: false,
      fix: false,
      maxRounds: 3,
      images: false
    });

    const scan = JSON.parse(await readFile(join(outputDir, "scan.json"), "utf8"));
    const repairs = JSON.parse(await readFile(join(outputDir, "repairs.json"), "utf8"));

    expect(scan.schemaVersion).toBe(1);
    expect(repairs.schemaVersion).toBe(1);
    expect(Array.isArray(repairs.repairs)).toBe(true);
  });
});
