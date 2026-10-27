import crypto from "node:crypto";
import type { Express } from "express";
import { z } from "zod";
import { db } from "./db.js";
import { readEntityFavorites } from "./entityFavorites.js";
import { readFavoriteKeys } from "./favorites.js";
import { getTopicAliases, getTopicGraphItems, type TopicType } from "./productRoutes.js";
import {
  MEDIA_LIST_JOINS,
  MEDIA_LIST_SELECT,
  hydrateMediaRows,
  type MediaListRow
} from "./queries/mediaListQueries.js";
import {
  ARENA_STRATEGIES,
  VIEWING_FACET_TYPES,
  VIEWING_LANES,
  buildArenaSignalProfile,
  pickAdaptiveArenaPair,
  rankArenaCandidates,
  type ArenaDecisionRecord,
  type ArenaPairCandidate,
  type ArenaSignalProfile,
  type RankedArenaCandidate,
  type ViewingFacet,
  type ViewingFacetType,
  type ViewingLane,
  type ViewingSignal
} from "./viewingArenaRanking.js";

const GRAPH_TYPES = ["actor", "series", "genre", "director", "maker", "label"] as const;
const graphTypeSchema = z.enum(GRAPH_TYPES);
const viewingPresetSchema = z.enum(["quick", "explore", "favorites", "unwatched"]);
const viewingConfigSchema = z.object({
  preset: viewingPresetSchema.default("explore"),
  durationMinutes: z.coerce.number().int().min(20).max(240).default(60),
  category: z.enum(["ALL", "JAV", "FC2"]).default("ALL"),
  excludeRecentlyWatched: z.boolean().default(true),
  favoriteBias: z.boolean().default(true),
  limit: z.coerce.number().int().min(6).max(36).default(24),
  preferredGenre: z.string().trim().min(1).max(120).optional(),
  preferredActor: z.string().trim().min(1).max(120).optional(),
  preferredSeries: z.string().trim().min(1).max(120).optional(),
  preferredDirector: z.string().trim().min(1).max(120).optional(),
  preferredMaker: z.string().trim().min(1).max(120).optional(),
  preferredLabel: z.string().trim().min(1).max(120).optional(),
  preferredGenreLabel: z.string().trim().min(1).max(120).optional(),
  preferredActorLabel: z.string().trim().min(1).max(120).optional(),
  preferredSeriesLabel: z.string().trim().min(1).max(120).optional(),
  preferredDirectorLabel: z.string().trim().min(1).max(120).optional(),
  preferredMakerLabel: z.string().trim().min(1).max(120).optional(),
  preferredLabelLabel: z.string().trim().min(1).max(120).optional(),
  focusLane: z.enum(VIEWING_LANES).optional()
});
const viewingFeedbackSchema = z.object({
  mediaId: z.string().trim().min(1),
  feedback: z.enum(["like", "dislike", "skip", "clear"])
});
const viewingArenaChoiceSchema = z.object({
  roundIndex: z.coerce.number().int().min(0).max(15),
  action: z.enum(["choose", "both", "reject", "reroll", "skip", "neutral"]).default("choose"),
  winnerMediaId: z.string().trim().min(1).optional()
}).superRefine((value, context) => {
  if (value.action === "choose" && !value.winnerMediaId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["winnerMediaId"], message: "请选择其中一部影片" });
  }
});
const viewingBranchSchema = z.object({
  lane: z.enum(VIEWING_LANES)
});
const viewingHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(8)
});
const queryBooleanSchema = z.preprocess((value) => {
  if (value === "true" || value === true) return true;
  if (value === "false" || value === false) return false;
  return value;
}, z.boolean());
const graphYearSchema = z.coerce.number().int().min(1900).max(2100);
const graphYearRangeSchema = z.object({
  yearFrom: graphYearSchema.optional(),
  yearTo: graphYearSchema.optional()
}).refine((value) => value.yearFrom == null || value.yearTo == null || value.yearFrom <= value.yearTo, {
  message: "yearFrom must be less than or equal to yearTo"
});
const graphQuerySchema = z.object({
  types: z.string().trim().default(GRAPH_TYPES.join(",")),
  q: z.string().trim().max(120).default(""),
  limit: z.coerce.number().int().min(18).max(100).default(60),
  minShared: z.coerce.number().int().min(1).max(30).default(2),
  category: z.enum(["ALL", "JAV", "FC2"]).default("ALL"),
  hideGeneric: queryBooleanSchema.default(true),
  yearFrom: graphYearSchema.optional(),
  yearTo: graphYearSchema.optional()
}).and(graphYearRangeSchema);
const graphConnectionQuerySchema = z.object({
  sourceType: graphTypeSchema,
  sourceValue: z.string().trim().min(1).max(300),
  targetType: graphTypeSchema,
  targetValue: z.string().trim().min(1).max(300),
  category: z.enum(["ALL", "JAV", "FC2"]).default("ALL"),
  yearFrom: graphYearSchema.optional(),
  yearTo: graphYearSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(12),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  cursor: z.string().trim().max(120).optional()
}).and(graphYearRangeSchema);
const graphNeighborsQuerySchema = z.object({
  sourceType: graphTypeSchema,
  sourceValue: z.string().trim().min(1).max(300),
  targetTypes: z.string().trim().default(GRAPH_TYPES.join(",")),
  category: z.enum(["ALL", "JAV", "FC2"]).default("ALL"),
  yearFrom: graphYearSchema.optional(),
  yearTo: graphYearSchema.optional(),
  minShared: z.coerce.number().int().min(1).max(100).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().trim().max(120).optional()
}).and(graphYearRangeSchema);
const graphPathQuerySchema = z.object({
  sourceType: graphTypeSchema,
  sourceValue: z.string().trim().min(1).max(300),
  targetType: graphTypeSchema,
  targetValue: z.string().trim().min(1).max(300),
  category: z.enum(["ALL", "JAV", "FC2"]).default("ALL"),
  yearFrom: graphYearSchema.optional(),
  yearTo: graphYearSchema.optional(),
  minShared: z.coerce.number().int().min(1).max(30).default(1),
  maxDepth: z.coerce.number().int().min(1).max(6).default(4)
}).and(graphYearRangeSchema);

type ViewingConfig = z.infer<typeof viewingConfigSchema>;
type ViewingCandidate = MediaListRow & {
  normalizedCode: string;
  favoriteEntityMatches: number;
  firstSeenAt: string;
  preferredGenreMatch: number;
  preferredActorMatch: number;
  preferredSeriesMatch: number;
  preferredDirectorMatch: number;
  preferredMakerMatch: number;
  preferredLabelMatch: number;
};
type ViewingBootstrapSignal = {
  id: "browse" | "favorite" | "pace";
  label: string;
  value: string;
  simulated: boolean;
};
type SessionRow = {
  id: string;
  preset: ViewingConfig["preset"];
  configJson: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};
type SessionItemRow = {
  mediaId: string;
  position: number;
  lane: ViewingLane;
  reason: string;
  score: number;
  feedback: string;
};
type ArenaRoundRow = {
  roundIndex: number;
  leftMediaId: string;
  rightMediaId: string;
  winnerMediaId: string | null;
  decision: ArenaDecisionRecord["decision"];
  strategy: string;
  prompt: string;
};
type ScoredViewingCandidate = {
  candidate: ViewingCandidate;
  favorite: boolean;
  score: number;
  reason: string;
  facets: ViewingFacet[];
};
type GraphNode = {
  id: string;
  type: (typeof GRAPH_TYPES)[number];
  value: string;
  label: string;
  aliases: string[];
  mediaCount: number;
  isFavorite: boolean;
  degree: number;
  mediaId: string | null;
  coverKind: "manual" | "representative" | "none";
  latestReleaseDate: string | null;
};
type GraphType = (typeof GRAPH_TYPES)[number];
type GraphCategory = "ALL" | "JAV" | "FC2";
type GraphYearRange = { startYear?: number; endYear?: number };
type GraphEdge = {
  id: string;
  source: string;
  target: string;
  weight: number;
  affinity: number;
  strength: number;
  relationType: string;
  relationLabel: string;
};
type GraphEntity = {
  id: string;
  type: GraphType;
  value: string;
  label: string;
  aliases: string[];
  mediaId: string | null;
  coverKind: GraphNode["coverKind"];
  latestReleaseDate: string | null;
};

const GENERIC_GRAPH_GENRES = new Set([
  "高清", "高画质", "hd", "4k", "单体作品", "單體作品", "独家配信", "獨家配信", "独占配信",
  "samplevideo", "サンプル動画", "样片"
]);

const VIEWING_PRESETS = [
  { id: "quick", label: "快速选片", description: "回答几道题，马上得到一组片单", durationMinutes: 30 },
  { id: "explore", label: "熟悉中找新意", description: "保留喜欢的元素，再换一点新鲜感", durationMinutes: 60 },
  { id: "favorites", label: "从收藏继续", description: "从收藏过的演员、系列和题材开始", durationMinutes: 90 },
  { id: "unwatched", label: "看看没播过的", description: "优先挑选从未播放的影片", durationMinutes: 90 }
] as const;

const graphCache = new Map<string, { expiresAt: number; value: unknown }>();

function parseConfig(value: string): ViewingConfig {
  try {
    return viewingConfigSchema.parse(JSON.parse(value));
  } catch {
    return viewingConfigSchema.parse({});
  }
}

function loadMediaRows(ids: string[]): MediaListRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return db.prepare(`
    SELECT ${MEDIA_LIST_SELECT}
    FROM media_files
    ${MEDIA_LIST_JOINS}
    WHERE media_files.id IN (${placeholders})
  `).all(...ids) as MediaListRow[];
}

