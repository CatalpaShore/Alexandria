import { z } from "zod";
import { ensureCachedCover, getCachedCover } from "./covers.js";
import { db } from "./db.js";
import { readFavoriteKeys } from "./favorites.js";
import { getLocalizedActorDisplayName } from "./actorAliases.js";
import {
  MEDIA_LIST_JOINS,
  MEDIA_LIST_SELECT,
  hydrateMediaRows,
  isHiddenMetadataGenre,
  parseJsonStringArray,
  type MediaListRow
} from "./queries/mediaListQueries.js";

const MEDIA_CACHE_TTL_MS = 10 * 60 * 1000;
const FACET_CACHE_TTL_MS = 15 * 60 * 1000;
const SEARCH_SUGGESTION_CACHE_TTL_MS = 5 * 60 * 1000;
const SHORT_SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const FACET_LOCALIZATION_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_MEDIA_CACHE_ENTRIES = 128;
const MAX_FACET_CACHE_ENTRIES = 128;
const MAX_SEARCH_SUGGESTION_CACHE_ENTRIES = 160;
const MAX_SHORT_SEARCH_CACHE_ENTRIES = 16;
const CACHE_WARMUP_SEARCH_LIMIT = 8;

type JsonCacheEntry = {
  expiresAt: number;
  value: unknown;
};

type MetadataFacetType = "actor" | "genre" | "director" | "maker" | "label" | "series";
type MetadataFacetLocalizationCache = {
  expiresAt: number;
  values: Record<MetadataFacetType, Map<string, string>>;
};

export type CacheStatus = "HIT" | "MISS" | "BYPASS";
export type CachedResponse<T = unknown> = {
  body: T;
  cacheStatus: CacheStatus;
};

export type SearchDomain = ReturnType<typeof createSearchDomain>;

const booleanQuery = z.preprocess((value) => {
  if (value == null || value === "") return undefined;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return value;
}, z.boolean().optional());

const listQuery = z.preprocess((value) => {
  if (value == null || value === "") return [];

  const rawValues = Array.isArray(value) ? value : [value];
  const seen = new Set<string>();
  const values: string[] = [];

  for (const rawValue of rawValues) {
    for (const item of String(rawValue).split(",")) {
      const trimmed = item.trim();
      if (!trimmed || trimmed === "ALL" || seen.has(trimmed)) continue;
      seen.add(trimmed);
      values.push(trimmed);
    }
  }

  return values;
}, z.array(z.string().trim().min(1)).default([]));

const mediaQuerySchema = z.object({
  q: z.string().trim().optional(),
  letter: z.string().trim().optional(),
  extension: z.string().trim().optional(),
  prefix: z.string().trim().optional(),
  category: z.string().trim().optional(),
  bucket: z.string().trim().optional(),
  source: z.string().trim().optional(),
  tag: z.string().trim().optional(),
  actor: listQuery,
  genre: listQuery,
  director: listQuery,
  maker: listQuery,
  label: listQuery,
  metadataSeries: listQuery,
  mediaType: z.enum(["video", "image"]).optional(),
  favoriteOnly: booleanQuery,
  playbackState: z.enum(["history", "inProgress", "completed"]).optional(),
  groupVersions: booleanQuery.default(true),
  pagination: z.enum(["offset", "cursor"]).default("offset"),
  cursor: z.string().trim().max(1000).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(12).max(120).default(48),
  sort: z.enum(["name", "mtime", "size", "random", "recentPlayed", "progress"]).default("name"),
  direction: z.enum(["asc", "desc"]).default("asc"),
  randomSeed: z.coerce.number().optional()
});

const facetQuerySchema = mediaQuerySchema.omit({
  page: true,
  pageSize: true,
  sort: true,
  direction: true,
  randomSeed: true,
  pagination: true,
  cursor: true,
  groupVersions: true
});

const searchSuggestionsQuerySchema = z.object({
  q: z.string().trim().default(""),
  limit: z.coerce.number().int().min(4).max(16).default(8)
});

const sortMap = {
  name: "media_files.name",
  mtime: "media_files.mtime_ms",
  size: "media_files.size",
  recentPlayed: "COALESCE(playback_progress.last_played_at, '')",
  progress:
    "COALESCE(playback_progress.position_seconds / NULLIF(COALESCE(playback_progress.duration_seconds, media_files.duration_seconds), 0), 0)"
} as const;

const UINT64_MASK = (1n << 64n) - 1n;
const SQLITE_POSITIVE_INTEGER_MAX = (1n << 63n) - 1n;

export function randomPivotFromSeed(seed: number): number {
  let value = (BigInt(Math.trunc(seed)) + 0x9e3779b97f4a7c15n) & UINT64_MASK;
  value = ((value ^ (value >> 30n)) * 0xbf58476d1ce4e5b9n) & UINT64_MASK;
  value = ((value ^ (value >> 27n)) * 0x94d049bb133111ebn) & UINT64_MASK;
  value ^= value >> 31n;
  return Number(value & SQLITE_POSITIVE_INTEGER_MAX);
}

type MediaCursor = {
  version: 1;
  sort: z.infer<typeof mediaQuerySchema>["sort"];
  direction: z.infer<typeof mediaQuerySchema>["direction"];
  randomSeed: number;
  value: string | number;
  name: string;
  id: string;
  randomBucket?: number;
  randomKey?: string | number;
};

