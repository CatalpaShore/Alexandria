import fs from "node:fs";
import path from "node:path";
import type { RequestHandler } from "express";
import { config } from "./config.js";
import { db } from "./db.js";
import { getMediaJobStatus } from "./mediaJobs.js";
import {
  getOperationalMaintenanceStatus,
  type OperationalMaintenanceStatus
} from "./operationalMaintenance.js";
import { RESPONSE_READY_EVENT } from "./requestTiming.js";
import type { ScanSummary } from "./scanner.js";

type LatencySnapshot = {
  requests: number;
  errors: number;
  rejected: number;
  errorRatePercent: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
};

type RequestRouteSnapshot = LatencySnapshot & {
  route: string;
};

export type DiagnosticsAlert = {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
};

export type SanitizedScanReport = Omit<ScanSummary, "roots"> & {
  durationMs: number;
  roots: Array<{ name: string; indexed: number }>;
};

export type OperationsDiagnostics = {
  generatedAt: string;
  uptimeSeconds: number;
  process: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
  };
  requests: LatencySnapshot & {
    active: number;
    routes: RequestRouteSnapshot[];
  };
  database: {
    databaseBytes: number;
    walBytes: number;
    sharedMemoryBytes: number;
    pageSize: number;
    pageCount: number;
    freelistPages: number;
    freelistBytes: number;
    freeRatioPercent: number;
    journalMode: string;
    autoVacuum: number;
  };
  jobs: {
    workerRunning: boolean;
    playbackActive: boolean;
    probeToolAvailable: boolean;
    ffmpegToolAvailable: boolean;
    pending: number;
    running: number;
    failed: number;
    failedLast24Hours: number;
    retryScheduled: number;
    expiredLeases: number;
    oldestPendingAgeSeconds: number | null;
    oldestRunningAgeSeconds: number | null;
    schedule: {
      timeZone: string;
      nightStartHour: number;
      nightEndHour: number;
      daytimeCooldownMs: number;
      localHour: number;
      nightWindowActive: boolean;
      daytimeBackgroundDue: boolean;
      backgroundAllowed: boolean;
      foregroundPriority: number;
      processNiceness: number;
      ffmpegThreads: number;
    };
    counts: Array<{ jobType: string; status: string; count: number }>;
  };
  temporaryFiles: {
    count: number;
    bytes: number;
    staleCount: number;
    staleBytes: number;
  };
  scanning: {
    active: boolean;
    latest: SanitizedScanReport | null;
  };
  maintenance: OperationalMaintenanceStatus;
  alerts: DiagnosticsAlert[];
};

export type DiagnosticsContext = {
  isScanActive?: () => boolean;
  getLatestScan?: () => ScanSummary | null;
  getMaintenanceStatus?: () => OperationalMaintenanceStatus;
};

class RollingDurations {
  private readonly values: Float64Array;
  private cursor = 0;
  private samples = 0;

  constructor(capacity: number) {
    this.values = new Float64Array(capacity);
  }

  add(value: number): void {
    this.values[this.cursor] = value;
    this.cursor = (this.cursor + 1) % this.values.length;
    this.samples = Math.min(this.samples + 1, this.values.length);
  }

  snapshot(): number[] {
    return Array.from(this.values.subarray(0, this.samples));
  }
}

class RequestBucket {
  readonly durations: RollingDurations;
  requests = 0;
  errors = 0;
  rejected = 0;
  lastSeenAt = 0;

  constructor(capacity: number) {
    this.durations = new RollingDurations(capacity);
  }

  add(durationMs: number, statusCode: number): void {
    this.requests += 1;
    if (statusCode >= 500) this.errors += 1;
    if (statusCode >= 400) this.rejected += 1;
    this.lastSeenAt = Date.now();
    this.durations.add(durationMs);
  }
}

