import { requestJson } from "../../lib/http";

export type AgentCapabilitiesResponse = {
  implementationStage: "phase-1-foundation" | "phase-2-runtime";
  agentAvailable: boolean;
  unavailableCode: "AGENT_STORAGE_UNAVAILABLE" | "AGENT_RUNTIME_UNAVAILABLE" | "AGENT_MODELS_UNAVAILABLE" | null;
  unavailableReason: string | null;
  runtimeReady?: boolean;
  installedModels?: string[];
  loadedModels?: string[];
  chatModelLoaded?: boolean;
  missingModels?: string[];
  storage: {
    state: "disabled" | "missing" | "permission-denied" | "not-directory" | "uninitialized" | "identity-mismatch" | "ready" | "unavailable";
    root: string;
    mountPoint: string | null;
    markerPath: string;
    storageId: string | null;
    readable: boolean;
    writable: boolean;
    ready: boolean;
    errorCode: string | null;
    message: string;
  };
  isolation: {
    internalFallbackAllowed: false;
    existingPlatformUnaffected: true;
    currentTranslationMode: "legacy-unchanged" | "external-t7-wait-when-missing";
    completedSubtitlesRemainInternal: true;
  };
  models: {
    chat: string;
    embedding: string;
    translation: string;
    ollamaUrl: string;
  };
  plannedCapabilities: string[];
};

export type AgentChatModelOption = {
  name: string;
  family: string;
  parameterSize: string;
  quantization: string;
  sizeBytes: number;
  capabilities: string[];
  isDefault: boolean;
  loaded: boolean;
};

export type AgentChatModelsResponse = {
  defaultModel: string | null;
  items: AgentChatModelOption[];
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

export type AgentEntryContext = {
  source: "media-detail" | "entity" | "topic" | "media-wall" | "viewing-desk" | "history";
  mediaIds?: string[];
  entity?: { type: string; value: string; label: string };
  filters?: Record<string, unknown>;
  viewingDeskSessionId?: string;
  label: string;
};

export type AgentMentionType = "code" | "actor" | "genre" | "series" | "maker" | "label" | "director" | "prefix";
export type AgentMention = {
  type: AgentMentionType;
  value: string;
  label: string;
  originalName?: string;
  count?: number;
  mediaId?: string;
  imageUrl?: string;
  latestReleaseDate?: string;
};

export type AgentComposerContext = {
  intent?: { id: string; label: string };
  constraints: Array<{ label: string; excluded: boolean }>;
};

export type AgentTurnState = {
  version: 1;
  intent: "search" | "recommend" | "compare" | "aggregate" | "entity" | "action" | "general";
  constraints: { include: Record<string, string[] | boolean | number | string>; exclude: Record<string, string[] | boolean | number | string> };
  mediaSlots: Array<{ slot: number; mediaId: string; locked: boolean; source: "tool" | "user" | "page-context" }>;
  entities: Array<{ type: string; value: string; label: string }>;
  sort: string | null;
  sourceContext: AgentEntryContext | null;
  lastToolResultId: string | null;
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
  rows: Array<{
    rank: number;
    type: "actor" | "maker" | "label" | "series" | "director";
    value: string;
    label: string;
    count: number;
    detail?: string;
  }>;
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
  status: AgentActionStatus;
};

export type AgentActionStatus = "awaiting_confirmation" | "executing" | "completed" | "failed" | "cancelled" | "expired";
export type AgentPendingAction = {
  id: string; threadId: string; actionType: "create_playlist" | "add_to_playlist" | "set_favorite" | "watch_later";
  payload: Record<string, unknown>; preview: { title: string; description: string; media: Array<{ mediaId: string; code: string }>; confirmLabel: string };
  status: AgentActionStatus; result: Record<string, unknown>; expiresAt: string;
};
export type AgentPreference = {
  id: string;
  dimension: "actor" | "genre" | "series" | "maker" | "label" | "director" | "duration";
  value: string;
  weight: number;
  confidence: number;
  source: "explicit" | "feedback" | "watch_history" | "favorite" | "query_history";
  status: "active" | "muted";
  updatedAt: string;
};

export type AgentTraceStep = {
  key: "understand" | "retrieve" | "evidence" | "reason" | "write" | "save";
  label: string;
  detail: string;
  status: "active" | "complete" | "failed" | "interrupted";
  durationMs: number | null;
};

export type AgentMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: AgentCitation[];
  presentation: AgentPresentation | null;
  presentations: AgentPresentation[];
  state: AgentTurnState | null;
  stateVersion: number;
  trace: AgentTraceStep[];
  status: "generating" | "completed" | "failed" | "interrupted";
  error: string | null;
  createdAt: string;
};

