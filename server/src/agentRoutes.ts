import crypto from "node:crypto";
import type { Express } from "express";
import type { Response } from "express";
import { z } from "zod";
import { getAgentRuntimeStatus } from "./agentCapabilities.js";
import {
  assertAgentChatModelLoaded,
  listAgentChatModelsWithStatus,
  loadAgentChatModel,
  resolveAgentChatModel,
  unloadAgentChatModel
} from "./externalAiRuntime.js";
import { db } from "./db.js";
import { resolveEntityProfileImageUrl } from "./entityProfileImageCache.js";
import { getEntityExtendedProfile } from "./entityProfiles.js";
import { getTopicGraphItems, type TopicType } from "./productRoutes.js";
import {
  appendAgentExchange,
  beginAgentExchange,
  completeAgentMessage,
  createAgentThread,
  deleteAgentThread,
  failAgentMessage,
  getLatestAgentTurnState,
  getAgentThread,
  listAgentThreads,
  recordAgentToolRun,
  renameAgentThreadFromFirstMessage,
  saveAgentTurnState
} from "./agentStore.js";
import {
  buildAgentPresentation,
  buildAgentUserModelContext,
  describeAgentIntent,
  describeAgentReasoning,
  ensureAgentAnswerVariation,
  extractAgentCitationNumbers,
  extractAgentRecommendationCitationNumbers,
  generateAgentAnswer,
  generateAgentClarification,
  getAgentIndexStatus,
  queryRequestsRecommendation,
  queryUsesPriorRecommendationContext,
  retrieveAgentAnalytics,
  retrieveAgentContext,
  startAgentIndexing,
  streamAgentAnswer,
  type AgentCitation,
  type AgentPresentation,
  type AgentUserModelContext
} from "./agentRag.js";
import {
  buildDeterministicTurn,
  createTurnState,
  type AgentEntryContext,
  type AgentTurnState
} from "./agentTools.js";
import {
  cancelAgentAction,
  clearAgentLearning,
  confirmAgentAction,
  createAgentActionDraft,
  deleteAgentFeedback,
  deleteAgentPreference,
  draftActionFromMessage,
  getAgentAction,
  listAgentPreferences,
  learnAgentQueryPreferences,
  recordAgentFeedback,
  refreshAgentQueryPreferences,
  replaceAgentRecommendationSlot,
  updateAgentPreference
} from "./agentFeatures.js";

const entryContextSchema = z.object({
  source: z.enum(["media-detail", "entity", "topic", "media-wall", "viewing-desk", "history"]),
  mediaIds: z.array(z.string().trim().min(1)).max(24).optional(),
  entity: z.object({ type: z.string().trim().min(1), value: z.string().trim().min(1), label: z.string().trim().min(1) }).optional(),
  filters: z.record(z.string(), z.unknown()).optional(),
  viewingDeskSessionId: z.string().trim().min(1).optional(),
  label: z.string().trim().min(1).max(160)
});

const mentionProfileTypes = new Set<TopicType>(["actor", "director", "maker", "label", "series"]);

function getMentionProfileImage(type: TopicType, value: string): string | undefined {
  if (!mentionProfileTypes.has(type)) return undefined;
  const imageUrl = resolveEntityProfileImageUrl(getEntityExtendedProfile(type, value))?.imageUrl?.trim();
  return imageUrl || undefined;
}

function getMentionRepresentative(type: TopicType, aliases: string[]): {
  mediaId?: string;
  latestReleaseDate?: string;
} {
  const values = [...new Set(aliases.filter(Boolean))];
  if (!values.length) return {};
  const parameters = Object.fromEntries(values.map((value, index) => [`value${index}`, value]));
  const placeholders = values.map((_, index) => `@value${index}`).join(", ");
  const row = (type === "prefix" ? db.prepare(`
    SELECT COALESCE(
      MIN(CASE WHEN media_files.thumbnail_status = 'ready' THEN media_files.id END),
      MIN(media_files.id)
    ) AS mediaId,
    MAX(NULLIF(media_metadata.release_date, '')) AS latestReleaseDate
    FROM media_files
    LEFT JOIN media_metadata ON media_metadata.normalized_code = media_files.normalized_code
    WHERE media_files.code_prefix IN (${placeholders})
      AND media_files.media_type = 'video'
  `).get(parameters) : db.prepare(`
    SELECT COALESCE(
      MIN(CASE WHEN media_files.thumbnail_status = 'ready' THEN media_files.id END),
      MIN(media_files.id)
    ) AS mediaId,
    MAX(NULLIF(media_metadata.release_date, '')) AS latestReleaseDate
    FROM media_metadata_facets
    JOIN media_files ON media_files.normalized_code = media_metadata_facets.normalized_code
    LEFT JOIN media_metadata ON media_metadata.normalized_code = media_files.normalized_code
    WHERE media_metadata_facets.facet_type = @type
      AND media_metadata_facets.facet_value IN (${placeholders})
      AND media_files.media_type = 'video'
  `).get({ type, ...parameters })) as { mediaId: string | null; latestReleaseDate: string | null } | undefined;
  return {
    ...(row?.mediaId ? { mediaId: row.mediaId } : {}),
    ...(row?.latestReleaseDate ? { latestReleaseDate: row.latestReleaseDate } : {})
  };
}

export function normalizeAgentRegenerationMessageId(value: unknown): unknown {
  return typeof value === "string" && value.startsWith("optimistic-assistant-") ? undefined : value;
}

const messageSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  model: z.string().trim().min(1).max(160).optional(),
  requestId: z.string().uuid().optional(),
  context: entryContextSchema.nullable().optional(),
  baseStateVersion: z.number().int().min(0).optional(),
  regenerateFromMessageId: z.preprocess(normalizeAgentRegenerationMessageId, z.string().uuid().optional()),
  mentions: z.array(z.object({
    type: z.enum(["code", "actor", "genre", "series", "maker", "label", "director", "prefix"]),
    value: z.string().trim().min(1).max(160),
    label: z.string().trim().min(1).max(160)
  })).max(12).default([]),
  composerContext: z.object({
    intent: z.object({ id: z.enum(["search", "recommend", "compare", "aggregate", "playlist"]), label: z.string().trim().min(1).max(40) }).optional(),
    constraints: z.array(z.object({ label: z.string().trim().min(1).max(80), excluded: z.boolean() })).max(16).default([])
  }).optional()
});

