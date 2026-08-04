import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadButtonProbeConfig, mergeWorkflowOptions } from "../src/config.js";

describe("ButtonProbe config", () => {
  test("loads buttonprobe.config.json from the project root", async () => {
    const root = await mkdtemp(join(tmpdir(), "buttonprobe-config-"));
    await writeFile(
      join(root, "buttonprobe.config.json"),
      JSON.stringify({
        baseUrl: "http://localhost:5173",
        provider: "anthropic",
        maxPages: 3,
        testCommand: "npm test",
        devCommand: "npm run dev -- --port {port}",
        analysisModel: "cheap-model",
        repairModel: "strong-model",
        analyzeMaxTokens: 1200,
        repairMaxTokens: 3000,
        maxModelCalls: 9,
        behaviorContracts: {
          save: {
            expect: { text: ["Saved"], visible: ["[data-testid='toast']"] },
            forbid: { text: ["Error"], consoleError: true }
          }
        }
      })
    );

    const config = await loadButtonProbeConfig(root);

    expect(config).toMatchObject({
      baseUrl: "http://localhost:5173",
      provider: "anthropic",
      maxPages: 3,
      testCommand: "npm test",
      devCommand: "npm run dev -- --port {port}",
      analysisModel: "cheap-model",
      repairModel: "strong-model",
      analyzeMaxTokens: 1200,
      repairMaxTokens: 3000,
      maxModelCalls: 9,
      behaviorContracts: {
        save: {
          expect: { text: ["Saved"], visible: ["[data-testid='toast']"] },
          forbid: { text: ["Error"], consoleError: true }
        }
      }
    });
  });

  test("CLI options override config file values", () => {
    const merged = mergeWorkflowOptions(
      {
        baseUrl: "http://localhost:3000",
        maxPages: 2,
        interactionTimeoutMs: 500,
        testCommand: "npm test"
      },
      {
        baseUrl: "http://localhost:4173",
        maxPages: 1,
        outputDir: ".custom"
      },
      "/repo"
    );

    expect(merged.baseUrl).toBe("http://localhost:4173");
    expect(merged.maxPages).toBe(1);
    expect(merged.interactionTimeoutMs).toBe(500);
    expect(merged.outputDir).toBe("/repo/.custom");
    expect(merged.testCommand).toBe("npm test");
  });

  test("loads named business profiles with a constrained network mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "buttonprobe-profile-config-"));
    await writeFile(
      join(root, "buttonprobe.config.json"),
      JSON.stringify({
        baseUrl: "http://localhost:5173",
        profiles: {
          reviewer: {
            storageState: ".buttonprobe/auth/reviewer.json",
            routes: ["/orders", "/orders/42"],
            networkMode: "replay",
            replayHar: ".buttonprobe/fixtures/orders.har"
          }
        }
      })
    );

    const config = await loadButtonProbeConfig(root);

    expect(config.profiles?.reviewer).toEqual({
      storageState: ".buttonprobe/auth/reviewer.json",
      routes: ["/orders", "/orders/42"],
      networkMode: "replay",
      replayHar: ".buttonprobe/fixtures/orders.har"
    });
  });

  test("loads scenario contracts alongside legacy behavior contracts", async () => {
    const root = await mkdtemp(join(tmpdir(), "buttonprobe-scenario-config-"));
    await writeFile(
      join(root, "buttonprobe.config.json"),
      JSON.stringify({
        baseUrl: "http://localhost:5173",
        scenarios: {
          "save-profile": {
            route: "/profile",
            target: "[data-testid='save-profile']",
            actions: [{ type: "click", selector: "[data-testid='save-profile']" }],
            expect: [
              { type: "text", value: "Saved" },
              { type: "visible", selector: "[data-testid='save-toast']" },
              { type: "urlIncludes", value: "/profile" }
            ],
            forbid: [
              { type: "text", value: "Error" },
              { type: "consoleError" },
              { type: "urlIncludes", value: "/login" }
            ]
          }
        }
      })
    );

    const config = await loadButtonProbeConfig(root);
    const merged = mergeWorkflowOptions(config, {}, root);

    expect(config.scenarios?.["save-profile"]?.target).toBe("[data-testid='save-profile']");
    expect(config.scenarios?.["save-profile"]?.expect).toContainEqual({ type: "text", value: "Saved" });
    expect(merged.scenarios?.["save-profile"]?.forbid).toContainEqual({ type: "consoleError" });
  });
});
