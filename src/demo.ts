import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runButtonProbe } from "./workflow.js";

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a localhost port"));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForHttp(url: string, timeoutMs = 30_000): Promise<void> {
  const startedAt = Date.now();
  let lastError = "not ready";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = (error as Error).message;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error(`Timed out waiting for demo server: ${lastError}`);
}

async function runNpmInstall(cwd: string): Promise<void> {
  await new Promise<void>((resolveInstall, reject) => {
    const child = spawn("npm", ["install", "--no-audit", "--no-fund", "--no-progress"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveInstall();
      else reject(new Error(`Demo dependency install failed: ${output.slice(-4000)}`));
    });
  });
}

function stopProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolveStop) => {
    if (child.exitCode !== null || child.killed) {
      resolveStop();
      return;
    }
    child.once("close", () => resolveStop());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 1000).unref();
  });
}

export interface DemoResult {
  issues: Array<{ id: string; label: string; verdict: string }>;
  reportPath: string;
}

export async function runDemo(): Promise<DemoResult> {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const fixtureRoot = join(packageRoot, "fixtures", "viral-demo-react");
  const parent = await mkdtemp(join(tmpdir(), "buttonprobe-demo-"));
  const root = join(parent, "viral-demo-react");
  let server: ChildProcess | undefined;
  try {
    await cp(fixtureRoot, root, {
      recursive: true,
      filter: (source) => !source.split(/[\\/]/).includes("node_modules")
    });
    await runNpmInstall(root);
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    server = spawn("npm", ["run", "dev", "--", "--port", String(port)], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"]
    });
    await waitForHttp(baseUrl);
    const outputDir = resolve(process.cwd(), ".buttonprobe", "demo");
    const result = await runButtonProbe({
      baseUrl,
      outputDir,
      projectRoot: root,
      maxPages: 1,
      interactionTimeoutMs: 200,
      unsafe: false,
      ai: false,
      fix: false,
      maxRounds: 1,
      images: false
    });
    const issues = result.scan.pages
      .flatMap((page) => page.controls)
      .filter((control) => control.verdict === "INERT" || control.verdict === "CRASHED")
      .map((control) => ({
        id: control.id,
        label: control.text || control.ariaLabel || control.selector,
        verdict: control.verdict
      }));
    return { issues, reportPath: result.reportPath };
  } finally {
    if (server) await stopProcess(server);
    await rm(parent, { recursive: true, force: true });
  }
}