const agentMentionTypes = new Set<AgentMentionType>([
  "code", "actor", "genre", "series", "maker", "label", "director", "prefix"
]);

export function getAgentRegenerationMentions(message: AgentMessage): AgentMention[] {
  const seen = new Set<string>();
  return (message.state?.entities ?? []).flatMap((entity) => {
    if (!agentMentionTypes.has(entity.type as AgentMentionType)) return [];
    const type = entity.type as AgentMentionType;
    const key = `${type}\u0000${entity.value}`;
    if (!entity.value.trim() || seen.has(key)) return [];
    seen.add(key);
    return [{ type, value: entity.value, label: entity.label || entity.value }];
  });
}

export type AgentStreamEvent =
  | { type: "accepted"; userMessage: AgentMessage; assistantMessage: AgentMessage; trace: AgentTraceStep[] }
  | { type: "evidence"; citations: AgentCitation[]; trace: AgentTraceStep[] }
  | { type: "trace"; trace: AgentTraceStep[] }
  | { type: "presentation"; presentations: AgentPresentation[]; stateVersion: number }
  | { type: "delta"; delta: string }
  | { type: "completed"; userMessage: AgentMessage; assistantMessage: AgentMessage; elapsedMs: number }
  | { type: "error"; error: string; interrupted: boolean; partialContent: string; trace: AgentTraceStep[] };

export type AgentThread = {
  id: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  context: AgentEntryContext | null;
};

export type AgentThreadDetail = AgentThread & { messages: AgentMessage[] };

export type AgentIndexStatus = {
  status: "idle" | "running" | "ready" | "failed" | "interrupted";
  phase: "idle" | "preparing" | "embedding" | "cleaning" | "ready" | "failed" | "interrupted";
  total: number;
  processed: number;
  indexed: number;
  skipped: number;
  documents: number;
  documentVersion: number;
  running: boolean;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  heartbeatAt: string | null;
  updatedAt: string;
};

export function fetchAgentCapabilities(): Promise<AgentCapabilitiesResponse> {
  return requestJson<AgentCapabilitiesResponse>("/api/agent/capabilities", { cache: "no-store" });
}

export function fetchAgentChatModels(): Promise<AgentChatModelsResponse> {
  return requestJson<AgentChatModelsResponse>("/api/agent/models", { cache: "no-store" });
}

export function loadAgentChatModel(model: string): Promise<{ model: string; loadedModels: string[] }> {
  return requestJson("/api/agent/models/load", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model })
  });
}

export function fetchAgentThreads(): Promise<{ items: AgentThread[] }> {
  return requestJson<{ items: AgentThread[] }>("/api/agent/threads", { cache: "no-store" });
}

export function fetchAgentMentions(q: string, limit = 16): Promise<{ items: AgentMention[] }> {
  const params = new URLSearchParams({ q, limit: String(limit) });
  return requestJson(`/api/agent/mentions?${params.toString()}`, { cache: "no-store" });
}

export function createAgentThread(context: AgentEntryContext | null = null): Promise<AgentThread> {
  return requestJson<AgentThread>("/api/agent/threads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ context }) });
}

export function fetchAgentThread(id: string): Promise<AgentThreadDetail> {
  return requestJson<AgentThreadDetail>(`/api/agent/threads/${encodeURIComponent(id)}`, { cache: "no-store" });
}

export function deleteAgentThread(id: string): Promise<void> {
  return requestJson<void>(`/api/agent/threads/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function sendAgentMessage(id: string, message: string, model?: string): Promise<{ userMessage: AgentMessage; assistantMessage: AgentMessage }> {
  return requestJson(`/api/agent/threads/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, model })
  });
}

export async function consumeAgentNdjsonStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: AgentStreamEvent) => void
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    onEvent(JSON.parse(line) as AgentStreamEvent);
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
}

