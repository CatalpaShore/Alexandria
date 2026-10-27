import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { db } from "./db.js";

const supportedCoverExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);

function isSeedCoverFile(entry: fs.Dirent): boolean {
  if (!entry.isFile()) return false;
  return supportedCoverExtensions.has(path.extname(entry.name).toLowerCase());
}

function isSameDirectory(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

export function importCoverSeedIfAvailable(): void {
  if (!fs.existsSync(config.coverSeedDir)) return;
  if (isSameDirectory(config.coverSeedDir, config.coverCacheDir)) return;

  const directoryStat = fs.statSync(config.coverSeedDir);
  const seedSignature = `${Math.round(directoryStat.mtimeMs)}`;
  const savedSeed = db
    .prepare("SELECT source_signature AS sourceSignature FROM app_cache_state WHERE cache_key = 'cover-seed-v1'")
    .get() as { sourceSignature: string } | undefined;
  if (savedSeed?.sourceSignature === seedSignature) return;

  const seedEntries = fs.readdirSync(config.coverSeedDir, { withFileTypes: true }).filter(isSeedCoverFile);
  if (seedEntries.length === 0) return;

  fs.mkdirSync(config.coverCacheDir, { recursive: true });

  let copied = 0;
  let skipped = 0;
  let bytes = 0;

  for (const entry of seedEntries) {
    const sourcePath = path.join(config.coverSeedDir, entry.name);
    const targetPath = path.join(config.coverCacheDir, entry.name);

    const sourceStat = fs.statSync(sourcePath);
    const targetExists = fs.existsSync(targetPath);

    if (targetExists) {
      const targetStat = fs.statSync(targetPath);
      if (targetStat.isFile() && targetStat.size === sourceStat.size && targetStat.size > 0) {
        skipped += 1;
        continue;
      }
    }

    fs.copyFileSync(sourcePath, targetPath);
    copied += 1;
    bytes += sourceStat.size;
  }

  if (copied > 0 || skipped > 0) {
    console.log(
      `Cover seed loaded: ${copied} copied, ${skipped} already present, ${(bytes / 1024 / 1024).toFixed(1)} MiB from ${config.coverSeedDir}`
    );
  }
  db.prepare(
    `
    INSERT INTO app_cache_state (cache_key, source_signature, updated_at)
    VALUES ('cover-seed-v1', ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      source_signature = excluded.source_signature,
      updated_at = excluded.updated_at
  `
  ).run(seedSignature, new Date().toISOString());
}
