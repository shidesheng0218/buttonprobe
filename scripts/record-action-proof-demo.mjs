#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const output = resolve(process.argv[2] ?? "docs/buttonprobe-action-proof.gif");
const benchmarkPath = resolve("benchmarks/latest.json");
const benchmark = JSON.parse(await readFile(benchmarkPath, "utf8"));
const tempDir = await mkdtemp(join(tmpdir(), "buttonprobe-proof-gif-"));

function screen(title, eyebrow, body, footer) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box} body{margin:0;width:960px;height:540px;background:#111827;color:#f8fafc;font-family:ui-sans-serif,system-ui,sans-serif;padding:44px}
    .bar{display:flex;justify-content:space-between;align-items:center;color:#cbd5e1;font:600 15px ui-monospace,monospace}.dot{color:#34d399}.card{margin-top:28px;border:1px solid #334155;background:#172033;padding:30px}.eyebrow{color:#38bdf8;font:700 14px ui-monospace,monospace;text-transform:uppercase}.title{font-size:38px;font-weight:750;margin:12px 0 20px;letter-spacing:0}.body{font:19px/1.65 ui-monospace,monospace;white-space:pre-wrap;color:#e2e8f0}.good{color:#34d399}.muted{color:#94a3b8}.footer{position:absolute;bottom:42px;color:#94a3b8;font:15px ui-monospace,monospace}
  </style></head><body><div class="bar"><span>BUTTONPROBE / PR PROOF</span><span class="dot">LOCAL-FIRST</span></div><main class="card"><div class="eyebrow">${eyebrow}</div><div class="title">${title}</div><div class="body">${body}</div></main><div class="footer">${footer}</div></body></html>`;
}

const frames = [
  screen("An AI proposes a UI diff", "pull request", `patch-url: github.event.pull_request.diff_url\n\nButtonProbe receives the diff.\nIt does not apply it to your checkout.`, "Your AI writes the patch."),
  screen("Verification runs in a worktree", "0 model calls", `git apply --check    <span class="good">passed</span>\ntest command         <span class="good">passed</span>\nbrowser interaction  <span class="good">passed</span>\nregression guard     <span class="good">passed</span>`, "Tests and browser evidence decide."),
  screen("ui-verified", "proof artifact", `<span class="good">verified.diff</span>\n<span class="good">proof.json</span>\n<span class="good">report.html</span>\n\noriginal checkout modified: <span class="good">false</span>\nviral eval: ${benchmark.viral.passed}/${benchmark.viral.total} | React: ${benchmark.react.uiVerified}/${benchmark.react.total}`, "ButtonProbe proves before merge.")
];

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
  let number = 1;
  for (const html of frames) {
    await page.setContent(html);
    for (let repeat = 0; repeat < 2; repeat += 1) {
      await page.screenshot({ path: join(tempDir, `frame-${String(number).padStart(2, "0")}.png`) });
      number += 1;
    }
  }
} finally {
  await browser.close();
}

try {
  execFileSync("ffmpeg", [
    "-y", "-framerate", "1", "-i", join(tempDir, "frame-%02d.png"),
    "-vf", "fps=1,scale=960:-1:flags=lanczos", "-loop", "0", output
  ], { stdio: "ignore" });
  process.stdout.write(`Wrote ${output}\n`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
