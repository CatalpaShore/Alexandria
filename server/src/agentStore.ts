import crypto from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";
import { inspectExternalAiStorage } from "./externalAiStorage.js";

let externalDb: Database.Database | null = null;
let externalStorageId: string | null = null;
let lastExternalStorageCheckAt = 0;
const EXTERNAL_STORAGE_RECHECK_MS = 30_000;

function initializeSchema(database: Database.Database): void {
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_threads (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_threads_user_updated
      ON agent_threads(user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      citations_json TEXT NOT NULL DEFAULT '[]',
      presentation_json TEXT NOT NULL DEFAULT 'null',
      trace_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'completed',
      error TEXT,
      request_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES agent_threads(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_agent_messages_thread_created
      ON agent_messages(thread_id, created_at, id);

    CREATE TABLE IF NOT EXISTS agent_documents (
      media_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      embedding BLOB,
      embedding_model TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_documents_embedding_ready
      ON agent_documents(media_id) WHERE embedding IS NOT NULL;

    CREATE TABLE IF NOT EXISTS agent_index_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL DEFAULT 'idle',
      total INTEGER NOT NULL DEFAULT 0,
      indexed INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      started_at TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO agent_index_state (id, updated_at) VALUES (1, datetime('now'));

    CREATE TABLE IF NOT EXISTS agent_turn_states (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      intent TEXT NOT NULL,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES agent_messages(id) ON DELETE CASCADE,
      FOREIGN KEY (thread_id) REFERENCES agent_threads(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_agent_turn_states_thread_version
      ON agent_turn_states(thread_id, version DESC);

    CREATE TABLE IF NOT EXISTS agent_tool_runs (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      result_summary_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      duration_ms INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES agent_messages(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_agent_tool_runs_message
      ON agent_tool_runs(message_id, created_at);

    CREATE TABLE IF NOT EXISTS agent_feedback (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      media_id TEXT NOT NULL,
      slot INTEGER,
      feedback_type TEXT NOT NULL,
      context_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      UNIQUE(user_id, message_id, media_id, feedback_type),
      FOREIGN KEY (message_id) REFERENCES agent_messages(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_agent_feedback_user_media
      ON agent_feedback(user_id, media_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS agent_pending_actions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      preview_json TEXT NOT NULL,
      status TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      result_json TEXT NOT NULL DEFAULT '{}',
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES agent_threads(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_agent_pending_actions_thread
      ON agent_pending_actions(thread_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS agent_preferences (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      dimension TEXT NOT NULL,
      value TEXT NOT NULL,
      weight REAL NOT NULL,
      confidence REAL NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, dimension, value, source)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_preferences_user
      ON agent_preferences(user_id, status, weight DESC);
  `);
  const messageColumns = new Set(
    (database.prepare("PRAGMA table_info(agent_messages)").all() as Array<{ name: string }>).map((column) => column.name)
  );
  if (!messageColumns.has("trace_json")) database.exec("ALTER TABLE agent_messages ADD COLUMN trace_json TEXT NOT NULL DEFAULT '[]'");
  if (!messageColumns.has("presentation_json")) database.exec("ALTER TABLE agent_messages ADD COLUMN presentation_json TEXT NOT NULL DEFAULT 'null'");
  if (!messageColumns.has("status")) database.exec("ALTER TABLE agent_messages ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'");
  if (!messageColumns.has("error")) database.exec("ALTER TABLE agent_messages ADD COLUMN error TEXT");
  if (!messageColumns.has("request_id")) database.exec("ALTER TABLE agent_messages ADD COLUMN request_id TEXT");
  if (!messageColumns.has("presentations_json")) database.exec("ALTER TABLE agent_messages ADD COLUMN presentations_json TEXT NOT NULL DEFAULT '[]'");
  if (!messageColumns.has("state_json")) database.exec("ALTER TABLE agent_messages ADD COLUMN state_json TEXT NOT NULL DEFAULT 'null'");
  if (!messageColumns.has("state_version")) database.exec("ALTER TABLE agent_messages ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0");
  const threadColumns = new Set(
    (database.prepare("PRAGMA table_info(agent_threads)").all() as Array<{ name: string }>).map((column) => column.name)
  );
  if (!threadColumns.has("context_json")) database.exec("ALTER TABLE agent_threads ADD COLUMN context_json TEXT NOT NULL DEFAULT 'null'");
  const documentColumns = new Set(
    (database.prepare("PRAGMA table_info(agent_documents)").all() as Array<{ name: string }>).map((column) => column.name)
  );
  if (!documentColumns.has("document_version")) database.exec("ALTER TABLE agent_documents ADD COLUMN document_version INTEGER NOT NULL DEFAULT 1");
  if (!documentColumns.has("source_updated_at")) database.exec("ALTER TABLE agent_documents ADD COLUMN source_updated_at TEXT NOT NULL DEFAULT ''");
  const indexStateColumns = new Set(
    (database.prepare("PRAGMA table_info(agent_index_state)").all() as Array<{ name: string }>).map((column) => column.name)
  );
  if (!indexStateColumns.has("phase")) database.exec("ALTER TABLE agent_index_state ADD COLUMN phase TEXT NOT NULL DEFAULT 'idle'");
  if (!indexStateColumns.has("processed")) database.exec("ALTER TABLE agent_index_state ADD COLUMN processed INTEGER NOT NULL DEFAULT 0");
  if (!indexStateColumns.has("heartbeat_at")) database.exec("ALTER TABLE agent_index_state ADD COLUMN heartbeat_at TEXT");
  if (!indexStateColumns.has("document_version")) database.exec("ALTER TABLE agent_index_state ADD COLUMN document_version INTEGER NOT NULL DEFAULT 1");
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_messages_request
      ON agent_messages(request_id) WHERE request_id IS NOT NULL;
  `);
  database.prepare(`
    UPDATE agent_messages
    SET status = 'interrupted', error = COALESCE(error, '上次生成因服务重启而中断')
    WHERE status = 'generating'
  `).run();
  const interruptedAt = new Date().toISOString();
  database.prepare(`
    UPDATE agent_index_state
    SET status = 'interrupted', phase = 'interrupted',
      error = COALESCE(error, '上次索引任务因服务重启而中断，可重新触发并从已有向量继续'),
      finished_at = COALESCE(finished_at, ?), updated_at = ?
    WHERE status = 'running'
  `).run(interruptedAt, interruptedAt);
}

export function closeAgentStore(): void {
  if (!externalDb) return;
  try {
    externalDb.close();
  } catch {
    // The drive may already be gone; discard the handle either way.
  }
  externalDb = null;
  externalStorageId = null;
  lastExternalStorageCheckAt = 0;
}

export function getAgentStore(): Database.Database {
  if (externalDb && externalStorageId && Date.now() - lastExternalStorageCheckAt < EXTERNAL_STORAGE_RECHECK_MS) {
    try {
      externalDb.prepare("SELECT 1").get();
      return externalDb;
    } catch {
      closeAgentStore();
    }
  }

  const storage = inspectExternalAiStorage(config.externalAi);
  lastExternalStorageCheckAt = Date.now();
  if (!storage.ready || !storage.storageId) {
    closeAgentStore();
    const error = new Error(storage.message) as Error & { code?: string; status?: number };
    error.code = "AGENT_STORAGE_UNAVAILABLE";
    error.status = 503;
    throw error;
  }

  if (externalDb && externalStorageId === storage.storageId) {
    try {
      externalDb.prepare("SELECT 1").get();
      return externalDb;
    } catch {
      closeAgentStore();
    }
  }
  closeAgentStore();
  const database = new Database(path.join(config.externalAi.root, "agent/db/agent.sqlite"));
  initializeSchema(database);
  externalDb = database;
  externalStorageId = storage.storageId;
  lastExternalStorageCheckAt = Date.now();
  return database;
}

export function createAgentThread(userId: string, title = "新对话", context: unknown = null) {
  const database = getAgentStore();
  const now = new Date().toISOString();
  const thread = { id: crypto.randomUUID(), userId, title, createdAt: now, updatedAt: now };
  database.prepare(`
    INSERT INTO agent_threads (id, user_id, title, context_json, created_at, updated_at)
    VALUES (@id, @userId, @title, @contextJson, @createdAt, @updatedAt)
  `).run({ ...thread, contextJson: JSON.stringify(context) });
  return { ...thread, context };
}

export function listAgentThreads(userId: string) {
  return getAgentStore().prepare(`
    SELECT id, user_id AS userId, title, context_json AS contextJson, created_at AS createdAt, updated_at AS updatedAt
    FROM agent_threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100
  `).all(userId).map((row) => {
    const item = row as Record<string, unknown> & { contextJson: string };
    const { contextJson, ...thread } = item;
    return { ...thread, context: JSON.parse(contextJson || "null") };
  });
}

export function getAgentThread(threadId: string, userId: string) {
  const database = getAgentStore();
  const thread = database.prepare(`
    SELECT id, user_id AS userId, title, context_json AS contextJson, created_at AS createdAt, updated_at AS updatedAt
    FROM agent_threads WHERE id = ? AND user_id = ?
  `).get(threadId, userId);
  if (!thread) return null;
  const messages = database.prepare(`
    SELECT id, role, content, citations_json AS citationsJson, presentation_json AS presentationJson,
      presentations_json AS presentationsJson, state_json AS stateJson, state_version AS stateVersion,
      trace_json AS traceJson, status, error, created_at AS createdAt
    FROM agent_messages WHERE thread_id = ? ORDER BY created_at, rowid
  `).all(threadId) as Array<Record<string, unknown> & {
    citationsJson: string; presentationJson: string; presentationsJson: string; stateJson: string; traceJson: string;
  }>;
  const threadRow = thread as Record<string, unknown> & { contextJson: string };
  const { contextJson, ...threadFields } = threadRow;
  const actionStatuses = new Map(
    (database.prepare("SELECT id, status FROM agent_pending_actions WHERE thread_id = ?").all(threadId) as Array<{ id: string; status: string }>)
      .map((item) => [item.id, item.status])
  );
  const hydrateActionStatus = (presentation: unknown): unknown => {
    if (!presentation || typeof presentation !== "object") return presentation;
    const item = presentation as { kind?: string; actionId?: string; status?: string };
    if (item.kind !== "action-confirmation" || !item.actionId) return presentation;
    return { ...item, status: actionStatuses.get(item.actionId) ?? item.status };
  };
  return {
    ...threadFields,
    context: JSON.parse(contextJson || "null"),
    messages: messages.map(({ citationsJson, presentationJson, presentationsJson, stateJson, traceJson, ...message }) => {
      const presentation = hydrateActionStatus(JSON.parse(presentationJson || "null"));
      const presentations = (JSON.parse(presentationsJson || "[]") as unknown[]).map(hydrateActionStatus);
      return { ...message, citations: JSON.parse(citationsJson || "[]"), presentation, presentations,
        state: JSON.parse(stateJson || "null"), trace: JSON.parse(traceJson || "[]") };
    })
  };
}

export function appendAgentMessage(input: {
  threadId: string;
  role: "user" | "assistant";
  content: string;
  citations?: unknown[];
  presentation?: unknown;
  presentations?: unknown[];
  state?: unknown;
  stateVersion?: number;
  trace?: unknown[];
  status?: "generating" | "completed" | "failed" | "interrupted";
  error?: string | null;
  requestId?: string | null;
}) {
  const database = getAgentStore();
  const createdAt = new Date().toISOString();
  const message = {
    id: crypto.randomUUID(),
    ...input,
    citations: input.citations ?? [],
    presentation: input.presentation ?? null,
    presentations: input.presentations ?? (input.presentation ? [input.presentation] : []),
    state: input.state ?? null,
    stateVersion: input.stateVersion ?? 0,
    trace: input.trace ?? [],
    status: input.status ?? "completed",
    error: input.error ?? null,
    requestId: input.requestId ?? null,
    createdAt
  };
  database.prepare(`
    INSERT INTO agent_messages (
      id, thread_id, role, content, citations_json, presentation_json, presentations_json, state_json, state_version,
      trace_json, status, error, request_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    message.id, input.threadId, input.role, input.content, JSON.stringify(message.citations), JSON.stringify(message.presentation),
    JSON.stringify(message.presentations), JSON.stringify(message.state), message.stateVersion,
    JSON.stringify(message.trace), message.status, message.error, message.requestId, createdAt
  );
  database.prepare("UPDATE agent_threads SET updated_at = ? WHERE id = ?").run(createdAt, input.threadId);
  const { threadId: _threadId, requestId: _requestId, ...result } = message;
  return result;
}

export function appendAgentExchange(input: {
  threadId: string;
  userContent: string;
  assistantContent: string;
  citations?: unknown[];
  presentation?: unknown;
  presentations?: unknown[];
  state?: unknown;
  stateVersion?: number;
}) {
  const database = getAgentStore();
  return database.transaction(() => {
    const userMessage = appendAgentMessage({ threadId: input.threadId, role: "user", content: input.userContent });
    const assistantMessage = appendAgentMessage({
      threadId: input.threadId,
      role: "assistant",
      content: input.assistantContent,
      citations: input.citations,
      presentation: input.presentation,
      presentations: input.presentations,
      state: input.state,
      stateVersion: input.stateVersion
    });
    return { userMessage, assistantMessage };
  })();
}

export function beginAgentExchange(input: {
  threadId: string;
  userContent: string;
  requestId: string;
}) {
  const database = getAgentStore();
  return database.transaction(() => {
    const userMessage = appendAgentMessage({
      threadId: input.threadId,
      role: "user",
      content: input.userContent,
      requestId: `${input.requestId}:user`
    });
    const assistantMessage = appendAgentMessage({
      threadId: input.threadId,
      role: "assistant",
      content: "",
      status: "generating",
      requestId: `${input.requestId}:assistant`
    });
    return { userMessage, assistantMessage };
  })();
}

export function completeAgentMessage(input: {
  messageId: string;
  content: string;
  citations: unknown[];
  presentation?: unknown;
  presentations?: unknown[];
  state?: unknown;
  stateVersion?: number;
  trace: unknown[];
}) {
  const database = getAgentStore();
  const updatedAt = new Date().toISOString();
  database.prepare(`
    UPDATE agent_messages
    SET content = ?, citations_json = ?, presentation_json = ?, presentations_json = ?, state_json = ?, state_version = ?,
      trace_json = ?, status = 'completed', error = NULL
    WHERE id = ? AND role = 'assistant'
  `).run(
    input.content,
    JSON.stringify(input.citations),
    JSON.stringify(input.presentation ?? input.presentations?.[0] ?? null),
    JSON.stringify(input.presentations ?? (input.presentation ? [input.presentation] : [])),
    JSON.stringify(input.state ?? null),
    input.stateVersion ?? 0,
    JSON.stringify(input.trace),
    input.messageId
  );
  const row = database.prepare(`
    SELECT id, role, content, citations_json AS citationsJson, presentation_json AS presentationJson,
      presentations_json AS presentationsJson, state_json AS stateJson, state_version AS stateVersion,
      trace_json AS traceJson, status, error, created_at AS createdAt
    FROM agent_messages WHERE id = ?
  `).get(input.messageId) as Record<string, unknown> & {
    citationsJson: string; presentationJson: string; presentationsJson: string; stateJson: string; traceJson: string;
  };
  database.prepare(`
    UPDATE agent_threads SET updated_at = ?
    WHERE id = (SELECT thread_id FROM agent_messages WHERE id = ?)
  `).run(updatedAt, input.messageId);
  const { citationsJson, presentationJson, presentationsJson, stateJson, traceJson, ...message } = row;
  return {
    ...message,
    citations: JSON.parse(citationsJson || "[]"),
    presentation: JSON.parse(presentationJson || "null"),
    presentations: JSON.parse(presentationsJson || "[]"),
    state: JSON.parse(stateJson || "null"),
    trace: JSON.parse(traceJson || "[]")
  };
}

export function failAgentMessage(input: {
  messageId: string;
  content?: string;
  trace?: unknown[];
  error: string;
  interrupted?: boolean;
}): void {
  getAgentStore().prepare(`
    UPDATE agent_messages
    SET content = ?, trace_json = ?, status = ?, error = ?
    WHERE id = ? AND role = 'assistant'
  `).run(
    input.content ?? "",
    JSON.stringify(input.trace ?? []),
    input.interrupted ? "interrupted" : "failed",
    input.error,
    input.messageId
  );
}

export function renameAgentThreadFromFirstMessage(threadId: string, content: string): void {
  const title = content.replace(/\s+/g, " ").trim().slice(0, 32) || "新对话";
  getAgentStore().prepare("UPDATE agent_threads SET title = ? WHERE id = ? AND title = '新对话'").run(title, threadId);
}

export function deleteAgentThread(threadId: string, userId: string): boolean {
  return getAgentStore().prepare("DELETE FROM agent_threads WHERE id = ? AND user_id = ?").run(threadId, userId).changes > 0;
}

export function saveAgentTurnState(input: {
  messageId: string;
  threadId: string;
  version: number;
  intent: string;
  state: unknown;
}): void {
  getAgentStore().prepare(`
    INSERT INTO agent_turn_states (message_id, thread_id, version, intent, state_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET version = excluded.version, intent = excluded.intent,
      state_json = excluded.state_json
  `).run(input.messageId, input.threadId, input.version, input.intent, JSON.stringify(input.state), new Date().toISOString());
}

export function getLatestAgentTurnState(threadId: string): { version: number; intent: string; state: unknown } | null {
  const row = getAgentStore().prepare(`
    SELECT version, intent, state_json AS stateJson
    FROM agent_turn_states WHERE thread_id = ? ORDER BY version DESC, created_at DESC LIMIT 1
  `).get(threadId) as { version: number; intent: string; stateJson: string } | undefined;
  return row ? { version: row.version, intent: row.intent, state: JSON.parse(row.stateJson || "null") } : null;
}

export function recordAgentToolRun(input: {
  id?: string;
  messageId: string;
  toolName: string;
  arguments: unknown;
  resultSummary?: unknown;
  status: "running" | "completed" | "failed" | "interrupted";
  durationMs?: number | null;
}): string {
  const id = input.id ?? crypto.randomUUID();
  getAgentStore().prepare(`
    INSERT INTO agent_tool_runs (
      id, message_id, tool_name, arguments_json, result_summary_json, status, duration_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET result_summary_json = excluded.result_summary_json,
      status = excluded.status, duration_ms = excluded.duration_ms
  `).run(
    id,
    input.messageId,
    input.toolName,
    JSON.stringify(input.arguments),
    JSON.stringify(input.resultSummary ?? {}),
    input.status,
    input.durationMs ?? null,
    new Date().toISOString()
  );
  return id;
}