function rewriteLegacyViewingReason(reason: string): string {
  if (reason === "来自你的 Arena 选择") return "你在刚才的对比中选中了这部";
  if (reason === "已收藏内容") return "你收藏过这部";
  if (reason === "收藏专题关联") return "和你的收藏有相似之处";
  if (reason === "可以继续观看") return "上次还没看完";
  if (reason === "尚未观看") return "还没有播放过";
  if (reason === "根据当前场景精选") return "综合本次选择推荐";
  if (reason === "延续当前路线的核心锚点") return "最贴近你刚才的选择";
  if (reason === "保留一处熟悉感，改变其他维度") return "有熟悉的元素，也带来一些变化";
  if (reason === "低重合但未触碰已排除信号") return "和常看内容差别更大，并已避开不喜欢的方向";
  if (reason.startsWith("延续 ")) return `符合你刚才偏好的${reason.slice(3)}`;
  if (reason.startsWith("从 ") && reason.endsWith(" 向外延伸")) {
    return `保留${reason.slice(2, -5)}，再换一点新风格`;
  }
  if (reason.startsWith("保留 ") && reason.includes("，拓展到")) {
    return reason.replace(/^保留 /, "保留").replace("，拓展到", "，同时加入");
  }
  if (reason.startsWith("意外支线：")) return `试试较少出现的${reason.slice(5)}`;
  if (reason.startsWith("符合所选演员：")) return `你选择了演员：${reason.slice(7)}`;
  if (reason.startsWith("来自所选系列：")) return `来自你选择的系列：${reason.slice(7)}`;
  if (reason.startsWith("符合所选专题：")) return `符合你选择的题材：${reason.slice(7)}`;
  if (reason.startsWith("来自所选导演：")) return `来自你选择的导演：${reason.slice(7)}`;
  if (reason.startsWith("来自所选厂商：")) return `来自你选择的厂商：${reason.slice(7)}`;
  if (reason.startsWith("来自所选厂牌：")) return `来自你选择的厂牌：${reason.slice(7)}`;
  if (reason.startsWith("发行于 ")) return `发行日期：${reason.slice(4)}`;
  return reason;
}

function loadViewingSession(id?: string) {
  const row = (id
    ? db.prepare(`SELECT id, preset, config_json AS configJson, status,
        created_at AS createdAt, updated_at AS updatedAt FROM viewing_sessions WHERE id = ?`).get(id)
    : db.prepare(`SELECT id, preset, config_json AS configJson, status,
        created_at AS createdAt, updated_at AS updatedAt FROM viewing_sessions
        WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1`).get()) as SessionRow | undefined;
  if (!row) return null;

  const itemRows = db.prepare(`SELECT media_id AS mediaId, position, lane, reason, score, feedback
    FROM viewing_session_items WHERE session_id = ? AND position >= 0 ORDER BY position`).all(row.id) as SessionItemRow[];
  const arenaRows = db.prepare(`SELECT round_index AS roundIndex, left_media_id AS leftMediaId,
      right_media_id AS rightMediaId, winner_media_id AS winnerMediaId, decision, strategy, prompt
    FROM viewing_arena_rounds WHERE session_id = ? ORDER BY round_index`).all(row.id) as ArenaRoundRow[];
  const mediaIds = [...new Set([
    ...itemRows.map((item) => item.mediaId),
    ...arenaRows.flatMap((round) => [round.leftMediaId, round.rightMediaId])
  ])];
  const mediaById = new Map(
    hydrateMediaRows(loadMediaRows(mediaIds), readFavoriteKeys())
      .map((media) => [String(media.id), media])
  );
  const items = itemRows.flatMap((item) => {
    const media = mediaById.get(item.mediaId);
    const reason = rewriteLegacyViewingReason(item.reason).replaceAll("专题「", "题材「");
    return media ? [{ ...item, reason, media }] : [];
  });
  const queueMinutes = items.reduce((total, item) => {
    const duration = Number((item.media as { durationSeconds?: number | null }).durationSeconds ?? 0);
    return total + Math.round(duration / 60);
  }, 0);
  const config = parseConfig(row.configJson);
  const rounds = arenaRows.flatMap((round) => {
    const left = mediaById.get(round.leftMediaId);
    const right = mediaById.get(round.rightMediaId);
    const fallbackStrategy = ARENA_STRATEGIES[round.roundIndex % ARENA_STRATEGIES.length];
    const currentStrategy = ARENA_STRATEGIES.find((strategy) => strategy.id === round.strategy) ?? fallbackStrategy;
    return left && right ? [{
      ...round,
      strategy: currentStrategy.id,
      strategyLabel: currentStrategy.label,
      prompt: currentStrategy.prompt,
      left,
      right
    }] : [];
  });
  const profile = buildSessionArenaProfile(row.id, config, arenaRows);
  const { weights: _weights, ...publicProfile } = profile;
  const laneCopy: Record<ViewingLane, { label: string; description: string }> = {
    core: { label: "最合口味", description: "最贴近你刚才选中的演员、系列和题材" },
    adjacent: { label: "换点新意", description: "保留一部分熟悉感，再换演员、系列或风格" },
    wildcard: { label: "大胆试试", description: "和常看内容差别更大，但会避开明确不喜欢的方向" }
  };
  const lanes = VIEWING_LANES.map((lane) => ({
    id: lane,
    ...laneCopy[lane],
    count: items.filter((item) => item.lane === lane).length
  }));
  return {
    id: row.id,
    preset: row.preset,
    config,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    items,
    arena: {
      rounds,
      completed: rounds.length === 0 || rounds.every((round) => Boolean(round.decision)),
      answered: rounds.filter((round) => Boolean(round.decision)).length,
      total: rounds.length,
      profile: publicProfile,
      canBranch: rounds.length < 12
    },
    lanes,
    summary: {
      total: items.length,
      unwatched: items.filter((item) => !(item.media as { playback?: unknown }).playback).length,
      favoriteMatches: items.filter((item) => item.reason.includes("收藏")).length,
      estimatedMinutes: config.durationMinutes,
      queueMinutes
    }
  };
}

function listViewingSessions(limit: number) {
  const rows = db.prepare(`
    SELECT viewing_sessions.id, viewing_sessions.preset,
      viewing_sessions.config_json AS configJson,
      viewing_sessions.status,
      viewing_sessions.created_at AS createdAt,
      viewing_sessions.updated_at AS updatedAt,
      SUM(CASE WHEN viewing_session_items.position >= 0 THEN 1 ELSE 0 END) AS itemCount,
      SUM(CASE WHEN viewing_session_items.feedback = 'like' THEN 1 ELSE 0 END) AS likedCount,
      SUM(CASE WHEN viewing_session_items.feedback IN ('skip', 'dislike') THEN 1 ELSE 0 END) AS hiddenCount
    FROM viewing_sessions
    LEFT JOIN viewing_session_items ON viewing_session_items.session_id = viewing_sessions.id
    GROUP BY viewing_sessions.id
    ORDER BY viewing_sessions.created_at DESC
    LIMIT ?
  `).all(limit) as Array<SessionRow & {
    configJson: string;
    itemCount: number;
    likedCount: number;
    hiddenCount: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    preset: row.preset,
    config: parseConfig(row.configJson),
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    summary: {
      total: Number(row.itemCount ?? 0),
      liked: Number(row.likedCount ?? 0),
      hidden: Number(row.hiddenCount ?? 0),
      estimatedMinutes: parseConfig(row.configJson).durationMinutes
    }
  }));
}

