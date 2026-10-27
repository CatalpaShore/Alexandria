import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const required = {
  "client/src/motion.css": [
    "--motion-duration-fast",
    "--motion-duration-base",
    "--motion-duration-surface",
    "--motion-ease-standard",
    "@media (prefers-reduced-motion: reduce)",
    ".motion-surface-pending",
    ".motion-pressable",
    "motion-surface-forward-enter",
    "motion-selection-confirm"
  ],
  "client/src/components/motion/MotionSurface.tsx": [
    "aria-busy",
    "motion-surface-content",
    "motion-surface-pending"
  ],
  "docs/performance/motion-system.md": [
    "never animate virtualized rows",
    "390x844",
    "prefers-reduced-motion"
  ]
};

for (const [file, markers] of Object.entries(required)) {
  const contents = await readFile(resolve(root, file), "utf8");
  for (const marker of markers) {
    if (!contents.includes(marker)) throw new Error(`${file} is missing motion contract marker: ${marker}`);
  }
}

console.log("Motion system contract is valid.");
