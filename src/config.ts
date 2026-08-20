import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { BehaviorContract, BrowserName, BusinessProfile, NetworkSafetyMode, ScenarioContract } from "./types.js";
import type { WorkflowOptions } from "./workflow.js";

export interface ButtonProbeConfig {
  provider?: "openai-compatible" | "anthropic" | undefined;
  baseUrl?: string | undefined;
  outputDir?: string | undefined;
  projectRoot?: string | undefined;
  maxPages?: number | undefined;
  interactionTimeoutMs?: number | undefined;
  timeout?: number | undefined;
  unsafe?: boolean | undefined;
  ai?: boolean | undefined;
  fix?: boolean | undefined;
  testCommand?: string | undefined;
  devCommand?: string | undefined;
  buildCommand?: string | undefined;
  startCommand?: string | undefined;
  readyUrl?: string | undefined;
  storageState?: string | undefined;
  maxRounds?: number | undefined;
  maxModelCalls?: number | undefined;
  maxFixIssues?: number | undefined;
  images?: boolean | undefined;
  apiBaseUrl?: string | undefined;
  model?: string | undefined;
  analysisModel?: string | undefined;
  repairModel?: string | undefined;
  analyzeMaxTokens?: number | undefined;
  repairMaxTokens?: number | undefined;
  behaviorContracts?: Record<string, BehaviorContract> | undefined;
  scenarios?: Record<string, ScenarioContract> | undefined;
  profiles?: Record<string, BusinessProfile> | undefined;
  browsers?: BrowserName[] | undefined;
}

function assertNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid buttonprobe.config.json field "${field}": expected number`);
  }
  return value;
}

function assertString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Invalid buttonprobe.config.json field "${field}": expected string`);
  }
  return value;
}

function assertBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`Invalid buttonprobe.config.json field "${field}": expected boolean`);
  }
  return value;
}

function assertProvider(value: unknown): "openai-compatible" | "anthropic" | undefined {
  if (value === undefined) return undefined;
  if (value !== "openai-compatible" && value !== "anthropic") {
    throw new Error('Invalid buttonprobe.config.json field "provider": expected openai-compatible or anthropic');
  }
  return value;
}

function assertStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid buttonprobe.config.json field "${field}": expected string array`);
  }
  return value;
}

function assertNetworkMode(value: unknown, field: string): NetworkSafetyMode | undefined {
  if (value === undefined) return undefined;
  if (value !== "observe" && value !== "sandbox" && value !== "replay") {
    throw new Error(`Invalid buttonprobe.config.json field "${field}": expected observe, sandbox, or replay`);
  }
  return value;
}

function assertProfiles(value: unknown): Record<string, BusinessProfile> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error('Invalid buttonprobe.config.json field "profiles": expected object');
  }
  const profiles: Record<string, BusinessProfile> = {};
  for (const [name, rawProfile] of Object.entries(value as Record<string, unknown>)) {
    if (!rawProfile || typeof rawProfile !== "object" || Array.isArray(rawProfile)) {
      throw new Error(`Invalid buttonprobe.config.json field "profiles.${name}": expected object`);
    }
    const profile = rawProfile as Record<string, unknown>;
    const storageState = assertString(profile.storageState, `profiles.${name}.storageState`);
    const routes = assertStringArray(profile.routes, `profiles.${name}.routes`);
    const networkMode = assertNetworkMode(profile.networkMode, `profiles.${name}.networkMode`);
    const replayHar = assertString(profile.replayHar, `profiles.${name}.replayHar`);
    const setupCommand = assertString(profile.setupCommand, `profiles.${name}.setupCommand`);
    const resetCommand = assertString(profile.resetCommand, `profiles.${name}.resetCommand`);
    profiles[name] = {
      ...(storageState ? { storageState } : {}),
      ...(routes ? { routes } : {}),
      ...(networkMode ? { networkMode } : {}),
      ...(replayHar ? { replayHar } : {}),
      ...(setupCommand ? { setupCommand } : {}),
      ...(resetCommand ? { resetCommand } : {})
    };
  }
  return profiles;
}

function assertBehaviorContracts(value: unknown): Record<string, BehaviorContract> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error('Invalid buttonprobe.config.json field "behaviorContracts": expected object');
  }
  const contracts: Record<string, BehaviorContract> = {};
  for (const [controlId, rawContract] of Object.entries(value as Record<string, unknown>)) {
    if (!rawContract || typeof rawContract !== "object" || Array.isArray(rawContract)) {
      throw new Error(`Invalid buttonprobe.config.json field "behaviorContracts.${controlId}": expected object`);
    }
    const contract = rawContract as Record<string, unknown>;
    const parseGroup = (groupName: "expect" | "forbid") => {
      const rawGroup = contract[groupName];
      if (rawGroup === undefined) return undefined;
      if (!rawGroup || typeof rawGroup !== "object" || Array.isArray(rawGroup)) {
        throw new Error(`Invalid buttonprobe.config.json field "behaviorContracts.${controlId}.${groupName}": expected object`);
      }
      const group = rawGroup as Record<string, unknown>;
      const text = assertStringArray(group.text, `behaviorContracts.${controlId}.${groupName}.text`);
      const visible = groupName === "expect"
        ? assertStringArray(group.visible, `behaviorContracts.${controlId}.expect.visible`)
        : undefined;
      const urlIncludes = assertString(group.urlIncludes, `behaviorContracts.${controlId}.${groupName}.urlIncludes`);
      const network = groupName === "expect"
        ? assertStringArray(group.network, `behaviorContracts.${controlId}.expect.network`)
        : undefined;
      const consoleClean = groupName === "expect"
        ? assertBoolean(group.consoleClean, `behaviorContracts.${controlId}.expect.consoleClean`)
        : undefined;
      const consoleError = groupName === "forbid"
        ? assertBoolean(group.consoleError, `behaviorContracts.${controlId}.forbid.consoleError`)
        : undefined;
      return {
        ...(text ? { text } : {}),
        ...(visible ? { visible } : {}),
        ...(urlIncludes ? { urlIncludes } : {}),
        ...(network ? { network } : {}),
        ...(consoleClean !== undefined ? { consoleClean } : {}),
        ...(consoleError !== undefined ? { consoleError } : {})
      };
    };
    const expectGroup = parseGroup("expect");
    const forbidGroup = parseGroup("forbid");
    if (!expectGroup && !forbidGroup) {
      throw new Error(`Invalid buttonprobe.config.json field "behaviorContracts.${controlId}": expected expect or forbid`);
    }
    contracts[controlId] = {
      ...(expectGroup ? { expect: expectGroup } : {}),
      ...(forbidGroup ? { forbid: forbidGroup } : {})
    };
  }
  return contracts;
}

function assertScenarioAction(value: unknown, field: string): ScenarioContract["actions"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid buttonprobe.config.json field "${field}": expected object`);
  }
  const action = value as Record<string, unknown>;
  if (action.type !== "click") throw new Error(`Invalid buttonprobe.config.json field "${field}.type": expected click`);
  const selector = assertString(action.selector, `${field}.selector`);
  if (!selector) throw new Error(`Invalid buttonprobe.config.json field "${field}.selector": expected string`);
  return { type: "click", selector };
}

function assertScenarioExpectation(value: unknown, field: string): NonNullable<ScenarioContract["expect"]>[number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid buttonprobe.config.json field "${field}": expected object`);
  }
  const check = value as Record<string, unknown>;
  if (check.type === "text" || check.type === "urlIncludes" || check.type === "network") {
    const expectedValue = assertString(check.value, `${field}.value`);
    if (!expectedValue) throw new Error(`Invalid buttonprobe.config.json field "${field}.value": expected string`);
    return { type: check.type, value: expectedValue };
  }
  if (check.type === "visible") {
    const selector = assertString(check.selector, `${field}.selector`);
    if (!selector) throw new Error(`Invalid buttonprobe.config.json field "${field}.selector": expected string`);
    return { type: "visible", selector };
  }
  if (check.type === "consoleClean") return { type: "consoleClean" };
  throw new Error(`Invalid buttonprobe.config.json field "${field}.type": expected text, visible, urlIncludes, network, or consoleClean`);
}

function assertScenarioForbid(value: unknown, field: string): NonNullable<ScenarioContract["forbid"]>[number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid buttonprobe.config.json field "${field}": expected object`);
  }
  const check = value as Record<string, unknown>;
  if (check.type === "consoleError") return { type: "consoleError" };
  if (check.type === "text" || check.type === "urlIncludes" || check.type === "network") {
    const expectedValue = assertString(check.value, `${field}.value`);
    if (!expectedValue) throw new Error(`Invalid buttonprobe.config.json field "${field}.value": expected string`);
    return { type: check.type, value: expectedValue };
  }
  throw new Error(`Invalid buttonprobe.config.json field "${field}.type": expected text, urlIncludes, consoleError, or network`);
}

