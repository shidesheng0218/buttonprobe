import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createButtonProbeMcpServer } from "../src/mcp.js";
import { validateProofArtifacts } from "../src/patch-proof.js";

const servers: Server[] = [];

afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return `http://127.0.0.1:${address.port}`;
}

async function createRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "buttonprobe-mcp-verify-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "App.tsx"), "export const enabled = false;\n");
  await writeFile(
    join(root, "server.mjs"),
    [
      'import { createServer } from "node:http";',
      'import { readFileSync } from "node:fs";',
      'const port = Number(process.env.PORT);',
      'createServer((_request, response) => {',
      '  const source = readFileSync("src/App.tsx", "utf8");',
      '  const enabled = source.includes("enabled = true");',
      '  response.setHeader("content-type", "text/html");',
      '  response.end(`<button data-testid="save" onclick="${enabled ? "this.textContent=\\\'Saved\\\'" : ""}">Save</button><button data-testid="normal" onclick="this.textContent=\\\'Normal done\\\'">Normal</button>`);',
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

interface VerifyStructured {
  structuredContent?: {
    status: string;
    reason: string;
    proofPath: string;
    reportPath: string;
    verifiedDiffPath?: string;
    originalCheckoutModified: boolean;
    modelCalls: number;
  };
  isError?: boolean;
}

describe("buttonprobe_verify MCP tool", () => {
  test("verifies an external patch to ui-verified with zero model calls", async () => {
    const root = await createRepo();
    const original = await readFile(join(root, "src", "App.tsx"), "utf8");
    const baseUrl = await listen(
      createServer((_request, response) => {
        response.setHeader("content-type", "text/html");
        response.end(
          '<button data-testid="save">Save</button><button data-testid="normal" onclick="this.textContent=\'Normal done\'">Normal</button>'
        );
      })
    );
    const patchPath = join(root, "agent.diff");
    await writeFile(
      patchPath,
      "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1 +1 @@\n-export const enabled = false;\n+export const enabled = true;\n"
    );

    const server = createButtonProbeMcpServer("0.0.0-test");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "buttonprobe-mcp-verify-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = (await client.callTool({
      name: "buttonprobe_verify",
      arguments: {
        url: baseUrl,
        patchPath,
        testCommand:
          "node -e \"const fs=require('fs');if(!fs.readFileSync('src/App.tsx','utf8').includes('enabled = true'))process.exit(1)\"",
        devCommand: "node server.mjs",
        projectRoot: root,
        outputDir: join(root, ".buttonprobe", "mcp-verify"),
        target: '[data-testid="save"]',
        timeout: 40
      }
    })) as VerifyStructured;

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent!;
    expect(structured.status).toBe("ui-verified");
    expect(structured.modelCalls).toBe(0);
    expect(structured.originalCheckoutModified).toBe(false);
    expect(structured.verifiedDiffPath).toBeTruthy();
    await validateProofArtifacts(structured.proofPath);
    expect(await readFile(join(root, "src", "App.tsx"), "utf8")).toBe(original);
    await client.close();
  }, 120_000);
});