const mentionQuerySchema = z.object({
  q: z.string().trim().max(80).default(""),
  limit: z.coerce.number().int().min(4).max(24).default(12)
});

const createThreadSchema = z.object({ context: entryContextSchema.nullable().optional() });
const modelLoadSchema = z.object({ model: z.string().trim().min(1).max(160) });
const feedbackSchema = z.object({
  mediaId: z.string().trim().min(1),
  slot: z.number().int().min(1).max(24).nullable().optional(),
  feedbackType: z.enum(["like", "not_interested", "already_watched", "more_like_this", "replace"])
});
const preferencePatchSchema = z.object({ weight: z.number().min(-1).max(1).optional(), status: z.enum(["active", "muted"]).optional() });
const actionDraftSchema = z.object({
  threadId: z.string().trim().min(1),
  actionType: z.enum(["create_playlist", "add_to_playlist", "set_favorite", "watch_later"]),
  payload: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().trim().min(1).max(200).optional()
});

type AgentTraceStep = {
  key: "understand" | "retrieve" | "evidence" | "reason" | "write" | "save";
  label: string;
  detail: string;
  status: "active" | "complete" | "failed" | "interrupted";
  durationMs: number | null;
};

const activeAgentTurns = new Map<string, AbortController>();

function writeStreamEvent(res: Response, event: Record<string, unknown>): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`${JSON.stringify(event)}\n`);
  res.flush?.();
}

function collectEvidence(
  history: Array<{ role?: string; content?: string; citations?: AgentCitation[] }>,
  retrieved: AgentCitation[]
): { citations: AgentCitation[]; recommendationEligibleNumbers: number[] } {
  const historical = history.slice(-4).flatMap((item) => {
    if (item.role !== "assistant" || !item.citations?.length) return [];
    return extractAgentCitationNumbers(item.content ?? "", item.citations.length)
      .map((number) => item.citations?.[number - 1])
      .filter((citation): citation is AgentCitation => Boolean(citation));
  });
  const citations = [...retrieved, ...historical]
    .filter((item, index, items) => items.findIndex((candidate) => candidate.mediaId === item.mediaId) === index)
    .slice(0, 12);
  const retrievedIds = new Set(retrieved.map((item) => item.mediaId));
  return {
    citations,
    recommendationEligibleNumbers: citations
      .map((item, index) => retrievedIds.has(item.mediaId) ? index + 1 : 0)
      .filter(Boolean)
  };
}

function getRecommendationContext(
  history: Array<{ role?: string; citations?: AgentCitation[] }>,
  query: string
): AgentCitation[] {
  if (!queryRequestsRecommendation(query) || !queryUsesPriorRecommendationContext(query)) return [];
  const context: AgentCitation[] = [];
  const seen = new Set<string>();
  for (let index = history.length - 1; index >= 0 && context.length < 12; index -= 1) {
    const message = history[index];
    if (message.role !== "assistant") continue;
    for (const citation of message.citations ?? []) {
      if (seen.has(citation.mediaId)) continue;
      seen.add(citation.mediaId);
      context.push(citation);
      if (context.length >= 12) break;
    }
  }
  return context;
}

function buildRetrievalOptions(
  history: Array<{ role?: string; citations?: AgentCitation[] }>,
  query: string,
  regeneration: { variationSeed?: number; excludeMediaIds: string[] },
  userModel: AgentUserModelContext | null = null,
  latestState: AgentTurnState | null = null
) {
  const contextCitations = getRecommendationContext(history, query);
  const contextEntities = queryUsesPriorRecommendationContext(query)
    ? latestState?.entities.filter((item) => ["actor", "genre", "series", "maker", "label", "director", "prefix"].includes(item.type)) ?? []
    : [];
  return {
    ...regeneration,
    contextCitations,
    contextEntities,
    userModel,
    excludeMediaIds: [...new Set([
      ...regeneration.excludeMediaIds,
      ...contextCitations.map((item) => item.mediaId)
    ])]
  };
}

export type AgentHistoryMessage = {
  id: string;
  role?: string;
  content?: string;
  citations?: AgentCitation[];
  presentation?: AgentPresentation | null;
  presentations?: AgentPresentation[];
  status?: string;
};

export function hydrateAgentThreadPresentations<T extends { messages?: AgentHistoryMessage[] }>(thread: T): T {
  let changed = false;
  const messages = (thread.messages ?? []).map((message, index, items) => {
    if (message.role !== "assistant" || (message.status && message.status !== "completed")
      || message.presentation || message.presentations?.length || !message.citations?.length) return message;
    const previous = items[index - 1];
    if (previous?.role !== "user" || !previous.content) return message;
    const eligibleNumbers = message.citations.map((_, citationIndex) => citationIndex + 1);
    let presentation = buildAgentPresentation(
      previous.content,
      message.content ?? "",
      message.citations,
      eligibleNumbers
    );
    if (!presentation || presentation.kind !== "media-cards") return message;
    const hasExplicitCount = /(?:\d{1,2}|[一二两三四五六])\s*部/u.test(previous.content);
    const canonicalSectionNumbers = extractAgentRecommendationCitationNumbers(message.content ?? "", message.citations.length);
    if (!hasExplicitCount && canonicalSectionNumbers.length === 0) {
      const recoveredNumbers = extractAgentCitationNumbers(message.content ?? "", message.citations.length).slice(0, 6);
      if (recoveredNumbers.length > presentation.citationNumbers.length) {
        presentation = {
          ...presentation,
          citationNumbers: recoveredNumbers,
          layout: recoveredNumbers.length === 1 ? "spotlight" : recoveredNumbers.length >= 5 ? "compact" : "gallery"
        };
      }
    }
    changed = true;
    return { ...message, presentation, presentations: [presentation] };
  });
  return changed ? { ...thread, messages } : thread;
}

