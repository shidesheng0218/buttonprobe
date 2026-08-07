#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { loadButtonProbeConfig, mergeWorkflowOptions } from "./config.js";
import { runDoctor } from "./doctor.js";
import { writeInitialConfig } from "./init-config.js";
import { runPatchVerification } from "./patch-proof.js";
import { releaseGatePassed, runExternalEval, runReactEval, runViralEval } from "./viral-eval.js";
import { runButtonProbe } from "./workflow.js";
import type { WorkflowOptions } from "./workflow.js";
import type { BrowserName } from "./types.js";

function integer(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid number: ${value}`);
  return parsed;
}

type CliMode = "legacy" | "scan" | "analyze" | "fix";

function addSharedOptions(command: Command): Command {
  return command
    .option("-o, --output <directory>", "report output directory")
    .option("--project-root <directory>", "source repository root")
    .option("--max-pages <number>", "maximum same-origin pages", integer)
    .option("--timeout <milliseconds>", "post-click observation window", integer)
    .option("--unsafe", "allow controls with destructive labels")
    .option("--test-command <command>", "test command used as the repair gate")
    .option("--dev-command <command>", "development server command for isolated UI verification; use {port}")
    .option("--provider <provider>", "model API provider: openai-compatible or anthropic")
    .option("--analysis-model <model>", "lower-cost model used for page analysis")
    .option("--repair-model <model>", "model used to generate repair diffs")
    .option("--analyze-max-tokens <number>", "maximum analysis output tokens", integer)
    .option("--repair-max-tokens <number>", "maximum repair output tokens", integer)
    .option("--max-rounds <number>", "repair rounds per issue, capped at 3", integer)
    .option("--max-model-calls <number>", "maximum model requests per run", integer)
    .option("--max-fix-issues <number>", "maximum controls to repair per run", integer)
    .option("--browser <list>", "browsers for UI verification, e.g. chromium,firefox,webkit", "chromium")
    .option("--profile <name>", "named business profile from buttonprobe.config.json")
    .option("--apply", "apply a verified repair diff back to the current checkout")
    .option("--no-images", "do not send screenshots to the model");
}

function option<T>(command: Command, name: string): T | undefined {
  return command.getOptionValueSource(name) === undefined ? undefined : (command.getOptionValue(name) as T);
}

function modeOverrides(mode: CliMode, flags: { ai?: boolean; fix?: boolean }): Pick<WorkflowOptions, "ai" | "fix"> {
  if (mode === "scan") return { ai: false, fix: false };
  if (mode === "analyze") return { ai: true, fix: false };
  if (mode === "fix") return { ai: true, fix: true };
  return { ai: Boolean(flags.ai || flags.fix), fix: Boolean(flags.fix) };
}

function setOption<K extends keyof WorkflowOptions>(
  target: Partial<WorkflowOptions>,
  key: K,
  value: WorkflowOptions[K] | undefined
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function parseBrowsers(raw: string): BrowserName[] {
  const browsers = raw.split(",").map((item) => item.trim()).filter(Boolean);
  if (!browsers.length || browsers.some((browser) => !["chromium", "firefox", "webkit"].includes(browser))) {
    throw new Error("--browser must be a comma-separated list of chromium, firefox, and webkit");
  }
  return [...new Set(browsers)] as BrowserName[];
}

async function execute(url: string, command: Command, mode: CliMode): Promise<void> {
  const projectRoot = resolve(option<string>(command, "projectRoot") ?? process.cwd());
  const config = await loadButtonProbeConfig(projectRoot);
  const flags = command.optsWithGlobals<{
    ai?: boolean;
    fix?: boolean;
    output?: string;
    projectRoot?: string;
    maxPages?: number;
    timeout?: number;
    unsafe?: boolean;
    testCommand?: string;
    devCommand?: string;
    provider?: string;
    analysisModel?: string;
    repairModel?: string;
    analyzeMaxTokens?: number;
    repairMaxTokens?: number;
    maxRounds?: number;
    maxModelCalls?: number;
    maxFixIssues?: number;
    profile?: string;
    apply?: boolean;
    images?: boolean;
  }>();
  const aiOptions = modeOverrides(mode, flags);
  const apiBaseUrl = process.env.BUTTONPROBE_BASE_URL ?? config.apiBaseUrl;
  const providerValue = process.env.BUTTONPROBE_PROVIDER ?? option<string>(command, "provider") ?? config.provider;
  if (providerValue && providerValue !== "openai-compatible" && providerValue !== "anthropic") {
    throw new Error("--provider must be openai-compatible or anthropic");
  }
  const provider = providerValue as WorkflowOptions["provider"];
  const analysisModel = process.env.BUTTONPROBE_ANALYSIS_MODEL ?? option<string>(command, "analysisModel") ?? config.analysisModel;
  const repairModel = process.env.BUTTONPROBE_REPAIR_MODEL ?? option<string>(command, "repairModel") ?? config.repairModel;
  const profileName = option<string>(command, "profile");
  const profile = profileName ? config.profiles?.[profileName] : undefined;
  if (profileName && !profile) {
    throw new Error(`Unknown profile "${profileName}". Define it in buttonprobe.config.json profiles.`);
  }
  const model = process.env.BUTTONPROBE_MODEL ?? config.model ?? repairModel ?? analysisModel;
  if ((aiOptions.ai || aiOptions.fix) && (!apiBaseUrl || !model)) {
    throw new Error("AI mode requires BUTTONPROBE_BASE_URL and BUTTONPROBE_MODEL (or stage-specific models)");
  }

  const overrides: Partial<WorkflowOptions> = {
    baseUrl: url,
    projectRoot,
    maxRounds: Math.min(option<number>(command, "maxRounds") ?? config.maxRounds ?? 3, 3),
    ...aiOptions
  };
  setOption(overrides, "outputDir", option<string>(command, "output"));
  setOption(overrides, "maxPages", option<number>(command, "maxPages"));
  setOption(overrides, "interactionTimeoutMs", option<number>(command, "timeout"));
  setOption(overrides, "unsafe", option<boolean>(command, "unsafe"));
  setOption(overrides, "testCommand", option<string>(command, "testCommand"));
  setOption(overrides, "devCommand", option<string>(command, "devCommand"));
  setOption(overrides, "provider", provider);
  setOption(overrides, "analysisModel", analysisModel);
  setOption(overrides, "repairModel", repairModel);
  setOption(overrides, "analyzeMaxTokens", option<number>(command, "analyzeMaxTokens"));
  setOption(overrides, "repairMaxTokens", option<number>(command, "repairMaxTokens"));
  setOption(overrides, "maxModelCalls", option<number>(command, "maxModelCalls"));
  setOption(overrides, "maxFixIssues", option<number>(command, "maxFixIssues"));
  setOption(overrides, "browsers", parseBrowsers(option<string>(command, "browser") ?? "chromium"));
  setOption(overrides, "profile", profile);
  setOption(overrides, "apply", option<boolean>(command, "apply"));
  setOption(overrides, "images", option<boolean>(command, "images"));
  setOption(overrides, "apiBaseUrl", apiBaseUrl);
  setOption(overrides, "model", model);
  setOption(
    overrides,
    "apiKey",
    process.env.BUTTONPROBE_API_KEY ?? (provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : undefined)
  );

  const merged = mergeWorkflowOptions(config, overrides, process.cwd());

  const result = await runButtonProbe({
    ...merged,
    outputDir: resolve(merged.outputDir),
    projectRoot: resolve(merged.projectRoot)
  });

  const controls = result.scan.pages.flatMap((page) => page.controls);
  const issues = controls.filter((control) => control.verdict === "INERT" || control.verdict === "CRASHED");
  process.stdout.write(
    [
      `Scanned ${result.scan.pages.length} page(s) and ${controls.length} control(s).`,
      `Found ${issues.length} actionable issue(s).`,
      `Report: ${result.reportPath}`
    ].join("\n") + "\n"
  );
}

const program = addSharedOptions(
  new Command()
    .name("buttonprobe")
    .description("Find, explain, and repair inert UI controls.")
    .argument("[url]", "localhost URL to scan")
    .option("--ai", "analyze all controls with a bring-your-own model")
    .option("--fix", "run the bounded automatic repair loop")
    .showHelpAfterError()
);

program.action(async (url: string | undefined, _flags, command) => {
  if (!url) {
    command.help();
    return;
  }
  await execute(url, command, "legacy");
});

addSharedOptions(program.command("scan").description("scan localhost UI controls without AI")).argument(
  "<url>",
  "localhost URL to scan"
).action(async (url: string, _flags, command) => execute(url, command, "scan"));

addSharedOptions(program.command("analyze").description("scan and explain controls with a configured model")).argument(
  "<url>",
  "localhost URL to analyze"
).action(async (url: string, _flags, command) => execute(url, command, "analyze"));

addSharedOptions(program.command("fix").description("run the bounded proof-carrying repair loop")).argument(
  "<url>",
  "localhost URL to repair"
).action(async (url: string, _flags, command) => execute(url, command, "fix"));

program
  .command("verify")
  .description("verify an existing unified diff in an isolated UI proof worktree")
  .argument("<url>", "localhost URL to scan before verification")
  .requiredOption("--patch <file>", "unified diff generated by an external agent")
  .requiredOption("--test-command <command>", "test command used as the proof gate")
  .option("--dev-command <command>", "patched worktree development server command; use {port}")
  .option("-o, --output <directory>", "proof output directory", ".buttonprobe/verify")
  .option("--project-root <directory>", "source repository root", process.cwd())
  .option("--timeout <milliseconds>", "post-click observation window", integer)
  .option("--unsafe", "allow controls with destructive labels")
  .option("--apply", "apply only when the patch is ui-verified")
  .option("--browser <list>", "browser list for report metadata, e.g. chromium,firefox,webkit", "chromium")
  .action(async (url: string, _flags, command) => {
    const flags = command.optsWithGlobals() as {
      patch: string;
      testCommand: string;
      devCommand?: string;
      output: string;
      projectRoot: string;
      timeout?: number;
      unsafe?: boolean;
      apply?: boolean;
      browser: string;
    };
    const projectRoot = resolve(flags.projectRoot);
    const config = await loadButtonProbeConfig(projectRoot);
    const browsers = flags.browser.split(",").map((item) => item.trim()).filter(Boolean);
    if (browsers.some((browser) => browser !== "chromium" && browser !== "firefox" && browser !== "webkit")) {
      throw new Error("--browser must be a comma-separated list of chromium, firefox, and webkit");
    }
    const devCommand = flags.devCommand ?? config.devCommand;
    const result = await runPatchVerification({
      baseUrl: url,
      patchPath: resolve(flags.patch),
      projectRoot,
      outputDir: resolve(flags.output),
      testCommand: flags.testCommand,
      ...(devCommand ? { devCommand } : {}),
      ...(flags.timeout ? { interactionTimeoutMs: flags.timeout } : {}),
      unsafe: Boolean(flags.unsafe),
      apply: Boolean(flags.apply),
      ...(config.scenarios ? { scenarios: config.scenarios } : {}),
      browsers: browsers as Array<"chromium" | "firefox" | "webkit">
    });
    process.stdout.write(
      [
        `ButtonProbe verify: ${result.status}`,
        `Model calls: ${result.usageSummary.modelCalls}`,
        `Proof: ${result.proofPath}`,
        `Report: ${result.reportPath}`,
        ...(result.verifiedDiffPath ? [`Verified diff: ${result.verifiedDiffPath}`] : [])
      ].join("\n") + "\n"
    );
    if (result.status !== "ui-verified") process.exitCode = 1;
  });

program
  .command("eval")
  .description("run reproducible ButtonProbe benchmark suites")
  .argument("[suite]", "benchmark suite to run", "viral")
  .option("-o, --output <directory>", "eval output directory")
  .option("--manifest <file>", "external eval manifest for eval external")
  .option("--allow-network", "allow cloning public external benchmark repositories")
  .option("--case <name>", "run one named fixture case")
  .option("--fail-fast", "stop fixture eval after the first failed case")
  .option("--timeout <milliseconds>", "per-case eval timeout", integer)
  .action(async (suite: string, _flags, command) => {
    if (suite !== "viral" && suite !== "react" && suite !== "external" && suite !== "smoke") {
      throw new Error(`Unknown eval suite: ${suite}`);
    }
    const flags = command.optsWithGlobals() as {
      output?: string;
      manifest?: string;
      allowNetwork?: boolean;
      case?: string;
      failFast?: boolean;
      timeout?: number;
    };
    const output = resolve(flags.output ?? `.buttonprobe/eval/${suite}`);
    if (suite === "external") {
      if (!flags.manifest) throw new Error("buttonprobe eval external requires --manifest");
      const result = await runExternalEval({
        outputDir: output,
        manifestPath: resolve(flags.manifest),
        allowNetwork: Boolean(flags.allowNetwork),
        ...(flags.case ? { caseName: flags.case } : {}),
        ...(flags.timeout ? { timeoutMs: flags.timeout } : {})
      });
      process.stdout.write(
        [
          `ButtonProbe external eval: ${result.summary.passed}/${result.summary.total} passed.`,
          `Results: ${resolve(output, "eval-results.json")}`
        ].join("\n") + "\n"
      );
      if (result.summary.total === 0 || result.summary.passed !== result.summary.total) process.exitCode = 1;
      return;
    }
    const evalOptions = {
      outputDir: output,
      ...(flags.case ? { caseSlug: flags.case } : {}),
      ...(flags.failFast ? { failFast: true } : {}),
      ...(flags.timeout ? { timeoutMs: flags.timeout } : {})
    };
    const result = suite === "viral"
      ? await runViralEval(evalOptions)
      : suite === "smoke"
        ? await runViralEval({ ...evalOptions, caseSlug: flags.case ?? "empty-onclick" })
        : await runReactEval(evalOptions);
    process.stdout.write(
      [
        `ButtonProbe ${suite} eval: ${result.summary.passed}/${result.summary.total} passed.`,
        `Original repo pollution rate: ${result.summary.originalRepoPollutionRate}`,
        `Results: ${resolve(output, "eval-results.json")}`
      ].join("\n") + "\n"
    );
    if (suite !== "smoke" && !releaseGatePassed(result, suite as "viral" | "react")) process.exitCode = 1;
  });

program
  .command("doctor")
  .description("check local readiness for scan, analyze, and repair")
  .argument("[url]", "localhost URL to check")
  .option("--project-root <directory>", "source repository root", process.cwd())
  .option("--test-command <command>", "test command used as the repair gate")
  .action(async (url: string | undefined, _flags, command) => {
    const flags = command.optsWithGlobals() as { projectRoot: string; testCommand?: string };
    const doctorOptions = {
      projectRoot: resolve(flags.projectRoot),
      ...(url ? { url } : {}),
      ...(flags.testCommand ? { testCommand: flags.testCommand } : {})
    };
    const result = await runDoctor(doctorOptions);
    for (const check of result.checks) {
      process.stdout.write(`${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.message}\n`);
    }
    if (!result.ok) process.exitCode = 1;
  });

program
  .command("init")
  .description("write buttonprobe.config.json without storing API keys")
  .option("--url <url>", "default localhost URL", "http://localhost:5173")
  .option("--project-root <directory>", "source repository root", process.cwd())
  .option("--test-command <command>", "test command used as the repair gate")
  .option("--provider <provider>", "provider preset: openai, deepseek, ollama, openrouter, or anthropic")
  .action(async (_flags, command) => {
    const flags = command.optsWithGlobals() as {
      url: string;
      projectRoot: string;
      testCommand?: string;
      provider?: string;
    };
    const path = await writeInitialConfig({
      projectRoot: resolve(flags.projectRoot),
      url: flags.url,
      ...(flags.provider ? { provider: flags.provider } : {}),
      ...(flags.testCommand ? { testCommand: flags.testCommand } : {})
    });
    process.stdout.write(
      [
        `Wrote ${path}`,
        "API keys are not stored. Configure BUTTONPROBE_BASE_URL, BUTTONPROBE_MODEL, and BUTTONPROBE_API_KEY in your shell."
      ].join("\n") + "\n"
    );
  });

program.parseAsync(process.argv).catch((error) => {
  process.stderr.write(`ButtonProbe error: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
