import fs from "node:fs";
import type { Response } from "express";
import { z } from "zod";
import { ensureCachedCover, getCachedCover } from "./covers.js";
import { db } from "./db.js";
import { readFavoriteKeys } from "./favorites.js";
import { getMediaDerivative, requestPosterVariant, type PosterVariant } from "./mediaDerivatives.js";
import {
  MEDIA_LIST_JOINS,
  MEDIA_LIST_SELECT,
  getMediaRowById,
  hydrateMediaRows,
  type MediaListRow,
  type MediaPosterRow
} from "./queries/mediaListQueries.js";
import { ensureInsideMediaRoot, pipeFileStream } from "./services/fileStreaming.js";
import { ensureThumbnail } from "./thumbnails.js";
import type { CachedResponse } from "./searchDomain.js";
import { recommendationFeedbackSchema } from "./contracts/platform.js";

const RECOMMENDATION_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_RECOMMENDATION_CACHE_ENTRIES = 96;

type JsonCacheEntry = {
  expiresAt: number;
  value: unknown;
};

const recommendationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(4).max(24).default(12),
  sort: z.enum(["relevance", "recent", "name", "random"]).default("relevance"),
  mode: z.enum(["mixed", "actor", "series", "genre"]).default("mixed"),
  randomSeed: z.coerce.number().int().optional()
});

export type MediaDomain = ReturnType<typeof createMediaDomain>;

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

