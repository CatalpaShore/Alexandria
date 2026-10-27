import { z } from "zod";
import { db } from "./db.js";
import { readFavoriteKeys } from "./favorites.js";
import { getActorAliasRegistry } from "./actorAliases.js";
import type { AgentCitation, AgentPresentation } from "./agentRag.js";
import {
  actorCupRank,
  formatEntityProfileForAgent,
  formatEntityProfileStatus,
  getEntityExtendedProfile,
  rankActorProfiles,
  rankPublicEntityProfiles,
  type ActorProfileRankingInput,
  type ActorProfileRankingMetric,
  type PublicEntityType,
  type PublicProfileRankingInput,
  type PublicProfileRankingType
} from "./entityProfiles.js";
import {
  getEntityInsightDisplayName,
  getEntityInsights,
  resolveEntityInsightAliases,
  type EntityInsightType
} from "./entityInsights.js";
import { getTopicGraphItems, getTopicLabel } from "./productRoutes.js";
import { resolveEntityProfileImageUrl } from "./entityProfileImageCache.js";
import { HEAVY_CONTENT_GENRE_LABELS } from "./agentTaxonomy.js";

export type AgentEntryContext = {
  source: "media-detail" | "entity" | "topic" | "media-wall" | "viewing-desk" | "history";
  mediaIds?: string[];
  entity?: { type: string; value: string; label: string };
  filters?: Record<string, unknown>;
  viewingDeskSessionId?: string;
  label: string;
};

export type AgentTurnState = {
  version: 1;
  intent: "search" | "recommend" | "compare" | "aggregate" | "entity" | "action" | "general";
  constraints: {
    include: Record<string, string[] | boolean | number | string>;
    exclude: Record<string, string[] | boolean | number | string>;
  };
  mediaSlots: Array<{ slot: number; mediaId: string; locked: boolean; source: "tool" | "user" | "page-context" }>;
  entities: Array<{ type: string; value: string; label: string }>;
  sort: string | null;
  sourceContext: AgentEntryContext | null;
  lastToolResultId: string | null;
};

export type AgentToolRun = {
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
  resultSummary: Record<string, unknown>;
  durationMs: number;
};

const listSchema = z.array(z.string().trim().min(1)).max(24).optional();

export const searchMediaSchema = z.object({
  mediaIds: listSchema,
  codes: listSchema,
  actors: listSchema,
  genres: listSchema,
  series: listSchema,
  makers: listSchema,
  labels: listSchema,
  directors: listSchema,
  prefixes: listSchema,
  favorite: z.boolean().optional(),
  watched: z.enum(["unwatched", "in_progress", "completed", "any"]).default("any"),
  releaseYearFrom: z.number().int().min(1900).max(2200).optional(),
  releaseYearTo: z.number().int().min(1900).max(2200).optional(),
  sort: z.enum(["relevance", "recent", "last_played", "code", "duration"]).default("relevance"),
  limit: z.number().int().min(1).max(24).default(12),
  excludeMediaIds: z.array(z.string().min(1)).max(100).default([])
});

export type SearchMediaInput = z.infer<typeof searchMediaSchema>;

const aggregateLibrarySchema = z.object({
  filters: searchMediaSchema.partial().default({}),
  groupBy: z.enum(["actor", "genre", "series", "maker", "label", "director", "prefix", "release_year"]),
  metric: z.enum(["unique_media_count", "duration_sum", "completed_count"]).default("unique_media_count"),
  order: z.enum(["desc", "asc"]).default("desc"),
  limit: z.number().int().min(1).max(20).default(10)
});

export type AggregateLibraryInput = z.infer<typeof aggregateLibrarySchema>;

type MediaRow = {
  mediaId: string;
  relativePath: string;
  code: string;
  title: string;
  summary: string;
  actors: string;
  genres: string;
  series: string;
  seriesOriginal: string;
  maker: string;
  makerOriginal: string;
  label: string;
  labelOriginal: string;
  director: string;
  directorOriginal: string;
  releaseDate: string;
  durationSeconds: number | null;
  completed: number;
  positionSeconds: number;
  lastPlayedAt: string;
};

function parseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function baseMediaSql(): string {
  return `
    SELECT media_files.id AS mediaId, media_files.relative_path AS relativePath,
      media_files.normalized_code AS code,
      COALESCE(NULLIF(media_metadata.title_zh, ''), NULLIF(media_metadata.title, ''), media_files.basename) AS title,
      COALESCE(NULLIF(media_metadata.summary_zh, ''), media_metadata.summary, '') AS summary,
      CASE WHEN media_metadata.actors_zh_json <> '[]' THEN media_metadata.actors_zh_json ELSE COALESCE(media_metadata.actors_json, '[]') END AS actors,
      CASE WHEN media_metadata.genres_zh_json <> '[]' THEN media_metadata.genres_zh_json ELSE COALESCE(media_metadata.genres_json, '[]') END AS genres,
      COALESCE(NULLIF(media_metadata.series_zh, ''), media_metadata.series, '') AS series,
      COALESCE(media_metadata.series, '') AS seriesOriginal,
      COALESCE(NULLIF(media_metadata.maker_zh, ''), media_metadata.maker, '') AS maker,
      COALESCE(media_metadata.maker, '') AS makerOriginal,
      COALESCE(NULLIF(media_metadata.label_zh, ''), media_metadata.label, '') AS label,
      COALESCE(media_metadata.label, '') AS labelOriginal,
      COALESCE(NULLIF(media_metadata.director_zh, ''), media_metadata.director, '') AS director,
      COALESCE(media_metadata.director, '') AS directorOriginal,
      COALESCE(media_metadata.release_date, '') AS releaseDate,
      media_files.duration_seconds AS durationSeconds,
      COALESCE(playback_progress.completed, 0) AS completed,
      COALESCE(playback_progress.position_seconds, 0) AS positionSeconds,
      COALESCE(playback_progress.last_played_at, '') AS lastPlayedAt
    FROM media_files
    LEFT JOIN media_metadata ON media_metadata.normalized_code = media_files.normalized_code
    LEFT JOIN playback_progress ON playback_progress.relative_path = media_files.relative_path
  `;
}

function citationFromRow(row: MediaRow, favoriteSet: Set<string>, score: number): AgentCitation {
  return {
    mediaId: row.mediaId,
    code: row.code,
    title: row.title,
    summary: row.summary,
    actors: parseList(row.actors),
    genres: parseList(row.genres),
    series: row.seriesOriginal ? getTopicLabel("series", row.seriesOriginal) : row.series,
    maker: row.makerOriginal ? getTopicLabel("maker", row.makerOriginal) : row.maker,
    label: row.labelOriginal ? getTopicLabel("label", row.labelOriginal) : row.label,
    director: row.directorOriginal ? getTopicLabel("director", row.directorOriginal) : row.director,
    prefix: row.code.split("-")[0] ?? "",
    releaseDate: row.releaseDate,
    durationSeconds: row.durationSeconds,
    favorite: favoriteSet.has(row.relativePath),
    completed: Boolean(row.completed),
    lastPlayedAt: row.lastPlayedAt,
    score
  };
}

function jsonArrayMatch(column: string): string {
  return `EXISTS (SELECT 1 FROM json_each(${column}) item WHERE TRIM(CAST(item.value AS TEXT)) = ?)`;
}

export function searchMedia(input: SearchMediaInput): AgentCitation[] {
  const parsed = searchMediaSchema.parse(input);
  const conditions = ["media_files.media_type = 'video'"];
  const params: Array<string | number> = [];
  const addScalarList = (values: string[] | undefined, expression: string) => {
    if (!values?.length) return;
    conditions.push(`(${values.map(() => expression).join(" OR ")})`);
    params.push(...values);
  };
  addScalarList(parsed.mediaIds, "media_files.id = ?");
  addScalarList(parsed.codes?.map((value) => value.toUpperCase()), "media_files.normalized_code = ?");
  addScalarList(parsed.prefixes?.map((value) => value.toUpperCase()), "media_files.code_prefix = ?");
  addScalarList(parsed.series, "(media_metadata.series = ? OR media_metadata.series_zh = ?)");
  if (parsed.series?.length) params.splice(params.length - parsed.series.length, parsed.series.length, ...parsed.series.flatMap((value) => [value, value]));
  addScalarList(parsed.makers, "(media_metadata.maker = ? OR media_metadata.maker_zh = ?)");
  if (parsed.makers?.length) params.splice(params.length - parsed.makers.length, parsed.makers.length, ...parsed.makers.flatMap((value) => [value, value]));
  addScalarList(parsed.labels, "(media_metadata.label = ? OR media_metadata.label_zh = ?)");
  if (parsed.labels?.length) params.splice(params.length - parsed.labels.length, parsed.labels.length, ...parsed.labels.flatMap((value) => [value, value]));
  addScalarList(parsed.directors, "(media_metadata.director = ? OR media_metadata.director_zh = ?)");
  if (parsed.directors?.length) params.splice(params.length - parsed.directors.length, parsed.directors.length, ...parsed.directors.flatMap((value) => [value, value]));
  addScalarList(parsed.actors, `(${jsonArrayMatch("media_metadata.actors_json")} OR ${jsonArrayMatch("media_metadata.actors_zh_json")})`);
  if (parsed.actors?.length) params.splice(params.length - parsed.actors.length, parsed.actors.length, ...parsed.actors.flatMap((value) => [value, value]));
  addScalarList(parsed.genres, `(${jsonArrayMatch("media_metadata.genres_json")} OR ${jsonArrayMatch("media_metadata.genres_zh_json")})`);
  if (parsed.genres?.length) params.splice(params.length - parsed.genres.length, parsed.genres.length, ...parsed.genres.flatMap((value) => [value, value]));
  if (parsed.releaseYearFrom) { conditions.push("CAST(SUBSTR(media_metadata.release_date, 1, 4) AS INTEGER) >= ?"); params.push(parsed.releaseYearFrom); }
  if (parsed.releaseYearTo) { conditions.push("CAST(SUBSTR(media_metadata.release_date, 1, 4) AS INTEGER) <= ?"); params.push(parsed.releaseYearTo); }
  if (parsed.watched === "unwatched") conditions.push("COALESCE(playback_progress.position_seconds, 0) = 0");
  if (parsed.watched === "in_progress") conditions.push("COALESCE(playback_progress.position_seconds, 0) > 0 AND COALESCE(playback_progress.completed, 0) = 0");
  if (parsed.watched === "completed") conditions.push("COALESCE(playback_progress.completed, 0) = 1");
  if (parsed.excludeMediaIds.length) {
    conditions.push(`media_files.id NOT IN (${parsed.excludeMediaIds.map(() => "?").join(",")})`);
    params.push(...parsed.excludeMediaIds);
  }
  const favoriteSet = readFavoriteKeys();
  if (parsed.favorite != null) {
    const favoritePaths = [...favoriteSet];
    if (favoritePaths.length === 0 && parsed.favorite) return [];
    if (favoritePaths.length > 0) {
      conditions.push(`media_files.relative_path ${parsed.favorite ? "IN" : "NOT IN"} (${favoritePaths.map(() => "?").join(",")})`);
      params.push(...favoritePaths);
    }
  }
  const orderBy = parsed.sort === "last_played"
    ? "COALESCE(playback_progress.last_played_at, '') DESC"
    : parsed.sort === "code" ? "media_files.normalized_code"
    : parsed.sort === "duration" ? "COALESCE(media_files.duration_seconds, 0) DESC"
    : "COALESCE(media_metadata.release_date, '') DESC, media_files.mtime_ms DESC";
  const rows = db.prepare(`${baseMediaSql()} WHERE ${conditions.join(" AND ")} ORDER BY ${orderBy} LIMIT ?`)
    .all(...params, parsed.limit) as MediaRow[];
  return rows.map((row, index) => citationFromRow(row, favoriteSet, 1 - index * 0.01));
}