function deleteViewingSession(id: string) {
  const existing = db.prepare("SELECT id FROM viewing_sessions WHERE id = ?").get(id) as { id: string } | undefined;
  if (!existing) return null;

  db.transaction(() => {
    db.prepare("DELETE FROM viewing_sessions WHERE id = ?").run(id);
    const active = db.prepare("SELECT id FROM viewing_sessions WHERE status = 'active' LIMIT 1").get() as { id: string } | undefined;
    if (active) return;

    const fallback = db.prepare("SELECT id FROM viewing_sessions ORDER BY created_at DESC LIMIT 1").get() as { id: string } | undefined;
    if (fallback) {
      db.prepare("UPDATE viewing_sessions SET status = 'active', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), fallback.id);
    }
  })();

  return { deletedId: id, session: loadViewingSession() };
}

function seededNoise(id: string, seed: number): number {
  const value = crypto.createHash("sha1").update(`${id}:${seed}`).digest().readUInt32BE(0);
  return value / 0xffffffff;
}

function loadViewingFacetsByCode(codes: string[]): Map<string, ViewingFacet[]> {
  const uniqueCodes = [...new Set(codes.filter(Boolean))];
  if (uniqueCodes.length === 0) return new Map();
  const placeholders = uniqueCodes.map(() => "?").join(", ");
  const rows = db.prepare(`SELECT normalized_code AS normalizedCode, facet_type AS facetType,
      facet_value AS facetValue FROM media_metadata_facets
    WHERE normalized_code IN (${placeholders})
      AND facet_type IN (${VIEWING_FACET_TYPES.map(() => "?").join(", ")})`).all(
        ...uniqueCodes,
        ...VIEWING_FACET_TYPES
      ) as Array<{ normalizedCode: string; facetType: ViewingFacetType; facetValue: string }>;
  const facets = new Map<string, ViewingFacet[]>();
  for (const row of rows) {
    const items = facets.get(row.normalizedCode) ?? [];
    items.push({ type: row.facetType, value: row.facetValue });
    facets.set(row.normalizedCode, items);
  }
  return facets;
}

function loadViewingFacetsByMediaId(mediaIds: string[]): Map<string, ViewingFacet[]> {
  const uniqueIds = [...new Set(mediaIds.filter(Boolean))];
  if (uniqueIds.length === 0) return new Map();
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = db.prepare(`SELECT media_files.id AS mediaId, media_metadata_facets.facet_type AS facetType,
      media_metadata_facets.facet_value AS facetValue
    FROM media_files
    JOIN media_metadata_facets ON media_metadata_facets.normalized_code = media_files.normalized_code
    WHERE media_files.id IN (${placeholders})
      AND media_metadata_facets.facet_type IN (${VIEWING_FACET_TYPES.map(() => "?").join(", ")})`).all(
        ...uniqueIds,
        ...VIEWING_FACET_TYPES
      ) as Array<{ mediaId: string; facetType: ViewingFacetType; facetValue: string }>;
  const facets = new Map<string, ViewingFacet[]>();
  for (const row of rows) {
    const items = facets.get(row.mediaId) ?? [];
    items.push({ type: row.facetType, value: row.facetValue });
    facets.set(row.mediaId, items);
  }
  return facets;
}

function configSignals(config: ViewingConfig): ViewingSignal[] {
  const configured: Array<[ViewingFacetType, string | undefined]> = [
    ["genre", config.preferredGenre],
    ["actor", config.preferredActor],
    ["series", config.preferredSeries],
    ["director", config.preferredDirector],
    ["maker", config.preferredMaker],
    ["label", config.preferredLabel]
  ];
  return configured.flatMap(([type, value]) => value ? [{ type, value, score: 0.82 }] : []);
}

function loadBranchSignals(sessionId: string, lane?: ViewingLane): ViewingSignal[] {
  if (!lane) return [];
  const rows = db.prepare(`SELECT media_metadata_facets.facet_type AS facetType,
      media_metadata_facets.facet_value AS facetValue, COUNT(*) AS count
    FROM viewing_session_items
    JOIN media_files ON media_files.id = viewing_session_items.media_id
    JOIN media_metadata_facets ON media_metadata_facets.normalized_code = media_files.normalized_code
    WHERE viewing_session_items.session_id = ? AND viewing_session_items.lane = ?
      AND viewing_session_items.position >= 0
      AND media_metadata_facets.facet_type IN (${VIEWING_FACET_TYPES.map(() => "?").join(", ")})
    GROUP BY media_metadata_facets.facet_type, media_metadata_facets.facet_value
    ORDER BY count DESC, media_metadata_facets.facet_value
    LIMIT 5`).all(sessionId, lane, ...VIEWING_FACET_TYPES) as Array<{
      facetType: ViewingFacetType;
      facetValue: string;
      count: number;
    }>;
  return rows.map((row) => ({ type: row.facetType, value: row.facetValue, score: Math.min(0.62, 0.24 + row.count * 0.06) }));
}

function loadFeedbackSignals(sessionId: string): ViewingSignal[] {
  const rows = db.prepare(`SELECT media_metadata_facets.facet_type AS facetType,
      media_metadata_facets.facet_value AS facetValue,
      SUM(CASE viewing_session_items.feedback
        WHEN 'like' THEN 0.9
        WHEN 'dislike' THEN -0.68
        WHEN 'skip' THEN -0.22
        ELSE 0 END) AS score
    FROM viewing_session_items
    JOIN media_files ON media_files.id = viewing_session_items.media_id
    JOIN media_metadata_facets ON media_metadata_facets.normalized_code = media_files.normalized_code
    WHERE viewing_session_items.session_id = ?
      AND viewing_session_items.feedback IN ('like', 'dislike', 'skip')
      AND media_metadata_facets.facet_type IN (${VIEWING_FACET_TYPES.map(() => "?").join(", ")})
    GROUP BY media_metadata_facets.facet_type, media_metadata_facets.facet_value
    HAVING ABS(SUM(CASE viewing_session_items.feedback
      WHEN 'like' THEN 0.9
      WHEN 'dislike' THEN -0.68
      WHEN 'skip' THEN -0.22
      ELSE 0 END)) > 0.08
    ORDER BY ABS(score) DESC, media_metadata_facets.facet_value
    LIMIT 12`).all(sessionId, ...VIEWING_FACET_TYPES) as Array<{
      facetType: ViewingFacetType;
      facetValue: string;
      score: number;
    }>;
  return rows.map((row) => ({
    type: row.facetType,
    value: row.facetValue,
    score: Math.max(-1.8, Math.min(1.8, Number(row.score)))
  }));
}

function buildSessionArenaProfile(
  sessionId: string,
  config: ViewingConfig,
  suppliedRounds?: ArenaRoundRow[]
): ArenaSignalProfile {
  const rounds = suppliedRounds ?? db.prepare(`SELECT round_index AS roundIndex,
      left_media_id AS leftMediaId, right_media_id AS rightMediaId,
      winner_media_id AS winnerMediaId, decision, strategy, prompt
    FROM viewing_arena_rounds WHERE session_id = ? ORDER BY round_index`).all(sessionId) as ArenaRoundRow[];
  const mediaIds = rounds.flatMap((round) => [round.leftMediaId, round.rightMediaId]);
  return buildArenaSignalProfile({
    initialSignals: configSignals(config),
    branchSignals: [
      ...loadBranchSignals(sessionId, config.focusLane),
      ...loadFeedbackSignals(sessionId)
    ],
    rounds,
    facetsByMediaId: loadViewingFacetsByMediaId(mediaIds)
  });
}

function sessionSeed(sessionId: string, offset = 0): number {
  return crypto.createHash("sha1").update(sessionId).digest().readUInt32BE(0) + offset * 977;
}

const VIEWING_COLD_START_EXIT_THRESHOLD = 4;

function countViewingBehaviorSignals(): number {
  const playback = db.prepare("SELECT COUNT(*) AS count FROM playback_progress").get() as { count: number };
  const decisions = db.prepare("SELECT COUNT(*) AS count FROM viewing_arena_rounds WHERE decision != ''").get() as { count: number };
  return readFavoriteKeys().size + readEntityFavorites().length + Number(playback.count) + Number(decisions.count);
}

function parseStarterFacet(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 30 && !/[?？!！]/.test(item))
      : [];
  } catch {
    return [];
  }
}

function loadViewingBootstrap() {
  const realSignalCount = countViewingBehaviorSignals();
  const coldStart = realSignalCount < VIEWING_COLD_START_EXIT_THRESHOLD;
  const rows = db.prepare(`
    SELECT ${MEDIA_LIST_SELECT}
    FROM media_files
    ${MEDIA_LIST_JOINS}
    WHERE media_files.media_type = 'video'
      AND media_metadata.status = 'ready'
      AND TRIM(COALESCE(media_metadata.title, '')) != ''
      AND (
        media_files.normalized_code = '' OR NOT EXISTS (
          SELECT 1 FROM media_files preferred
          WHERE preferred.library_category = media_files.library_category
            AND preferred.normalized_code = media_files.normalized_code
            AND (preferred.size > media_files.size OR (preferred.size = media_files.size AND preferred.id < media_files.id))
        )
      )
    ORDER BY media_files.first_seen_at DESC, media_files.mtime_ms DESC
    LIMIT 96
  `).all() as MediaListRow[];
  const dailySeed = Number(new Date().toISOString().slice(0, 10).replaceAll("-", ""));
  const usable = rows.filter((row) => (
    parseStarterFacet(row.metadataActorsJson).length > 0 && parseStarterFacet(row.metadataGenresJson).length > 0
  ));
  const ordered = [...(usable.length >= 8 ? usable : rows)].sort((left, right) => (
    seededNoise(left.id, dailySeed) - seededNoise(right.id, dailySeed)
  ));
  const selected: MediaListRow[] = [];
  const seenActors = new Set<string>();
  for (const row of ordered) {
    const actor = parseStarterFacet(row.metadataActorsJson)[0] ?? "";
    if (actor && seenActors.has(actor) && selected.length < 6) continue;
    selected.push(row);
    if (actor) seenActors.add(actor);
    if (selected.length >= 12) break;
  }
  const fallback = ordered.find((row) => !selected.includes(row));
  if (selected.length < 8 && fallback) selected.push(fallback);
  const anchor = selected.find((row) => parseStarterFacet(row.metadataActorsJson).length > 0);
  const actor = parseStarterFacet(anchor?.metadataActorsJson ?? null)[0] ?? "最近入库影片中的演员";
  const genre = parseStarterFacet(anchor?.metadataGenresJson ?? null)
    .find((value) => !GENERIC_GRAPH_GENRES.has(value.toLocaleLowerCase())) ?? "资料较完整的影片";
  const signals: ViewingBootstrapSignal[] = coldStart ? [
    { id: "browse", label: "参考演员", value: actor, simulated: true },
    { id: "favorite", label: "参考题材", value: genre, simulated: true },
    { id: "pace", label: "预计时长", value: "约 1 小时", simulated: true }
  ] : [];
  const items = hydrateMediaRows(selected, readFavoriteKeys());
  return {
    coldStart,
    realSignalCount,
    exitThreshold: VIEWING_COLD_START_EXIT_THRESHOLD,
    signals,
    items,
    summary: {
      total: items.length,
      unwatched: items.filter((item) => !item.playback).length,
      favoriteMatches: items.filter((item) => item.isFavorite).length
    }
  };
}

function getCandidateReason(candidate: ViewingCandidate, favorite: boolean, config: ViewingConfig): string {
  if (candidate.preferredActorMatch > 0 && config.preferredActor) return `你选择了演员：${config.preferredActorLabel ?? config.preferredActor}`;
  if (candidate.preferredSeriesMatch > 0 && config.preferredSeries) return `来自你选择的系列：${config.preferredSeriesLabel ?? config.preferredSeries}`;
  if (candidate.preferredGenreMatch > 0 && config.preferredGenre) return `符合你选择的题材：${config.preferredGenreLabel ?? config.preferredGenre}`;
  if (candidate.preferredDirectorMatch > 0 && config.preferredDirector) return `来自你选择的导演：${config.preferredDirectorLabel ?? config.preferredDirector}`;
  if (candidate.preferredMakerMatch > 0 && config.preferredMaker) return `来自你选择的厂商：${config.preferredMakerLabel ?? config.preferredMaker}`;
  if (candidate.preferredLabelMatch > 0 && config.preferredLabel) return `来自你选择的厂牌：${config.preferredLabelLabel ?? config.preferredLabel}`;
  if (favorite) return "你收藏过这部";
  if (candidate.favoriteEntityMatches > 0) return "和你的收藏有相似之处";
  if (candidate.playbackLastPlayedAt && !candidate.playbackCompleted) return "上次还没看完";
  if (!candidate.playbackLastPlayedAt) return "还没有播放过";
  if (candidate.metadataReleaseDate) return `发行日期：${candidate.metadataReleaseDate}`;
  return "综合本次选择推荐";
}

