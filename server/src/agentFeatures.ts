import crypto from "node:crypto";
import { db } from "./db.js";
import { getAgentStore } from "./agentStore.js";
import { readFavoriteKeys, writeFavoriteKeys } from "./favorites.js";
import { searchMedia, type AgentTurnState } from "./agentTools.js";
import type { AgentCitation, AgentPresentation } from "./agentRag.js";
import { extractAgentGenreConceptValues } from "./agentTaxonomy.js";
import { getTopicGraphItems, type TopicType } from "./productRoutes.js";

export type AgentFeedbackType = "like" | "not_interested" | "already_watched" | "more_like_this" | "replace";

export type AgentPreference = {
  id: string;
  userId: string;
  dimension: "actor" | "genre" | "series" | "maker" | "label" | "director" | "duration";
  value: string;
  weight: number;
  confidence: number;
  source: "explicit" | "feedback" | "watch_history" | "favorite" | "query_history";
  status: "active" | "muted";
  evidence: Record<string, unknown>;
  updatedAt: string;
};

export type AgentQueryPreferenceMention = {
  type: "code" | "actor" | "genre" | "series" | "maker" | "label" | "director" | "prefix";
  value: string;
  label: string;
};

export type AgentQueryPreferenceSignal = {
  dimension: Exclude<AgentPreference["dimension"], "duration">;
  value: string;
  weight: number;
};

const queryPreferenceDimensions = ["actor", "genre", "series", "maker", "label", "director"] as const;
const queryProfileRefreshIntervalMs = 6 * 60 * 60_000;
const lastQueryProfileRefresh = new Map<string, number>();

function normalizedQueryValue(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("ja");
}

function queryContainsPreferenceValue(query: string, value: string): boolean {
  const normalizedQuery = normalizedQueryValue(query);
  const normalizedValue = normalizedQueryValue(value);
  if (!normalizedValue || !normalizedQuery.includes(normalizedValue)) return false;
  if (!/^[a-z0-9][a-z0-9+._-]*$/iu.test(normalizedValue)) return true;
  const escaped = normalizedValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "iu").test(normalizedQuery);
}

/** Extracts only interest-bearing query entities; informational questions do not become preferences. */
export function extractAgentQueryPreferenceSignals(
  query: string,
  mentions: AgentQueryPreferenceMention[] = []
): AgentQueryPreferenceSignal[] {
  if (!/(?:推荐|推薦|找片|找几|找幾|挑几|挑幾|来点|來點|想看|喜欢|喜歡|偏好|更多类似|更多類似|继续推荐|繼續推薦|再推荐|再推薦|换一批|換一批|不要|排除|避开|避開)/u.test(query)) return [];
  const negative = /(?:不喜欢|不喜歡|不要|排除|避开|避開|减少|減少|别再|別再)/u.test(query);
  const weight = negative ? -0.55 : 0.36;
  const signals = new Map<string, AgentQueryPreferenceSignal>();
  const add = (dimension: AgentQueryPreferenceSignal["dimension"], value: string) => {
    const cleaned = value.trim();
    if (cleaned.length < 2) return;
    const key = `${dimension}:${normalizedQueryValue(cleaned)}`;
    signals.set(key, { dimension, value: cleaned, weight });
  };

  mentions.forEach((mention) => {
    if (queryPreferenceDimensions.includes(mention.type as typeof queryPreferenceDimensions[number])) {
      add(mention.type as AgentQueryPreferenceSignal["dimension"], mention.label || mention.value);
    }
  });
  extractAgentGenreConceptValues(query).forEach((value) => add("genre", value));

  for (const dimension of queryPreferenceDimensions) {
    getTopicGraphItems(dimension as TopicType)
      .filter((item) => [item.value, item.label, ...item.aliases].some((value) => queryContainsPreferenceValue(query, value)))
      .sort((left, right) => Math.max(right.value.length, right.label.length) - Math.max(left.value.length, left.label.length)
        || right.mediaCount - left.mediaCount)
      .slice(0, dimension === "genre" ? 5 : 3)
      .forEach((item) => add(dimension, item.label || item.value));
  }
  return [...signals.values()];
}