function allMediaRows(filters: Partial<SearchMediaInput>): MediaRow[] {
  const citations = searchMedia({ ...filters, limit: 24 } as SearchMediaInput);
  if (citations.length < 24) {
    const ids = citations.map((item) => item.mediaId);
    if (!ids.length) return [];
  }
  const clauses = ["media_files.media_type = 'video'"];
  const params: string[] = [];
  if (filters.prefixes?.length) {
    clauses.push(`media_files.code_prefix IN (${filters.prefixes.map(() => "?").join(",")})`);
    params.push(...filters.prefixes.map((value) => value.toUpperCase()));
  }
  if (filters.series?.length) {
    clauses.push(`(${filters.series.map(() => "media_metadata.series = ? OR media_metadata.series_zh = ?").join(" OR ")})`);
    params.push(...filters.series.flatMap((value) => [value, value]));
  }
  if (filters.genres?.length) {
    clauses.push(`(${filters.genres.map(() => `(${jsonArrayMatch("media_metadata.genres_json")} OR ${jsonArrayMatch("media_metadata.genres_zh_json")})`).join(" OR ")})`);
    params.push(...filters.genres.flatMap((value) => [value, value]));
  }
  return db.prepare(`${baseMediaSql()} WHERE ${clauses.join(" AND ")}`).all(...params) as MediaRow[];
}

export function aggregateLibrary(input: AggregateLibraryInput) {
  const parsed = aggregateLibrarySchema.parse(input);
  const rows = allMediaRows(parsed.filters);
  const groups = new Map<string, { value: string; label: string; media: Set<string>; duration: number; completed: number }>();
  for (const row of rows) {
    const values = parsed.groupBy === "actor" ? parseList(row.actors)
      : parsed.groupBy === "genre" ? parseList(row.genres)
      : parsed.groupBy === "series" ? [row.series]
      : parsed.groupBy === "maker" ? [row.maker]
      : parsed.groupBy === "label" ? [row.label]
      : parsed.groupBy === "director" ? [row.director]
      : parsed.groupBy === "prefix" ? [row.code.split("-")[0] ?? ""]
      : [row.releaseDate.slice(0, 4)];
    for (const rawValue of values.filter(Boolean)) {
      const value = rawValue.trim();
      if (!value) continue;
      const group = groups.get(value) ?? { value, label: value, media: new Set<string>(), duration: 0, completed: 0 };
      if (!group.media.has(row.code)) {
        group.media.add(row.code);
        group.duration += row.durationSeconds ?? 0;
        group.completed += row.completed ? 1 : 0;
      }
      groups.set(value, group);
    }
  }
  const metricValue = (group: { media: Set<string>; duration: number; completed: number }) => parsed.metric === "duration_sum"
    ? Math.round(group.duration / 60) : parsed.metric === "completed_count" ? group.completed : group.media.size;
  const ranked = [...groups.values()]
    .map((group) => ({ value: group.value, label: group.label, count: metricValue(group) }))
    .sort((left, right) => parsed.order === "desc" ? right.count - left.count || left.label.localeCompare(right.label) : left.count - right.count || left.label.localeCompare(right.label))
    .slice(0, parsed.limit)
    .map((row, index) => ({ ...row, rank: index + 1 }));
  return { totalWorks: new Set(rows.map((row) => row.code)).size, groupBy: parsed.groupBy, metric: parsed.metric, rows: ranked };
}

export function compareMedia(codes: string[]) {
  const citations = searchMedia({ codes: [...new Set(codes)].slice(0, 6), watched: "any", sort: "code", limit: 6, excludeMediaIds: [] });
  const fields = [
    { key: "actors", label: "演员", values: citations.map((item) => item.actors.join("、") || "资料缺失") },
    { key: "genres", label: "题材", values: citations.map((item) => item.genres.join("、") || "资料缺失") },
    { key: "series", label: "系列", values: citations.map((item) => item.series || "未归入系列") },
    { key: "maker", label: "厂商", values: citations.map((item) => item.maker || "资料缺失") },
    { key: "label", label: "厂牌", values: citations.map((item) => item.label || "资料缺失") },
    { key: "director", label: "导演", values: citations.map((item) => item.director || "资料缺失") },
    { key: "releaseDate", label: "发行日期", values: citations.map((item) => item.releaseDate || "资料缺失") },
    { key: "duration", label: "时长", values: citations.map((item) => item.durationSeconds
      ? `${Math.round(item.durationSeconds / 60)} 分钟` : "资料缺失") },
    { key: "favorite", label: "收藏", values: citations.map((item) => item.favorite ? "已收藏" : "未收藏") },
    { key: "watch", label: "观看状态", values: citations.map((item) => item.completed ? "已看完" : item.lastPlayedAt ? "看过" : "未观看") }
  ];
  const presentation: AgentPresentation = {
    kind: "comparison-matrix",
    title: "作品对比",
    columns: citations.map((item, index) => ({ citationNumber: index + 1, mediaId: item.mediaId, code: item.code })),
    rows: fields
  };
  return { citations, presentation };
}

export function getWatchHistory(limit = 20): AgentCitation[] {
  const favoriteSet = readFavoriteKeys();
  const rows = db.prepare(`${baseMediaSql()}
    WHERE media_files.media_type = 'video' AND playback_progress.last_played_at IS NOT NULL
    ORDER BY playback_progress.last_played_at DESC LIMIT ?`).all(Math.min(50, Math.max(1, limit))) as MediaRow[];
  return rows.map((row, index) => citationFromRow(row, favoriteSet, 1 - index * 0.01));
}

export function getEntityProfile(type: EntityInsightType, value: string) {
  const extendedProfile = getEntityExtendedProfile(type, value);
  const topic = getTopicGraphItems(type).find((item) => item.value === value || item.aliases.includes(value));
  const aliases = topic?.aliases?.length ? topic.aliases : resolveEntityInsightAliases(type, value);
  const filter: Partial<SearchMediaInput> = type === "actor" ? { actors: [value] }
    : type === "genre" ? { genres: [value] }
    : type === "series" ? { series: [value] }
    : type === "maker" ? { makers: [value] }
    : type === "label" ? { labels: [value] }
    : type === "director" ? { directors: [value] }
    : { prefixes: [value] };
  const filterValues = type === "actor" ? { actors: aliases }
    : type === "genre" ? { genres: aliases }
    : type === "series" ? { series: aliases }
    : type === "maker" ? { makers: aliases }
    : type === "label" ? { labels: aliases }
    : type === "director" ? { directors: aliases }
    : { prefixes: aliases };
  const mediaRows = searchMedia({ ...filter, ...filterValues, watched: "any", sort: "recent", limit: 24, excludeMediaIds: [] } as SearchMediaInput);
  const seenCodes = new Set<string>();
  const items = mediaRows.filter((item) => {
    const codeKey = item.code.normalize("NFKC").trim().toUpperCase();
    if (!codeKey || seenCodes.has(codeKey)) return false;
    seenCodes.add(codeKey);
    return true;
  }).slice(0, 12);
  const insights = getEntityInsights(type, value, aliases);
  const stats = type === "prefix" ? db.prepare(`
    SELECT COUNT(DISTINCT media_files.normalized_code) AS mediaCount,
      COUNT(DISTINCT CASE WHEN progress.last_played_at IS NOT NULL THEN media_files.normalized_code END) AS watchedCount
    FROM media_files
    LEFT JOIN playback_progress progress ON progress.relative_path = media_files.relative_path
    WHERE media_files.media_type = 'video' AND media_files.code_prefix = @value
  `).get({ value }) as { mediaCount: number; watchedCount: number } : db.prepare(`
    SELECT COUNT(DISTINCT facets.normalized_code) AS mediaCount,
      COUNT(DISTINCT CASE WHEN progress.last_played_at IS NOT NULL THEN facets.normalized_code END) AS watchedCount
    FROM media_metadata_facets facets
    JOIN media_files ON media_files.normalized_code = facets.normalized_code AND media_files.media_type = 'video'
    LEFT JOIN playback_progress progress ON progress.relative_path = media_files.relative_path
    WHERE facets.facet_type = @type
      AND facets.facet_value IN (SELECT CAST(value AS TEXT) FROM json_each(@aliasesJson))
  `).get({ type, aliasesJson: JSON.stringify(aliases) }) as { mediaCount: number; watchedCount: number };
  const favoriteKeys = readFavoriteKeys();
  const favoriteRows = type === "prefix" ? db.prepare(`
    SELECT DISTINCT relative_path AS relativePath, normalized_code AS normalizedCode FROM media_files
    WHERE media_type = 'video' AND code_prefix = @value
  `).all({ value }) as Array<{ relativePath: string; normalizedCode: string }> : db.prepare(`
    SELECT DISTINCT media_files.relative_path AS relativePath, media_files.normalized_code AS normalizedCode
    FROM media_metadata_facets facets
    JOIN media_files ON media_files.normalized_code = facets.normalized_code AND media_files.media_type = 'video'
    WHERE facets.facet_type = @type
      AND facets.facet_value IN (SELECT CAST(value AS TEXT) FROM json_each(@aliasesJson))
  `).all({ type, aliasesJson: JSON.stringify(aliases) }) as Array<{ relativePath: string; normalizedCode: string }>;
  const favoriteCount = favoriteKeys.size
    ? new Set(favoriteRows.filter((row) => favoriteKeys.has(row.relativePath)).map((row) => row.normalizedCode)).size : 0;
  return {
    type,
    value,
    mediaCount: stats.mediaCount,
    favoriteCount,
    watchedCount: stats.watchedCount,
    insights,
    extendedProfile,
    profileEvidence: formatEntityProfileForAgent(extendedProfile),
    items
  };
}

const ENTITY_TYPE_LABELS: Record<EntityInsightType, string> = {
  actor: "演员", genre: "标签", series: "系列", maker: "厂商", label: "厂牌", director: "导演", prefix: "番号系列"
};

function findExplicitEntityMention(query: string): { type: EntityInsightType; value: string } | null {
  const typeByLabel: Record<string, EntityInsightType> = {
    演员: "actor", 标签: "genre", 主题: "series", 系列: "series", 厂商: "maker", 厂牌: "label", 导演: "director", 番号系列: "prefix"
  };
  const match = query.match(/(演员|标签|主题|系列|厂商|厂牌|导演|番号系列)=([^；\n]+)/u);
  return match ? { type: typeByLabel[match[1]], value: match[2].trim() } : null;
}

function normalizeEntityMentionText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ja")
    .replace(/[\s\u3000“”"'‘’「」『』【】《》〈〉]+/gu, "");
}

export function findNaturalEntityMention(query: string): { type: EntityInsightType; value: string } | null {
  const normalizedQuery = normalizeEntityMentionText(query);
  const hintedType: EntityInsightType | null = /番号系列|番号前缀|番号前綴|番号プレフィックス/u.test(query) ? "prefix"
    : /演员|女优|女優/u.test(query) ? "actor"
    : /系列|主题/u.test(query) ? "series"
    : /标签|題材|题材/u.test(query) ? "genre"
    : /厂商|廠商|公司|メーカー/u.test(query) ? "maker"
    : /厂牌|廠牌|品牌|レーベル/u.test(query) ? "label"
    : /导演|導演|監督/u.test(query) ? "director" : null;
  const profileRows = db.prepare(`
    SELECT facet_type AS type, facet_value AS value, display_name AS displayName,
      aliases_json AS aliasesJson, names_json AS namesJson
    FROM entity_profiles
    WHERE source_status != 'unverified'
  `).all() as Array<{ type: string; value: string; displayName: string; aliasesJson: string; namesJson: string }>;
  const profileKeys = new Set(profileRows.map((row) => `${row.type}:${row.value}`));
  const profileNames = new Map(profileRows.map((row) => {
    let localizedNames: string[] = [];
    try {
      const parsed = JSON.parse(row.namesJson) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        localizedNames = Object.values(parsed as Record<string, unknown>).map(String).filter(Boolean);
      }
    } catch {
      localizedNames = [];
    }
    return [`${row.type}:${row.value}`, [row.displayName, ...parseList(row.aliasesJson), ...localizedNames]];
  }));
  const types: EntityInsightType[] = ["actor", "genre", "series", "maker", "label", "director", "prefix"];
  const matches = types.flatMap((type) => getTopicGraphItems(type).flatMap((item) => {
    const aliases = [item.value, item.label, ...item.aliases, ...(profileNames.get(`${type}:${item.value}`) ?? [])]
      .map(normalizeEntityMentionText)
      .filter((value) => value.length >= 2 && normalizedQuery.includes(value));
    if (!aliases.length) return [];
    const matchedLength = Math.max(...aliases.map((value) => value.length));
    const hasProfile = profileKeys.has(`${type}:${item.value}`);
    return [{ type, value: item.value, matchedLength, hasProfile, mediaCount: item.mediaCount,
      score: (hintedType === type ? 100_000 : 0) + (hasProfile ? 10_000 : 0) + matchedLength * 100 + item.mediaCount }];
  }));
  matches.sort((left, right) => right.score - left.score || right.matchedLength - left.matchedLength ||
    right.mediaCount - left.mediaCount);
  const top = matches[0];
  if (!top) return null;
  if (!hintedType) {
    if (!top.hasProfile || top.matchedLength < 3) return null;
    const equallyNamedAcrossTypes = matches.some((item) => item !== top && item.matchedLength === top.matchedLength &&
      item.type !== top.type && item.hasProfile === top.hasProfile);
    if (equallyNamedAcrossTypes) return null;
  }
  return { type: top.type, value: top.value };
}

