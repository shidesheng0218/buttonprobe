import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface InitConfigOptions {
  projectRoot: string;
  url: string;
  testCommand?: string;
  provider?: string;
}

const providerPresets: Record<string, {
  provider: "openai-compatible" | "anthropic";
  apiBaseUrl: string;
  model: string;
}> = {
  openai: {
    provider: "openai-compatible",
    apiBaseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini"
  },
  deepseek: {
    provider: "openai-compatible",
    apiBaseUrl: "https://api.deepseek.com",
    model: "deepseek-chat"
  },
  ollama: {
    provider: "openai-compatible",
    apiBaseUrl: "http://localhost:11434/v1",
    model: "llama3.1"
  },
  openrouter: {
    provider: "openai-compatible",
    apiBaseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4.1-mini"
  },
  anthropic: {
    provider: "anthropic",
    apiBaseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-5"
  }
};

export async function writeInitialConfig(options: InitConfigOptions): Promise<string> {
  const configDirectory = join(options.projectRoot, ".buttonprobe");
  const path = join(configDirectory, "config.json");
  const preset = options.provider ? providerPresets[options.provider] : undefined;
  if (options.provider && !preset) {
    throw new Error(`Unknown provider preset: ${options.provider}. Use openai, deepseek, ollama, openrouter, or anthropic.`);
  }
  const config = {
    baseUrl: options.url,
    outputDir: ".buttonprobe",
    maxPages: 5,
    interactionTimeoutMs: 750,
    maxRounds: 3,
    maxFixIssues: 3,
    images: true,
    ...(preset ? { provider: preset.provider, apiBaseUrl: preset.apiBaseUrl, model: preset.model } : {}),
    ...(options.testCommand ? { testCommand: options.testCommand } : {}),
    scenarios: {
      example: {
        target: "[data-testid='replace-me']",
        actions: [{ type: "click", selector: "[data-testid='replace-me']" }],
        expect: [{ type: "text", value: "Saved" }],
        forbid: [{ type: "consoleError" }]
      }
    }
  };
  await mkdir(configDirectory, { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

export function vitePluginSnippet(): string {
  return [
    'import { createButtonProbeVitePlugin } from "buttonprobe/vite";',
    "",
    "export default defineConfig({",
    "  plugins: [createButtonProbeVitePlugin()]",
    "});"
  ].join("\n");
}