function writeCachedJson(cache: Map<string, JsonCacheEntry>, key: string, value: unknown): void {
  const now = Date.now();
  for (const [cacheKey, entry] of cache.entries()) {
    if (entry.expiresAt <= now) cache.delete(cacheKey);
  }
  cache.delete(key);
  cache.set(key, { expiresAt: now + RECOMMENDATION_CACHE_TTL_MS, value });
  while (cache.size > MAX_RECOMMENDATION_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

function buildFacetPairSql(
  alias: string,
  facets: Array<{ facet_type: string; facet_value: string }>
): string {
  return facets
    .map(
      (_facet, index) =>
        `(${alias}.facet_type = @recommendFacetType${index} AND ${alias}.facet_value = @recommendFacetValue${index})`
    )
    .join(" OR ");
}

type RecommendationFacet = {
  facet_type: string;
  facet_value: string;
};

const recommendationFacetLabels: Record<string, string> = {
  series: "同系列",
  actor: "同演员",
  genre: "相似标签",
  director: "同导演",
  maker: "同厂商",
  label: "同厂牌"
};

function recommendationReason(
  sourceFacets: RecommendationFacet[],
  candidateFacets: RecommendationFacet[],
  samePrefix: boolean
): string {
  const sourceKeys = new Set(sourceFacets.map((facet) => `${facet.facet_type}\u0000${facet.facet_value}`));
  const priority = ["series", "actor", "genre", "director", "maker", "label"];
  for (const type of priority) {
    const match = candidateFacets.find((facet) =>
      facet.facet_type === type && sourceKeys.has(`${facet.facet_type}\u0000${facet.facet_value}`)
    );
    if (match) return `${recommendationFacetLabels[type] ?? "内容相似"} · ${match.facet_value}`;
  }
  return samePrefix ? "相同番号系列" : "同分类精选";
}

function sharedRecommendationFacets(
  sourceFacets: RecommendationFacet[],
  candidateFacets: RecommendationFacet[]
): RecommendationFacet[] {
  const sourceKeys = new Set(sourceFacets.map((facet) => `${facet.facet_type}\u0000${facet.facet_value}`));
  return candidateFacets.filter((facet) => sourceKeys.has(`${facet.facet_type}\u0000${facet.facet_value}`));
}

function servePlainFile(filePath: string, mimeType: string, res: Response): void {
  const stat = fs.statSync(filePath);
  res.setHeader("Content-Type", mimeType);
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Cache-Control", "private, max-age=86400");
  pipeFileStream(fs.createReadStream(filePath), res);
}

async function resolveCachedPoster(coverUrl: string | null | undefined, thumbUrl: string | null | undefined) {
  const urls = [coverUrl, thumbUrl]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .filter((url, index, list) => list.indexOf(url) === index);
  for (const url of urls) {
    const cached = getCachedCover(url);
    if (cached) return cached;
  }
  return null;
}

async function ensureCachedPoster(coverUrl: string | null | undefined, thumbUrl: string | null | undefined) {
  const cached = await resolveCachedPoster(coverUrl, thumbUrl);
  if (cached) return cached;

  const urls = [coverUrl, thumbUrl]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .filter((url, index, list) => list.indexOf(url) === index);
  if (urls.length === 0) return null;

  return new Promise<Awaited<ReturnType<typeof ensureCachedCover>>>((resolve) => {
    let pending = urls.length;
    let settled = false;
    for (const url of urls) {
      ensureCachedCover(url).then((cover) => {
        pending -= 1;
        if (cover && !settled) {
          settled = true;
          resolve(cover);
          return;
        }
        if (pending === 0 && !settled) resolve(null);
      });
    }
  });
}

function sendPlaceholderImage(svg: string, res: Response): void {
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.send(svg);
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

export function createMediaDomain() {
  const recommendationResponseCache = new Map<string, JsonCacheEntry>();

  function buildRecommendations(
    id: string,
    limit: number,
    sort: z.infer<typeof recommendationsQuerySchema>["sort"],
    mode: z.infer<typeof recommendationsQuerySchema>["mode"],
    randomSeed = 0
  ) {
    const row = getMediaRowById(id);
    if (!row) return null;

    const favoriteKeys = readFavoriteKeys();
    const params: Record<string, string | number> = {
      recommendId: row.id,
      recommendMediaType: row.media_type,
      recommendCategory: row.library_category,
      recommendPrefix: row.code_prefix,
      recommendCode: row.normalized_code,
      randomPivot: Math.abs(Math.trunc(randomSeed)) % 9_007_199_254_740_991,
      limit
    };
    const facets = db.prepare(`
      SELECT facet_type, facet_value
      FROM media_metadata_facets
      WHERE normalized_code = ?
        AND facet_type IN ('actor', 'genre', 'director', 'maker', 'label', 'series')
      ORDER BY CASE facet_type
        WHEN 'series' THEN 0
        WHEN 'genre' THEN 1
        WHEN 'actor' THEN 2
        WHEN 'director' THEN 3
        WHEN 'maker' THEN 4
        WHEN 'label' THEN 5
        ELSE 5 END,
        facet_value
    `).all(row.normalized_code) as Array<{ facet_type: string; facet_value: string }>;
    const relevantFacets = mode === "mixed"
      ? facets
      : facets.filter((facet) => facet.facet_type === mode);
    if (mode !== "mixed" && relevantFacets.length === 0) return { items: [] };
    relevantFacets.forEach((facet, index) => {
      params[`recommendFacetType${index}`] = facet.facet_type;
      params[`recommendFacetValue${index}`] = facet.facet_value;
    });

    const matchClauses: string[] = [];
    const scoreParts: string[] = [];
    if (mode === "mixed" && row.code_prefix) {
      matchClauses.push("media_files.code_prefix = @recommendPrefix");
      scoreParts.push("CASE WHEN media_files.code_prefix = @recommendPrefix THEN 2 ELSE 0 END");
    }
    if (relevantFacets.length > 0) {
      const matchFacetSql = buildFacetPairSql("match_facet", relevantFacets);
      const scoreFacetSql = buildFacetPairSql("score_facet", relevantFacets);
      matchClauses.push(`EXISTS (
        SELECT 1 FROM media_metadata_facets match_facet
        WHERE match_facet.normalized_code = media_files.normalized_code
          AND (${matchFacetSql})
      )`);
      scoreParts.push(`COALESCE((
        SELECT SUM(CASE score_facet.facet_type
          WHEN 'series' THEN 18
          WHEN 'actor' THEN 10
          WHEN 'director' THEN 6
          WHEN 'maker' THEN 4
          WHEN 'label' THEN 4
          WHEN 'genre' THEN 3
          ELSE 0 END) + COUNT(DISTINCT score_facet.facet_type) * 2
        FROM media_metadata_facets score_facet
        WHERE score_facet.normalized_code = media_files.normalized_code
          AND (${scoreFacetSql})
      ), 0)`);
    }

    const scoreSql = scoreParts.length > 0 ? scoreParts.join(" + ") : "0";
    const similaritySql = matchClauses.length > 0 ? matchClauses.join(" OR ") : "1 = 1";
    const orderBySql = sort === "random"
      ? "CASE WHEN media_files.random_key >= @randomPivot THEN 0 ELSE 1 END, media_files.random_key, media_files.id"
      : sort === "recent"
        ? "COALESCE(media_metadata.release_date, '') DESC, media_files.mtime_ms DESC, media_files.name ASC"
        : sort === "name"
          ? "media_files.name COLLATE NOCASE ASC"
          : `ranked_candidates.recommendationScore DESC,
        COALESCE(playback_progress.last_played_at, '') DESC,
        media_files.mtime_ms DESC,
        media_files.name ASC`;
    const candidateLimit = Math.min(Math.max(limit * 12, 72), 360);
    params.limit = candidateLimit;
    const rawItems = db.prepare(`
      WITH ranked_candidates AS (
        SELECT media_files.id AS candidateId,
          (${scoreSql}) AS recommendationScore,
          ROW_NUMBER() OVER (
            PARTITION BY CASE
              WHEN media_files.normalized_code != '' THEN media_files.normalized_code
              ELSE media_files.id
            END
            ORDER BY
              CASE WHEN media_files.thumbnail_status = 'ready' THEN 0 ELSE 1 END,
              CASE WHEN media_files.duration_seconds IS NOT NULL THEN 0 ELSE 1 END,
              media_files.size DESC,
              media_files.mtime_ms DESC,
              media_files.id ASC
          ) AS logicalRank
        FROM media_files
        WHERE media_files.id != @recommendId
          AND media_files.media_type = @recommendMediaType
          AND media_files.library_category = @recommendCategory
          AND (@recommendCode = '' OR media_files.normalized_code != @recommendCode)
          AND (${similaritySql})
      )
      SELECT ${MEDIA_LIST_SELECT}, 1 AS versionCount
      FROM ranked_candidates
      JOIN media_files ON media_files.id = ranked_candidates.candidateId
      ${MEDIA_LIST_JOINS}
      WHERE ranked_candidates.logicalRank = 1
        AND NOT EXISTS (
          SELECT 1 FROM playback_progress watched
          WHERE watched.media_id = media_files.id
             OR watched.relative_path = media_files.relative_path
        )
        AND NOT EXISTS (
          SELECT 1 FROM recommendation_feedback feedback
          WHERE feedback.anchor_media_id = @recommendId
            AND feedback.media_id = media_files.id
            AND feedback.feedback_type = 'not_interested'
        )
      ORDER BY ${orderBySql}
      LIMIT @limit
    `).all(params) as MediaListRow[];

    const hydrated = hydrateMediaRows(rawItems, favoriteKeys, { compact: true });
    const codes = [...new Set(
      hydrated
        .map((item) => String(item.normalizedCode ?? ""))
        .filter((code) => code.length > 0)
    )];
    const facetsByCode = new Map<string, RecommendationFacet[]>();
    if (codes.length > 0) {
      const placeholders = codes.map(() => "?").join(", ");
      const candidateFacets = db.prepare(`
        SELECT normalized_code, facet_type, facet_value
        FROM media_metadata_facets
        WHERE normalized_code IN (${placeholders})
          AND facet_type IN ('actor', 'genre', 'director', 'maker', 'label', 'series')
        ORDER BY normalized_code,
          CASE facet_type WHEN 'series' THEN 0 WHEN 'actor' THEN 1 WHEN 'genre' THEN 2 ELSE 3 END,
          facet_value
      `).all(...codes) as Array<RecommendationFacet & { normalized_code: string }>;
      for (const facet of candidateFacets) {
        const list = facetsByCode.get(facet.normalized_code) ?? [];
        list.push({ facet_type: facet.facet_type, facet_value: facet.facet_value });
        facetsByCode.set(facet.normalized_code, list);
      }
    }

    const skipped: typeof hydrated = [];
    const groupCounts = new Map<string, number>();
    const preferredReasons = new Map<string, RecommendationFacet>();
    const diversified: typeof hydrated = [];
    for (const item of hydrated) {
      const normalizedCode = String(item.normalizedCode ?? "");
      const candidateFacets = facetsByCode.get(normalizedCode) ?? [];
      const shared = sharedRecommendationFacets(facets, candidateFacets);
      const actor = shared.find((facet) => facet.facet_type === "actor");
      const series = shared.find((facet) => facet.facet_type === "series");
      const genre = shared
        .filter((facet) => facet.facet_type === "genre")
        .sort((left, right) => (groupCounts.get(`genre:${left.facet_value}`) ?? 0) - (groupCounts.get(`genre:${right.facet_value}`) ?? 0))[0];
      const actorKey = actor ? `actor:${actor.facet_value}` : "";
      const seriesKey = series ? `series:${series.facet_value}` : "";
      const genreKey = genre ? `genre:${genre.facet_value}` : "";
      const exceedsMixedCap = mode === "mixed" && (
        Boolean(actorKey && (groupCounts.get(actorKey) ?? 0) >= 4)
        || Boolean(seriesKey && (groupCounts.get(seriesKey) ?? 0) >= 3)
        || Boolean(genreKey && (groupCounts.get(genreKey) ?? 0) >= 3)
      );
      if (exceedsMixedCap) {
        skipped.push(item);
        continue;
      }
      for (const key of [actorKey, seriesKey, genreKey].filter(Boolean)) {
        groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1);
      }
      const preferredReason = series && (groupCounts.get(seriesKey) ?? 0) <= 3
        ? series
        : actor && (groupCounts.get(actorKey) ?? 0) <= 4
          ? actor
          : genre;
      if (preferredReason) preferredReasons.set(String(item.id), preferredReason);
      diversified.push(item);
      if (diversified.length >= limit) break;
    }
    if (mode !== "mixed" && diversified.length < limit) {
      diversified.push(...skipped.slice(0, limit - diversified.length));
    }
    const items = diversified.slice(0, limit).map((item) => ({
      ...item,
      recommendationReason: preferredReasons.has(String(item.id))
        ? `${recommendationFacetLabels[preferredReasons.get(String(item.id))?.facet_type ?? ""] ?? "内容相似"} · ${preferredReasons.get(String(item.id))?.facet_value}`
        : recommendationReason(
          facets,
          facetsByCode.get(String(item.normalizedCode ?? "")) ?? [],
          Boolean(row.code_prefix && item.codePrefix === row.code_prefix)
        )
    }));
    warmCoverCacheForMediaItems(items);
    return { items };
  }

  function getRecommendations(id: string, rawQuery: unknown): CachedResponse | null {
    const query = recommendationsQuerySchema.parse(rawQuery);
    const cacheKey = `${id}:${query.limit}:${query.sort}:${query.mode}:${query.randomSeed ?? 0}`;
    const cached = readCachedJson(recommendationResponseCache, cacheKey);
    if (cached) return { body: cached, cacheStatus: "HIT" };
    const body = buildRecommendations(id, query.limit, query.sort, query.mode, query.randomSeed);
    if (!body) return null;
    writeCachedJson(recommendationResponseCache, cacheKey, body);
    return { body, cacheStatus: "MISS" };
  }

  function setRecommendationFeedback(anchorMediaId: string, rawBody: unknown): {
    anchorMediaId: string;
    mediaId: string;
    feedbackType: "not_interested";
    createdAt: string;
  } | null {
    if (!getMediaRowById(anchorMediaId)) return null;
    const input = recommendationFeedbackSchema.parse(rawBody);
    if (!getMediaRowById(input.mediaId)) return null;
    const createdAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO recommendation_feedback (anchor_media_id, media_id, feedback_type, created_at)
      VALUES (@anchorMediaId, @mediaId, @feedbackType, @createdAt)
      ON CONFLICT(anchor_media_id, media_id, feedback_type)
      DO UPDATE SET created_at = excluded.created_at
    `).run({ anchorMediaId, ...input, createdAt });
    recommendationResponseCache.clear();
    return { anchorMediaId, ...input, createdAt };
  }

  function clearRecommendationFeedback(anchorMediaId: string, mediaId: string): boolean {
    const changed = db.prepare(`
      DELETE FROM recommendation_feedback
      WHERE anchor_media_id = ? AND media_id = ? AND feedback_type = 'not_interested'
    `).run(anchorMediaId, mediaId).changes > 0;
    if (changed) recommendationResponseCache.clear();
    return changed;
  }

  async function sendThumbnail(id: string, res: Response): Promise<boolean> {
    const row = getMediaRowById(id);
    if (!row) return false;
    ensureInsideMediaRoot(row.absolute_path);
    const thumbnail = await ensureThumbnail(row);
    if (thumbnail.kind === "placeholder") {
      sendPlaceholderImage(thumbnail.svg, res);
      return true;
    }
    servePlainFile(thumbnail.path, thumbnail.mimeType, res);
    return true;
  }

  async function sendPoster(id: string, rawSize: unknown, res: Response): Promise<boolean> {
    const row = db.prepare(`
      SELECT media_files.*,
        media_metadata.cover_url AS metadataCoverUrl,
        media_metadata.thumb_url AS metadataThumbUrl
      FROM media_files
      LEFT JOIN media_metadata ON media_metadata.normalized_code = media_files.normalized_code
      WHERE media_files.id = ?
    `).get(id) as MediaPosterRow | undefined;
    if (!row) return false;

    const posterVariant: PosterVariant = rawSize === "detail" ? "detail" : "card";
    const derivedPoster = getMediaDerivative(row.id, "poster", posterVariant);
    if (derivedPoster) {
      servePlainFile(derivedPoster.path, derivedPoster.mimeType, res);
      return true;
    }

    const cover = await ensureCachedPoster(row.metadataCoverUrl, row.metadataThumbUrl);
    if (cover) {
      requestPosterVariant(row, posterVariant, row.metadataCoverUrl ?? "", row.metadataThumbUrl ?? "");
      servePlainFile(cover.path, cover.mimeType, res);
      return true;
    }

    const refreshedRow = getMediaRowById(id) ?? row;
    ensureInsideMediaRoot(refreshedRow.absolute_path);
    const thumbnail = await ensureThumbnail(refreshedRow);
    if (thumbnail.kind === "placeholder") {
      sendPlaceholderImage(thumbnail.svg, res);
      return true;
    }
    servePlainFile(thumbnail.path, thumbnail.mimeType, res);
    return true;
  }

  return {
    clearCaches: () => recommendationResponseCache.clear(),
    clearRecommendationFeedback,
    getRecommendations,
    setRecommendationFeedback,
    sendThumbnail,
    sendPoster,
    getCacheStats: () => ({ recommendationEntries: recommendationResponseCache.size })
  };
}