function entityInsightAnswer(result: ReturnType<typeof getEntityProfile>): string {
  const { insights } = result;
  const displayName = getEntityInsightDisplayName(result.type, result.value);
  const relationCopy = (["actor", "genre", "series", "maker", "label", "director"] as const)
    .filter((type) => type !== result.type && insights.related[type].length)
    .slice(0, 3)
    .map((type) => `- 主要${ENTITY_TYPE_LABELS[type]}：${insights.related[type].slice(0, 5)
      .map((item) => `${getEntityInsightDisplayName(type, item.value)}（${item.mediaCount} 部）`).join("、")}`);
  const workCopy = result.items.slice(0, 6).map((item, index) => `${item.code} [${index + 1}]`).join("、");
  return [
    `## ${ENTITY_TYPE_LABELS[result.type]}「${displayName}」· 馆藏画像`,
    `- 关联作品：${insights.mediaCount} 部`,
    insights.firstReleaseDate || insights.latestReleaseDate
      ? `- 发行跨度：${insights.firstReleaseDate ?? "未知"} 至 ${insights.latestReleaseDate ?? "未知"}（${insights.releaseYearCount} 个年份）` : "",
    insights.averageRuntimeMinutes ? `- 平均时长：${insights.averageRuntimeMinutes} 分钟；累计 ${insights.totalRuntimeMinutes} 分钟` : "",
    insights.averageScore != null ? `- 馆藏平均评分：${insights.averageScore}（${insights.scoredMediaCount} 部有评分）` : "",
    `- 你的记录：收藏 ${result.favoriteCount} 部；看过 ${result.watchedCount} 部`,
    ...relationCopy,
    result.profileEvidence ? `\n### 公开资料\n${result.profileEvidence}` : "",
    workCopy ? `\n最近发行作品：${workCopy}。` : "",
    "\n以上统计由本地馆藏元数据确定计算；缺失字段保持为空。"
  ].filter(Boolean).join("\n");
}

function findProfileMention(query: string) {
  const explicit = query.match(/演员=([^；\n]+)/u)?.[1]?.trim();
  if (explicit) return getEntityExtendedProfile("actor", explicit);
  const registeredAliases = getActorAliasRegistry()
    .flatMap((group) => group.aliases.map((alias) => ({ alias, canonicalName: group.canonicalName })))
    .sort((left, right) => right.alias.length - left.alias.length);
  for (const item of registeredAliases) {
    if (item.alias.length >= 2 && query.includes(item.alias)) {
      const profile = getEntityExtendedProfile("actor", item.canonicalName);
      if (profile) return profile;
    }
  }
  const metadataNames = db.prepare(`
    SELECT DISTINCT TRIM(CAST(source.value AS TEXT)) AS source,
      COALESCE(TRIM(CAST(translated.value AS TEXT)), '') AS translated
    FROM media_metadata metadata
    JOIN json_each(metadata.actors_json) source
    LEFT JOIN json_each(metadata.actors_zh_json) translated ON translated.key = source.key
    WHERE LENGTH(TRIM(CAST(source.value AS TEXT))) >= 2
       OR LENGTH(TRIM(CAST(translated.value AS TEXT))) >= 2
  `).all() as Array<{ source: string; translated: string }>;
  metadataNames.sort((left, right) =>
    Math.max(right.source.length, right.translated.length) - Math.max(left.source.length, left.translated.length)
  );
  for (const item of metadataNames) {
    if (![item.source, item.translated].some((name) => name.length >= 2 && query.includes(name))) continue;
    const profile = getEntityExtendedProfile("actor", item.source) ?? getEntityExtendedProfile("actor", item.translated);
    if (profile) return profile;
  }
  const rows = db.prepare(`
    SELECT facet_value AS value, aliases_json AS aliasesJson FROM entity_profiles
    WHERE facet_type = 'actor' AND source_status != 'unverified'
    ORDER BY LENGTH(display_name) DESC
  `).all() as Array<{ value: string; aliasesJson: string }>;
  for (const row of rows) {
    const aliases = parseList(row.aliasesJson);
    if ([row.value, ...aliases].some((alias) => alias.length >= 2 && query.includes(alias))) {
      return getEntityExtendedProfile("actor", row.value);
    }
  }
  return null;
}

function profileAnswer(profile: NonNullable<ReturnType<typeof getEntityExtendedProfile>>): string {
  const measurements = profile.measurements;
  const dimensions = [measurements.bustCm, measurements.waistCm, measurements.hipsCm];
  const stringFact = (key: string) => typeof profile.facts[key] === "string" ? profile.facts[key] as string : "";
  const uniqueSources = profile.sources.filter((source, index, sources) =>
    sources.findIndex((candidate) => candidate.url === source.url) === index);
  const lines = [
    `## ${profile.displayName} · 公开资料`,
    profile.originalName && profile.originalName !== profile.displayName ? `- 日文原名：${profile.originalName}` : "",
    profile.birthDate ? `- 出生日期：${profile.birthDate}` : "",
    profile.birthplace ? `- 出生地：${profile.birthplace}` : "",
    profile.nationality ? `- 国籍：${profile.nationality}` : "",
    profile.heightCm ? `- 身高：${profile.heightCm} cm` : "",
    dimensions.every((value) => value != null) ? `- 三围：${dimensions.join(" / ")} cm` : "- 三围：当前可信来源未收录，因此保持为空",
    measurements.cup ? `- 罩杯：${measurements.cup}` : "",
    stringFact("agency") ? `- 所属事务所：${stringFact("agency")}` : "",
    stringFact("romanizedName") ? `- 罗马字：${stringFact("romanizedName")}` : "",
    stringFact("reading") ? `- 读音：${stringFact("reading")}` : "",
    profile.occupations.length ? `- 职业：${profile.occupations.join("、")}` : "",
    profile.biography ? `\n${profile.biography}` : "",
    uniqueSources.length ? `\n资料来源：${uniqueSources.map((source) =>
      `[${source.title.trim() || source.provider}](${source.url})`).join("、")}。${formatEntityProfileStatus(profile.status)}，置信度 ${Math.round(profile.confidence * 100)}%。` : ""
  ].filter(Boolean);
  return lines.join("\n");
}

function entityProfilePresentation(
  rawProfile: NonNullable<ReturnType<typeof getEntityExtendedProfile>>
): Extract<AgentPresentation, { kind: "entity-profile-card" }> | null {
  if (!["actor", "maker", "label", "series", "director"].includes(rawProfile.type)) return null;
  const profile = resolveEntityProfileImageUrl(rawProfile) ?? rawProfile;
  const dimensions = [profile.measurements.bustCm, profile.measurements.waistCm, profile.measurements.hipsCm];
  const structuredFact = (key: string) => {
    const value = profile.facts[key];
    return Array.isArray(value) ? value.map(String).filter(Boolean).join("、")
      : typeof value === "string" || typeof value === "number" ? String(value) : "";
  };
  const facts = [
    profile.birthDate ? { label: "出生日期", value: profile.birthDate } : null,
    profile.birthplace ? { label: "出生地", value: profile.birthplace } : null,
    profile.heightCm != null ? { label: "身高", value: `${profile.heightCm} cm` } : null,
    dimensions.every((value) => value != null) ? { label: "三围", value: `${dimensions.join(" / ")} cm` } : null,
    profile.measurements.cup ? { label: "罩杯", value: `${profile.measurements.cup} 杯` } : null,
    structuredFact("agency") ? { label: "事务所", value: structuredFact("agency") } : null,
    structuredFact("inceptionDate") ? { label: "成立时间", value: structuredFact("inceptionDate") } : null,
    structuredFact("foundedYear") ? { label: "成立年份", value: structuredFact("foundedYear") } : null,
    structuredFact("headquarters") ? { label: "总部", value: structuredFact("headquarters") } : null,
    structuredFact("country") ? { label: "所属国家", value: structuredFact("country") } : null,
    structuredFact("industry") ? { label: "行业", value: structuredFact("industry") } : null,
    structuredFact("parentOrganization") ? { label: "母公司", value: structuredFact("parentOrganization") } : null,
    structuredFact("relatedMaker") ? { label: "所属厂商", value: structuredFact("relatedMaker") } : null,
    structuredFact("matchedLibraryWorkCount")
      ? { label: "身份验证", value: `${structuredFact("matchedLibraryWorkCount")} 部馆藏作品` } : null
  ].filter((item): item is { label: string; value: string } => Boolean(item)).slice(0, 6);
  return {
    kind: "entity-profile-card",
    type: profile.type as "actor" | "maker" | "label" | "series" | "director",
    value: profile.value,
    label: profile.displayName,
    ...(profile.originalName ? { originalName: profile.originalName } : {}),
    ...(profile.imageUrl ? { imageUrl: profile.imageUrl } : {}),
    ...(profile.biography ? { description: profile.biography } : {}),
    status: profile.status,
    confidence: profile.confidence,
    sourceCount: new Set(profile.sources.map((source) => source.url)).size,
    aliases: profile.aliases.filter((alias) => alias !== profile.displayName).slice(0, 5),
    facts
  };
}

export function createTurnState(input: {
  intent: AgentTurnState["intent"];
  citations?: AgentCitation[];
  citationNumbers?: number[];
  include?: AgentTurnState["constraints"]["include"];
  exclude?: AgentTurnState["constraints"]["exclude"];
  entities?: AgentTurnState["entities"];
  sourceContext?: AgentEntryContext | null;
  previous?: AgentTurnState | null;
  toolRunId?: string | null;
}): AgentTurnState {
  const selected = input.citationNumbers?.length
    ? input.citationNumbers.map((number) => input.citations?.[number - 1]).filter((item): item is AgentCitation => Boolean(item))
    : input.citations ?? [];
  const mediaSlots = input.citations === undefined && input.citationNumbers === undefined
    ? input.previous?.mediaSlots ?? []
    : selected.map((item, index) => ({ slot: index + 1, mediaId: item.mediaId, locked: false, source: "tool" as const }));
  return {
    version: 1,
    intent: input.intent,
    constraints: {
      include: { ...(input.previous?.constraints.include ?? {}), ...(input.include ?? {}) },
      exclude: { ...(input.previous?.constraints.exclude ?? {}), ...(input.exclude ?? {}) }
    },
    mediaSlots,
    entities: input.entities ?? input.previous?.entities ?? [],
    sort: input.previous?.sort ?? null,
    sourceContext: input.sourceContext ?? input.previous?.sourceContext ?? null,
    lastToolResultId: input.toolRunId ?? null
  };
}

export function extractMentionedCodes(query: string): string[] {
  return [...new Set(query.toUpperCase().match(/[A-Z]{2,12}[-_ ]?\d{2,7}(?:-[A-Z])?/g)
    ?.map((value) => value.replace(/[ _]/g, "-")) ?? [])];
}

export type ActorProfileRankingRequest = {
  metric: ActorProfileRankingMetric;
  order: "asc" | "desc";
  limit: number;
  minHeightCm?: number;
  maxHeightCm?: number;
  birthYearFrom?: number;
  birthYearTo?: number;
  title: string;
  metricLabel: string;
};

export type ActorProfileMediaRequest = {
  rankingInput: ActorProfileRankingInput;
  title: string;
  mediaLimit: number;
};

export type ActorProfileGenreRecommendationRequest = {
  rankingInput: ActorProfileRankingInput;
  genreGroup: "heavy-content";
  genreLabels: string[];
  title: string;
  limit: number;
};

export type EntityRankingRequest = {
  groupBy: AggregateLibraryInput["groupBy"];
  metric: AggregateLibraryInput["metric"];
  order: "desc" | "asc";
  limit: number;
  title: string;
  metricLabel: string;
};

export type PublicProfileRankingRequest = PublicProfileRankingInput & {
  order: "asc" | "desc";
  limit: number;
  title: string;
  metricLabel: string;
};

export type EntityRecommendationRequest = {
  type: EntityInsightType;
  limit: number;
  personalized: boolean;
  title: string;
};