function decodeMediaCursor(
  encoded: string | undefined,
  query: z.infer<typeof mediaQuerySchema>
): MediaCursor | null {
  if (!encoded) return null;
  try {
    return z.object({
      version: z.literal(1),
      sort: z.literal(query.sort),
      direction: z.literal(query.direction),
      randomSeed: z.literal(Math.trunc(query.randomSeed ?? 0)),
      value: z.union([z.string(), z.number()]),
      name: z.string(),
      id: z.string(),
      randomBucket: z.number().int().optional(),
      randomKey: z.union([z.string(), z.number()]).optional()
    }).parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))) as MediaCursor;
  } catch {
    return null;
  }
}

function encodeMediaCursor(cursor: MediaCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function buildCursorPredicate(
  query: z.infer<typeof mediaQuerySchema>,
  cursor: MediaCursor,
  params: Record<string, string | number>
): string {
  params.cursorName = cursor.name;
  params.cursorId = cursor.id;
  if (query.sort === "random") {
    params.cursorRandomBucket = cursor.randomBucket ?? 0;
    params.cursorRandomKey = String(cursor.randomKey ?? cursor.value);
    const bucketSql = "CASE WHEN media_files.random_key >= @randomPivot THEN 0 ELSE 1 END";
    return `(
      ${bucketSql} > @cursorRandomBucket OR
      (${bucketSql} = @cursorRandomBucket AND media_files.random_key > CAST(@cursorRandomKey AS INTEGER)) OR
      (${bucketSql} = @cursorRandomBucket AND media_files.random_key = CAST(@cursorRandomKey AS INTEGER) AND media_files.id > @cursorId)
    )`;
  }

  const expression = sortMap[query.sort];
  const comparator = query.direction === "desc" ? "<" : ">";
  params.cursorValue = cursor.value;
  return `(
    ${expression} ${comparator} @cursorValue OR
    (${expression} = @cursorValue AND media_files.name > @cursorName) OR
    (${expression} = @cursorValue AND media_files.name = @cursorName AND media_files.id > @cursorId)
  )`;
}

function createMediaCursor(
  query: z.infer<typeof mediaQuerySchema>,
  row: MediaListRow,
  randomPivot: number
): string {
  const name = String(row.name ?? "");
  const id = String(row.id);
  let value: string | number;
  if (query.sort === "mtime") value = Number(row.mtimeMs ?? 0);
  else if (query.sort === "size") value = Number(row.size ?? 0);
  else if (query.sort === "recentPlayed") value = row.playbackLastPlayedAt ?? "";
  else if (query.sort === "progress") {
    const duration = Number(row.playbackDurationSeconds ?? row.durationSeconds ?? 0);
    value = duration > 0 ? Number(row.playbackPositionSeconds ?? 0) / duration : 0;
  } else if (query.sort === "random") value = row.randomKeyCursor ?? String(row.randomKey ?? 0);
  else value = name;

  const randomKey = query.sort === "random"
    // SQLite random_key is a signed 64-bit integer; keep its decimal text exact across page cursors.
    ? row.randomKeyCursor ?? String(row.randomKey ?? 0)
    : undefined;
  const randomBucket = randomKey == null
    ? undefined
    : BigInt(randomKey) >= BigInt(Math.trunc(randomPivot)) ? 0 : 1;
  return encodeMediaCursor({
    version: 1,
    sort: query.sort,
    direction: query.direction,
    randomSeed: Math.trunc(query.randomSeed ?? 0),
    value,
    name,
    id,
    randomBucket,
    randomKey
  });
}

db.exec(`
  CREATE TEMP TABLE IF NOT EXISTS short_search_matches (
    query_key TEXT NOT NULL,
    media_id TEXT NOT NULL,
    PRIMARY KEY (query_key, media_id)
  ) WITHOUT ROWID
`);

function readCachedJson<T>(cache: Map<string, JsonCacheEntry>, key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }

  cache.delete(key);
  cache.set(key, entry);
  return entry.value as T;
}