function loadScoredViewingCandidates(config: ViewingConfig, seed: number): ScoredViewingCandidate[] {
  const params = {
    category: config.category,
    excludeRecentlyWatched: Number(config.excludeRecentlyWatched),
    unwatchedOnly: Number(config.preset === "unwatched"),
    preferredGenreAliases: JSON.stringify(config.preferredGenre ? getTopicAliases("genre", config.preferredGenre) : []),
    preferredActorAliases: JSON.stringify(config.preferredActor ? getTopicAliases("actor", config.preferredActor) : []),
    preferredSeriesAliases: JSON.stringify(config.preferredSeries ? getTopicAliases("series", config.preferredSeries) : []),
    preferredDirectorAliases: JSON.stringify(config.preferredDirector ? getTopicAliases("director", config.preferredDirector) : []),
    preferredMakerAliases: JSON.stringify(config.preferredMaker ? getTopicAliases("maker", config.preferredMaker) : []),
    preferredLabelAliases: JSON.stringify(config.preferredLabel ? getTopicAliases("label", config.preferredLabel) : [])
  };
  const candidates = db.prepare(`
    SELECT ${MEDIA_LIST_SELECT},
      media_files.first_seen_at AS firstSeenAt,
      (SELECT COUNT(*) FROM media_metadata_facets candidate_facets
       JOIN entity_favorites ON entity_favorites.facet_type = candidate_facets.facet_type
        AND entity_favorites.facet_value = candidate_facets.facet_value
       WHERE candidate_facets.normalized_code = media_files.normalized_code) AS favoriteEntityMatches,
      EXISTS(SELECT 1 FROM media_metadata_facets preferred_genre
        WHERE preferred_genre.normalized_code = media_files.normalized_code
          AND preferred_genre.facet_type = 'genre'
          AND preferred_genre.facet_value IN (SELECT value FROM json_each(@preferredGenreAliases))) AS preferredGenreMatch,
      EXISTS(SELECT 1 FROM media_metadata_facets preferred_actor
        WHERE preferred_actor.normalized_code = media_files.normalized_code
          AND preferred_actor.facet_type = 'actor'
          AND preferred_actor.facet_value IN (SELECT value FROM json_each(@preferredActorAliases))) AS preferredActorMatch,
      EXISTS(SELECT 1 FROM media_metadata_facets preferred_series
        WHERE preferred_series.normalized_code = media_files.normalized_code
          AND preferred_series.facet_type = 'series'
          AND preferred_series.facet_value IN (SELECT value FROM json_each(@preferredSeriesAliases))) AS preferredSeriesMatch,
      EXISTS(SELECT 1 FROM media_metadata_facets preferred_director
        WHERE preferred_director.normalized_code = media_files.normalized_code
          AND preferred_director.facet_type = 'director'
          AND preferred_director.facet_value IN (SELECT value FROM json_each(@preferredDirectorAliases))) AS preferredDirectorMatch,
      EXISTS(SELECT 1 FROM media_metadata_facets preferred_maker
        WHERE preferred_maker.normalized_code = media_files.normalized_code
          AND preferred_maker.facet_type = 'maker'
          AND preferred_maker.facet_value IN (SELECT value FROM json_each(@preferredMakerAliases))) AS preferredMakerMatch,
      EXISTS(SELECT 1 FROM media_metadata_facets preferred_label
        WHERE preferred_label.normalized_code = media_files.normalized_code
          AND preferred_label.facet_type = 'label'
          AND preferred_label.facet_value IN (SELECT value FROM json_each(@preferredLabelAliases))) AS preferredLabelMatch
    FROM media_files
    ${MEDIA_LIST_JOINS}
    WHERE media_files.media_type = 'video'
      AND (@category = 'ALL' OR media_files.library_category = @category)
      AND (@unwatchedOnly = 0 OR playback_progress.last_played_at IS NULL)
      AND (@excludeRecentlyWatched = 0 OR playback_progress.last_played_at IS NULL
        OR playback_progress.last_played_at < datetime('now', '-14 days'))
      AND NOT EXISTS (
        SELECT 1 FROM viewing_session_items history
        WHERE history.media_id = media_files.id AND history.feedback = 'dislike'
      )
      AND (
        media_files.normalized_code = '' OR NOT EXISTS (
          SELECT 1 FROM media_files preferred
          WHERE preferred.library_category = media_files.library_category
            AND preferred.normalized_code = media_files.normalized_code
            AND (preferred.size > media_files.size OR (preferred.size = media_files.size AND preferred.id < media_files.id))
        )
      )
    ORDER BY preferredActorMatch DESC,
      preferredSeriesMatch DESC,
      preferredGenreMatch DESC,
      preferredDirectorMatch DESC,
      preferredMakerMatch DESC,
      preferredLabelMatch DESC,
      media_files.mtime_ms DESC
    LIMIT 720
  `).all(params) as ViewingCandidate[];

  const favoriteKeys = readFavoriteKeys();
  const scored = candidates.map((candidate) => {
    const favorite = favoriteKeys.has(candidate.relativePath);
    let score = seededNoise(candidate.id, seed) * (config.preset === "explore" ? 28 : 12);
    if (!candidate.playbackLastPlayedAt) score += 18;
    if (candidate.playbackLastPlayedAt && !candidate.playbackCompleted) score += 10;
    if (candidate.compatibilityStatus && candidate.compatibilityStatus !== "unsupported") score += 7;
    if (config.favoriteBias) score += candidate.favoriteEntityMatches * (config.preset === "favorites" ? 18 : 9);
    score += candidate.preferredGenreMatch * 52;
    score += candidate.preferredActorMatch * 76;
    score += candidate.preferredSeriesMatch * 64;
    score += candidate.preferredDirectorMatch * 48;
    score += candidate.preferredMakerMatch * 34;
    score += candidate.preferredLabelMatch * 38;
    if (favorite) score += config.preset === "favorites" ? 70 : 34;
    return { candidate, favorite, score, reason: getCandidateReason(candidate, favorite, config) };
  }).sort((left, right) => right.score - left.score ||
    String(left.candidate.name).localeCompare(String(right.candidate.name)));

  const metadataReady = scored.filter(({ candidate }) => {
    if (candidate.metadataStatus !== "ready" || !candidate.metadataTitle?.trim()) return false;
    try {
      const actors = JSON.parse(candidate.metadataActorsJson ?? "[]") as unknown[];
      const genres = JSON.parse(candidate.metadataGenresJson ?? "[]") as unknown[];
      const hasUsableActor = actors.some((actor) => typeof actor === "string" && actor.length <= 30 && !/[?？!！]/.test(actor));
      return hasUsableActor && genres.length > 0;
    } catch {
      return false;
    }
  });
  const usable = metadataReady.length >= 6 ? metadataReady : scored;
  const facetsByCode = loadViewingFacetsByCode(usable.map((item) => item.candidate.normalizedCode));
  return usable.map((item) => ({
    ...item,
    facets: facetsByCode.get(item.candidate.normalizedCode) ?? []
  }));
}

function rankViewingCandidates(
  candidates: ScoredViewingCandidate[],
  profile: ArenaSignalProfile,
  config: ViewingConfig,
  pinnedIds: string[] = []
): RankedArenaCandidate<ScoredViewingCandidate>[] {
  return rankArenaCandidates({
    candidates: candidates.map((item) => ({
      id: item.candidate.id,
      normalizedCode: item.candidate.normalizedCode,
      baseScore: item.score,
      routeMatchCount: item.candidate.preferredGenreMatch
        + item.candidate.preferredActorMatch
        + item.candidate.preferredSeriesMatch
        + item.candidate.preferredDirectorMatch
        + item.candidate.preferredMakerMatch
        + item.candidate.preferredLabelMatch
        + Math.min(1, item.candidate.favoriteEntityMatches),
      favorite: item.favorite,
      unwatched: !item.candidate.playbackLastPlayedAt,
      facets: item.facets,
      payload: item
    })),
    profile,
    limit: config.limit,
    pinnedIds,
    focusLane: config.focusLane
  });
}

