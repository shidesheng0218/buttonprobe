import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AIControlAssessment,
  AIPageAssessment,
  AIUsageEvent,
  AIUsageSummary,
  RepairAttempt
} from "./types.js";

export class AIResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIResponseError";
  }
}

export interface AIClientOptions {
  provider?: "openai-compatible" | "anthropic";
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  cacheDir?: string;
  analysisModel?: string;
  repairModel?: string;
  analyzeMaxTokens?: number;
  repairMaxTokens?: number;
  maxModelCalls?: number;
  retryDelayMs?: number;
}

export interface RepairCall {
  prompt: string;
  cacheKey?: string;
  imageDataUrls?: string[];
}

export interface AIRepairResult {
  attempt: RepairAttempt;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  latencyMs: number;
  cached: boolean;
}

export interface AnalyzeControlsCall {
  pageUrl: string;
  controls: Array<{
    id: string;
    label: string;
    verdict: string;
    signals: string[];
  }>;
  cacheKey?: string;
  imageDataUrl?: string;
}

interface CompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  content?: Array<{ type?: string; text?: string }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

function isRepairAttempt(value: unknown): value is RepairAttempt {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.diagnosis === "string" &&
    typeof candidate.sourceConfidence === "number" &&
    candidate.sourceConfidence >= 0 &&
    candidate.sourceConfidence <= 1 &&
    typeof candidate.expectedOutcome === "string" &&
    typeof candidate.patch === "string" &&
    Array.isArray(candidate.affectedControls) &&
    candidate.affectedControls.every((item) => typeof item === "string") &&
    (candidate.risk === "low" || candidate.risk === "medium" || candidate.risk === "high")
  );
}

function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const payload = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(payload);
  } catch (error) {
    throw new AIResponseError(`Model returned invalid JSON: ${(error as Error).message}`);
  }
}

function isAssessment(value: unknown): value is AIControlAssessment {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.controlId === "string" &&
    typeof candidate.expectedBehavior === "string" &&
    typeof candidate.observedBehavior === "string" &&
    (candidate.verdict === "WORKS" ||
      candidate.verdict === "INERT" ||
      candidate.verdict === "CRASHED" ||
      candidate.verdict === "AMBIGUOUS") &&
    typeof candidate.confidence === "number" &&
    candidate.confidence >= 0 &&
    candidate.confidence <= 1 &&
    typeof candidate.explanation === "string" &&
    (candidate.suggestedFix === undefined || typeof candidate.suggestedFix === "string") &&
    (candidate.suggestedTest === undefined || typeof candidate.suggestedTest === "string")
  );
}

function responseSchema(kind: AIUsageEvent["kind"]): Record<string, unknown> {
  if (kind === "repair") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["diagnosis", "sourceConfidence", "expectedOutcome", "patch", "affectedControls", "risk"],
      properties: {
        diagnosis: { type: "string" },
        sourceConfidence: { type: "number", minimum: 0, maximum: 1 },
        expectedOutcome: { type: "string" },
        patch: { type: "string" },
        affectedControls: { type: "array", items: { type: "string" } },
        risk: { type: "string", enum: ["low", "medium", "high"] }
      }
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["assessments"],
    properties: {
      assessments: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["controlId", "expectedBehavior", "observedBehavior", "verdict", "confidence", "explanation"],
          properties: {
            controlId: { type: "string" },
            expectedBehavior: { type: "string" },
            observedBehavior: { type: "string" },
            verdict: { type: "string", enum: ["WORKS", "INERT", "CRASHED", "AMBIGUOUS"] },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            explanation: { type: "string" },
            suggestedFix: { type: "string" },
            suggestedTest: { type: "string" }
          }
        }
      }
    }
  };
}

export class AIClient {
  private readonly cache = new Map<string, AIRepairResult>();
  private readonly analysisCache = new Map<string, AIPageAssessment>();
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly usageEvents: AIUsageEvent[] = [];
  private readonly provider: "openai-compatible" | "anthropic";

  constructor(private readonly options: AIClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.retryDelayMs = options.retryDelayMs ?? 200;
    this.provider = options.provider ??
      (new URL(options.baseUrl).hostname === "api.anthropic.com" ? "anthropic" : "openai-compatible");
  }

  getUsageSummary(): AIUsageSummary {
    const modelEvents = this.usageEvents.filter((event) => !event.cached);
    const localEndpoint = ["localhost", "127.0.0.1", "::1"].includes(new URL(this.options.baseUrl).hostname);
    const summary: AIUsageSummary = {
      modelCalls: modelEvents.length,
      inputTokens: modelEvents.reduce((total, event) => total + event.inputTokens, 0),
      outputTokens: modelEvents.reduce((total, event) => total + event.outputTokens, 0),
      latencyMs: modelEvents.reduce((total, event) => total + event.latencyMs, 0),
      cacheHits: this.usageEvents.filter((event) => event.cached).length,
      cacheMisses: modelEvents.filter((event) => event.success).length,
      events: [...this.usageEvents]
    };
    if (localEndpoint || modelEvents.every((event) => event.model.includes("mock"))) {
      summary.estimatedCostUsd = 0;
    }
    return summary;
  }

