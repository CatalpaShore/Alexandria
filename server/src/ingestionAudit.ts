import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getLibraryRoots } from "./config.js";
import {
  ingestionCompletionSchema,
  type IngestionCompletionContract
} from "./contracts/platform.js";
import { db } from "./db.js";

export type CompletionStageStatus = IngestionCompletionContract["overallStatus"];
export type CompletionStage = IngestionCompletionContract["stages"]["file"];
export type IngestionCompletion = IngestionCompletionContract;

type CompletionSource = {
  itemStatus?: string | null;
  mediaId?: string | null;
  mediaExists?: number | null;
  thumbnailStatus?: string | null;
  metadataStatus?: string | null;
  metadataError?: string | null;
  translationStatus?: string | null;
  translationError?: string | null;
  coverUrl?: string | null;
  thumbUrl?: string | null;
  posterReady?: number | null;
};

export type IngestionAuditItem = {
  id: string;
  runId: string;
  sourceId: string;
  originalPath: string;
  originalName: string;
  normalizedName: string;
  normalizedCode: string;
  category: string;
  targetPath: string;
  mediaId: string | null;
  size: number;
  status: string;
  metadataStatus: string;
  translationStatus: string;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  completion: IngestionCompletion;
  rollback: {
    status: string;
    reason: string | null;
    createdAt: string | null;
    completedAt: string | null;
  } | null;
};

export type RollbackResult = {
  itemId: string;
  runId: string;
  normalizedCode: string;
  status: "succeeded" | "refused" | "failed" | "already_rolled_back";
  reason: string;
  fromPath: string;
  toPath: string;
  mediaId: string | null;
};

type AuditItemRow = Omit<IngestionAuditItem, "completion" | "rollback"> & CompletionSource & {
  rollbackStatus: string | null;
  rollbackReason: string | null;
  rollbackCreatedAt: string | null;
  rollbackCompletedAt: string | null;
};

type RollbackItemRow = {
  id: string;
  runId: string;
  sourceId: string;
  originalPath: string;
  targetPath: string;
  normalizedCode: string;
  status: string;
  mediaId: string | null;
  mediaAbsolutePath: string | null;
  downloadRoot: string;
  libraryRootIndex: number;
};

db.exec(`
  CREATE TABLE IF NOT EXISTS ingestion_rollback_audit (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'item',
    status TEXT NOT NULL,
    from_path TEXT NOT NULL,
    to_path TEXT NOT NULL,
    media_id TEXT,
    normalized_code TEXT NOT NULL DEFAULT '',
    reason TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY (run_id) REFERENCES ingestion_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (item_id) REFERENCES ingestion_items(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_ingestion_rollback_item
    ON ingestion_rollback_audit(item_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ingestion_rollback_run
    ON ingestion_rollback_audit(run_id, created_at DESC);
`);

function stage(status: CompletionStageStatus, label: string, detail: string): CompletionStage {
  return { status, label, detail };
}

function normalizePipelineStatus(value: string | null | undefined): string {
  return String(value ?? "pending").trim().toLowerCase();
}

