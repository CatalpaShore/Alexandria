import { registerLibrarySourceRoutes } from "./librarySourceRoutes.js";
import fs from "node:fs";
import path from "node:path";
import type { Express, Response } from "express";
import { z } from "zod";
import { config, getLibraryRoots, getMediaSources, saveLibraryRoots } from "./config.js";
import { db, getMediaSearchIndexStatus } from "./db.js";
import { reclaimDatabaseSpace } from "./databaseMaintenance.js";
import { createDiagnosticsHandler } from "./diagnostics.js";
import { readFavoriteKeys } from "./favorites.js";
import { getMediaJobStatus } from "./mediaJobs.js";
import { getOperationalMaintenanceStatus, runOperationalMaintenance } from "./operationalMaintenance.js";
import { getRuntimeCapabilities } from "./runtimeCapabilities.js";
import type { ScanSummary } from "./scanner.js";
import { inspectStorageSource, summarizeStorageAvailability } from "./storageAccess.js";
import { getStorageRecoveryStatus } from "./storageRecovery.js";

type SystemRouteOptions = {
  startScan: () => Promise<ScanSummary>;
  isScanActive: () => boolean;
  getLatestScan: () => ScanSummary | null;
  clearResponseCaches: () => void;
  getCacheStats: () => Record<string, unknown>;
  isCacheWarmupRunning: () => boolean;
};

const libraryPathsSchema = z.object({
  roots: z
    .array(z.string().trim().min(1))
    .length(2)
    .refine((roots) => roots.every((root) => path.isAbsolute(root)), "资源路径必须是绝对路径")
});

function getStorageEntry(category: string, name: string, root: string) {
  const status = inspectStorageSource({ category, name, root });
  return {
    category,
    name,
    root,
    exists: status.readable,
    readable: status.readable,
    state: status.state,
    mountPoint: status.mountPoint,
    errorCode: status.errorCode,
    message: status.message
  };
}

function getPathSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

const directoryStatsCache = new Map<
  string,
  { expiresAt: number; refreshing: boolean; value: { exists: boolean; files: number; bytes: number } }
>();

const DIRECTORY_STATS_TTL_MS = 5 * 60 * 1000;

async function refreshDirectoryStats(root: string): Promise<void> {
  const cached = directoryStatsCache.get(root);
  if (!cached || cached.refreshing) return;
  cached.refreshing = true;
  let files = 0;
  let bytes = 0;
  try {
    const rootStat = await fs.promises.stat(root);
    if (!rootStat.isDirectory()) {
      directoryStatsCache.set(root, {
        expiresAt: Date.now() + DIRECTORY_STATS_TTL_MS,
        refreshing: false,
        value: { exists: false, files: 0, bytes: 0 }
      });
      return;
    }
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      const filePaths: string[] = [];
      for (const entry of entries) {
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(entryPath);
        else if (entry.isFile()) filePaths.push(entryPath);
      }
      for (let offset = 0; offset < filePaths.length; offset += 64) {
        const sizes = await Promise.all(filePaths.slice(offset, offset + 64).map(async (filePath) => {
          try { return (await fs.promises.stat(filePath)).size; } catch { return 0; }
        }));
        files += sizes.length;
        bytes += sizes.reduce((sum, size) => sum + size, 0);
      }
    }
    directoryStatsCache.set(root, {
      expiresAt: Date.now() + DIRECTORY_STATS_TTL_MS,
      refreshing: false,
      value: { exists: true, files, bytes }
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT" || code === "ENOTDIR") {
      directoryStatsCache.set(root, {
        expiresAt: Date.now() + DIRECTORY_STATS_TTL_MS,
        refreshing: false,
        value: { exists: false, files: 0, bytes: 0 }
      });
    } else {
      cached.refreshing = false;
    }
  }
}

function getDirectoryStats(root: string) {
  const cached = directoryStatsCache.get(root);
  if (cached) {
    if (cached.expiresAt <= Date.now()) void refreshDirectoryStats(root);
    return cached.value;
  }
  let files = 0;
  let bytes = 0;

  if (!fs.existsSync(root)) {
    const value = { exists: false, files, bytes };
    directoryStatsCache.set(root, { expiresAt: Date.now() + DIRECTORY_STATS_TTL_MS, refreshing: false, value });
    return value;
  }

  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      files += 1;
      bytes += getPathSize(entryPath);
    }
  }

  const value = { exists: true, files, bytes };
  directoryStatsCache.set(root, { expiresAt: Date.now() + DIRECTORY_STATS_TTL_MS, refreshing: false, value });
  return value;
}

