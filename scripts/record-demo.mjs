#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const outputDir = resolve(process.argv[2] ?? ".buttonprobe/demo-recording");
await mkdir(outputDir, { recursive: true });

const instructions = `# ButtonProbe demo recording

This script prepares the release recording workspace without requiring ffmpeg.

Recommended release flow:

1. Run the viral fixture:
   npm run demo:viral

2. Run the reproducible eval:
   npm run eval:viral

3. Capture the browser and terminal:
   - show the dead buttons before repair
   - show ButtonProbe diagnosis and verified.diff
   - show Original repo pollution rate: 0

4. Convert the recording to docs/buttonprobe-demo.gif:
   ffmpeg -i recording.mov -vf "fps=12,scale=1200:-1:flags=lanczos" docs/buttonprobe-demo.gif

If ffmpeg is unavailable, keep the screenshots and this checklist in the release artifacts, then generate the GIF on a machine with ffmpeg before launch.
`;

await writeFile(resolve(outputDir, "instructions.md"), instructions);
process.stdout.write(`Wrote demo recording instructions to ${resolve(outputDir, "instructions.md")}\n`);