function storeQueryPreferenceSignals(
  userId: string,
  query: string,
  createdAt: string,
  signals: AgentQueryPreferenceSignal[]
): number {
  if (!signals.length) return 0;
  const database = getAgentStore();
  const select = database.prepare(`
    SELECT weight, confidence, evidence_json AS evidenceJson FROM agent_preferences
    WHERE user_id = ? AND dimension = ? AND value = ? AND source = 'query_history'
  `);
  const upsert = database.prepare(`
    INSERT INTO agent_preferences (id, user_id, dimension, value, weight, confidence, source, status, evidence_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'query_history', 'active', ?, ?)
    ON CONFLICT(user_id, dimension, value, source) DO UPDATE SET
      weight = excluded.weight, confidence = excluded.confidence, status = 'active',
      evidence_json = excluded.evidence_json, updated_at = excluded.updated_at
  `);
  database.transaction(() => signals.forEach((signal) => {
    const current = select.get(userId, signal.dimension, signal.value) as {
      weight: number; confidence: number; evidenceJson: string;
    } | undefined;
    const evidence = parseJson<{ occurrences?: number; examples?: string[] }>(current?.evidenceJson ?? "{}", {});
    const occurrences = (evidence.occurrences ?? 0) + 1;
    const direction = signal.weight < 0 ? -1 : 1;
    const currentWeight = current?.weight ?? signal.weight;
    const nextWeight = Math.max(-0.72, Math.min(0.72,
      currentWeight * 0.72 + signal.weight * 0.28 + direction * Math.min(0.08, occurrences * 0.012)));
    const confidence = Math.min(0.9, Math.max(current?.confidence ?? 0.32, 0.32 + occurrences * 0.1));
    const examples = [query.replace(/\s+/gu, " ").trim().slice(0, 180), ...(evidence.examples ?? [])]
      .filter((value, index, items) => value && items.indexOf(value) === index).slice(0, 3);
    upsert.run(crypto.randomUUID(), userId, signal.dimension, signal.value, nextWeight, confidence,
      JSON.stringify({ occurrences, examples, lastSeenAt: createdAt, refreshPolicy: "on-query+6h-rebuild" }), createdAt);
  }))();
  return signals.length;
}

export function refreshAgentQueryPreferences(userId: string, options: { force?: boolean } = {}): {
  refreshed: boolean;
  queries: number;
  signals: number;
} {
  const now = Date.now();
  if (!options.force && now - (lastQueryProfileRefresh.get(userId) ?? 0) < queryProfileRefreshIntervalMs) {
    return { refreshed: false, queries: 0, signals: 0 };
  }
  const database = getAgentStore();
  const rows = database.prepare(`
    SELECT content, createdAt FROM (
      SELECT agent_messages.content, agent_messages.created_at AS createdAt, agent_messages.rowid AS messageRowId
      FROM agent_messages JOIN agent_threads ON agent_threads.id = agent_messages.thread_id
      WHERE agent_threads.user_id = ? AND agent_messages.role = 'user'
      ORDER BY agent_messages.created_at DESC, agent_messages.rowid DESC
      LIMIT 400
    ) recent_queries ORDER BY createdAt ASC, messageRowId ASC
  `).all(userId) as Array<{ content: string; createdAt: string }>;
  database.transaction(() => {
    database.prepare("DELETE FROM agent_preferences WHERE user_id = ? AND source = 'query_history'").run(userId);
    rows.forEach((row) => storeQueryPreferenceSignals(
      userId, row.content, row.createdAt, extractAgentQueryPreferenceSignals(row.content)
    ));
  })();
  lastQueryProfileRefresh.set(userId, now);
  const signals = (database.prepare(`SELECT COUNT(*) AS count FROM agent_preferences
    WHERE user_id = ? AND source = 'query_history'`).get(userId) as { count: number }).count;
  return { refreshed: true, queries: rows.length, signals };
}

export function learnAgentQueryPreferences(input: {
  userId: string;
  query: string;
  mentions?: AgentQueryPreferenceMention[];
}): number {
  try {
    refreshAgentQueryPreferences(input.userId);
    return storeQueryPreferenceSignals(
      input.userId,
      input.query,
      new Date().toISOString(),
      extractAgentQueryPreferenceSignals(input.query, input.mentions)
    );
  } catch {
    return 0;
  }
}