function getLibraryPathSettings() {
  const libraryRoots = getLibraryRoots();
  const mediaSources = getMediaSources();

  return {
    roots: libraryRoots.roots.map((root, index) => ({
      ...getStorageEntry("LIBRARY", index === 0 ? "primary" : "secondary", root),
      key: index === 0 ? "primary" : "secondary",
      label: index === 0 ? "资源路径 1" : "资源路径 2",
      path: root
    })),
    mediaSources: mediaSources.map((source) => getStorageEntry(source.category, source.name, source.root)),
    configPath: config.libraryConfigPath,
    updatedAt: libraryRoots.updatedAt ?? null
  };
}

function buildHealthSummary(options: SystemRouteOptions) {
  const dbPath = config.databasePath;
  const totals = db.prepare(`
    SELECT COUNT(*) AS count,
      COALESCE(SUM(size), 0) AS totalSize,
      COALESCE(SUM(duration_seconds), 0) AS totalDurationSeconds
    FROM media_files
  `).get() as { count: number; totalSize: number; totalDurationSeconds: number };
  const categories = db.prepare(`
    SELECT library_category AS value, COUNT(*) AS count, COALESCE(SUM(size), 0) AS totalSize
    FROM media_files
    GROUP BY library_category
    ORDER BY count DESC, value ASC
  `).all() as Array<{ value: string; count: number; totalSize: number }>;
  const mediaTypes = db.prepare(
    "SELECT media_type AS value, COUNT(*) AS count FROM media_files GROUP BY media_type ORDER BY count DESC"
  ).all() as Array<{ value: string; count: number }>;
  const metadataStatuses = db.prepare(
    "SELECT status AS value, COUNT(*) AS count FROM media_metadata GROUP BY status ORDER BY count DESC"
  ).all() as Array<{ value: string; count: number }>;
  const thumbnailStatuses = db.prepare(
    "SELECT thumbnail_status AS value, COUNT(*) AS count FROM media_files GROUP BY thumbnail_status ORDER BY count DESC"
  ).all() as Array<{ value: string; count: number }>;
  const probeStatuses = db.prepare(
    "SELECT probe_status AS value, COUNT(*) AS count FROM media_files WHERE media_type = 'video' GROUP BY probe_status ORDER BY count DESC"
  ).all() as Array<{ value: string; count: number }>;
  const compatibilityStatuses = db.prepare(
    "SELECT compatibility_status AS value, COUNT(*) AS count FROM media_files WHERE media_type = 'video' GROUP BY compatibility_status ORDER BY count DESC"
  ).all() as Array<{ value: string; count: number }>;
  const sidecarCount = (db.prepare("SELECT COUNT(*) AS count FROM media_sidecars").get() as { count: number }).count;
  const derivativeStats = db.prepare(
    "SELECT kind AS value, status, COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM media_derivatives GROUP BY kind, status"
  ).all();
  const playback = db.prepare(`
    SELECT COUNT(*) AS count,
      COALESCE(SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END), 0) AS completed,
      COALESCE(SUM(CASE WHEN completed = 0 AND position_seconds > 0 THEN 1 ELSE 0 END), 0) AS inProgress,
      MAX(last_played_at) AS lastPlayedAt
    FROM playback_progress
  `).get() as { count: number; completed: number; inProgress: number; lastPlayedAt: string | null };
  const readyMetadata = metadataStatuses.find((status) => status.value === "ready")?.count ?? 0;
  const librarySources = getMediaSources().map((source) => getStorageEntry(source.category, source.name, source.root));

  return {
    ok: true,
    totals,
    categories,
    mediaTypes,
    metadata: {
      total: metadataStatuses.reduce((sum, status) => sum + status.count, 0),
      ready: readyMetadata,
      statuses: metadataStatuses
    },
    thumbnails: { statuses: thumbnailStatuses, cache: getDirectoryStats(config.thumbnailDir) },
    covers: { cache: getDirectoryStats(config.coverCacheDir) },
    mediaProcessing: {
      probes: probeStatuses,
      compatibility: compatibilityStatuses,
      sidecars: sidecarCount,
      derivatives: derivativeStats,
      jobs: getMediaJobStatus()
    },
    playback,
    favorites: { count: readFavoriteKeys().size, path: config.favoritesPath },
    cache: {
      ...options.getCacheStats(),
      warmupRunning: options.isCacheWarmupRunning()
    },
    searchIndex: getMediaSearchIndexStatus(),
    storage: {
      dataDir: config.dataDir,
      databasePath: dbPath,
      databaseBytes: getPathSize(dbPath),
      metadataSeedPath: config.metadataSeedPath,
      metadataSeedBytes: getPathSize(config.metadataSeedPath)
    },
    library: {
      sources: librarySources,
      availability: summarizeStorageAvailability(librarySources),
      recovery: getStorageRecoveryStatus()
    },
    scanning: options.isScanActive(),
    latestScan: options.getLatestScan()
  };
}