const overallRequests = new RequestBucket(2048);
const routeRequests = new Map<string, RequestBucket>();
const maxRouteBuckets = 64;
let activeRequests = 0;
let lastApiActivityAt = Date.now();

export function isApiIdle(idleMs = 10_000): boolean {
  return activeRequests === 0 && Date.now() - lastApiActivityAt >= idleMs;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? 0;
}

function bucketSnapshot(bucket: RequestBucket): LatencySnapshot {
  const values = bucket.durations.snapshot().sort((left, right) => left - right);
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    requests: bucket.requests,
    errors: bucket.errors,
    rejected: bucket.rejected,
    errorRatePercent: bucket.requests > 0 ? round((bucket.errors / bucket.requests) * 100) : 0,
    p50Ms: round(percentile(values, 0.5)),
    p95Ms: round(percentile(values, 0.95)),
    maxMs: round(values.at(-1) ?? 0)
  };
}

function fallbackRoute(value: string): string {
  const pathname = value.split("?", 1)[0] || "/";
  return pathname
    .replace(/\b[0-9a-f]{16,}\b/gi, ":id")
    .replace(/\b[0-9]{2,}\b/g, ":number")
    .replace(/\/+/g, "/");
}

function requestRoute(req: Parameters<RequestHandler>[0]): string {
  const route = req.route as { path?: unknown } | undefined;
  const routePath = typeof route?.path === "string" ? route.path : "";
  const pathValue = routePath ? `${req.baseUrl}${routePath}` : fallbackRoute(req.originalUrl);
  return `${req.method.toUpperCase()} ${pathValue}`;
}

function routeBucket(key: string): RequestBucket {
  const existing = routeRequests.get(key);
  if (existing) return existing;
  if (routeRequests.size >= maxRouteBuckets) {
    let oldestKey = "";
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [candidate, bucket] of routeRequests) {
      if (bucket.lastSeenAt < oldestAt) {
        oldestAt = bucket.lastSeenAt;
        oldestKey = candidate;
      }
    }
    if (oldestKey) routeRequests.delete(oldestKey);
  }
  const created = new RequestBucket(256);
  routeRequests.set(key, created);
  return created;
}

export const diagnosticsMiddleware: RequestHandler = (req, res, next) => {
  if (!req.originalUrl.startsWith("/api/")) {
    next();
    return;
  }

  lastApiActivityAt = Date.now();
  activeRequests += 1;
  const started = process.hrtime.bigint();
  let recorded = false;
  let completed = false;
  const complete = () => {
    if (completed) return;
    completed = true;
    activeRequests = Math.max(0, activeRequests - 1);
  };
  const record = (statusCode: number) => {
    if (recorded) return;
    recorded = true;
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    overallRequests.add(durationMs, statusCode);
    routeBucket(requestRoute(req)).add(durationMs, statusCode);
  };
  // File and media responses can remain open for minutes while the browser plays
  // or downloads them. Their useful latency is the time until headers are ready,
  // not the lifetime of the byte stream.
  res.once(RESPONSE_READY_EVENT, () => record(res.statusCode));
  res.once("finish", () => {
    record(res.statusCode);
    complete();
  });
  res.once("close", () => {
    record(res.writableEnded ? res.statusCode : 499);
    complete();
  });
  next();
};

function fileBytes(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function pathBytes(target: string): number {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return 0;
  }
  if (stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let bytes = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) bytes += pathBytes(path.join(target, entry.name));
  return bytes;
}

let temporaryCache: { expiresAt: number; value: OperationsDiagnostics["temporaryFiles"] } | null = null;

