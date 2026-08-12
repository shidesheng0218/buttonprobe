import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

function runCli(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "cli.ts"), ...args], {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

describe("buttonprobe CLI", () => {
  test("documents scan, AI, and repair-loop options", async () => {
    const result = await runCli(["--help"]);

    expect(result.code).toBe(0);
    expect(result.output).toContain("--ai");
    expect(result.output).toContain("--fix");
    expect(result.output).toContain("--test-command");
    expect(result.output).toContain("--dev-command");
    expect(result.output).toContain("--analysis-model");
    expect(result.output).toContain("--repair-model");
    expect(result.output).toContain("--max-rounds");
    expect(result.output).toContain("scan");
    expect(result.output).toContain("analyze");
    expect(result.output).toContain("fix");
    expect(result.output).toContain("verify");
    expect(result.output).toContain("eval");
    expect(result.output).toContain("doctor");
    expect(result.output).toContain("init");
  });

  test("verify help exposes PR proof options", async () => {
    const result = await runCli(["verify", "--help"]);

    expect(result.code).toBe(0);
    expect(result.output).toContain("--patch");
    expect(result.output).toContain("--patch-url");
    expect(result.output).toContain("--target");
    expect(result.output).toContain("--browser");
  });

  test("rejects fix mode without a model configuration", async () => {
    const result = await runCli(["http://localhost:3000", "--fix"]);

    expect(result.code).not.toBe(0);
    expect(result.output).toContain("BUTTONPROBE_BASE_URL");
  });

  test("scan subcommand runs without AI configuration", async () => {
    const result = await runCli(["scan", "https://example.com"]);

    expect(result.code).not.toBe(0);
    expect(result.output).toContain("localhost");
  });

  test("analyze subcommand requires model configuration", async () => {
    const result = await runCli(["analyze", "http://localhost:3000"]);

    expect(result.code).not.toBe(0);
    expect(result.output).toContain("BUTTONPROBE_BASE_URL");
  });

  test("init writes config without persisting API keys", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "buttonprobe-init-"));
    const result = await runCli(["init", "--project-root", cwd, "--url", "http://localhost:5173", "--test-command", "npm test"], {
      env: { BUTTONPROBE_API_KEY: "secret-key" }
    });

    expect(result.code).toBe(0);
    const config = await readFile(join(cwd, "buttonprobe.config.json"), "utf8");
    expect(config).toContain("http://localhost:5173");
    expect(config).toContain("npm test");
    expect(config).not.toContain("secret-key");
  });

  test("doctor reports missing model configuration with provider examples", async () => {
    const result = await runCli(["doctor", "http://localhost:5173", "--test-command", "npm test"], {
      env: { BUTTONPROBE_BASE_URL: "", BUTTONPROBE_MODEL: "", BUTTONPROBE_API_KEY: "" }
    });

    expect(result.code).not.toBe(0);
    expect(result.output).toContain("OpenAI");
    expect(result.output).toContain("DeepSeek");
    expect(result.output).toContain("Ollama");
  });

  test("eval supports viral and react suites", async () => {
    const result = await runCli(["eval", "react", "--output", ".buttonprobe/eval/react"]);

    expect(result.code).toBe(0);
    expect(result.output).toContain("ButtonProbe react eval");
    expect(result.output).toMatch(/[89]\/10/);
  }, 30_000);

  test("eval external requires explicit network execution", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "buttonprobe-external-eval-"));
    const manifest = join(cwd, "manifest.json");
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(
        manifest,
        JSON.stringify({ cases: [{ name: "repo/save-button", repo: "https://github.com/example/repo", commit: "abc123" }] })
      )
    );
    const result = await runCli(["eval", "external", "--manifest", manifest, "--output", join(cwd, "out")]);

    expect(result.code).not.toBe(0);
    expect(result.output).toContain("--allow-network");
  });

  test("rejects external eval manifests without pinned commits", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "buttonprobe-external-commit-"));
    const manifest = join(cwd, "manifest.json");
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(manifest, JSON.stringify({ cases: [{ name: "demo", repo: "https://github.com/example/demo" }] }))
    );

    const result = await runCli([
      "eval",
      "external",
      "--manifest",
      manifest,
      "--output",
      join(cwd, "out"),
      "--allow-network"
    ]);

    expect(result.code).not.toBe(0);
    expect(result.output).toContain("commit");
  });

  test("does not accept an empty external benchmark as a passing release gate", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "buttonprobe-external-empty-"));
    const manifest = join(cwd, "manifest.json");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(manifest, JSON.stringify({ cases: [] })));

    const result = await runCli([
      "eval",
      "external",
      "--manifest",
      manifest,
      "--output",
      join(cwd, "out"),
      "--allow-network"
    ]);

    expect(result.code).not.toBe(0);
    expect(result.output).toContain("0/0 passed");
  });

  test("init provider presets write endpoint defaults without API keys", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "buttonprobe-init-provider-"));
    const result = await runCli(["init", "--project-root", cwd, "--provider", "deepseek"], {
      env: { BUTTONPROBE_API_KEY: "secret-key" }
    });

    expect(result.code).toBe(0);
    const config = await readFile(join(cwd, "buttonprobe.config.json"), "utf8");
    expect(config).toContain("https://api.deepseek.com");
    expect(config).toContain("deepseek-chat");
    expect(config).not.toContain("secret-key");
  });

  test("init supports the native Anthropic Claude provider preset", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "buttonprobe-init-anthropic-"));
    const result = await runCli(["init", "--project-root", cwd, "--provider", "anthropic"], {
      env: { ANTHROPIC_API_KEY: "secret-claude-key" }
    });

    expect(result.code).toBe(0);
    const config = await readFile(join(cwd, "buttonprobe.config.json"), "utf8");
    expect(config).toContain('"provider": "anthropic"');
    expect(config).toContain("https://api.anthropic.com");
    expect(config).toContain("claude-sonnet-5");
    expect(config).not.toContain("secret-claude-key");
  });
});