function writeCachedJson(
  cache: Map<string, JsonCacheEntry>,
  key: string,
  value: unknown,
  ttlMs: number,
  maxEntries: number
): void {
  const now = Date.now();
  for (const [cacheKey, entry] of cache.entries()) {
    if (entry.expiresAt <= now) cache.delete(cacheKey);
  }

  cache.delete(key);
  cache.set(key, { expiresAt: now + ttlMs, value });
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

function getMediaCacheKey(query: z.infer<typeof mediaQuerySchema>): string {
  return JSON.stringify({
    q: query.q ?? "",
    letter: query.letter ?? "ALL",
    extension: query.extension ?? "ALL",
    prefix: query.prefix ?? "ALL",
    category: query.category ?? "ALL",
    bucket: query.bucket ?? "ALL",
    source: query.source ?? "ALL",
    tag: query.tag ?? "ALL",
    actor: query.actor,
    genre: query.genre,
    director: query.director,
    maker: query.maker,
    label: query.label,
    metadataSeries: query.metadataSeries,
    mediaType: query.mediaType ?? "ALL",
    page: query.page,
    pageSize: query.pageSize,
    sort: query.sort,
    direction: query.direction,
    randomSeed: query.randomSeed ?? 0,
    groupVersions: query.groupVersions,
    pagination: query.pagination,
    cursor: query.cursor ?? "",
    playbackState: query.playbackState ?? "ALL"
  });
}

function getFacetCacheKey(query: z.infer<typeof facetQuerySchema>): string {
  return JSON.stringify({
    q: query.q ?? "",
    letter: query.letter ?? "ALL",
    extension: query.extension ?? "ALL",
    prefix: query.prefix ?? "ALL",
    category: query.category ?? "ALL",
    bucket: query.bucket ?? "ALL",
    source: query.source ?? "ALL",
    tag: query.tag ?? "ALL",
    actor: query.actor,
    genre: query.genre,
    director: query.director,
    maker: query.maker,
    label: query.label,
    metadataSeries: query.metadataSeries,
    mediaType: query.mediaType ?? "ALL",
    favoriteOnly: Boolean(query.favoriteOnly),
    playbackState: query.playbackState ?? "ALL"
  });
}

function normalizeSearchNeedle(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function quoteFtsPhrase(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function withAdditionalWhere(baseWhereSql: string, extra: string): string {
  return baseWhereSql ? `${baseWhereSql} AND ${extra}` : `WHERE ${extra}`;
}

export function createSearchDomain(options: {
  isScanActive: () => boolean;
  getLatestScan: () => unknown;
}) {
  const mediaResponseCache = new Map<string, JsonCacheEntry>();
  const facetResponseCache = new Map<string, JsonCacheEntry>();
  const searchSuggestionResponseCache = new Map<string, JsonCacheEntry>();
  const shortSearchMatchCache = new Map<string, number>();
  let metadataFacetLocalizationCache: MetadataFacetLocalizationCache | null = null;

  function clearCaches(): void {
    mediaResponseCache.clear();
    facetResponseCache.clear();
    searchSuggestionResponseCache.clear();
    shortSearchMatchCache.clear();
    db.prepare("DELETE FROM temp.short_search_matches").run();
    metadataFacetLocalizationCache = null;
  }

  function clearPlaybackCaches(): void {
    // Media responses embed progress, but the expensive default facet inventory
    // does not. Keep those facet snapshots warm while invalidating only facet
    // queries that explicitly depend on playback state.
    mediaResponseCache.clear();
    for (const cacheKey of facetResponseCache.keys()) {
      try {
        const parsed = JSON.parse(cacheKey) as { playbackState?: unknown };
        if (parsed.playbackState !== "ALL") facetResponseCache.delete(cacheKey);
      } catch {
        facetResponseCache.delete(cacheKey);
      }
    }
  }

  function materializeShortSearchMatches(needle: string): string {
    const now = Date.now();
    const queryKey = needle.toLocaleLowerCase();

    for (const [cachedKey, expiresAt] of shortSearchMatchCache.entries()) {
      if (expiresAt > now) continue;
      db.prepare("DELETE FROM temp.short_search_matches WHERE query_key = ?").run(cachedKey);
      shortSearchMatchCache.delete(cachedKey);
    }

    if (!shortSearchMatchCache.has(queryKey)) {
      db.prepare(
        `
        INSERT OR IGNORE INTO temp.short_search_matches (query_key, media_id)
        SELECT @queryKey, media_id
        FROM media_search_fts
        WHERE search_text LIKE @needle
      `
      ).run({ queryKey, needle: `%${needle}%` });
    }

    shortSearchMatchCache.delete(queryKey);
    shortSearchMatchCache.set(queryKey, now + SHORT_SEARCH_CACHE_TTL_MS);
    while (shortSearchMatchCache.size > MAX_SHORT_SEARCH_CACHE_ENTRIES) {
      const oldestKey = shortSearchMatchCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      shortSearchMatchCache.delete(oldestKey);
      db.prepare("DELETE FROM temp.short_search_matches WHERE query_key = ?").run(oldestKey);
    }
    return queryKey;
  }

  function buildMediaSearchPredicate(
    query: string,
    params: Record<string, string | number>,
    paramPrefix = "search"
  ): string {
    const needle = query.trim();
    const compactNeedle = normalizeSearchNeedle(needle);
    const candidates = [...new Set([needle, compactNeedle].filter(Boolean))];
    const ftsCandidates = candidates.filter((candidate) => [...candidate].length >= 3);

    if (ftsCandidates.length > 0) {
      const paramName = `${paramPrefix}Match`;
      params[paramName] = ftsCandidates.map(quoteFtsPhrase).join(" OR ");
      return `media_files.id IN (
        SELECT media_id FROM media_search_fts
        WHERE media_search_fts MATCH @${paramName}
      )`;
    }

    const paramName = `${paramPrefix}ShortCacheKey`;
    params[paramName] = materializeShortSearchMatches(needle);
    return `media_files.id IN (
      SELECT media_id FROM temp.short_search_matches
      WHERE query_key = @${paramName}
    )`;
  }

  function addMetadataFacetFilter(
    clauses: string[],
    params: Record<string, string | number>,
    paramPrefix: string,
    facetType: string,
    values: string[]
  ): void {
    if (values.length === 0) return;
    const facetTypeParam = `${paramPrefix}FacetType`;
    const placeholders = values.map((value, index) => {
      const facetValueParam = `${paramPrefix}FacetValue${index}`;
      params[facetValueParam] = value;
      return `@${facetValueParam}`;
    });

    clauses.push(`EXISTS (
      SELECT 1 FROM media_metadata_facets ${paramPrefix}_facet
      WHERE ${paramPrefix}_facet.normalized_code = media_files.normalized_code
        AND ${paramPrefix}_facet.facet_type = @${facetTypeParam}
        AND ${paramPrefix}_facet.facet_value IN (${placeholders.join(", ")})
    )`);
    params[facetTypeParam] = facetType;
  }

  function buildMediaWhere(query: z.infer<typeof mediaQuerySchema>, favoriteKeys: Set<string>) {
    const clauses: string[] = [];
    const params: Record<string, string | number> = {};

    if (query.q) clauses.push(buildMediaSearchPredicate(query.q, params));
    if (query.letter && query.letter !== "ALL") {
      clauses.push("media_files.first_letter = @letter");
      params.letter = query.letter.toUpperCase();
    }
    if (query.extension && query.extension !== "ALL") {
      clauses.push("media_files.extension = @extension");
      params.extension = query.extension.toLowerCase();
    }
    if (query.prefix && query.prefix !== "ALL") {
      clauses.push("media_files.code_prefix = @prefix");
      params.prefix = query.prefix.toUpperCase();
    }
    if (query.category && query.category !== "ALL") {
      clauses.push("media_files.library_category = @category");
      params.category = query.category.toUpperCase();
    }
    if (query.bucket && query.bucket !== "ALL") {
      clauses.push("media_files.collection_bucket = @bucket");
      params.bucket = query.bucket.toUpperCase();
    }
    if (query.source && query.source !== "ALL") {
      clauses.push("media_files.source_name = @source");
      params.source = query.source;
    }
    if (query.tag && query.tag !== "ALL") {
      clauses.push(`EXISTS (
        SELECT 1 FROM media_variant_tags
        WHERE media_variant_tags.media_id = media_files.id
          AND media_variant_tags.tag = @tag
      )`);
      params.tag = query.tag.toUpperCase();
    }

    addMetadataFacetFilter(clauses, params, "actor", "actor", query.actor);
    addMetadataFacetFilter(clauses, params, "genre", "genre", query.genre);
    addMetadataFacetFilter(clauses, params, "director", "director", query.director);
    addMetadataFacetFilter(clauses, params, "maker", "maker", query.maker);
    addMetadataFacetFilter(clauses, params, "label", "label", query.label);
    addMetadataFacetFilter(clauses, params, "series", "series", query.metadataSeries);

    if (query.mediaType) {
      clauses.push("media_files.media_type = @mediaType");
      params.mediaType = query.mediaType;
    }
    if (query.favoriteOnly) {
      const keys = [...favoriteKeys];
      if (keys.length === 0) {
        clauses.push("0 = 1");
      } else {
        const placeholders = keys.map((key, index) => {
          const paramName = `favorite${index}`;
          params[paramName] = key;
          return `@${paramName}`;
        });
        clauses.push(`media_files.relative_path IN (${placeholders.join(", ")})`);
      }
    }
    if (query.playbackState === "history") {
      clauses.push("EXISTS (SELECT 1 FROM playback_progress personal_history WHERE personal_history.relative_path = media_files.relative_path AND personal_history.position_seconds > 0)");
    } else if (query.playbackState === "inProgress") {
      clauses.push("EXISTS (SELECT 1 FROM playback_progress personal_history WHERE personal_history.relative_path = media_files.relative_path AND personal_history.position_seconds > 0 AND personal_history.completed = 0)");
    } else if (query.playbackState === "completed") {
      clauses.push("EXISTS (SELECT 1 FROM playback_progress personal_history WHERE personal_history.relative_path = media_files.relative_path AND personal_history.completed = 1)");
    }

    return { whereSql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

  function buildMediaResponse(query: z.infer<typeof mediaQuerySchema>) {
    const favoriteKeys = readFavoriteKeys();
    const { whereSql, params } = buildMediaWhere(query, favoriteKeys);
    const offset = (query.page - 1) * query.pageSize;
    const cursor = query.pagination === "cursor" ? decodeMediaCursor(query.cursor, query) : null;
    const randomPivot = randomPivotFromSeed(query.randomSeed ?? 0);
    if (query.sort === "random") {
      params.randomPivot = randomPivot;
    }
    const orderBy = query.sort === "random"
      ? "CASE WHEN media_files.random_key >= @randomPivot THEN 0 ELSE 1 END, media_files.random_key"
      : sortMap[query.sort];
    const direction = query.direction.toUpperCase();
    const orderedBy = query.sort === "random"
      ? `${orderBy}, media_files.id ASC`
      : `${orderBy} ${direction}, media_files.name ASC, media_files.id ASC`;
    const cursorPredicate = cursor ? buildCursorPredicate(query, cursor, params) : "";
    const logicalKeySql = `CASE
      WHEN media_files.normalized_code != '' THEN media_files.library_category || ':' || media_files.normalized_code
      ELSE media_files.id
    END`;
    const count = query.pagination === "cursor" && cursor
      ? { count: -1 }
      : query.groupVersions
      ? (db.prepare(`
          SELECT COUNT(*) AS count FROM (
            SELECT ${logicalKeySql} AS logicalKey
            FROM media_files ${whereSql}
            GROUP BY logicalKey
          )
        `).get(params) as { count: number })
      : (db.prepare(`SELECT COUNT(*) AS count FROM media_files ${whereSql}`).get(params) as { count: number });

    const queryLimit = query.pagination === "cursor" ? query.pageSize + 1 : query.pageSize;
    const rawItemsWithSentinel = query.groupVersions
      ? (db.prepare(`
          WITH ranked_media AS (
            SELECT media_files.id,
              COUNT(*) OVER (PARTITION BY ${logicalKeySql}) AS versionCount,
              ROW_NUMBER() OVER (
                PARTITION BY ${logicalKeySql}
                ORDER BY
                  CASE WHEN media_files.thumbnail_status = 'ready' THEN 0 ELSE 1 END,
                  CASE media_files.compatibility_status WHEN 'native' THEN 0 WHEN 'remux' THEN 1 ELSE 2 END,
                  media_files.size DESC,
                  media_files.mtime_ms DESC,
                  media_files.id ASC
              ) AS logicalRank
            FROM media_files ${whereSql}
          )
          SELECT ${MEDIA_LIST_SELECT}, ranked_media.versionCount
          FROM ranked_media
          JOIN media_files ON media_files.id = ranked_media.id
          ${MEDIA_LIST_JOINS}
          WHERE ranked_media.logicalRank = 1
          ${cursorPredicate ? `AND ${cursorPredicate}` : ""}
          ORDER BY ${orderedBy}
          LIMIT @limit OFFSET @offset
        `).all({ ...params, limit: queryLimit, offset: query.pagination === "cursor" ? 0 : offset }) as MediaListRow[])
      : (db.prepare(`
          SELECT ${MEDIA_LIST_SELECT}, 1 AS versionCount
          FROM media_files
          ${MEDIA_LIST_JOINS}
          ${cursorPredicate ? withAdditionalWhere(whereSql, cursorPredicate) : whereSql}
          ORDER BY ${orderedBy}
          LIMIT @limit OFFSET @offset
        `).all({ ...params, limit: queryLimit, offset: query.pagination === "cursor" ? 0 : offset }) as MediaListRow[]);

    const hasMore = query.pagination === "cursor" && rawItemsWithSentinel.length > query.pageSize;
    const rawItems = hasMore ? rawItemsWithSentinel.slice(0, query.pageSize) : rawItemsWithSentinel;
    const nextCursor = hasMore && rawItems.length > 0
      ? createMediaCursor(query, rawItems[rawItems.length - 1], randomPivot)
      : null;

    return {
      items: hydrateMediaRows(rawItems, favoriteKeys, { compact: true }),
      page: query.page,
      pageSize: query.pageSize,
      total: count.count,
      totalPages: count.count < 0 ? -1 : Math.ceil(count.count / query.pageSize),
      nextCursor
    };
  }

  function warmCoverCacheForMediaItems(items: Array<{ metadata: unknown }>): void {
    const urls = items
      .flatMap((item) => {
        const metadata = item.metadata as { coverUrl?: unknown; thumbUrl?: unknown } | null | undefined;
        return [metadata?.coverUrl, metadata?.thumbUrl]
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
      })
      .filter((url, index, list) => list.indexOf(url) === index)
      .slice(0, 12);

    for (const url of urls) {
      if (getCachedCover(url)) continue;
      ensureCachedCover(url).catch(() => undefined);
    }
  }

  function buildTagFacets(whereSql = "", params: Record<string, string | number> = {}) {
    return db.prepare(`
      SELECT media_variant_tags.tag AS value, COUNT(*) AS count
      FROM media_files
      JOIN media_variant_tags ON media_variant_tags.media_id = media_files.id
      ${whereSql}
      GROUP BY media_variant_tags.tag
      ORDER BY count DESC, media_variant_tags.tag COLLATE NOCASE ASC
      LIMIT 40
    `).all(params) as Array<{ value: string; count: number }>;
  }

  function getMetadataFacetLocalizations(): Record<MetadataFacetType, Map<string, string>> {
    if (metadataFacetLocalizationCache && metadataFacetLocalizationCache.expiresAt > Date.now()) {
      return metadataFacetLocalizationCache.values;
    }

    const values: Record<MetadataFacetType, Map<string, string>> = {
      actor: new Map(), genre: new Map(), director: new Map(), maker: new Map(), label: new Map(), series: new Map()
    };
    const rows = db.prepare(`
      SELECT actors_json AS actorsJson, genres_json AS genresJson, director, maker, label, series,
        actors_zh_json AS actorsZhJson, genres_zh_json AS genresZhJson,
        director_zh AS directorZh, maker_zh AS makerZh, label_zh AS labelZh, series_zh AS seriesZh
      FROM media_metadata
      WHERE status = 'ready' AND translation_status = 'ready'
    `).all() as Array<{
      actorsJson: string | null; genresJson: string | null; director: string; maker: string; label: string;
      series: string; actorsZhJson: string | null; genresZhJson: string | null; directorZh: string;
      makerZh: string; labelZh: string; seriesZh: string;
    }>;

    function addValue(type: MetadataFacetType, value: string | undefined, valueZh: string | undefined): void {
      const normalizedValue = value?.trim().replace(/\s+/g, " ") ?? "";
      const translatedValueZh = valueZh?.trim().replace(/\s+/g, " ") ?? "";
      const normalizedValueZh = type === "actor"
        ? getLocalizedActorDisplayName(normalizedValue, translatedValueZh)
        : translatedValueZh;
      if (type === "genre" && (isHiddenMetadataGenre(normalizedValue) || isHiddenMetadataGenre(normalizedValueZh))) return;
      if (["director", "maker", "label", "series"].includes(type) && /[ぁ-ゖァ-ヺ]/u.test(normalizedValue)
        && (!/[\u3400-\u9fff]/u.test(normalizedValueZh) || /[ぁ-ゖァ-ヺ]/u.test(normalizedValueZh))) return;
      if (!normalizedValue || !normalizedValueZh || values[type].has(normalizedValue)) return;
      values[type].set(normalizedValue, normalizedValueZh);
    }

    for (const row of rows) {
      const actors = parseJsonStringArray(row.actorsJson);
      const actorsZh = parseJsonStringArray(row.actorsZhJson);
      const genres = parseJsonStringArray(row.genresJson);
      const genresZh = parseJsonStringArray(row.genresZhJson);
      actors.forEach((actor, index) => addValue("actor", actor, actorsZh[index]));
      genres.forEach((genre, index) => addValue("genre", genre, genresZh[index]));
      addValue("director", row.director, row.directorZh);
      addValue("maker", row.maker, row.makerZh);
      addValue("label", row.label, row.labelZh);
      addValue("series", row.series, row.seriesZh);
    }

    metadataFacetLocalizationCache = { expiresAt: Date.now() + FACET_LOCALIZATION_CACHE_TTL_MS, values };
    return values;
  }

  function buildMetadataFacetGroups(
    whereSql = "",
    params: Record<string, string | number> = {}
  ): Record<MetadataFacetType, Array<{ value: string; valueZh: string; count: number; mediaId?: string; imageUrl?: string }>> {
    const rows = db.prepare(`
      SELECT media_metadata_facets.facet_type AS facetType,
        media_metadata_facets.facet_value AS value,
        COUNT(DISTINCT media_files.id) AS count,
        COALESCE(
          MAX(NULLIF(topic_covers.media_id, '')),
          MIN(CASE WHEN media_files.thumbnail_status = 'ready' THEN media_files.id END),
          MIN(media_files.id)
        ) AS mediaId,
        MAX(NULLIF(entity_profiles.image_url, '')) AS imageUrl
      FROM media_files
      JOIN media_metadata_facets ON media_metadata_facets.normalized_code = media_files.normalized_code
      LEFT JOIN topic_covers
        ON topic_covers.facet_type = media_metadata_facets.facet_type
        AND topic_covers.facet_value = media_metadata_facets.facet_value
      LEFT JOIN entity_profiles
        ON entity_profiles.facet_type = media_metadata_facets.facet_type
        AND entity_profiles.facet_value = media_metadata_facets.facet_value
      ${withAdditionalWhere(whereSql, "media_metadata_facets.facet_type IN ('actor', 'genre', 'director', 'maker', 'label', 'series')")}
      GROUP BY media_metadata_facets.facet_type, media_metadata_facets.facet_value
      ORDER BY facetType, count DESC, value COLLATE NOCASE ASC
    `).all(params) as Array<{ facetType: MetadataFacetType; value: string; count: number; mediaId: string | null; imageUrl: string | null }>;
    const localizations = getMetadataFacetLocalizations();
    const groups: Record<MetadataFacetType, Array<{ value: string; valueZh: string; count: number }>> = {
      actor: [], genre: [], director: [], maker: [], label: [], series: []
    };
    for (const row of rows) {
      const valueZh = localizations[row.facetType].get(row.value) ?? "";
      if (row.facetType === "genre" && (isHiddenMetadataGenre(row.value) || isHiddenMetadataGenre(valueZh))) continue;
      groups[row.facetType].push({
        value: row.value,
        count: row.count,
        valueZh,
        ...(row.mediaId ? { mediaId: row.mediaId } : {}),
        ...(row.imageUrl ? { imageUrl: row.imageUrl } : {})
      });
    }
    return groups;
  }

  function buildFacetResponse(query: z.infer<typeof facetQuerySchema>) {
    const favoriteKeys = query.favoriteOnly ? readFavoriteKeys() : new Set<string>();
    const asMediaQuery = (overrides: Partial<z.infer<typeof mediaQuerySchema>> = {}) => ({
      ...query,
      ...overrides,
      page: 1,
      pageSize: 48,
      sort: "name" as const,
      direction: "asc" as const,
      groupVersions: true,
      pagination: "offset" as const
    });
    const { whereSql, params } = buildMediaWhere(asMediaQuery(), favoriteKeys);
    const facets = (select: string) => db.prepare(select).all(params);
    const metadataFacets = buildMetadataFacetGroups(whereSql, params);
    const disjunctiveMetadataFacet = (
      queryKey: "actor" | "genre" | "director" | "maker" | "label" | "metadataSeries",
      facetType: MetadataFacetType
    ) => {
      if (query[queryKey].length === 0) return metadataFacets[facetType];

      // Multi-select values within one dimension are OR-ed. Build that dimension's
      // choices without its current selections, while retaining every other filter.
      const ownDimensionCleared = buildMediaWhere(asMediaQuery({ [queryKey]: [] }), favoriteKeys);
      return buildMetadataFacetGroups(
        ownDimensionCleared.whereSql,
        ownDimensionCleared.params
      )[facetType];
    };
    return {
      letters: facets(`SELECT first_letter AS value, COUNT(*) AS count FROM media_files ${whereSql} GROUP BY first_letter ORDER BY first_letter`),
      extensions: facets(`SELECT extension AS value, COUNT(*) AS count FROM media_files ${whereSql} GROUP BY extension ORDER BY extension`),
      mediaTypes: facets(`SELECT media_type AS value, COUNT(*) AS count FROM media_files ${whereSql} GROUP BY media_type ORDER BY media_type`),
      categories: db.prepare(`
        SELECT library_category AS value,
          COUNT(*) AS count,
          COALESCE(
            MIN(CASE WHEN thumbnail_status = 'ready' THEN id END),
            MIN(id)
          ) AS mediaId
        FROM media_files
        GROUP BY library_category
        ORDER BY library_category
      `).all(),
      sources: facets(`SELECT source_name AS value, COUNT(*) AS count FROM media_files ${whereSql} GROUP BY source_name ORDER BY source_name`),
      prefixes: facets(`
        SELECT media_files.code_prefix AS value,
          COUNT(*) AS count,
          COALESCE(
            MAX(NULLIF(topic_covers.media_id, '')),
            MIN(CASE WHEN media_files.thumbnail_status = 'ready' THEN media_files.id END),
            MIN(media_files.id)
          ) AS mediaId
        FROM media_files
        LEFT JOIN topic_covers
          ON topic_covers.facet_type = 'prefix'
          AND topic_covers.facet_value = media_files.code_prefix
        ${withAdditionalWhere(whereSql, "media_files.code_prefix != ''")}
        GROUP BY media_files.code_prefix
        ORDER BY count DESC, media_files.code_prefix
      `),
      buckets: facets(`SELECT collection_bucket AS value, COUNT(*) AS count FROM media_files ${whereSql} GROUP BY collection_bucket ORDER BY value`),
      quality: facets(`SELECT quality_tag AS value, COUNT(*) AS count FROM media_files ${withAdditionalWhere(whereSql, "quality_tag != ''")} GROUP BY quality_tag ORDER BY count DESC, quality_tag`),
      tags: buildTagFacets(whereSql, params),
      actors: disjunctiveMetadataFacet("actor", "actor"),
      genres: disjunctiveMetadataFacet("genre", "genre"),
      directors: disjunctiveMetadataFacet("director", "director"),
      makers: disjunctiveMetadataFacet("maker", "maker"),
      labels: disjunctiveMetadataFacet("label", "label"),
      metadataSeries: disjunctiveMetadataFacet("metadataSeries", "series"),
      totals: db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS totalSize FROM media_files").get(),
      scanning: options.isScanActive(),
      latestScan: options.getLatestScan()
    };
  }

  function buildSearchSuggestions(query: z.infer<typeof searchSuggestionsQuerySchema>) {
    const compactQuery = normalizeSearchNeedle(query.q);
    const hasQuery = query.q.length > 0;
    const params: Record<string, string | number> = {
      q: `%${query.q}%`, startsWith: `${query.q}%`, compactStartsWith: `${compactQuery}%`, limit: query.limit
    };
    const codeWhere = hasQuery ? `AND ${buildMediaSearchPredicate(query.q, params, "suggestion")}` : "";
    const compactOrder = compactQuery
      ? "WHEN (media_files.code_prefix || media_files.code_number) LIKE @compactStartsWith THEN 1"
      : "";
    const codeRows = db.prepare(`
      SELECT media_files.normalized_code AS value,
        MAX(NULLIF(media_metadata.title, '')) AS title,
        MAX(NULLIF(media_metadata.maker, '')) AS maker,
        COUNT(*) AS count, MIN(media_files.id) AS mediaId
      FROM media_files
      LEFT JOIN media_metadata ON media_metadata.normalized_code = media_files.normalized_code
      WHERE media_files.normalized_code != '' ${codeWhere}
      GROUP BY media_files.normalized_code
      ORDER BY CASE
        WHEN media_files.normalized_code LIKE @startsWith THEN 0
        ${compactOrder}
        ELSE 2 END,
        count DESC, media_files.normalized_code ASC
      LIMIT @limit
    `).all(params) as Array<{ value: string; title: string | null; maker: string | null; count: number; mediaId: string | null }>;

    function buildFacetRows(facetType: "actor" | "genre" | "maker") {
      const facetWhere = hasQuery ? "AND media_metadata_facets.facet_value LIKE @q" : "";
      return db.prepare(`
        SELECT media_metadata_facets.facet_value AS value,
          COUNT(DISTINCT media_files.id) AS count,
          MIN(media_files.id) AS mediaId,
          MAX(NULLIF(media_metadata.title, '')) AS sampleTitle
        FROM media_metadata_facets
        JOIN media_files ON media_files.normalized_code = media_metadata_facets.normalized_code
        LEFT JOIN media_metadata ON media_metadata.normalized_code = media_files.normalized_code
        WHERE media_metadata_facets.facet_type = @facetType ${facetWhere}
        GROUP BY media_metadata_facets.facet_value
        ORDER BY CASE WHEN media_metadata_facets.facet_value LIKE @startsWith THEN 0 ELSE 1 END,
          count DESC, media_metadata_facets.facet_value COLLATE NOCASE ASC
        LIMIT @limit
      `).all({ ...params, facetType }) as Array<{
        value: string; count: number; mediaId: string | null; sampleTitle: string | null
      }>;
    }

    const mapCode = (row: typeof codeRows[number]) => ({
      type: "code", value: row.value, label: row.value,
      subtitle: [row.title, row.maker].filter(Boolean).join(" · "), count: row.count, mediaId: row.mediaId
    });
    const mapFacet = (type: "actor" | "maker" | "genre") =>
      (row: ReturnType<typeof buildFacetRows>[number]) => ({
        type, value: row.value, label: row.value, subtitle: row.sampleTitle ?? "", count: row.count, mediaId: row.mediaId
      });
    return {
      codes: codeRows.map(mapCode),
      actors: buildFacetRows("actor").map(mapFacet("actor")),
      makers: buildFacetRows("maker").map(mapFacet("maker")),
      genres: buildFacetRows("genre").filter((row) => !isHiddenMetadataGenre(row.value)).map(mapFacet("genre"))
    };
  }

  function getSuggestions(rawQuery: unknown): CachedResponse {
    const query = searchSuggestionsQuerySchema.parse(rawQuery);
    const cacheKey = JSON.stringify({ q: query.q.toLocaleLowerCase(), limit: query.limit });
    const cached = readCachedJson(searchSuggestionResponseCache, cacheKey);
    if (cached) return { body: cached, cacheStatus: "HIT" };
    const body = buildSearchSuggestions(query);
    writeCachedJson(searchSuggestionResponseCache, cacheKey, body, SEARCH_SUGGESTION_CACHE_TTL_MS, MAX_SEARCH_SUGGESTION_CACHE_ENTRIES);
    return { body, cacheStatus: "MISS" };
  }

  function getMedia(rawQuery: unknown): CachedResponse {
    const query = mediaQuerySchema.parse(rawQuery);
    const canUseCache = !options.isScanActive() && !query.favoriteOnly && !query.playbackState
      && query.sort !== "random" && query.page <= 3 && !query.cursor;
    const cacheKey = canUseCache ? getMediaCacheKey(query) : null;
    const cached = cacheKey ? readCachedJson(mediaResponseCache, cacheKey) : null;
    if (cached) return { body: cached, cacheStatus: "HIT" };
    const body = buildMediaResponse(query);
    if (cacheKey) writeCachedJson(mediaResponseCache, cacheKey, body, MEDIA_CACHE_TTL_MS, MAX_MEDIA_CACHE_ENTRIES);
    warmCoverCacheForMediaItems(body.items);
    return { body, cacheStatus: cacheKey ? "MISS" : "BYPASS" };
  }

  function getFacets(rawQuery: unknown): CachedResponse {
    const query = facetQuerySchema.parse(rawQuery);
    const cacheKey = options.isScanActive() ? null : getFacetCacheKey(query);
    const cached = cacheKey ? readCachedJson(facetResponseCache, cacheKey) : null;
    if (cached) return { body: cached, cacheStatus: "HIT" };
    const body = buildFacetResponse(query);
    if (cacheKey) writeCachedJson(facetResponseCache, cacheKey, body, FACET_CACHE_TTL_MS, MAX_FACET_CACHE_ENTRIES);
    return { body, cacheStatus: cacheKey ? "MISS" : "BYPASS" };
  }

  function warmFacets(rawQuery: unknown): void {
    const query = facetQuerySchema.parse(rawQuery);
    writeCachedJson(facetResponseCache, getFacetCacheKey(query), buildFacetResponse(query), FACET_CACHE_TTL_MS, MAX_FACET_CACHE_ENTRIES);
  }

  function warmMedia(rawQuery: unknown): void {
    const query = mediaQuerySchema.parse(rawQuery);
    const body = buildMediaResponse(query);
    warmCoverCacheForMediaItems(body.items);
    writeCachedJson(mediaResponseCache, getMediaCacheKey(query), body, MEDIA_CACHE_TTL_MS, MAX_MEDIA_CACHE_ENTRIES);
  }

  function getWarmupCategories(): string[] {
    const rows = db.prepare("SELECT library_category AS value FROM media_files GROUP BY library_category ORDER BY library_category")
      .all() as Array<{ value: string }>;
    const seen = new Set<string>();
    return ["ALL", "JAV", "FC2", ...rows.map((row) => row.value.toUpperCase())]
      .filter((category) => {
        if (seen.has(category)) return false;
        seen.add(category);
        return true;
      })
      .slice(0, 6);
  }

  function getWarmupSearchQueries(): Array<Record<string, unknown>> {
    const prefixRows = db.prepare(`
      SELECT code_prefix AS value, COUNT(*) AS count FROM media_files
      WHERE code_prefix != '' GROUP BY code_prefix
      ORDER BY count DESC, code_prefix ASC LIMIT @limit
    `).all({ limit: CACHE_WARMUP_SEARCH_LIMIT }) as Array<{ value: string }>;
    const actorRows = db.prepare(`
      SELECT media_metadata_facets.facet_value AS value, COUNT(DISTINCT media_files.id) AS count
      FROM media_metadata_facets
      JOIN media_files ON media_files.normalized_code = media_metadata_facets.normalized_code
      WHERE media_metadata_facets.facet_type = 'actor'
      GROUP BY media_metadata_facets.facet_value
      ORDER BY count DESC, media_metadata_facets.facet_value COLLATE NOCASE ASC
      LIMIT @limit
    `).all({ limit: CACHE_WARMUP_SEARCH_LIMIT }) as Array<{ value: string }>;
    return [
      ...prefixRows.map((row) => ({ prefix: row.value })),
      ...actorRows.map((row) => ({ actor: [row.value] }))
    ];
  }

  return {
    clearCaches,
    clearPlaybackCaches,
    getSuggestions,
    getMedia,
    getFacets,
    warmFacets,
    warmMedia,
    getWarmupCategories,
    getWarmupSearchQueries,
    getCacheStats: () => ({
      mediaEntries: mediaResponseCache.size,
      facetEntries: facetResponseCache.size,
      searchSuggestionEntries: searchSuggestionResponseCache.size
    })
  };
}