export function buildIngestionCompletion(source: CompletionSource): IngestionCompletion {
  const itemStatus = normalizePipelineStatus(source.itemStatus);
  const metadataStatus = normalizePipelineStatus(source.metadataStatus);
  const translationStatus = normalizePipelineStatus(source.translationStatus);
  const thumbnailStatus = normalizePipelineStatus(source.thumbnailStatus);
  const mediaReady = Boolean(source.mediaId && source.mediaExists);
  const processingStopped = ["rejected", "rolled_back"].includes(itemStatus);

  let file = stage("processing", "文件", "等待媒体库建立索引");
  if (itemStatus === "rolled_back") {
    file = stage("ready", "文件", "文件已安全回滚到下载目录");
  } else if (["failed", "conflict", "rejected"].includes(itemStatus)) {
    const details: Record<string, string> = {
      failed: "文件移动失败",
      conflict: "目标位置存在同名文件",
      rejected: "文件未通过番号识别规则",
      rolled_back: "文件已回滚到下载目录"
    };
    file = stage("attention", "文件", details[itemStatus] ?? "文件需要处理");
  } else if (mediaReady) {
    file = stage("ready", "文件", "文件已索引");
  } else if (itemStatus === "waiting") {
    file = stage("processing", "文件", "等待文件稳定后入库");
  }

  let metadata = processingStopped
    ? stage("ready", "元数据", "文件已退出入库流程")
    : stage("processing", "元数据", "等待抓取元数据");
  if (metadataStatus === "ready") {
    metadata = stage("ready", "元数据", "元数据已就绪");
  } else if (["not_found", "failed"].includes(metadataStatus)) {
    metadata = stage(
      "attention",
      "元数据",
      source.metadataError || (metadataStatus === "not_found" ? "未找到匹配的元数据" : "元数据抓取失败")
    );
  } else if (metadataStatus === "fetching") {
    metadata = stage("processing", "元数据", "正在抓取元数据");
  }

  let translation = processingStopped
    ? stage("ready", "翻译", "文件已退出入库流程")
    : stage("processing", "翻译", metadataStatus === "ready" ? "等待生成中文翻译" : "等待元数据后开始翻译");
  if (["ready", "skipped"].includes(translationStatus)) {
    translation = stage("ready", "翻译", translationStatus === "skipped" ? "无需翻译" : "中文翻译已就绪");
  } else if (["failed", "error"].includes(translationStatus)) {
    translation = stage("attention", "翻译", source.translationError || "中文翻译失败");
  } else if (translationStatus === "translating" || translationStatus === "fetching") {
    translation = stage("processing", "翻译", "正在生成中文信息");
  } else if (["not_found", "failed"].includes(metadataStatus)) {
    translation = stage("attention", "翻译", "元数据未就绪，暂时无法翻译");
  }

  const hasRemoteCover = Boolean(String(source.coverUrl ?? "").trim() || String(source.thumbUrl ?? "").trim());
  const hasCover = hasRemoteCover || Boolean(source.posterReady) || thumbnailStatus === "ready";
  let cover = processingStopped
    ? stage("ready", "封面", "文件已退出入库流程")
    : stage("processing", "封面", "等待生成或缓存封面");
  if (hasCover) {
    cover = stage("ready", "封面", hasRemoteCover ? "元数据封面已就绪" : "视频截图封面已就绪");
  } else if (metadataStatus === "ready" && ["failed", "unsupported"].includes(thumbnailStatus)) {
    cover = stage("attention", "封面", "未获取到元数据封面，截图封面生成失败");
  } else if (["not_found", "failed"].includes(metadataStatus) && ["failed", "unsupported"].includes(thumbnailStatus)) {
    cover = stage("attention", "封面", "元数据与截图封面均不可用");
  }

  const stages = { file, metadata, translation, cover };
  const stageValues = Object.values(stages);
  const overallStatus: CompletionStageStatus = stageValues.some((item) => item.status === "attention")
    ? "attention"
    : stageValues.some((item) => item.status === "processing")
      ? "processing"
      : "ready";
  const unresolved = stageValues.filter((item) => item.status === overallStatus).map((item) => item.detail);
  const reason = overallStatus === "ready"
    ? "文件、元数据、翻译和封面均已就绪"
    : unresolved.join("；");

  return ingestionCompletionSchema.parse({ overallStatus, reason, stages });
}

const completionSelect = `
  items.status AS itemStatus,
  media.id AS mediaId,
  CASE WHEN media.id IS NULL THEN 0 ELSE 1 END AS mediaExists,
  media.thumbnail_status AS thumbnailStatus,
  COALESCE(metadata.status, items.metadata_status, 'pending') AS metadataStatus,
  metadata.error AS metadataError,
  COALESCE(metadata.translation_status, items.translation_status, 'pending') AS translationStatus,
  metadata.translation_error AS translationError,
  metadata.cover_url AS coverUrl,
  metadata.thumb_url AS thumbUrl,
  CASE WHEN EXISTS (
    SELECT 1 FROM media_derivatives derivative
    WHERE derivative.media_id = media.id AND derivative.kind = 'poster' AND derivative.status = 'ready'
  ) THEN 1 ELSE 0 END AS posterReady
`;

