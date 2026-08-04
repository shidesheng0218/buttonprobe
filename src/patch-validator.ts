import { spawn } from "node:child_process";

const allowedRoots = ["src/", "app/", "pages/", "components/", "test/", "tests/", "__tests__/"];
const protectedPaths = [
  /^\.env(?:\.|$)/,
  /(?:^|\/)(?:package-lock|pnpm-lock|yarn\.lock|bun\.lockb)$/,
  /(?:^|\/)\.github\//,
  /(?:^|\/)\.git\//,
  /(?:^|\/)(?:migrations?|prisma)\//,
  /(?:^|\/)(?:release|deploy)(?:\.|\/)/i,
  /^package\.json$/
];

function runGitApplyCheck(root: string, patch: string): Promise<{ ok: boolean; error: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", ["apply", "--check", "-"], { cwd: root, stdio: ["pipe", "ignore", "pipe"] });
    let error = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      error += chunk;
    });
    child.on("close", (code) => resolve({ ok: code === 0, error: error.trim() }));
    child.on("error", (spawnError) => resolve({ ok: false, error: spawnError.message }));
    child.stdin.end(patch);
  });
}

function extractFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split("\n")) {
    if (!line.startsWith("+++ ")) continue;
    const raw = line.slice(4).trim().split("\t")[0] ?? "";
    if (raw === "/dev/null") continue;
    files.add(raw.replace(/^b\//, ""));
  }
  return [...files];
}

export async function validatePatch(root: string, patch: string): Promise<import("./types.js").PatchValidation> {
  const files = extractFiles(patch);
  if (files.length === 0) return { ok: false, files, reason: "Patch does not modify any files" };
  if (files.length > 3) return { ok: false, files, reason: "Patch modifies more than 3 files" };

  for (const file of files) {
    if (protectedPaths.some((pattern) => pattern.test(file))) {
      return { ok: false, files, reason: `Patch touches protected path: ${file}` };
    }
    if (!allowedRoots.some((rootPath) => file.startsWith(rootPath))) {
      return { ok: false, files, reason: `Patch path is outside allowed source roots: ${file}` };
    }
  }

  const changedLines = patch
    .split("\n")
    .filter(
      (line) =>
        (line.startsWith("+") && !line.startsWith("+++")) ||
        (line.startsWith("-") && !line.startsWith("---"))
    ).length;
  if (changedLines > 150) {
    return { ok: false, files, changedLines, reason: "Patch changes more than 150 lines" };
  }

  const gitCheck = await runGitApplyCheck(root, patch);
  if (!gitCheck.ok) {
    return { ok: false, files, changedLines, reason: `git apply --check failed: ${gitCheck.error}` };
  }
  return { ok: true, files, changedLines };
}
