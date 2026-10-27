import fs from "node:fs";
import zlib from "node:zlib";
import { config } from "./config.js";
import {
  db,
  ensureMetadataFacetIndex,
  rebuildMetadataFacetIndex,
  type MetadataStatus
} from "./db.js";

type MetadataSeedRow = {
  normalized_code: string;
  provider: string;
  provider_id: string;
  title: string;
  summary: string;
  director: string;
  actors_json: string;
  genres_json: string;
  maker: string;
  label: string;
  series: string;
  title_zh: string;
  summary_zh: string;
  director_zh: string;
  actors_zh_json: string;
  genres_zh_json: string;
  maker_zh: string;
  label_zh: string;
  series_zh: string;
  release_date: string | null;
  runtime_minutes: number | null;
  score: number | null;
  homepage: string;
  thumb_url: string;
  cover_url: string;
  preview_video_url: string;
  preview_video_hls_url: string;
  preview_images_json: string;
  source: string;
  status: MetadataStatus;
  error: string | null;
  attempts: number;
  translation_status: string;
  translation_error: string | null;
  translation_source: string;
  translation_input_hash: string;
  translated_at: string | null;
  fetched_at: string | null;
  updated_at: string;
};

type MetadataSeedPayload = {
  version: 1;
  generatedAt: string;
  rows: MetadataSeedRow[];
};

const importSeedRow = db.prepare(`
  INSERT INTO media_metadata (
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
    raw_json,
    attempts,
    translation_status,
    translation_error,
    translation_source,
    translation_input_hash,
    translated_at,
    fetched_at,
    updated_at
  )
  VALUES (
    @normalized_code,
    @provider,
    @provider_id,
    @title,
    @summary,
    @director,
    @actors_json,
    @genres_json,
    @maker,
    @label,
    @series,
    @title_zh,
    @summary_zh,
    @director_zh,
    @actors_zh_json,
    @genres_zh_json,
    @maker_zh,
    @label_zh,
    @series_zh,
    @release_date,
    @runtime_minutes,
    @score,
    @homepage,
    @thumb_url,
    @cover_url,
    @preview_video_url,
    @preview_video_hls_url,
    @preview_images_json,
    @source,
    @status,
    @error,
    NULL,
    @attempts,
    @translation_status,
    @translation_error,
    @translation_source,
    @translation_input_hash,
    @translated_at,
    @fetched_at,
    @updated_at
  )
  ON CONFLICT(normalized_code) DO UPDATE SET
    provider = excluded.provider,
    provider_id = excluded.provider_id,
    title = excluded.title,
    summary = excluded.summary,
    director = excluded.director,
    actors_json = excluded.actors_json,
    genres_json = excluded.genres_json,
    maker = excluded.maker,
    label = excluded.label,
    series = excluded.series,
    title_zh = CASE WHEN excluded.translation_status = 'ready' THEN excluded.title_zh ELSE media_metadata.title_zh END,
    summary_zh = CASE WHEN excluded.translation_status = 'ready' THEN excluded.summary_zh ELSE media_metadata.summary_zh END,
    director_zh = CASE WHEN excluded.translation_status = 'ready' THEN excluded.director_zh ELSE media_metadata.director_zh END,
    actors_zh_json = CASE WHEN excluded.translation_status = 'ready' THEN excluded.actors_zh_json ELSE media_metadata.actors_zh_json END,
    genres_zh_json = CASE WHEN excluded.translation_status = 'ready' THEN excluded.genres_zh_json ELSE media_metadata.genres_zh_json END,
    maker_zh = CASE WHEN excluded.translation_status = 'ready' THEN excluded.maker_zh ELSE media_metadata.maker_zh END,
    label_zh = CASE WHEN excluded.translation_status = 'ready' THEN excluded.label_zh ELSE media_metadata.label_zh END,
    series_zh = CASE WHEN excluded.translation_status = 'ready' THEN excluded.series_zh ELSE media_metadata.series_zh END,
    release_date = excluded.release_date,
    runtime_minutes = excluded.runtime_minutes,
    score = excluded.score,
    homepage = excluded.homepage,
    thumb_url = excluded.thumb_url,
    cover_url = excluded.cover_url,
    preview_video_url = excluded.preview_video_url,
    preview_video_hls_url = excluded.preview_video_hls_url,
    preview_images_json = excluded.preview_images_json,
    source = excluded.source,
    status = excluded.status,
    error = excluded.error,
    attempts = MAX(media_metadata.attempts, excluded.attempts),
    translation_status = CASE
      WHEN excluded.translation_status = 'ready' THEN excluded.translation_status
      ELSE media_metadata.translation_status
    END,
    translation_error = CASE
      WHEN excluded.translation_status = 'ready' THEN excluded.translation_error
      ELSE media_metadata.translation_error
    END,
    translation_source = CASE
      WHEN excluded.translation_status = 'ready' THEN excluded.translation_source
      ELSE media_metadata.translation_source
    END,
    translation_input_hash = CASE
      WHEN excluded.translation_status = 'ready' THEN excluded.translation_input_hash
      ELSE media_metadata.translation_input_hash
    END,
    translated_at = COALESCE(excluded.translated_at, media_metadata.translated_at),
    fetched_at = COALESCE(excluded.fetched_at, media_metadata.fetched_at),
    updated_at = excluded.updated_at
  WHERE
    media_metadata.status IN ('pending', 'fetching', 'failed')
    OR media_metadata.updated_at <= excluded.updated_at
`);