const AGGREGATE_GROUP_LABELS: Partial<Record<AggregateLibraryInput["groupBy"], string>> = {
  actor: "演员", genre: "标签", series: "系列", maker: "厂商", label: "厂牌", director: "导演", prefix: "番号"
};

const ENTITY_RECOMMENDATION_LABELS: Record<EntityInsightType, string> = {
  actor: "演员", genre: "标签", series: "主题", maker: "厂商", label: "厂牌", director: "导演", prefix: "番号系列"
};

export function parseEntityRecommendationQuery(query: string): EntityRecommendationRequest | null {
  if (!/(推荐|推薦|建议|建議|值得关注|值得關注|值得探索|猜你喜欢|猜你喜歡)/u.test(query)) return null;
  const type: EntityInsightType | null = /番号(?:系列|前缀|前綴)|前缀专题|前綴專題/u.test(query) ? "prefix"
    : /厂牌|廠牌|品牌|レーベル/u.test(query) ? "label"
    : /厂商|廠商|厂家|メーカー/u.test(query) ? "maker"
    : /导演|導演|監督/u.test(query) ? "director"
    : /标签|標籤|题材|題材|分类|分類|类别|類別/u.test(query) ? "genre"
    : /系列|主题|主題|专题|專題/u.test(query) ? "series"
    : /演员|演員|女优|女優/u.test(query) ? "actor" : null;
  if (!type) return null;
  if (/(?:影片|作品|片单|片單|电影|電影)/u.test(query)) return null;
  const countMatch = query.match(/(\d{1,2})\s*(?:个|個|位|名|项|項|组|組)/u);
  const chineseCount = query.match(/([一二两三四五六七八])\s*(?:个|個|位|名|项|項|组|組)/u)?.[1];
  const parsedCount = countMatch ? Number(countMatch[1])
    : chineseCount ? ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8 } as const)[chineseCount as "一" | "二" | "两" | "三" | "四" | "五" | "六" | "七" | "八"]
      : 4;
  const limit = Math.min(8, Math.max(1, parsedCount));
  const personalized = /(根据|基于).{0,8}(最近|观影|觀看|历史|歷史|收藏)|我的?(?:观影|觀看|偏好|口味)|适合我|適合我|猜你喜欢|猜你喜歡/u.test(query);
  const label = ENTITY_RECOMMENDATION_LABELS[type];
  return { type, limit, personalized, title: personalized ? `根据近期偏好推荐${label}` : `值得探索的${label}` };
}

function requestedEntityMediaCount(query: string): number {
  const numeric = query.match(/(\d{1,2})\s*部/u)?.[1];
  if (numeric) return Math.min(6, Math.max(1, Number(numeric)));
  const chinese = query.match(/([一二两三四五六])\s*部/u)?.[1];
  return chinese
    ? ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6 } as const)[chinese as "一" | "二" | "两" | "三" | "四" | "五" | "六"]
    : 4;
}

function buildEntityMediaRecommendation(
  query: string,
  entity: { type: EntityInsightType; value: string },
  excludeMediaIds: string[]
): { items: AgentCitation[]; toolArguments: SearchMediaInput } {
  const entityFilter = entity.type === "actor" ? { actors: [entity.value] }
    : entity.type === "genre" ? { genres: [entity.value] }
    : entity.type === "series" ? { series: [entity.value] }
    : entity.type === "maker" ? { makers: [entity.value] }
    : entity.type === "label" ? { labels: [entity.value] }
    : entity.type === "director" ? { directors: [entity.value] }
    : { prefixes: [entity.value] };
  const limit = requestedEntityMediaCount(query);
  const toolArguments: SearchMediaInput = {
    ...entityFilter,
    favorite: /收藏/u.test(query) ? true : undefined,
    watched: /没看|未看|还没(?:有)?看|从未看/u.test(query) ? "unwatched" : "any",
    sort: /近期|最近|新作|新片|发行/u.test(query) ? "recent" : "relevance",
    limit: /资料.{0,6}完整|元数据.{0,6}完整/u.test(query) ? Math.min(24, Math.max(limit * 3, 12)) : limit,
    excludeMediaIds
  };
  let items = searchMedia(toolArguments);
  if (/资料.{0,6}完整|元数据.{0,6}完整/u.test(query)) {
    const completeness = (item: AgentCitation) => [
      item.actors.length > 0, item.genres.length > 0, Boolean(item.series), Boolean(item.maker),
      Boolean(item.label), Boolean(item.director), Boolean(item.releaseDate), Boolean(item.summary)
    ].filter(Boolean).length;
    items = [...items].sort((left, right) => completeness(right) - completeness(left)
      || (right.releaseDate ?? "").localeCompare(left.releaseDate ?? ""));
  }
  return { items: items.slice(0, limit), toolArguments: { ...toolArguments, limit } };
}

function entityMediaRecommendationReason(item: AgentCitation): string {
  return [
    item.releaseDate ? `发行 ${item.releaseDate}` : "",
    item.actors.length ? `演员 ${item.actors.slice(0, 2).join("、")}` : "",
    item.series ? `系列“${item.series}”` : "",
    item.label ? `厂牌“${item.label}”` : "",
    item.director ? `导演 ${item.director}` : ""
  ].filter(Boolean).slice(0, 3).join("；") || "馆藏元数据已核验";
}

function recentEntityMatches(type: EntityInsightType): Map<string, Set<string>> {
  const rows = type === "prefix"
    ? db.prepare(`
        WITH recent_codes AS (
          SELECT media_files.normalized_code, media_files.code_prefix AS value
          FROM media_files JOIN playback_progress ON playback_progress.relative_path = media_files.relative_path
          WHERE media_files.media_type = 'video' AND COALESCE(playback_progress.last_played_at, '') != ''
          GROUP BY media_files.normalized_code ORDER BY MAX(playback_progress.last_played_at) DESC LIMIT 80
        )
        SELECT value, normalized_code AS normalizedCode FROM recent_codes
        WHERE COALESCE(value, '') != ''
      `).all()
    : db.prepare(`
        WITH recent_codes AS (
          SELECT media_files.normalized_code
          FROM media_files JOIN playback_progress ON playback_progress.relative_path = media_files.relative_path
          WHERE media_files.media_type = 'video' AND COALESCE(playback_progress.last_played_at, '') != ''
          GROUP BY media_files.normalized_code ORDER BY MAX(playback_progress.last_played_at) DESC LIMIT 80
        )
        SELECT facets.facet_value AS value, facets.normalized_code AS normalizedCode
        FROM media_metadata_facets facets JOIN recent_codes ON recent_codes.normalized_code = facets.normalized_code
        WHERE facets.facet_type = ?
      `).all(type);
  const matches = new Map<string, Set<string>>();
  for (const row of rows as Array<{ value: string; normalizedCode: string }>) {
    const codes = matches.get(row.value) ?? new Set<string>();
    codes.add(row.normalizedCode);
    matches.set(row.value, codes);
  }
  return matches;
}

function buildEntityRecommendationPresentation(
  request: EntityRecommendationRequest,
  options: { variationSeed?: number; excludeEntityValues?: string[] } = {}
): Extract<AgentPresentation, { kind: "entity-cards" }> {
  const history = request.personalized ? recentEntityMatches(request.type) : new Map<string, Set<string>>();
  const topics = getTopicGraphItems(request.type)
    .filter((item) => item.mediaCount >= 3)
    .map((item) => ({
      item,
      historyCount: new Set([...new Set([item.value, ...item.aliases])]
        .flatMap((alias) => [...(history.get(alias) ?? [])])).size
    }));
  const hasPersonalMatches = topics.some((candidate) => candidate.historyCount > 0);
  const excluded = new Set(options.excludeEntityValues ?? []);
  const preferred = topics.filter((candidate) => !excluded.has(candidate.item.value));
  const candidates = preferred.length >= request.limit ? preferred : [
    ...preferred,
    ...topics.filter((candidate) => excluded.has(candidate.item.value))
  ];
  const variationNoise = (value: string): number => {
    if (options.variationSeed == null) return 0;
    let hash = options.variationSeed | 0;
    for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619);
    return ((hash >>> 0) % 10_000) / 10_000;
  };
  const relevanceScore = (candidate: typeof topics[number]): number => hasPersonalMatches
    ? candidate.historyCount * 100 + Math.log1p(candidate.item.mediaCount) * 5 + variationNoise(candidate.item.value) * 18
    : Math.log1p(candidate.item.mediaCount) * 10 + variationNoise(candidate.item.value) * 8;
  const selected = candidates
    .sort((left, right) => options.variationSeed == null
      ? hasPersonalMatches
        ? right.historyCount - left.historyCount || right.item.mediaCount - left.item.mediaCount
        : right.item.mediaCount - left.item.mediaCount || left.item.label.localeCompare(right.item.label, "zh-CN")
      : relevanceScore(right) - relevanceScore(left) || left.item.label.localeCompare(right.item.label, "zh-CN"))
    .slice(0, request.limit);
  const items = selected.map(({ item, historyCount }) => {
    const publicType = ["actor", "series", "maker", "label", "director"].includes(request.type)
      ? request.type as PublicEntityType : null;
    const rawProfile = publicType ? getEntityExtendedProfile(publicType, item.value) : null;
    const profile = rawProfile ? resolveEntityProfileImageUrl(rawProfile) ?? rawProfile : null;
    const insights = getEntityInsights(request.type, item.value, item.aliases);
    const highlightType: Exclude<EntityInsightType, "prefix"> = request.type === "actor" ? "genre"
      : request.type === "genre" ? "actor"
      : request.type === "maker" ? "label"
      : "actor";
    const highlights = insights.related[highlightType].slice(0, 3)
      .map((related) => getEntityInsightDisplayName(highlightType, related.value));
    const reason = hasPersonalMatches && historyCount > 0
      ? `近期观看中有 ${historyCount} 部相关作品`
      : item.latestReleaseDate
        ? `馆藏 ${item.mediaCount} 部 · 最近更新 ${item.latestReleaseDate}`
        : `馆藏已收录 ${item.mediaCount} 部作品`;
    const originalName = profile?.originalName && profile.originalName !== item.label
      ? profile.originalName
      : item.value !== item.label ? item.value : undefined;
    return {
      type: request.type,
      value: item.value,
      label: item.label,
      ...(originalName ? { originalName } : {}),
      ...(profile?.imageUrl ? { imageUrl: profile.imageUrl } : {}),
      ...(item.customCoverMediaId ?? item.mediaId ? { coverMediaId: item.customCoverMediaId ?? item.mediaId ?? undefined } : {}),
      mediaCount: item.mediaCount,
      ...(item.latestReleaseDate ? { latestReleaseDate: item.latestReleaseDate } : {}),
      reason,
      highlights
    };
  });
  return {
    kind: "entity-cards",
    title: request.title,
    subtitle: hasPersonalMatches ? "结合近期观看与本地分类统计" : "基于本地分类统计 · 无需影片引用",
    items
  };
}