function writeViewingSessionItems(
  sessionId: string,
  ranked: RankedArenaCandidate<ScoredViewingCandidate>[],
  now: string
): void {
  const previousItems = db.prepare(`SELECT media_id AS mediaId, position, lane, reason, score, feedback,
      created_at AS createdAt
    FROM viewing_session_items WHERE session_id = ?`).all(sessionId) as Array<SessionItemRow & { createdAt: string }>;
  const previousById = new Map(previousItems.map((item) => [item.mediaId, item]));
  db.prepare("DELETE FROM viewing_session_items WHERE session_id = ?").run(sessionId);
  const insert = db.prepare(`INSERT INTO viewing_session_items
    (session_id, media_id, position, lane, reason, score, feedback, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const activeIds = new Set<string>();
  ranked.forEach((item, position) => {
    const previous = previousById.get(item.id);
    activeIds.add(item.id);
    insert.run(
      sessionId,
      item.id,
      position,
      item.lane,
      item.reason,
      item.score,
      previous?.feedback ?? "",
      previous?.createdAt ?? now,
      now
    );
  });
  for (const previous of previousItems) {
    if (!previous.feedback || activeIds.has(previous.mediaId)) continue;
    insert.run(
      sessionId,
      previous.mediaId,
      -1,
      VIEWING_LANES.includes(previous.lane) ? previous.lane : "core",
      previous.reason,
      previous.score,
      previous.feedback,
      previous.createdAt,
      now
    );
  }
}

function loadArenaPairCandidates(sessionId: string): ArenaPairCandidate[] {
  const rows = db.prepare(`SELECT viewing_session_items.media_id AS id,
      viewing_session_items.lane, viewing_session_items.score,
      media_files.normalized_code AS normalizedCode
    FROM viewing_session_items
    JOIN media_files ON media_files.id = viewing_session_items.media_id
    WHERE viewing_session_items.session_id = ? AND viewing_session_items.position >= 0`).all(sessionId) as Array<{
      id: string;
      lane: ViewingLane;
      score: number;
      normalizedCode: string;
    }>;
  const facetsByCode = loadViewingFacetsByCode(rows.map((row) => row.normalizedCode));
  return rows.map((row) => ({
    id: row.id,
    lane: VIEWING_LANES.includes(row.lane) ? row.lane : "core",
    score: row.score,
    facets: facetsByCode.get(row.normalizedCode) ?? []
  }));
}

function insertArenaRounds(
  sessionId: string,
  startIndex: number,
  count: number,
  focusLane: ViewingLane | undefined,
  now: string
): void {
  const candidates = loadArenaPairCandidates(sessionId);
  const usedMediaIds = new Set<string>();
  const existing = db.prepare(`SELECT left_media_id AS leftMediaId, right_media_id AS rightMediaId
    FROM viewing_arena_rounds WHERE session_id = ?`).all(sessionId) as Array<{ leftMediaId: string; rightMediaId: string }>;
  for (const round of existing) {
    usedMediaIds.add(round.leftMediaId);
    usedMediaIds.add(round.rightMediaId);
  }
  const insertRound = db.prepare(`INSERT INTO viewing_arena_rounds
    (session_id, round_index, left_media_id, right_media_id, winner_media_id, decision, strategy, prompt, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, '', ?, ?, ?, ?)`);
  for (let offset = 0; offset < count; offset += 1) {
    const roundIndex = startIndex + offset;
    const pair = pickAdaptiveArenaPair({
      candidates,
      usedMediaIds,
      strategyIndex: roundIndex,
      seed: sessionSeed(sessionId, roundIndex),
      focusLane
    });
    if (!pair) break;
    insertRound.run(
      sessionId,
      roundIndex,
      pair.left.id,
      pair.right.id,
      pair.strategy.id,
      pair.strategy.prompt,
      now,
      now
    );
    usedMediaIds.add(pair.left.id);
    usedMediaIds.add(pair.right.id);
  }
}

function refreshViewingSessionRecommendations(sessionId: string): void {
  const row = db.prepare(`SELECT config_json AS configJson FROM viewing_sessions WHERE id = ?`).get(sessionId) as { configJson: string } | undefined;
  if (!row) return;
  const config = parseConfig(row.configJson);
  const profile = buildSessionArenaProfile(sessionId, config);
  const candidates = loadScoredViewingCandidates(config, sessionSeed(sessionId, profile.decidedRounds));
  const winnerIds = (db.prepare(`SELECT winner_media_id AS mediaId FROM viewing_arena_rounds
    WHERE session_id = ? AND decision = 'choose' AND winner_media_id IS NOT NULL
    ORDER BY round_index`).all(sessionId) as Array<{ mediaId: string }>).map((item) => item.mediaId);
  const likedIds = (db.prepare(`SELECT media_id AS mediaId FROM viewing_session_items
    WHERE session_id = ? AND feedback = 'like'`).all(sessionId) as Array<{ mediaId: string }>).map((item) => item.mediaId);
  const pinnedIds = [...new Set([...winnerIds, ...likedIds])];
  const ranked = rankViewingCandidates(candidates, profile, config, pinnedIds);
  writeViewingSessionItems(sessionId, ranked, new Date().toISOString());
}

function replaceArenaRound(sessionId: string, roundIndex: number): void {
  const row = db.prepare(`SELECT config_json AS configJson FROM viewing_sessions WHERE id = ?`).get(sessionId) as { configJson: string } | undefined;
  if (!row) return;
  const config = parseConfig(row.configJson);
  const candidates = loadArenaPairCandidates(sessionId);
  const usedRows = db.prepare(`SELECT left_media_id AS leftMediaId, right_media_id AS rightMediaId
    FROM viewing_arena_rounds WHERE session_id = ?`).all(sessionId) as Array<{ leftMediaId: string; rightMediaId: string }>;
  const usedMediaIds = new Set(usedRows.flatMap((item) => [item.leftMediaId, item.rightMediaId]));
  const pair = pickAdaptiveArenaPair({
    candidates,
    usedMediaIds,
    strategyIndex: roundIndex,
    seed: sessionSeed(sessionId, roundIndex + Date.now()),
    focusLane: config.focusLane
  });
  if (!pair) return;
  db.prepare(`UPDATE viewing_arena_rounds
    SET left_media_id = ?, right_media_id = ?, winner_media_id = NULL, decision = '', strategy = ?, prompt = ?, updated_at = ?
    WHERE session_id = ? AND round_index = ?`).run(
      pair.left.id,
      pair.right.id,
      pair.strategy.id,
      pair.strategy.prompt,
      new Date().toISOString(),
      sessionId,
      roundIndex
    );
}

function replaceNextPendingArenaRound(sessionId: string): void {
  const next = db.prepare(`SELECT round_index AS roundIndex FROM viewing_arena_rounds
    WHERE session_id = ? AND decision = '' ORDER BY round_index LIMIT 1`).get(sessionId) as { roundIndex: number } | undefined;
  if (next) replaceArenaRound(sessionId, next.roundIndex);
}

function startViewingBranch(sessionId: string, lane: ViewingLane): { status: "ok" | "missing" | "pending" | "limit"; session?: ReturnType<typeof loadViewingSession> } {
  const row = db.prepare(`SELECT config_json AS configJson FROM viewing_sessions WHERE id = ?`).get(sessionId) as { configJson: string } | undefined;
  if (!row) return { status: "missing" };
  const pending = db.prepare(`SELECT COUNT(*) AS count FROM viewing_arena_rounds
    WHERE session_id = ? AND decision = ''`).get(sessionId) as { count: number };
  if (pending.count > 0) return { status: "pending" };
  const total = db.prepare(`SELECT COUNT(*) AS count FROM viewing_arena_rounds WHERE session_id = ?`).get(sessionId) as { count: number };
  if (total.count >= 12) return { status: "limit" };
  const config = { ...parseConfig(row.configJson), focusLane: lane };
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE viewing_sessions SET config_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(config), now, sessionId);
    refreshViewingSessionRecommendations(sessionId);
    insertArenaRounds(sessionId, total.count, Math.min(3, 12 - total.count), lane, now);
  })();
  return { status: "ok", session: loadViewingSession(sessionId) };
}

export function generateViewingSession(config: ViewingConfig) {
  const sessionId = crypto.randomUUID();
  const profile = buildArenaSignalProfile({
    initialSignals: configSignals(config),
    rounds: [],
    facetsByMediaId: new Map()
  });
  const selected = rankViewingCandidates(loadScoredViewingCandidates(config, sessionSeed(sessionId)), profile, config);
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare("UPDATE viewing_sessions SET status = 'archived', updated_at = ? WHERE status = 'active'").run(now);
    db.prepare(`INSERT INTO viewing_sessions (id, preset, config_json, status, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?)`).run(sessionId, config.preset, JSON.stringify(config), now, now);
    writeViewingSessionItems(sessionId, selected, now);
    const routeRoundCount = config.preset === "quick" ? 4 : config.preset === "favorites" ? 6 : 5;
    insertArenaRounds(sessionId, 0, Math.min(routeRoundCount, Math.floor(selected.length / 2)), config.focusLane, now);
  })();
  return loadViewingSession(sessionId);
}

function parseGraphTypes(value: string): Array<(typeof GRAPH_TYPES)[number]> {
  const parsed = value.split(",").map((item) => item.trim()).filter(Boolean);
  const valid = parsed.flatMap((item) => {
    const result = graphTypeSchema.safeParse(item);
    return result.success ? [result.data] : [];
  });
  return valid.length > 0 ? [...new Set(valid)] : [...GRAPH_TYPES];
}

function graphNodeId(type: string, value: string): string {
  return `${type}:${Buffer.from(value).toString("base64url")}`;
}

function normalizeGraphLabel(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s\-_・·]+/g, "");
}

function encodeGraphCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString("base64url");
}

function decodeGraphCursor(cursor?: string): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { offset?: unknown };
    if (!Number.isInteger(parsed.offset) || Number(parsed.offset) < 0 || Number(parsed.offset) > 100_000) {
      throw new Error("invalid offset");
    }
    return Number(parsed.offset);
  } catch {
    throw new z.ZodError([{
      code: z.ZodIssueCode.custom,
      path: ["cursor"],
      message: "Invalid pagination cursor"
    }]);
  }
}

function relationDescriptor(left: GraphType, right: GraphType): { relationType: string; relationLabel: string } | null {
  if (left === right) {
    if (left === "actor") return { relationType: "actor_collaboration", relationLabel: "合作演员" };
    if (left === "genre") return { relationType: "genre_cooccurrence", relationLabel: "共现标签" };
    return null;
  }
  const pair = [left, right].sort((a, b) => GRAPH_TYPES.indexOf(a) - GRAPH_TYPES.indexOf(b)).join(":");
  const labels: Record<string, string> = {
    "actor:series": "出演系列",
    "actor:genre": "作品标签",
    "actor:director": "合作导演",
    "actor:maker": "合作片商",
    "actor:label": "合作厂牌",
    "series:genre": "系列标签",
    "series:director": "系列导演",
    "series:maker": "系列片商",
    "series:label": "系列厂牌",
    "genre:director": "导演标签",
    "genre:maker": "片商标签",
    "genre:label": "厂牌标签",
    "director:maker": "合作片商",
    "director:label": "合作厂牌",
    "maker:label": "片商厂牌"
  };
  return { relationType: pair.replace(":", "_"), relationLabel: labels[pair] ?? "作品关联" };
}

function knownGraphReleaseSql(metadataAlias = "media_metadata"): string {
  const date = `${metadataAlias}.release_date`;
  // Local catalogs may know the year without claiming an exact release day.
  return `(
    (${date} GLOB '[0-9][0-9][0-9][0-9]' AND CAST(${date} AS INTEGER) >= 1
      AND CAST(${date} AS INTEGER) <= CAST(STRFTIME('%Y', 'now', 'localtime') AS INTEGER))
    OR (${date} = DATE(${date}) AND DATE(${date}) <= DATE('now', 'localtime'))
  )`;
}

function graphFilterSql(metadataAlias = "media_metadata", mediaAlias = "media_files"): string {
  return `
    AND (@category = 'ALL' OR ${mediaAlias}.library_category = @category)
    AND ${metadataAlias}.status = 'ready'
    AND (
      TRIM(COALESCE(${metadataAlias}.release_date, '')) = ''
      OR ${knownGraphReleaseSql(metadataAlias)}
    )
    AND ((@startYear IS NULL AND @endYear IS NULL)
      OR TRIM(COALESCE(${metadataAlias}.release_date, '')) != '')
    AND (@startYear IS NULL OR CAST(SUBSTR(${metadataAlias}.release_date, 1, 4) AS INTEGER) >= @startYear)
    AND (@endYear IS NULL OR CAST(SUBSTR(${metadataAlias}.release_date, 1, 4) AS INTEGER) <= @endYear)
  `;
}

function graphFilterParams(category: GraphCategory, years: GraphYearRange) {
  return { category, startYear: years.startYear ?? null, endYear: years.endYear ?? null };
}

const graphEntityCache = new Map<GraphType, {
  items: GraphEntity[];
  byAlias: Map<string, GraphEntity>;
  expiresAt: number;
}>();

function getGraphEntities(type: GraphType) {
  const cached = graphEntityCache.get(type);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const items = getTopicGraphItems(type as TopicType).map((item): GraphEntity => ({
    id: graphNodeId(type, item.value),
    type,
    value: item.value,
    label: item.label,
    aliases: [...new Set([item.value, ...item.aliases])],
    mediaId: item.mediaId,
    coverKind: item.customCoverMediaId ? "manual" : item.mediaId ? "representative" : "none",
    latestReleaseDate: item.latestReleaseDate
  }));
  const byAlias = new Map<string, GraphEntity>();
  for (const item of items) {
    byAlias.set(item.value, item);
    for (const alias of item.aliases) byAlias.set(alias, item);
  }
  const value = { items, byAlias, expiresAt: Date.now() + 2 * 60 * 1000 };
  graphEntityCache.set(type, value);
  return value;
}

function resolveGraphEntity(type: GraphType, value: string): GraphEntity {
  const known = getGraphEntities(type).byAlias.get(value);
  if (known) return known;
  const aliases = getTopicAliases(type as TopicType, value).slice(0, 12);
  return {
    id: graphNodeId(type, value),
    type,
    value,
    label: value,
    aliases: aliases.length > 0 ? aliases : [value],
    mediaId: null,
    coverKind: "none",
    latestReleaseDate: null
  };
}

function loadFilteredGraphNodes(
  type: GraphType,
  category: GraphCategory,
  years: GraphYearRange,
  favoriteKeys: Set<string>
): GraphNode[] {
  const rows = db.prepare(`
    SELECT facets.facet_value AS facetValue,
      media_files.library_category || ':' || media_files.normalized_code AS logicalKey,
      MAX(NULLIF(media_metadata.release_date, '')) AS releaseDate,
      COALESCE(
        MIN(CASE WHEN media_files.thumbnail_status = 'ready' THEN media_files.id END),
        MIN(media_files.id)
      ) AS mediaId
    FROM media_metadata_facets facets
    JOIN media_files ON media_files.normalized_code = facets.normalized_code
    LEFT JOIN media_metadata ON media_metadata.normalized_code = facets.normalized_code
    WHERE facets.facet_type = @type ${graphFilterSql()}
    GROUP BY facets.facet_value, media_files.library_category, media_files.normalized_code
  `).all({ type, ...graphFilterParams(category, years) }) as Array<{
    facetValue: string;
    logicalKey: string;
    releaseDate: string | null;
    mediaId: string | null;
  }>;
  const aggregates = new Map<string, {
    entity: GraphEntity;
    logicalKeys: Set<string>;
    latestReleaseDate: string | null;
    mediaId: string | null;
  }>();
  const entities = getGraphEntities(type);
  for (const row of rows) {
    const entity = entities.byAlias.get(row.facetValue) ?? resolveGraphEntity(type, row.facetValue);
    const aggregate = aggregates.get(entity.id) ?? {
      entity,
      logicalKeys: new Set<string>(),
      latestReleaseDate: null,
      mediaId: null
    };
    aggregate.logicalKeys.add(row.logicalKey);
    if (row.releaseDate && (!aggregate.latestReleaseDate || row.releaseDate > aggregate.latestReleaseDate)) {
      aggregate.latestReleaseDate = row.releaseDate;
      aggregate.mediaId = row.mediaId;
    } else if (!aggregate.mediaId) {
      aggregate.mediaId = row.mediaId;
    }
    aggregates.set(entity.id, aggregate);
  }
  return [...aggregates.values()].map(({ entity, logicalKeys, latestReleaseDate, mediaId }) => ({
    ...entity,
    aliases: entity.aliases,
    mediaCount: logicalKeys.size,
    isFavorite: entity.aliases.some((alias) => favoriteKeys.has(`${type}\u0000${alias}`)),
    degree: 0,
    mediaId: entity.coverKind === "manual" ? entity.mediaId : mediaId,
    coverKind: entity.coverKind === "manual" ? "manual" : mediaId ? "representative" : "none",
    latestReleaseDate
  }));
}

function loadGraphYearStats(types: GraphType[], category: GraphCategory) {
  const placeholders = types.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT CAST(SUBSTR(media_metadata.release_date, 1, 4) AS INTEGER) AS year,
      COUNT(DISTINCT media_files.library_category || ':' || media_files.normalized_code) AS count
    FROM media_metadata_facets facets
    JOIN media_files ON media_files.normalized_code = facets.normalized_code
    JOIN media_metadata ON media_metadata.normalized_code = facets.normalized_code
    WHERE facets.facet_type IN (${placeholders})
      AND media_metadata.status = 'ready'
      AND ${knownGraphReleaseSql()}
      AND (? = 'ALL' OR media_files.library_category = ?)
    GROUP BY year
    ORDER BY year
  `).all(...types, category, category) as Array<{ year: number; count: number }>;
  return {
    availableYearRange: rows.length > 0 ? { min: Number(rows[0].year), max: Number(rows.at(-1)?.year) } : null,
    yearDistribution: rows.map((row) => ({ year: Number(row.year), count: Number(row.count) }))
  };
}

