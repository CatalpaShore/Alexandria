import crypto from "node:crypto";
import { config } from "./config.js";
import { db } from "./db.js";
import { readOllamaResponseError } from "./externalAiRuntime.js";
import { getAgentModelRuntimeProfile } from "./agentModelRuntime.js";
import { getAgentStore } from "./agentStore.js";
import { readFavoriteKeys } from "./favorites.js";
import { expandAgentGenreConcepts, genreMatchesAgentConcept } from "./agentTaxonomy.js";

export type AgentIndexDocumentSource = {
  mediaId: string;
  normalizedCode: string;
  libraryCategory: string;
  titleZh: string;
  titleOriginal: string;
  summaryZh: string;
  summaryOriginal: string;
  actorsZh: string;
  actorsOriginal: string;
  genresZh: string;
  genresOriginal: string;
  seriesZh: string;
  seriesOriginal: string;
  makerZh: string;
  makerOriginal: string;
  labelZh: string;
  labelOriginal: string;
  directorZh: string;
  directorOriginal: string;
  prefix: string;
  releaseDate: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  qualityTag: string;
  variantTags: string;
  sourceUpdatedAt: string;
};

export type AgentCitation = {
  mediaId: string;
  code: string;
  title: string;
  summary: string;
  actors: string[];
  genres: string[];
  series: string;
  maker?: string;
  label?: string;
  director?: string;
  prefix?: string;
  releaseDate?: string;
  durationSeconds?: number | null;
  favorite: boolean;
  completed: boolean;
  lastPlayedAt: string;
  score: number;
  selectionBasis?: "direct" | "profile-fallback";
};

export type AgentPreferenceSignal = {
  dimension: "actor" | "genre" | "series" | "maker" | "label" | "director";
  value: string;
  weight: number;
  confidence: number;
  source: "explicit" | "feedback" | "watch_history" | "favorite" | "query_history";
};

export type AgentUserModelContext = {
  signals: AgentPreferenceSignal[];
};

export type AgentAnalyticsContext = {
  kind: "actor-genre-ranking";
  subject: string;
  totalTaggedWorks: number;
  worksWithActors: number;
  distinctActors: number;
  rows: Array<{ rank: number; value: string; label: string; count: number }>;
};

export type AgentPresentation = {
  kind: "media-cards";
  title: string;
  citationNumbers: number[];
  layout?: "auto" | "spotlight" | "gallery" | "compact";
  showMotionPreview?: boolean;
} | {
  kind: "entity-cards";
  title: string;
  subtitle: string;
  items: Array<{
    type: "actor" | "genre" | "series" | "maker" | "label" | "director" | "prefix";
    value: string;
    label: string;
    originalName?: string;
    imageUrl?: string;
    coverMediaId?: string;
    mediaCount: number;
    latestReleaseDate?: string;
    reason: string;
    highlights: string[];
  }>;
} | {
  kind: "entity-profile-card";
  type: "actor" | "maker" | "label" | "series" | "director";
  value: string;
  label: string;
  originalName?: string;
  imageUrl?: string;
  description?: string;
  status: "verified" | "auto-matched" | "auto-resolved" | "unverified";
  confidence: number;
  sourceCount: number;
  aliases: string[];
  facts: Array<{ label: string; value: string }>;
} | {
  kind: "entity-ranking";
  title: string;
  metricLabel: string;
  scopeLabel?: string;
  rows: Array<{ rank: number; type: "actor" | "maker" | "label" | "series" | "director"; value: string; label: string; count: number; detail?: string }>;
} | {
  kind: "comparison-matrix";
  title: string;
  columns: Array<{ citationNumber: number; mediaId: string; code: string }>;
  rows: Array<{ key: string; label: string; values: string[] }>;
} | {
  kind: "distribution-summary";
  title: string;
  metricLabel: string;
  total: number;
  rows: Array<{ rank: number; type: "genre" | "actor" | "series" | "maker" | "label" | "director" | "prefix" | "release_year"; value: string; label: string; count: number }>;
} | {
  kind: "clarification-question";
  title: string;
  question: string;
  why?: string;
  options: Array<{ id: string; label: string; description?: string }>;
  allowCustom: boolean;
  customPlaceholder?: string;
} | {
  kind: "action-confirmation";
  title: string;
  actionId: string;
  actionType: "create_playlist" | "add_to_playlist" | "set_favorite" | "watch_later";
  description: string;
  media: Array<{ mediaId: string; code: string }>;
  confirmLabel: string;
  status: "awaiting_confirmation" | "executing" | "completed" | "failed" | "cancelled" | "expired";
};

let indexingPromise: Promise<void> | null = null;
const AGENT_INDEX_DOCUMENT_VERSION = 2;
const AGENT_INDEX_BATCH_SIZE = 16;

function parseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

const ignoredPreferenceValues = new Set([
  "高清", "高画质", "单体作品", "独家配信", "样片", "数字马赛克", "4k", "hd", "uncensored"
]);

function normalizePreferenceValue(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("ja");
}

function isUsefulPreferenceValue(value: string): boolean {
  const normalized = normalizePreferenceValue(value);
  return normalized.length >= 2 && !ignoredPreferenceValues.has(normalized);
}

function preferenceSignalKey(signal: Pick<AgentPreferenceSignal, "dimension" | "value">): string {
  return `${signal.dimension}:${normalizePreferenceValue(signal.value)}`;
}

function aggregateInferredPreferenceSignals(
  rows: Array<{ actors: string; genres: string; series: string; maker: string; label: string; director: string }>,
  source: "watch_history" | "favorite",
  limit: number
): AgentPreferenceSignal[] {
  const counts = new Map<string, { dimension: AgentPreferenceSignal["dimension"]; value: string; count: number }>();
  const add = (dimension: AgentPreferenceSignal["dimension"], value: string) => {
    if (!isUsefulPreferenceValue(value)) return;
    const key = `${dimension}:${normalizePreferenceValue(value)}`;
    const current = counts.get(key);
    counts.set(key, { dimension, value: current?.value ?? value.trim(), count: (current?.count ?? 0) + 1 });
  };
  rows.forEach((row) => {
    parseList(row.actors).slice(0, 5).forEach((value) => add("actor", value));
    parseList(row.genres).slice(0, 10).forEach((value) => add("genre", value));
    if (row.series) add("series", row.series);
    if (row.maker) add("maker", row.maker);
    if (row.label) add("label", row.label);
    if (row.director) add("director", row.director);
  });
  const maxCount = Math.max(1, ...[...counts.values()].map((item) => item.count));
  const signals = [...counts.values()]
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value, "zh-CN"))
    .map((item) => ({
      dimension: item.dimension,
      value: item.value,
      weight: Math.min(source === "favorite" ? 0.58 : 0.5,
        (source === "favorite" ? 0.2 : 0.16) + (item.count / maxCount) * 0.34),
      confidence: Math.min(0.82, 0.38 + item.count * 0.09),
      source
    }));
  return selectBoundedPreferenceSignals(signals, limit);
}

export function selectBoundedPreferenceSignals(signals: AgentPreferenceSignal[], limit: number): AgentPreferenceSignal[] {
  const ranked = [...signals].sort((left, right) =>
    Math.abs(right.weight * right.confidence) - Math.abs(left.weight * left.confidence));
  const caps: Record<AgentPreferenceSignal["dimension"], number> = {
    genre: Math.max(1, Math.ceil(limit / 2)),
    actor: Math.max(1, Math.ceil(limit / 3)),
    series: Math.max(1, Math.floor(limit / 4)),
    maker: Math.max(1, Math.floor(limit / 4)),
    label: Math.max(1, Math.floor(limit / 4)),
    director: Math.max(1, Math.floor(limit / 6))
  };
  const counts = { genre: 0, actor: 0, series: 0, maker: 0, label: 0, director: 0 };
  const selected: AgentPreferenceSignal[] = [];
  const addWithinDimensionCap = (signal: AgentPreferenceSignal) => {
    if (selected.length >= limit || counts[signal.dimension] >= caps[signal.dimension]) return;
    selected.push(signal);
    counts[signal.dimension] += 1;
  };

  // Query-derived interests should influence the live model promptly instead of being
  // crowded out by a long watch or feedback history. Keep this reserve deliberately
  // small so explicit negative feedback and durable behavior remain dominant.
  ranked
    .filter((signal) => signal.source === "query_history")
    .slice(0, Math.min(2, limit))
    .forEach(addWithinDimensionCap);
  ranked.filter((signal) => signal.source !== "query_history").forEach(addWithinDimensionCap);
  ranked.filter((signal) => signal.source === "query_history").forEach(addWithinDimensionCap);
  if (selected.length < limit) {
    ranked.forEach((signal) => {
      if (selected.length >= limit || selected.includes(signal)) return;
      selected.push(signal);
    });
  }
  return selected;
}

/** Builds a bounded preference profile; storage or behavior read failures never block a reply. */
export function buildAgentUserModelContext(userId: string): AgentUserModelContext {
  try {
    const explicit = getAgentStore().prepare(`
      SELECT dimension, value, weight, confidence, source
      FROM agent_preferences
      WHERE user_id = ? AND status = 'active'
        AND dimension IN ('actor', 'genre', 'series', 'maker', 'label', 'director')
      ORDER BY ABS(weight) DESC, confidence DESC, updated_at DESC
      LIMIT 24
    `).all(userId) as AgentPreferenceSignal[];
    const recentRows = db.prepare(`
      SELECT CASE WHEN media_metadata.actors_zh_json <> '[]' THEN media_metadata.actors_zh_json ELSE COALESCE(media_metadata.actors_json, '[]') END AS actors,
        CASE WHEN media_metadata.genres_zh_json <> '[]' THEN media_metadata.genres_zh_json ELSE COALESCE(media_metadata.genres_json, '[]') END AS genres,
        COALESCE(NULLIF(media_metadata.series_zh, ''), media_metadata.series, '') AS series,
        COALESCE(NULLIF(media_metadata.maker_zh, ''), media_metadata.maker, '') AS maker,
        COALESCE(NULLIF(media_metadata.label_zh, ''), media_metadata.label, '') AS label,
        COALESCE(NULLIF(media_metadata.director_zh, ''), media_metadata.director, '') AS director
      FROM playback_progress
      JOIN media_files ON media_files.relative_path = playback_progress.relative_path
      LEFT JOIN media_metadata ON media_metadata.normalized_code = media_files.normalized_code
      WHERE media_files.media_type = 'video' AND playback_progress.last_played_at <> ''
      ORDER BY playback_progress.last_played_at DESC
      LIMIT 40
    `).all() as Array<{ actors: string; genres: string; series: string; maker: string; label: string; director: string }>;
    const favorites = [...readFavoriteKeys()];
    const favoriteRows = favorites.length === 0 ? [] : db.prepare(`
      SELECT CASE WHEN media_metadata.actors_zh_json <> '[]' THEN media_metadata.actors_zh_json ELSE COALESCE(media_metadata.actors_json, '[]') END AS actors,
        CASE WHEN media_metadata.genres_zh_json <> '[]' THEN media_metadata.genres_zh_json ELSE COALESCE(media_metadata.genres_json, '[]') END AS genres,
        COALESCE(NULLIF(media_metadata.series_zh, ''), media_metadata.series, '') AS series,
        COALESCE(NULLIF(media_metadata.maker_zh, ''), media_metadata.maker, '') AS maker,
        COALESCE(NULLIF(media_metadata.label_zh, ''), media_metadata.label, '') AS label,
        COALESCE(NULLIF(media_metadata.director_zh, ''), media_metadata.director, '') AS director
      FROM media_files
      LEFT JOIN media_metadata ON media_metadata.normalized_code = media_files.normalized_code
      WHERE media_files.media_type = 'video'
        AND media_files.relative_path IN (SELECT value FROM json_each(?))
      ORDER BY media_files.mtime_ms DESC
      LIMIT 80
    `).all(JSON.stringify(favorites)) as Array<{ actors: string; genres: string; series: string; maker: string; label: string; director: string }>;

    const merged = new Map<string, AgentPreferenceSignal>();
    const inferred = [
      ...aggregateInferredPreferenceSignals(recentRows, "watch_history", 12),
      ...aggregateInferredPreferenceSignals(favoriteRows, "favorite", 12)
    ];
    inferred.forEach((signal) => {
      const key = preferenceSignalKey(signal);
      const current = merged.get(key);
      if (!current || signal.weight * signal.confidence > current.weight * current.confidence) merged.set(key, signal);
    });
    explicit.filter((signal) => isUsefulPreferenceValue(signal.value)).forEach((signal) => {
      merged.set(preferenceSignalKey(signal), signal);
    });
    return {
      signals: selectBoundedPreferenceSignals([...merged.values()], 12)
    };
  } catch {
    return { signals: [] };
  }
}