export function parsePublicProfileRankingQuery(query: string): PublicProfileRankingRequest | null {
  const type: PublicProfileRankingType | null = /厂牌|廠牌|品牌|レーベル/u.test(query) ? "label"
    : /厂商|廠商|厂家|メーカー/u.test(query) ? "maker"
    : /系列|主题/u.test(query) ? "series"
    : /导演|導演|監督/u.test(query) ? "director" : null;
  if (!type) return null;
  const mentionedEntity = findExplicitEntityMention(query) ?? findNaturalEntityMention(query);
  const asksForOneProfile = mentionedEntity?.type === type
    && /介绍|資料|资料|档案|檔案|详情|詳情|官网|官方網站|别名|別名|是什么|是什麼|情况|情況/u.test(query)
    && !/旗下|所属|所屬|隶属|隸屬|排行|排名|前\s*\d+|top\s*\d+|列出.{0,8}(?:厂商|廠商|厂牌|廠牌|系列|主题|导演|導演|監督)|哪些(?:厂商|廠商|厂牌|廠牌|系列|主题|导演|導演|監督)/iu.test(query);
  if (asksForOneProfile) return null;
  const label = type === "maker" ? "厂商" : type === "label" ? "厂牌" : type === "director" ? "导演" : "系列";
  const limitMatch = query.match(/(?:前\s*|top\s*)(\d{1,2})|(?:列出|给我|給我)?[^\d]{0,5}(\d{1,2})\s*(?:个|個|项|項)/iu);
  const limit = Math.min(20, Math.max(1, Number(limitMatch?.[1] ?? limitMatch?.[2] ?? 10)));
  const relatedMaker = type === "label" || type === "series"
    ? query.match(/(?:属于|屬於|隶属|隸屬|归属|歸屬)\s*([^的，。？?\n]{2,40})\s*的?\s*(?:厂牌|廠牌|品牌|レーベル)/u)?.[1]
      ?? query.match(/(?:属于|屬於|隶属|隸屬|归属|歸屬)\s*([^的，。？?\n]{2,40})\s*的?\s*(?:系列|主题)/u)?.[1]
      ?? query.match(/([^，。？?\n]{2,40})\s*(?:旗下|所属|所屬)(?:有|的)?(?:哪些|什么|什麼)?\s*(?:厂牌|廠牌|品牌|レーベル|系列|主题)/u)?.[1]
      ?? (type === "series"
        ? query.match(/([^，。？?\n]{2,40})\s*(?:有(?:哪些|什么|什麼)|的)\s*(?:系列|主题)/u)?.[1]
        : undefined)
    : undefined;
  if (relatedMaker?.trim()) {
    const filterValue = relatedMaker.trim();
    return { type, metric: "related_maker", filterValue, order: "desc", limit,
      title: `${filterValue} 旗下${label}`, metricLabel: "所属厂商" };
  }
  const headquarters = type === "director" ? undefined
    : query.match(/(?:总部|總部)(?:位于|位於|在)?\s*([^的，。？?\n]{2,20})\s*的?\s*(?:厂商|廠商|厂家|メーカー|厂牌|廠牌|品牌)/u)?.[1]?.trim();
  if (headquarters) {
    return { type, metric: "headquarters", filterValue: headquarters, order: "desc", limit,
      title: `总部位于${headquarters}的${label}`, metricLabel: "总部" };
  }
  const country = type === "director" ? undefined
    : query.match(/(?:位于|位於|来自|來自)?\s*(日本|日本国|Japan)\s*(?:的)?\s*(?:厂商|廠商|厂家|メーカー|厂牌|廠牌|品牌|系列)/iu)?.[1];
  if (country) {
    return { type, metric: "country", filterValue: country, order: "desc", limit,
      title: `${country}的${label}`, metricLabel: "国家" };
  }
  if (type !== "director" && /母公司/u.test(query) && /哪些|有|具备|具備|列出|排行|排名/u.test(query)) {
    const parent = query.match(/母公司(?:是|为|為)\s*([^的，。？?\n]{2,40})\s*的/u)?.[1]?.trim();
    return { type, metric: "parent_organization", ...(parent ? { filterValue: parent } : {}), order: "desc", limit,
      title: parent ? `母公司为${parent}的${label}` : `已有母公司资料的${label}`, metricLabel: "母公司" };
  }
  if (type !== "director" && /(成立|创立|創立|设立|設立|创建|創建|创办|創辦|历史|歷史)/u.test(query)
    && /(最早|最晚|最久|排行|排名|前\s*\d+|top\s*\d+)/iu.test(query)) {
    const latest = /最晚|最新成立/u.test(query);
    return { type, metric: "inception", order: latest ? "desc" : "asc", limit,
      title: `${label}成立时间${latest ? "从晚到早" : "从早到晚"}`, metricLabel: "成立时间" };
  }
  if (/官网|官方网站|官方網站/u.test(query) && /哪些|有|具备|具備|列出|排行|排名/u.test(query)) {
    return { type, metric: "official_website", order: "desc", limit,
      title: `已有官方网站的${label}`, metricLabel: "官网" };
  }
  if (/(?:Wikipedia|Wiki|维基|維基)/iu.test(query) && /哪些|有|具备|具備|列出|排行|排名/u.test(query)) {
    return { type, metric: "wikipedia", order: "desc", limit,
      title: `已有 Wikipedia 档案的${label}`, metricLabel: "Wikipedia" };
  }
  if (/(?:照片|图片|圖片|头像|頭像)/u.test(query) && /哪些|有|具备|具備|列出|排行|排名/u.test(query)) {
    return { type, metric: "image", order: "desc", limit,
      title: `已有可展示图片的${label}`, metricLabel: "图片" };
  }
  if (/(资料|資料|档案|檔案).*(最完整|完整度|最全)|(?:最完整|完整度).*(资料|資料|档案|檔案)/u.test(query)) {
    return { type, metric: "completeness", order: "desc", limit,
      title: `${label}公开资料完整度`, metricLabel: "资料项" };
  }
  if (/(哪些|列出|汇总|彙總).*(公开资料|公開資料|公开档案|公開檔案)|(?:公开资料|公開資料|公开档案|公開檔案).*(哪些|列表|排行)/u.test(query)) {
    return { type, metric: "public_profile", order: "desc", limit,
      title: `已有公开资料的${label}`, metricLabel: "馆藏作品" };
  }
  return null;
}

export function parseEntityRankingQuery(query: string): EntityRankingRequest | null {
  if (!/(最多|最少|排行|排名|前\s*\d+|top\s*\d+)/iu.test(query)) return null;
  if (/(拥有最多|最多).{0,8}(标签|题材)|(?:标签|题材).{0,8}(演员|女优|女優)/u.test(query)) return null;
  const groupBy: AggregateLibraryInput["groupBy"] | null = /厂商|廠商|厂家|メーカー/u.test(query) ? "maker"
    : /厂牌|廠牌|品牌|レーベル/u.test(query) ? "label"
    : /导演|導演|監督/u.test(query) ? "director"
    : /番号|前缀|前綴/u.test(query) ? "prefix"
    : /标签|題材|题材/u.test(query) ? "genre"
    : /系列|主题/u.test(query) ? "series"
    : /演员|女优|女優/u.test(query) ? "actor" : null;
  if (!groupBy) return null;
  const limitMatch = query.match(/(?:前\s*|top\s*)(\d{1,2})/iu);
  const limit = Math.min(20, Math.max(1, Number(limitMatch?.[1] ?? 10)));
  const ascending = /最少|从少到多|由少到多/u.test(query);
  const metric: AggregateLibraryInput["metric"] = /时长|時長|总时长|總時長/u.test(query) ? "duration_sum"
    : /看完|已看完|完成观看/u.test(query) ? "completed_count" : "unique_media_count";
  const metricLabel = metric === "duration_sum" ? "分钟" : "部作品";
  return {
    groupBy,
    metric,
    order: ascending ? "asc" : "desc",
    limit,
    title: `${AGGREGATE_GROUP_LABELS[groupBy]}${metric === "duration_sum" ? "累计时长" : metric === "completed_count" ? "已看完作品" : "馆藏作品数"}${ascending ? "从少到多" : "排行"}`,
    metricLabel
  };
}

export function parseActorProfileRankingQuery(query: string): ActorProfileRankingRequest | null {
  if (!/(?:演员|女优|女優|哪些人|谁|誰)/u.test(query)) return null;
  const limitMatch = query.match(/(?:前\s*|top\s*)(\d{1,2})|(?:最年轻|最年长|最高|最矮|最大)?[^\d]{0,4}(\d{1,2})\s*(?:位|名)(?:演员|女优|女優)/iu);
  const limit = Math.min(20, Math.max(1, Number(limitMatch?.[1] ?? limitMatch?.[2] ?? 10)));
  const heightRange = query.match(/身高\s*(\d{3})(?:\s*(?:cm|厘米|公分))?\s*(以上|及以上|以下|及以下)/iu);
  const birthAfter = query.match(/(19\d{2}|20\d{2})\s*年\s*(及以后|以后|之后|后)出生/u);
  const birthBefore = query.match(/(19\d{2}|20\d{2})\s*年\s*(及以前|以前|之前|前)出生/u);
  if (/(缺少|缺失|没有|沒有|暂无|暫無|不完整|待补全|待補全)/u.test(query)) {
    const missingFields = [
      ...(/生日|出生日期/u.test(query) ? ["birth_date" as const] : []),
      ...(/身高/u.test(query) ? ["height" as const] : []),
      ...(/三围|三圍/u.test(query) ? ["measurements" as const] : []),
      ...(/罩杯/u.test(query) ? ["cup" as const] : []),
      ...(/简介|簡介|人物介绍|人物介紹/u.test(query) ? ["biography" as const] : []),
      ...(/图片|圖片|照片|头像|頭像/u.test(query) ? ["image" as const] : []),
      ...(/wiki|维基|維基|wikipedia/iu.test(query) ? ["wikipedia" as const] : []),
      ...(/官网|官方网站|官方網站/u.test(query) ? ["official_website" as const] : [])
    ];
    const missingFieldLabels: Record<(typeof missingFields)[number], string> = {
      birth_date: "生日", height: "身高", measurements: "完整三围", cup: "罩杯",
      biography: "简介", image: "图片", wikipedia: "Wikipedia", official_website: "官网"
    };
    return {
      metric: "missing_fields", order: "desc", limit,
      ...(missingFields.length ? { missingFields } : {}),
      title: missingFields.length ? `缺少${missingFields.map((field) => missingFieldLabels[field]).join("或")}的演员` : "演员公开资料缺口",
      metricLabel: "缺失项"
    };
  }
  if ((/身高/u.test(query) && /(最高|最低|最矮|排行|排名|以上|以下|前\s*\d+|top)/iu.test(query)) ||
    /最矮.{0,4}(?:演员|女优|女優)/u.test(query)) {
    const ascending = /(最低|最矮)/u.test(query);
    return {
      metric: "height", order: ascending ? "asc" : "desc", limit,
      ...(heightRange?.[2].includes("以上") ? { minHeightCm: Number(heightRange[1]) } : {}),
      ...(heightRange?.[2].includes("以下") ? { maxHeightCm: Number(heightRange[1]) } : {}),
      title: heightRange ? `身高 ${heightRange[1]} cm ${heightRange[2]}的演员` : `演员身高${ascending ? "从低到高" : "排行"}`,
      metricLabel: "cm"
    };
  }
  if (/(最年轻|年龄最小|年纪最小|最年长|年龄最大|年纪最大)/u.test(query) || birthAfter || birthBefore) {
    const oldest = /(最年长|年龄最大|年纪最大)/u.test(query);
    return {
      metric: "birth_date", order: oldest ? "asc" : "desc", limit,
      ...(birthAfter ? { birthYearFrom: Number(birthAfter[1]) + (birthAfter[2] === "后" ? 1 : 0) } : {}),
      ...(birthBefore ? { birthYearTo: Number(birthBefore[1]) - (birthBefore[2] === "前" ? 1 : 0) } : {}),
      title: birthAfter ? `${birthAfter[1]} 年后出生的演员` : birthBefore ? `${birthBefore[1]} 年前出生的演员` : `${oldest ? "年长" : "年轻"}演员排行`,
      metricLabel: "出生日期"
    };
  }
  if (/(罩杯).*(最大|最高|排行|排名)|(?:最大|最高).*(罩杯)/u.test(query)) return {
    metric: "cup", order: "desc", limit, title: "演员罩杯资料排行", metricLabel: "罩杯"
  };
  if (/(胸围|胸圍|胸部).*(最大|排行|排名)|(?:最大).*(胸围|胸圍)/u.test(query)) return {
    metric: "bust", order: "desc", limit, title: "演员胸围资料排行", metricLabel: "cm"
  };
  if (/(完整三围|完整三圍|有三围|有三圍|三围资料|三圍資料)/u.test(query)) return {
    metric: "measurements", order: "desc", limit, title: "已收录完整三围的演员", metricLabel: "部作品"
  };
  if (/(?:wiki|维基|維基|wikipedia)/iu.test(query) && /哪些|有|具备|具備|列出|排行|排名/u.test(query)) return {
    metric: "wikipedia", order: "desc", limit, title: "已有 Wikipedia 档案的演员", metricLabel: "馆藏作品"
  };
  if (/(?:图片|圖片|照片|头像|頭像)/u.test(query) && /哪些|有|具备|具備|列出|排行|排名/u.test(query)) return {
    metric: "image", order: "desc", limit, title: "已有可展示头像的演员", metricLabel: "馆藏作品"
  };
  if (/(?:官网|官方网站|官方網站)/u.test(query) && /哪些|有|具备|具備|列出|排行|排名/u.test(query)) return {
    metric: "official_website", order: "desc", limit, title: "已有官方网站的演员", metricLabel: "馆藏作品"
  };
  if (/(?:简介|簡介|人物介绍|人物介紹)/u.test(query) && /哪些|有|具备|具備|列出|排行|排名/u.test(query)) return {
    metric: "biography", order: "desc", limit, title: "已有公开简介的演员", metricLabel: "馆藏作品"
  };
  if (/(资料|資料).*(最完整|完整度|最全)|(?:最完整|完整度).*(资料|資料)/u.test(query)) return {
    metric: "completeness", order: "desc", limit, title: "演员公开资料完整度", metricLabel: "项"
  };
  return null;
}