function buildKnowledgeGraph(
  types: GraphType[],
  q: string,
  limit: number,
  minShared: number,
  category: GraphCategory,
  hideGeneric: boolean,
  years: GraphYearRange
) {
  const normalizedQuery = q.toLocaleLowerCase();
  const favoriteKeys = new Set(readEntityFavorites().map((item) => `${item.type}\u0000${item.value}`));
  const perTypeLimit = Math.max(5, Math.ceil(limit / types.length));
  const candidates = new Map<GraphType, GraphNode[]>();
  for (const type of types) {
    const nodes = loadFilteredGraphNodes(type, category, years, favoriteKeys)
      .filter((item) => !normalizedQuery || [item.label, item.value, ...item.aliases]
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery)))
      .filter((item) => type !== "genre" || !hideGeneric || !GENERIC_GRAPH_GENRES.has(normalizeGraphLabel(item.label)))
      .sort((left, right) => right.mediaCount - left.mediaCount || left.label.localeCompare(right.label, "zh-CN"))
      .slice(0, perTypeLimit);
    candidates.set(type, nodes);
  }

  const nodes: GraphNode[] = [];
  for (let index = 0; nodes.length < limit; index += 1) {
    let added = false;
    for (const type of types) {
      const node = candidates.get(type)?.[index];
      if (!node || nodes.length >= limit) continue;
      nodes.push(node);
      added = true;
    }
    if (!added) break;
  }

  const selectedAliases = nodes.flatMap((node) => node.aliases.slice(0, 6).map((alias) => ({ node, alias })));
  let edges: GraphEdge[] = [];
  if (selectedAliases.length > 1) {
    const values = selectedAliases.map(() => "(?, ?, ?)").join(", ");
    const valuesParams = selectedAliases.flatMap(({ node, alias }) => [node.id, node.type, alias]);
    const rows = db.prepare(`
      WITH selected(node_id, facet_type, facet_value) AS (VALUES ${values}),
      node_codes AS (
        SELECT DISTINCT selected.node_id, selected.facet_type, facets.normalized_code
        FROM selected
        JOIN media_metadata_facets facets ON facets.facet_type = selected.facet_type
          AND facets.facet_value = selected.facet_value
        JOIN media_files ON media_files.normalized_code = facets.normalized_code
        LEFT JOIN media_metadata ON media_metadata.normalized_code = facets.normalized_code
        WHERE 1 = 1 ${graphFilterSql()}
      ),
      node_counts AS (
        SELECT node_id, COUNT(DISTINCT normalized_code) AS media_count
        FROM node_codes
        GROUP BY node_id
      )
      SELECT left_node.node_id AS source, right_node.node_id AS target,
        COUNT(DISTINCT left_node.normalized_code) AS sharedCount,
        source_count.media_count AS sourceCount,
        target_count.media_count AS targetCount
      FROM node_codes left_node
      JOIN node_codes right_node ON right_node.normalized_code = left_node.normalized_code
        AND right_node.node_id > left_node.node_id
        AND (right_node.facet_type != left_node.facet_type OR left_node.facet_type IN ('actor', 'genre'))
      JOIN node_counts source_count ON source_count.node_id = left_node.node_id
      JOIN node_counts target_count ON target_count.node_id = right_node.node_id
      GROUP BY left_node.node_id, right_node.node_id
      HAVING sharedCount >= @minShared
    `).all(...valuesParams, { ...graphFilterParams(category, years), minShared }) as Array<{
      source: string;
      target: string;
      sharedCount: number;
      sourceCount: number;
      targetCount: number;
    }>;
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    edges = rows.flatMap((row) => {
        const sourceNode = nodeById.get(row.source);
        const targetNode = nodeById.get(row.target);
        if (!sourceNode || !targetNode) return [];
        const relation = relationDescriptor(sourceNode.type, targetNode.type);
        if (!relation) return [];
        const affinity = row.sharedCount / Math.sqrt(Math.max(1, row.sourceCount * row.targetCount));
        const strength = affinity * Math.log1p(row.sharedCount);
        return [{ ...relation, source: row.source, target: row.target, weight: row.sharedCount,
          affinity, strength, id: `${row.source}|${row.target}` }];
      })
      .sort((left, right) => right.strength - left.strength || right.weight - left.weight)
      .slice(0, Math.min(180, limit * 3));
  }
  const degree = new Map<string, number>();
  edges.forEach((edge) => {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  });
  nodes.forEach((node) => { node.degree = degree.get(node.id) ?? 0; });
  const yearStats = loadGraphYearStats(types, category);

  return {
    nodes,
    edges,
    ...yearStats,
    summary: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      mediaConnections: edges.reduce((total, edge) => total + edge.weight, 0),
      types: types.map((type) => ({ type, count: nodes.filter((node) => node.type === type).length })),
      ...yearStats,
      selectedYearRange: { yearFrom: years.startYear ?? null, yearTo: years.endYear ?? null }
    },
    generatedAt: new Date().toISOString()
  };
}

function loadGraphEntityStats(entity: GraphEntity, category: GraphCategory, years: GraphYearRange) {
  const placeholders = entity.aliases.map(() => "?").join(", ");
  const row = db.prepare(`
    SELECT COUNT(DISTINCT media_files.library_category || ':' || media_files.normalized_code) AS mediaCount,
      MAX(NULLIF(media_metadata.release_date, '')) AS latestReleaseDate,
      COALESCE(
        MIN(CASE WHEN media_files.thumbnail_status = 'ready' THEN media_files.id END),
        MIN(media_files.id)
      ) AS mediaId
    FROM media_metadata_facets facets
    JOIN media_files ON media_files.normalized_code = facets.normalized_code
    LEFT JOIN media_metadata ON media_metadata.normalized_code = facets.normalized_code
    WHERE facets.facet_type = ? AND facets.facet_value IN (${placeholders}) ${graphFilterSql()}
  `).get(entity.type, ...entity.aliases, graphFilterParams(category, years)) as {
    mediaCount: number;
    latestReleaseDate: string | null;
    mediaId: string | null;
  };
  return {
    mediaCount: Number(row.mediaCount ?? 0),
    latestReleaseDate: row.latestReleaseDate,
    mediaId: entity.coverKind === "manual" ? entity.mediaId : row.mediaId
  };
}

function toGraphNode(
  entity: GraphEntity,
  stats: ReturnType<typeof loadGraphEntityStats>,
  degree = 0,
  favoriteKeys = new Set<string>()
): GraphNode {
  return {
    ...entity,
    mediaCount: stats.mediaCount,
    latestReleaseDate: stats.latestReleaseDate,
    mediaId: stats.mediaId,
    coverKind: entity.coverKind === "manual" ? "manual" : stats.mediaId ? "representative" : "none",
    degree,
    isFavorite: entity.aliases.some((alias) => favoriteKeys.has(`${entity.type}\u0000${alias}`))
  };
}

type NeighborCandidate = { entity: GraphEntity; codes: Set<string> };