  private recordCached(kind: AIUsageEvent["kind"], model: string, usage: { inputTokens: number; outputTokens: number }): void {
    this.usageEvents.push({
      kind,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      latencyMs: 0,
      cached: true,
      success: true
    });
  }

  private cachePath(kind: "analysis" | "repair", key: string): string | undefined {
    if (!this.options.cacheDir) return undefined;
    const fileName = createHash("sha256").update(`${kind}:${key}`).digest("hex");
    return join(this.options.cacheDir, `${fileName}.json`);
  }

  private async readFileCache<T>(kind: "analysis" | "repair", key: string): Promise<T | undefined> {
    const path = this.cachePath(kind, key);
    if (!path) return undefined;
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  private async writeFileCache(kind: "analysis" | "repair", key: string, value: unknown): Promise<void> {
    const path = this.cachePath(kind, key);
    if (!path || !this.options.cacheDir) return;
    await mkdir(this.options.cacheDir, { recursive: true });
    await writeFile(path, JSON.stringify(value));
  }

  private async complete(
    kind: AIUsageEvent["kind"],
    model: string,
    maxTokens: number,
    prompt: string,
    imageDataUrls: string[] = []
  ): Promise<{
    body: CompletionResponse;
    content: string;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
  }> {
    const openAIContent: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
    const anthropicContent: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
    for (const image of imageDataUrls) {
      openAIContent.push({ type: "image_url", image_url: { url: image } });
      const match = image.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/);
      if (!match?.[1] || !match[2]) throw new AIResponseError("Unsupported image data URL for model upload");
      anthropicContent.push({
        type: "image",
        source: { type: "base64", media_type: match[1], data: match[2] }
      });
    }
    let structuredOutput = true;
    let lastError = "Model request failed";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (this.usageEvents.filter((event) => !event.cached).length >= (this.options.maxModelCalls ?? Number.POSITIVE_INFINITY)) {
        throw new AIResponseError("Model request budget exhausted");
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const startedAt = Date.now();
      try {
        const baseUrl = this.options.baseUrl.replace(/\/$/, "");
        const endpoint = this.provider === "anthropic"
          ? `${baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`}/messages`
          : `${baseUrl}/chat/completions`;
        const systemPrompt = "Return only JSON matching the requested schema. Never return shell commands or markdown.";
        const requestBody = this.provider === "anthropic"
          ? {
              model,
              max_tokens: maxTokens,
              system: systemPrompt,
              ...(structuredOutput
                ? { output_config: { format: { type: "json_schema", schema: responseSchema(kind) } } }
                : {}),
              messages: [{ role: "user", content: anthropicContent }]
            }
          : {
              model,
              temperature: 0,
              max_tokens: maxTokens,
              ...(structuredOutput
                ? {
                    response_format: {
                      type: "json_schema",
                      json_schema: {
                        name: `buttonprobe_${kind}`,
                        strict: true,
                        schema: responseSchema(kind)
                      }
                    }
                  }
                : {}),
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: openAIContent }
              ]
            };
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.provider === "anthropic"
              ? {
                  "anthropic-version": "2023-06-01",
                  ...(this.options.apiKey ? { "x-api-key": this.options.apiKey } : {})
                }
              : this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {})
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });
        const latencyMs = Date.now() - startedAt;
        if (!response.ok) {
          lastError = `Model endpoint returned HTTP ${response.status}`;
          this.usageEvents.push({
            kind,
            model,
            inputTokens: 0,
            outputTokens: 0,
            latencyMs,
            cached: false,
            success: false,
            error: lastError
          });
          if (response.status === 400 && structuredOutput) {
            structuredOutput = false;
            continue;
          }
          if ([429, 502, 503].includes(response.status) && attempt < 2) {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, this.retryDelayMs * (attempt + 1)));
            continue;
          }
          throw new AIResponseError(lastError);
        }
        const responseBody = (await response.json()) as CompletionResponse;
        const raw = this.provider === "anthropic"
          ? responseBody.content?.filter((block) => block.type === "text").map((block) => block.text ?? "").join("")
          : responseBody.choices?.[0]?.message?.content;
        if (typeof raw !== "string") throw new AIResponseError("Model response did not include content");
        const anthropicInputTokens =
          (responseBody.usage?.input_tokens ?? 0) +
          (responseBody.usage?.cache_creation_input_tokens ?? 0) +
          (responseBody.usage?.cache_read_input_tokens ?? 0);
        const inputTokens = this.provider === "anthropic"
          ? anthropicInputTokens
          : responseBody.usage?.prompt_tokens ?? 0;
        const outputTokens = this.provider === "anthropic"
          ? responseBody.usage?.output_tokens ?? 0
          : responseBody.usage?.completion_tokens ?? 0;
        this.usageEvents.push({
          kind,
          model,
          inputTokens,
          outputTokens,
          latencyMs,
          cached: false,
          success: true
        });
        return { body: responseBody, content: raw, latencyMs, inputTokens, outputTokens };
      } catch (error) {
        if (error instanceof AIResponseError) throw error;
        const latencyMs = Date.now() - startedAt;
        lastError = (error as Error).name === "AbortError"
          ? `Model request timed out after ${this.timeoutMs}ms`
          : `Model request failed: ${(error as Error).message}`;
        this.usageEvents.push({
          kind,
          model,
          inputTokens: 0,
          outputTokens: 0,
          latencyMs,
          cached: false,
          success: false,
          error: lastError
        });
        if (attempt < 2) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, this.retryDelayMs * (attempt + 1)));
          continue;
        }
        throw new AIResponseError(lastError);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new AIResponseError(lastError);
  }

  async analyzeControls(call: AnalyzeControlsCall): Promise<AIPageAssessment> {
    const key =
      call.cacheKey ??
      createHash("sha256")
        .update(call.pageUrl)
        .update(JSON.stringify(call.controls))
        .update(call.imageDataUrl ?? "")
        .digest("hex");
    const cached = this.analysisCache.get(key);
    const model = this.options.analysisModel ?? this.options.model;
    if (cached) {
      this.recordCached("analyze", model, cached.usage);
      return { ...cached, cached: true };
    }
    const fileCached = await this.readFileCache<AIPageAssessment>("analysis", key);
    if (
      fileCached &&
      Array.isArray(fileCached.assessments) &&
      fileCached.assessments.every(isAssessment)
    ) {
      this.analysisCache.set(key, fileCached);
      this.recordCached("analyze", model, fileCached.usage);
      return { ...fileCached, cached: true };
    }

    const prompt = [
      "Analyze every supplied UI control.",
      "Return: {\"assessments\":[{\"controlId\":string,\"expectedBehavior\":string,",
      "\"observedBehavior\":string,\"verdict\":\"WORKS\"|\"INERT\"|\"CRASHED\"|\"AMBIGUOUS\",",
      "\"confidence\":number,\"explanation\":string,\"suggestedFix\"?:string,\"suggestedTest\"?:string}]}",
      `Page: ${call.pageUrl}`,
      `Controls: ${JSON.stringify(call.controls)}`
    ].join("\n");
    const completion = await this.complete(
      "analyze",
      model,
      this.options.analyzeMaxTokens ?? 1200,
      prompt,
      call.imageDataUrl ? [call.imageDataUrl] : []
    );
    const parsed = extractJson(completion.content) as { assessments?: unknown };
    if (
      !parsed ||
      !Array.isArray(parsed.assessments) ||
      !parsed.assessments.every(isAssessment) ||
      parsed.assessments.length !== call.controls.length
    ) {
      throw new AIResponseError("Model output did not include one valid assessment per control");
    }

    const result: AIPageAssessment = {
      schemaVersion: 1,
      pageUrl: call.pageUrl,
      assessments: parsed.assessments,
      usage: {
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens
      },
      latencyMs: completion.latencyMs,
      cached: false
    };
    this.analysisCache.set(key, result);
    await this.writeFileCache("analysis", key, result);
    return result;
  }

  async repair(call: RepairCall): Promise<AIRepairResult> {
    const key =
      call.cacheKey ??
      createHash("sha256")
        .update(call.prompt)
        .update(call.imageDataUrls?.join("") ?? "")
        .digest("hex");
    const cached = this.cache.get(key);
    const model = this.options.repairModel ?? this.options.model;
    if (cached) {
      this.recordCached("repair", model, cached.usage);
      return { ...cached, cached: true };
    }
    const fileCached = await this.readFileCache<AIRepairResult>("repair", key);
    if (fileCached && isRepairAttempt(fileCached.attempt)) {
      this.cache.set(key, fileCached);
      this.recordCached("repair", model, fileCached.usage);
      return { ...fileCached, cached: true };
    }

    const completion = await this.complete(
      "repair",
      model,
      this.options.repairMaxTokens ?? 3000,
      call.prompt,
      call.imageDataUrls ?? []
    );
    try {
      const parsed = extractJson(completion.content);
      if (!isRepairAttempt(parsed)) {
        throw new AIResponseError("Model output did not match the repair schema");
      }

      const result: AIRepairResult = {
        attempt: parsed,
        usage: {
          inputTokens: completion.inputTokens,
          outputTokens: completion.outputTokens
        },
        latencyMs: completion.latencyMs,
        cached: false
      };
      this.cache.set(key, result);
      await this.writeFileCache("repair", key, result);
      return result;
    } catch (error) {
      if (error instanceof AIResponseError) throw error;
      throw new AIResponseError(`Model output failed validation: ${(error as Error).message}`);
    }
  }
}
