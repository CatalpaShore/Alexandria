import fs from "node:fs";
import path from "node:path";

const cwd = process.cwd();
const sourceDir = path.resolve(process.env.COVER_CACHE_SOURCE_DIR ?? ".local/data/covers");
const targetDir = path.resolve(process.env.COVER_SEED_DIR ?? "seed/covers");
const keepFileName = ".gitkeep";
const coverExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);

function isCoverFile(fileName) {
  return coverExtensions.has(path.extname(fileName).toLowerCase());
}

function relative(filePath) {
  return path.relative(cwd, filePath) || ".";
}

fs.mkdirSync(targetDir, { recursive: true });
const keepPath = path.join(targetDir, keepFileName);
if (!fs.existsSync(keepPath)) {
  fs.writeFileSync(keepPath, "");
}

if (!fs.existsSync(sourceDir)) {
  console.log(`Cover seed sync skipped: ${relative(sourceDir)} does not exist`);
  process.exit(0);
}

const sourceEntries = fs
  .readdirSync(sourceDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && isCoverFile(entry.name));
const sourceNames = new Set(sourceEntries.map((entry) => entry.name));

let copied = 0;
let unchanged = 0;
let removed = 0;
let bytes = 0;

for (const entry of sourceEntries) {
  const sourcePath = path.join(sourceDir, entry.name);
  const targetPath = path.join(targetDir, entry.name);
  const sourceStat = fs.statSync(sourcePath);
  const targetStat = fs.existsSync(targetPath) ? fs.statSync(targetPath) : null;

  if (targetStat?.isFile() && targetStat.size === sourceStat.size && targetStat.size > 0) {
    unchanged += 1;
    continue;
  }

  fs.copyFileSync(sourcePath, targetPath);
  copied += 1;
  bytes += sourceStat.size;
}

for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
  if (!entry.isFile() || entry.name === keepFileName) continue;
  if (sourceNames.has(entry.name)) continue;

  fs.unlinkSync(path.join(targetDir, entry.name));
  removed += 1;
}

console.log(
  `Cover seed synced: ${copied} copied, ${unchanged} unchanged, ${removed} removed, ${(bytes / 1024 / 1024).toFixed(1)} MiB into ${relative(targetDir)}`
);
