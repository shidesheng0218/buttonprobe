import { createServer, type RequestListener } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AIClient, AIResponseError } from "../src/ai-client.js";

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

async function startServer(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return `http://127.0.0.1:${address.port}/v1`;
}

describe("AIClient", () => {
  test("reuses a file-backed cache across client instances", async () => {
    let requests = 0;
    const cacheDir = await mkdtemp(join(tmpdir(), "buttonprobe-ai-cache-"));
    const baseUrl = await startServer((_request, response) => {
      requests += 1;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  assessments: [
                    {
                      controlId: "button-1",
                      expectedBehavior: "Open",
                      observedBehavior: "Opened",
                      verdict: "WORKS",
                      confidence: 0.99,
                      explanation: "Observed a DOM change."
                    }
                  ]
                })
              }
            }
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20 }
        })
      );
    });
    const call = {
      pageUrl: "http://localhost:3000",
      controls: [{ id: "button-1", label: "Open", verdict: "WORKS", signals: ["dom"] }],
      cacheKey: "persistent-analysis"
    };

    const first = await new AIClient({ baseUrl, model: "test", cacheDir }).analyzeControls(call);
    const second = await new AIClient({ baseUrl, model: "test", cacheDir }).analyzeControls(call);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(requests).toBe(1);
    const cachedSummary = new AIClient({ baseUrl, model: "test", cacheDir });
    await cachedSummary.analyzeControls(call);
    expect(cachedSummary.getUsageSummary()).toMatchObject({
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheHits: 1
    });
  });

  test("analyzes every supplied control in a single page request", async () => {
    const baseUrl = await startServer(async (request, response) => {
      let requestBody = "";
      for await (const chunk of request) requestBody += chunk;
      const parsed = JSON.parse(requestBody) as { messages: Array<{ content: unknown }> };
      expect(JSON.stringify(parsed.messages)).toContain("button-1");
      expect(JSON.stringify(parsed.messages)).toContain("button-2");

      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  assessments: [
                    {
                      controlId: "button-1",
                      expectedBehavior: "Open settings",
                      observedBehavior: "A dialog opened",
                      verdict: "WORKS",
                      confidence: 0.98,
                      explanation: "The interaction produced a visible dialog."
                    },
                    {
                      controlId: "button-2",
                      expectedBehavior: "Save changes",
                      observedBehavior: "No observable change",
                      verdict: "INERT",
                      confidence: 0.9,
                      explanation: "No DOM, URL, or network signal was observed.",
                      suggestedFix: "Attach the save handler."
                    }
                  ]
                })
              }
            }
          ]
        })
      );
    });

    const client = new AIClient({ baseUrl, model: "test-model" });
    const result = await client.analyzeControls({
      pageUrl: "http://localhost:3000",
      controls: [
        { id: "button-1", label: "Settings", verdict: "WORKS", signals: ["dialog"] },
        { id: "button-2", label: "Save", verdict: "INERT", signals: [] }
      ],
      cacheKey: "analysis-1"
    });

    expect(result.assessments).toHaveLength(2);
    expect(result.assessments[1]?.verdict).toBe("INERT");
  });

  test("parses a schema-valid repair attempt from an OpenAI-compatible endpoint", async () => {
    const baseUrl = await startServer((request, response) => {
      expect(request.url).toBe("/v1/chat/completions");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  diagnosis: "The click handler is empty.",
                  sourceConfidence: 0.94,
                  expectedOutcome: "The counter increments.",
                  patch: "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1 +1 @@\n-old\n+new\n",
                  affectedControls: ["button-1"],
                  risk: "low"
                })
              }
            }
          ],
          usage: { prompt_tokens: 120, completion_tokens: 55 }
        })
      );
    });

    const client = new AIClient({ baseUrl, apiKey: "test-key", model: "test-model" });
    const result = await client.repair({ prompt: "Fix it", cacheKey: "case-1" });

    expect(result.attempt.risk).toBe("low");
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 55 });
  });

  test("rejects malformed model output", async () => {
    const baseUrl = await startServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: "{\"risk\":\"low\"}" } }] }));
    });

    const client = new AIClient({ baseUrl, model: "test-model" });
    await expect(client.repair({ prompt: "Fix it", cacheKey: "case-2" })).rejects.toBeInstanceOf(
      AIResponseError
    );
  });

  test("routes analyze and repair calls to separate models with bounded output", async () => {
    const requests: Array<{ model: string; max_tokens: number }> = [];
    const baseUrl = await startServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const parsed = JSON.parse(body) as { model: string; max_tokens: number; messages: Array<{ content: unknown }> };
      requests.push({ model: parsed.model, max_tokens: parsed.max_tokens });
      const analysis = JSON.stringify(parsed.messages).includes("Analyze every supplied UI control");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          choices: [{
            message: {
              content: analysis
                ? JSON.stringify({ assessments: [{
                    controlId: "button-1",
                    expectedBehavior: "Open",
                    observedBehavior: "No effect",
                    verdict: "INERT",
                    confidence: 0.9,
                    explanation: "No signal"
                  }] })
                : JSON.stringify({
                    diagnosis: "Empty handler",
                    sourceConfidence: 0.9,
                    expectedOutcome: "Open",
                    patch: "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1 +1 @@\n-old\n+new\n",
                    affectedControls: ["button-1"],
                    risk: "low"
                  })
            }
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5 }
        })
      );
    });
    const client = new AIClient({
      baseUrl,
      model: "fallback-model",
      analysisModel: "cheap-model",
      repairModel: "strong-model",
      analyzeMaxTokens: 1200,
      repairMaxTokens: 3000
    });

    await client.analyzeControls({
      pageUrl: "http://localhost:3000",
      controls: [{ id: "button-1", label: "Open", verdict: "INERT", signals: [] }]
    });
    await client.repair({ prompt: "Fix it" });

    expect(requests).toEqual([
      { model: "cheap-model", max_tokens: 1200 },
      { model: "strong-model", max_tokens: 3000 }
    ]);
    expect(client.getUsageSummary()).toMatchObject({
      modelCalls: 2,
      inputTokens: 20,
      outputTokens: 10,
      cacheHits: 0,
      cacheMisses: 2
    });
  });

  test("retries transient provider failures and records every model request", async () => {
    let requests = 0;
    const baseUrl = await startServer((_request, response) => {
      requests += 1;
      if (requests === 1) {
        response.statusCode = 503;
        response.end("busy");
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ assessments: [{
        controlId: "button-1",
        expectedBehavior: "Open",
        observedBehavior: "Opened",
        verdict: "WORKS",
        confidence: 0.9,
        explanation: "DOM changed"
      }] }) } }] }));
    });
    const client = new AIClient({ baseUrl, model: "test", retryDelayMs: 1 });

    await client.analyzeControls({
      pageUrl: "http://localhost:3000",
      controls: [{ id: "button-1", label: "Open", verdict: "WORKS", signals: ["dom"] }]
    });

    expect(requests).toBe(2);
    expect(client.getUsageSummary()).toMatchObject({
      modelCalls: 2,
      cacheMisses: 2,
      events: [
        { success: false, error: "Model endpoint returned HTTP 503" },
        { success: true }
      ]
    });
  });

  test("falls back when an OpenAI-compatible provider rejects JSON schema output", async () => {
    const responseFormats: unknown[] = [];
    const baseUrl = await startServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const parsed = JSON.parse(body) as { response_format?: unknown };
      responseFormats.push(parsed.response_format);
      if (responseFormats.length === 1) {
        response.statusCode = 400;
        response.end("response_format unsupported");
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ assessments: [{
        controlId: "button-1",
        expectedBehavior: "Open",
        observedBehavior: "Opened",
        verdict: "WORKS",
        confidence: 0.9,
        explanation: "DOM changed"
      }] }) } }] }));
    });
    const client = new AIClient({ baseUrl, model: "deepseek-chat", retryDelayMs: 1 });

    await client.analyzeControls({
      pageUrl: "http://localhost:3000",
      controls: [{ id: "button-1", label: "Open", verdict: "WORKS", signals: ["dom"] }]
    });

    expect(responseFormats[0]).toMatchObject({ type: "json_schema" });
    expect(responseFormats[1]).toBeUndefined();
    expect(client.getUsageSummary().modelCalls).toBe(2);
    expect(client.getUsageSummary().estimatedCostUsd).toBe(0);
  });

  test("uses the native Anthropic Messages API and parses Claude usage", async () => {
    const requests: Array<{
      url: string | undefined;
      headers: Record<string, string | string[] | undefined>;
      body: Record<string, unknown>;
    }> = [];
    const baseUrl = await startServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push({
        url: request.url,
        headers: request.headers,
        body: JSON.parse(body) as Record<string, unknown>
      });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        content: [{
          type: "text",
          text: JSON.stringify({ assessments: [{
            controlId: "button-1",
            expectedBehavior: "Open",
            observedBehavior: "Opened",
            verdict: "WORKS",
            confidence: 0.95,
            explanation: "DOM changed"
          }] })
        }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 120,
          output_tokens: 40,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 20
        }
      }));
    });
    const client = new AIClient({
      provider: "anthropic",
      baseUrl,
      apiKey: "claude-key",
      model: "claude-sonnet-5"
    });

    const result = await client.analyzeControls({
      pageUrl: "http://localhost:3000",
      controls: [{ id: "button-1", label: "Open", verdict: "WORKS", signals: ["dom"] }]
    });

    expect(result.assessments[0]?.verdict).toBe("WORKS");
    expect(requests[0]?.url).toBe("/v1/messages");
    expect(requests[0]?.headers["x-api-key"]).toBe("claude-key");
    expect(requests[0]?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(requests[0]?.headers.authorization).toBeUndefined();
    expect(requests[0]?.body).toMatchObject({
      model: "claude-sonnet-5",
      max_tokens: 1200,
      system: expect.any(String),
      output_config: { format: { type: "json_schema" } }
    });
    expect(requests[0]?.body).not.toHaveProperty("temperature");
    expect(client.getUsageSummary()).toMatchObject({
      modelCalls: 1,
      inputTokens: 150,
      outputTokens: 40
    });
  });

  test("converts screenshot data URLs to Anthropic image blocks", async () => {
    let content: unknown;
    const baseUrl = await startServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      content = (JSON.parse(body) as { messages: Array<{ content: unknown }> }).messages[0]?.content;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        content: [{ type: "text", text: JSON.stringify({
          diagnosis: "Empty handler",
          sourceConfidence: 0.95,
          expectedOutcome: "Works",
          patch: "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1 +1 @@\n-old\n+new\n",
          affectedControls: ["button-1"],
          risk: "low"
        }) }],
        usage: { input_tokens: 10, output_tokens: 10 }
      }));
    });
    const client = new AIClient({
      provider: "anthropic",
      baseUrl,
      apiKey: "claude-key",
      model: "claude-sonnet-5"
    });

    await client.repair({
      prompt: "Fix it",
      imageDataUrls: ["data:image/png;base64,aGVsbG8="]
    });

    expect(content).toEqual([
      { type: "text", text: "Fix it" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" }
      }
    ]);
  });
});