const countMetadataByStatus = db.prepare(`
  SELECT status, COUNT(*) AS count
  FROM media_metadata
  GROUP BY status
  ORDER BY status
`);

function readSeedPayload(): MetadataSeedPayload | null {
  if (!fs.existsSync(config.metadataSeedPath)) return null;

  const compressed = fs.readFileSync(config.metadataSeedPath);
  const text = zlib.gunzipSync(compressed).toString("utf8");
  const payload = JSON.parse(text) as Partial<MetadataSeedPayload>;

  if (payload.version !== 1 || !Array.isArray(payload.rows)) {
    throw new Error(`Unsupported metadata seed format: ${config.metadataSeedPath}`);
  }

  return payload as MetadataSeedPayload;
}

function normalizeSeedRow(row: MetadataSeedRow): MetadataSeedRow {
  return {
    normalized_code: String(row.normalized_code ?? "").trim().toUpperCase(),
    provider: String(row.provider ?? ""),
    provider_id: String(row.provider_id ?? ""),
    title: String(row.title ?? ""),
    summary: String(row.summary ?? ""),
    director: String(row.director ?? ""),
    actors_json: String(row.actors_json ?? "[]"),
    genres_json: String(row.genres_json ?? "[]"),
    maker: String(row.maker ?? ""),
    label: String(row.label ?? ""),
    series: String(row.series ?? ""),
    title_zh: String(row.title_zh ?? ""),
    summary_zh: String(row.summary_zh ?? ""),
    director_zh: String(row.director_zh ?? ""),
    actors_zh_json: String(row.actors_zh_json ?? "[]"),
    genres_zh_json: String(row.genres_zh_json ?? "[]"),
    maker_zh: String(row.maker_zh ?? ""),
    label_zh: String(row.label_zh ?? ""),
    series_zh: String(row.series_zh ?? ""),
    release_date: row.release_date ?? null,
    runtime_minutes: row.runtime_minutes ?? null,
    score: row.score ?? null,
    homepage: String(row.homepage ?? ""),
    thumb_url: String(row.thumb_url ?? ""),
    cover_url: String(row.cover_url ?? ""),
    preview_video_url: String(row.preview_video_url ?? ""),
    preview_video_hls_url: String(row.preview_video_hls_url ?? ""),
    // Official gallery arrays are intentionally retired. The product gallery
    // is generated from each local media file and stored on the external disk.
    preview_images_json: "[]",
    source: String(row.source ?? "seed"),
    status: row.status,
    error: row.error ?? null,
    attempts: Number.isFinite(row.attempts) ? row.attempts : 0,
    translation_status: String(row.translation_status ?? "pending"),
    translation_error: row.translation_error ?? null,
    translation_source: String(row.translation_source ?? ""),
    translation_input_hash: String(row.translation_input_hash ?? ""),
    translated_at: row.translated_at ?? null,
    fetched_at: row.fetched_at ?? null,
    updated_at: String(row.updated_at ?? new Date().toISOString())
  };
}

export function importMetadataSeedIfAvailable(): void {
  if (!fs.existsSync(config.metadataSeedPath)) {
    ensureMetadataFacetIndex();
    return;
  }
  const seedStat = fs.statSync(config.metadataSeedPath);
  const seedSignature = `${seedStat.size}:${Math.round(seedStat.mtimeMs)}`;
  const savedSeed = db
    .prepare("SELECT source_signature AS sourceSignature FROM app_cache_state WHERE cache_key = 'metadata-seed-v1'")
    .get() as { sourceSignature: string } | undefined;
  if (savedSeed?.sourceSignature === seedSignature) {
    ensureMetadataFacetIndex();
    console.log(`Metadata seed unchanged; skipped import from ${config.metadataSeedPath}`);
    return;
  }

  const payload = readSeedPayload();
  if (!payload) {
    ensureMetadataFacetIndex();
    return;
  }

  let imported = 0;
  const importRows = db.transaction((rows: MetadataSeedRow[]) => {
    for (const row of rows) {
      const normalizedRow = normalizeSeedRow(row);
      if (!normalizedRow.normalized_code) continue;
      const result = importSeedRow.run(normalizedRow);
      imported += result.changes;
    }
  });

  importRows(payload.rows);

  if (imported > 0) {
    rebuildMetadataFacetIndex();
  } else {
    ensureMetadataFacetIndex();
  }

  db.prepare(
    `
    INSERT INTO app_cache_state (cache_key, source_signature, updated_at)
    VALUES ('metadata-seed-v1', ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      source_signature = excluded.source_signature,
      updated_at = excluded.updated_at
  `
  ).run(seedSignature, new Date().toISOString());

  const statusCounts = countMetadataByStatus.all() as Array<{ status: string; count: number }>;
  const statusText = statusCounts
    .map((row) => `${row.status}:${row.count}`)
    .join(", ");
  console.log(
    `Metadata seed loaded: ${payload.rows.length} rows, ${imported} changed, current statuses ${statusText} from ${config.metadataSeedPath}`
  );
}
