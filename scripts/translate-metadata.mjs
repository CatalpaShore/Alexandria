import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  getKnownTermTranslation,
  improveMetadataTranslation,
  improveTranslatedText
} from "./lib/jav-translation-quality.mjs";

const cwd = process.cwd();
const databasePath = path.resolve(process.env.METADATA_DB_PATH ?? ".local/data/media-wall.sqlite");
const provider = (process.env.TRANSLATE_PROVIDER ?? "google").trim().toLowerCase();
const mode = (process.env.TRANSLATE_MODE ?? "full").trim().toLowerCase();
const englishTitleRepairMode = mode === "english-title-repair";
const targetLang = process.env.TRANSLATE_TARGET_LANG ?? "zh-CN";
const sourceLang = process.env.TRANSLATE_SOURCE_LANG ?? "ja";
const batchLimit = parsePositiveInteger(process.env.TRANSLATE_BATCH_LIMIT, 50);
const rowWindowSize = parsePositiveInteger(process.env.TRANSLATE_ROW_WINDOW_SIZE, 50);
const progressInterval = parsePositiveInteger(process.env.TRANSLATE_PROGRESS_INTERVAL, 5);
const prefetchEnabled = process.env.TRANSLATE_PREFETCH !== "false";
const prefetchTextLimit = parsePositiveInteger(process.env.TRANSLATE_PREFETCH_TEXT_LIMIT, 16);
const prefetchCharLimit = parsePositiveInteger(process.env.TRANSLATE_PREFETCH_CHAR_LIMIT, 1800);
const prefetchProgressInterval = parsePositiveInteger(process.env.TRANSLATE_PREFETCH_PROGRESS_INTERVAL, 25);
const singleTextCharLimit = parsePositiveInteger(process.env.TRANSLATE_SINGLE_TEXT_CHAR_LIMIT, 900);
const delayMs = parsePositiveInteger(process.env.TRANSLATE_DELAY_MS, 350);
const timeoutMs = parsePositiveInteger(process.env.TRANSLATE_TIMEOUT_MS, 20000);
const force = process.env.TRANSLATE_FORCE === "true";
const dryRun = process.env.TRANSLATE_DRY_RUN === "true";
const englishTitleWordThreshold = parsePositiveInteger(process.env.TRANSLATE_ENGLISH_TITLE_WORDS, 3);
const modifiedSinceDays = parseNonNegativeInteger(process.env.TRANSLATE_MODIFIED_SINCE_DAYS, 0);
const libreTranslateUrl = (process.env.LIBRETRANSLATE_URL ?? "http://localhost:5000").trim().replace(/\/+$/, "");
const libreTranslateApiKey = (process.env.LIBRETRANSLATE_API_KEY ?? "").trim();
const codes = (process.env.TRANSLATE_CODES ?? "")
  .split(",")
  .map((code) => code.trim().toUpperCase())
  .filter(Boolean);
const userAgent =
  process.env.TRANSLATE_USER_AGENT ??
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function addModifiedSinceCondition(conditions, params) {
  if (modifiedSinceDays <= 0 || codes.length > 0) return;
  params.modifiedSinceMs = Date.now() - modifiedSinceDays * 24 * 60 * 60 * 1000;
  conditions.push(`EXISTS (
    SELECT 1
    FROM media_files
    WHERE media_files.normalized_code = media_metadata.normalized_code
      AND media_files.mtime_ms >= @modifiedSinceMs
  )`);
}

function relative(filePath) {
  return path.relative(cwd, filePath) || ".";
}