export function queryRequestsUnwatched(query: string): boolean {
  return /没看|没有观看|还没(?:有)?(?:看|观看)|未看|从未看|尚未观看/u.test(query);
}

export function queryRequestsRecentHistory(query: string): boolean {
  return /最近.*(?:看过|看了|观看|观影)|(?:观看|观影)记录/u.test(query);
}

export function queryRequestsRecommendation(query: string): boolean {
  return /推荐|推薦|挑选|挑選|挑几|挑幾|挑些|片单|片單|选几|選幾|找几部|找幾部|来几部|來幾部|来点|來點|换一批|換一批|看什么|看什麼/u.test(query)
    && !/不要推荐|不要推薦/u.test(query);
}

export function queryUsesPriorRecommendationContext(query: string): boolean {
  return /相似|类似|同类|这类|这些|他们|她们|这些人|上述|上(?:一|个)批|上一版|刚才|继续推荐|再推荐|换一批|按(?:照)?(?:这个|这些|上面)|基于(?:这个|这些|上面)/u.test(query);
}

export function queryRequestsLibraryAnalytics(query: string): boolean {
  return /最多|排行|排名|前\s*[0-9一二三四五六七八九十]+|统计.*演员|演员.*统计/u.test(query);
}

function requestedRankingCount(query: string): number {
  const numeric = query.match(/(?:前|top\s*)(\d{1,2})/iu)?.[1];
  if (numeric) return Math.min(20, Math.max(1, Number(numeric)));
  const chinese = query.match(/前\s*([一二两三四五六七八九十]+)/u)?.[1];
  if (!chinese) return 10;
  const values: Record<string, number> = {
    一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10
  };
  return values[chinese] ?? 10;
}

function queryContainsStructuredValue(query: string, value: string): boolean {
  const normalizedQuery = query.normalize("NFKC").toLocaleLowerCase("ja");
  const normalizedValue = value.normalize("NFKC").trim().toLocaleLowerCase("ja");
  if (!normalizedValue || !normalizedQuery.includes(normalizedValue)) return false;
  if (!/^[a-z0-9][a-z0-9+._-]*$/i.test(normalizedValue)) return true;
  const escaped = normalizedValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "iu").test(normalizedQuery);
}

function findMentionedGenres(query: string, limit = 4): string[] {
  const rows = db.prepare(`
    SELECT genre, COUNT(*) AS mediaCount FROM (
      SELECT DISTINCT TRIM(CAST(value AS TEXT)) AS genre
      FROM media_metadata, json_each(media_metadata.genres_zh_json)
      UNION
      SELECT DISTINCT TRIM(CAST(value AS TEXT)) AS genre
      FROM media_metadata, json_each(media_metadata.genres_json)
    )
    WHERE genre <> '' AND LENGTH(genre) >= 2 AND INSTR(LOWER(@query), LOWER(genre)) > 0
    GROUP BY genre
    ORDER BY LENGTH(genre) DESC, mediaCount DESC, genre COLLATE NOCASE
    LIMIT 32
  `).all({ query: query.normalize("NFKC") }) as Array<{ genre: string; mediaCount: number }>;
  const mentioned = rows
    .filter((row) => queryContainsStructuredValue(query, row.genre))
    .filter((row, index, items) => items.findIndex((candidate) =>
      candidate.genre.normalize("NFKC").toLocaleLowerCase("ja") === row.genre.normalize("NFKC").toLocaleLowerCase("ja")) === index);
  return mentioned
    .filter((row) => !mentioned.some((candidate) => candidate.genre !== row.genre
      && candidate.genre.normalize("NFKC").toLocaleLowerCase("ja").includes(row.genre.normalize("NFKC").toLocaleLowerCase("ja"))))
    .slice(0, limit)
    .map((row) => row.genre);
}

function findMentionedGenre(query: string): string | null {
  return findMentionedGenres(query, 1)[0] ?? null;
}

export function retrieveAgentAnalytics(query: string): AgentAnalyticsContext | null {
  if (!queryRequestsLibraryAnalytics(query) || !/演员/u.test(query)) return null;
  const subject = findMentionedGenre(query);
  const subjectFilter = subject ? `AND (
        EXISTS (SELECT 1 FROM json_each(media_metadata.genres_zh_json) genre WHERE TRIM(CAST(genre.value AS TEXT)) = @subject)
        OR EXISTS (SELECT 1 FROM json_each(media_metadata.genres_json) genre WHERE TRIM(CAST(genre.value AS TEXT)) = @subject)
      )` : "";
  const taggedCte = `
    WITH tagged AS (
      SELECT media_metadata.normalized_code,
        CASE WHEN media_metadata.actors_zh_json <> '[]'
          THEN media_metadata.actors_zh_json ELSE media_metadata.actors_json END AS actor_labels,
        CASE WHEN media_metadata.actors_json <> '[]'
          THEN media_metadata.actors_json ELSE media_metadata.actors_zh_json END AS actor_values
      FROM media_metadata
      WHERE EXISTS (
        SELECT 1 FROM media_files
        WHERE media_files.normalized_code = media_metadata.normalized_code AND media_files.media_type = 'video'
      )
      ${subjectFilter}
    )
  `;
  const stats = db.prepare(`${taggedCte}
    SELECT COUNT(*) AS totalTaggedWorks,
      SUM(CASE WHEN json_array_length(actor_labels) > 0 THEN 1 ELSE 0 END) AS worksWithActors,
      (SELECT COUNT(DISTINCT TRIM(CAST(actor.value AS TEXT)))
        FROM tagged actor_source, json_each(actor_source.actor_labels) actor
        WHERE TRIM(CAST(actor.value AS TEXT)) <> '') AS distinctActors
    FROM tagged
  `).get({ subject }) as { totalTaggedWorks: number; worksWithActors: number; distinctActors: number };
  const limit = requestedRankingCount(query);
  const rows = db.prepare(`${taggedCte}, actor_codes AS (
      SELECT DISTINCT tagged.normalized_code,
        TRIM(CAST(actor_value.value AS TEXT)) AS value,
        COALESCE(NULLIF(TRIM(CAST(actor_label.value AS TEXT)), ''), TRIM(CAST(actor_value.value AS TEXT))) AS label
      FROM tagged
      JOIN json_each(tagged.actor_values) actor_value
      LEFT JOIN json_each(tagged.actor_labels) actor_label ON actor_label.key = actor_value.key
      WHERE TRIM(CAST(actor_value.value AS TEXT)) <> ''
    )
    SELECT MIN(value) AS value, label, COUNT(DISTINCT normalized_code) AS count
    FROM actor_codes
    GROUP BY label
    ORDER BY count DESC, label COLLATE NOCASE
    LIMIT @limit
  `).all({ subject, limit }) as Array<{ value: string; label: string; count: number }>;
  if (rows.length === 0) return null;
  return {
    kind: "actor-genre-ranking",
    subject: subject ?? "全部馆藏",
    totalTaggedWorks: stats.totalTaggedWorks,
    worksWithActors: stats.worksWithActors,
    distinctActors: stats.distinctActors,
    rows: rows.map((row, index) => ({ ...row, rank: index + 1 }))
  };
}

function extractMentionedCodes(query: string): string[] {
  return [...new Set(query.toUpperCase().match(/[A-Z]{2,12}[-_ ]?\d{2,7}(?:-[A-Z])?/g)
    ?.map((value) => value.replace(/[ _]/g, "-")) ?? [])];
}

export function describeAgentIntent(query: string): string {
  const task = queryRequestsLibraryAnalytics(query)
    ? "全库统计"
    : /比较|对比|差异|区别/u.test(query)
    ? "作品比较"
    : queryRequestsRecommendation(query)
      ? "筛选推荐"
      : /找|搜索|查找|检索/u.test(query) ? "馆藏检索" : "馆藏问答";
  const targets = extractMentionedCodes(query);
  const constraints = [
    /收藏/u.test(query) ? "收藏范围" : "",
    queryRequestsUnwatched(query) ? "未观看" : "",
    queryRequestsRecentHistory(query) ? "近期观看" : ""
  ].filter(Boolean);
  return [
    `识别为“${task}”`,
    targets.length > 0 ? `目标作品：${targets.join("、")}` : "",
    constraints.length > 0 ? `限制条件：${constraints.join("、")}` : ""
  ].filter(Boolean).join("；");
}

export function describeAgentReasoning(query: string, citations: AgentCitation[]): string {
  const targets = extractMentionedCodes(query);
  const evidenceCodes = (targets.length > 0 ? targets : citations.slice(0, 4).map((item) => item.code)).join("、");
  const requestedFields = [
    /演员/u.test(query) ? "演员" : "",
    /题材|类型/u.test(query) ? "题材" : "",
    /系列/u.test(query) ? "系列" : "",
    /厂商|制作商/u.test(query) ? "厂商" : "",
    /厂牌|品牌/u.test(query) ? "厂牌" : "",
    /导演/u.test(query) ? "导演" : "",
    /发行|日期|年份/u.test(query) ? "发行日期" : "",
    /时长|分钟/u.test(query) ? "时长" : "",
    /观看|看过|未看/u.test(query) ? "观看状态" : "",
    /收藏/u.test(query) ? "收藏状态" : ""
  ].filter(Boolean);
  const fields = requestedFields.length > 0 ? requestedFields.join("、") : "标题、演员、题材、系列、厂商与厂牌";

  if (queryRequestsLibraryAnalytics(query)) {
    return "使用本地数据库按作品去重后聚合统计，并按数量排序；语义检索结果不参与计数";
  }
  if (/比较|对比|差异|区别/u.test(query)) {
    return `以${evidenceCodes ? ` ${evidenceCodes} ` : "检索到的作品"}为范围，逐项核对${fields}，再归纳共同点与差异`;
  }
  if (queryRequestsRecommendation(query)) {
    const hardFilters = [
      /收藏/u.test(query) ? "收藏" : "",
      queryRequestsUnwatched(query) ? "未观看" : "",
      queryRequestsRecentHistory(query) ? "近期观看" : ""
    ].filter(Boolean);
    return `${hardFilters.length > 0 ? `先应用${hardFilters.join("、")}条件，` : ""}再按${fields}、问题相关性与证据完整度筛选排序`;
  }
  if (/找|搜索|查找|检索/u.test(query)) {
    return `围绕${fields}核对匹配结果，并优先保留与问题直接相关且资料较完整的馆藏条目`;
  }
  return `围绕问题核对${fields}，只采用能够与馆藏引用直接对应的信息形成结论`;
}

export function extractAgentCitationNumbers(answer: string, citationCount: number): number[] {
  return [...new Set([...answer.matchAll(/\[(\d{1,2})]/g)]
    .map((match) => Number(match[1]))
    .filter((number) => number >= 1 && number <= citationCount))];
}

export function extractAgentRecommendationCitationNumbers(answer: string, citationCount: number): number[] {
  const sectionPattern = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*{1,2})?推荐(?:影片|作品|列表|片单)(?:[:：])?(?:\*{1,2})?\s*(?=\n|$)/gimu;
  const sections = [...answer.matchAll(sectionPattern)];
  const lastSection = sections.at(-1);
  if (!lastSection || lastSection.index == null) return [];
  return extractAgentCitationNumbers(answer.slice(lastSection.index + lastSection[0].length), citationCount);
}

function recommendationCitationOccurrences(answer: string, citationCount: number): number[] {
  const sectionPattern = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*{1,2})?推荐(?:影片|作品|列表|片单)(?:[:：])?(?:\*{1,2})?\s*(?=\n|$)/gimu;
  const lastSection = [...answer.matchAll(sectionPattern)].at(-1);
  if (!lastSection || lastSection.index == null) return [];
  return [...answer.slice(lastSection.index + lastSection[0].length).matchAll(/\[(\d{1,2})]/g)]
    .map((match) => Number(match[1]))
    .filter((number) => number >= 1 && number <= citationCount);
}

function requestedRecommendationCount(query: string): number | null {
  const numeric = query.match(/(\d{1,2})\s*部/u)?.[1];
  if (numeric) return Math.min(6, Math.max(1, Number(numeric)));
  const chinese = query.match(/([一二两三四五六])\s*部/u)?.[1];
  if (!chinese) return null;
  return { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6 }[chinese as "一" | "二" | "两" | "三" | "四" | "五" | "六"];
}