export function registerSystemRoutes(app: Express, options: SystemRouteOptions): void {
  registerLibrarySourceRoutes(app, options.startScan, options.isScanActive);
  // Pay the one-time filesystem inventory cost before the HTTP listener is
  // exposed. Expired inventories are refreshed asynchronously and served stale
  // in the meantime, so health checks never walk thousands of cache files.
  getDirectoryStats(config.thumbnailDir);
  getDirectoryStats(config.coverCacheDir);

  let healthSummaryCache: { expiresAt: number; value: ReturnType<typeof buildHealthSummary> } | null = null;
  const healthSummary = () => {
    if (healthSummaryCache && healthSummaryCache.expiresAt > Date.now()) {
      return { cacheStatus: "HIT" as const, value: healthSummaryCache.value };
    }
    const value = buildHealthSummary(options);
    healthSummaryCache = { expiresAt: Date.now() + 5_000, value };
    return { cacheStatus: "MISS" as const, value };
  };
  const sendHealthSummary = (res: Response) => {
    const startedAt = performance.now();
    const result = healthSummary();
    res.setHeader("X-AMW-Cache", result.cacheStatus);
    res.setHeader("Server-Timing", `health;dur=${(performance.now() - startedAt).toFixed(1)}`);
    res.json(result.value);
  };

  app.get("/api/health/ping", (_req, res) => res.json({ ok: true, service: "alexandria" }));
  app.get("/api/health", (_req, res) => sendHealthSummary(res));
  app.get("/api/health/summary", (_req, res) => sendHealthSummary(res));
  app.get("/api/runtime-capabilities", (req, res) => {
    res.json(getRuntimeCapabilities(req.get("user-agent") ?? ""));
  });
  app.get("/api/diagnostics", createDiagnosticsHandler({
    isScanActive: options.isScanActive,
    getLatestScan: options.getLatestScan,
    getMaintenanceStatus: getOperationalMaintenanceStatus
  }));
  app.post("/api/maintenance/operations", async (_req, res, next) => {
    try {
      res.json(await runOperationalMaintenance("manual"));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/maintenance/database/reclaim", (req, res, next) => {
    try {
      if (req.body?.confirm !== "RECLAIM") {
        res.status(400).json({ error: "需要明确确认数据库空间回收" });
        return;
      }
      if (options.isScanActive()) {
        res.status(409).json({ error: "媒体扫描进行中，请稍后再回收数据库空间" });
        return;
      }
      res.json(reclaimDatabaseSpace(db, config.databasePath));
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/settings/library-paths", (_req, res) => {
    res.json(getLibraryPathSettings());
  });
  app.put("/api/settings/library-paths", (req, res, next) => {
    try {
      const body = libraryPathsSchema.parse(req.body);
      saveLibraryRoots(body.roots as [string, string]);
      healthSummaryCache = null;
      options.clearResponseCaches();
      if (!options.isScanActive()) {
        options.startScan().catch((error) => {
          console.error("Media scan after library path update failed:", error);
        });
      }
      res.json({ ...getLibraryPathSettings(), scanning: options.isScanActive() });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/scan", async (req, res, next) => {
    try {
      const capabilities = getRuntimeCapabilities(req.get("user-agent") ?? "");
      if (!capabilities.canTriggerScan) {
        res.status(403).json({ code: "LOCAL_PC_ONLY", error: capabilities.disabledReason, capabilities });
        return;
      }
      res.json(await options.startScan());
    } catch (error) {
      next(error);
    }
  });
}