export function getIngestionRunAudit(runId: string): { items: IngestionAuditItem[]; rollbackSummary: Record<string, number> } {
  const rows = db.prepare(`
    SELECT items.id, items.run_id AS runId, items.source_id AS sourceId,
      items.original_path AS originalPath, items.original_name AS originalName,
      items.normalized_name AS normalizedName, items.normalized_code AS normalizedCode,
      items.category, items.target_path AS targetPath, items.size, items.status,
      items.metadata_status AS storedMetadataStatus,
      items.translation_status AS storedTranslationStatus,
      items.reason, items.created_at AS createdAt, items.updated_at AS updatedAt,
      ${completionSelect},
      rollback.status AS rollbackStatus, rollback.reason AS rollbackReason,
      rollback.created_at AS rollbackCreatedAt, rollback.completed_at AS rollbackCompletedAt
    FROM ingestion_items items
    LEFT JOIN media_files media ON media.id = COALESCE(
      items.media_id,
      (SELECT candidate.id FROM media_files candidate WHERE candidate.absolute_path = items.target_path LIMIT 1)
    )
    LEFT JOIN media_metadata metadata ON metadata.normalized_code = items.normalized_code
    LEFT JOIN ingestion_rollback_audit rollback ON rollback.id = (
      SELECT latest.id FROM ingestion_rollback_audit latest
      WHERE latest.item_id = items.id ORDER BY latest.created_at DESC LIMIT 1
    )
    WHERE items.run_id = ?
    ORDER BY items.created_at, items.id
  `).all(runId) as Array<AuditItemRow & { storedMetadataStatus: string; storedTranslationStatus: string }>;

  const items = rows.map((row) => ({
    id: row.id,
    runId: row.runId,
    sourceId: row.sourceId,
    originalPath: row.originalPath,
    originalName: row.originalName,
    normalizedName: row.normalizedName,
    normalizedCode: row.normalizedCode,
    category: row.category,
    targetPath: row.targetPath,
    mediaId: row.mediaId,
    size: row.size,
    status: row.status,
    metadataStatus: row.metadataStatus ?? row.storedMetadataStatus,
    translationStatus: row.translationStatus ?? row.storedTranslationStatus,
    reason: row.reason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completion: buildIngestionCompletion(row),
    rollback: row.rollbackStatus ? {
      status: row.rollbackStatus,
      reason: row.rollbackReason,
      createdAt: row.rollbackCreatedAt,
      completedAt: row.rollbackCompletedAt
    } : null
  }));

  const rollbackSummary = items.reduce<Record<string, number>>((summary, item) => {
    const status = item.rollback?.status ?? (item.status === "rolled_back" ? "succeeded" : "not_started");
    summary[status] = (summary[status] ?? 0) + 1;
    return summary;
  }, {});
  return { items, rollbackSummary };
}

export function getCompletionForCodes(codes: string[]): Map<string, IngestionCompletion> {
  const uniqueCodes = [...new Set(codes.filter(Boolean))];
  if (uniqueCodes.length === 0) return new Map();
  const requestedValues = uniqueCodes.map(() => "(?)").join(", ");
  const rows = db.prepare(`
    WITH requested(normalizedCode) AS (VALUES ${requestedValues})
    SELECT requested.normalizedCode, ${completionSelect}
    FROM requested
    LEFT JOIN ingestion_items items ON items.id = (
      SELECT latest.id FROM ingestion_items latest
      WHERE latest.normalized_code = requested.normalizedCode
      ORDER BY CASE latest.status WHEN 'moved' THEN 0 WHEN 'rolled_back' THEN 2 ELSE 1 END,
        latest.created_at DESC, latest.id DESC LIMIT 1
    )
    LEFT JOIN media_files media ON media.id = (
      SELECT candidate.id FROM media_files candidate
      WHERE candidate.normalized_code = requested.normalizedCode
      ORDER BY candidate.mtime_ms DESC, candidate.id LIMIT 1
    )
    LEFT JOIN media_metadata metadata ON metadata.normalized_code = requested.normalizedCode
  `).all(...uniqueCodes) as Array<CompletionSource & { normalizedCode: string }>;
  return new Map(rows.map((row) => [row.normalizedCode, buildIngestionCompletion(row)]));
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.lstat(candidate);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code !== "ENOENT");
  }
}