export function parseActorProfileMediaQuery(query: string): ActorProfileMediaRequest | null {
  if (!/(推荐|推薦|找|筛选|篩選|影片|作品|片单|片單|电影|電影)/u.test(query)) return null;
  const mediaLimitMatch = query.match(/(?:推荐|推薦|找|给我|給我|筛选|篩選)[^\d]{0,8}(\d{1,2})\s*部/u);
  const mediaLimit = Math.min(18, Math.max(1, Number(mediaLimitMatch?.[1] ?? 12)));
  const rankingInput: Partial<ActorProfileRankingInput> = { limit: 8 };
  const titleParts: string[] = [];
  const height = query.match(/身高\s*(\d{3})(?:\s*(?:cm|厘米|公分))?\s*(以上|及以上|以下|及以下)/iu);
  if (height) {
    const threshold = Number(height[1]);
    const above = height[2].includes("以上");
    rankingInput.metric = "height";
    rankingInput.order = above ? "desc" : "asc";
    if (above) rankingInput.minHeightCm = threshold;
    else rankingInput.maxHeightCm = threshold;
    titleParts.push(`身高 ${threshold} cm ${height[2]}`);
  }
  const birthAfter = query.match(/(19\d{2}|20\d{2})\s*年\s*(及以后|以后|之后|后)出生/u);
  const birthBefore = query.match(/(19\d{2}|20\d{2})\s*年\s*(及以前|以前|之前|前)出生/u);
  if (birthAfter || birthBefore) {
    const match = birthAfter ?? birthBefore!;
    const boundaryYear = Number(match[1]);
    const isAfter = Boolean(birthAfter);
    const adjustedYear = boundaryYear + (isAfter && match[2] === "后" ? 1 : !isAfter && match[2] === "前" ? -1 : 0);
    rankingInput.metric ??= "birth_date";
    rankingInput.order ??= isAfter ? "desc" : "asc";
    if (isAfter) rankingInput.birthYearFrom = adjustedYear;
    else rankingInput.birthYearTo = adjustedYear;
    titleParts.push(`${boundaryYear} 年${match[2]}出生`);
  }
  const bust = query.match(/(?:胸围|胸圍|胸部)\s*(\d{2,3})(?:\s*(?:cm|厘米|公分))?\s*(以上|及以上|以下|及以下)/iu);
  if (bust) {
    const threshold = Number(bust[1]);
    const above = bust[2].includes("以上");
    rankingInput.metric ??= "bust";
    rankingInput.order ??= above ? "desc" : "asc";
    if (above) rankingInput.minBustCm = threshold;
    else rankingInput.maxBustCm = threshold;
    titleParts.push(`胸围 ${threshold} cm ${bust[2]}`);
  }
  const cup = query.match(/([A-K]{1,2}\+*)\s*杯\s*(以上|及以上|以下|及以下|左右|的)?/iu);
  if (cup) {
    const cupLabel = cup[1].toUpperCase();
    const threshold = actorCupRank(cupLabel);
    const qualifier = cup[2] ?? "的";
    const above = qualifier.includes("以上");
    const below = qualifier.includes("以下");
    rankingInput.metric ??= "cup";
    rankingInput.order ??= below ? "asc" : "desc";
    if (above) rankingInput.minCupRank = threshold;
    else if (below) rankingInput.maxCupRank = threshold;
    else {
      rankingInput.minCupRank = threshold;
      rankingInput.maxCupRank = threshold;
    }
    titleParts.push(`${cupLabel} 杯${qualifier === "的" ? "" : qualifier}`);
  }
  if (!rankingInput.metric || !rankingInput.order || !titleParts.length) return null;
  return {
    rankingInput: rankingInput as ActorProfileRankingInput,
    title: `${titleParts.join("、")}演员的馆藏作品`,
    mediaLimit
  };
}

export function parseActorProfileGenreRecommendationQuery(query: string): ActorProfileGenreRecommendationRequest | null {
  if (!/(?:演员|演員|女优|女優|哪些人|谁|誰)/u.test(query)) return null;
  if (!/(?:重口|重口味|硬核|极端题材|極端題材|大尺度素材)/u.test(query)) return null;
  const heightRange = query.match(/身高\s*(\d{3})(?:\s*(?:cm|厘米|公分))?\s*(以上|及以上|以下|及以下)/iu);
  const qualitativeHeight = /高身高|高个(?:子)?|高個(?:子)?|高挑|身材高/u.test(query);
  if (!heightRange && !qualitativeHeight) return null;
  const above = !heightRange || heightRange[2].includes("以上");
  const threshold = heightRange ? Number(heightRange[1]) : 165;
  const countMatch = query.match(/(?:推荐|推薦|列出|找|给我|給我)?[^\d]{0,6}(\d{1,2})\s*(?:位|名|个|個)(?:演员|演員|女优|女優)?/u);
  const limit = Math.min(12, Math.max(1, Number(countMatch?.[1] ?? 6)));
  return {
    rankingInput: {
      metric: "height",
      order: above ? "desc" : "asc",
      ...(above ? { minHeightCm: threshold } : { maxHeightCm: threshold }),
      limit: 200
    },
    genreGroup: "heavy-content",
    genreLabels: [...HEAVY_CONTENT_GENRE_LABELS],
    title: `${heightRange ? `身高 ${threshold} cm ${heightRange[2]}` : `身高至少 ${threshold} cm`}，且有重口题材馆藏证据的演员`,
    limit
  };
}

type ActorProfileGenreCandidate = {
  value: string;
  label: string;
  originalName?: string;
  imageUrl?: string;
  coverMediaId?: string;
  heightCm: number;
  mediaCount: number;
  matchedMediaCount: number;
  matchedGenres: Array<{ label: string; mediaCount: number }>;
};

function variationNoise(value: string, seed?: number): number {
  if (seed == null) return 0;
  let hash = seed | 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619);
  }
  return ((hash >>> 0) % 10_000) / 10_000;
}

function recommendActorsByProfileAndGenres(
  request: ActorProfileGenreRecommendationRequest,
  options: { variationSeed?: number; excludeEntityValues?: string[] }
): { candidates: ActorProfileGenreCandidate[]; profileTotal: number; eligibleProfileTotal: number; matchedProfileTotal: number } {
  const profiles = rankActorProfiles(request.rankingInput, 200);
  const profileAliasRows = db.prepare(`
    SELECT facet_value AS value, aliases_json AS aliasesJson
    FROM entity_profiles
    WHERE facet_type = 'actor'
      AND facet_value IN (SELECT CAST(value AS TEXT) FROM json_each(@valuesJson))
  `).all({ valuesJson: JSON.stringify(profiles.rows.map((row) => row.value)) }) as Array<{
    value: string;
    aliasesJson: string;
  }>;
  const aliasesByValue = new Map(profileAliasRows.map((row) => [row.value, parseList(row.aliasesJson)]));
  const candidateProfiles = profiles.rows.map((row) => {
    return {
      value: row.value,
      label: row.label,
      mediaCount: row.mediaCount,
      heightCm: Number(row.metricValue),
      aliases: [...new Set([row.value, ...(aliasesByValue.get(row.value) ?? [])]
        .map((value) => value.trim()).filter(Boolean))]
    };
  });
  if (!candidateProfiles.length) return {
    candidates: [], profileTotal: profiles.profileTotal, eligibleProfileTotal: profiles.eligibleTotal, matchedProfileTotal: 0
  };

  const genreRows = db.prepare(`
    SELECT DISTINCT TRIM(CAST(source.value AS TEXT)) AS source,
      TRIM(COALESCE(CAST(translated.value AS TEXT), '')) AS translated
    FROM media_metadata metadata
    JOIN json_each(metadata.genres_json) source
    LEFT JOIN json_each(metadata.genres_zh_json) translated ON translated.key = source.key
    WHERE TRIM(CAST(source.value AS TEXT)) IN (SELECT CAST(value AS TEXT) FROM json_each(@labelsJson))
      OR TRIM(COALESCE(CAST(translated.value AS TEXT), '')) IN (SELECT CAST(value AS TEXT) FROM json_each(@labelsJson))
  `).all({ labelsJson: JSON.stringify(request.genreLabels) }) as Array<{ source: string; translated: string }>;
  const genreAliases = new Set(request.genreLabels);
  const genreDisplayNames = new Map(request.genreLabels.map((label) => [label, label]));
  for (const row of genreRows) {
    if (row.source) {
      genreAliases.add(row.source);
      genreDisplayNames.set(row.source, row.translated || row.source);
    }
    if (row.translated) {
      genreAliases.add(row.translated);
      genreDisplayNames.set(row.translated, row.translated);
    }
  }
  const evidenceRows = db.prepare(`
    WITH candidates AS (
      SELECT json_extract(candidate.value, '$.value') AS profileValue,
        json_extract(candidate.value, '$.aliases') AS aliasesJson
      FROM json_each(@candidatesJson) candidate
    ), candidate_aliases AS (
      SELECT candidates.profileValue,
        TRIM(CAST(alias.value AS TEXT)) AS alias
      FROM candidates, json_each(candidates.aliasesJson) alias
      WHERE TRIM(CAST(alias.value AS TEXT)) != ''
    )
    SELECT DISTINCT candidate_aliases.profileValue,
      genres.facet_value AS genreValue,
      genres.normalized_code AS normalizedCode,
      media_files.id AS mediaId
    FROM candidate_aliases
    JOIN media_metadata_facets actors
      ON actors.facet_type = 'actor' AND actors.facet_value = candidate_aliases.alias
    JOIN media_metadata_facets genres
      ON genres.normalized_code = actors.normalized_code AND genres.facet_type = 'genre'
    JOIN media_files
      ON media_files.normalized_code = genres.normalized_code AND media_files.media_type = 'video'
    WHERE genres.facet_value IN (SELECT CAST(value AS TEXT) FROM json_each(@genreAliasesJson))
  `).all({
    candidatesJson: JSON.stringify(candidateProfiles.map((candidate) => ({ value: candidate.value, aliases: candidate.aliases }))),
    genreAliasesJson: JSON.stringify([...genreAliases])
  }) as Array<{ profileValue: string; genreValue: string; normalizedCode: string; mediaId: string }>;

  const evidence = new Map<string, {
    mediaIds: Map<string, string>;
    genreMedia: Map<string, Set<string>>;
  }>();
  for (const row of evidenceRows) {
    const group = evidence.get(row.profileValue) ?? { mediaIds: new Map<string, string>(), genreMedia: new Map<string, Set<string>>() };
    group.mediaIds.set(row.normalizedCode, row.mediaId);
    const label = genreDisplayNames.get(row.genreValue) ?? row.genreValue;
    const works = group.genreMedia.get(label) ?? new Set<string>();
    works.add(row.normalizedCode);
    group.genreMedia.set(label, works);
    evidence.set(row.profileValue, group);
  }

  const excluded = new Set(options.excludeEntityValues ?? []);
  const prepared = candidateProfiles.flatMap((candidate): ActorProfileGenreCandidate[] => {
    const group = evidence.get(candidate.value);
    if (!group?.mediaIds.size) return [];
    return [{
      value: candidate.value,
      label: candidate.label,
      ...(group.mediaIds.values().next().value ? { coverMediaId: group.mediaIds.values().next().value } : {}),
      heightCm: candidate.heightCm,
      mediaCount: candidate.mediaCount,
      matchedMediaCount: group.mediaIds.size,
      matchedGenres: [...group.genreMedia.entries()]
        .map(([label, works]) => ({ label, mediaCount: works.size }))
        .sort((left, right) => right.mediaCount - left.mediaCount || left.label.localeCompare(right.label, "zh-CN"))
    }];
  });
  const relevance = (candidate: ActorProfileGenreCandidate) =>
    Math.log1p(candidate.matchedMediaCount) * 24 + candidate.matchedGenres.length * 3 + candidate.heightCm * 0.15
      + variationNoise(candidate.value, options.variationSeed) * 18;
  const sorted = [...prepared].sort((left, right) => relevance(right) - relevance(left)
    || right.heightCm - left.heightCm || left.label.localeCompare(right.label, "zh-CN"));
  const preferred = sorted.filter((candidate) => !excluded.has(candidate.value));
  const candidatePool = preferred.length >= request.limit
    ? preferred : [...preferred, ...sorted.filter((candidate) => excluded.has(candidate.value))];
  const selected = candidatePool.slice(0, request.limit).map((candidate) => {
    const profile = getEntityExtendedProfile("actor", candidate.value);
    const resolvedProfile = profile ? resolveEntityProfileImageUrl(profile) ?? profile : null;
    const originalName = resolvedProfile?.originalName && resolvedProfile.originalName !== candidate.label
      ? resolvedProfile.originalName : candidate.value !== candidate.label ? candidate.value : undefined;
    return {
      ...candidate,
      ...(originalName ? { originalName } : {}),
      ...(resolvedProfile?.imageUrl ? { imageUrl: resolvedProfile.imageUrl } : {})
    };
  });
  return {
    candidates: selected,
    profileTotal: profiles.profileTotal,
    eligibleProfileTotal: profiles.eligibleTotal,
    matchedProfileTotal: prepared.length
  };
}