export function getAgentRegenerationContext(messages: AgentHistoryMessage[], messageId?: string): {
  variationSeed?: number;
  excludeMediaIds: string[];
  excludeEntityValues: string[];
  previousAnswer?: string;
  history: AgentHistoryMessage[];
} {
  if (!messageId) return { excludeMediaIds: [], excludeEntityValues: [], history: messages };
  const sourceIndex = messages.findIndex((item) => item.id === messageId && item.role === "assistant");
  if (sourceIndex < 0) throw new Error("REGENERATION_SOURCE_NOT_FOUND");
  const source = messages[sourceIndex];
  const mediaIds = new Set<string>();
  const entityValues = new Set<string>();
  const precedingUserQuery = messages[sourceIndex - 1]?.role === "user" ? messages[sourceIndex - 1]?.content ?? "" : "";
  const normalizedSourceQuery = normalizeRepeatedAgentQuery(precedingUserQuery);
  for (let index = 1; index <= sourceIndex; index += 1) {
    const assistant = messages[index];
    const userQuery = messages[index - 1]?.role === "user" ? messages[index - 1]?.content ?? "" : "";
    if (assistant.role !== "assistant" || normalizeRepeatedAgentQuery(userQuery) !== normalizedSourceQuery) continue;
    const citations = assistant.citations ?? [];
    const wasRecommendation = queryRequestsRecommendation(userQuery)
      || /(?:^|\n)#{1,3}\s*推荐影片|(?:^|\n)[-*]\s*\*\*[^\n]+\[\d+\]\*\*/u.test(assistant.content ?? "");
    if (wasRecommendation) citations.forEach((citation) => mediaIds.add(citation.mediaId));
    for (const presentation of assistant.presentations ?? []) {
      if (presentation.kind === "media-cards") {
        presentation.citationNumbers.forEach((number) => {
          const mediaId = citations[number - 1]?.mediaId;
          if (mediaId) mediaIds.add(mediaId);
        });
      } else if (presentation.kind === "entity-cards") {
        presentation.items.forEach((item) => entityValues.add(item.value));
      }
    }
  }
  const excludedIndexes = new Set([sourceIndex]);
  if (messages[sourceIndex - 1]?.role === "user") excludedIndexes.add(sourceIndex - 1);
  return {
    variationSeed: crypto.randomInt(1, 2_147_483_647),
    excludeMediaIds: [...mediaIds],
    excludeEntityValues: [...entityValues],
    previousAnswer: source.content ?? "",
    history: messages.filter((_, index) => !excludedIndexes.has(index))
  };
}

function normalizeRepeatedAgentQuery(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/gu, "").trim();
}

function getRepeatedQueryEntityValues(messages: AgentHistoryMessage[], query: string): string[] {
  const normalizedQuery = normalizeRepeatedAgentQuery(query);
  if (!normalizedQuery) return [];
  const values = new Set<string>();
  for (let index = messages.length - 2; index >= 0; index -= 1) {
    const userMessage = messages[index];
    if (userMessage.role !== "user" || normalizeRepeatedAgentQuery(userMessage.content ?? "") !== normalizedQuery) continue;
    const assistantMessage = messages[index + 1]?.role === "assistant" ? messages[index + 1] : null;
    const batch = (assistantMessage?.presentations ?? []).flatMap((presentation) =>
      presentation.kind === "entity-cards" ? presentation.items.map((item) => item.value) : []
    );
    batch.forEach((value) => values.add(value));
  }
  return [...values];
}

function withRepeatedQueryVariation(
  regeneration: ReturnType<typeof getAgentRegenerationContext>,
  messages: AgentHistoryMessage[],
  query: string,
  isExplicitRegeneration: boolean
): ReturnType<typeof getAgentRegenerationContext> {
  if (isExplicitRegeneration) return regeneration;
  const repeatedValues = getRepeatedQueryEntityValues(messages, query);
  if (!repeatedValues.length) return regeneration;
  return {
    ...regeneration,
    variationSeed: crypto.randomInt(1, 2_147_483_647),
    excludeEntityValues: [...new Set([...regeneration.excludeEntityValues, ...repeatedValues])]
  };
}

function getModelHistory(messages: AgentHistoryMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  return messages.flatMap((item) =>
    (item.role === "user" || item.role === "assistant") && typeof item.content === "string"
      ? [{ role: item.role, content: item.content }]
      : []
  );
}

function getActiveUserId(): string {
  return (db.prepare("SELECT user_id AS userId FROM active_user_state WHERE id = 1").get() as { userId?: string } | undefined)?.userId ?? "user-1";
}

function mentionAugmentedQuery(
  message: string,
  mentions: Array<{ type: string; value: string; label: string }>,
  composerContext?: { intent?: { id: string; label: string }; constraints: Array<{ label: string; excluded: boolean }> }
): string {
  const labels: Record<string, string> = { code: "番号", actor: "演员", genre: "标签", series: "系列", maker: "厂商", label: "厂牌", director: "导演", prefix: "番号系列" };
  const context: string[] = [];
  if (mentions.length) context.push(`用户已通过 @ 选择器明确指定：${mentions.map((item) => `${labels[item.type] ?? item.type}=${item.value}`).join("；")}`);
  if (composerContext?.intent) context.push(`用户已通过命令明确指定任务：${composerContext.intent.label}`);
  if (composerContext?.constraints.length) context.push(`用户已通过条件标签明确指定：${composerContext.constraints.map((item) => `${item.excluded ? "排除" : "包含"}=${item.label}`).join("；")}`);
  return context.length ? `${message}\n\n${context.join("\n")}` : message;
}

