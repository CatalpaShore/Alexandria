import path from "node:path";
import Database from "better-sqlite3";
import {
  JAV_TRANSLATION_QUALITY_VERSION,
  improveMetadataTranslation
} from "./lib/jav-translation-quality.mjs";

const cwd = process.cwd();
const databasePath = path.resolve(process.env.METADATA_DB_PATH ?? ".local/data/media-wall.sqlite");
const dryRun = process.env.TRANSLATION_QUALITY_DRY_RUN === "true";
const limit = parsePositiveInteger(process.env.TRANSLATION_QUALITY_LIMIT, 0);
const modifiedSinceDays = parseNonNegativeInteger(process.env.TRANSLATION_QUALITY_MODIFIED_SINCE_DAYS, 0);
const codes = (process.env.TRANSLATION_QUALITY_CODES ?? "")
  .split(",")
  .map((code) => code.trim().toUpperCase())
  .filter(Boolean);

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function relative(filePath) {
  return path.relative(cwd, filePath) || ".";
}

function nowIso() {
  return new Date().toISOString();
}

function parseJsonArray(value) {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function normalizeText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];

  for (const value of values.map(normalizeText)) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }

  return result;
}

function getTranslationInput(row) {
  return {
    title: normalizeText(row.title),
    summary: normalizeText(row.summary),
    director: normalizeText(row.director),
    actors: uniqueStrings(parseJsonArray(row.actors_json)),
    genres: uniqueStrings(parseJsonArray(row.genres_json)),
    maker: normalizeText(row.maker),
    label: normalizeText(row.label),
    series: normalizeText(row.series)
  };
}

function getExistingTranslation(row) {
  return {
    titleZh: normalizeText(row.title_zh),
    summaryZh: normalizeText(row.summary_zh),
    directorZh: normalizeText(row.director_zh),
    actorsZh: parseJsonArray(row.actors_zh_json),
    genresZh: parseJsonArray(row.genres_zh_json),
    makerZh: normalizeText(row.maker_zh),
    labelZh: normalizeText(row.label_zh),
    seriesZh: normalizeText(row.series_zh)
  };
}

function hasChanged(before, after) {
  return JSON.stringify(before) !== JSON.stringify(after);
}

function appendQualitySource(source) {
  const current = normalizeText(source);
  return current.includes(JAV_TRANSLATION_QUALITY_VERSION)
    ? current
    : [current || "translation", JAV_TRANSLATION_QUALITY_VERSION].join("+");
}

const db = new Database(databasePath);
const params = {};
const conditions = ["translation_status = 'ready'"];

if (codes.length > 0) {
  conditions.push(`normalized_code IN (${codes.map((_, index) => `@code${index}`).join(", ")})`);
  codes.forEach((code, index) => {
    params[`code${index}`] = code;
  });
}

if (modifiedSinceDays > 0 && codes.length === 0) {
  params.modifiedSinceMs = Date.now() - modifiedSinceDays * 24 * 60 * 60 * 1000;
  conditions.push(`EXISTS (
    SELECT 1
    FROM media_files
    WHERE media_files.normalized_code = media_metadata.normalized_code
      AND media_files.mtime_ms >= @modifiedSinceMs
  )`);
}

const rows = db
  .prepare(
    `
    SELECT
      normalized_code,
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
      translation_source
    FROM media_metadata
    WHERE ${conditions.join(" AND ")}
    ORDER BY normalized_code ASC
    ${limit > 0 ? "LIMIT @limit" : ""}
  `
  )
  .all(limit > 0 ? { ...params, limit } : params);

const update = db.prepare(`
  UPDATE media_metadata
  SET title_zh = @titleZh,
      summary_zh = @summaryZh,
      director_zh = @directorZh,
      actors_zh_json = @actorsZhJson,
      genres_zh_json = @genresZhJson,
      maker_zh = @makerZh,
      label_zh = @labelZh,
      series_zh = @seriesZh,
      translation_source = @translationSource,
      translated_at = @translatedAt
  WHERE normalized_code = @normalizedCode
`);
const clearTopicStats = db.prepare("DELETE FROM app_cache_state WHERE cache_key LIKE 'topic-stats:%'");
const updateTopicLocalizationRevision = db.prepare(`
  INSERT INTO app_cache_state (cache_key, source_signature, updated_at)
  VALUES ('topic-localizations', @revision, @revision)
  ON CONFLICT(cache_key) DO UPDATE SET
    source_signature = excluded.source_signature,
    updated_at = excluded.updated_at
`);

let changed = 0;
const examples = [];

const runUpdates = db.transaction((changes) => {
  for (const change of changes) {
    update.run(change);
  }
  const revision = nowIso();
  clearTopicStats.run();
  updateTopicLocalizationRevision.run({ revision });
});
const changes = [];

for (const row of rows) {
  const input = getTranslationInput(row);
  const before = getExistingTranslation(row);
  const after = improveMetadataTranslation(input, before);

  if (!hasChanged(before, after)) continue;
  changed += 1;
  if (examples.length < 10) {
    examples.push({
      code: row.normalized_code,
      changedFields: Object.keys(after).filter(
        (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field])
      ),
      before,
      after
    });
  }

  changes.push({
    normalizedCode: row.normalized_code,
    titleZh: after.titleZh,
    summaryZh: after.summaryZh,
    directorZh: after.directorZh,
    actorsZhJson: JSON.stringify(after.actorsZh),
    genresZhJson: JSON.stringify(after.genresZh),
    makerZh: after.makerZh,
    labelZh: after.labelZh,
    seriesZh: after.seriesZh,
    translationSource: appendQualitySource(row.translation_source),
    translatedAt: nowIso()
  });
}

if (!dryRun && changes.length > 0) {
  runUpdates(changes);
}

db.close();

console.log(
  JSON.stringify(
    {
      database: relative(databasePath),
      qualityVersion: JAV_TRANSLATION_QUALITY_VERSION,
      dryRun,
      scanned: rows.length,
      changed,
      examples
    },
    null,
    2
  )
);
