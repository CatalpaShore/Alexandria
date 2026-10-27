import fs from "node:fs/promises";
import path from "node:path";
import { config, getLibraryRoots } from "../server/src/config.js";
import { db } from "../server/src/db.js";
import {
  getIngestionFilenameRisk,
  normalizeIngestionFilename,
  type IngestionFilenameRisk
} from "../server/src/ingestionFiles.js";

type IngestionRow = {
  id: string;
  sourceId: string;
  originalPath: string;
  originalName: string;
  normalizedCode: string;
  targetPath: string;
  size: number;
};

type SourceRow = {
  id: string;
  downloadRoot: string;
  libraryRootIndex: number;
};

type AuditRow = IngestionRow & {
  risk: IngestionFilenameRisk | "invalid-code-boundary";
  action: "rollback" | "skip" | "rolled_back" | "failed";
  detail: string;
};

const args = process.argv.slice(2);
const readArg = (name: string): string => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? "" : "";
};
const runId = readArg("--run-id");
const execute = args.includes("--execute");
if (!runId) throw new Error("Usage: tsx scripts/rollback-ingestion-misclassifications.ts --run-id <id> [--execute]");

function isWithin(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

async function fileState(filePath: string): Promise<{ exists: boolean; size: number }> {
  try {
    const stat = await fs.stat(filePath);
    return { exists: stat.isFile(), size: stat.size };
  } catch {
    return { exists: false, size: 0 };
  }
}

const sourceRows = db.prepare(`
  SELECT id, download_root AS downloadRoot, library_root_index AS libraryRootIndex
  FROM ingestion_sources
`).all() as SourceRow[];
const sources = new Map(sourceRows.map((source) => [source.id, source]));
const libraryRoots = getLibraryRoots().roots;
const rows = db.prepare(`
  SELECT id, source_id AS sourceId, original_path AS originalPath,
    original_name AS originalName, normalized_code AS normalizedCode,
    target_path AS targetPath, size
  FROM ingestion_items
  WHERE run_id = ? AND status = 'moved'
  ORDER BY created_at, normalized_code
`).all(runId) as IngestionRow[];

const knownPrefixes = new Set(
  (db.prepare("SELECT DISTINCT code_prefix AS prefix FROM media_files WHERE code_prefix != ''").all() as Array<{ prefix: string }>)
    .map((row) => row.prefix.toUpperCase())
);
const candidates = rows.flatMap((row) => {
  const risk = getIngestionFilenameRisk(row.originalName, row.normalizedCode)
    ?? (normalizeIngestionFilename(row.originalName, knownPrefixes) ? null : "invalid-code-boundary");
  return risk ? [{ ...row, risk }] : [];
});
const audit: AuditRow[] = [];
let rolledBack = 0;

for (const row of candidates) {
  const source = sources.get(row.sourceId);
  const libraryRoot = source ? libraryRoots[source.libraryRootIndex] : "";
  const target = await fileState(row.targetPath);
  const original = await fileState(row.originalPath);
  let detail = "ready";
  if (!source || !libraryRoot) detail = "unknown ingestion source";
  else if (!isWithin(source.downloadRoot, row.originalPath)) detail = "original path is outside download root";
  else if (!isWithin(libraryRoot, row.targetPath)) detail = "target path is outside library root";
  else if (!target.exists) detail = "target file is missing";
  else if (original.exists) detail = "original path already exists";
  else if (target.size !== row.size) detail = `target size changed: expected=${row.size} actual=${target.size}`;

  if (detail !== "ready") {
    audit.push({ ...row, action: "skip", detail });
    continue;
  }
  if (!execute) {
    audit.push({ ...row, action: "rollback", detail });
    continue;
  }

  try {
    await fs.mkdir(path.dirname(row.originalPath), { recursive: true });
    await fs.rename(row.targetPath, row.originalPath);
    try {
      const notification = db.prepare(`
        SELECT created_at AS createdAt FROM ingestion_notifications WHERE item_id = ? LIMIT 1
      `).get(row.id) as { createdAt: string } | undefined;
      db.transaction(() => {
        db.prepare("DELETE FROM ingestion_notifications WHERE item_id = ?").run(row.id);
        if (notification) {
          db.prepare(`
            DELETE FROM ingestion_history
            WHERE normalized_code = ? AND ingested_at = ? AND source = 'automatic'
          `).run(row.normalizedCode, notification.createdAt);
        }
        db.prepare(`
          UPDATE ingestion_items
          SET status = 'rolled_back', media_id = NULL,
            metadata_status = 'skipped', translation_status = 'skipped',
            next_retry_at = NULL, reason = ?, updated_at = ?
          WHERE id = ? AND status = 'moved'
        `).run(`误识别回滚：${row.risk}`, new Date().toISOString(), row.id);
      })();
    } catch (error) {
      await fs.rename(row.originalPath, row.targetPath);
      throw error;
    }
    rolledBack += 1;
    audit.push({ ...row, action: "rolled_back", detail: "restored original path" });
  } catch (error) {
    audit.push({
      ...row,
      action: "failed",
      detail: error instanceof Error ? error.message : "rollback failed"
    });
  }
}

if (execute && rolledBack > 0) {
  const run = db.prepare("SELECT stats_json AS statsJson FROM ingestion_runs WHERE id = ?").get(runId) as { statsJson: string } | undefined;
  const stats = JSON.parse(run?.statsJson || "{}") as Record<string, unknown>;
  stats.rolledBack = Number(stats.rolledBack ?? 0) + rolledBack;
  db.prepare(`
    UPDATE ingestion_runs SET status = 'partial', stats_json = ?,
      error = COALESCE(error, '部分误识别文件已回滚'), updated_at = ?
    WHERE id = ?
  `).run(JSON.stringify(stats), new Date().toISOString(), runId);
}

await fs.mkdir(config.metadataExportDir, { recursive: true });
const mode = execute ? "executed" : "preview";
const baseOutputPath = path.join(config.metadataExportDir, `ingestion-rollback-${runId}-${mode}.json`);
let outputPath = baseOutputPath;
try {
  await fs.access(baseOutputPath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  outputPath = path.join(config.metadataExportDir, `ingestion-rollback-${runId}-${mode}-${timestamp}.json`);
} catch {
  // The stable filename is available for the first audit pass.
}
await fs.writeFile(outputPath, `${JSON.stringify({ runId, execute, candidates: candidates.length, rolledBack, audit }, null, 2)}\n`);

const summary = audit.reduce<Record<string, number>>((counts, row) => {
  counts[row.action] = (counts[row.action] ?? 0) + 1;
  return counts;
}, {});
console.log(JSON.stringify({
  runId,
  execute,
  candidates: candidates.length,
  rolledBack,
  summary,
  outputPath,
  nextStep: execute && rolledBack > 0
    ? "触发媒体扫描后，清理没有任何 media_files 关联的孤立元数据"
    : undefined
}, null, 2));
