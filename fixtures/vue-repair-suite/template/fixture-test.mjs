import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const vite = join(root, "node_modules", "vite", "bin", "vite.js");
const result = spawnSync(process.execPath, [vite, "build"], { cwd: root, encoding: "utf8", env: process.env, timeout: 120_000 });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) process.exit(result.status ?? 1);