function searchMediaByActorProfiles(request: ActorProfileMediaRequest, excludeMediaIds: string[] = []): {
  profiles: ReturnType<typeof rankActorProfiles>;
  items: AgentCitation[];
} {
  const profiles = rankActorProfiles(request.rankingInput);
  const perActor = profiles.rows.map((row) => {
    const profile = getEntityExtendedProfile("actor", row.value);
    const aliases = [...new Set([
      row.value,
      ...(profile?.aliases ?? []),
      ...resolveEntityInsightAliases("actor", row.value)
    ].filter(Boolean))].slice(0, 24);
    return searchMedia({
      actors: aliases,
      watched: "any",
      sort: "recent",
      limit: Math.min(4, request.mediaLimit),
      excludeMediaIds
    });
  });
  const items: AgentCitation[] = [];
  const seen = new Set<string>();
  for (let index = 0; items.length < request.mediaLimit; index += 1) {
    let added = false;
    for (const actorItems of perActor) {
      const item = actorItems[index];
      if (!item || seen.has(item.mediaId)) continue;
      items.push({ ...item, score: Math.max(0.5, 1 - items.length * 0.01) });
      seen.add(item.mediaId);
      added = true;
      if (items.length >= request.mediaLimit) break;
    }
    if (!added) break;
  }
  return { profiles, items };
}

