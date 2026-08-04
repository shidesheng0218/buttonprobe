import { access, constants } from "node:fs/promises";
import { inspectGitWorkspace } from "./git-workspace.js";

export interface DoctorOptions {
  projectRoot: string;
  url?: string;
  testCommand?: string;
  env?: NodeJS.ProcessEnv;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

function isLocalhost(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const env = options.env ?? process.env;
  const workspace = await inspectGitWorkspace(options.projectRoot);
  const playwrightAvailable = await access("node_modules/playwright", constants.R_OK)
    .then(() => true)
    .catch(() => false);
  const checks: DoctorCheck[] = [
    {
      name: "Node.js",
      ok: Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) >= 20,
      message: `Node ${process.versions.node}`
    },
    {
      name: "Playwright",
      ok: playwrightAvailable,
      message: playwrightAvailable ? "Playwright package is installed" : "Run: npx playwright install chromium"
    },
    {
      name: "Git repository",
      ok: workspace.isRepository,
      message: workspace.isRepository ? "Inside a Git worktree" : "Run ButtonProbe from a Git repository"
    },
    {
      name: "Clean worktree",
      ok: workspace.isRepository && workspace.clean,
      message: workspace.clean ? "Git worktree is clean" : "Dirty worktree will use patch-only mode"
    },
    {
      name: "Localhost URL",
      ok: isLocalhost(options.url),
      message: isLocalhost(options.url) ? `Using ${options.url}` : "Use a localhost URL, for example http://localhost:5173"
    },
    {
      name: "Model config",
      ok: Boolean(
        env.BUTTONPROBE_BASE_URL &&
        (env.BUTTONPROBE_MODEL || env.BUTTONPROBE_ANALYSIS_MODEL || env.BUTTONPROBE_REPAIR_MODEL)
      ),
      message: env.BUTTONPROBE_BASE_URL && (env.BUTTONPROBE_MODEL || env.BUTTONPROBE_ANALYSIS_MODEL || env.BUTTONPROBE_REPAIR_MODEL)
        ? `Configured model ${env.BUTTONPROBE_MODEL ?? env.BUTTONPROBE_REPAIR_MODEL ?? env.BUTTONPROBE_ANALYSIS_MODEL}`
        : [
            "Missing BUTTONPROBE_BASE_URL or BUTTONPROBE_MODEL.",
            "OpenAI: BUTTONPROBE_BASE_URL=https://api.openai.com/v1",
            "DeepSeek: BUTTONPROBE_BASE_URL=https://api.deepseek.com",
            "Ollama: BUTTONPROBE_BASE_URL=http://localhost:11434/v1",
            "Claude: BUTTONPROBE_PROVIDER=anthropic BUTTONPROBE_BASE_URL=https://api.anthropic.com ANTHROPIC_API_KEY=..."
          ].join(" ")
    },
    {
      name: "Test command",
      ok: Boolean(options.testCommand),
      message: options.testCommand ? `Using ${options.testCommand}` : "Pass --test-command \"npm test\" for repair mode"
    }
  ];
  return { ok: checks.every((check) => check.ok), checks };
}