export function consumeAgentNdjsonText(
  body: string,
  onEvent: (event: AgentStreamEvent) => void
): void {
  body.split("\n").forEach((line) => {
    if (!line.trim()) return;
    onEvent(JSON.parse(line) as AgentStreamEvent);
  });
}

const AGENT_MESSAGE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Optimistic assistant messages use a prefixed client-only id until the stream
 * is accepted. A failed request can therefore be retried, but it cannot be a
 * regeneration source because the id has never been persisted by the server.
 */
export function normalizeAgentRegenerationMessageId(value?: string): string | undefined {
  const candidate = value?.trim();
  return candidate && AGENT_MESSAGE_UUID_PATTERN.test(candidate) ? candidate : undefined;
}

export async function sendAgentMessageStream(
  id: string,
  message: string,
  options: {
    requestId: string;
    model?: string;
    context?: AgentEntryContext | null;
    baseStateVersion?: number;
    mentions?: AgentMention[];
    composerContext?: AgentComposerContext;
    regenerateFromMessageId?: string;
    signal?: AbortSignal;
    onEvent: (event: AgentStreamEvent) => void;
  }
): Promise<void> {
  const response = await fetch(`/api/agent/threads/${encodeURIComponent(id)}/messages/stream`, {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Agent-Request-Id": options.requestId
    },
    body: JSON.stringify({
      message,
      model: options.model,
      requestId: options.requestId,
      context: options.context,
      baseStateVersion: options.baseStateVersion,
      mentions: options.mentions ?? [],
      composerContext: options.composerContext,
      regenerateFromMessageId: normalizeAgentRegenerationMessageId(options.regenerateFromMessageId)
    }),
    signal: options.signal
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed: ${response.status}`);
  }
  if (response.body && typeof response.body.getReader === "function") {
    await consumeAgentNdjsonStream(response.body, options.onEvent);
    return;
  }

  // Older Android System WebView versions can complete fetch requests but do
  // not expose Response.body as a readable stream. Keep sending functional by
  // consuming the same NDJSON response after it has been buffered.
  consumeAgentNdjsonText(await response.text(), options.onEvent);
}

export function fetchAgentIndexStatus(): Promise<AgentIndexStatus> {
  return requestJson<AgentIndexStatus>("/api/agent/index", { cache: "no-store" });
}

export function startAgentIndex(): Promise<{ started: boolean; status: AgentIndexStatus }> {
  return requestJson("/api/agent/index", { method: "POST" });
}

export function submitAgentFeedback(messageId: string, payload: { mediaId: string; slot?: number; feedbackType: "like" | "not_interested" | "already_watched" | "more_like_this" | "replace" }) {
  return requestJson(`/api/agent/messages/${encodeURIComponent(messageId)}/feedback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}
export function replaceAgentRecommendation(messageId: string, slot: number): Promise<{ citations: AgentCitation[]; presentations: AgentPresentation[]; state: AgentTurnState; stateVersion: number }> {
  return requestJson(`/api/agent/messages/${encodeURIComponent(messageId)}/replace-slot/${slot}`, { method: "POST" });
}
export function confirmAgentAction(id: string): Promise<AgentPendingAction> { return requestJson(`/api/agent/actions/${encodeURIComponent(id)}/confirm`, { method: "POST" }); }
export function cancelAgentAction(id: string): Promise<AgentPendingAction> { return requestJson(`/api/agent/actions/${encodeURIComponent(id)}/cancel`, { method: "POST" }); }
export function fetchAgentPreferences(): Promise<{ items: AgentPreference[] }> { return requestJson("/api/agent/preferences", { cache: "no-store" }); }
export function updateAgentPreference(id: string, patch: { weight?: number; status?: "active" | "muted" }): Promise<AgentPreference> {
  return requestJson(`/api/agent/preferences/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
}
export function deleteAgentPreference(id: string): Promise<void> { return requestJson(`/api/agent/preferences/${encodeURIComponent(id)}`, { method: "DELETE" }); }
export function clearAgentLearning(): Promise<{ preferences: number; feedback: number }> { return requestJson("/api/agent/preferences", { method: "DELETE" }); }
