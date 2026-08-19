import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { join, resolve } from "node:path";
import { loadButtonProbeConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import { runPatchVerification } from "./patch-proof.js";
import { runButtonProbe } from "./workflow.js";
import type { BrowserName } from "./types.js";

export const MCP_SERVER_NAME = "buttonprobe";

function assertZeroModelCalls(modelCalls: number, tool: string): void {
  if (modelCalls !== 0) {
    throw new Error(`${tool} must never call a model; recorded ${modelCalls} model calls`);
  }
}

const browserSchema = z.enum(["chromium", "firefox", "webkit"]);

export function createButtonProbeMcpServer(version: string): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version });

  server.registerTool(
    "buttonprobe_scan",
    {
      description:
        "Click every control in a localhost web app and report dead buttons (inert, crashed, or ambiguous). Deterministic; never calls a model and never modifies the repository.",
      inputSchema: {
        url: z.string().describe("localhost URL to scan, for example http://localhost:5173"),
        projectRoot: z.string().optional().describe("source repository root; defaults to the current directory"),
        timeout: z.number().int().positive().optional().describe("post-click observation window in milliseconds"),
        unsafe: z.boolean().optional().describe("allow controls with destructive labels")
      },
      outputSchema: {
        scannedControls: z.number(),
        brokenCount: z.number(),
        brokenControls: z.array(
          z.object({
            id: z.string(),
            selector: z.string(),
            label: z.string(),
            verdict: z.string(),
            pageUrl: z.string()
          })
        ),
        reportPath: z.string(),
        modelCalls: z.number()
      }
    },
    async (args) => {
      const projectRoot = resolve(args.projectRoot ?? process.cwd());
      const outputDir = join(projectRoot, ".buttonprobe", "mcp-scan");
      const result = await runButtonProbe({
        baseUrl: args.url,
        outputDir,
        projectRoot,
        maxPages: 1,
        interactionTimeoutMs: args.timeout ?? 500,
        unsafe: args.unsafe ?? false,
        ai: false,
        fix: false,
        maxRounds: 1,
        images: false
      });
      assertZeroModelCalls(result.usageSummary.modelCalls, "buttonprobe_scan");
      const controls = result.scan.pages.flatMap((page) => page.controls);
      const brokenControls = controls
        .filter((control) => control.verdict === "INERT" || control.verdict === "CRASHED" || control.verdict === "AMBIGUOUS")
        .map((control) => ({
          id: control.id,
          selector: control.selector,
          label: control.text || control.ariaLabel || control.selector,
          verdict: control.verdict,
          pageUrl: control.pageUrl
        }));
      const structuredContent = {
        scannedControls: controls.length,
        brokenCount: brokenControls.length,
        brokenControls,
        reportPath: result.reportPath,
        modelCalls: 0
      };
      return {
        content: [
          {
            type: "text",
            text:
              `Scanned ${structuredContent.scannedControls} control(s); found ${structuredContent.brokenCount} broken control(s). ` +
              `Report: ${result.reportPath}`
          }
        ],
        structuredContent
      };
    }
  );

  server.registerTool(
    "buttonprobe_verify",
    {
      description:
        "Verify an existing unified diff (from Claude, Codex, Cursor, or a human) in an isolated Git worktree: applies the patch, runs the test command, starts the patched dev server, and re-checks the target control in a real browser. Zero model calls. The current checkout is never modified unless apply=true and the patch reaches ui-verified.",
      inputSchema: {
        url: z.string().describe("localhost URL of the currently running (unpatched) app"),
        patchPath: z.string().optional().describe("path to a unified diff file"),
        patchUrl: z.string().optional().describe("https or localhost URL of a unified diff, for example a GitHub pull request .diff URL"),
        testCommand: z.string().describe("test command used as the proof gate"),
        devCommand: z.string().optional().describe("patched worktree dev server command; use {port} for the allocated port"),
        projectRoot: z.string().optional().describe("source repository root; defaults to the current directory"),
        outputDir: z.string().optional().describe("proof output directory; defaults to <projectRoot>/.buttonprobe/mcp-verify"),
        target: z.string().optional().describe("target control selector or ButtonProbe control id"),
        browsers: z.array(browserSchema).optional().describe("browsers for UI verification; defaults to chromium"),
        apply: z.boolean().optional().describe("apply the diff to the checkout only after ui-verified; defaults to false"),
        timeout: z.number().int().positive().optional().describe("post-click observation window in milliseconds")
      },
      outputSchema: {
        status: z.string(),
        reason: z.string(),
        proofPath: z.string(),
        reportPath: z.string(),
        verifiedDiffPath: z.string().optional(),
        originalCheckoutModified: z.boolean(),
        modelCalls: z.number()
      }
    },
    async (args) => {
      const projectRoot = resolve(args.projectRoot ?? process.cwd());
      const config = await loadButtonProbeConfig(projectRoot);
      const outputDir = resolve(args.outputDir ?? join(projectRoot, ".buttonprobe", "mcp-verify"));
      const devCommand = args.devCommand ?? config.devCommand;
      const browsers = (args.browsers ?? ["chromium"]) as BrowserName[];
      const result = await runPatchVerification({
        baseUrl: args.url,
        ...(args.patchPath ? { patchPath: resolve(args.patchPath) } : {}),
        ...(args.patchUrl ? { patchUrl: args.patchUrl } : {}),
        projectRoot,
        outputDir,
        testCommand: args.testCommand,
        ...(devCommand ? { devCommand } : {}),
        ...(args.timeout ? { interactionTimeoutMs: args.timeout } : {}),
        ...(args.target ? { targetSelector: args.target } : {}),
        ...(config.scenarios ? { scenarios: config.scenarios } : {}),
        ...(args.apply ? { apply: true } : {}),
        browsers
      });
      assertZeroModelCalls(result.usageSummary.modelCalls, "buttonprobe_verify");
      const structuredContent = {
        status: result.status,
        reason: result.reason,
        proofPath: result.proofPath,
        reportPath: result.reportPath,
        ...(result.verifiedDiffPath ? { verifiedDiffPath: result.verifiedDiffPath } : {}),
        originalCheckoutModified: result.originalCheckoutModified,
        modelCalls: 0
      };
      return {
        content: [
          {
            type: "text",
            text:
              `ButtonProbe verify: ${result.status}. ${result.reason} ` +
              `Proof: ${result.proofPath} Report: ${result.reportPath}` +
              (result.verifiedDiffPath ? ` Verified diff: ${result.verifiedDiffPath}` : "")
          }
        ],
        structuredContent
      };
    }
  );

  server.registerTool(
    "buttonprobe_doctor",
    {
      description:
        "Check local readiness for ButtonProbe: Node, Playwright, Git repository, clean worktree, localhost URL, model config, and test command. Returns actionable fix suggestions. Zero model calls.",
      inputSchema: {
        url: z.string().optional().describe("localhost URL to validate"),
        projectRoot: z.string().optional().describe("source repository root; defaults to the current directory"),
        testCommand: z.string().optional().describe("test command to validate")
      },
      outputSchema: {
        ok: z.boolean(),
        checks: z.array(
          z.object({
            name: z.string(),
            ok: z.boolean(),
            message: z.string()
          })
        ),
        modelCalls: z.number()
      }
    },
    async (args) => {
      const projectRoot = resolve(args.projectRoot ?? process.cwd());
      const result = await runDoctor({
        projectRoot,
        ...(args.url ? { url: args.url } : {}),
        ...(args.testCommand ? { testCommand: args.testCommand } : {})
      });
      const structuredContent = {
        ok: result.ok,
        checks: result.checks,
        modelCalls: 0
      };
      return {
        content: [
          {
            type: "text",
            text: result.checks.map((check) => `${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.message}`).join("\n")
          }
        ],
        structuredContent
      };
    }
  );

  return server;
}

export async function runMcpServer(version = "0.1.0"): Promise<void> {
  const server = createButtonProbeMcpServer(version);
  const transport = new StdioServerTransport();
  process.stderr.write(
    "ButtonProbe MCP server running on stdio. Tools: buttonprobe_scan, buttonprobe_verify, buttonprobe_doctor (zero model calls).\n"
  );
  await server.connect(transport);
}
