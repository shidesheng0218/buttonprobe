import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { scanApplication } from "../src/scanner.js";

let server: ReturnType<typeof createServer>;
let url: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === "/api/fail") {
      response.statusCode = 500;
      response.end("backend failed");
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html>
      <html>
        <body>
          <button data-testid="working" onclick="this.textContent='Done'">Run</button>
          <button data-testid="inert" onclick="">Save</button>
          <button data-testid="crash" onclick="throw new Error('boom')">Crash</button>
          <button data-testid="danger">Delete project</button>
          <button data-testid="instrumented" data-bp-id="bp_checkout_1" onclick="this.setAttribute('aria-pressed', 'true')">Pay</button>
          <button data-testid="mutation" onclick="fetch('/profile', { method: 'POST' })">Update profile</button>
          <button data-testid="backend" onclick="fetch('/api/fail', { method: 'POST' })">Save to backend</button>
        </body>
      </html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  url = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("scanApplication", () => {
  test("classifies working, inert, crashed, and dangerous controls", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "buttonprobe-scan-"));
    const result = await scanApplication({
      baseUrl: url,
      outputDir,
      maxPages: 1,
      interactionTimeoutMs: 100
    });

    const controls = result.pages[0]?.controls ?? [];
    const verdictById = Object.fromEntries(
      controls
        .filter((control) => control.testId !== "instrumented" && control.testId !== "mutation" && control.testId !== "backend")
        .map((control) => [control.testId, control.verdict])
    );

    expect(verdictById).toEqual({
      working: "WORKS",
      inert: "INERT",
      crash: "CRASHED",
      danger: "SKIPPED"
    });
  });

  test("prefers compiler-instrumented control ids over test ids", async () => {
    const result = await scanApplication({
      baseUrl: url,
      outputDir: await mkdtemp(join(tmpdir(), "buttonprobe-instrumented-scan-")),
      maxPages: 1,
      interactionTimeoutMs: 25,
      unsafe: true
    });

    const control = result.pages[0]?.controls.find((candidate) => candidate.testId === "instrumented");
    expect(control?.id).toBe("bp_checkout_1");
    expect(control?.selector).toBe('[data-bp-id="bp_checkout_1"]');
  });

  test("blocks live mutations in the default observe mode", async () => {
    const result = await scanApplication({
      baseUrl: url,
      outputDir: await mkdtemp(join(tmpdir(), "buttonprobe-observe-scan-")),
      maxPages: 1,
      interactionTimeoutMs: 25,
      unsafe: true
    });

    const control = result.pages[0]?.controls.find((candidate) => candidate.testId === "mutation");
    expect(control?.verdict).toBe("BLOCKED_MUTATION");
    expect(control?.evidence.signals.some((signal) => signal.detail.startsWith("BLOCKED_MUTATION POST"))).toBe(true);
  });

  test("classifies a failed mutation as a backend error instead of a working control", async () => {
    const result = await scanApplication({
      baseUrl: url,
      outputDir: await mkdtemp(join(tmpdir(), "buttonprobe-backend-error-scan-")),
      maxPages: 1,
      interactionTimeoutMs: 25,
      unsafe: true,
      networkMode: "sandbox"
    });

    const control = result.pages[0]?.controls.find((candidate) => candidate.testId === "backend");
    expect(control?.verdict).toBe("BACKEND_ERROR");
    expect(Reflect.get(control ?? {}, "failureClass")).toBe("BACKEND_5XX");
    expect(control?.evidence.signals.some((signal) => signal.detail.includes("HTTP 500"))).toBe(true);
  });

  test("rejects non-local targets by default", async () => {
    await expect(
      scanApplication({
        baseUrl: "https://example.com",
        outputDir: await mkdtemp(join(tmpdir(), "buttonprobe-remote-"))
      })
    ).rejects.toThrow("localhost");
  });
});