export type AgentActionType = "create_playlist" | "add_to_playlist" | "set_favorite" | "watch_later";
export type AgentActionStatus = "awaiting_confirmation" | "executing" | "completed" | "failed" | "cancelled" | "expired";

export type AgentPendingAction = {
  id: string;
  userId: string;
  threadId: string;
  actionType: AgentActionType;
  payload: Record<string, unknown>;
  preview: {
    title: string;
    description: string;
    media: Array<{ mediaId: string; code: string }>;
    confirmLabel: string;
  };
  status: AgentActionStatus;
  idempotencyKey: string;
  result: Record<string, unknown>;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function mapAction(row: Record<string, unknown> & { payloadJson: string; previewJson: string; resultJson: string }): AgentPendingAction {
  const { payloadJson, previewJson, resultJson, ...rest } = row;
  return {
    ...(rest as unknown as Omit<AgentPendingAction, "payload" | "preview" | "result">),
    payload: parseJson(payloadJson, {}),
    preview: parseJson(previewJson, { title: "待确认操作", description: "", media: [], confirmLabel: "确认" }),
    result: parseJson(resultJson, {})
  };
}

function loadMediaSummary(mediaIds: string[]): Array<{ mediaId: string; code: string; relativePath: string }> {
  const unique = [...new Set(mediaIds)].slice(0, 100);
  if (!unique.length) return [];
  const rows = db.prepare(`
    SELECT id AS mediaId, normalized_code AS code, relative_path AS relativePath
    FROM media_files WHERE media_type = 'video' AND id IN (${unique.map(() => "?").join(",")})
  `).all(...unique) as Array<{ mediaId: string; code: string; relativePath: string }>;
  const byId = new Map(rows.map((row) => [row.mediaId, row]));
  return unique.map((id) => byId.get(id)).filter((item): item is { mediaId: string; code: string; relativePath: string } => Boolean(item));
}

export function recordAgentFeedback(input: {
  userId: string;
  messageId: string;
  mediaId: string;
  slot?: number | null;
  feedbackType: AgentFeedbackType;
  context?: Record<string, unknown>;
}) {
  const database = getAgentStore();
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  database.prepare(`
    INSERT INTO agent_feedback (id, user_id, message_id, media_id, slot, feedback_type, context_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, message_id, media_id, feedback_type) DO UPDATE SET slot = excluded.slot,
      context_json = excluded.context_json, created_at = excluded.created_at
  `).run(id, input.userId, input.messageId, input.mediaId, input.slot ?? null, input.feedbackType, JSON.stringify(input.context ?? {}), createdAt);

  if (input.feedbackType === "like" || input.feedbackType === "not_interested" || input.feedbackType === "more_like_this") {
    const row = db.prepare(`
      SELECT CASE WHEN media_metadata.actors_zh_json <> '[]' THEN media_metadata.actors_zh_json ELSE media_metadata.actors_json END AS actors,
        CASE WHEN media_metadata.genres_zh_json <> '[]' THEN media_metadata.genres_zh_json ELSE media_metadata.genres_json END AS genres,
        COALESCE(NULLIF(media_metadata.series_zh, ''), media_metadata.series, '') AS series,
        COALESCE(NULLIF(media_metadata.maker_zh, ''), media_metadata.maker, '') AS maker,
        COALESCE(NULLIF(media_metadata.label_zh, ''), media_metadata.label, '') AS label,
        COALESCE(NULLIF(media_metadata.director_zh, ''), media_metadata.director, '') AS director
      FROM media_files LEFT JOIN media_metadata ON media_metadata.normalized_code = media_files.normalized_code
      WHERE media_files.id = ?
    `).get(input.mediaId) as {
      actors?: string; genres?: string; series?: string; maker?: string; label?: string; director?: string;
    } | undefined;
    const weight = input.feedbackType === "not_interested" ? -0.8 : input.feedbackType === "like" ? 0.8 : 0.55;
    const entities: Array<{ dimension: AgentPreference["dimension"]; value: string }> = [];
    const toList = (value?: string) => parseJson<string[]>(value || "[]", []).filter(Boolean);
    toList(row?.actors).slice(0, 3).forEach((value) => entities.push({ dimension: "actor", value }));
    toList(row?.genres).slice(0, 5).forEach((value) => entities.push({ dimension: "genre", value }));
    if (row?.series) entities.push({ dimension: "series", value: row.series });
    if (row?.maker) entities.push({ dimension: "maker", value: row.maker });
    if (row?.label) entities.push({ dimension: "label", value: row.label });
    if (row?.director) entities.push({ dimension: "director", value: row.director });
    const upsert = database.prepare(`
      INSERT INTO agent_preferences (id, user_id, dimension, value, weight, confidence, source, status, evidence_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'feedback', 'active', ?, ?)
      ON CONFLICT(user_id, dimension, value, source) DO UPDATE SET
        weight = MAX(-1.0, MIN(1.0, (agent_preferences.weight * 0.65) + (excluded.weight * 0.35))),
        confidence = MIN(1.0, agent_preferences.confidence + 0.15), status = 'active',
        evidence_json = excluded.evidence_json, updated_at = excluded.updated_at
    `);
    database.transaction(() => entities.forEach((entity) => upsert.run(
      crypto.randomUUID(), input.userId, entity.dimension, entity.value, weight, 0.55,
      JSON.stringify({ messageId: input.messageId, mediaId: input.mediaId, feedbackType: input.feedbackType }), createdAt
    )))();
  }
  return { id, ...input, createdAt };
}

export function deleteAgentFeedback(userId: string, feedbackId: string): boolean {
  return getAgentStore().prepare("DELETE FROM agent_feedback WHERE id = ? AND user_id = ?").run(feedbackId, userId).changes > 0;
}

export function replaceAgentRecommendationSlot(input: {
  userId: string;
  messageId: string;
  slot: number;
}): { citations: AgentCitation[]; presentations: AgentPresentation[]; state: AgentTurnState; stateVersion: number } | null {
  const database = getAgentStore();
  const row = database.prepare(`
    SELECT agent_messages.id, agent_messages.citations_json AS citationsJson,
      agent_messages.presentations_json AS presentationsJson, agent_messages.state_json AS stateJson,
      agent_messages.state_version AS stateVersion
    FROM agent_messages JOIN agent_threads ON agent_threads.id = agent_messages.thread_id
    WHERE agent_messages.id = ? AND agent_threads.user_id = ? AND agent_messages.role = 'assistant'
  `).get(input.messageId, input.userId) as {
    citationsJson: string; presentationsJson: string; stateJson: string; stateVersion: number;
  } | undefined;
  if (!row) return null;
  const citations = parseJson<AgentCitation[]>(row.citationsJson, []);
  const presentations = parseJson<AgentPresentation[]>(row.presentationsJson, []);
  const state = parseJson<AgentTurnState | null>(row.stateJson, null);
  if (!state || state.intent !== "recommend") return null;
  const target = state.mediaSlots.find((item) => item.slot === input.slot);
  if (!target || target.locked) return null;
  const excludedIds = [...new Set([
    ...state.mediaSlots.map((item) => item.mediaId),
    ...(database.prepare(`SELECT media_id AS mediaId FROM agent_feedback WHERE user_id = ? AND feedback_type = 'not_interested'`)
      .all(input.userId) as Array<{ mediaId: string }>).map((item) => item.mediaId)
  ])];
  const include = state.constraints.include;
  const replacement = searchMedia({
    favorite: typeof include.favorite === "boolean" ? include.favorite : undefined,
    watched: include.watched === "unwatched" ? "unwatched" : "any",
    actors: Array.isArray(include.actors) ? include.actors.map(String) : undefined,
    genres: Array.isArray(include.genres) ? include.genres.map(String) : undefined,
    series: Array.isArray(include.series) ? include.series.map(String) : undefined,
    sort: "recent",
    limit: 1,
    excludeMediaIds: excludedIds
  });
  const next = replacement[0];
  if (!next) return null;
  const citationIndex = citations.findIndex((item) => item.mediaId === next.mediaId);
  const citationNumber = citationIndex >= 0 ? citationIndex + 1 : citations.push(next);
  const mediaPresentation = presentations.find((item): item is Extract<AgentPresentation, { kind: "media-cards" }> => item.kind === "media-cards");
  if (!mediaPresentation) return null;
  mediaPresentation.citationNumbers[input.slot - 1] = citationNumber;
  target.mediaId = next.mediaId;
  const stateVersion = row.stateVersion + 1;
  database.prepare(`
    UPDATE agent_messages SET citations_json = ?, presentation_json = ?, presentations_json = ?, state_json = ?, state_version = ?
    WHERE id = ?
  `).run(JSON.stringify(citations), JSON.stringify(presentations[0] ?? null), JSON.stringify(presentations), JSON.stringify(state), stateVersion, input.messageId);
  database.prepare(`UPDATE agent_turn_states SET version = ?, state_json = ? WHERE message_id = ?`)
    .run(stateVersion, JSON.stringify(state), input.messageId);
  return { citations, presentations, state, stateVersion };
}

export function listAgentPreferences(userId: string): { items: AgentPreference[] } {
  const rows = getAgentStore().prepare(`
    SELECT id, user_id AS userId, dimension, value, weight, confidence, source, status,
      evidence_json AS evidenceJson, updated_at AS updatedAt
    FROM agent_preferences WHERE user_id = ? ORDER BY status, ABS(weight) DESC, updated_at DESC
  `).all(userId) as Array<Record<string, unknown> & { evidenceJson: string }>;
  return { items: rows.map(({ evidenceJson, ...row }) => ({ ...row, evidence: parseJson(evidenceJson, {}) } as AgentPreference)) };
}

export function updateAgentPreference(userId: string, id: string, patch: { weight?: number; status?: "active" | "muted" }) {
  const current = getAgentStore().prepare(`SELECT id FROM agent_preferences WHERE id = ? AND user_id = ?`).get(id, userId);
  if (!current) return null;
  getAgentStore().prepare(`
    UPDATE agent_preferences SET weight = COALESCE(?, weight), status = COALESCE(?, status), updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(patch.weight ?? null, patch.status ?? null, new Date().toISOString(), id, userId);
  return listAgentPreferences(userId).items.find((item) => item.id === id) ?? null;
}

export function deleteAgentPreference(userId: string, id: string): boolean {
  return getAgentStore().prepare("DELETE FROM agent_preferences WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}

export function clearAgentLearning(userId: string): { preferences: number; feedback: number } {
  return getAgentStore().transaction(() => ({
    preferences: getAgentStore().prepare("DELETE FROM agent_preferences WHERE user_id = ?").run(userId).changes,
    feedback: getAgentStore().prepare("DELETE FROM agent_feedback WHERE user_id = ?").run(userId).changes
  }))();
}

export function createAgentActionDraft(input: {
  userId: string;
  threadId: string;
  actionType: AgentActionType;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
}): AgentPendingAction {
  const mediaIds = Array.isArray(input.payload.mediaIds) ? input.payload.mediaIds.map(String) : [];
  const media = loadMediaSummary(mediaIds);
  if (media.length !== [...new Set(mediaIds)].length) throw new Error("操作包含无效或不可用的影片");
  const name = typeof input.payload.name === "string" ? input.payload.name.trim().slice(0, 120) : "";
  const favorite = input.payload.favorite !== false;
  const previewMedia = media.map(({ mediaId, code }) => ({ mediaId, code }));
  const preview = input.actionType === "create_playlist"
    ? { title: "创建片单", description: `创建“${name || "智能馆长片单"}”并加入 ${media.length} 部影片`, media: previewMedia, confirmLabel: "确认创建" }
    : input.actionType === "add_to_playlist"
    ? { title: "加入片单", description: `向指定片单加入 ${media.length} 部影片`, media: previewMedia, confirmLabel: "确认加入" }
    : input.actionType === "watch_later"
    ? { title: "加入稍后观看", description: `把 ${media.length} 部影片加入“稍后观看”`, media: previewMedia, confirmLabel: "确认加入" }
    : { title: favorite ? "收藏影片" : "取消收藏", description: `${favorite ? "收藏" : "取消收藏"} ${media.length} 部影片`, media: previewMedia, confirmLabel: favorite ? "确认收藏" : "确认取消" };
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const idempotencyKey = input.idempotencyKey ?? crypto.createHash("sha256")
    .update(`${input.userId}:${input.threadId}:${input.actionType}:${JSON.stringify(input.payload)}`)
    .digest("hex");
  const existing = getAgentStore().prepare(`
    SELECT id, user_id AS userId, thread_id AS threadId, action_type AS actionType,
      payload_json AS payloadJson, preview_json AS previewJson, status, idempotency_key AS idempotencyKey,
      result_json AS resultJson, expires_at AS expiresAt, created_at AS createdAt, updated_at AS updatedAt
    FROM agent_pending_actions WHERE idempotency_key = ?
  `).get(idempotencyKey) as (Record<string, unknown> & { payloadJson: string; previewJson: string; resultJson: string }) | undefined;
  if (existing) return mapAction(existing);
  getAgentStore().prepare(`
    INSERT INTO agent_pending_actions (id, user_id, thread_id, action_type, payload_json, preview_json,
      status, idempotency_key, result_json, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'awaiting_confirmation', ?, '{}', ?, ?, ?)
  `).run(id, input.userId, input.threadId, input.actionType, JSON.stringify(input.payload), JSON.stringify(preview), idempotencyKey, expiresAt, now, now);
  return {
    id, userId: input.userId, threadId: input.threadId, actionType: input.actionType,
    payload: input.payload, preview, status: "awaiting_confirmation", idempotencyKey,
    result: {}, expiresAt, createdAt: now, updatedAt: now
  };
}

function getAction(userId: string, id: string): AgentPendingAction | null {
  const row = getAgentStore().prepare(`
    SELECT id, user_id AS userId, thread_id AS threadId, action_type AS actionType,
      payload_json AS payloadJson, preview_json AS previewJson, status, idempotency_key AS idempotencyKey,
      result_json AS resultJson, expires_at AS expiresAt, created_at AS createdAt, updated_at AS updatedAt
    FROM agent_pending_actions WHERE id = ? AND user_id = ?
  `).get(id, userId) as (Record<string, unknown> & { payloadJson: string; previewJson: string; resultJson: string }) | undefined;
  return row ? mapAction(row) : null;
}

function ensureManualPlaylist(name: string, description = "") {
  const existing = db.prepare("SELECT id, name FROM playlists WHERE kind = 'manual' AND name = ? ORDER BY updated_at DESC LIMIT 1")
    .get(name) as { id: string; name: string } | undefined;
  if (existing) return existing;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO playlists (id, name, description, kind, query_json, created_at, updated_at)
    VALUES (?, ?, ?, 'manual', '{}', ?, ?)`).run(id, name, description, now, now);
  return { id, name };
}

function addMediaToPlaylist(playlistId: string, mediaIds: string[]) {
  const now = new Date().toISOString();
  const positionRow = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM playlist_items WHERE playlist_id = ?");
  const insert = db.prepare(`INSERT INTO playlist_items (playlist_id, media_id, position, added_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(playlist_id, media_id) DO NOTHING`);
  let added = 0;
  for (const mediaId of mediaIds) {
    const position = (positionRow.get(playlistId) as { position: number }).position;
    added += insert.run(playlistId, mediaId, position, now).changes;
  }
  db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(now, playlistId);
  return added;
}

export function confirmAgentAction(userId: string, id: string): AgentPendingAction | null {
  const action = getAction(userId, id);
  if (!action) return null;
  if (action.status === "completed") return action;
  if (action.status !== "awaiting_confirmation" && action.status !== "failed") throw new Error("这个操作当前不能确认");
  if (Date.parse(action.expiresAt) < Date.now()) {
    getAgentStore().prepare("UPDATE agent_pending_actions SET status = 'expired', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    throw new Error("操作草稿已过期，请重新生成");
  }
  getAgentStore().prepare("UPDATE agent_pending_actions SET status = 'executing', updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);
  try {
    const mediaIds = Array.isArray(action.payload.mediaIds) ? action.payload.mediaIds.map(String) : [];
    const media = loadMediaSummary(mediaIds);
    if (media.length !== [...new Set(mediaIds)].length) throw new Error("部分影片已不存在，操作未执行");
    const result = db.transaction(() => {
      if (action.actionType === "create_playlist") {
        const name = typeof action.payload.name === "string" && action.payload.name.trim() ? action.payload.name.trim().slice(0, 120) : "智能馆长片单";
        const playlist = ensureManualPlaylist(name, "由智能馆长创建");
        const added = addMediaToPlaylist(playlist.id, mediaIds);
        return { playlistId: playlist.id, playlistName: playlist.name, added };
      }
      if (action.actionType === "watch_later") {
        const playlist = ensureManualPlaylist("稍后观看", "由智能馆长维护的稍后观看片单");
        return { playlistId: playlist.id, playlistName: playlist.name, added: addMediaToPlaylist(playlist.id, mediaIds) };
      }
      if (action.actionType === "add_to_playlist") {
        const playlistId = String(action.payload.playlistId ?? "");
        const playlist = db.prepare("SELECT id, name FROM playlists WHERE id = ? AND kind = 'manual'").get(playlistId) as { id: string; name: string } | undefined;
        if (!playlist) throw new Error("目标片单不存在");
        return { playlistId, playlistName: playlist.name, added: addMediaToPlaylist(playlistId, mediaIds) };
      }
      const favorite = action.payload.favorite !== false;
      const current = readFavoriteKeys();
      for (const item of media) favorite ? current.add(item.relativePath) : current.delete(item.relativePath);
      writeFavoriteKeys(current);
      return { favorite, changed: media.length };
    })();
    const updatedAt = new Date().toISOString();
    getAgentStore().prepare(`UPDATE agent_pending_actions SET status = 'completed', result_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(result), updatedAt, id);
    return getAction(userId, id);
  } catch (error) {
    getAgentStore().prepare(`UPDATE agent_pending_actions SET status = 'failed', result_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify({ error: error instanceof Error ? error.message : "操作失败" }), new Date().toISOString(), id);
    throw error;
  }
}

export function cancelAgentAction(userId: string, id: string): AgentPendingAction | null {
  const action = getAction(userId, id);
  if (!action) return null;
  if (action.status === "completed") throw new Error("已完成的操作不能取消");
  getAgentStore().prepare("UPDATE agent_pending_actions SET status = 'cancelled', updated_at = ? WHERE id = ? AND user_id = ?")
    .run(new Date().toISOString(), id, userId);
  return getAction(userId, id);
}

export function getAgentAction(userId: string, id: string): AgentPendingAction | null {
  return getAction(userId, id);
}

export function draftActionFromMessage(input: {
  userId: string;
  threadId: string;
  message: string;
  state: AgentTurnState | null;
}): { action: AgentPendingAction; presentation: AgentPresentation; answer: string } | null {
  if (!input.state?.mediaSlots.length) return null;
  const message = input.message.trim();
  let actionType: AgentActionType | null = null;
  if (/稍后观看|稍后再看/u.test(message)) actionType = "watch_later";
  else if (/创建.*片单|生成.*片单|保存.*片单/u.test(message)) actionType = "create_playlist";
  else if (/收藏/u.test(message)) actionType = "set_favorite";
  if (!actionType || !/(这些|以上|推荐|它们|这几部|全部)/u.test(message)) return null;
  const mediaIds = input.state.mediaSlots.map((item) => item.mediaId);
  const nameMatch = message.match(/[“「"]([^”」"]{1,40})[”」"]/u);
  const payload: Record<string, unknown> = { mediaIds };
  if (actionType === "create_playlist") payload.name = nameMatch?.[1] ?? "智能馆长片单";
  if (actionType === "set_favorite") payload.favorite = !/取消收藏/u.test(message);
  const action = createAgentActionDraft({ ...input, actionType, payload });
  const presentation: AgentPresentation = {
    kind: "action-confirmation",
    title: action.preview.title,
    actionId: action.id,
    actionType,
    description: action.preview.description,
    media: action.preview.media,
    confirmLabel: action.preview.confirmLabel,
    status: action.status
  };
  return { action, presentation, answer: `我已准备好“${action.preview.title}”，请核对下方范围后再确认执行。` };
}
