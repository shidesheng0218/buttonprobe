import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createButtonProbeMcpServer } from "../src/mcp.js";

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

async function connectClient(): Promise<Client> {
  const server = createButtonProbeMcpServer("0.0.0-test");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "buttonprobe-test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

interface ToolStructured {
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

describe("buttonprobe MCP server", () => {
  test("exposes exactly the zero-model scan, verify, and doctor tools", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "buttonprobe_doctor",
      "buttonprobe_scan",
      "buttonprobe_verify"
    ]);
    await client.close();
  });

  test("doctor returns actionable checks with zero model calls", async () => {
    const client = await connectClient();
    const projectRoot = await mkdtemp(join(tmpdir(), "buttonprobe-mcp-doctor-"));
    const result = (await client.callTool({
      name: "buttonprobe_doctor",
      arguments: { projectRoot, url: "http://localhost:5173", testCommand: "npm test" }
    })) as ToolStructured;

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      ok: boolean;
      modelCalls: number;
      checks: Array<{ name: string; ok: boolean; message: string }>;
    };
    expect(structured.modelCalls).toBe(0);
    expect(structured.checks.some((check) => check.name === "Deterministic templates" && check.ok)).toBe(true);
    expect(structured.checks.some((check) => check.name === "Git repository")).toBe(true);
    await client.close();
  });

  test("verify rejects invalid input as a tool error without crashing the server", async () => {
    const client = await connectClient();
    const result = (await client.callTool({
      name: "buttonprobe_verify",
      arguments: { url: "http://localhost:5173", testCommand: "npm test" }
    })) as ToolStructured;

    expect(result.isError).toBe(true);
    const text = (result.content ?? []).map((item) => item.text ?? "").join("\n");
    expect(text).toContain("--patch");

    const followUp = (await client.callTool({
      name: "buttonprobe_doctor",
      arguments: { projectRoot: await mkdtemp(join(tmpdir(), "buttonprobe-mcp-after-")) }
    })) as ToolStructured;
    expect(followUp.isError).toBeFalsy();
    await client.close();
  });

  test("scan finds broken controls with zero model calls", async () => {
    const client = await connectClient();
    const url = await listen(
      createServer((_request, response) => {
        response.setHeader("content-type", "text/html");
        response.end(
          '<button data-testid="works" onclick="this.textContent=\'Done\'">Run</button><button data-testid="inert" onclick="">Save</button>'
        );
      })
    );
    const projectRoot = await mkdtemp(join(tmpdir(), "buttonprobe-mcp-scan-"));
    const result = (await client.callTool({
      name: "buttonprobe_scan",
      arguments: { url, projectRoot, timeout: 80 }
    })) as ToolStructured;

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      scannedControls: number;
      brokenCount: number;
      brokenControls: Array<{ id: string; verdict: string }>;
      modelCalls: number;
    };
    expect(structured.modelCalls).toBe(0);
    expect(structured.scannedControls).toBeGreaterThanOrEqual(2);
    expect(structured.brokenControls.some((control) => control.id === "inert")).toBe(true);
    expect(structured.brokenControls.every((control) => control.verdict !== "WORKS")).toBe(true);
    await client.close();
  }, 60_000);
});