function assertScenarios(value: unknown): Record<string, ScenarioContract> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error('Invalid buttonprobe.config.json field "scenarios": expected object');
  }
  const scenarios: Record<string, ScenarioContract> = {};
  for (const [name, rawScenario] of Object.entries(value as Record<string, unknown>)) {
    if (!rawScenario || typeof rawScenario !== "object" || Array.isArray(rawScenario)) {
      throw new Error(`Invalid buttonprobe.config.json field "scenarios.${name}": expected object`);
    }
    const scenario = rawScenario as Record<string, unknown>;
    const target = assertString(scenario.target, `scenarios.${name}.target`);
    if (!target) throw new Error(`Invalid buttonprobe.config.json field "scenarios.${name}.target": expected string`);
    const route = assertString(scenario.route, `scenarios.${name}.route`);
    const actionsRaw = scenario.actions;
    if (!Array.isArray(actionsRaw) || actionsRaw.length === 0) {
      throw new Error(`Invalid buttonprobe.config.json field "scenarios.${name}.actions": expected non-empty array`);
    }
    const expectRaw = scenario.expect;
    const forbidRaw = scenario.forbid;
    scenarios[name] = {
      ...(route ? { route } : {}),
      target,
      actions: actionsRaw.map((action, index) => assertScenarioAction(action, `scenarios.${name}.actions.${index}`)),
      ...(expectRaw !== undefined
        ? {
            expect: (Array.isArray(expectRaw) ? expectRaw : (() => {
              throw new Error(`Invalid buttonprobe.config.json field "scenarios.${name}.expect": expected array`);
            })()).map((check, index) => assertScenarioExpectation(check, `scenarios.${name}.expect.${index}`))
          }
        : {}),
      ...(forbidRaw !== undefined
        ? {
            forbid: (Array.isArray(forbidRaw) ? forbidRaw : (() => {
              throw new Error(`Invalid buttonprobe.config.json field "scenarios.${name}.forbid": expected array`);
            })()).map((check, index) => assertScenarioForbid(check, `scenarios.${name}.forbid.${index}`))
          }
        : {})
    };
  }
  return scenarios;
}

export async function loadButtonProbeConfig(projectRoot: string): Promise<ButtonProbeConfig> {
  const paths = [join(projectRoot, ".buttonprobe", "config.json"), join(projectRoot, "buttonprobe.config.json")];
  let raw = "";
  for (const path of paths) {
    try {
      raw = await readFile(path, "utf8");
      break;
    } catch {
      // Fall back to the legacy root config.
    }
  }
  if (!raw) return {};
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return {
    provider: assertProvider(parsed.provider),
    baseUrl: assertString(parsed.baseUrl, "baseUrl"),
    outputDir: assertString(parsed.outputDir, "outputDir"),
    projectRoot: assertString(parsed.projectRoot, "projectRoot"),
    maxPages: assertNumber(parsed.maxPages, "maxPages"),
    interactionTimeoutMs: assertNumber(parsed.interactionTimeoutMs, "interactionTimeoutMs"),
    timeout: assertNumber(parsed.timeout, "timeout"),
    unsafe: assertBoolean(parsed.unsafe, "unsafe"),
    ai: assertBoolean(parsed.ai, "ai"),
    fix: assertBoolean(parsed.fix, "fix"),
    testCommand: assertString(parsed.testCommand, "testCommand"),
    devCommand: assertString(parsed.devCommand, "devCommand"),
    buildCommand: assertString(parsed.buildCommand, "buildCommand"),
    startCommand: assertString(parsed.startCommand, "startCommand"),
    readyUrl: assertString(parsed.readyUrl, "readyUrl"),
    storageState: assertString(parsed.storageState, "storageState"),
    maxRounds: assertNumber(parsed.maxRounds, "maxRounds"),
    maxModelCalls: assertNumber(parsed.maxModelCalls, "maxModelCalls"),
    maxFixIssues: assertNumber(parsed.maxFixIssues, "maxFixIssues"),
    images: assertBoolean(parsed.images, "images"),
    apiBaseUrl: assertString(parsed.apiBaseUrl, "apiBaseUrl"),
    model: assertString(parsed.model, "model"),
    analysisModel: assertString(parsed.analysisModel, "analysisModel"),
    repairModel: assertString(parsed.repairModel, "repairModel"),
    analyzeMaxTokens: assertNumber(parsed.analyzeMaxTokens, "analyzeMaxTokens"),
    repairMaxTokens: assertNumber(parsed.repairMaxTokens, "repairMaxTokens"),
    behaviorContracts: assertBehaviorContracts(parsed.behaviorContracts),
    scenarios: assertScenarios(parsed.scenarios),
    profiles: assertProfiles(parsed.profiles)
  };
}

