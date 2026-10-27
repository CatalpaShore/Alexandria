import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const cwd = process.cwd();
const databasePath = path.resolve(process.env.METADATA_DB_PATH ?? ".local/data/media-wall.sqlite");
const outputPath = path.resolve(process.env.METADATA_SEED_OUTPUT ?? "seed/metadata-seed.json.gz");

const sql = `
  SELECT
    normalized_code,
    provider,
    provider_id,
    title,
    summary,
    director,
    actors_json,
    genres_json,
    maker,
    label,
    series,
    title_zh,
    summary_zh,
    director_zh,
    actors_zh_json,
    genres_zh_json,
    maker_zh,
    label_zh,
    series_zh,
    release_date,
    runtime_minutes,
    score,
    homepage,
    thumb_url,
    cover_url,
    preview_video_url,
    preview_video_hls_url,
    preview_images_json,
    source,
    status,
    error,
    attempts,
    translation_status,
    translation_error,
    translation_source,
    translation_input_hash,
    translated_at,
    fetched_at,
    updated_at
  FROM media_metadata
  WHERE status IN ('ready', 'not_found')
  ORDER BY normalized_code
`;

const result = spawnSync("sqlite3", ["-readonly", "-json", databasePath, sql], {
  cwd,
  encoding: "utf8",
  maxBuffer: 128 * 1024 * 1024
});

if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}

const rows = JSON.parse(result.stdout || "[]");
const payload = {
  version: 1,
  generatedAt: new Date().toISOString(),
  sourceDatabase: path.relative(cwd, databasePath),
  rows
};
const json = `${JSON.stringify(payload)}\n`;
const compressed = zlib.gzipSync(json, { level: 9 });

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, compressed);

console.log(
  `Wrote ${path.relative(cwd, outputPath)} with ${rows.length} rows (${(compressed.length / 1024 / 1024).toFixed(1)} MiB compressed)`
);