function nowIso() {
  return new Date().toISOString();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

const cjkPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const hanPattern = /\p{Script=Han}/u;
const englishWordPattern = /[A-Za-z][A-Za-z]+/g;
const englishFragmentPattern =
  /[A-Za-z][A-Za-z'’.-]*(?:[\s,.;:!?'"“”‘’()[\]/-]+[A-Za-z][A-Za-z'’.-]*){1,}/g;
const compactIdentifierWords = new Set([
  "ACT",
  "AV",
  "BD",
  "BEST",
  "DVD",
  "DVDPG",
  "EDITION",
  "EXCLUSIVE",
  "FC",
  "FC2",
  "FHD",
  "HD",
  "MGS",
  "PPV",
  "PREMIUM",
  "SD",
  "SPECIAL",
  "SP",
  "UHD",
  "VR"
]);

function getEnglishNarrativeWords(value) {
  return [...normalizeText(value).matchAll(englishWordPattern)]
    .map((match) => match[0])
    .filter((word) => {
      if (word.length < 2) return false;
      const upper = word.toUpperCase();
      return !(word === upper && word.length <= 5 && compactIdentifierWords.has(upper));
    });
}

function looksLikeEnglishNarrative(value) {
  const normalized = normalizeText(value);
  if (!normalized) return false;

  const words = getEnglishNarrativeWords(normalized);
  if (!hasEnglishPhrase(normalized, englishTitleWordThreshold)) return false;

  const letterCount = words.join("").length;
  const cjkCount = [...normalized].filter((char) => cjkPattern.test(char)).length;
  return letterCount >= 10 && letterCount >= cjkCount;
}

function hasEnglishPhrase(value, minWords = englishTitleWordThreshold) {
  const words = getEnglishNarrativeWords(value);
  return words.length >= minWords && words.join("").length >= 10;
}

function englishPhraseScore(value) {
  return getEnglishNarrativeWords(value).length;
}

function hasChineseText(value) {
  return hanPattern.test(normalizeText(value));
}

function getRemoteSourceLang(text, context) {
  if (context === "narrative" && (looksLikeEnglishNarrative(text) || hasEnglishPhrase(text, 2))) {
    return provider === "libretranslate" ? "en" : "auto";
  }

  return sourceLang;
}

function prepareRemoteText(text, context) {
  const normalized = normalizeText(text);
  if (context !== "narrative" || (!looksLikeEnglishNarrative(normalized) && !hasEnglishPhrase(normalized, 2))) {
    return normalized;
  }

  return normalized.replace(/[A-Za-z][A-Za-z'’.-]*/g, (word) => {
    const upper = word.toUpperCase();
    if (word.length <= 1 || compactIdentifierWords.has(upper) || /^[A-Z0-9]{2,}$/.test(word)) {
      return word;
    }
    return word.toLowerCase();
  });
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

function hashInput(input) {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function shouldSkipTranslation(text, context = "generic") {
  if (!text) return true;
  if (context === "narrative" && looksLikeEnglishNarrative(text)) return false;
  if (/^[A-Z0-9\s._:/+()[\],&'"-]+$/i.test(text)) return true;
  return false;
}

function cleanTranslation(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .replace(/\s+([，。！？、：；])/g, "$1")
    .trim();
}

function splitHard(value, maxLength) {
  const result = [];
  for (let index = 0; index < value.length; index += maxLength) {
    result.push(value.slice(index, index + maxLength));
  }
  return result;
}

function splitTextForTranslation(text) {
  const normalized = normalizeText(text);
  if (!normalized || normalized.length <= singleTextCharLimit) return normalized ? [normalized] : [];

  const result = [];
  let current = "";
  const units = normalized
    .split(/(?<=[。！？!?；;．.、，,])\s*/u)
    .map((unit) => unit.trim())
    .filter(Boolean);

  for (const unit of units.length > 0 ? units : [normalized]) {
    if (unit.length > singleTextCharLimit) {
      if (current) {
        result.push(current);
        current = "";
      }
      result.push(...splitHard(unit, singleTextCharLimit));
      continue;
    }

    const next = current ? `${current}${unit}` : unit;
    if (next.length > singleTextCharLimit) {
      if (current) result.push(current);
      current = unit;
    } else {
      current = next;
    }
  }

  if (current) result.push(current);
  return result;
}

async function translateWithGoogle(text, remoteSourceLang = sourceLang) {
  const query = new URLSearchParams({
    client: "gtx",
    sl: remoteSourceLang,
    tl: targetLang,
    dt: "t",
    q: text
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`https://translate.googleapis.com/translate_a/single?${query.toString()}`, {
      headers: {
        "User-Agent": userAgent,
        Accept: "application/json,text/plain,*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,ja;q=0.7"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`google_${response.status}`);
    }

    const payload = await response.json();
    const translated = Array.isArray(payload?.[0])
      ? payload[0].map((part) => (Array.isArray(part) ? part[0] : "")).join("")
      : "";

    if (!translated) throw new Error("empty_translation");
    return cleanTranslation(translated);
  } finally {
    clearTimeout(timeout);
  }
}

async function translateWithLibreTranslate(text, remoteSourceLang = sourceLang) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const target = targetLang.toLowerCase().startsWith("zh") ? "zh" : targetLang;

  try {
    const response = await fetch(`${libreTranslateUrl}/translate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        q: text,
        source: remoteSourceLang,
        target,
        format: "text",
        ...(libreTranslateApiKey ? { api_key: libreTranslateApiKey } : {})
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`libretranslate_${response.status}`);
    }

    const payload = await response.json();
    const translated = payload?.translatedText;
    if (!translated) throw new Error("empty_translation");
    return cleanTranslation(translated);
  } finally {
    clearTimeout(timeout);
  }
}

async function translateRemote(text, remoteSourceLang = sourceLang) {
  if (provider === "google") {
    return translateWithGoogle(text, remoteSourceLang);
  }

  if (provider === "libretranslate") {
    return translateWithLibreTranslate(text, remoteSourceLang);
  }

  throw new Error(`Unsupported TRANSLATE_PROVIDER=${provider}`);
}

function buildBatchMarker(index) {
  return `[[AMW_TRANSLATION_BOUNDARY_${index}]]`;
}

function parseBatchTranslation(translated, count) {
  const pattern = /\[\[\s*AMW_TRANSLATION_BOUNDARY_(\d+)\s*\]\]/g;
  const markers = [];
  let match;

  while ((match = pattern.exec(translated)) !== null) {
    markers.push({
      index: Number.parseInt(match[1] ?? "", 10),
      start: match.index,
      end: pattern.lastIndex
    });
  }

  if (markers.length !== count) return null;

  const result = new Array(count);
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const next = markers[index + 1];
    if (!Number.isInteger(marker.index) || marker.index < 0 || marker.index >= count) {
      return null;
    }

    result[marker.index] = cleanTranslation(translated.slice(marker.end, next?.start ?? translated.length));
  }

  return result.every((value) => typeof value === "string") ? result : null;
}

async function translateRemoteBatch(texts, remoteSourceLang = sourceLang) {
  if (texts.length === 1) return [await translateRemote(texts[0], remoteSourceLang)];

  const combined = texts.map((text, index) => `${buildBatchMarker(index)}\n${text}`).join("\n");
  const translated = await translateRemote(combined, remoteSourceLang);
  const parsed = parseBatchTranslation(translated, texts.length);

  if (!parsed) {
    throw new Error("batch_marker_mismatch");
  }

  return parsed;
}

function ensureSchema(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(media_metadata)").all().map((column) => column.name));
  const ensureColumn = (name, definition) => {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE media_metadata ADD COLUMN ${name} ${definition}`);
      columns.add(name);
    }
  };

  ensureColumn("title_zh", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("summary_zh", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("director_zh", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("actors_zh_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("genres_zh_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("maker_zh", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("label_zh", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("series_zh", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("translation_status", "TEXT NOT NULL DEFAULT 'pending'");
  ensureColumn("translation_error", "TEXT");
  ensureColumn("translation_source", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("translation_input_hash", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("translated_at", "TEXT");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_metadata_translation_status ON media_metadata(translation_status);

    CREATE TABLE IF NOT EXISTS metadata_translation_cache (
      source_text TEXT NOT NULL,
      target_lang TEXT NOT NULL,
      provider TEXT NOT NULL,
      translated_text TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source_text, target_lang, provider)
    )
  `);
}

function readRows(db) {
  if (englishTitleRepairMode) return readEnglishTitleRepairRows(db);

  const conditions = ["status = 'ready'"];
  const params = {};

  if (!force) {
    conditions.push(`(
      translation_status != 'ready'
      OR translation_input_hash = ''
      OR translation_input_hash IS NULL
    )`);
  }

  if (codes.length > 0) {
    conditions.push(`normalized_code IN (${codes.map((_, index) => `@code${index}`).join(", ")})`);
    codes.forEach((code, index) => {
      params[`code${index}`] = code;
    });
  }

  addModifiedSinceCondition(conditions, params);

  return db
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
        translation_status,
        translation_input_hash
      FROM media_metadata
      WHERE ${conditions.join(" AND ")}
      ORDER BY
        CASE translation_status
          WHEN 'failed' THEN 0
          WHEN 'pending' THEN 1
          WHEN 'skipped' THEN 2
          ELSE 3
        END,
        updated_at DESC,
        normalized_code ASC
      LIMIT @limit
    `
    )
    .all({ ...params, limit: batchLimit });
}

function shouldRepairEnglishTitle(row) {
  const title = normalizeText(row.title);
  const titleZh = normalizeText(row.title_zh);
  const titleIsEnglish = looksLikeEnglishNarrative(title);
  if (!title) return false;

  if (hasChineseText(titleZh) && getEnglishTitleFragments(titleZh).length > 0) return true;
  if (looksLikeEnglishNarrative(titleZh)) return true;
  if (titleIsEnglish && (!hasChineseText(titleZh) || hasEnglishPhrase(titleZh, 2))) return true;
  if (force && titleIsEnglish) return true;
  if (titleIsEnglish && (!titleZh || titleZh === title)) return true;

  return false;
}

function readEnglishTitleRepairRows(db) {
  const conditions = ["status = 'ready'", "translation_status = 'ready'"];
  const params = {};

  if (codes.length > 0) {
    conditions.push(`normalized_code IN (${codes.map((_, index) => `@code${index}`).join(", ")})`);
    codes.forEach((code, index) => {
      params[`code${index}`] = code;
    });
  }

  addModifiedSinceCondition(conditions, params);

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
    `
    )
    .all(params);

  return rows.filter(shouldRepairEnglishTitle).slice(0, batchLimit);
}

function markIneligibleRowsSkipped(db) {
  const conditions = ["status != 'ready'", "translation_status != 'skipped'"];
  const params = { provider, updatedAt: nowIso() };
  if (codes.length > 0) {
    conditions.push(`normalized_code IN (${codes.map((_, index) => `@skipCode${index}`).join(", ")})`);
    codes.forEach((code, index) => {
      params[`skipCode${index}`] = code;
    });
  }
  addModifiedSinceCondition(conditions, params);

  const result = db
    .prepare(
      `
      UPDATE media_metadata
      SET translation_status = 'skipped',
          translation_error = CASE
            WHEN status = 'not_found' THEN 'metadata_not_found'
            ELSE 'metadata_not_ready'
          END,
          translation_source = @provider,
          translated_at = NULL,
          updated_at = @updatedAt
      WHERE ${conditions.join(" AND ")}
    `
    )
    .run(params);

  return result.changes;
}

function collectTextItems(items) {
  return uniqueStrings(items.flatMap(({ text, context }) => {
    const normalized = normalizeText(text);
    if (!normalized || shouldSkipTranslation(normalized, context)) return [];
    return splitTextForTranslation(normalized).filter((chunk) => !shouldSkipTranslation(chunk, context));
  }));
}

function collectInputTexts(input) {
  return collectTextItems([
    { text: input.title, context: "narrative" },
    { text: input.summary, context: "narrative" },
    { text: input.director, context: "director" },
    ...input.actors.map((text) => ({ text, context: "actor" })),
    ...input.genres.map((text) => ({ text, context: "genre" })),
    { text: input.maker, context: "maker" },
    { text: input.label, context: "label" },
    { text: input.series, context: "series" }
  ]);
}

function getEnglishTitleRepairSource(input, before) {
  if (looksLikeEnglishNarrative(input.title)) return input.title;
  if (hasEnglishPhrase(before.titleZh, 2)) return before.titleZh;
  return input.title;
}

function isNaturalEnglishWord(word) {
  const normalized = normalizeText(word);
  if (normalized.length < 3) return false;
  const upper = normalized.toUpperCase();
  if (compactIdentifierWords.has(upper) || /^[A-Z0-9]{2,}$/.test(normalized)) return false;
  return /[a-z]/.test(normalized);
}

function shouldTranslateEnglishFragment(fragment) {
  if (getKnownTermTranslation(fragment, "actor")) return true;

  const naturalWords = getEnglishNarrativeWords(fragment).filter(isNaturalEnglishWord);
  return naturalWords.length >= 2 && hasEnglishPhrase(fragment, 2);
}

function getEnglishTitleFragments(value) {
  return uniqueStrings(
    [...normalizeText(value).matchAll(englishFragmentPattern)]
      .map((match) => normalizeText(match[0]))
      .filter(shouldTranslateEnglishFragment)
  );
}

function shouldRepairEnglishTitleFragments(before) {
  const titleZh = normalizeText(before.titleZh);
  if (!titleZh || !hasChineseText(titleZh)) return false;
  return getEnglishTitleFragments(titleZh).length > 0;
}

function collectEnglishTitleRepairTexts(row) {
  const input = getTranslationInput(row);
  const before = getExistingTranslation(row);
  if (shouldRepairEnglishTitleFragments(before)) {
    return collectTextItems(getEnglishTitleFragments(before.titleZh).map((text) => ({ text, context: "narrative" })));
  }

  return collectTextItems([
    {
      text: getEnglishTitleRepairSource(input, before),
      context: "narrative"
    }
  ]);
}

function buildPrefetchChunks(texts) {
  const chunks = [];
  let current = [];
  let currentChars = 0;

  for (const text of texts) {
    const projectedChars = currentChars + text.length;
    const wouldOverflow =
      current.length > 0 && (current.length >= prefetchTextLimit || projectedChars > prefetchCharLimit);

    if (wouldOverflow) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }

    current.push(text);
    currentChars += text.length;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function primeTranslationCache(cacheStatements, rows, stats, label = "") {
  if (!prefetchEnabled || dryRun) return;

  const texts = uniqueStrings(
    rows.flatMap((row) => {
      return englishTitleRepairMode ? collectEnglishTitleRepairTexts(row) : collectInputTexts(getTranslationInput(row));
    })
  );
  const missingTexts = texts.filter((text) => {
    const cached = cacheStatements.get.get({
      sourceText: text,
      targetLang,
      provider
    });
    return !cached?.translated_text;
  });

  if (missingTexts.length === 0) return;

  const chunks = buildPrefetchChunks(missingTexts);
  const labelText = label ? ` ${label}` : "";
  console.log(`Metadata translation prefetch${labelText}: ${missingTexts.length} texts in ${chunks.length} requests`);

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];
    try {
      const translations = await translateRemoteBatch(
        englishTitleRepairMode ? chunk.map((text) => prepareRemoteText(text, "narrative")) : chunk,
        englishTitleRepairMode ? getRemoteSourceLang(chunk.join(" "), "narrative") : sourceLang
      );
      const updatedAt = nowIso();
      for (let index = 0; index < chunk.length; index += 1) {
        cacheStatements.upsert.run({
          sourceText: chunk[index],
          targetLang,
          provider,
          translatedText: translations[index],
          updatedAt
        });
      }
      stats.remoteCalls += 1;
      if (delayMs > 0) await wait(delayMs);
    } catch {
      for (const text of chunk) {
        try {
          const translated = await translateRemote(
            englishTitleRepairMode ? prepareRemoteText(text, "narrative") : text,
            englishTitleRepairMode ? getRemoteSourceLang(text, "narrative") : sourceLang
          );
          cacheStatements.upsert.run({
            sourceText: text,
            targetLang,
            provider,
            translatedText: translated,
            updatedAt: nowIso()
          });
          stats.remoteCalls += 1;
          if (delayMs > 0) await wait(delayMs);
        } catch (error) {
          console.warn(
            `Metadata translation prefetch skipped one text: ${
              error instanceof Error ? error.message : "translation_failed"
            }`
          );
        }
      }
    }

    const finished = chunkIndex + 1;
    if (finished % prefetchProgressInterval === 0 || finished === chunks.length) {
      console.log(`Metadata translation prefetch${labelText}: ${finished}/${chunks.length} requests done`);
    }
  }
}

async function translateText(db, cacheStatements, text, stats, context = "generic") {
  const normalized = normalizeText(text);
  if (!normalized) return "";

  const knownTerm = getKnownTermTranslation(normalized, context);
  if (knownTerm) return knownTerm;
  if (shouldSkipTranslation(normalized, context)) return normalized;

  const cached = cacheStatements.get.get({
    sourceText: normalized,
    targetLang,
    provider
  });
  if (cached?.translated_text) {
    const cachedText = improveTranslatedText(normalized, cached.translated_text, context);
    const cachedLooksStale =
      context === "narrative" && looksLikeEnglishNarrative(normalized) && hasEnglishPhrase(cachedText, 2);
    if (!cachedLooksStale) {
      stats.cacheHits += 1;
      return cachedText;
    }
  }

  const chunks = splitTextForTranslation(normalized);
  if (chunks.length > 1) {
    const translatedChunks = [];
    for (const chunk of chunks) {
      translatedChunks.push(await translateText(db, cacheStatements, chunk, stats, context));
    }

    const translated = improveTranslatedText(normalized, cleanTranslation(translatedChunks.join("")), context);
    if (!dryRun) {
      cacheStatements.upsert.run({
        sourceText: normalized,
        targetLang,
        provider,
        translatedText: translated,
        updatedAt: nowIso()
      });
    }
    return translated;
  }

  const translated = improveTranslatedText(
    normalized,
    await translateRemote(prepareRemoteText(normalized, context), getRemoteSourceLang(normalized, context)),
    context
  );
  if (!dryRun) {
    cacheStatements.upsert.run({
      sourceText: normalized,
      targetLang,
      provider,
      translatedText: translated,
      updatedAt: nowIso()
    });
  }
  stats.remoteCalls += 1;
  if (delayMs > 0) await wait(delayMs);
  return translated;
}

async function translateArray(db, cacheStatements, values, stats, context) {
  const translated = [];

  for (const value of values) {
    translated.push(await translateText(db, cacheStatements, value, stats, context));
  }

  return translated;
}

async function translateRow(db, statements, cacheStatements, row, stats) {
  const input = getTranslationInput(row);
  const inputHash = hashInput(input);

  if (!force && row.translation_status === "ready" && row.translation_input_hash === inputHash) {
      if (!dryRun) {
        statements.markSkipped.run({
          normalizedCode: row.normalized_code,
          translationStatus: "ready",
          updatedAt: nowIso()
        });
      }
    stats.skipped += 1;
    return;
  }

  try {
    const rawTranslated = {
      titleZh: await translateText(db, cacheStatements, input.title, stats, "narrative"),
      summaryZh: await translateText(db, cacheStatements, input.summary, stats, "narrative"),
      directorZh: await translateText(db, cacheStatements, input.director, stats, "director"),
      actorsZh: await translateArray(db, cacheStatements, input.actors, stats, "actor"),
      genresZh: await translateArray(db, cacheStatements, input.genres, stats, "genre"),
      makerZh: await translateText(db, cacheStatements, input.maker, stats, "maker"),
      labelZh: await translateText(db, cacheStatements, input.label, stats, "label"),
      seriesZh: await translateText(db, cacheStatements, input.series, stats, "series")
    };
    const translated = improveMetadataTranslation(input, rawTranslated);

    if (!dryRun) {
      statements.updateReady.run({
        normalizedCode: row.normalized_code,
        titleZh: translated.titleZh,
        summaryZh: translated.summaryZh,
        directorZh: translated.directorZh,
        actorsZhJson: JSON.stringify(translated.actorsZh),
        genresZhJson: JSON.stringify(translated.genresZh),
        makerZh: translated.makerZh,
        labelZh: translated.labelZh,
        seriesZh: translated.seriesZh,
        translationStatus: "ready",
        translationError: null,
        translationSource: provider,
        translationInputHash: inputHash,
        translatedAt: nowIso()
      });
    }
    stats.ready += 1;
  } catch (error) {
    if (!dryRun) {
      statements.updateFailed.run({
        normalizedCode: row.normalized_code,
        translationStatus: "failed",
        translationError: error instanceof Error ? error.message : "Translation failed",
        translationSource: provider,
        translationInputHash: inputHash,
        updatedAt: nowIso()
      });
    }
    stats.failed += 1;
  }
}

function appendTranslationSource(source, suffix) {
  const current = normalizeText(source);
  if (current.includes(suffix)) return current;
  return [current || "translation", suffix].join("+");
}

function hasEnglishTitleRepairSource(row) {
  return normalizeText(row.translation_source).includes(":english-title");
}

function isUsableEnglishTitleRepair(sourceTitle, beforeTitle, afterTitle) {
  const source = normalizeText(sourceTitle);
  const before = normalizeText(beforeTitle);
  const after = normalizeText(afterTitle);
  if (!after || !hasChineseText(after)) return false;
  if (source && after.toLowerCase() === source.toLowerCase()) return false;

  const beforeEnglishScore = englishPhraseScore(before);
  const afterEnglishScore = englishPhraseScore(after);
  if (afterEnglishScore >= Math.max(2, beforeEnglishScore) && looksLikeEnglishNarrative(after)) {
    return false;
  }

  return true;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getPrimaryActorName(value) {
  const normalized = normalizeText(value);
  return normalizeText(normalized.split(/[（(]/)[0]) || normalized;
}

function getActorAliases(value) {
  const normalized = normalizeText(value);
  if (!normalized) return [];

  const aliases = [normalized, normalizeText(normalized.replace(/\s*\([^)]*\)\s*/g, " "))];
  for (const match of normalized.matchAll(/\(([^)]+)\)/g)) {
    aliases.push(
      ...String(match[1] ?? "")
        .split(/[,/、，]/)
        .map(normalizeText)
    );
  }

  return uniqueStrings(aliases).filter((alias) => alias.length >= 2);
}

function includesFolded(haystack, needle) {
  return normalizeText(haystack).toLowerCase().includes(normalizeText(needle).toLowerCase());
}

function replaceActorAliases(output, aliases, actorZh) {
  let next = output;
  for (const alias of aliases) {
    if (!alias || !includesFolded(next, alias)) continue;
    next = next.replace(new RegExp(escapeRegExp(alias), "gi"), actorZh);
  }
  return next;
}

function dedupeActorName(output, actorZh) {
  const escaped = escapeRegExp(actorZh);
  return output.replace(new RegExp(`${escaped}(?:[\\s、，,]+${escaped})+`, "g"), actorZh);
}

function trimTrailingDuplicateActorName(output, actorZh) {
  if (!actorZh) return output;

  const firstIndex = output.indexOf(actorZh);
  const lastIndex = output.lastIndexOf(actorZh);
  if (firstIndex < 0 || lastIndex <= firstIndex) return output;

  return cleanTranslation(output.replace(new RegExp(`[\\s、，,/+-]*${escapeRegExp(actorZh)}\\s*$`), ""));
}

function preserveExistingActorNames(sourceTitle, beforeTitle, afterTitle, actors, actorsZh) {
  const source = normalizeText(sourceTitle);
  const before = normalizeText(beforeTitle);
  let output = normalizeText(afterTitle);
  if (!output) return output;

  for (const [index, actorZhValue] of actorsZh.entries()) {
    const actorZh = getPrimaryActorName(actorZhValue);
    if (!actorZh) continue;

    const aliases = getActorAliases(actors[index]);
    output = replaceActorAliases(output, aliases, actorZh);
    output = dedupeActorName(output, actorZh);
    output = trimTrailingDuplicateActorName(output, actorZh);
    if (output.includes(actorZh)) continue;

    const shouldPreserve =
      before.includes(actorZh) || aliases.some((alias) => includesFolded(source, alias));
    if (!shouldPreserve) continue;

    output = output.replace(/^[\p{Script=Han}·]{2,12}(?=[\s，,。！!？?:：、~～-])/u, actorZh);
    if (output.includes(actorZh)) continue;

    const replaced = output.replace(
      /([\s，,。！!？?:：、~～-]+)([\p{Script=Han}·]{2,12})([。.!！?？]*)$/u,
      `$1${actorZh}$3`
    );
    output = replaced;
    if (output.includes(actorZh)) continue;

    const surname = actorZh.slice(0, 2);
    const surnameIndex = surname ? output.lastIndexOf(surname) : -1;
    if (surnameIndex >= 0) {
      const suffix = output.slice(surnameIndex);
      if (/^[\p{Script=Han}·]{2,12}[。.!！?？]*$/u.test(suffix)) {
        output = `${output.slice(0, surnameIndex)}${actorZh}${suffix.match(/[。.!！?？]*$/u)?.[0] ?? ""}`;
      }
    }
    if (!output.includes(actorZh)) output = `${output} ${actorZh}`;
  }

  return cleanTranslation(output);
}

async function repairEnglishFragmentsInTitle(db, cacheStatements, titleZh, stats) {
  let output = normalizeText(titleZh);
  const fragments = getEnglishTitleFragments(output).sort((a, b) => b.length - a.length);

  for (const fragment of fragments) {
    const translated = await translateText(db, cacheStatements, fragment, stats, "narrative");
    if (!translated || translated === fragment || !hasChineseText(translated)) continue;
    if (hasEnglishPhrase(translated, 2) && englishPhraseScore(translated) >= englishPhraseScore(fragment)) continue;
    output = output.replace(new RegExp(escapeRegExp(fragment), "g"), translated);
  }

  return cleanTranslation(output);
}

async function repairEnglishTitleRow(db, statements, cacheStatements, row, stats) {
  const input = getTranslationInput(row);
  const before = getExistingTranslation(row);
  const repairSource = getEnglishTitleRepairSource(input, before);
  const fragmentRepair = shouldRepairEnglishTitleFragments(before);

  try {
    const rawTitleZh = fragmentRepair
      ? await repairEnglishFragmentsInTitle(db, cacheStatements, before.titleZh, stats)
      : await translateText(db, cacheStatements, repairSource, stats, "narrative");
    const translatedTitleZh = fragmentRepair
      ? improveTranslatedText(before.titleZh, rawTitleZh, "narrative")
      : improveMetadataTranslation(input, {
          ...before,
          titleZh: rawTitleZh
        }).titleZh;

    const titleZh = preserveExistingActorNames(
      input.title,
      before.titleZh,
      translatedTitleZh,
      input.actors,
      before.actorsZh
    );
    if (!isUsableEnglishTitleRepair(repairSource, before.titleZh, titleZh)) {
      stats.skipped += 1;
      return;
    }

    if (hasEnglishPhrase(before.titleZh, 2) && englishPhraseScore(titleZh) >= englishPhraseScore(before.titleZh)) {
      stats.skipped += 1;
      return;
    }

    if (titleZh === before.titleZh && hasEnglishTitleRepairSource(row)) {
      stats.skipped += 1;
      return;
    }

    if (titleZh !== before.titleZh && stats.examples.length < 10) {
      stats.examples.push({
        code: row.normalized_code,
        before: before.titleZh,
        after: titleZh
      });
    }

    if (!dryRun) {
      statements.updateTitleRepair.run({
        normalizedCode: row.normalized_code,
        titleZh,
        translationSource: appendTranslationSource(row.translation_source, `${provider}:english-title`),
        translatedAt: nowIso()
      });
    }

    stats.ready += 1;
  } catch (error) {
    console.warn(
      `English title repair skipped ${row.normalized_code}: ${
        error instanceof Error ? error.message : "Translation failed"
      }`
    );
    stats.failed += 1;
  }
}

if (!fs.existsSync(databasePath)) {
  console.error(`Metadata database not found: ${relative(databasePath)}`);
  process.exit(1);
}

const db = new Database(databasePath);
ensureSchema(db);
const skippedIneligibleRows = englishTitleRepairMode || dryRun ? 0 : markIneligibleRowsSkipped(db);

const statements = {
  updateReady: db.prepare(`
    UPDATE media_metadata
    SET title_zh = @titleZh,
        summary_zh = @summaryZh,
        director_zh = @directorZh,
        actors_zh_json = @actorsZhJson,
        genres_zh_json = @genresZhJson,
        maker_zh = @makerZh,
        label_zh = @labelZh,
        series_zh = @seriesZh,
        translation_status = @translationStatus,
        translation_error = @translationError,
        translation_source = @translationSource,
        translation_input_hash = @translationInputHash,
        translated_at = @translatedAt
    WHERE normalized_code = @normalizedCode
  `),
  updateFailed: db.prepare(`
    UPDATE media_metadata
    SET translation_status = @translationStatus,
        translation_error = @translationError,
        translation_source = @translationSource,
        translation_input_hash = @translationInputHash,
        translated_at = NULL
    WHERE normalized_code = @normalizedCode
  `),
  markSkipped: db.prepare(`
    UPDATE media_metadata
    SET translation_status = @translationStatus
    WHERE normalized_code = @normalizedCode
  `),
  updateTitleRepair: db.prepare(`
    UPDATE media_metadata
    SET title_zh = @titleZh,
        translation_source = @translationSource,
        translated_at = @translatedAt,
        updated_at = @translatedAt
    WHERE normalized_code = @normalizedCode
  `)
};
const cacheStatements = {
  get: db.prepare(`
    SELECT translated_text
    FROM metadata_translation_cache
    WHERE source_text = @sourceText
      AND target_lang = @targetLang
      AND provider = @provider
  `),
  upsert: db.prepare(`
    INSERT INTO metadata_translation_cache (
      source_text,
      target_lang,
      provider,
      translated_text,
      updated_at
    )
    VALUES (
      @sourceText,
      @targetLang,
      @provider,
      @translatedText,
      @updatedAt
    )
    ON CONFLICT(source_text, target_lang, provider) DO UPDATE SET
      translated_text = excluded.translated_text,
      updated_at = excluded.updated_at
  `)
};
const rows = readRows(db);
const stats = {
  total: rows.length,
  ready: 0,
  failed: 0,
  skipped: 0,
  cacheHits: 0,
  remoteCalls: 0,
  examples: []
};

console.log(
  `Metadata translation starting: ${rows.length} rows, mode=${mode}, provider=${provider}, target=${targetLang}, force=${force}, dryRun=${dryRun}, modifiedSinceDays=${modifiedSinceDays}, db=${relative(databasePath)}`
);
if (skippedIneligibleRows > 0) {
  console.log(`Metadata translation skipped ${skippedIneligibleRows} rows without ready metadata`);
}

for (let start = 0; start < rows.length; start += rowWindowSize) {
  const windowRows = rows.slice(start, start + rowWindowSize);
  const windowLabel = `rows ${start + 1}-${start + windowRows.length}/${rows.length}`;
  await primeTranslationCache(cacheStatements, windowRows, stats, windowLabel);

  for (const row of windowRows) {
    if (englishTitleRepairMode) {
      await repairEnglishTitleRow(db, statements, cacheStatements, row, stats);
    } else {
      await translateRow(db, statements, cacheStatements, row, stats);
    }
    const finished = stats.ready + stats.failed + stats.skipped;
    if (finished % progressInterval === 0 || finished === rows.length) {
      console.log(
        `Metadata translation: ${finished}/${rows.length}, ready=${stats.ready}, failed=${stats.failed}, skipped=${stats.skipped}, cache=${stats.cacheHits}, remote=${stats.remoteCalls}`
      );
    }
  }
}

if (!dryRun && rows.length > 0) {
  db.prepare(`
    UPDATE ingestion_items
    SET metadata_status = COALESCE((
          SELECT status FROM media_metadata WHERE media_metadata.normalized_code = ingestion_items.normalized_code
        ), metadata_status),
        translation_status = COALESCE((
          SELECT translation_status FROM media_metadata WHERE media_metadata.normalized_code = ingestion_items.normalized_code
        ), translation_status),
        updated_at = @updatedAt
    WHERE normalized_code IN (
      SELECT normalized_code FROM media_metadata WHERE translation_status IN ('ready', 'failed', 'skipped')
    )
  `).run({ updatedAt: nowIso() });
}

db.close();
if (stats.examples.length > 0) {
  console.log(
    JSON.stringify(
      {
        mode,
        dryRun,
        examples: stats.examples
      },
      null,
      2
    )
  );
}
console.log(
  `Metadata translation finished: ready=${stats.ready}, failed=${stats.failed}, skipped=${stats.skipped}, cache=${stats.cacheHits}, remote=${stats.remoteCalls}`
);