function readRollbackItem(itemId: string): RollbackItemRow | null {
  return (db.prepare(`
    SELECT items.id, items.run_id AS runId, items.source_id AS sourceId,
      items.original_path AS originalPath, items.target_path AS targetPath,
      items.normalized_code AS normalizedCode, items.status, items.media_id AS mediaId,
      media.absolute_path AS mediaAbsolutePath,
      sources.download_root AS downloadRoot, sources.library_root_index AS libraryRootIndex
    FROM ingestion_items items
    JOIN ingestion_sources sources ON sources.id = items.source_id
    LEFT JOIN media_files media ON media.id = COALESCE(
      items.media_id,
      (SELECT candidate.id FROM media_files candidate WHERE candidate.absolute_path = items.target_path LIMIT 1)
    )
    WHERE items.id = ?
  `).get(itemId) as RollbackItemRow | undefined) ?? null;
}

function createRollbackAudit(item: RollbackItemRow, scope: "item" | "run", fromPath: string): string {
  const auditId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO ingestion_rollback_audit (
      id, run_id, item_id, scope, status, from_path, to_path,
      media_id, normalized_code, created_at
    ) VALUES (?, ?, ?, ?, 'processing', ?, ?, ?, ?, ?)
  `).run(
    auditId, item.runId, item.id, scope, fromPath, item.originalPath,
    item.mediaId, item.normalizedCode, new Date().toISOString()
  );
  return auditId;
}

function finishRollbackAudit(auditId: string, status: string, reason: string): void {
  db.prepare(`
    UPDATE ingestion_rollback_audit
    SET status = ?, reason = ?, completed_at = ? WHERE id = ?
  `).run(status, reason, new Date().toISOString(), auditId);
}

const rollbackLocks = new Set<string>();

export async function rollbackIngestionItem(
  itemId: string,
  scope: "item" | "run" = "item"
): Promise<RollbackResult> {
  const item = readRollbackItem(itemId);
  if (!item) {
    return {
      itemId,
      runId: "",
      normalizedCode: "",
      status: "refused",
      reason: "未找到入库记录",
      fromPath: "",
      toPath: "",
      mediaId: null
    };
  }

  const fromPath = item.mediaAbsolutePath || item.targetPath;
  const baseResult = {
    itemId: item.id,
    runId: item.runId,
    normalizedCode: item.normalizedCode,
    fromPath,
    toPath: item.originalPath,
    mediaId: item.mediaId
  };
  if (item.status === "rolled_back") {
    return { ...baseResult, status: "already_rolled_back", reason: "该文件已经回滚" };
  }
  if (item.status !== "moved") {
    return { ...baseResult, status: "refused", reason: `当前状态为 ${item.status}，没有可回滚的已移动文件` };
  }
  if (rollbackLocks.has(item.id)) {
    return { ...baseResult, status: "refused", reason: "该文件正在执行回滚" };
  }

  const auditId = createRollbackAudit(item, scope, fromPath);
  rollbackLocks.add(item.id);
  try {
    const libraryRoot = getLibraryRoots().roots[item.libraryRootIndex] ?? "";
    if (!libraryRoot || !isInside(libraryRoot, fromPath)) {
      const reason = "源文件不在当前配置的媒体库路径中，已拒绝回滚";
      finishRollbackAudit(auditId, "refused", reason);
      return { ...baseResult, status: "refused", reason };
    }
    if (!isInside(item.downloadRoot, item.originalPath)) {
      const reason = "原路径不在对应下载目录中，已拒绝回滚";
      finishRollbackAudit(auditId, "refused", reason);
      return { ...baseResult, status: "refused", reason };
    }
    if (!await pathExists(fromPath)) {
      const reason = "媒体库中的源文件不存在，未执行任何文件操作";
      finishRollbackAudit(auditId, "refused", reason);
      return { ...baseResult, status: "refused", reason };
    }
    if (await pathExists(item.originalPath)) {
      const reason = "原下载路径已存在文件，为避免覆盖已拒绝回滚";
      finishRollbackAudit(auditId, "refused", reason);
      return { ...baseResult, status: "refused", reason };
    }

    await fs.mkdir(path.dirname(item.originalPath), { recursive: true });
    await fs.rename(fromPath, item.originalPath);

    try {
      const now = new Date().toISOString();
      db.transaction(() => {
        const media = db.prepare(`
          SELECT id FROM media_files WHERE id = ? OR absolute_path = ? LIMIT 1
        `).get(item.mediaId, fromPath) as { id: string } | undefined;
        if (media) {
          db.prepare("DELETE FROM media_search_fts WHERE media_id = ?").run(media.id);
          db.prepare("DELETE FROM media_files WHERE id = ?").run(media.id);
        }
        db.prepare(`
          UPDATE ingestion_items
          SET status = 'rolled_back', reason = '已安全回滚到原下载目录', updated_at = ?
          WHERE id = ?
        `).run(now, item.id);
        db.prepare(`
          DELETE FROM ingestion_history
          WHERE normalized_code = ?
            AND NOT EXISTS (
              SELECT 1 FROM media_files WHERE normalized_code = ?
            )
        `).run(item.normalizedCode, item.normalizedCode);
        db.prepare(`
          UPDATE ingestion_rollback_audit
          SET status = 'succeeded', reason = '文件已移回原下载路径', completed_at = ?
          WHERE id = ?
        `).run(now, auditId);
      })();
    } catch (databaseError) {
      try {
        await fs.rename(item.originalPath, fromPath);
      } catch (restoreError) {
        const databaseReason = databaseError instanceof Error ? databaseError.message : "数据库更新失败";
        const restoreReason = restoreError instanceof Error ? restoreError.message : "文件恢复失败";
        const reason = `${databaseReason}；文件已移动到原下载路径，但恢复媒体库位置失败：${restoreReason}`;
        finishRollbackAudit(auditId, "failed", reason);
        return { ...baseResult, status: "failed", reason };
      }
      const reason = `${databaseError instanceof Error ? databaseError.message : "数据库更新失败"}；文件已恢复到媒体库原位`;
      finishRollbackAudit(auditId, "failed", reason);
      return { ...baseResult, status: "failed", reason };
    }
    return { ...baseResult, status: "succeeded", reason: "文件已移回原下载路径" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "回滚失败";
    finishRollbackAudit(auditId, "failed", reason);
    return { ...baseResult, status: "failed", reason };
  } finally {
    rollbackLocks.delete(item.id);
  }
}

export async function rollbackIngestionRun(runId: string): Promise<{
  runId: string;
  results: RollbackResult[];
  summary: Record<string, number>;
}> {
  const itemIds = (db.prepare(`
    SELECT id FROM ingestion_items
    WHERE run_id = ? AND status = 'moved'
    ORDER BY created_at DESC, id DESC
  `).all(runId) as Array<{ id: string }>).map((row) => row.id);
  const results: RollbackResult[] = [];
  for (const itemId of itemIds) {
    results.push(await rollbackIngestionItem(itemId, "run"));
  }
  const summary = results.reduce<Record<string, number>>((counts, result) => {
    counts[result.status] = (counts[result.status] ?? 0) + 1;
    return counts;
  }, {});
  return { runId, results, summary };
}