function getTemporaryFileStats(nowMs = Date.now()): OperationsDiagnostics["temporaryFiles"] {
  if (temporaryCache && temporaryCache.expiresAt > nowMs) return temporaryCache.value;
  let count = 0;
  let bytes = 0;
  let staleCount = 0;
  let staleBytes = 0;
  const staleCutoffMs = 20 * 60 * 1000;
  for (const root of [config.posterVariantDir, config.streamCacheDir]) {
    if (!fs.existsSync(root)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.name.includes(".tmp")) continue;
      const target = path.join(root, entry.name);
      const entryBytes = pathBytes(target);
      count += 1;
      bytes += entryBytes;
      try {
        if (nowMs - fs.statSync(target).mtimeMs >= staleCutoffMs) {
          staleCount += 1;
          staleBytes += entryBytes;
        }
      } catch {
        // A concurrent cleanup can remove the entry between reads.
      }
    }
  }
  const value = { count, bytes, staleCount, staleBytes };
  temporaryCache = { expiresAt: nowMs + 30_000, value };
  return value;
}

function ageSeconds(value: string | null, nowMs = Date.now()): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, Math.round((nowMs - timestamp) / 1000)) : null;
}

function getJobDiagnostics(): OperationsDiagnostics["jobs"] {
  const now = new Date().toISOString();
  const aggregate = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'failed' AND datetime(COALESCE(finished_at, updated_at)) >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS failedLast24Hours,
      SUM(CASE WHEN status = 'pending' AND retry_after IS NOT NULL AND retry_after > @now THEN 1 ELSE 0 END) AS retryScheduled,
      SUM(CASE WHEN status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < @now THEN 1 ELSE 0 END) AS expiredLeases,
      MIN(CASE WHEN status = 'pending' THEN created_at END) AS oldestPendingAt,
      MIN(CASE WHEN status = 'running' THEN COALESCE(started_at, updated_at) END) AS oldestRunningAt
    FROM media_jobs
  `).get({ now }) as {
    pending: number | null;
    running: number | null;
    failed: number | null;
    failedLast24Hours: number | null;
    retryScheduled: number | null;
    expiredLeases: number | null;
    oldestPendingAt: string | null;
    oldestRunningAt: string | null;
  };
  const worker = getMediaJobStatus();
  return {
    workerRunning: worker.running,
    playbackActive: worker.playbackActive,
    probeToolAvailable: worker.probeToolAvailable,
    ffmpegToolAvailable: worker.ffmpegToolAvailable,
    pending: Number(aggregate.pending ?? 0),
    running: Number(aggregate.running ?? 0),
    failed: Number(aggregate.failed ?? 0),
    failedLast24Hours: Number(aggregate.failedLast24Hours ?? 0),
    retryScheduled: Number(aggregate.retryScheduled ?? 0),
    expiredLeases: Number(aggregate.expiredLeases ?? 0),
    oldestPendingAgeSeconds: ageSeconds(aggregate.oldestPendingAt),
    oldestRunningAgeSeconds: ageSeconds(aggregate.oldestRunningAt),
    schedule: worker.schedule,
    counts: worker.counts
  };
}

function getDatabaseDiagnostics(): OperationsDiagnostics["database"] {
  const databasePath = config.databasePath;
  const pageSize = Number(db.pragma("page_size", { simple: true }));
  const pageCount = Number(db.pragma("page_count", { simple: true }));
  const freelistPages = Number(db.pragma("freelist_count", { simple: true }));
  const totalPages = Math.max(1, pageCount);
  return {
    databaseBytes: fileBytes(databasePath),
    walBytes: fileBytes(`${databasePath}-wal`),
    sharedMemoryBytes: fileBytes(`${databasePath}-shm`),
    pageSize,
    pageCount,
    freelistPages,
    freelistBytes: pageSize * freelistPages,
    freeRatioPercent: Math.round((freelistPages / totalPages) * 1000) / 10,
    journalMode: String(db.pragma("journal_mode", { simple: true })),
    autoVacuum: Number(db.pragma("auto_vacuum", { simple: true }))
  };
}

function sanitizeScan(summary: ScanSummary | null): SanitizedScanReport | null {
  if (!summary) return null;
  const started = Date.parse(summary.startedAt);
  const finished = Date.parse(summary.finishedAt);
  return {
    ...summary,
    roots: summary.roots.map((root) => ({ name: root.name, indexed: root.indexed })),
    durationMs: Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : 0
  };
}

function buildAlerts(
  requests: LatencySnapshot,
  database: OperationsDiagnostics["database"],
  jobs: OperationsDiagnostics["jobs"],
  temporaryFiles: OperationsDiagnostics["temporaryFiles"],
  maintenance: OperationalMaintenanceStatus
): DiagnosticsAlert[] {
  const alerts: DiagnosticsAlert[] = [];
  if (jobs.expiredLeases > 0) {
    alerts.push({ code: "EXPIRED_JOB_LEASE", severity: "error", message: `${jobs.expiredLeases} 个任务租约已过期` });
  }
  if (jobs.failedLast24Hours > 0) {
    alerts.push({ code: "RECENT_JOB_FAILURE", severity: "warning", message: `过去 24 小时有 ${jobs.failedLast24Hours} 个任务失败` });
  }
  if ((jobs.oldestPendingAgeSeconds ?? 0) >= 30 * 60) {
    alerts.push({ code: "QUEUE_DELAY", severity: "warning", message: "最早待处理任务已等待超过 30 分钟" });
  }
  if (temporaryFiles.staleCount > 0) {
    alerts.push({ code: "STALE_TEMP_FILES", severity: "warning", message: `发现 ${temporaryFiles.staleCount} 个过期转码临时项` });
  }
  if (database.walBytes >= 512 * 1024 * 1024) {
    alerts.push({ code: "LARGE_WAL", severity: "warning", message: "数据库 WAL 已超过 512 MiB" });
  }
  if (database.freeRatioPercent >= 25) {
    alerts.push({ code: "DATABASE_FREE_PAGES", severity: "info", message: `数据库空闲页占 ${database.freeRatioPercent}%` });
  }
  if (requests.requests >= 20 && requests.p95Ms >= 800) {
    alerts.push({ code: "SLOW_API", severity: "warning", message: `API P95 延迟为 ${requests.p95Ms} ms` });
  }
  if (requests.requests >= 20 && requests.errorRatePercent >= 2) {
    alerts.push({ code: "API_ERROR_RATE", severity: "error", message: `API 错误率为 ${requests.errorRatePercent}%` });
  }
  if (maintenance.lastReport && !maintenance.lastReport.ok) {
    alerts.push({ code: "MAINTENANCE_ERROR", severity: "warning", message: "最近一次后台维护存在失败步骤" });
  }
  return alerts;
}

export function getOperationsDiagnostics(context: DiagnosticsContext = {}): OperationsDiagnostics {
  const requestSummary = bucketSnapshot(overallRequests);
  const database = getDatabaseDiagnostics();
  const jobs = getJobDiagnostics();
  const temporaryFiles = getTemporaryFileStats();
  const maintenance = context.getMaintenanceStatus?.() ?? getOperationalMaintenanceStatus();
  const routes = Array.from(routeRequests.entries())
    .map(([route, bucket]) => ({ route, ...bucketSnapshot(bucket) }))
    .sort((left, right) => right.p95Ms - left.p95Ms || right.requests - left.requests)
    .slice(0, 12);
  const memory = process.memoryUsage();

  return {
    generatedAt: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    process: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal
    },
    requests: { ...requestSummary, active: activeRequests, routes },
    database,
    jobs,
    temporaryFiles,
    scanning: {
      active: context.isScanActive?.() ?? false,
      latest: sanitizeScan(context.getLatestScan?.() ?? null)
    },
    maintenance,
    alerts: buildAlerts(requestSummary, database, jobs, temporaryFiles, maintenance)
  };
}

export function createDiagnosticsHandler(context: DiagnosticsContext = {}): RequestHandler {
  return (_req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.json(getOperationsDiagnostics(context));
    } catch (error) {
      next(error);
    }
  };
}