export function buildDeterministicTurn(
  query: string,
  sourceContext: AgentEntryContext | null = null,
  options: { variationSeed?: number; excludeMediaIds?: string[]; excludeEntityValues?: string[] } = {}
): {
  answer: string;
  citations: AgentCitation[];
  presentations: AgentPresentation[];
  state: AgentTurnState;
  toolName: string;
  toolArguments: Record<string, unknown>;
  resultCount: number;
} | null {
  const profileGenreRequest = parseActorProfileGenreRecommendationQuery(query);
  if (profileGenreRequest) {
    const result = recommendActorsByProfileAndGenres(profileGenreRequest, options);
    const presentation: Extract<AgentPresentation, { kind: "entity-cards" }> = {
      kind: "entity-cards",
      title: profileGenreRequest.title,
      subtitle: "身高公开档案 × 实际出演标签交集 · 可重新生成换一批",
      items: result.candidates.map((candidate) => ({
        type: "actor",
        value: candidate.value,
        label: candidate.label,
        ...(candidate.originalName ? { originalName: candidate.originalName } : {}),
        ...(candidate.imageUrl ? { imageUrl: candidate.imageUrl } : {}),
        ...(candidate.coverMediaId ? { coverMediaId: candidate.coverMediaId } : {}),
        mediaCount: candidate.mediaCount,
        reason: `身高 ${candidate.heightCm} cm · ${candidate.matchedMediaCount} 部重口标签作品`,
        highlights: candidate.matchedGenres.slice(0, 3)
          .map((genre) => `${genre.label} · ${genre.mediaCount} 部`)
      }))
    };
    const list = result.candidates.map((candidate, index) =>
      `${index + 1}. **${candidate.label}**：身高 ${candidate.heightCm} cm；馆藏中有 ${candidate.matchedMediaCount} 部作品命中${candidate.matchedGenres.slice(0, 4).map((genre) => `「${genre.label}」`).join("、")}标签。`
    ).join("\n");
    return {
      answer: result.candidates.length
        ? `## ${profileGenreRequest.title}\n\n${list}\n\n这里不能从影片元数据推断演员主观上“愿意”拍摄；结果只表示馆藏中存在实际出演记录。高身高按可靠公开档案的 ${profileGenreRequest.rankingInput.minHeightCm ?? profileGenreRequest.rankingInput.maxHeightCm} cm ${profileGenreRequest.rankingInput.minHeightCm != null ? "及以上" : "及以下"}计算，“重口”按明确的硬核、SM/BDSM、拘束调教、肛交灌肠、排尿饮尿、施虐凌辱等标签组取交集，不再只命中“高身高”单一标签。`
        : `当前 ${result.profileTotal} 位可靠演员档案中，有 ${result.eligibleProfileTotal} 位满足身高条件，但没有演员的馆藏作品同时命中当前重口标签组。这里不会把主观“愿意”作为事实推断。`,
      citations: [],
      presentations: result.candidates.length ? [presentation] : [],
      state: createTurnState({
        intent: "recommend",
        include: {
          ...(profileGenreRequest.rankingInput.minHeightCm != null
            ? { minHeightCm: profileGenreRequest.rankingInput.minHeightCm } : {}),
          ...(profileGenreRequest.rankingInput.maxHeightCm != null
            ? { maxHeightCm: profileGenreRequest.rankingInput.maxHeightCm } : {}),
          genres: profileGenreRequest.genreLabels
        },
        sourceContext,
        entities: result.candidates.map((candidate) => ({ type: "actor", value: candidate.value, label: candidate.label }))
      }),
      toolName: "recommend_actors_by_profile_and_genres",
      toolArguments: {
        ...profileGenreRequest.rankingInput,
        genreGroup: profileGenreRequest.genreGroup,
        genreLabels: profileGenreRequest.genreLabels,
        limit: profileGenreRequest.limit
      },
      resultCount: result.candidates.length
    };
  }
  const profileMediaRequest = parseActorProfileMediaQuery(query);
  if (profileMediaRequest) {
    const result = searchMediaByActorProfiles(profileMediaRequest, options.excludeMediaIds ?? []);
    const actors = result.profiles.rows.map((row) => {
      const profile = getEntityExtendedProfile("actor", row.value);
      const input = profileMediaRequest.rankingInput;
      const matchDetails = [
        (input.minHeightCm != null || input.maxHeightCm != null) && profile?.heightCm != null
          ? `身高 ${profile.heightCm} cm` : "",
        (input.birthYearFrom != null || input.birthYearTo != null) && profile?.birthDate
          ? `出生 ${profile.birthDate}` : "",
        (input.minBustCm != null || input.maxBustCm != null) && profile?.measurements.bustCm != null
          ? `胸围 ${profile.measurements.bustCm} cm` : "",
        (input.minCupRank != null || input.maxCupRank != null) && profile?.measurements.cup
          ? `${profile.measurements.cup} 杯` : ""
      ].filter(Boolean);
      return {
        ...row,
        label: getEntityInsightDisplayName("actor", row.value),
        matchDetail: matchDetails.join(" · ") || row.detail
      };
    });
    const actorSummary = actors.slice(0, 8)
      .map((row) => `**${row.label}**（${row.matchDetail}，馆藏 ${row.mediaCount} 部）`).join("、");
    const presentation: AgentPresentation = {
      kind: "media-cards",
      title: profileMediaRequest.title,
      citationNumbers: result.items.map((_, index) => index + 1),
      layout: result.items.length === 1 ? "spotlight" : result.items.length >= 5 ? "compact" : "gallery",
      showMotionPreview: true
    };
    return {
      answer: result.items.length
        ? `## ${profileMediaRequest.title}\n\n匹配的可靠公开档案：${actorSummary}。\n\n已从这些演员的本地馆藏中选出 ${result.items.length} 部近期作品，见下方卡片。筛选只使用已入库的结构化资料，字段缺失者不会参与，也不会由模型猜测。`
        : `当前 ${result.profiles.profileTotal} 位可靠演员档案中，有 ${result.profiles.eligibleTotal} 位符合条件，但本地馆藏没有匹配影片。缺失资料不会由模型猜测。`,
      citations: result.items,
      presentations: result.items.length ? [presentation] : [],
      state: createTurnState({
        intent: /推荐|推薦/u.test(query) ? "recommend" : "search",
        citations: result.items,
        sourceContext,
        entities: actors.map((row) => ({ type: "actor", value: row.value, label: row.label }))
      }),
      toolName: "search_media_by_actor_profile",
      toolArguments: { ...profileMediaRequest.rankingInput, mediaLimit: profileMediaRequest.mediaLimit },
      resultCount: result.items.length
    };
  }
  const requestsEntityMedia = /推荐|推薦|找|筛选|篩選/u.test(query)
    && /影片|作品|片单|片單|电影|電影/u.test(query);
  const selectedMediaEntity = requestsEntityMedia
    ? findExplicitEntityMention(query) ?? findNaturalEntityMention(query)
    : null;
  if (selectedMediaEntity) {
    const result = buildEntityMediaRecommendation(query, selectedMediaEntity, options.excludeMediaIds ?? []);
    const entityLabel = getEntityInsightDisplayName(selectedMediaEntity.type, selectedMediaEntity.value);
    const typeLabel = ENTITY_TYPE_LABELS[selectedMediaEntity.type];
    const presentation: AgentPresentation = {
      kind: "media-cards",
      title: `${typeLabel}「${entityLabel}」推荐影片`,
      citationNumbers: result.items.map((_, index) => index + 1),
      layout: result.items.length === 1 ? "spotlight" : result.items.length >= 5 ? "compact" : "gallery",
      showMotionPreview: true
    };
    const list = result.items.map((item, index) =>
      `- **${item.code} [${index + 1}]** — ${entityMediaRecommendationReason(item)}`).join("\n");
    const includeKey = selectedMediaEntity.type === "actor" ? "actors"
      : selectedMediaEntity.type === "genre" ? "genres"
      : selectedMediaEntity.type === "series" ? "series"
      : selectedMediaEntity.type === "maker" ? "makers"
      : selectedMediaEntity.type === "label" ? "labels"
      : selectedMediaEntity.type === "director" ? "directors" : "prefixes";
    return {
      answer: result.items.length
        ? `已按${typeLabel}「${entityLabel}」${/发行|近期|最近|新作|新片/u.test(query) ? "、发行时间" : ""}${/资料.{0,6}完整|元数据.{0,6}完整/u.test(query) ? "和元数据完整度" : ""}筛选出 ${result.items.length} 部真实馆藏作品。\n\n## 推荐影片\n\n${list}`
        : `馆藏中没有找到符合当前观看、收藏与${typeLabel}「${entityLabel}」条件的影片。`,
      citations: result.items,
      presentations: result.items.length ? [presentation] : [],
      state: createTurnState({
        intent: "recommend",
        citations: result.items,
        include: { [includeKey]: [selectedMediaEntity.value] },
        sourceContext,
        entities: [{ type: selectedMediaEntity.type, value: selectedMediaEntity.value, label: entityLabel }]
      }),
      toolName: "search_media",
      toolArguments: result.toolArguments,
      resultCount: result.items.length
    };
  }
  const entityRecommendation = parseEntityRecommendationQuery(query);
  if (entityRecommendation) {
    const presentation = buildEntityRecommendationPresentation(entityRecommendation, options);
    const typeLabel = ENTITY_RECOMMENDATION_LABELS[entityRecommendation.type];
    const list = presentation.items.map((item, index) =>
      `${index + 1}. **${item.label}** — ${item.reason}${item.highlights.length ? `；关联 ${item.highlights.join("、")}` : ""}`
    ).join("\n");
    return {
      answer: presentation.items.length
        ? `## ${entityRecommendation.title}\n\n${list}\n\n以上结果由本地数据库直接聚合，不依赖单部影片引用；点击卡片可继续查看对应资料、馆藏作品和关联专题。`
        : `当前没有至少关联 3 部馆藏作品、可用于推荐的${typeLabel}子分类。`,
      citations: [],
      presentations: presentation.items.length ? [presentation] : [],
      state: createTurnState({
        intent: "recommend",
        sourceContext,
        entities: presentation.items.map((item) => ({ type: item.type, value: item.value, label: item.label }))
      }),
      toolName: "recommend_entities",
      toolArguments: entityRecommendation,
      resultCount: presentation.items.length
    };
  }
  const profileRankingRequest = parseActorProfileRankingQuery(query);
  if (!profileRankingRequest && /身高|出生|年龄|三围|罩杯|个人资料|演员资料|简介|wiki|维基|社交账号|职业/u.test(query)) {
    const profile = findProfileMention(query);
    const presentation = profile ? entityProfilePresentation(profile) : null;
    if (profile) return {
      answer: profileAnswer(profile),
      citations: [],
      presentations: presentation ? [presentation] : [],
      state: createTurnState({
        intent: "entity", sourceContext,
        entities: [{ type: "actor", value: profile.value, label: profile.displayName }]
      }),
      toolName: "get_entity_profile",
      toolArguments: { type: "actor", value: profile.value },
      resultCount: 1
    };
  }
  if (profileRankingRequest) {
    const { title, metricLabel, ...rankingInput } = profileRankingRequest;
    const result = rankActorProfiles(rankingInput);
    const displayRows = result.rows.map((row) => ({
      ...row,
      label: getEntityInsightDisplayName("actor", row.value)
    }));
    const presentation: AgentPresentation = {
      kind: "entity-ranking",
      title,
      metricLabel,
      scopeLabel: "公开档案聚合",
      rows: displayRows.map((row, index) => ({
        rank: index + 1,
        type: "actor",
        value: row.value,
        label: row.label,
        count: row.mediaCount,
        detail: row.detail
      }))
    };
    const list = displayRows.map((row, index) => `${index + 1}. **${row.label}**：${row.detail}（馆藏 ${row.mediaCount} 部）`).join("\n");
    return {
      answer: result.rows.length
        ? `## ${title}\n\n${list}\n\n以上结果由已入库的 ${result.profileTotal} 位可靠演员公开档案确定计算；其中 ${result.eligibleTotal} 位具备本次查询所需字段。缺失资料不会参与排名，也不会由模型猜测。`
        : `当前 ${result.profileTotal} 位可靠演员公开档案中，没有具备本次查询所需字段的结果。缺失资料不会由模型猜测。`,
      citations: [],
      presentations: result.rows.length ? [presentation] : [],
      state: createTurnState({
        intent: "aggregate", sourceContext,
        entities: displayRows.map((row) => ({ type: "actor", value: row.value, label: row.label }))
      }),
      toolName: "rank_actor_profiles",
      toolArguments: rankingInput,
      resultCount: result.rows.length
    };
  }
  const publicProfileRankingRequest = parsePublicProfileRankingQuery(query);
  if (publicProfileRankingRequest) {
    const { title, metricLabel, ...rankingInput } = publicProfileRankingRequest;
    const result = rankPublicEntityProfiles(rankingInput);
    const presentation: AgentPresentation = {
      kind: "entity-ranking", title, metricLabel, scopeLabel: "公开资料聚合",
      rows: result.rows.map((row, index) => ({ rank: index + 1, type: rankingInput.type,
        value: row.value, label: getEntityInsightDisplayName(rankingInput.type, row.value),
        count: row.mediaCount, detail: row.detail }))
    };
    const list = presentation.rows.map((row) => {
      const rawDetail = row.detail ?? "";
      const detail = rankingInput.metric === "official_website" && rawDetail.startsWith("官网 ")
        ? `官网 \`${rawDetail.slice(3)}\`` : rawDetail;
      return `${row.rank}. **${row.label}**：${detail}（馆藏 ${row.count} 部）`;
    }).join("\n");
    return {
      answer: result.rows.length
        ? `## ${title}\n\n${list}\n\n结果仅使用已入库的结构化公开资料；缺失字段不会由模型补猜。当前共有 ${result.profileTotal} 条可靠${rankingInput.type === "maker" ? "厂商" : rankingInput.type === "label" ? "厂牌" : rankingInput.type === "director" ? "导演" : "系列"}档案，其中 ${result.eligibleTotal} 条满足本次条件。`
        : `当前 ${result.profileTotal} 条可靠公开档案中，没有满足“${title}”所需字段的结果。缺失字段不会由模型补猜。`,
      citations: [], presentations: result.rows.length ? [presentation] : [],
      state: createTurnState({ intent: "aggregate", sourceContext,
        entities: presentation.rows.map((row) => ({ type: row.type, value: row.value, label: row.label })) }),
      toolName: "rank_public_entity_profiles",
      toolArguments: rankingInput,
      resultCount: result.rows.length
    };
  }
  const entityRankingRequest = parseEntityRankingQuery(query);
  if (entityRankingRequest) {
    const { title, metricLabel, ...rankingInput } = entityRankingRequest;
    const result = aggregateLibrary({ filters: {}, ...rankingInput });
    const presentation: AgentPresentation = {
      kind: "distribution-summary",
      title,
      metricLabel,
      total: result.totalWorks,
      rows: result.rows.map((row) => ({
        ...row,
        type: rankingInput.groupBy,
        label: getEntityInsightDisplayName(rankingInput.groupBy as EntityInsightType, row.value)
      }))
    };
    const list = result.rows.map((row, index) =>
      `${index + 1}. **${getEntityInsightDisplayName(rankingInput.groupBy as EntityInsightType, row.value)}**：${row.count.toLocaleString("zh-CN")} ${metricLabel}`
    ).join("\n");
    return {
      answer: result.rows.length
        ? `## ${title}\n\n${list}\n\n以上结果由本地馆藏数据库按唯一番号去重计算，共统计 ${result.totalWorks.toLocaleString("zh-CN")} 部作品。`
        : `当前馆藏没有可用于${title}的结构化数据。`,
      citations: [],
      presentations: result.rows.length ? [presentation] : [],
      state: createTurnState({
        intent: "aggregate", sourceContext,
        entities: result.rows.map((row) => ({ type: rankingInput.groupBy, value: row.value,
          label: getEntityInsightDisplayName(rankingInput.groupBy as EntityInsightType, row.value) }))
      }),
      toolName: "aggregate_library",
      toolArguments: { filters: {}, ...rankingInput },
      resultCount: result.rows.length
    };
  }
  const entityQuestion = /资料|介绍|情况|作品|统计|有哪些|多少|常见|主要|活跃|发行|时长|评分|画像|是什么|是谁|公司|品牌|厂商|厂牌|导演/u.test(query);
  const explicitEntity = entityQuestion ? findExplicitEntityMention(query) ?? findNaturalEntityMention(query) : null;
  if (explicitEntity) {
    const result = getEntityProfile(explicitEntity.type, explicitEntity.value);
    if (result.insights.mediaCount > 0) {
      const profilePresentation = result.extendedProfile ? entityProfilePresentation(result.extendedProfile) : null;
      const presentation: AgentPresentation = {
        kind: "media-cards",
        title: `${ENTITY_TYPE_LABELS[explicitEntity.type]}「${getEntityInsightDisplayName(explicitEntity.type, explicitEntity.value)}」近期作品`,
        citationNumbers: result.items.map((_, index) => index + 1),
        layout: result.items.length >= 5 ? "compact" : "gallery",
        showMotionPreview: true
      };
      return {
        answer: entityInsightAnswer(result),
        citations: result.items,
        presentations: [...(profilePresentation ? [profilePresentation] : []), ...(result.items.length ? [presentation] : [])],
        state: createTurnState({
          intent: "entity", citations: result.items, sourceContext,
          entities: [{ type: explicitEntity.type, value: explicitEntity.value,
            label: getEntityInsightDisplayName(explicitEntity.type, explicitEntity.value) }]
        }),
        toolName: "get_entity_profile",
        toolArguments: explicitEntity,
        resultCount: result.insights.mediaCount
      };
    }
  }
  const codes = extractMentionedCodes(query);
  if (!codes.length && sourceContext?.mediaIds?.length && /这部|这个作品|当前作品|它的|影片信息|详细信息/u.test(query)) {
    const items = searchMedia({ mediaIds: sourceContext.mediaIds, watched: "any", sort: "code", limit: Math.min(6, sourceContext.mediaIds.length), excludeMediaIds: [] });
    const presentation: AgentPresentation = {
      kind: "media-cards",
      title: "当前页面作品",
      citationNumbers: items.map((_, index) => index + 1),
      layout: items.length === 1 ? "spotlight" : items.length >= 5 ? "compact" : "gallery",
      showMotionPreview: true
    };
    return {
      answer: items.length === 1
        ? `当前作品是 **${items[0].code} [1]**。${items[0].actors.length ? `演员为 ${items[0].actors.join("、")}` : "演员资料暂缺"}；${items[0].genres.length ? `题材包括 ${items[0].genres.join("、")}` : "题材资料暂缺"}。`
        : `已读取当前页面中的 ${items.length} 部作品，具体番号和资料见下方卡片。`,
      citations: items,
      presentations: items.length ? [presentation] : [],
      state: createTurnState({ intent: "search", citations: items, include: { mediaIds: sourceContext.mediaIds }, sourceContext }),
      toolName: "search_media",
      toolArguments: { mediaIds: sourceContext.mediaIds },
      resultCount: items.length
    };
  }
  if (codes.length >= 2 && /比较|对比|差异|区别/u.test(query)) {
    const result = compareMedia(codes);
    const answer = result.citations.length === codes.length
      ? `已按馆藏元数据对比 ${result.citations.map((item) => item.code).join("、")}，共有项与差异如下。`
      : `找到 ${result.citations.length} 部可比较作品；未匹配的番号没有加入结果。`;
    return {
      answer,
      citations: result.citations,
      presentations: [result.presentation],
      state: createTurnState({ intent: "compare", citations: result.citations, sourceContext }),
      toolName: "compare_media",
      toolArguments: { codes },
      resultCount: result.citations.length
    };
  }

  const seriesOrPrefix = query.match(/\b([A-Z]{2,12})\s*(?:系列|系)/iu)?.[1]?.toUpperCase();
  if (seriesOrPrefix && /标签|题材|类型|分布|最多|常见|总结/u.test(query)) {
    const toolArguments: AggregateLibraryInput = {
      filters: { prefixes: [seriesOrPrefix] },
      groupBy: "genre",
      metric: "unique_media_count",
      order: "desc",
      limit: 10
    };
    const result = aggregateLibrary(toolArguments);
    const presentation: AgentPresentation = {
      kind: "distribution-summary",
      title: `${seriesOrPrefix} 系列题材分布`,
      metricLabel: "部作品",
      total: result.totalWorks,
      rows: result.rows.map((row) => ({ ...row, type: "genre" as const }))
    };
    const top = result.rows[0];
    return {
      answer: top
        ? `${seriesOrPrefix} 系列共统计 ${result.totalWorks} 部作品，最常见题材是 **${top.label}**（${top.count} 部）。`
        : `馆藏中没有找到可用于统计的 ${seriesOrPrefix} 系列作品。`,
      citations: [],
      presentations: result.rows.length ? [presentation] : [],
      state: createTurnState({ intent: "aggregate", include: { prefixes: [seriesOrPrefix] }, sourceContext }),
      toolName: "aggregate_library",
      toolArguments,
      resultCount: result.rows.length
    };
  }

  if (codes.length === 1 && /是什么|信息|演员|标签|题材|系列|收藏|看过/u.test(query)) {
    const items = searchMedia({ codes, watched: "any", sort: "code", limit: 1, excludeMediaIds: [] });
    const item = items[0];
    if (!item) return {
      answer: `馆藏中没有找到 ${codes[0]}。`,
      citations: [],
      presentations: [],
      state: createTurnState({ intent: "search", include: { codes }, sourceContext }),
      toolName: "search_media",
      toolArguments: { codes },
      resultCount: 0
    };
    const presentation: AgentPresentation = {
      kind: "media-cards",
      title: "馆藏作品",
      citationNumbers: [1],
      layout: "spotlight",
      showMotionPreview: true
    };
    return {
      answer: `**${item.code} [1]**：${item.actors.length ? `演员为 ${item.actors.join("、")}` : "演员资料暂缺"}；${item.genres.length ? `题材包括 ${item.genres.join("、")}` : "题材资料暂缺"}${item.series ? `；系列为 ${item.series}` : ""}。`,
      citations: items,
      presentations: [presentation],
      state: createTurnState({ intent: "search", citations: items, include: { codes }, sourceContext }),
      toolName: "search_media",
      toolArguments: { codes },
      resultCount: 1
    };
  }
  return null;
}