export function buildAgentPresentation(
  query: string,
  answer: string,
  citations: AgentCitation[],
  eligibleCitationNumbers: number[],
  analytics: AgentAnalyticsContext | null = null
): AgentPresentation | null {
  if (analytics?.kind === "actor-genre-ranking") {
    return {
      kind: "entity-ranking",
      title: analytics.subject === "全部馆藏" ? "馆藏演员排行" : `“${analytics.subject}”演员排行`,
      metricLabel: "部作品",
      rows: analytics.rows.map((row) => ({ ...row, type: "actor" as const }))
    };
  }
  if (!queryRequestsRecommendation(query)) return null;
  const eligible = new Set(eligibleCitationNumbers);
  const prefersNewSuggestions = queryRequestsRecentHistory(query) && !/重看|再看|看过也可以|重复观看/u.test(query);
  const recommendationSectionNumbers = extractAgentRecommendationCitationNumbers(answer, citations.length);
  const citationNumbers = (recommendationSectionNumbers.length > 0
    ? recommendationSectionNumbers
    : extractAgentCitationNumbers(answer, citations.length))
    .filter((number) => eligible.has(number))
    .filter((number) => !prefersNewSuggestions || (!citations[number - 1].completed && !citations[number - 1].lastPlayedAt))
    .slice(0, requestedRecommendationCount(query) ?? 4);
  if (citationNumbers.length === 0) return null;
  return {
    kind: "media-cards",
    title: queryRequestsRecentHistory(query) ? "根据近期观影推荐" : "推荐影片",
    citationNumbers,
    layout: citationNumbers.length === 1 ? "spotlight" : citationNumbers.length >= 5 ? "compact" : "gallery",
    showMotionPreview: true
  };
}

function getSourceRows(): AgentIndexDocumentSource[] {
  return db.prepare(`
    SELECT media_files.id AS mediaId, media_files.normalized_code AS normalizedCode,
      COALESCE(media_files.library_category, '') AS libraryCategory,
      COALESCE(NULLIF(media_metadata.title_zh, ''), NULLIF(media_metadata.title, ''), media_files.basename) AS titleZh,
      COALESCE(NULLIF(media_metadata.title, ''), media_files.basename) AS titleOriginal,
      COALESCE(media_metadata.summary_zh, '') AS summaryZh,
      COALESCE(media_metadata.summary, '') AS summaryOriginal,
      COALESCE(media_metadata.actors_zh_json, '[]') AS actorsZh,
      COALESCE(media_metadata.actors_json, '[]') AS actorsOriginal,
      COALESCE(media_metadata.genres_zh_json, '[]') AS genresZh,
      COALESCE(media_metadata.genres_json, '[]') AS genresOriginal,
      COALESCE(media_metadata.series_zh, '') AS seriesZh,
      COALESCE(media_metadata.series, '') AS seriesOriginal,
      COALESCE(media_metadata.maker_zh, '') AS makerZh,
      COALESCE(media_metadata.maker, '') AS makerOriginal,
      COALESCE(media_metadata.label_zh, '') AS labelZh,
      COALESCE(media_metadata.label, '') AS labelOriginal,
      COALESCE(media_metadata.director_zh, '') AS directorZh,
      COALESCE(media_metadata.director, '') AS directorOriginal,
      COALESCE(media_files.code_prefix, '') AS prefix,
      COALESCE(media_metadata.release_date, '') AS releaseDate,
      media_files.duration_seconds AS durationSeconds,
      media_files.width AS width,
      media_files.height AS height,
      COALESCE(media_files.quality_tag, '') AS qualityTag,
      COALESCE((SELECT json_group_array(tag) FROM media_variant_tags WHERE media_id = media_files.id), media_files.variant_tags, '[]') AS variantTags,
      MAX(COALESCE(media_files.indexed_at, ''), COALESCE(media_metadata.updated_at, '')) AS sourceUpdatedAt
    FROM media_files
    LEFT JOIN media_metadata ON media_metadata.normalized_code = media_files.normalized_code
    WHERE media_files.media_type = 'video'
    ORDER BY media_files.normalized_code, media_files.id
  `).all() as AgentIndexDocumentSource[];
}

function uniqueTextValues(...groups: string[][]): string[] {
  return [...new Set(groups.flat().map((item) => item.trim()).filter(Boolean))];
}

function pairedText(preferred: string, original: string): string {
  const values = uniqueTextValues([preferred], [original]);
  return values.join(" / ");
}

export function buildAgentIndexDocument(row: AgentIndexDocumentSource): string {
  const actors = uniqueTextValues(parseList(row.actorsZh), parseList(row.actorsOriginal));
  const genres = uniqueTextValues(parseList(row.genresZh), parseList(row.genresOriginal));
  const variants = parseList(row.variantTags);
  const durationMinutes = row.durationSeconds && row.durationSeconds > 0 ? Math.round(row.durationSeconds / 60) : null;
  const resolution = row.width && row.height ? `${row.width}x${row.height}` : "";
  return [
    `馆藏分类: ${row.libraryCategory}`,
    `番号: ${row.normalizedCode}`,
    `标题: ${pairedText(row.titleZh, row.titleOriginal).slice(0, 420)}`,
    `简介: ${pairedText(row.summaryZh, row.summaryOriginal).slice(0, 1_300)}`,
    `演员: ${actors.slice(0, 32).join("、")}`,
    `题材: ${genres.slice(0, 48).join("、")}`,
    `系列: ${pairedText(row.seriesZh, row.seriesOriginal)}`,
    `厂商: ${pairedText(row.makerZh, row.makerOriginal)}`,
    `厂牌: ${pairedText(row.labelZh, row.labelOriginal)}`,
    `导演: ${pairedText(row.directorZh, row.directorOriginal)}`,
    `番号前缀: ${row.prefix}`,
    `发行日期: ${row.releaseDate}`,
    `片长: ${durationMinutes ? `${durationMinutes} 分钟` : ""}`,
    `画质: ${uniqueTextValues([row.qualityTag], [resolution]).join("、")}`,
    `版本: ${variants.join("、")}`
  ].filter((line) => !line.endsWith(": ")).join("\n").slice(0, 2_800);
}