function loadNeighborCandidates(
  source: GraphEntity,
  targetTypes: GraphType[],
  category: GraphCategory,
  years: GraphYearRange
): NeighborCandidate[] {
  const sourcePlaceholders = source.aliases.map(() => "?").join(", ");
  const targetPlaceholders = targetTypes.map(() => "?").join(", ");
  const rows = db.prepare(`
    WITH source_codes AS (
      SELECT DISTINCT facets.normalized_code
      FROM media_metadata_facets facets
      JOIN media_files ON media_files.normalized_code = facets.normalized_code
      LEFT JOIN media_metadata ON media_metadata.normalized_code = facets.normalized_code
      WHERE facets.facet_type = ? AND facets.facet_value IN (${sourcePlaceholders}) ${graphFilterSql()}
    )
    SELECT targets.facet_type AS targetType, targets.facet_value AS targetValue,
      targets.normalized_code AS normalizedCode
    FROM source_codes
    JOIN media_metadata_facets targets USING (normalized_code)
    WHERE targets.facet_type IN (${targetPlaceholders})
  `).all(
    source.type,
    ...source.aliases,
    ...targetTypes,
    graphFilterParams(category, years)
  ) as Array<{ targetType: GraphType; targetValue: string; normalizedCode: string }>;
  const candidates = new Map<string, NeighborCandidate>();
  for (const row of rows) {
    const entity = resolveGraphEntity(row.targetType, row.targetValue);
    if (entity.id === source.id || !relationDescriptor(source.type, entity.type)) continue;
    const candidate = candidates.get(entity.id) ?? { entity, codes: new Set<string>() };
    candidate.codes.add(row.normalizedCode);
    candidates.set(entity.id, candidate);
  }
  return [...candidates.values()];
}

function loadGraphNeighbors(input: z.infer<typeof graphNeighborsQuerySchema>) {
  const source = resolveGraphEntity(input.sourceType, input.sourceValue);
  const targetTypes = parseGraphTypes(input.targetTypes);
  const offset = decodeGraphCursor(input.cursor);
  const years = { startYear: input.yearFrom, endYear: input.yearTo };
  const sourceStats = loadGraphEntityStats(source, input.category, years);
  const favoriteKeys = new Set(readEntityFavorites().map((item) => `${item.type}\u0000${item.value}`));
  const ranked = loadNeighborCandidates(source, targetTypes, input.category, years)
    .filter((candidate) => candidate.codes.size >= input.minShared)
    .sort((left, right) => right.codes.size - left.codes.size ||
      left.entity.label.localeCompare(right.entity.label, "zh-CN"));
  const page = ranked.slice(offset, offset + input.limit);
  const nodes = page.map((candidate) => toGraphNode(
    candidate.entity,
    loadGraphEntityStats(candidate.entity, input.category, years),
    1,
    favoriteKeys
  ));
  const sourceNode = toGraphNode(source, sourceStats, nodes.length, favoriteKeys);
  const edges = page.flatMap((candidate, index): GraphEdge[] => {
    const target = nodes[index];
    const relation = relationDescriptor(source.type, candidate.entity.type);
    if (!relation) return [];
    const sharedCount = candidate.codes.size;
    const affinity = sharedCount / Math.sqrt(Math.max(1, sourceStats.mediaCount * target.mediaCount));
    return [{
      id: `${source.id}|${candidate.entity.id}`,
      source: source.id,
      target: candidate.entity.id,
      weight: sharedCount,
      affinity,
      strength: affinity * Math.log1p(sharedCount),
      ...relation
    }];
  });
  const nextOffset = offset + page.length;
  const pageInfo = {
    total: ranked.length,
    nextCursor: nextOffset < ranked.length ? encodeGraphCursor(nextOffset) : null,
    hasMore: nextOffset < ranked.length
  };
  return {
    source: sourceNode,
    nodes: [sourceNode, ...nodes],
    edges,
    pageInfo,
    pagination: {
      total: ranked.length,
      limit: input.limit,
      offset,
      cursor: input.cursor ?? null,
      nextCursor: pageInfo.nextCursor,
      hasMore: pageInfo.hasMore
    }
  };
}

function expandPathFrontier(
  frontier: GraphEntity[],
  category: GraphCategory,
  years: GraphYearRange,
  minShared: number,
  targetId?: string
): Map<string, Array<{ entity: GraphEntity; sharedCount: number }>> {
  const selected = frontier.flatMap((entity) => entity.aliases.slice(0, 12).map((alias) => ({ entity, alias })));
  if (selected.length === 0) return new Map();
  const values = selected.map(() => "(?, ?, ?)").join(", ");
  const rows = db.prepare(`
    WITH frontier(node_id, facet_type, facet_value) AS (VALUES ${values}),
    frontier_codes AS (
      SELECT DISTINCT frontier.node_id, facets.normalized_code
      FROM frontier
      JOIN media_metadata_facets facets ON facets.facet_type = frontier.facet_type
        AND facets.facet_value = frontier.facet_value
      JOIN media_files ON media_files.normalized_code = facets.normalized_code
      LEFT JOIN media_metadata ON media_metadata.normalized_code = facets.normalized_code
      WHERE 1 = 1 ${graphFilterSql()}
    )
    SELECT frontier_codes.node_id AS sourceId, targets.facet_type AS targetType,
      targets.facet_value AS targetValue, targets.normalized_code AS normalizedCode
    FROM frontier_codes
    JOIN media_metadata_facets targets USING (normalized_code)
    WHERE targets.facet_type IN ('actor', 'series', 'genre', 'director', 'maker', 'label')
  `).all(
    ...selected.flatMap(({ entity, alias }) => [entity.id, entity.type, alias]),
    graphFilterParams(category, years)
  ) as Array<{ sourceId: string; targetType: GraphType; targetValue: string; normalizedCode: string }>;
  const sourceById = new Map(frontier.map((entity) => [entity.id, entity]));
  const grouped = new Map<string, Map<string, NeighborCandidate>>();
  for (const row of rows) {
    const source = sourceById.get(row.sourceId);
    if (!source) continue;
    const entity = resolveGraphEntity(row.targetType, row.targetValue);
    if (entity.id === source.id || !relationDescriptor(source.type, entity.type)) continue;
    if (
      entity.id !== targetId &&
      entity.type === "genre" &&
      GENERIC_GRAPH_GENRES.has(normalizeGraphLabel(entity.label))
    ) continue;
    const byTarget = grouped.get(source.id) ?? new Map<string, NeighborCandidate>();
    const candidate = byTarget.get(entity.id) ?? { entity, codes: new Set<string>() };
    candidate.codes.add(row.normalizedCode);
    byTarget.set(entity.id, candidate);
    grouped.set(source.id, byTarget);
  }
  return new Map([...grouped].map(([sourceId, candidates]) => [sourceId,
    [...candidates.values()]
      .filter((candidate) => candidate.codes.size >= minShared)
      .sort((left, right) => right.codes.size - left.codes.size ||
        left.entity.label.localeCompare(right.entity.label, "zh-CN"))
      .slice(0, 40)
      .map((candidate) => ({ entity: candidate.entity, sharedCount: candidate.codes.size }))
  ]));
}

function loadGraphPath(input: z.infer<typeof graphPathQuerySchema>) {
  const source = resolveGraphEntity(input.sourceType, input.sourceValue);
  const target = resolveGraphEntity(input.targetType, input.targetValue);
  const years = { startYear: input.yearFrom, endYear: input.yearTo };
  if (source.id === target.id) {
    const node = toGraphNode(source, loadGraphEntityStats(source, input.category, years));
    return { found: true, nodes: [node], edges: [], path: [node.id],
      summary: { hopCount: 0, visitedNodeCount: 1 } };
  }
  const visited = new Map<string, GraphEntity>([[source.id, source]]);
  const parents = new Map<string, { parentId: string; sharedCount: number }>();
  let frontier = [source];
  let found = false;
  const maxVisitedNodes = 320;
  for (let depth = 0; depth < input.maxDepth && frontier.length > 0 && !found; depth += 1) {
    const expansions = expandPathFrontier(frontier, input.category, years, input.minShared, target.id);
    const next: GraphEntity[] = [];
    for (const current of frontier) {
      for (const candidate of expansions.get(current.id) ?? []) {
        if (visited.has(candidate.entity.id)) continue;
        visited.set(candidate.entity.id, candidate.entity);
        parents.set(candidate.entity.id, { parentId: current.id, sharedCount: candidate.sharedCount });
        next.push(candidate.entity);
        if (candidate.entity.id === target.id) {
          found = true;
          break;
        }
        if (visited.size >= maxVisitedNodes) break;
      }
      if (found || visited.size >= maxVisitedNodes) break;
    }
    frontier = next;
  }
  if (!found) {
    return { found: false, nodes: [], edges: [], path: [], summary: {
      hopCount: null,
      visitedNodeCount: visited.size,
      maxDepth: input.maxDepth,
      truncated: visited.size >= maxVisitedNodes
    } };
  }
  const entityPath: GraphEntity[] = [];
  let cursor: string | null = target.id;
  while (cursor) {
    const currentId: string = cursor;
    const entity = visited.get(currentId) ?? (currentId === target.id ? target : undefined);
    if (!entity) break;
    entityPath.push(entity);
    if (currentId === source.id) break;
    cursor = parents.get(currentId)?.parentId ?? null;
  }
  entityPath.reverse();
  const favoriteKeys = new Set(readEntityFavorites().map((item) => `${item.type}\u0000${item.value}`));
  const nodes = entityPath.map((entity, index) => toGraphNode(
    entity,
    loadGraphEntityStats(entity, input.category, years),
    index === 0 || index === entityPath.length - 1 ? 1 : 2,
    favoriteKeys
  ));
  const edges = entityPath.slice(1).flatMap((entity, index): GraphEdge[] => {
    const parent = entityPath[index];
    const relation = relationDescriptor(parent.type, entity.type);
    if (!relation) return [];
    const sharedCount = parents.get(entity.id)?.sharedCount ?? 1;
    const affinity = sharedCount / Math.sqrt(Math.max(1, nodes[index].mediaCount * nodes[index + 1].mediaCount));
    return [{ id: `${parent.id}|${entity.id}`, source: parent.id, target: entity.id,
      weight: sharedCount, affinity, strength: affinity * Math.log1p(sharedCount), ...relation }];
  });
  return { found: true, nodes, edges, path: nodes.map((node) => node.id), summary: {
    hopCount: edges.length,
    visitedNodeCount: visited.size,
    maxDepth: input.maxDepth,
    truncated: false
  } };
}