export function registerAgentRoutes(app: Express): void {
  app.get("/api/agent/capabilities", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await getAgentRuntimeStatus());
  });

  app.get("/api/agent/models", async (_req, res, next) => {
    try {
      const models = await listAgentChatModelsWithStatus();
      res.setHeader("Cache-Control", "no-store");
      res.json({
        defaultModel: models.find((item) => item.isDefault)?.name ?? null,
        items: models
      });
    } catch (error) { next(error); }
  });

  app.post("/api/agent/models/load", async (req, res, next) => {
    try {
      const runtime = await getAgentRuntimeStatus();
      if (!runtime.agentAvailable) {
        res.status(503).json({ code: runtime.unavailableCode, error: runtime.unavailableReason, capabilities: runtime });
        return;
      }
      const { model } = modelLoadSchema.parse(req.body ?? {});
      res.setHeader("Cache-Control", "no-store");
      res.json(await loadAgentChatModel(model));
    } catch (error) { next(error); }
  });

  app.post("/api/agent/models/unload", async (req, res, next) => {
    try {
      const { model } = modelLoadSchema.parse(req.body ?? {});
      res.setHeader("Cache-Control", "no-store");
      res.json(await unloadAgentChatModel(model));
    } catch (error) { next(error); }
  });

  app.get("/api/agent/threads", (_req, res, next) => {
    try { res.json({ items: listAgentThreads(getActiveUserId()) }); } catch (error) { next(error); }
  });

  app.get("/api/agent/mentions", (req, res, next) => {
    try {
      const { q, limit } = mentionQuerySchema.parse(req.query);
      const pattern = `%${q}%`;
      const startsWith = `${q}%`;
      const perType = Math.max(2, Math.ceil(limit / 8));
      const facetTypes: TopicType[] = ["actor", "genre", "series", "maker", "label", "director", "prefix"];
      const normalizedNeedle = q.normalize("NFKC").toLocaleLowerCase("ja");
      const facets = facetTypes.flatMap((type) => getTopicGraphItems(type)
        .filter((item) => !normalizedNeedle || [item.value, item.label, ...item.aliases]
          .some((candidate) => candidate.normalize("NFKC").toLocaleLowerCase("ja").includes(normalizedNeedle)))
        .sort((left, right) => {
          const leftStarts = [left.value, left.label, ...left.aliases].some((candidate) =>
            candidate.normalize("NFKC").toLocaleLowerCase("ja").startsWith(normalizedNeedle));
          const rightStarts = [right.value, right.label, ...right.aliases].some((candidate) =>
            candidate.normalize("NFKC").toLocaleLowerCase("ja").startsWith(normalizedNeedle));
          return Number(rightStarts) - Number(leftStarts) || right.mediaCount - left.mediaCount || left.label.localeCompare(right.label, "zh-CN");
        })
        .slice(0, perType)
        .map((item) => {
          const imageUrl = getMentionProfileImage(type, item.value);
          const representative = item.mediaId && item.latestReleaseDate
            ? {}
            : getMentionRepresentative(type, item.aliases);
          return {
            type,
            value: item.value,
            label: item.label,
            ...(item.label !== item.value ? { originalName: item.value } : {}),
            count: item.mediaCount,
            mediaId: item.customCoverMediaId || item.mediaId || representative.mediaId,
            latestReleaseDate: item.latestReleaseDate || representative.latestReleaseDate,
            ...(imageUrl ? { imageUrl } : {})
          };
        }));
      const codes = db.prepare(`
        SELECT media_files.normalized_code AS value,
          COUNT(DISTINCT media_files.library_category || ':' || media_files.normalized_code) AS count,
          COALESCE(
            MIN(CASE WHEN media_files.thumbnail_status = 'ready' THEN media_files.id END),
            MIN(media_files.id)
          ) AS mediaId,
          MAX(NULLIF(media_metadata.release_date, '')) AS latestReleaseDate
        FROM media_files
        LEFT JOIN media_metadata ON media_metadata.normalized_code = media_files.normalized_code
        WHERE media_files.media_type = 'video' AND media_files.normalized_code != ''
          AND (? = '' OR media_files.normalized_code LIKE ?)
        GROUP BY media_files.normalized_code
        ORDER BY CASE WHEN media_files.normalized_code LIKE ? THEN 0 ELSE 1 END,
          count DESC, media_files.normalized_code
        LIMIT ?
      `).all(q, pattern, startsWith, perType) as Array<{
        value: string;
        count: number;
        mediaId: string | null;
        latestReleaseDate: string | null;
      }>;
      const combined = [
        ...codes.map((item) => ({
          ...item,
          type: "code" as const,
          label: item.value,
          mediaId: item.mediaId || undefined,
          latestReleaseDate: item.latestReleaseDate || undefined
        })),
        ...facets
      ];
      if (q) {
        const normalized = q.normalize("NFKC").toLocaleLowerCase("ja");
        const ranked = [...combined].sort((left, right) => {
          const leftValue = left.value.normalize("NFKC").toLocaleLowerCase("ja");
          const rightValue = right.value.normalize("NFKC").toLocaleLowerCase("ja");
          const leftLabel = left.label.normalize("NFKC").toLocaleLowerCase("ja");
          const rightLabel = right.label.normalize("NFKC").toLocaleLowerCase("ja");
          const leftExact = leftValue === normalized || leftLabel === normalized;
          const rightExact = rightValue === normalized || rightLabel === normalized;
          const leftStarts = leftValue.startsWith(normalized) || leftLabel.startsWith(normalized);
          const rightStarts = rightValue.startsWith(normalized) || rightLabel.startsWith(normalized);
          return Number(rightExact) - Number(leftExact) || Number(rightStarts) - Number(leftStarts) ||
            right.count - left.count || left.label.localeCompare(right.label, "zh-CN");
        });
        res.json({ items: ranked.slice(0, limit) });
        return;
      }
      const typeOrder = ["actor", "genre", "series", "code", "prefix", "maker", "label", "director"] as const;
      const grouped = new Map(typeOrder.map((type) => [type, combined.filter((item) => item.type === type)]));
      const balanced = Array.from({ length: perType }, (_, index) => typeOrder
        .map((type) => grouped.get(type)?.[index])
        .filter((item): item is NonNullable<typeof item> => Boolean(item)))
        .flat()
        .slice(0, limit);
      res.json({ items: balanced });
    } catch (error) { next(error); }
  });

  app.post("/api/agent/threads", (req, res, next) => {
    try {
      const { context = null } = createThreadSchema.parse(req.body ?? {});
      res.status(201).json(createAgentThread(getActiveUserId(), "新对话", context));
    } catch (error) { next(error); }
  });

  app.get("/api/agent/threads/:id", (req, res, next) => {
    try {
      const thread = getAgentThread(req.params.id, getActiveUserId());
      if (!thread) return void res.status(404).json({ error: "对话不存在" });
      res.json(hydrateAgentThreadPresentations(
        thread as unknown as { messages?: AgentHistoryMessage[] } & Record<string, unknown>
      ));
    } catch (error) { next(error); }
  });

  app.delete("/api/agent/threads/:id", (req, res, next) => {
    try {
      if (!deleteAgentThread(req.params.id, getActiveUserId())) return void res.status(404).json({ error: "对话不存在" });
      res.status(204).end();
    } catch (error) { next(error); }
  });

  app.post("/api/agent/threads/:id/messages", async (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Pragma", "no-cache");
      const runtime = await getAgentRuntimeStatus();
      if (!runtime.agentAvailable) {
        res.status(503).json({ code: runtime.unavailableCode, error: runtime.unavailableReason, capabilities: runtime });
        return;
      }
      const thread = getAgentThread(req.params.id, getActiveUserId());
      if (!thread) return void res.status(404).json({ error: "对话不存在" });
      const { message, model, context, baseStateVersion, mentions, composerContext, regenerateFromMessageId } = messageSchema.parse(req.body ?? {});
      const chatModel = await resolveAgentChatModel(model);
      await assertAgentChatModelLoaded(chatModel);
      if (!regenerateFromMessageId) learnAgentQueryPreferences({ userId: getActiveUserId(), query: message, mentions });
      const effectiveQuery = mentionAugmentedQuery(message, mentions, composerContext);
      const historyMessages = (thread as unknown as { messages?: AgentHistoryMessage[] }).messages ?? [];
      if (regenerateFromMessageId && !historyMessages.some((item) => item.id === regenerateFromMessageId && item.role === "assistant")) {
        return void res.status(400).json({ code: "AGENT_REGENERATION_SOURCE_NOT_FOUND", error: "找不到需要重新生成的原回答" });
      }
      const regeneration = getAgentRegenerationContext(historyMessages, regenerateFromMessageId);
      const deterministicOptions = withRepeatedQueryVariation(
        regeneration, historyMessages, message, Boolean(regenerateFromMessageId)
      );
      const latestState = getLatestAgentTurnState(req.params.id);
      if (baseStateVersion != null && latestState && latestState.version !== baseStateVersion) {
        return void res.status(409).json({ code: "AGENT_STATE_CHANGED", error: "对话结果已经变化，请基于最新结果重试", latestState });
      }
      const sourceContext = (context ?? (thread as { context?: AgentEntryContext | null }).context ?? null) as AgentEntryContext | null;
      const draftedAction = draftActionFromMessage({ userId: getActiveUserId(), threadId: req.params.id, message, state: latestState?.state as AgentTurnState | null ?? null });
      if (draftedAction) {
        const stateVersion = (latestState?.version ?? 0) + 1;
        const state = createTurnState({ intent: "action", sourceContext, previous: latestState?.state as AgentTurnState | null });
        const exchange = appendAgentExchange({ threadId: req.params.id, userContent: message, assistantContent: draftedAction.answer,
          citations: [], presentation: draftedAction.presentation, presentations: [draftedAction.presentation], state, stateVersion });
        saveAgentTurnState({ messageId: exchange.assistantMessage.id, threadId: req.params.id, version: stateVersion, intent: state.intent, state });
        renameAgentThreadFromFirstMessage(req.params.id, message);
        return void res.json(exchange);
      }
      const deterministic = buildDeterministicTurn(effectiveQuery, sourceContext, deterministicOptions)
        ?? (effectiveQuery !== message ? buildDeterministicTurn(message, sourceContext, deterministicOptions) : null);
      if (deterministic) {
        deterministic.answer = ensureAgentAnswerVariation(
          regeneration.previousAnswer,
          deterministic.answer,
          regeneration.variationSeed
        );
        const stateVersion = (latestState?.version ?? 0) + 1;
        const exchange = appendAgentExchange({
          threadId: req.params.id,
          userContent: message,
          assistantContent: deterministic.answer,
          citations: deterministic.citations,
          presentation: deterministic.presentations[0] ?? null,
          presentations: deterministic.presentations,
          state: deterministic.state,
          stateVersion
        });
        saveAgentTurnState({ messageId: exchange.assistantMessage.id, threadId: req.params.id, version: stateVersion, intent: deterministic.state.intent, state: deterministic.state });
        recordAgentToolRun({
          messageId: exchange.assistantMessage.id,
          toolName: deterministic.toolName,
          arguments: deterministic.toolArguments,
          resultSummary: { count: deterministic.resultCount },
          status: "completed",
          durationMs: 0
        });
        renameAgentThreadFromFirstMessage(req.params.id, message);
        return void res.json(exchange);
      }
      const clarification = await generateAgentClarification(effectiveQuery, getModelHistory(regeneration.history), chatModel);
      if (clarification) {
        const stateVersion = (latestState?.version ?? 0) + 1;
        const state = createTurnState({
          intent: queryRequestsRecommendation(effectiveQuery) ? "recommend" : "general",
          sourceContext,
          previous: latestState?.state as AgentTurnState | null
        });
        const exchange = appendAgentExchange({
          threadId: req.params.id,
          userContent: message,
          assistantContent: "",
          citations: [],
          presentation: clarification,
          presentations: [clarification],
          state,
          stateVersion
        });
        saveAgentTurnState({ messageId: exchange.assistantMessage.id, threadId: req.params.id, version: stateVersion, intent: state.intent, state });
        renameAgentThreadFromFirstMessage(req.params.id, message);
        return void res.json(exchange);
      }
      const analytics = retrieveAgentAnalytics(effectiveQuery);
      const history = regeneration.history;
      const userModel = queryRequestsRecommendation(effectiveQuery)
        ? buildAgentUserModelContext(getActiveUserId())
        : null;
      const retrievedCitations = analytics && !queryRequestsRecommendation(effectiveQuery)
        ? []
        : await retrieveAgentContext(effectiveQuery, 8, buildRetrievalOptions(
          history, effectiveQuery, regeneration, userModel, latestState?.state as AgentTurnState | null ?? null
        ));
      const { citations, recommendationEligibleNumbers } = collectEvidence(history, retrievedCitations);
      const answer = await generateAgentAnswer(effectiveQuery, citations, getModelHistory(history),
      recommendationEligibleNumbers, analytics, regeneration.variationSeed, chatModel, userModel, regeneration.previousAnswer);
      const presentation = buildAgentPresentation(effectiveQuery, answer, citations, recommendationEligibleNumbers, analytics);
      const presentations = presentation ? [presentation] : [];
      const stateVersion = (latestState?.version ?? 0) + 1;
      const state = createTurnState({
        intent: queryRequestsRecommendation(effectiveQuery) ? "recommend" : analytics ? "aggregate" : "general",
        citations,
        citationNumbers: presentation?.kind === "media-cards" ? presentation.citationNumbers : undefined,
        sourceContext,
        previous: latestState?.state as AgentTurnState | null,
        entities: mentions.filter((item) => item.type !== "code").map((item) => ({ type: item.type, value: item.value, label: item.label }))
      });
      const exchange = appendAgentExchange({
        threadId: req.params.id,
        userContent: message,
        assistantContent: answer,
        citations,
        presentation,
        presentations,
        state,
        stateVersion
      });
      saveAgentTurnState({ messageId: exchange.assistantMessage.id, threadId: req.params.id, version: stateVersion, intent: state.intent, state });
      renameAgentThreadFromFirstMessage(req.params.id, message);
      res.json(exchange);
    } catch (error) { next(error); }
  });

  app.post("/api/agent/threads/:id/messages/stream", async (req, res, next) => {
    let assistantMessageId: string | null = null;
    let partialContent = "";
    const trace: AgentTraceStep[] = [];
    const controller = new AbortController();
    try {
      const runtime = await getAgentRuntimeStatus();
      if (!runtime.agentAvailable) {
        res.status(503).json({ code: runtime.unavailableCode, error: runtime.unavailableReason, capabilities: runtime });
        return;
      }
      const thread = getAgentThread(req.params.id, getActiveUserId()) as {
        messages?: AgentHistoryMessage[];
        context?: AgentEntryContext | null;
      } | null;
      if (!thread) return void res.status(404).json({ error: "对话不存在" });
      if (activeAgentTurns.has(req.params.id)) {
        res.status(409).json({ code: "AGENT_TURN_ACTIVE", error: "这个对话正在生成回答，请等待或先停止当前回答" });
        return;
      }

      const { message, model, requestId = crypto.randomUUID(), context, baseStateVersion, mentions, composerContext, regenerateFromMessageId } = messageSchema.parse(req.body ?? {});
      const chatModel = await resolveAgentChatModel(model);
      await assertAgentChatModelLoaded(chatModel);
      if (!regenerateFromMessageId) learnAgentQueryPreferences({ userId: getActiveUserId(), query: message, mentions });
      const effectiveQuery = mentionAugmentedQuery(message, mentions, composerContext);
      const historyMessages = thread.messages ?? [];
      if (regenerateFromMessageId && !historyMessages.some((item) => item.id === regenerateFromMessageId && item.role === "assistant")) {
        res.status(400).json({ code: "AGENT_REGENERATION_SOURCE_NOT_FOUND", error: "找不到需要重新生成的原回答" });
        return;
      }
      const regeneration = getAgentRegenerationContext(historyMessages, regenerateFromMessageId);
      const deterministicOptions = withRepeatedQueryVariation(
        regeneration, historyMessages, message, Boolean(regenerateFromMessageId)
      );
      const latestState = getLatestAgentTurnState(req.params.id);
      if (baseStateVersion != null && latestState && latestState.version !== baseStateVersion) {
        res.status(409).json({ code: "AGENT_STATE_CHANGED", error: "对话结果已经变化，请基于最新结果重试", latestState });
        return;
      }
      const sourceContext = (context ?? thread.context ?? null) as AgentEntryContext | null;
      const exchange = beginAgentExchange({ threadId: req.params.id, userContent: message, requestId });
      assistantMessageId = exchange.assistantMessage.id;
      renameAgentThreadFromFirstMessage(req.params.id, message);
      activeAgentTurns.set(req.params.id, controller);

      res.status(200);
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, no-transform");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("X-Agent-Request-Id", requestId);
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      res.on("close", () => {
        if (!res.writableEnded) controller.abort(new Error("Client disconnected"));
      });

      const startedAt = Date.now();
      trace.push({ key: "understand", label: "识别意图", detail: describeAgentIntent(message), status: "complete", durationMs: 0 });
      trace.push({ key: "retrieve", label: "检索范围", detail: "正在匹配元数据、收藏与观看记录", status: "active", durationMs: null });
      writeStreamEvent(res, { type: "accepted", userMessage: exchange.userMessage, assistantMessage: exchange.assistantMessage, trace });

      const draftedAction = draftActionFromMessage({ userId: getActiveUserId(), threadId: req.params.id, message, state: latestState?.state as AgentTurnState | null ?? null });
      if (draftedAction) {
        const stateVersion = (latestState?.version ?? 0) + 1;
        const state = createTurnState({ intent: "action", sourceContext, previous: latestState?.state as AgentTurnState | null });
        trace[1] = { ...trace[1], label: "准备操作", detail: draftedAction.action.preview.description, status: "complete", durationMs: 0 };
        trace.push({ key: "save", label: "等待确认", detail: "操作尚未执行，等待你的明确确认", status: "complete", durationMs: 0 });
        partialContent = draftedAction.answer;
        writeStreamEvent(res, { type: "presentation", presentations: [draftedAction.presentation], stateVersion });
        writeStreamEvent(res, { type: "delta", delta: draftedAction.answer });
        const assistantMessage = completeAgentMessage({ messageId: assistantMessageId, content: draftedAction.answer, citations: [],
          presentation: draftedAction.presentation, presentations: [draftedAction.presentation], state, stateVersion, trace });
        saveAgentTurnState({ messageId: assistantMessageId, threadId: req.params.id, version: stateVersion, intent: state.intent, state });
        writeStreamEvent(res, { type: "completed", userMessage: exchange.userMessage, assistantMessage, elapsedMs: Date.now() - startedAt });
        res.end();
        return;
      }

      const deterministic = buildDeterministicTurn(effectiveQuery, sourceContext, deterministicOptions)
        ?? (effectiveQuery !== message ? buildDeterministicTurn(message, sourceContext, deterministicOptions) : null);
      if (deterministic) {
        deterministic.answer = ensureAgentAnswerVariation(
          regeneration.previousAnswer,
          deterministic.answer,
          regeneration.variationSeed
        );
        const toolStartedAt = Date.now();
        trace[1] = {
          ...trace[1],
          label: "查询馆藏",
          detail: `${deterministic.toolName} 已返回 ${deterministic.resultCount} 项结果`,
          status: "complete",
          durationMs: Date.now() - toolStartedAt
        };
        trace.push({
          key: "evidence",
          label: "确认依据",
          detail: deterministic.citations.length
            ? `已核对 ${deterministic.citations.map((item) => item.code).join("、")}`
            : "已使用本地数据库完整聚合结果",
          status: "complete",
          durationMs: 0
        });
        trace.push({ key: "write", label: "组织回复", detail: "确定性结果已生成", status: "complete", durationMs: 0 });
        trace.push({ key: "save", label: "保存会话", detail: "回答、工具结果与回合状态已写入 辅助存储", status: "complete", durationMs: 0 });
        partialContent = deterministic.answer;
        const stateVersion = (latestState?.version ?? 0) + 1;
        writeStreamEvent(res, { type: "evidence", citations: deterministic.citations, trace });
        writeStreamEvent(res, { type: "presentation", presentations: deterministic.presentations, stateVersion });
        writeStreamEvent(res, { type: "delta", delta: deterministic.answer });
        const assistantMessage = completeAgentMessage({
          messageId: assistantMessageId,
          content: deterministic.answer,
          citations: deterministic.citations,
          presentation: deterministic.presentations[0] ?? null,
          presentations: deterministic.presentations,
          state: deterministic.state,
          stateVersion,
          trace
        });
        saveAgentTurnState({ messageId: assistantMessageId, threadId: req.params.id, version: stateVersion, intent: deterministic.state.intent, state: deterministic.state });
        recordAgentToolRun({
          messageId: assistantMessageId,
          toolName: deterministic.toolName,
          arguments: deterministic.toolArguments,
          resultSummary: { count: deterministic.resultCount },
          status: "completed",
          durationMs: trace[1].durationMs
        });
        writeStreamEvent(res, { type: "completed", userMessage: exchange.userMessage, assistantMessage, elapsedMs: Date.now() - startedAt });
        res.end();
        return;
      }

      const clarification = await generateAgentClarification(effectiveQuery, getModelHistory(regeneration.history), chatModel);
      if (clarification) {
        const stateVersion = (latestState?.version ?? 0) + 1;
        const state = createTurnState({
          intent: queryRequestsRecommendation(effectiveQuery) ? "recommend" : "general",
          sourceContext,
          previous: latestState?.state as AgentTurnState | null
        });
        trace[1] = { ...trace[1], label: "确认需求", detail: "馆长需要一个会影响检索结果的选择", status: "complete", durationMs: Date.now() - startedAt };
        trace.push({ key: "write", label: "提出问题", detail: "等待你的选择后继续原请求", status: "complete", durationMs: 0 });
        trace.push({ key: "save", label: "保存会话", detail: "澄清问题已写入 辅助存储 会话库", status: "complete", durationMs: 0 });
        writeStreamEvent(res, { type: "presentation", presentations: [clarification], stateVersion });
        const assistantMessage = completeAgentMessage({
          messageId: assistantMessageId,
          content: "",
          citations: [],
          presentation: clarification,
          presentations: [clarification],
          state,
          stateVersion,
          trace
        });
        saveAgentTurnState({ messageId: assistantMessageId, threadId: req.params.id, version: stateVersion, intent: state.intent, state });
        writeStreamEvent(res, { type: "completed", userMessage: exchange.userMessage, assistantMessage, elapsedMs: Date.now() - startedAt });
        res.end();
        return;
      }

      const retrievalStartedAt = Date.now();
      const analytics = retrieveAgentAnalytics(effectiveQuery);
      const history = regeneration.history;
      const userModel = queryRequestsRecommendation(effectiveQuery)
        ? buildAgentUserModelContext(getActiveUserId())
        : null;
      const retrievedCitations = analytics && !queryRequestsRecommendation(effectiveQuery)
        ? []
        : await retrieveAgentContext(effectiveQuery, 8, buildRetrievalOptions(
          history, effectiveQuery, regeneration, userModel, latestState?.state as AgentTurnState | null ?? null
        ));
      trace[1] = {
        ...trace[1],
        status: "complete",
        durationMs: Date.now() - retrievalStartedAt,
        detail: analytics
          ? `全库统计完成：${analytics.totalTaggedWorks} 部${analytics.subject === "全部馆藏" ? "馆藏" : `“${analytics.subject}”`}作品，覆盖 ${analytics.distinctActors} 位演员`
          : `检索完成，获得 ${retrievedCitations.length} 条本轮候选证据${userModel?.signals.length ? `，应用 ${userModel.signals.length} 条可解释偏好信号` : ""}`
      };
      const { citations, recommendationEligibleNumbers } = collectEvidence(history, retrievedCitations);
      trace.push({
        key: "evidence",
        label: "确认依据",
        detail: analytics
          ? `数据库已按唯一番号去重并生成前 ${analytics.rows.length} 位演员排行`
          : citations.length > 0
          ? `已整理 ${citations.length} 条馆藏依据：${citations.slice(0, 4).map((item) => item.code).join("、")}${citations.length > 4 ? "…" : ""}`
          : "未找到足够的馆藏依据，将明确说明信息不足",
        status: "complete",
        durationMs: 0
      });
      const reasoningSummary = describeAgentReasoning(effectiveQuery, citations);
      trace.push({ key: "reason", label: "判断路径", detail: reasoningSummary, status: "active", durationMs: null });
      writeStreamEvent(res, { type: "evidence", citations, trace });

      const reasoningStartedAt = Date.now();
      let writingStartedAt = 0;
      let writingStarted = false;
      const answer = await streamAgentAnswer(
        effectiveQuery,
        citations,
        getModelHistory(history),
        {
          signal: controller.signal,
          onThinkingStarted: () => {
            trace[trace.length - 1] = { ...trace[trace.length - 1], detail: reasoningSummary };
            writeStreamEvent(res, { type: "trace", trace });
          },
          onContent: (delta) => {
            if (!writingStarted) {
              writingStarted = true;
              trace[trace.length - 1] = {
                ...trace[trace.length - 1],
                status: "complete",
                durationMs: Date.now() - reasoningStartedAt,
                detail: reasoningSummary
              };
              writingStartedAt = Date.now();
              trace.push({ key: "write", label: "组织回复", detail: "正在按结论、依据和引用结构输出回答", status: "active", durationMs: null });
              writeStreamEvent(res, { type: "trace", trace });
            }
            partialContent += delta;
            writeStreamEvent(res, { type: "delta", delta });
          },
          recommendationEligibleNumbers,
          analytics,
          variationSeed: regeneration.variationSeed,
          model: chatModel,
          userModel,
          previousAnswer: regeneration.previousAnswer
        }
      );

      if (writingStarted) {
        trace[trace.length - 1] = {
          ...trace[trace.length - 1],
          status: "complete",
          durationMs: Date.now() - writingStartedAt,
          detail: "回复内容已生成"
        };
      }
      trace.push({ key: "save", label: "保存会话", detail: "回答与引用已写入 辅助存储 会话库", status: "complete", durationMs: 0 });
      const presentation = buildAgentPresentation(effectiveQuery, answer, citations, recommendationEligibleNumbers, analytics);
      const presentations = presentation ? [presentation] : [];
      const stateVersion = (latestState?.version ?? 0) + 1;
      const state = createTurnState({
        intent: queryRequestsRecommendation(effectiveQuery) ? "recommend" : analytics ? "aggregate" : "general",
        citations,
        citationNumbers: presentation?.kind === "media-cards" ? presentation.citationNumbers : undefined,
        sourceContext,
        previous: latestState?.state as AgentTurnState | null,
        entities: mentions.filter((item) => item.type !== "code").map((item) => ({ type: item.type, value: item.value, label: item.label }))
      });
      const assistantMessage = completeAgentMessage({
        messageId: assistantMessageId,
        content: answer,
        citations,
        presentation,
        presentations,
        state,
        stateVersion,
        trace
      });
      saveAgentTurnState({ messageId: assistantMessageId, threadId: req.params.id, version: stateVersion, intent: state.intent, state });
      writeStreamEvent(res, {
        type: "completed",
        userMessage: exchange.userMessage,
        assistantMessage,
        elapsedMs: Date.now() - startedAt
      });
      res.end();
    } catch (error) {
      const interrupted = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
      const message = interrupted ? "生成已停止" : error instanceof Error ? error.message : "Agent 生成失败";
      const activeStep = [...trace].reverse().find((step) => step.status === "active");
      if (activeStep) {
        activeStep.status = interrupted ? "interrupted" : "failed";
        activeStep.detail = message;
      }
      if (assistantMessageId) {
        try { failAgentMessage({ messageId: assistantMessageId, content: partialContent, trace, error: message, interrupted }); } catch { /* 辅助存储 may be unavailable. */ }
      }
      if (res.headersSent) {
        writeStreamEvent(res, { type: "error", error: message, interrupted, partialContent, trace });
        if (!res.writableEnded) res.end();
      } else {
        next(error);
      }
    } finally {
      if (activeAgentTurns.get(req.params.id) === controller) activeAgentTurns.delete(req.params.id);
    }
  });

  app.get("/api/agent/index", (_req, res, next) => {
    const startedAt = performance.now();
    try {
      const status = getAgentIndexStatus();
      res.setHeader("Server-Timing", `agent-index;dur=${(performance.now() - startedAt).toFixed(1)}`);
      res.json(status);
    } catch (error) { next(error); }
  });

  app.post("/api/agent/index", (_req, res, next) => {
    try { res.status(202).json(startAgentIndexing()); } catch (error) { next(error); }
  });

  app.post("/api/agent/messages/:id/feedback", (req, res, next) => {
    try { res.status(201).json(recordAgentFeedback({ userId: getActiveUserId(), messageId: req.params.id, ...feedbackSchema.parse(req.body) })); }
    catch (error) { next(error); }
  });
  app.delete("/api/agent/feedback/:id", (req, res, next) => {
    try { if (!deleteAgentFeedback(getActiveUserId(), req.params.id)) return void res.status(404).json({ error: "反馈不存在" }); res.status(204).end(); }
    catch (error) { next(error); }
  });
  app.post("/api/agent/messages/:id/replace-slot/:slot", (req, res, next) => {
    try {
      const result = replaceAgentRecommendationSlot({ userId: getActiveUserId(), messageId: req.params.id, slot: z.coerce.number().int().min(1).max(24).parse(req.params.slot) });
      if (!result) return void res.status(409).json({ error: "当前推荐位无法替换" });
      recordAgentFeedback({ userId: getActiveUserId(), messageId: req.params.id, mediaId: result.state.mediaSlots.find((item) => item.slot === Number(req.params.slot))?.mediaId ?? "unknown", slot: Number(req.params.slot), feedbackType: "replace" });
      res.json(result);
    } catch (error) { next(error); }
  });
  app.get("/api/agent/preferences", (_req, res, next) => {
    try {
      const userId = getActiveUserId();
      refreshAgentQueryPreferences(userId);
      res.json(listAgentPreferences(userId));
    } catch (error) { next(error); }
  });
  app.patch("/api/agent/preferences/:id", (req, res, next) => {
    try { const item = updateAgentPreference(getActiveUserId(), req.params.id, preferencePatchSchema.parse(req.body)); if (!item) return void res.status(404).json({ error: "偏好不存在" }); res.json(item); }
    catch (error) { next(error); }
  });
  app.delete("/api/agent/preferences/:id", (req, res, next) => { try { if (!deleteAgentPreference(getActiveUserId(), req.params.id)) return void res.status(404).json({ error: "偏好不存在" }); res.status(204).end(); } catch (error) { next(error); } });
  app.delete("/api/agent/preferences", (_req, res, next) => { try { res.json(clearAgentLearning(getActiveUserId())); } catch (error) { next(error); } });
  app.post("/api/agent/actions", (req, res, next) => { try { res.status(201).json(createAgentActionDraft({ userId: getActiveUserId(), ...actionDraftSchema.parse(req.body) })); } catch (error) { next(error); } });
  app.get("/api/agent/actions/:id", (req, res, next) => { try { const action = getAgentAction(getActiveUserId(), req.params.id); if (!action) return void res.status(404).json({ error: "操作不存在" }); res.json(action); } catch (error) { next(error); } });
  app.post("/api/agent/actions/:id/confirm", (req, res, next) => { try { const action = confirmAgentAction(getActiveUserId(), req.params.id); if (!action) return void res.status(404).json({ error: "操作不存在" }); res.json(action); } catch (error) { next(error); } });
  app.post("/api/agent/actions/:id/cancel", (req, res, next) => { try { const action = cancelAgentAction(getActiveUserId(), req.params.id); if (!action) return void res.status(404).json({ error: "操作不存在" }); res.json(action); } catch (error) { next(error); } });

  app.post("/api/agent/messages", async (req, res) => {
    const capabilities = await getAgentRuntimeStatus();
    res.status(410).json({
      code: "AGENT_THREAD_REQUIRED",
      error: "请先创建对话，再向 /api/agent/threads/:id/messages 发送消息",
      capabilities
    });
  });
}