async function embed(input: string[]): Promise<number[][]> {
  const response = await fetch(`${config.externalAi.ollamaUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.externalAi.embeddingModel,
      input,
      truncate: true,
      keep_alive: process.env.OLLAMA_KEEP_ALIVE ?? "2m",
      options: { num_ctx: 4_096 }
    }),
    signal: AbortSignal.timeout(180_000)
  });
  if (!response.ok) throw await readOllamaResponseError(response);
  const body = await response.json() as { embeddings?: number[][] };
  if (!Array.isArray(body.embeddings) || body.embeddings.length !== input.length) {
    throw new Error("Embedding model returned an invalid batch");
  }
  return body.embeddings;
}

function encodeEmbedding(values: number[]): Buffer {
  const buffer = Buffer.allocUnsafe(values.length * 4);
  values.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

function cosineSimilarity(left: number[], right: Buffer): number {
  if (right.byteLength !== left.length * 4) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const rightValue = right.readFloatLE(index * 4);
    dot += left[index] * rightValue;
    leftNorm += left[index] * left[index];
    rightNorm += rightValue * rightValue;
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

export function getAgentIndexStatus() {
  const database = getAgentStore();
  let state = database.prepare(`
    SELECT status, total, indexed, skipped, error, started_at AS startedAt,
      finished_at AS finishedAt, updated_at AS updatedAt, phase, processed,
      heartbeat_at AS heartbeatAt, document_version AS documentVersion
    FROM agent_index_state WHERE id = 1
  `).get() as Record<string, unknown>;
  if (state.status === "running" && !indexingPromise) {
    const interruptedAt = new Date().toISOString();
    database.prepare(`UPDATE agent_index_state SET status = 'interrupted', phase = 'interrupted',
      error = ?, finished_at = COALESCE(finished_at, ?), updated_at = ? WHERE id = 1`)
      .run("上次索引任务已中断，可重新触发并复用已完成的向量", interruptedAt, interruptedAt);
    state = { ...state, status: "interrupted", phase: "interrupted",
      error: "上次索引任务已中断，可重新触发并复用已完成的向量", finishedAt: interruptedAt, updatedAt: interruptedAt };
  }
  const documents = (database.prepare("SELECT COUNT(*) AS count FROM agent_documents WHERE embedding IS NOT NULL").get() as { count: number }).count;
  return { ...state, documents, running: Boolean(indexingPromise) };
}

export function startAgentIndexing(): { started: boolean; status: ReturnType<typeof getAgentIndexStatus> } {
  if (indexingPromise) return { started: false, status: getAgentIndexStatus() };
  indexingPromise = runAgentIndexing().catch(() => undefined).finally(() => { indexingPromise = null; });
  return { started: true, status: getAgentIndexStatus() };
}

async function runAgentIndexing(): Promise<void> {
  const database = getAgentStore();
  const rows = getSourceRows();
  const startedAt = new Date().toISOString();
  database.prepare(`UPDATE agent_index_state SET status = 'running', phase = 'preparing', total = ?, processed = 0,
    indexed = 0, skipped = 0, error = NULL, started_at = ?, finished_at = NULL, heartbeat_at = ?,
    document_version = ?, updated_at = ? WHERE id = 1`)
    .run(rows.length, startedAt, startedAt, AGENT_INDEX_DOCUMENT_VERSION, startedAt);
  let indexed = 0;
  let skipped = 0;
  let processed = 0;
  try {
    for (let offset = 0; offset < rows.length; offset += AGENT_INDEX_BATCH_SIZE) {
      const batchRows = rows.slice(offset, offset + AGENT_INDEX_BATCH_SIZE);
      const pending = batchRows.map((row) => {
        const content = buildAgentIndexDocument(row);
        const hash = crypto.createHash("sha256").update(`${AGENT_INDEX_DOCUMENT_VERSION}\0${content}`).digest("hex");
        const existing = database.prepare(`SELECT content_hash AS hash, embedding_model AS model,
          document_version AS documentVersion, embedding IS NOT NULL AS hasEmbedding
          FROM agent_documents WHERE media_id = ?`)
          .get(row.mediaId) as { hash: string; model: string; documentVersion: number; hasEmbedding: number } | undefined;
        return { row, content, hash, unchanged: existing?.hash === hash
          && existing.model === config.externalAi.embeddingModel
          && existing.documentVersion === AGENT_INDEX_DOCUMENT_VERSION
          && Boolean(existing.hasEmbedding) };
      });
      const changed = pending.filter((item) => !item.unchanged);
      const embeddings = changed.length > 0 ? await embed(changed.map((item) => item.content)) : [];
      const upsert = database.prepare(`
        INSERT INTO agent_documents (media_id, content, content_hash, embedding, embedding_model,
          document_version, source_updated_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(media_id) DO UPDATE SET content = excluded.content, content_hash = excluded.content_hash,
          embedding = excluded.embedding, embedding_model = excluded.embedding_model,
          document_version = excluded.document_version, source_updated_at = excluded.source_updated_at,
          updated_at = excluded.updated_at
      `);
      database.transaction(() => {
        const updatedAt = new Date().toISOString();
        changed.forEach((item, index) => upsert.run(item.row.mediaId, item.content, item.hash,
          encodeEmbedding(embeddings[index]), config.externalAi.embeddingModel, AGENT_INDEX_DOCUMENT_VERSION,
          item.row.sourceUpdatedAt, updatedAt));
      })();
      indexed += changed.length;
      skipped += pending.length - changed.length;
      processed += pending.length;
      const heartbeatAt = new Date().toISOString();
      database.prepare(`UPDATE agent_index_state SET phase = 'embedding', processed = ?, indexed = ?, skipped = ?,
        heartbeat_at = ?, updated_at = ? WHERE id = 1`)
        .run(processed, indexed, skipped, heartbeatAt, heartbeatAt);
    }
    const cleanupAt = new Date().toISOString();
    database.prepare("UPDATE agent_index_state SET phase = 'cleaning', heartbeat_at = ?, updated_at = ? WHERE id = 1")
      .run(cleanupAt, cleanupAt);
    database.exec("CREATE TEMP TABLE IF NOT EXISTS current_agent_media_ids (media_id TEXT PRIMARY KEY); DELETE FROM current_agent_media_ids;");
    const rememberMediaId = database.prepare("INSERT OR IGNORE INTO current_agent_media_ids (media_id) VALUES (?)");
    database.transaction(() => rows.forEach((row) => rememberMediaId.run(row.mediaId)))();
    database.prepare("DELETE FROM agent_documents WHERE NOT EXISTS (SELECT 1 FROM current_agent_media_ids current WHERE current.media_id = agent_documents.media_id)").run();
    database.exec("DROP TABLE current_agent_media_ids");
    const finishedAt = new Date().toISOString();
    database.prepare(`UPDATE agent_index_state SET status = 'ready', phase = 'ready', processed = total,
      finished_at = ?, heartbeat_at = ?, updated_at = ? WHERE id = 1`)
      .run(finishedAt, finishedAt, finishedAt);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Indexing failed";
    try {
      const failedAt = new Date().toISOString();
      database.prepare(`UPDATE agent_index_state SET status = 'failed', phase = 'failed', error = ?,
        finished_at = ?, heartbeat_at = ?, updated_at = ? WHERE id = 1`)
        .run(message, failedAt, failedAt, failedAt);
    } catch {
      // The drive may have been unplugged mid-index.
    }
    throw error;
  }
}

const agentSearchNoise = [
  "用户已通过选择器明确指定", "用户已通过命令明确指定任务", "用户已通过条件标签明确指定",
  "用户已通过", "明确指定", "条件标签", "选择器", "命令", "任务",
  "推荐几部", "找几部", "来几部", "推荐一些", "找一些", "挑选几部",
  "请帮我", "帮我", "给我", "我想看", "我要看", "想看",
  "继续推荐", "再推荐", "推荐", "挑选", "找片", "查找", "搜索", "检索",
  "未观看", "没看过", "还没看", "已观看", "看过", "收藏范围", "收藏",
  "相似作品", "类似作品", "同类作品", "相似", "类似", "同类",
  "相关影片", "相关作品", "影片", "作品", "片单", "电影", "视频",
  "一些", "几部", "几款", "几项", "看看", "来点", "可以", "哪些",
  "包含", "排除", "标签", "题材", "类型", "演员", "系列", "厂商", "厂牌", "导演"
].sort((left, right) => right.length - left.length);

const agentSearchStopTerms = new Set([
  "用户", "通过", "指定", "任务", "条件", "当前", "本地", "馆藏", "我的", "这个", "这些", "上面",
  "intent", "recommend", "search", "genre", "actor", "series", "maker", "label", "director"
]);

export function extractAgentSearchTerms(query: string): string[] {
  const codes = extractMentionedCodes(query);
  if (codes.length > 0) return codes.slice(0, 6);
  let normalized = query.normalize("NFKC").replace(/\/(?:找片|推荐|检索|搜索|比较|统计)\b/giu, " ");
  for (const phrase of agentSearchNoise) normalized = normalized.replaceAll(phrase, " ");
  const terms = normalized.match(/[A-Za-z][A-Za-z0-9+._-]{1,}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々〆ヵヶー・]{2,}/gu) ?? [];
  return [...new Set(terms
    .map((value) => value.replace(/^[的与和及或从中]+|[的与和及或]+$/gu, "").trim())
    .filter((value) => value.length >= 2 && !agentSearchStopTerms.has(value.toLocaleLowerCase("zh-CN"))))]
    .slice(0, 8);
}

function structuredContextFilter(
  entities: Array<{ type: string; value: string; label?: string }>,
  params: Record<string, string | number>
): string {
  const supportedTypes = new Set(["actor", "genre", "series", "maker", "label", "director", "prefix"]);
  const grouped = new Map<string, string[]>();
  entities.filter((entity) => supportedTypes.has(entity.type)).forEach((entity) => {
    const values = [entity.value, entity.label ?? ""]
      .map((value) => value.trim()).filter(Boolean);
    grouped.set(entity.type, [...new Set([...(grouped.get(entity.type) ?? []), ...values])]);
  });
  const jsonColumns: Record<string, string[]> = {
    actor: ["media_metadata.actors_json", "media_metadata.actors_zh_json"],
    genre: ["media_metadata.genres_json", "media_metadata.genres_zh_json"]
  };
  const textColumns: Record<string, string[]> = {
    series: ["media_metadata.series", "media_metadata.series_zh"],
    maker: ["media_metadata.maker", "media_metadata.maker_zh"],
    label: ["media_metadata.label", "media_metadata.label_zh"],
    director: ["media_metadata.director", "media_metadata.director_zh"],
    prefix: ["media_files.code_prefix"]
  };
  const dimensions = [...grouped.entries()].flatMap(([type, values]) => {
    const variants = values.flatMap((value, index) => {
      const key = `context_${type}_${index}`;
      params[key] = value;
      if (jsonColumns[type]) return jsonColumns[type].map((column) =>
        `EXISTS (SELECT 1 FROM json_each(${column}) context_value
          WHERE TRIM(CAST(context_value.value AS TEXT)) = @${key} COLLATE NOCASE)`);
      return (textColumns[type] ?? []).map((column) =>
        `TRIM(COALESCE(${column}, '')) = @${key} COLLATE NOCASE`);
    });
    return variants.length ? [`(${variants.join(" OR ")})`] : [];
  });
  return dimensions.length ? dimensions.join(" AND ") : "1 = 1";
}

function structuredGenreCandidates(
  genres: string[],
  limit = 24,
  contextEntities: Array<{ type: string; value: string; label?: string }> = []
): AgentCitation[] {
  if (genres.length === 0) return [];
  const favorites = readFavoriteKeys();
  const params: Record<string, string | number> = { limit };
  const contextFilter = structuredContextFilter(contextEntities, params);
  const scoreParts = genres.map((genre, index) => {
    params[`genre${index}`] = genre;
    return `CASE WHEN (
      EXISTS (SELECT 1 FROM json_each(media_metadata.genres_json) genre WHERE TRIM(CAST(genre.value AS TEXT)) = @genre${index} COLLATE NOCASE)
      OR EXISTS (SELECT 1 FROM json_each(media_metadata.genres_zh_json) genre WHERE TRIM(CAST(genre.value AS TEXT)) = @genre${index} COLLATE NOCASE)
    ) THEN 1 ELSE 0 END`;
  });
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT media_files.id AS mediaId, media_files.relative_path AS relativePath,
        media_files.normalized_code AS code,
        COALESCE(NULLIF(media_metadata.title_zh, ''), NULLIF(media_metadata.title, ''), media_files.basename) AS title,
        COALESCE(NULLIF(media_metadata.summary_zh, ''), media_metadata.summary, '') AS summary,
        CASE WHEN media_metadata.actors_zh_json <> '[]' THEN media_metadata.actors_zh_json ELSE COALESCE(media_metadata.actors_json, '[]') END AS actors,
        CASE WHEN media_metadata.genres_zh_json <> '[]' THEN media_metadata.genres_zh_json ELSE COALESCE(media_metadata.genres_json, '[]') END AS genres,
        COALESCE(NULLIF(media_metadata.series_zh, ''), media_metadata.series, '') AS series,
        COALESCE(NULLIF(media_metadata.maker_zh, ''), media_metadata.maker, '') AS maker,
        COALESCE(NULLIF(media_metadata.label_zh, ''), media_metadata.label, '') AS label,
        COALESCE(NULLIF(media_metadata.director_zh, ''), media_metadata.director, '') AS director,
        COALESCE(media_files.code_prefix, '') AS prefix,
        COALESCE(playback_progress.completed, 0) AS completed,
        COALESCE(playback_progress.last_played_at, '') AS lastPlayedAt,
        COALESCE(media_metadata.release_date, '') AS releaseDate,
        media_files.duration_seconds AS durationSeconds,
        (${scoreParts.join(" + ")}) AS structuredScore
      FROM media_files
      LEFT JOIN media_metadata ON media_metadata.normalized_code = media_files.normalized_code
      LEFT JOIN playback_progress ON playback_progress.relative_path = media_files.relative_path
      WHERE media_files.media_type = 'video' AND ${contextFilter}
    ) candidates
    WHERE structuredScore > 0
    ORDER BY structuredScore DESC, releaseDate DESC, code
    LIMIT @limit
  `).all(params) as Array<{
    mediaId: string; relativePath: string; code: string; title: string; summary: string;
    actors: string; genres: string; series: string; maker: string; label: string; director: string;
    prefix: string; completed: number; lastPlayedAt: string; releaseDate: string;
    durationSeconds: number | null; structuredScore: number;
  }>;
  return rows.map(({ relativePath, structuredScore, ...row }, index) => ({
    ...row,
    actors: parseList(row.actors),
    genres: parseList(row.genres),
    favorite: favorites.has(relativePath),
    completed: Boolean(row.completed),
    score: 1.6 + structuredScore * 0.35 - index * 0.01
  }));
}

function catalogRecommendationCandidates(limit = 24): AgentCitation[] {
  const favorites = readFavoriteKeys();
  const rows = db.prepare(`
    SELECT media_files.id AS mediaId, media_files.relative_path AS relativePath,
      media_files.normalized_code AS code,
      COALESCE(NULLIF(media_metadata.title_zh, ''), NULLIF(media_metadata.title, ''), media_files.basename) AS title,
      COALESCE(NULLIF(media_metadata.summary_zh, ''), media_metadata.summary, '') AS summary,
      CASE WHEN media_metadata.actors_zh_json <> '[]' THEN media_metadata.actors_zh_json ELSE COALESCE(media_metadata.actors_json, '[]') END AS actors,
      CASE WHEN media_metadata.genres_zh_json <> '[]' THEN media_metadata.genres_zh_json ELSE COALESCE(media_metadata.genres_json, '[]') END AS genres,
      COALESCE(NULLIF(media_metadata.series_zh, ''), media_metadata.series, '') AS series,
      COALESCE(NULLIF(media_metadata.maker_zh, ''), media_metadata.maker, '') AS maker,
      COALESCE(NULLIF(media_metadata.label_zh, ''), media_metadata.label, '') AS label,
      COALESCE(NULLIF(media_metadata.director_zh, ''), media_metadata.director, '') AS director,
      COALESCE(media_files.code_prefix, '') AS prefix,
      COALESCE(media_metadata.release_date, '') AS releaseDate,
      media_files.duration_seconds AS durationSeconds,
      COALESCE(playback_progress.completed, 0) AS completed,
      COALESCE(playback_progress.last_played_at, '') AS lastPlayedAt
    FROM media_files
    LEFT JOIN media_metadata ON media_metadata.normalized_code = media_files.normalized_code
    LEFT JOIN playback_progress ON playback_progress.relative_path = media_files.relative_path
    WHERE media_files.media_type = 'video'
    ORDER BY COALESCE(media_metadata.release_date, '') DESC, media_files.mtime_ms DESC
    LIMIT ?
  `).all(limit) as Array<{
    mediaId: string; relativePath: string; code: string; title: string; summary: string;
    actors: string; genres: string; series: string; maker: string; label: string; director: string;
    prefix: string; releaseDate: string; durationSeconds: number | null; completed: number; lastPlayedAt: string;
  }>;
  return rows.map(({ relativePath, ...row }, index) => ({
    ...row,
    actors: parseList(row.actors),
    genres: parseList(row.genres),
    favorite: favorites.has(relativePath),
    completed: Boolean(row.completed),
    score: 0.7 - index * 0.01
  }));
}

function lexicalCandidates(query: string, limit = 16): AgentCitation[] {
  const favorites = readFavoriteKeys();
  const tokens = extractAgentSearchTerms(query).slice(0, 6);
  if (tokens.length === 0) return [];
  const clauses = tokens.map(() => `(
    media_files.normalized_code LIKE ? OR media_files.basename LIKE ? OR
    media_metadata.title LIKE ? OR media_metadata.title_zh LIKE ? OR
    media_metadata.summary LIKE ? OR media_metadata.summary_zh LIKE ? OR
    media_metadata.actors_json LIKE ? OR media_metadata.actors_zh_json LIKE ? OR
    media_metadata.genres_json LIKE ? OR media_metadata.genres_zh_json LIKE ? OR
    media_metadata.series LIKE ? OR media_metadata.series_zh LIKE ? OR
    media_metadata.maker LIKE ? OR media_metadata.maker_zh LIKE ? OR
    media_metadata.label LIKE ? OR media_metadata.label_zh LIKE ? OR
    media_metadata.director LIKE ? OR media_metadata.director_zh LIKE ? OR
    media_files.code_prefix LIKE ? OR media_metadata.release_date LIKE ?
  )`);
  const params = tokens.flatMap((token) => Array(20).fill(`%${token}%`));
  const rows = db.prepare(`
    SELECT media_files.id AS mediaId, media_files.relative_path AS relativePath, media_files.normalized_code AS code,
      COALESCE(NULLIF(media_metadata.title_zh, ''), NULLIF(media_metadata.title, ''), media_files.basename) AS title,
      COALESCE(NULLIF(media_metadata.summary_zh, ''), media_metadata.summary, '') AS summary,
      CASE WHEN media_metadata.actors_zh_json <> '[]' THEN media_metadata.actors_zh_json ELSE COALESCE(media_metadata.actors_json, '[]') END AS actors,
      CASE WHEN media_metadata.genres_zh_json <> '[]' THEN media_metadata.genres_zh_json ELSE COALESCE(media_metadata.genres_json, '[]') END AS genres,
      COALESCE(NULLIF(media_metadata.series_zh, ''), media_metadata.series, '') AS series,
      COALESCE(NULLIF(media_metadata.maker_zh, ''), media_metadata.maker, '') AS maker,
      COALESCE(NULLIF(media_metadata.label_zh, ''), media_metadata.label, '') AS label,
      COALESCE(NULLIF(media_metadata.director_zh, ''), media_metadata.director, '') AS director,
      COALESCE(media_files.code_prefix, '') AS prefix,
      COALESCE(media_metadata.release_date, '') AS releaseDate,
      media_files.duration_seconds AS durationSeconds,
      COALESCE(playback_progress.completed, 0) AS completed,
      COALESCE(playback_progress.last_played_at, '') AS lastPlayedAt
    FROM media_files
    LEFT JOIN media_metadata ON media_metadata.normalized_code = media_files.normalized_code
    LEFT JOIN playback_progress ON playback_progress.relative_path = media_files.relative_path
    WHERE media_files.media_type = 'video' AND (${clauses.join(" OR ")})
    ORDER BY CASE WHEN media_files.normalized_code = ? THEN 0 ELSE 1 END, media_files.mtime_ms DESC
    LIMIT ?
  `).all(...params, query.trim().toUpperCase(), limit) as Array<{
    mediaId: string; relativePath: string; code: string; title: string; summary: string;
    actors: string; genres: string; series: string; maker: string; label: string; director: string;
    prefix: string; releaseDate: string; durationSeconds: number | null; completed: number; lastPlayedAt: string;
  }>;
  return rows.map(({ relativePath, ...row }, index) => ({
    ...row,
    actors: parseList(row.actors),
    genres: parseList(row.genres),
    favorite: favorites.has(relativePath),
    completed: Boolean(row.completed),
    score: 1 - index * 0.02
  }));
}

function personalStateCandidates(query: string, limit = 24): AgentCitation[] {
  const wantsFavorites = /收藏/u.test(query);
  const wantsUnwatched = queryRequestsUnwatched(query);
  const wantsRecent = queryRequestsRecentHistory(query);
  if (!wantsFavorites && !wantsUnwatched && !wantsRecent) return [];
  const favorites = [...readFavoriteKeys()];
  const conditions = ["media_files.media_type = 'video'"];
  if (wantsFavorites) conditions.push("media_files.relative_path IN (SELECT value FROM json_each(@favorites))");
  if (wantsUnwatched) conditions.push("COALESCE(playback_progress.position_seconds, 0) = 0");
  if (wantsRecent) conditions.push("playback_progress.last_played_at IS NOT NULL");
  const rows = db.prepare(`
    SELECT media_files.id AS mediaId, media_files.relative_path AS relativePath,
      media_files.normalized_code AS code,
      COALESCE(NULLIF(media_metadata.title_zh, ''), NULLIF(media_metadata.title, ''), media_files.basename) AS title,
      COALESCE(NULLIF(media_metadata.summary_zh, ''), media_metadata.summary, '') AS summary,
      CASE WHEN media_metadata.actors_zh_json <> '[]' THEN media_metadata.actors_zh_json ELSE COALESCE(media_metadata.actors_json, '[]') END AS actors,
      CASE WHEN media_metadata.genres_zh_json <> '[]' THEN media_metadata.genres_zh_json ELSE COALESCE(media_metadata.genres_json, '[]') END AS genres,
      COALESCE(NULLIF(media_metadata.series_zh, ''), media_metadata.series, '') AS series,
      COALESCE(NULLIF(media_metadata.maker_zh, ''), media_metadata.maker, '') AS maker,
      COALESCE(NULLIF(media_metadata.label_zh, ''), media_metadata.label, '') AS label,
      COALESCE(NULLIF(media_metadata.director_zh, ''), media_metadata.director, '') AS director,
      COALESCE(media_files.code_prefix, '') AS prefix,
      COALESCE(media_metadata.release_date, '') AS releaseDate,
      media_files.duration_seconds AS durationSeconds,
      COALESCE(playback_progress.completed, 0) AS completed,
      COALESCE(playback_progress.last_played_at, '') AS lastPlayedAt
    FROM media_files
    LEFT JOIN media_metadata ON media_metadata.normalized_code = media_files.normalized_code
    LEFT JOIN playback_progress ON playback_progress.relative_path = media_files.relative_path
    WHERE ${conditions.join(" AND ")}
    ORDER BY COALESCE(playback_progress.last_played_at, '') DESC, media_files.mtime_ms DESC
    LIMIT @limit
  `).all({ favorites: JSON.stringify(favorites), limit }) as Array<{
    mediaId: string; relativePath: string; code: string; title: string; summary: string;
    actors: string; genres: string; series: string; maker: string; label: string; director: string;
    prefix: string; releaseDate: string; durationSeconds: number | null; completed: number; lastPlayedAt: string;
  }>;
  const favoriteSet = new Set(favorites);
  return rows.map(({ relativePath, ...row }, index) => ({
    ...row,
    actors: parseList(row.actors),
    genres: parseList(row.genres),
    favorite: favoriteSet.has(relativePath),
    completed: Boolean(row.completed),
    score: 1.2 - index * 0.01
  }));
}

function candidateMatchesPreference(item: AgentCitation, signal: AgentPreferenceSignal): boolean {
  const expected = normalizePreferenceValue(signal.value);
  if (signal.dimension === "actor") return item.actors.some((value) => normalizePreferenceValue(value) === expected);
  if (signal.dimension === "genre") return item.genres.some((value) => normalizePreferenceValue(value) === expected
    || genreMatchesAgentConcept(value, signal.value));
  if (signal.dimension === "series") return normalizePreferenceValue(item.series) === expected;
  if (signal.dimension === "maker") return normalizePreferenceValue(item.maker ?? "") === expected;
  if (signal.dimension === "label") return normalizePreferenceValue(item.label ?? "") === expected;
  return normalizePreferenceValue(item.director ?? "") === expected;
}

function citationMetadataValues(item: AgentCitation, dimension: AgentPreferenceSignal["dimension"]): string[] {
  if (dimension === "actor") return item.actors;
  if (dimension === "genre") return item.genres;
  if (dimension === "series") return item.series ? [item.series] : [];
  if (dimension === "maker") return item.maker ? [item.maker] : [];
  if (dimension === "label") return item.label ? [item.label] : [];
  return item.director ? [item.director] : [];
}

function extractSelectorConstraints(query: string): Array<{ dimension: AgentPreferenceSignal["dimension"]; value: string }> {
  const dimensions: Record<string, AgentPreferenceSignal["dimension"]> = {
    演员: "actor",
    标签: "genre",
    系列: "series",
    厂商: "maker",
    厂牌: "label",
    导演: "director"
  };
  return [...query.matchAll(/(?:演员|标签|系列|厂商|厂牌|导演)=([^；\n]+)/gu)].flatMap((match) => {
    const label = match[0].slice(0, match[0].indexOf("="));
    const dimension = dimensions[label];
    const value = match[1]?.trim();
    return dimension && value ? [{ dimension, value }] : [];
  });
}

function candidateMatchesSelectorConstraints(item: AgentCitation, query: string): boolean {
  const grouped = new Map<AgentPreferenceSignal["dimension"], string[]>();
  extractSelectorConstraints(query).forEach((constraint) => {
    grouped.set(constraint.dimension, [...(grouped.get(constraint.dimension) ?? []), constraint.value]);
  });
  return [...grouped.entries()].every(([dimension, values]) => citationMetadataValues(item, dimension)
    .some((candidate) => values.some((value) => normalizePreferenceValue(candidate) === normalizePreferenceValue(value))));
}

export function candidateMatchesAgentContextEntities(
  item: AgentCitation,
  entities: Array<{ type: string; value: string; label?: string }>
): boolean {
  const grouped = new Map<string, string[]>();
  entities.forEach((entity) => grouped.set(entity.type, [
    ...(grouped.get(entity.type) ?? []),
    entity.value,
    ...(entity.label && entity.label !== entity.value ? [entity.label] : [])
  ]));
  return [...grouped.entries()].every(([type, values]) => {
    const candidates = type === "prefix" ? item.prefix ? [item.prefix] : []
      : ["actor", "genre", "series", "maker", "label", "director"].includes(type)
        ? citationMetadataValues(item, type as AgentPreferenceSignal["dimension"])
        : [];
    return candidates.some((candidate) => values.some((value) => normalizePreferenceValue(candidate) === normalizePreferenceValue(value)));
  });
}

function explicitMetadataRelevanceBoost(item: AgentCitation, query: string): number {
  const boosts: Record<AgentPreferenceSignal["dimension"], number> = {
    actor: 0.62,
    genre: 0.58,
    series: 0.5,
    maker: 0.56,
    label: 0.54,
    director: 0.56
  };
  return (Object.keys(boosts) as AgentPreferenceSignal["dimension"][]).reduce((total, dimension) => {
    const matched = citationMetadataValues(item, dimension).some((value) => queryContainsStructuredValue(query, value));
    return total + (matched ? boosts[dimension] : 0);
  }, item.prefix && queryContainsStructuredValue(query, item.prefix) ? 0.42 : 0);
}

function metadataCompletenessBoost(item: AgentCitation): number {
  return [
    item.actors.length > 0,
    item.genres.length > 0,
    Boolean(item.series),
    Boolean(item.maker),
    Boolean(item.label),
    Boolean(item.director),
    Boolean(item.releaseDate),
    Boolean(item.summary)
  ].filter(Boolean).length * 0.01;
}

function candidateMatchesStrongNegativePreference(
  item: AgentCitation,
  userModel: AgentUserModelContext,
  query: string
): boolean {
  return userModel.signals.some((signal) => signal.weight <= -0.55 && signal.confidence >= 0.5
    && (signal.source === "explicit" || signal.source === "feedback")
    && !queryContainsStructuredValue(query, signal.value)
    && candidateMatchesPreference(item, signal));
}

export function rankAgentCandidatesByUserModel(
  citations: AgentCitation[],
  userModel: AgentUserModelContext | null
): AgentCitation[] {
  if (!userModel?.signals.length) return citations;
  const dimensionBoost: Record<AgentPreferenceSignal["dimension"], number> = {
    actor: 0.24,
    genre: 0.17,
    series: 0.2,
    maker: 0.16,
    label: 0.15,
    director: 0.18
  };
  return citations.map((item) => ({
    ...item,
    score: item.score + userModel.signals.reduce((total, signal) => candidateMatchesPreference(item, signal)
      ? total + signal.weight * signal.confidence * dimensionBoost[signal.dimension]
      : total, 0)
  })).sort((left, right) => right.score - left.score);
}

export async function retrieveAgentContext(
  query: string,
  limit = 8,
  options: {
    variationSeed?: number;
    excludeMediaIds?: string[];
    contextCitations?: AgentCitation[];
    contextEntities?: Array<{ type: string; value: string; label?: string }>;
    userModel?: AgentUserModelContext | null;
  } = {}
): Promise<AgentCitation[]> {
  const favorites = readFavoriteKeys();
  const wantsRecent = queryRequestsRecentHistory(query);
  const wantsRecommendation = queryRequestsRecommendation(query);
  const wantsRecentRecommendation = wantsRecent && wantsRecommendation;
  const contextCitations = options.contextCitations ?? [];
  const contextEntities = options.contextEntities ?? [];
  const mentionedGenres = findMentionedGenres(query);
  const requestedGenres = [...new Set([...mentionedGenres, ...expandAgentGenreConcepts(query)])];
  const structured = structuredGenreCandidates(requestedGenres, wantsRecommendation ? 96 : 24, contextEntities);
  const lexical = lexicalCandidates(query, 16);
  const personal = personalStateCandidates(query, 24);
  let vector: AgentCitation[] = [];
  try {
    const preferenceSource = contextCitations.length > 0
      ? contextCitations
      : wantsRecentRecommendation ? personal.slice(0, 8) : [];
    const recentPreferenceProfile = preferenceSource.length > 0
      ? preferenceSource.slice(0, 8).map((item) => [
        item.actors.slice(0, 3).join("、"),
        item.genres.slice(0, 6).join("、"),
        item.series,
        item.maker,
        item.label,
        item.director
      ].filter(Boolean).join("｜")).filter(Boolean).join("\n")
      : "";
    const positivePreferences = options.userModel?.signals
      .filter((signal) => signal.weight > 0.15)
      .slice(0, 8)
      .map((signal) => `${signal.dimension}=${signal.value}`)
      .join("、") ?? "";
    const semanticQuery = [
      query,
      recentPreferenceProfile ? `近期观看偏好特征：\n${recentPreferenceProfile}` : "",
      positivePreferences ? `长期偏好特征：${positivePreferences}` : ""
    ].filter(Boolean).join("\n");
    const [queryEmbedding] = await embed([semanticQuery]);
    const documents = getAgentStore().prepare("SELECT media_id AS mediaId, embedding FROM agent_documents WHERE embedding IS NOT NULL").all() as Array<{ mediaId: string; embedding: Buffer }>;
    const topIds = documents
      .map((item) => ({ mediaId: item.mediaId, score: cosineSimilarity(queryEmbedding, item.embedding) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, 16);
    if (topIds.length > 0) {
      const placeholders = topIds.map(() => "?").join(",");
      const scoreById = new Map(topIds.map((item) => [item.mediaId, item.score]));
      const rows = db.prepare(`
        SELECT media_files.id AS mediaId, media_files.relative_path AS relativePath, media_files.normalized_code AS code,
          COALESCE(NULLIF(media_metadata.title_zh, ''), NULLIF(media_metadata.title, ''), media_files.basename) AS title,
          COALESCE(NULLIF(media_metadata.summary_zh, ''), media_metadata.summary, '') AS summary,
          CASE WHEN media_metadata.actors_zh_json <> '[]' THEN media_metadata.actors_zh_json ELSE COALESCE(media_metadata.actors_json, '[]') END AS actors,
          CASE WHEN media_metadata.genres_zh_json <> '[]' THEN media_metadata.genres_zh_json ELSE COALESCE(media_metadata.genres_json, '[]') END AS genres,
          COALESCE(NULLIF(media_metadata.series_zh, ''), media_metadata.series, '') AS series,
          COALESCE(NULLIF(media_metadata.maker_zh, ''), media_metadata.maker, '') AS maker,
          COALESCE(NULLIF(media_metadata.label_zh, ''), media_metadata.label, '') AS label,
          COALESCE(NULLIF(media_metadata.director_zh, ''), media_metadata.director, '') AS director,
          COALESCE(media_files.code_prefix, '') AS prefix,
          COALESCE(media_metadata.release_date, '') AS releaseDate,
          media_files.duration_seconds AS durationSeconds,
          COALESCE(playback_progress.completed, 0) AS completed,
          COALESCE(playback_progress.last_played_at, '') AS lastPlayedAt
        FROM media_files LEFT JOIN media_metadata ON media_metadata.normalized_code = media_files.normalized_code
        LEFT JOIN playback_progress ON playback_progress.relative_path = media_files.relative_path
        WHERE media_files.id IN (${placeholders})
      `).all(...topIds.map((item) => item.mediaId)) as Array<{
        mediaId: string; relativePath: string; code: string; title: string; summary: string; actors: string;
        genres: string; series: string; maker: string; label: string; director: string;
        prefix: string; releaseDate: string; durationSeconds: number | null; completed: number; lastPlayedAt: string;
      }>;
      vector = rows.map(({ relativePath, ...row }) => ({
        ...row,
        actors: parseList(row.actors),
        genres: parseList(row.genres),
        favorite: favorites.has(relativePath),
        completed: Boolean(row.completed),
        score: scoreById.get(row.mediaId) ?? 0
      }));
    }
  } catch {
    // Lexical retrieval remains useful while the embedding model/index is warming up.
  }
  const fallback = wantsRecommendation && requestedGenres.length === 0 && lexical.length === 0
    && personal.length === 0 && vector.length === 0 && contextCitations.length === 0
    ? catalogRecommendationCandidates(96).map((item) => ({ ...item, selectionBasis: "profile-fallback" as const }))
    : [];
  const merged = new Map<string, AgentCitation>();
  const mergeCandidate = (item: AgentCitation) => {
    const current = merged.get(item.mediaId);
    merged.set(item.mediaId, current ? { ...current, score: current.score + item.score } : item);
  };
  personal.forEach(mergeCandidate);
  fallback.forEach(mergeCandidate);
  structured.forEach(mergeCandidate);
  lexical.forEach(mergeCandidate);
  vector.forEach(mergeCandidate);
  const structuredIds = new Set(structured.map((item) => item.mediaId));
  const directEvidenceIds = new Set([...personal, ...fallback, ...structured, ...lexical].map((item) => item.mediaId));
  const vectorScores = new Map(vector.map((item) => [item.mediaId, item.score]));
  const excludedMediaIds = new Set(options.excludeMediaIds ?? []);
  let candidates = [...merged.values()].filter((item) => !excludedMediaIds.has(item.mediaId));
  candidates = candidates
    .filter((item) => candidateMatchesSelectorConstraints(item, query))
    .filter((item) => candidateMatchesAgentContextEntities(item, contextEntities))
    .map((item) => ({
      ...item,
      score: item.score + explicitMetadataRelevanceBoost(item, query) + metadataCompletenessBoost(item)
    }));
  if (requestedGenres.length > 0) candidates = candidates.filter((item) => structuredIds.has(item.mediaId));
  if (/收藏/u.test(query)) candidates = candidates.filter((item) => item.favorite);
  if (queryRequestsUnwatched(query)) {
    candidates = candidates.filter((item) => !item.completed && !item.lastPlayedAt);
  }
  if (wantsRecommendation && options.userModel?.signals.length) {
    candidates = rankAgentCandidatesByUserModel(candidates, options.userModel)
      .filter((item) => !candidateMatchesStrongNegativePreference(item, options.userModel!, query));
  }
  if (wantsRecent && !wantsRecommendation) {
    candidates = candidates.filter((item) => item.lastPlayedAt).sort((left, right) => right.lastPlayedAt.localeCompare(left.lastPlayedAt));
  } else if (wantsRecentRecommendation) {
    const historyContext = candidates
      .filter((item) => item.lastPlayedAt)
      .sort((left, right) => right.lastPlayedAt.localeCompare(left.lastPlayedAt))
      .slice(0, Math.min(3, limit));
    const freshCandidates = candidates
      .filter((item) => !item.completed && !item.lastPlayedAt);
    const selectedFreshCandidates = sampleAgentRecommendationCandidates(
      freshCandidates,
      Math.max(0, limit - historyContext.length),
      options.variationSeed
    );
    return [...historyContext, ...selectedFreshCandidates];
  } else {
    candidates.sort((left, right) => right.score - left.score);
  }
  const bestVectorScore = Math.max(0, ...vectorScores.values());
  const semanticThreshold = wantsRecommendation ? Math.max(0.25, bestVectorScore - 0.18) : 0.5;
  let eligible = candidates
    .filter((item) => directEvidenceIds.has(item.mediaId) || (vectorScores.get(item.mediaId) ?? 0) >= semanticThreshold)
    .filter((item, index, items) => !wantsRecommendation
      || items.findIndex((candidate) => candidate.code === item.code) === index);
  if (wantsRecommendation && eligible.length < limit) {
    let profileFallback = catalogRecommendationCandidates(160)
      .filter((item) => !excludedMediaIds.has(item.mediaId))
      .filter((item) => !eligible.some((candidate) => candidate.mediaId === item.mediaId || candidate.code === item.code))
      .filter((item) => candidateMatchesSelectorConstraints(item, query))
      .filter((item) => candidateMatchesAgentContextEntities(item, contextEntities))
      .filter((item) => !/收藏/u.test(query) || item.favorite)
      .filter((item) => !queryRequestsUnwatched(query) || (!item.completed && !item.lastPlayedAt))
      .filter((item) => requestedGenres.length === 0 || item.genres.some((genre) => requestedGenres
        .some((requested) => normalizePreferenceValue(genre) === normalizePreferenceValue(requested))));
    if (options.userModel?.signals.length) {
      profileFallback = rankAgentCandidatesByUserModel(profileFallback, options.userModel)
        .filter((item) => !candidateMatchesStrongNegativePreference(item, options.userModel!, query));
    }
    eligible = [
      ...eligible,
      ...profileFallback.map((item) => ({
        ...item,
        selectionBasis: requestedGenres.length > 0 ? "direct" as const : "profile-fallback" as const
      }))
    ];
  }
  return wantsRecommendation
    ? sampleAgentRecommendationCandidates(eligible, limit, options.variationSeed)
    : eligible.slice(0, limit);
}

function seededAgentVariation(seed: number, key: string): number {
  const value = crypto.createHash("sha256").update(`${seed}:${key}`).digest().readUInt32BE(0) / 0xffff_ffff;
  return Math.min(1 - Number.EPSILON, Math.max(Number.EPSILON, value));
}

export function sampleAgentRecommendationCandidates(
  candidates: AgentCitation[],
  limit: number,
  variationSeed?: number
): AgentCitation[] {
  const boundedLimit = Math.max(0, Math.min(limit, candidates.length));
  if (!boundedLimit) return [];
  const ranked = [...candidates].sort((left, right) => right.score - left.score
    || left.code.localeCompare(right.code, "ja") || left.mediaId.localeCompare(right.mediaId));
  if (variationSeed == null) return ranked.slice(0, boundedLimit);

  const poolSize = Math.min(ranked.length, Math.max(boundedLimit * 4, 20));
  const pool = ranked.slice(0, poolSize);
  const bestScore = pool[0]?.score ?? 0;
  const worstScore = pool.at(-1)?.score ?? bestScore;
  const temperature = Math.max(0.08, Math.min(0.32, Math.max(0.12, bestScore - worstScore) * 0.55));
  return pool.map((item, index) => {
    const relativeWeight = Math.exp(Math.max(-8, (item.score - bestScore) / temperature));
    const randomUnit = seededAgentVariation(variationSeed, `${item.mediaId}:${index}`);
    return { item, priority: -Math.log(randomUnit) / relativeWeight };
  }).sort((left, right) => left.priority - right.priority
    || right.item.score - left.item.score || left.item.mediaId.localeCompare(right.item.mediaId))
    .slice(0, boundedLimit)
    .map(({ item }) => item);
}

export async function generateAgentAnswer(
  query: string,
  citations: AgentCitation[],
  history: Array<{ role: "user" | "assistant"; content: string }> = [],
  recommendationEligibleNumbers: number[] = [],
  analytics: AgentAnalyticsContext | null = null,
  variationSeed?: number,
  model = config.externalAi.chatModel,
  userModel: AgentUserModelContext | null = null,
  previousAnswer?: string
): Promise<string> {
  const requestAnswer = async (seed: number | undefined, attempt: number): Promise<string> => {
    const runtimeProfile = getAgentModelRuntimeProfile(model);
    const response = await fetch(`${config.externalAi.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        options: {
          temperature: runtimeProfile.temperature,
          top_p: runtimeProfile.topP,
          top_k: runtimeProfile.topK,
          ...(runtimeProfile.presencePenalty == null ? {} : { presence_penalty: runtimeProfile.presencePenalty }),
          ...(seed == null ? {} : { seed }),
          num_ctx: runtimeProfile.numCtx
        },
        messages: [
          { role: "system", content: agentSystemPrompt },
          ...compactAgentHistoryForModel(history),
          { role: "user", content: buildAgentUserPrompt(query, citations, recommendationEligibleNumbers, analytics, seed, userModel, previousAnswer, attempt) }
        ]
      }),
      signal: AbortSignal.timeout(300_000)
    });
    if (!response.ok) throw await readOllamaResponseError(response);
    const body = await response.json() as { message?: { content?: string } };
    const content = body.message?.content?.trim();
    if (!content) throw new Error("Agent model returned an empty answer");
    return finalizeAgentAnswer(query, content, citations, recommendationEligibleNumbers, userModel);
  };

  const firstAnswer = await requestAnswer(variationSeed, 1);
  if (!agentAnswersEquivalent(previousAnswer, firstAnswer)) return firstAnswer;
  const retrySeed = nextAgentVariationSeed(variationSeed);
  return ensureAgentAnswerVariation(previousAnswer, await requestAnswer(retrySeed, 2), retrySeed);
}

function queryExplicitlyRequestsAgentClarification(query: string): boolean {
  return /先(?:问|了解)|问我(?:一个|几个|些)?问题|通过提问|需要(?:先)?了解我|澄清(?:一下)?需求/u.test(query.normalize("NFKC").trim());
}

export function queryMayNeedAgentClarification(query: string): boolean {
  const normalized = query.normalize("NFKC").trim();
  if (!normalized || /继续完成上一条|针对馆长的问题|我的选择是|补充回答/u.test(normalized)) return false;
  if (queryExplicitlyRequestsAgentClarification(normalized)) return true;
  const compact = normalized.replace(/[\s，,。.!！?？]/g, "");
  return /^(?:请|帮我|给我)?(?:推荐|找)(?:点|些|一下)?(?:好看|合适|随便|想看)?(?:的)?(?:影片|作品|片子)?$/u.test(compact);
}

export function parseAgentClarificationResponse(content: string): Extract<AgentPresentation, { kind: "clarification-question" }> | null {
  const jsonSource = content.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  try {
    const value = JSON.parse(jsonSource) as {
      ask?: unknown;
      title?: unknown;
      question?: unknown;
      why?: unknown;
      options?: unknown;
      allowCustom?: unknown;
      customPlaceholder?: unknown;
    };
    if (value.ask !== true || typeof value.question !== "string" || !value.question.trim()) return null;
    const options = Array.isArray(value.options) ? value.options.flatMap((option, index) => {
      if (!option || typeof option !== "object") return [];
      const item = option as { label?: unknown; description?: unknown };
      if (typeof item.label !== "string" || !item.label.trim()) return [];
      return [{
        id: `option-${index + 1}`,
        label: item.label.trim().slice(0, 48),
        ...(typeof item.description === "string" && item.description.trim()
          ? { description: item.description.trim().slice(0, 120) }
          : {})
      }];
    }).slice(0, 4) : [];
    if (options.length < 2) return null;
    return {
      kind: "clarification-question",
      title: typeof value.title === "string" && value.title.trim() ? value.title.trim().slice(0, 32) : "先确认一个偏好",
      question: value.question.trim().slice(0, 180),
      ...(typeof value.why === "string" && value.why.trim() ? { why: value.why.trim().slice(0, 180) } : {}),
      options,
      allowCustom: value.allowCustom !== false,
      customPlaceholder: typeof value.customPlaceholder === "string" && value.customPlaceholder.trim()
        ? value.customPlaceholder.trim().slice(0, 80)
        : "也可以直接说出你的偏好"
    };
  } catch {
    return null;
  }
}

function fallbackAgentClarification(query: string): Extract<AgentPresentation, { kind: "clarification-question" }> {
  const recommendation = queryRequestsRecommendation(query);
  return {
    kind: "clarification-question",
    title: "先确认一个偏好",
    question: recommendation ? "这次你更希望我按哪个方向筛选？" : "你希望我优先从哪个方向回答？",
    why: recommendation ? "这个选择会直接影响候选范围和排序。" : "确认重点后，我可以给出更准确的馆藏回复。",
    options: recommendation ? [
      { id: "option-1", label: "贴近最近偏好", description: "优先选择与你近期观看相似的作品" },
      { id: "option-2", label: "探索新题材", description: "降低重复度，增加不同演员和题材" },
      { id: "option-3", label: "从未观看中挑选", description: "排除已经看过的作品" }
    ] : [
      { id: "option-1", label: "查找具体作品" },
      { id: "option-2", label: "查看馆藏统计" },
      { id: "option-3", label: "获取个性化推荐" }
    ],
    allowCustom: true,
    customPlaceholder: "补充演员、题材、数量或其他要求"
  };
}

export async function generateAgentClarification(
  query: string,
  history: Array<{ role: "user" | "assistant"; content: string }> = [],
  model = config.externalAi.chatModel
): Promise<Extract<AgentPresentation, { kind: "clarification-question" }> | null> {
  if (!queryMayNeedAgentClarification(query)) return null;
  if (queryExplicitlyRequestsAgentClarification(query)) return fallbackAgentClarification(query);
  try {
    const response = await fetch(`${config.externalAi.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        format: "json",
        options: { temperature: 0.2, top_p: 0.7, num_ctx: 4096 },
        messages: [
          {
            role: "system",
            content: `你是 Alexandria 智能馆长的澄清规划器。判断当前问题是否存在一个会显著改变馆藏检索结果的关键歧义。一次最多问一个问题，不询问隐私，不重复历史中已经回答的条件。只输出 JSON：无需追问时 {"ask":false}；需要时输出 {"ask":true,"title":"先确认一个偏好","question":"问题","why":"为什么需要确认","options":[{"label":"选项","description":"影响"}],"allowCustom":true,"customPlaceholder":"补充说明"}。提供 2 到 4 个互斥、简短、可执行的选项。`
          },
          ...compactAgentHistoryForModel(history).slice(-4),
          { role: "user", content: query }
        ]
      }),
      signal: AbortSignal.timeout(90_000)
    });
    if (!response.ok) throw await readOllamaResponseError(response);
    const body = await response.json() as { message?: { content?: string } };
    return parseAgentClarificationResponse(body.message?.content ?? "") ?? fallbackAgentClarification(query);
  } catch {
    return fallbackAgentClarification(query);
  }
}

const agentSystemPrompt = `你是 Alexandria 私人媒体库的智能馆长。只使用给出的本地馆藏数据、结构化工具结果和可解释用户画像回答，使用简体中文；“只使用本地数据”不等于“只有精确标签完全一致时才能回答”。
标签、演员、系列、厂商、厂牌、导演和番号系列属于馆藏结构化分类；不能因为本轮没有精确影片引用，就推断这些分类数据不存在或要求用户补充影片证据。分类推荐与统计应优先使用本地数据库工具结果。若精确候选不足但提供了“画像相邻候选”，应明确说明回退口径并继续给出有价值的推荐，不能把相邻候选描述成精确命中。
涉及具体作品时必须同时写出证据中的真实番号和 [1] 形式的证据编号，例如 AARM-199 [1]；禁止只写 [1]，也禁止写成“番号 [1]”“作品 [1]”“证据 [1]”等模糊占位。证据不足时明确说明，不要编造，也不要执行或声称执行未提供的操作。
元数据字段没有列出某个标签，只表示证据未记录该标签，不代表作品一定不含该属性。禁止把标签缺失写成“非某类型”“没有某属性”“未触犯某条件”，也禁止把用户画像中的一个实体与未明确关联的作品强行建立语义关系。偏好理由只能使用每条证据里的“精确偏好命中”。
当提示中包含“全库结构化统计”时，它是数据库对完整馆藏的直接聚合结果，不是抽样证据。必须直接依据统计回答最多、排名、数量或占比问题，不要声称数据不足，也不要用影片引用编号代替统计依据。完整排行会由界面另行展示，正文只需用一句话给出第一名、简述紧随其后的结果与统计口径，不要重复完整排名表格。
回复应先直接回答问题，再按需要使用简短标题、自然段、列表、粗体或表格组织信息。不要把普通结论写成让用户选择的选项，也不要为每句话创建一个列表项。
只输出标准 Markdown，禁止输出 HTML 标签（包括 <br>）；段落使用空行，表格单元格保持简短，不要在表格中嵌套列表。
当用户要求推荐 N 项且符合条件的证据不少于 N 项时，必须按相关性从中选出 N 项并给出理由；未指定数量时默认推荐 4 项。最终入选项必须统一放在“## 推荐影片”标题下，每项使用“**AARM-199 [1]** — 推荐理由”这样的格式，其中 AARM-199 必须替换为对应证据中的真实番号。禁止输出“番号 [1]”“作品 [1]”或仅写“[1]”。推荐只能从“允许作为推荐卡片的证据”中选择，每个入选作品只出现一次，未入选证据不要在最终回答中点名。
当用户要求根据近期观看记录推荐时，带有最近观看时间的证据只用于理解偏好；除非用户明确要求重看，否则应从未观看证据中选择推荐。`;

const vagueAgentReferencePattern = /(?:证据中的实际作品番号|实际作品番号|作品番号|影片番号|番号|影片|作品|证据|条目)\s*(\[(\d{1,2})\])/gu;

function resolveAgentReferenceLine(line: string, citations: AgentCitation[]): string {
  const explicit = line.replace(
    vagueAgentReferencePattern,
    (original, reference: string, number: string, offset: number, source: string) => {
      const code = citations[Number(number) - 1]?.code?.trim();
      if (!code) return original;
      const separator = offset > 0 && !/[\s([{“"'`*_—–-]/u.test(source[offset - 1]) ? " " : "";
      return `${separator}${code} ${reference}`;
    }
  );
  return explicit.replace(/\[(\d{1,2})]/g, (reference, number: string, offset: number, source: string) => {
    const code = citations[Number(number) - 1]?.code?.trim();
    if (!code) return reference;
    const nearbyPrefix = source.slice(Math.max(0, offset - code.length - 24), offset);
    return nearbyPrefix.includes(code) ? reference : `${code} ${reference}`;
  });
}

export function normalizeAgentAnswerReferences(answer: string, citations: AgentCitation[]): string {
  if (citations.length === 0 || !/\[\d{1,2}]/.test(answer)) return answer;
  let insideCodeFence = false;
  return answer.split("\n").map((line) => {
    if (/^\s*```/.test(line)) {
      insideCodeFence = !insideCodeFence;
      return line;
    }
    return insideCodeFence ? line : resolveAgentReferenceLine(line, citations);
  }).join("\n");
}

function answerHasMismatchedCitationCodes(answer: string, citations: AgentCitation[]): boolean {
  const normalizedCodes = citations.map((citation) => citation.code.normalize("NFKC").toUpperCase());
  return answer.split("\n").some((line) => [...line.matchAll(/\[(\d{1,2})]/g)].some((match) => {
    const expected = normalizedCodes[Number(match[1]) - 1];
    if (!expected || match.index == null) return false;
    const prefix = line.slice(Math.max(0, match.index - 96), match.index).normalize("NFKC").toUpperCase();
    const mentioned = normalizedCodes.filter((code) => prefix.includes(code));
    return mentioned.some((code) => code !== expected);
  }));
}

function compactHistoryContent(content: string, limit: number): string {
  const normalized = content.replace(/\n{3,}/g, "\n\n").trim();
  if (normalized.length <= limit) return normalized;
  const headLength = Math.ceil(limit * 0.68);
  const tailLength = limit - headLength;
  return `${normalized.slice(0, headLength)}\n…（中间内容已压缩）…\n${normalized.slice(-tailLength)}`;
}

export function compactAgentHistoryForModel(
  history: Array<{ role: "user" | "assistant"; content: string }>
): Array<{ role: "user" | "assistant"; content: string }> {
  return history.slice(-6).map((item) => ({
    role: item.role,
    content: compactHistoryContent(item.content, item.role === "user" ? 1_000 : 1_500)
  }));
}

function buildAgentUserModelBlock(
  userModel: AgentUserModelContext | null,
  citations: AgentCitation[]
): string {
  if (!userModel?.signals.length) return "";
  const positive = userModel.signals
    .filter((signal) => signal.weight > 0.15 && citations.some((item) => candidateMatchesPreference(item, signal)))
    .slice(0, 8);
  if (!positive.length) return "";
  const format = (signal: AgentPreferenceSignal) => `${signal.dimension}=${signal.value}（${signal.source}）`;
  return `\n\n候选中精确命中的偏好信号（只作软排序与理由依据，不能扩大解释或覆盖本轮明确条件）：\n${positive.map(format).join("、")}`;
}

function exactPreferenceMatchesForCitation(
  citation: AgentCitation,
  userModel: AgentUserModelContext | null
): string[] {
  return userModel?.signals
    .filter((signal) => signal.weight > 0.15 && candidateMatchesPreference(citation, signal))
    .slice(0, 4)
    .map((signal) => `${signal.dimension}=${signal.value}`) ?? [];
}

function buildAgentExecutionBrief(
  query: string,
  citations: AgentCitation[],
  recommendationEligibleNumbers: number[]
): string {
  const constraints = [
    ...findMentionedGenres(query).map((value) => `标签=${value}`),
    ...extractSelectorConstraints(query).map((item) => `${item.dimension}=${item.value}`),
    /收藏/u.test(query) ? "仅收藏" : "",
    queryRequestsUnwatched(query) ? "仅未观看" : "",
    queryRequestsRecentHistory(query) ? "参考近期观看" : ""
  ].filter(Boolean);
  const expected = requestedRecommendationCount(query) ?? 4;
  const profileFallbackCount = recommendationEligibleNumbers.filter((number) => citations[number - 1]?.selectionBasis === "profile-fallback").length;
  return `\n\n本轮执行简报：\n- 任务：${describeAgentIntent(query)}\n- 硬条件：${constraints.join("、") || "无额外硬条件"}\n- 证据状态：${citations.length} 条作品证据；${recommendationEligibleNumbers.length} 条可入选推荐${profileFallbackCount ? `（其中 ${profileFallbackCount} 条为画像相邻候选）` : ""}\n- 输出契约：${queryRequestsRecommendation(query) ? `最多选择 ${Math.min(expected, recommendationEligibleNumbers.length)} 项真实候选；有候选时不得以证据不足拒答；画像相邻候选必须说明回退口径` : "直接回答问题并保持引用可核验"}`;
}

function deterministicRecommendationReason(
  query: string,
  citation: AgentCitation,
  userModel: AgentUserModelContext | null
): string {
  const reasons: string[] = [];
  const queryTerms = extractAgentSearchTerms(query).map(normalizePreferenceValue);
  const queryGenres = citation.genres.filter((genre) => queryTerms.includes(normalizePreferenceValue(genre)));
  if (queryGenres.length) reasons.push(`精确命中“${queryGenres.join("、")}”标签`);
  const preferenceMatches = userModel?.signals
    .filter((signal) => signal.weight > 0.15 && candidateMatchesPreference(citation, signal))
    .slice(0, 2)
    .map((signal) => signal.value) ?? [];
  if (preferenceMatches.length) reasons.push(`同时贴合偏好“${preferenceMatches.join("、")}”`);
  if (reasons.length < 2 && citation.genres.length) reasons.push(`题材还包括${citation.genres.slice(0, 3).join("、")}`);
  if (reasons.length < 2 && citation.actors.length) reasons.push(`演员为${citation.actors.slice(0, 2).join("、")}`);
  if (reasons.length < 2 && citation.series) reasons.push(`属于“${citation.series}”系列`);
  if (reasons.length < 2 && citation.maker) reasons.push(`由“${citation.maker}”制作`);
  if (reasons.length < 2 && citation.label) reasons.push(`来自“${citation.label}”厂牌`);
  if (reasons.length < 2 && citation.director) reasons.push(`导演为${citation.director}`);
  return reasons.slice(0, 2).join("；") || "馆藏元数据完整，且与本轮检索结果相关";
}

export function finalizeAgentAnswer(
  query: string,
  answer: string,
  citations: AgentCitation[],
  recommendationEligibleNumbers: number[],
  userModel: AgentUserModelContext | null = null
): string {
  const mismatchedCitationCodes = answerHasMismatchedCitationCodes(answer, citations);
  const normalized = normalizeAgentAnswerReferences(answer, citations);
  if (!queryRequestsRecommendation(query)) return normalized;
  if (recommendationEligibleNumbers.length === 0) {
    const subject = extractAgentSearchTerms(query).slice(0, 3).join("、") || "当前条件";
    return `这次没有找到能够同时满足“${subject}”及其他硬条件的馆藏作品。我已经检查了精确标签、上位题材标签组、当前对话实体和用户画像候选，因此不会要求你另外提供影片列表，也不会编造番号。\n\n可以继续让我放宽一个条件，例如保留题材但允许已观看作品，或保留观看状态并改为画像中的相邻题材。`;
  }
  const eligible = [...new Set(recommendationEligibleNumbers)]
    .filter((number) => number >= 1 && number <= citations.length);
  const expected = Math.min(requestedRecommendationCount(query) ?? 4, eligible.length);
  const selected = extractAgentRecommendationCitationNumbers(normalized, citations.length)
    .filter((number) => eligible.includes(number));
  const recommendationOccurrences = recommendationCitationOccurrences(normalized, citations.length)
    .filter((number) => eligible.includes(number));
  const hasDuplicateRecommendationReferences = recommendationOccurrences.length !== new Set(recommendationOccurrences).size;
  const refusesDespiteEvidence = /(?:无法|不能|暂时不能|没法).{0,12}推荐|证据不足|可用证据.{0,8}(?:不足|为无|没有)|没有足够.{0,8}(?:候选|依据|证据)/u.test(normalized);
  const selfCorrectedOrUnsupported = /(?:^|\n).{0,8}(?:修正|更正|更新后的|替换为)|未(?:提及|出现|标记|记录|包含).{0,16}标签|未触犯|非.{0,8}(?:类型|路线)/u.test(normalized);
  if (!mismatchedCitationCodes && !hasDuplicateRecommendationReferences
    && !refusesDespiteEvidence && !selfCorrectedOrUnsupported
    && new Set(selected).size === expected) return normalized;

  const chosen = [...new Set([...selected, ...eligible])].slice(0, expected);
  const fallbackCount = chosen.filter((number) => citations[number - 1]?.selectionBasis === "profile-fallback").length;
  return [
    fallbackCount > 0
      ? `可以。精确条件下候选不足，我从本地馆藏中补入 ${fallbackCount} 条用户画像相邻候选，并结合可解释偏好选出 ${chosen.length} 部；这些回退项不会被描述成精确标签命中。`
      : `可以。已从本地馆藏的 ${eligible.length} 条合格候选中，按本轮条件${userModel?.signals.length ? "并结合可解释的偏好信号" : ""}选出 ${chosen.length} 部。`,
    "## 推荐影片",
    ...chosen.map((number) => {
      const item = citations[number - 1];
      return `- **${item.code} [${number}]** — ${deterministicRecommendationReason(query, item, userModel)}`;
    })
  ].join("\n\n");
}

function buildAgentUserPrompt(
  query: string,
  citations: AgentCitation[],
  recommendationEligibleNumbers: number[],
  analytics: AgentAnalyticsContext | null,
  variationSeed?: number,
  userModel: AgentUserModelContext | null = null,
  previousAnswer?: string,
  regenerationAttempt = 1
): string {
  const recommendationLine = queryRequestsRecommendation(query)
    ? `\n\n允许作为推荐卡片的证据：${recommendationEligibleNumbers.map((number) => {
      const code = citations[number - 1]?.code?.trim();
      return code ? `${code} [${number}]` : `[${number}]`;
    }).join("、") || "无"}`
    : "";
  const analyticsBlock = analytics?.kind === "actor-genre-ranking"
    ? `\n\n全库结构化统计（数据库直接聚合，按唯一番号去重）：\n统计目标：${analytics.subject === "全部馆藏" ? "全部馆藏作品" : `带有“${analytics.subject}”标签的作品`}，按演员统计作品数\n统计范围作品：${analytics.totalTaggedWorks} 部\n其中演员资料完整：${analytics.worksWithActors} 部\n涉及演员：${analytics.distinctActors} 位\n排名结果：\n${analytics.rows.map((row) => `${row.rank}. ${row.label}：${row.count} 部`).join("\n")}\n统计结果可以直接回答，不需要影片引用编号。完整排行会由界面单独展示，正文不要复写完整表格。`
    : "";
  const regenerationLine = variationSeed != null
    ? `\n\n本轮是重新生成。内部变体标识：${variationSeed.toString(36)}-${regenerationAttempt}（不得在回答中提及）。保持用户原始条件，只能使用本轮候选；必须改变上一版的选片组合或组织与措辞。${previousAnswer ? `\n上一版回答仅用于查重，禁止照抄，其中作品也不自动成为本轮证据：\n【上一版开始】\n${compactHistoryContent(previousAnswer, 1_200)}\n【上一版结束】` : ""}`
    : "";
  return `用户问题：${query}${buildAgentUserModelBlock(userModel, citations)}${buildAgentExecutionBrief(query, citations, recommendationEligibleNumbers)}${analyticsBlock}\n\n本地馆藏作品证据：\n${citations.map((item, index) => `[${index + 1}] ${item.code}｜${item.title}\n候选口径：${item.selectionBasis === "profile-fallback" ? "用户画像相邻候选（不是本轮题材的精确命中）" : "本轮检索直接候选"}\n演员：${item.actors.join("、")}\n题材：${item.genres.join("、")}\n系列：${item.series}\n厂商：${item.maker ?? ""}\n厂牌：${item.label ?? ""}\n导演：${item.director ?? ""}\n番号系列：${item.prefix ?? ""}\n发行日期：${item.releaseDate ?? ""}\n时长：${item.durationSeconds ? `${Math.round(item.durationSeconds / 60)} 分钟` : ""}\n精确偏好命中：${exactPreferenceMatchesForCitation(item, userModel).join("、") || "无"}\n收藏：${item.favorite ? "是" : "否"}\n观看：${item.completed ? "已看完" : item.lastPlayedAt ? `最近观看 ${item.lastPlayedAt}` : "未观看"}\n简介：${item.summary}`).join("\n\n") || "本题无需抽样影片证据"}${recommendationLine}${regenerationLine}`;
}

function nextAgentVariationSeed(previous?: number): number {
  let seed = crypto.randomInt(1, 2_147_483_647);
  while (seed === previous) seed = crypto.randomInt(1, 2_147_483_647);
  return seed;
}

export function agentAnswersEquivalent(previous?: string, next?: string): boolean {
  if (!previous?.trim() || !next?.trim()) return false;
  const normalize = (value: string) => value
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return normalize(previous) === normalize(next);
}

const agentRegenerationFallbacks = [
  "本轮重新生成后，可核验事实与上一版一致；当前约束下没有足够依据安全替换结论。",
  "这次重新生成已使用新的变量复核，但现有馆藏证据仍支持相同结论，因此保留事实结果。",
  "重新生成时已重新计算候选与证据；由于硬条件没有留下可靠替代项，本版继续采用相同事实口径。"
];

export function ensureAgentAnswerVariation(previous: string | undefined, next: string, variationSeed?: number): string {
  if (!agentAnswersEquivalent(previous, next)) return next;
  const start = Math.abs(variationSeed ?? 0) % agentRegenerationFallbacks.length;
  for (let offset = 0; offset < agentRegenerationFallbacks.length; offset += 1) {
    const fallback = agentRegenerationFallbacks[(start + offset) % agentRegenerationFallbacks.length];
    if (!previous?.includes(fallback)) return `${next.trim()}\n\n> ${fallback}`;
  }
  const version = Math.abs(variationSeed ?? Date.now()).toString(36).slice(-6);
  return `${next.trim()}\n\n> 当前事实结论保持不变；重新生成版本：${version}`;
}

type OllamaChatChunk = {
  error?: string;
  message?: { content?: string; thinking?: string };
  done?: boolean;
};

export async function consumeAgentModelStream(
  stream: ReadableStream<Uint8Array>,
  callbacks: {
    onContent: (delta: string) => void;
    onThinkingStarted?: () => void;
  }
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  let thinkingStarted = false;

  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    const chunk = JSON.parse(line) as OllamaChatChunk;
    if (chunk.error) throw new Error(chunk.error);
    if (chunk.message?.thinking && !thinkingStarted) {
      thinkingStarted = true;
      callbacks.onThinkingStarted?.();
    }
    const delta = chunk.message?.content ?? "";
    if (delta) {
      answer += delta;
      callbacks.onContent(delta);
    }
  };

  let streamDone = false;
  while (!streamDone) {
    const chunk = await reader.read();
    streamDone = chunk.done;
    buffer += decoder.decode(chunk.value, { stream: !streamDone });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    lines.forEach(consumeLine);
  }
  consumeLine(buffer);
  const content = answer.trim();
  if (!content) throw new Error("Agent model returned an empty answer");
  return content;
}

export async function streamAgentAnswer(
  query: string,
  citations: AgentCitation[],
  history: Array<{ role: "user" | "assistant"; content: string }> = [],
  options: {
    signal?: AbortSignal;
    onContent: (delta: string) => void;
    onThinkingStarted?: () => void;
    recommendationEligibleNumbers?: number[];
    analytics?: AgentAnalyticsContext | null;
    variationSeed?: number;
    model?: string;
    userModel?: AgentUserModelContext | null;
    previousAnswer?: string;
  }
): Promise<string> {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(300_000)])
    : AbortSignal.timeout(300_000);
  const requestAnswer = async (
    seed: number | undefined,
    attempt: number,
    onContent: (delta: string) => void
  ): Promise<string> => {
    const model = options.model ?? config.externalAi.chatModel;
    const runtimeProfile = getAgentModelRuntimeProfile(model);
    const response = await fetch(`${config.externalAi.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({
        model,
        stream: true,
        think: false,
        options: {
          temperature: runtimeProfile.temperature,
          top_p: runtimeProfile.topP,
          top_k: runtimeProfile.topK,
          ...(runtimeProfile.presencePenalty == null ? {} : { presence_penalty: runtimeProfile.presencePenalty }),
          ...(seed == null ? {} : { seed }),
          num_ctx: runtimeProfile.numCtx,
          num_predict: 1_400
        },
        messages: [
          { role: "system", content: agentSystemPrompt },
          ...compactAgentHistoryForModel(history),
          {
            role: "user",
            content: buildAgentUserPrompt(
              query,
              citations,
              options.recommendationEligibleNumbers ?? [],
              options.analytics ?? null,
              seed,
              options.userModel ?? null,
              options.previousAnswer,
              attempt
            )
          }
        ]
      }),
      signal
    });
    if (!response.ok) throw await readOllamaResponseError(response);
    if (!response.body) throw new Error("Agent model did not return a response stream");
    return finalizeAgentAnswer(
      query,
      await consumeAgentModelStream(response.body, {
        onContent,
        onThinkingStarted: options.onThinkingStarted
      }),
      citations,
      options.recommendationEligibleNumbers ?? [],
      options.userModel ?? null
    );
  };

  if (!options.previousAnswer?.trim()) {
    return requestAnswer(options.variationSeed, 1, options.onContent);
  }

  const firstAnswer = await requestAnswer(options.variationSeed, 1, () => undefined);
  const retrySeed = nextAgentVariationSeed(options.variationSeed);
  const answer = agentAnswersEquivalent(options.previousAnswer, firstAnswer)
    ? ensureAgentAnswerVariation(
      options.previousAnswer,
      await requestAnswer(retrySeed, 2, () => undefined),
      retrySeed
    )
    : firstAnswer;
  options.onContent(answer);
  return answer;
}
