import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Express } from "express";
import { z } from "zod";
import { db, type MediaRow } from "./db.js";
import { config } from "./config.js";
import { getActiveUserProfile } from "./userProfiles.js";
import { inspectExternalAiStorage } from "./externalAiStorage.js";
import { ensureInsideMediaRoot, streamFile } from "./services/fileStreaming.js";
import { enqueueMediaJob, registerMediaJobHandler, registerMediaJobIdleRefillHandler } from "./mediaJobs.js";
import { trackFfmpegProcess } from "./ffmpegProcesses.js";
import { withMediaWorkerFfmpegLimits } from "./ffmpegResources.js";
import { probeMediaFile } from "./mediaProbe.js";

type Highlight = {
  id: string; user_id: string; media_id: string; title: string; source_title: string;
  start: number; end: number; status: string; error: string | null; source_size: number;
  source_mtime: number; created_at: string; updated_at: string; attempts: number;
  retry_after: string | null; error_code: string | null; progress: number;
};
const MAX_ATTEMPTS = 3;
const activeStatuses = "'pending','processing','waiting','retrying'";
class ClipError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export const highlightInput = z.object({
  mediaId: z.string().min(1).max(100), title: z.string().trim().min(1).max(100),
  start: z.number().finite().min(0), end: z.number().finite().positive()
}).refine(v => v.end - v.start >= 1 && v.end - v.start <= 1800, "片段时长须在 1 秒到 30 分钟之间");
db.exec(`CREATE TABLE IF NOT EXISTS media_highlights (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, media_id TEXT NOT NULL,
 title TEXT NOT NULL, source_title TEXT NOT NULL, start REAL NOT NULL, end REAL NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', error TEXT, source_size INTEGER NOT NULL, source_mtime REAL NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
); CREATE INDEX IF NOT EXISTS idx_media_highlights_user ON media_highlights(user_id,created_at);
CREATE INDEX IF NOT EXISTS idx_media_highlights_work ON media_highlights(media_id,status);`);
db.transaction(() => {
  const columns = new Set((db.prepare("PRAGMA table_info(media_highlights)").all() as {name: string}[]).map(c => c.name));
  for (const [name, definition] of Object.entries({ attempts: "INTEGER NOT NULL DEFAULT 0", retry_after: "TEXT", error_code: "TEXT", progress: "REAL NOT NULL DEFAULT 0" })) {
    if (!columns.has(name)) db.exec(`ALTER TABLE media_highlights ADD COLUMN ${name} ${definition}`);
  }
}).immediate();
export function highlightStorage(): string {
  if (!inspectExternalAiStorage({ ...config.externalAi, enabled: true }).ready) {
    throw Object.assign(new ClipError("STORAGE_UNAVAILABLE", "高光存储硬盘不可用，连接后将自动恢复"), { status: 503 });
  }
  const root = path.join(config.externalAi.root, "highlights");
  if (fs.existsSync(root) && fs.realpathSync(root) !== path.join(fs.realpathSync(config.externalAi.root), "highlights")) throw new ClipError("STORAGE_UNAVAILABLE", "高光存储路径异常");
  return root;
}
function fileFor(id: string, suffix = ".mp4"): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("无效的片段编号");
  const file = path.join(highlightStorage(), `${id}${suffix}`);
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error("片段文件路径异常");
  return file;
}
function owned(id: string): Highlight | undefined {
  return db.prepare("SELECT * FROM media_highlights WHERE id=? AND user_id=?").get(id, getActiveUserProfile().id) as Highlight | undefined;
}
function work(mediaId: string): void { enqueueMediaJob(mediaId, "highlight", { priority: 120 }); }
function update(id: string, status: string, error: string | null = null, code: string | null = null, after: string | null = null): void {
  db.prepare("UPDATE media_highlights SET status=?,error=?,error_code=?,retry_after=?,updated_at=? WHERE id=?")
    .run(status, error, code, after, new Date().toISOString(), id);
}
function sqliteBusy(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && String(error.code).startsWith("SQLITE_BUSY"));
}
export function recordHighlightProgress(id: string, progress: number): void {
  try {
    db.prepare("UPDATE media_highlights SET progress=?,updated_at=? WHERE id=?").run(progress, new Date().toISOString(), id);
  } catch (error) {
    // Progress is advisory. A concurrent scan must not kill the encoder process.
    if (!sqliteBusy(error)) throw error;
  }
}
async function publishReady(id: string): Promise<void> {
  for (;;) {
    try {
      db.prepare("UPDATE media_highlights SET status='ready',progress=100,error=NULL,error_code=NULL,retry_after=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), id);
      return;
    } catch (error) {
      if (!sqliteBusy(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}
async function ffmpeg(args: string[], timeout: number, onProgress?: (seconds: number) => void): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = trackFfmpegProcess(spawn("ffmpeg", withMediaWorkerFfmpegLimits(["-nostdin", "-y", ...args]), {stdio: ["ignore", "pipe", "pipe"]}));
    let diagnostic = "", pending = "", lastProgress = Date.now(), secondsProcessed = -1, timedOut = false;
    child.stderr.on("data", chunk => { diagnostic = (diagnostic + String(chunk)).slice(-4000); });
    child.stdout.on("data", chunk => {
      pending += String(chunk);
      const lines = pending.split("\n"); pending = lines.pop() ?? "";
      for (const line of lines) {
        const match = line.match(/^out_time_us=(\d+)/);
        if (match && Number(match[1]) / 1e6 > secondsProcessed) {
          secondsProcessed = Number(match[1]) / 1e6;
          lastProgress = Date.now();
          try { onProgress?.(secondsProcessed); }
          catch (error) { child.kill("SIGKILL"); reject(error); }
        }
      }
    });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
    const stall = onProgress ? setInterval(() => {
      if (Date.now() - lastProgress > 120_000) { timedOut = true; child.kill("SIGKILL"); }
    }, 10_000) : null;
    const cleanup = () => { clearTimeout(timer); if (stall) clearInterval(stall); };
    child.once("error", () => { cleanup(); reject(new ClipError("ENCODE_FAILED", "视频处理工具无法启动，请检查 FFmpeg")); });
    child.once("close", code => {
      cleanup();
      if (code === 0) return resolve();
      if (timedOut) return reject(new ClipError("TIMEOUT", "生成超时或读取中断，将自动换用兼容方案重试"));
      if (/No space left/i.test(diagnostic)) return reject(new ClipError("NO_SPACE", "外接硬盘空间不足，释放空间后可重试"));
      // Retain the concrete FFmpeg failure in service logs without exposing source paths to the UI.
      console.warn("[highlight] ffmpeg failed", {code, diagnostic: diagnostic.replace(/\/Volumes\/[^\n]+/g, "[media path]").slice(-1200)});
      reject(new ClipError("ENCODE_FAILED", "视频生成失败，将自动使用兼容方案重试"));
    });
  });
}
export async function renderHighlight(media: MediaRow, start: number, end: number, output: string, attempt = 1, onProgress?: (seconds: number) => void): Promise<void> {
  const recovery = attempt > 1;
  const lead = recovery ? Math.min(start, 10) : 0;
  const input = recovery ? ["-fflags", "+genpts+discardcorrupt", "-err_detect", "ignore_err"] : [];
  await ffmpeg([
    ...input, "-ss", String(start - lead), "-i", media.absolute_path, ...(lead ? ["-ss", String(lead)] : []),
    "-t", String(end - start), "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn",
    "-vf", "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    "-pix_fmt", "yuv420p", "-c:v", "libx264", "-threads", String(config.mediaWorkerFfmpegThreads || 1),
    "-preset", recovery ? "ultrafast" : "veryfast", "-crf", "22", "-c:a", "aac", "-b:a", "160k",
    "-max_muxing_queue_size", "4096", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart",
    "-progress", "pipe:1", "-nostats", output
  ], Math.max(180_000, Math.min(30 * 60_000, (end - start) * 15_000)), onProgress);
}
async function validateClip(file: string, clip: Highlight): Promise<void> {
  if (!fs.statSync(file).size) throw new ClipError("VERIFY_FAILED", "生成的片段为空，将自动重试");
  const result = await probeMediaFile({absolute_path: file, extension: ".mp4"} as MediaRow);
  if (!result.durationSeconds || !result.width || Math.abs(result.durationSeconds - (clip.end - clip.start)) > Math.max(1, (clip.end - clip.start) * 0.01)) {
    throw new ClipError("VERIFY_FAILED", "片段时长或视频画面不完整，将自动重新生成");
  }
}
async function makePoster(clip: Highlight): Promise<void> {
  const target = fileFor(clip.id, ".jpg");
  if (fs.existsSync(target)) return;
  const temp = fileFor(clip.id, ".part.jpg");
  try {
    await ffmpeg(["-ss", String((clip.end - clip.start) / 2), "-i", fileFor(clip.id), "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", temp], 30_000);
    highlightStorage(); fs.renameSync(temp, target);
  } finally { try { highlightStorage(); fs.rmSync(temp, {force: true}); } catch { /* Storage may be disconnected. */ } }
}
function failClip(clip: Highlight, error: unknown, attempted: boolean): void {
  const code = error instanceof ClipError ? error.code : "ENCODE_FAILED";
  const message = error instanceof Error ? error.message : "片段生成失败";
  if (["SOURCE_UNAVAILABLE", "STORAGE_UNAVAILABLE", "NO_SPACE"].includes(code)) {
    if (attempted) db.prepare("UPDATE media_highlights SET attempts=MAX(0,attempts-1) WHERE id=?").run(clip.id);
    update(clip.id, "waiting", message, code, new Date(Date.now() + 30_000).toISOString());
  } else if (!["SOURCE_CHANGED", "INVALID_RANGE", "SOURCE_MISSING"].includes(code) && clip.attempts < MAX_ATTEMPTS) {
    update(clip.id, "retrying", message, code, new Date(Date.now() + (clip.attempts <= 1 ? 15_000 : 60_000)).toISOString());
  } else update(clip.id, "failed", message.replace(/，将自动.*$/, "，可点击修复重试"), code);
}
export function repairHighlightQueue(): number {
  const now = new Date().toISOString();
  // An interrupted clip must never be abandoned just because its parent job exhausted its retries.
  db.prepare(`UPDATE media_highlights SET status=CASE WHEN attempts>=${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END,
    retry_after=NULL,error=CASE WHEN attempts>=${MAX_ATTEMPTS} THEN '生成多次中断，可点击修复重试' ELSE '任务中断，已恢复到生成队列' END,error_code='INTERRUPTED'
    WHERE status='processing' AND NOT EXISTS (SELECT 1 FROM media_jobs j WHERE j.media_id=media_highlights.media_id
      AND j.job_type='highlight' AND j.status='running' AND j.lease_expires_at>?)`).run(now);
  db.prepare(`UPDATE media_highlights SET status='failed',error='原影片不存在',error_code='SOURCE_MISSING'
    WHERE status IN (${activeStatuses}) AND NOT EXISTS (SELECT 1 FROM media_files m WHERE m.id=media_highlights.media_id)`).run();
  const rows = db.prepare(`SELECT DISTINCT media_id FROM media_highlights WHERE status IN ('pending','waiting','retrying')
    AND (retry_after IS NULL OR retry_after<=?) LIMIT 20`).all(now) as {media_id: string}[];
  for (const row of rows) work(row.media_id);
  return rows.length;
}
registerMediaJobHandler("highlight", async (job, media) => {
  if (!media) { db.prepare(`UPDATE media_highlights SET status='failed',error='原影片不存在',error_code='SOURCE_MISSING' WHERE media_id=? AND status IN (${activeStatuses})`).run(job.media_id); return; }
  db.prepare(`UPDATE media_highlights SET status=CASE WHEN attempts>=${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END,
    error='任务中断，可点击修复重试' WHERE media_id=? AND status='processing'`).run(media.id);
  for (;;) {
    const clip = db.prepare(`SELECT * FROM media_highlights WHERE media_id=? AND status IN ('pending','waiting','retrying')
      AND (retry_after IS NULL OR retry_after<=?) ORDER BY created_at LIMIT 1`).get(media.id, new Date().toISOString()) as Highlight | undefined;
    if (!clip) break;
    if (clip.attempts >= MAX_ATTEMPTS) { update(clip.id, "failed", "已达到自动重试上限，可点击修复重试", "RETRY_LIMIT"); continue; }
    let temp: string | undefined, attempted = false;
    try {
      const target = fileFor(clip.id); fs.mkdirSync(path.dirname(target), {recursive: true});
      if (fs.existsSync(target)) {
        try { await validateClip(target, clip); await publishReady(clip.id); continue; }
        catch { /* Rebuild an invalid output; never publish an incomplete file. */ }
      }
      ensureInsideMediaRoot(media.absolute_path);
      let stat: fs.Stats;
      try { stat = fs.statSync(media.absolute_path); } catch { throw new ClipError("SOURCE_UNAVAILABLE", "原影片硬盘暂不可读，重新连接后自动恢复"); }
      if (stat.size !== clip.source_size || Math.abs(stat.mtimeMs - clip.source_mtime) > 2000) throw new ClipError("SOURCE_CHANGED", "原影片已变更，请重新选择片段");
      const duration = (await probeMediaFile(media)).durationSeconds;
      if (!duration || clip.end > duration + 0.1) throw new ClipError("INVALID_RANGE", "片段终点超出影片时长");
      clip.attempts += 1; attempted = true;
      db.prepare("UPDATE media_highlights SET attempts=?,progress=0 WHERE id=?").run(clip.attempts, clip.id);
      update(clip.id, "processing");
      temp = fileFor(clip.id, ".part.mp4"); fs.rmSync(temp, {force: true});
      let lastUpdate = 0;
      await renderHighlight(media, clip.start, clip.end, temp, clip.attempts, seconds => {
        if (Date.now() - lastUpdate < 2000) return;
        recordHighlightProgress(clip.id, Math.min(99, seconds / (clip.end - clip.start) * 100));
        lastUpdate = Date.now();
      });
      await validateClip(temp, clip); highlightStorage(); fs.renameSync(temp, target);
      await publishReady(clip.id);
      try { await makePoster(clip); } catch { /* Cover generation must not invalidate a playable clip. */ }
    } catch (error) {
      // Probe errors also consume an attempt, so corrupt inputs cannot retry forever.
      if (!attempted && !(error instanceof ClipError)) { clip.attempts++; db.prepare("UPDATE media_highlights SET attempts=? WHERE id=?").run(clip.attempts, clip.id); }
      failClip(clip, error, attempted);
    } finally { if (temp) { try { highlightStorage(); fs.rmSync(temp, {force: true}); } catch { /* No internal fallback. */ } } }
  }
  const ready = db.prepare("SELECT * FROM media_highlights WHERE media_id=? AND status='ready'").all(media.id) as Highlight[];
  for (const clip of ready) { try { if (fs.existsSync(fileFor(clip.id))) await makePoster(clip); } catch { /* Optional covers can be repaired later. */ } }
});
registerMediaJobIdleRefillHandler("highlights", repairHighlightQueue);
// Repair is foreground work, even when ordinary background queues are paused by playback.
const recoveryTimer = setInterval(() => { try { repairHighlightQueue(); } catch (error) { console.warn("[highlight] queue recovery deferred", error instanceof Error ? error.message : "unknown"); } }, 15_000);
recoveryTimer.unref();
export function stopHighlightRecovery(): void { clearInterval(recoveryTimer); }

export function registerHighlightRoutes(app: Express): void {
  app.get("/api/highlights", (_req, res) => {
    let available = true; try { highlightStorage(); } catch { available = false; }
    const rows = db.prepare(`SELECT id,media_id AS mediaId,title,source_title AS sourceTitle,start,end,status,error,
      error_code AS errorCode,attempts,progress,retry_after AS retryAfter,created_at AS createdAt,updated_at AS updatedAt
      FROM media_highlights WHERE user_id=? ORDER BY created_at DESC`).all(getActiveUserProfile().id) as (Record<string, unknown> & {id: string; mediaId: string; status: string})[];
    res.json({items: rows.map(row => ({...row, posterUrl: available && fs.existsSync(fileFor(row.id, ".jpg")) ? `/api/highlights/${row.id}/poster` : `/api/media/${row.mediaId}/poster?variant=card`})), storageAvailable: available});
  });
  app.post("/api/highlights", (req, res, next) => { try {
    const input = highlightInput.parse(req.body); highlightStorage();
    const media = db.prepare("SELECT * FROM media_files WHERE id=?").get(input.mediaId) as MediaRow | undefined;
    if (!media || media.media_type !== "video") return void res.status(404).json({error: "原影片不存在"});
    ensureInsideMediaRoot(media.absolute_path);
    let stat: fs.Stats;
    try { stat = fs.statSync(media.absolute_path); } catch { return void res.status(409).json({error: "请先连接原影片所在硬盘"}); }
    if (media.duration_seconds && input.end > media.duration_seconds + 0.1) return void res.status(400).json({error: "片段终点超出影片时长"});
    const id = crypto.randomUUID(), now = new Date().toISOString();
    db.transaction(() => {
      db.prepare("INSERT INTO media_highlights(id,user_id,media_id,title,source_title,start,end,source_size,source_mtime,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, getActiveUserProfile().id, media.id, input.title, media.normalized_code || media.basename, input.start, input.end, stat.size, stat.mtimeMs, now, now); work(media.id);
    })(); res.status(202).json({id, status: "pending"});
  } catch (error) { next(error); } });
  app.post("/api/highlights/repair", (_req, res, next) => { try {
    const rows = db.prepare("SELECT * FROM media_highlights WHERE user_id=? AND status!='processing'").all(getActiveUserProfile().id) as Highlight[];
    let repaired = 0;
    for (const clip of rows) {
      let missing = false;
      if (clip.status === "ready") { try { missing = !fs.existsSync(fileFor(clip.id)); } catch { continue; } }
      if (clip.status !== "ready" || missing) {
        db.prepare("UPDATE media_highlights SET attempts=0,progress=0 WHERE id=?").run(clip.id); update(clip.id, "pending"); repaired++;
      }
      work(clip.media_id);
    }
    repairHighlightQueue(); res.json({repaired});
  } catch (error) { next(error); } });
  app.post("/api/highlights/:id/retry", (req, res, next) => { try {
    const clip = owned(req.params.id); if (!clip) return void res.sendStatus(404);
    if (clip.status === "processing") return void res.status(409).json({error: "片段正在生成，请稍候"});
    if (clip.status === "ready" && fs.existsSync(fileFor(clip.id))) return void res.status(409).json({error: "片段已生成，无需重试"});
    db.transaction(() => { db.prepare("UPDATE media_highlights SET attempts=0,progress=0 WHERE id=?").run(clip.id); update(clip.id, "pending"); work(clip.media_id); })();
    res.status(202).json({id: clip.id});
  } catch (error) { next(error); } });
  app.get("/api/highlights/:id/poster", (req, res, next) => { try {
    const clip = owned(req.params.id); if (!clip) return void res.sendStatus(404);
    const file = fileFor(clip.id, ".jpg"); if (!fs.existsSync(file)) { work(clip.media_id); return void res.sendStatus(404); }
    streamFile(file, "image/jpeg", req, res, {cacheControl: "private, max-age=3600"});
  } catch (error) { next(error); } });
  app.get("/api/highlights/:id/file", (req, res, next) => { try {
    const clip = owned(req.params.id); if (!clip) return void res.sendStatus(404);
    if (clip.status !== "ready") return void res.status(409).json({error: "片段尚未生成完成"});
    const file = fileFor(clip.id);
    if (!fs.existsSync(file)) {
      db.prepare("UPDATE media_highlights SET attempts=0,progress=0 WHERE id=?").run(clip.id);
      update(clip.id, "pending", "片段文件缺失，已加入修复队列"); work(clip.media_id);
      return void res.status(409).json({error: "片段文件缺失，正在自动修复"});
    }
    if (req.query.download === "1") res.setHeader("Content-Disposition", `attachment; filename="highlight-${clip.id}.mp4"`);
    streamFile(file, "video/mp4", req, res, {cacheControl: "private, no-store"});
  } catch (error) { next(error); } });
  app.delete("/api/highlights/:id", (req, res, next) => { try {
    const clip = owned(req.params.id); if (!clip) return void res.sendStatus(404);
    if (["pending", "processing", "waiting", "retrying"].includes(clip.status)) return void res.status(409).json({error: "请等待片段处理结束后删除"});
    for (const suffix of [".mp4", ".jpg", ".part.mp4", ".part.jpg"]) fs.rmSync(fileFor(clip.id, suffix), {force: true});
    db.prepare("DELETE FROM media_highlights WHERE id=?").run(clip.id); res.sendStatus(204);
  } catch (error) { next(error); } });
}