function resolveFrom(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path);
}

function resolveProfile(root: string, profile: BusinessProfile | undefined): BusinessProfile | undefined {
  if (!profile) return undefined;
  return {
    ...(profile.storageState ? { storageState: resolveFrom(root, profile.storageState) } : {}),
    ...(profile.routes ? { routes: [...profile.routes] } : {}),
    ...(profile.networkMode ? { networkMode: profile.networkMode } : {}),
    ...(profile.replayHar ? { replayHar: resolveFrom(root, profile.replayHar) } : {}),
    ...(profile.setupCommand ? { setupCommand: profile.setupCommand } : {}),
    ...(profile.resetCommand ? { resetCommand: profile.resetCommand } : {})
  };
}

export function mergeWorkflowOptions(
  config: ButtonProbeConfig,
  overrides: Partial<WorkflowOptions>,
  projectRoot: string
): WorkflowOptions {
  const root = resolve(overrides.projectRoot ?? config.projectRoot ?? projectRoot);
  const outputDir = resolveFrom(root, overrides.outputDir ?? config.outputDir ?? ".buttonprobe");
  const profile = resolveProfile(root, overrides.profile);
  const baseUrl = overrides.baseUrl ?? config.baseUrl;
  if (!baseUrl) throw new Error("ButtonProbe requires a URL or baseUrl config value");

  return {
    provider: overrides.provider ?? config.provider,
    baseUrl,
    outputDir,
    projectRoot: root,
    maxPages: overrides.maxPages ?? config.maxPages ?? 5,
    interactionTimeoutMs:
      overrides.interactionTimeoutMs ?? config.interactionTimeoutMs ?? config.timeout ?? 750,
    unsafe: overrides.unsafe ?? config.unsafe ?? false,
    ai: overrides.ai ?? config.ai ?? false,
    fix: overrides.fix ?? config.fix ?? false,
    testCommand: overrides.testCommand ?? config.testCommand,
    devCommand: overrides.devCommand ?? config.devCommand,
    maxRounds: overrides.maxRounds ?? config.maxRounds ?? 3,
    images: overrides.images ?? config.images ?? true,
    apiBaseUrl: overrides.apiBaseUrl ?? config.apiBaseUrl,
    apiKey: overrides.apiKey,
    model: overrides.model ?? config.model,
    analysisModel: overrides.analysisModel ?? config.analysisModel,
    repairModel: overrides.repairModel ?? config.repairModel,
    analyzeMaxTokens: overrides.analyzeMaxTokens ?? config.analyzeMaxTokens ?? 1200,
    repairMaxTokens: overrides.repairMaxTokens ?? config.repairMaxTokens ?? 3000,
    maxModelCalls: overrides.maxModelCalls ?? config.maxModelCalls ?? 14,
    maxFixIssues: overrides.maxFixIssues ?? config.maxFixIssues ?? 3,
    browsers: overrides.browsers ?? config.browsers ?? ["chromium"],
    ...(config.behaviorContracts ? { behaviorContracts: config.behaviorContracts } : {}),
    ...(config.scenarios ? { scenarios: config.scenarios } : {}),
    apply: overrides.apply ?? false,
    ...(profile ? { profile } : {})
  };
}