function loadGraphConnection(input: z.infer<typeof graphConnectionQuerySchema>) {
  const sourceAliases = resolveGraphEntity(input.sourceType, input.sourceValue).aliases.slice(0, 12);
  const targetAliases = resolveGraphEntity(input.targetType, input.targetValue).aliases.slice(0, 12);
  const sourcePlaceholders = sourceAliases.map(() => "?").join(", ");
  const targetPlaceholders = targetAliases.map(() => "?").join(", ");
  const cursorOffset = decodeGraphCursor(input.cursor);
  const offset = input.cursor ? cursorOffset : input.offset;
  const years = { startYear: input.yearFrom, endYear: input.yearTo };
  const cte = `
    WITH source_codes AS (
      SELECT DISTINCT normalized_code FROM media_metadata_facets
      WHERE facet_type = ? AND facet_value IN (${sourcePlaceholders})
    ), target_codes AS (
      SELECT DISTINCT normalized_code FROM media_metadata_facets
      WHERE facet_type = ? AND facet_value IN (${targetPlaceholders})
    ), connected AS (
      SELECT media_files.library_category, media_files.normalized_code,
        COALESCE(
          MIN(CASE WHEN media_files.thumbnail_status = 'ready' THEN media_files.id END),
          MIN(media_files.id)
        ) AS mediaId,
        MAX(media_files.mtime_ms) AS latestMtime
      FROM source_codes
      JOIN target_codes USING (normalized_code)
      JOIN media_files USING (normalized_code)
      LEFT JOIN media_metadata USING (normalized_code)
      WHERE 1 = 1 ${graphFilterSql()}
      GROUP BY media_files.library_category, media_files.normalized_code
    )`;
  const bindings = [
    input.sourceType,
    ...sourceAliases,
    input.targetType,
    ...targetAliases
  ];
  const params = graphFilterParams(input.category, years);
  const totalRow = db.prepare(`${cte} SELECT COUNT(*) AS total FROM connected`)
    .get(...bindings, params) as { total: number };
  const rows = db.prepare(`
    ${cte}
    SELECT mediaId FROM connected
    ORDER BY latestMtime DESC, normalized_code COLLATE NOCASE ASC
    LIMIT @limit OFFSET @offset
  `).all(
    ...bindings,
    { ...params, limit: input.limit, offset }
  ) as Array<{ mediaId: string }>;
  const media = hydrateMediaRows(loadMediaRows(rows.map((row) => row.mediaId)), readFavoriteKeys());
  const mediaById = new Map(media.map((item) => [String(item.id), item]));
  const items = rows.flatMap((row) => {
    const item = mediaById.get(row.mediaId);
    return item ? [item] : [];
  });
  const total = Number(totalRow.total ?? 0);
  const nextOffset = offset + rows.length;
  const pageInfo = {
    total,
    nextCursor: nextOffset < total ? encodeGraphCursor(nextOffset) : null,
    hasMore: nextOffset < total
  };
  const relation = relationDescriptor(input.sourceType, input.targetType) ?? {
    relationType: "shared_media",
    relationLabel: "共同作品"
  };
  return {
    items,
    total,
    ...relation,
    pageInfo,
    pagination: {
      total,
      limit: input.limit,
      offset,
      cursor: input.cursor ?? null,
      nextCursor: pageInfo.nextCursor,
      hasMore: pageInfo.hasMore
    }
  };
}

export function registerDiscoveryRoutes(app: Express): void {
  app.get("/api/viewing-desk/session", (_req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ session: loadViewingSession(), presets: VIEWING_PRESETS, bootstrap: loadViewingBootstrap() });
  });

  app.post("/api/viewing-desk/session", (req, res, next) => {
    try {
      const config = viewingConfigSchema.parse(req.body);
      res.json({ session: generateViewingSession(config), presets: VIEWING_PRESETS, bootstrap: loadViewingBootstrap() });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/viewing-desk/sessions", (req, res, next) => {
    try {
      const query = viewingHistoryQuerySchema.parse(req.query);
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ sessions: listViewingSessions(query.limit) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/viewing-desk/session/:id", (req, res) => {
    const session = loadViewingSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: "这次选片记录不存在" });
      return;
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ session });
  });

  app.delete("/api/viewing-desk/session/:id", (req, res, next) => {
    try {
      const result = deleteViewingSession(req.params.id);
      if (!result) {
        res.status(404).json({ error: "这次选片记录不存在或已被删除" });
        return;
      }
      res.setHeader("Cache-Control", "private, no-store");
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/viewing-desk/session/:id/arena", (req, res, next) => {
    try {
      const input = viewingArenaChoiceSchema.parse(req.body);
      const round = db.prepare(`SELECT left_media_id AS leftMediaId, right_media_id AS rightMediaId, decision
        FROM viewing_arena_rounds WHERE session_id = ? AND round_index = ?`).get(
        req.params.id,
        input.roundIndex
      ) as { leftMediaId: string; rightMediaId: string; decision: string } | undefined;
      if (!round) {
        res.status(404).json({ error: "这一组影片不存在，请重新开始选片" });
        return;
      }
      if (round.decision) {
        res.status(409).json({ error: "这一轮已经选过了" });
        return;
      }
      if (input.action === "choose" && input.winnerMediaId !== round.leftMediaId && input.winnerMediaId !== round.rightMediaId) {
        res.status(400).json({ error: "请选择当前显示的影片" });
        return;
      }
      const now = new Date().toISOString();
      if (input.action === "reroll") {
        db.transaction(() => {
          replaceArenaRound(req.params.id, input.roundIndex);
          db.prepare("UPDATE viewing_sessions SET updated_at = ? WHERE id = ?").run(now, req.params.id);
        })();
        res.json({ session: loadViewingSession(req.params.id) });
        return;
      }
      db.transaction(() => {
        db.prepare(`UPDATE viewing_arena_rounds SET winner_media_id = ?, decision = ?, updated_at = ?
          WHERE session_id = ? AND round_index = ?`).run(
          input.action === "choose" ? input.winnerMediaId : null,
          input.action,
          now,
          req.params.id,
          input.roundIndex
        );
        db.prepare("UPDATE viewing_sessions SET updated_at = ? WHERE id = ?").run(now, req.params.id);
        refreshViewingSessionRecommendations(req.params.id);
        replaceNextPendingArenaRound(req.params.id);
      })();
      res.json({ session: loadViewingSession(req.params.id) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/viewing-desk/session/:id/branch", (req, res, next) => {
    try {
      const input = viewingBranchSchema.parse(req.body);
      const result = startViewingBranch(req.params.id, input.lane);
      if (result.status === "missing") {
        res.status(404).json({ error: "这次选片记录不存在" });
        return;
      }
      if (result.status === "pending") {
        res.status(409).json({ error: "请先完成当前几轮选择" });
        return;
      }
      if (result.status === "limit") {
        res.status(409).json({ error: "这次选片已经完成，请返回选片首页重新开始" });
        return;
      }
      res.json({ session: result.session });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/viewing-desk/session/:id/feedback", (req, res, next) => {
    try {
      const input = viewingFeedbackSchema.parse(req.body);
      const now = new Date().toISOString();
      const updated = db.transaction(() => {
        const result = db.prepare(`UPDATE viewing_session_items SET feedback = ?, updated_at = ?
          WHERE session_id = ? AND media_id = ? AND position >= 0`).run(
          input.feedback === "clear" ? "" : input.feedback,
          now,
          req.params.id,
          input.mediaId
        );
        if (result.changes === 0) return false;
        refreshViewingSessionRecommendations(req.params.id);
        db.prepare("UPDATE viewing_sessions SET updated_at = ? WHERE id = ?").run(now, req.params.id);
        return true;
      })();
      if (!updated) {
        res.status(404).json({ error: "这次选片记录或影片不存在" });
        return;
      }
      res.json({ session: loadViewingSession(req.params.id) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/knowledge-graph", (req, res, next) => {
    try {
      const query = graphQuerySchema.parse(req.query);
      const types = parseGraphTypes(query.types);
      const cacheKey = JSON.stringify([
        "graph", types, query.q, query.limit, query.minShared, query.category, query.hideGeneric,
        query.yearFrom, query.yearTo
      ]);
      const cached = graphCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        res.setHeader("X-AMW-Cache", "HIT");
        res.json(cached.value);
        return;
      }
      const value = buildKnowledgeGraph(
        types,
        query.q,
        query.limit,
        query.minShared,
        query.category,
        query.hideGeneric,
        { startYear: query.yearFrom, endYear: query.yearTo }
      );
      graphCache.set(cacheKey, { expiresAt: Date.now() + 2 * 60 * 1000, value });
      if (graphCache.size > 24) graphCache.delete(graphCache.keys().next().value ?? "");
      res.setHeader("Cache-Control", "private, max-age=60");
      res.setHeader("X-AMW-Cache", "MISS");
      res.json(value);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/knowledge-graph/connection", (req, res, next) => {
    try {
      const query = graphConnectionQuerySchema.parse(req.query);
      res.setHeader("Cache-Control", "private, max-age=120");
      res.json(loadGraphConnection(query));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/knowledge-graph/neighbors", (req, res, next) => {
    try {
      const query = graphNeighborsQuerySchema.parse(req.query);
      const cacheKey = JSON.stringify(["neighbors", query]);
      const cached = graphCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        res.setHeader("X-AMW-Cache", "HIT");
        res.json(cached.value);
        return;
      }
      const value = loadGraphNeighbors(query);
      graphCache.set(cacheKey, { expiresAt: Date.now() + 2 * 60 * 1000, value });
      if (graphCache.size > 24) graphCache.delete(graphCache.keys().next().value ?? "");
      res.setHeader("Cache-Control", "private, max-age=60");
      res.setHeader("X-AMW-Cache", "MISS");
      res.json(value);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/knowledge-graph/path", (req, res, next) => {
    try {
      const query = graphPathQuerySchema.parse(req.query);
      const cacheKey = JSON.stringify(["path", query]);
      const cached = graphCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        res.setHeader("X-AMW-Cache", "HIT");
        res.json(cached.value);
        return;
      }
      const value = loadGraphPath(query);
      graphCache.set(cacheKey, { expiresAt: Date.now() + 2 * 60 * 1000, value });
      if (graphCache.size > 24) graphCache.delete(graphCache.keys().next().value ?? "");
      res.setHeader("Cache-Control", "private, max-age=60");
      res.setHeader("X-AMW-Cache", "MISS");
      res.json(value);
    } catch (error) {
      next(error);
    }
  });
}

export const discoveryRouteTestUtils = {
  knownGraphReleaseSql,
  countViewingBehaviorSignals,
  decodeGraphCursor,
  deleteViewingSession,
  encodeGraphCursor,
  loadViewingSession,
  loadViewingBootstrap,
  relationDescriptor,
  writeViewingSessionItems,
  graphYearRangeSchema,
  viewingArenaChoiceSchema,
  viewingBranchSchema,
  viewingConfigSchema
};
