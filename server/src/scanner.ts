import crypto from "node:crypto";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  config,
  getMediaSources,
  getMediaType,
  getMimeType,
  type MediaSource,
  supportedExtensions
} from "./config.js";
import { db, type MediaRow, statements } from "./db.js";
import { parseMediaName } from "./mediaName.js";
import { enqueuePendingSubtitleJobs } from "./subtitleDerivatives.js";
import {
  createScanSourceKey,
  fingerprintScanSources,
  getSnapshotMediaPaths,
  loadScanSnapshot,
  saveScanSnapshot,
  scanSnapshotVersion,
  type ScanDirectorySnapshot,
  type ScanSnapshot,
  type ScanSnapshotFile,
  type ScanSourceSnapshot
} from "./scanSnapshots.js";
import { inspectStorageSource, type StorageAccessState } from "./storageAccess.js";

import { ensureLibraryIdentitySchema, recordFileIdentity, reconcileLibraryMoves } from "./libraryIdentity.js";
import { importLocalLibrary, isLibraryArtwork } from "./localLibraryImport.js";
import { getSidecarLanguage, selectSidecarMedia, type SidecarMedia } from "./sidecarMatching.js";

export { parseMediaName } from "./mediaName.js";

export type ScanSummary = {
  roots: Array<{
    name: string;
    root: string;
    indexed: number;
    state?: StorageAccessState;
    message?: string;
  }>;
  indexed: number;
  sidecars: number;
  unchanged: number;
  changed: number;
  removed: number;
  scanMode: "full" | "incremental";
  fullScanReason: string;
  directoriesRead: number;
  directoriesSkipped: number;
  filesReused: number;
  snapshotSaved: boolean;
  startedAt: string;
  finishedAt: string;
};

type SidecarCandidate = {
  source: MediaSource;
  filePath: string;
};

export type ScanOptions = {
  forceFull?: boolean;
  fullScanIntervalMs?: number;
  onProgress?: (progress: ScanProgress) => void;
  onInitialReady?: () => void;
};

export type ScanProgress = {
  phase: "discovering" | "importing" | "fingerprinting" | "finalizing";
  indexed: number;
  completed: number;
  total: number;
  initialReady: boolean;
};

const sidecarExtensions = new Set([".srt", ".ass", ".ssa", ".vtt", ".sub", ".nfo"]);

function normalizeRelativePath(source: MediaSource, filePath: string): string {
  return path.relative(source.root, filePath).split(path.sep).join("/");
}

function createId(source: MediaSource, sourceRelativePath: string): string {
  return crypto
    .createHash("sha1")
    // Include the category: two sources can share both a name and physical
    // root while remaining separate logical libraries. Existing IDs are
    // retrieved by relative path above and are never regenerated.
    .update(JSON.stringify([source.category, source.name, source.root, sourceRelativePath]))
    .digest("hex")
    .slice(0, 16);
}

function getFirstLetter(name: string): string {
  const match = name.match(/[A-Za-z0-9]/);
  if (!match) return "OTHER";
  const value = match[0].toUpperCase();
  return /[0-9]/.test(value) ? "#" : value;
}

async function toMediaRow(
  source: MediaSource,
  filePath: string,
  scanToken: string,
  knownStat?: Stats
): Promise<MediaRow | null> {
  const extension = path.extname(filePath).toLowerCase();
  if (!supportedExtensions.has(extension)) return null;

  const stat = knownStat ?? await fs.stat(filePath);
  const sourceRelativePath = normalizeRelativePath(source, filePath);
  const relativePath = `${source.category}/${source.name}/${sourceRelativePath}`;
  const name = path.basename(filePath);
  const basename = path.basename(filePath, path.extname(filePath));
  const directory = path.dirname(sourceRelativePath) === "." ? "" : path.dirname(sourceRelativePath);
  const parsed = parseMediaName(basename, directory);
  const existing = db.prepare("SELECT id,normalized_code FROM media_files WHERE relative_path=?").get(relativePath) as { id: string; normalized_code: string } | undefined;
  const id = existing?.id ?? createId(source, sourceRelativePath);
  const mediaType = getMediaType(extension);

  return {
    id,
    library_category: source.category,
    source_name: source.name,
    source_root: source.root,
    relative_path: relativePath,
    absolute_path: filePath,
    name,
    basename,
    extension: extension.replace(".", ""),
    mime_type: getMimeType(extension),
    size: stat.size,
    mtime_ms: Math.round(stat.mtimeMs),
    directory,
    first_letter: getFirstLetter(name),
    collection_bucket: parsed.collectionBucket,
    code_prefix: parsed.codePrefix,
    code_number: parsed.codeNumber,
    normalized_code: existing?.normalized_code || parsed.normalizedCode || `LOCAL-${id.toUpperCase()}`,
    variant_tags: JSON.stringify(parsed.variantTags),
    quality_tag: parsed.qualityTag,
    media_type: mediaType,
    thumbnail_path: mediaType === "image" ? filePath : null,
    thumbnail_status: mediaType === "image" ? "ready" : "pending",
    duration_seconds: null,
    width: null,
    height: null,
    container_format: "",
    video_codec: "",
    audio_codec: "",
    compatibility_status: "unknown",
    probe_status: "pending",
    probe_error: null,
    probed_at: null,
    indexed_at: new Date().toISOString(),
    scan_token: scanToken
  };
}

async function indexSidecars(
  candidates: SidecarCandidate[],
  scanToken: string,
  availableRoots: string[]
): Promise<number> {
  const upsert = db.prepare(`
    INSERT INTO media_sidecars (
      id, media_id, kind, absolute_path, relative_path, language, label,
      format, size, mtime_ms, scan_token, created_at, updated_at
    ) VALUES (
      @id, @mediaId, @kind, @absolutePath, @relativePath, @language, @label,
      @format, @size, @mtimeMs, @scanToken, @now, @now
    )
    ON CONFLICT(media_id, absolute_path) DO UPDATE SET
      relative_path = excluded.relative_path,
      language = excluded.language,
      label = excluded.label,
      format = excluded.format,
      size = excluded.size,
      mtime_ms = excluded.mtime_ms,
      scan_token = excluded.scan_token,
      updated_at = excluded.updated_at
  `);
  let indexed = 0;

  for (const candidate of candidates) {
    const extension = path.extname(candidate.filePath).toLowerCase();
    const sourceRelativePath = normalizeRelativePath(candidate.source, candidate.filePath);
    const directory = path.dirname(sourceRelativePath) === "." ? "" : path.dirname(sourceRelativePath);
    const sidecarBase = path.basename(candidate.filePath, extension);
    const findInDirectory = (mediaDirectory: string) => {
      const rows = db.prepare(`
        SELECT id, basename, normalized_code FROM media_files
        WHERE library_category = ? AND source_name = ? AND directory = ?
          AND media_type = 'video' AND scan_token = ?
      `).all(candidate.source.category, candidate.source.name, mediaDirectory, scanToken) as SidecarMedia[];
      return selectSidecarMedia(sidecarBase, rows);
    };
    let media = findInDirectory(directory);
    // Common media-server layouts keep subtitles in Subs/ or Subtitles/ next
    // to the video. Never search unrelated directories or the whole library.
    if (!media && extension !== ".nfo" && /^(subs|subtitles)$/i.test(path.basename(directory))) {
      const parent = path.dirname(directory);
      media = findInDirectory(parent === "." ? "" : parent);
    }

    if (!media) continue;
    const stat = await fs.stat(candidate.filePath);
    const language = getSidecarLanguage(sidecarBase);
    const now = new Date().toISOString();
    upsert.run({
      id: crypto.createHash("sha1").update(`${media.id}:${candidate.filePath}`).digest("hex").slice(0, 20),
      mediaId: media.id,
      kind: extension === ".nfo" ? "metadata" : "subtitle",
      absolutePath: candidate.filePath,
      relativePath: `${candidate.source.category}/${candidate.source.name}/${sourceRelativePath}`,
      language: language.language,
      label: language.label || sidecarBase,
      format: extension.slice(1),
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
      scanToken,
      now
    });
    indexed += 1;
  }

  if (availableRoots.length > 0) {
    const placeholders = availableRoots.map(() => "?").join(", ");
    db.prepare(`
      DELETE FROM media_sidecars
      WHERE scan_token != ?
        AND media_id IN (
          SELECT id FROM media_files WHERE source_root IN (${placeholders})
        )
    `).run(scanToken, ...availableRoots);
  }
  return indexed;
}

function roundedStat(stat: Stats): Pick<ScanDirectorySnapshot, "mtimeMs" | "ctimeMs" | "size" | "ino"> {
  return {
    mtimeMs: Math.round(stat.mtimeMs),
    ctimeMs: Math.round(stat.ctimeMs),
    size: stat.size,
    ino: stat.ino
  };
}

function sameDirectoryStat(snapshot: ScanDirectorySnapshot, stat: Stats): boolean {
  const current = roundedStat(stat);
  return (
    snapshot.mtimeMs === current.mtimeMs &&
    snapshot.ctimeMs === current.ctimeMs &&
    snapshot.size === current.size &&
    snapshot.ino === current.ino
  );
}

function toSnapshotFile(name: string, kind: ScanSnapshotFile["kind"], stat: Stats): ScanSnapshotFile {
  return { name, kind, ...roundedStat(stat) };
}

function sameSnapshotFile(snapshot: ScanSnapshotFile, stat: Stats): boolean {
  const current = roundedStat(stat);
  return (
    snapshot.size === current.size &&
    snapshot.mtimeMs === current.mtimeMs &&
    snapshot.ctimeMs === current.ctimeMs &&
    snapshot.ino === current.ino
  );
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function parseFullScanIntervalMs(value: string | undefined): number {
  const hours = Number.parseFloat(value ?? "168");
  return Number.isFinite(hours) && hours >= 0 ? hours * 60 * 60 * 1000 : 168 * 60 * 60 * 1000;
}

function envForcesFullScan(): boolean {
  return ["1", "true", "yes"].includes((process.env.SCAN_FORCE_FULL ?? "").trim().toLowerCase());
}

function trustsStableDirectorySnapshots(): boolean {
  const value = (process.env.SCAN_TRUST_DIRECTORY_MTIME ?? "true").trim().toLowerCase();
  return !["0", "false", "no"].includes(value);
}

export async function scanMediaLibrary(options: ScanOptions = {}): Promise<ScanSummary> {
  ensureLibraryIdentitySchema(db);
  const oldIds = new Set((db.prepare("SELECT id FROM media_files").all() as Array<{ id: string }>).map(row => row.id));
  const startedAt = new Date().toISOString();
  const scanToken = crypto.randomUUID();
  const sources = getMediaSources();
  const sourceStatuses = sources.map(inspectStorageSource);
  const availableSources = sourceStatuses
    .filter((source) => source.readable)
    .map(({ state: _state, readable: _readable, mountPoint: _mountPoint, errorCode: _errorCode, message: _message, ...source }) => source);
  const unavailableSources = sourceStatuses.filter((source) => !source.readable);
  if (availableSources.length === 0) {
    throw new Error(
      `No configured media source is readable: ${unavailableSources.map((source) => `${source.name} ${source.message}`).join("; ")}`
    );
  }
  const sourcesFingerprint = fingerprintScanSources(sources);
  const snapshotLoad = await loadScanSnapshot(config.dataDir);
  let indexed = 0;
  let unchanged = 0;
  let changed = 0;
  let directoriesRead = 0;
  let directoriesSkipped = 0;
  let filesReused = 0;
  let initialReady = false;
  const report = (phase: ScanProgress["phase"], completed = 0, total = 0) =>
    options.onProgress?.({ phase, indexed, completed, total, initialReady });
  report("discovering");
  const sidecarCandidates: SidecarCandidate[] = [];
  const existingRows = new Map(
    (db.prepare("SELECT relative_path, absolute_path, source_root, size, mtime_ms FROM media_files WHERE id NOT IN (SELECT media_id FROM library_availability WHERE available=0)").all() as Array<{
      relative_path: string;
      absolute_path: string;
      source_root: string;
      size: number;
      mtime_ms: number;
    }>).map((row) => [row.relative_path, row])
  );
  const existingPaths = new Set(existingRows.keys());
  const fullScanIntervalMs = options.fullScanIntervalMs ?? parseFullScanIntervalMs(
    process.env.SCAN_SNAPSHOT_FULL_INTERVAL_HOURS
  );
  let fullScanReason = "";

  // Incremental scanning is allowed only when the source identity, persisted directory
  // inventory, and current database agree. Every uncertainty takes the full-scan path.
  if (options.forceFull || envForcesFullScan()) {
    fullScanReason = "forced";
  } else if (!snapshotLoad.snapshot) {
    fullScanReason = `snapshot-${snapshotLoad.reason}`;
  } else if (snapshotLoad.snapshot.sourcesFingerprint !== sourcesFingerprint) {
    fullScanReason = "source-configuration-changed";
  } else if (!setsEqual(getSnapshotMediaPaths(snapshotLoad.snapshot), existingPaths)) {
    fullScanReason = "snapshot-database-mismatch";
  } else {
    const lastFullScanAt = Date.parse(snapshotLoad.snapshot.lastFullScanAt);
    if (
      !Number.isFinite(lastFullScanAt) ||
      fullScanIntervalMs === 0 ||
      Date.now() - lastFullScanAt >= fullScanIntervalMs
    ) {
      fullScanReason = "periodic-validation-due";
    }
  }

  const scanMode: ScanSummary["scanMode"] = fullScanReason ? "full" : "incremental";
  const previousSnapshot = scanMode === "incremental" ? snapshotLoad.snapshot : null;
  const nextSources: Record<string, ScanSourceSnapshot> = {};

  const upsertMany = db.transaction((rows: MediaRow[]) => {
    for (const row of rows) {
      statements.upsertMedia.run(row);
    }
  });
  const touchMany = db.transaction((relativePaths: string[]) => {
    const touch = db.prepare("UPDATE media_files SET scan_token = ? WHERE relative_path = ?");
    for (const relativePath of relativePaths) touch.run(scanToken, relativePath);
  });

  async function scanSource(source: MediaSource): Promise<ScanSummary["roots"][number]> {
    const rootStat = await fs.stat(source.root);
    if (!rootStat.isDirectory()) {
      throw new Error(`${source.name} is not a directory: ${source.root}`);
    }

    let sourceIndexed = 0;
    let batch: MediaRow[] = [];
    let unchangedBatch: string[] = [];
    const sourceKey = createScanSourceKey(source);
    const previousSource = previousSnapshot?.sources[sourceKey];
    const directories: Record<string, ScanDirectorySnapshot> = {};

    function flush(): void {
      if (batch.length > 0) {
        upsertMany(batch);
        batch = [];
      }
      if (unchangedBatch.length > 0) {
        touchMany(unchangedBatch);
        unchangedBatch = [];
      }
      report("discovering");
    }

    async function processMediaFile(filePath: string, stat: Stats): Promise<void> {
      const sourceRelativePath = normalizeRelativePath(source, filePath);
      const relativePath = `${source.category}/${source.name}/${sourceRelativePath}`;
      const existing = existingRows.get(relativePath);
      if (
        existing &&
        existing.size === stat.size &&
        existing.mtime_ms === Math.round(stat.mtimeMs) &&
        existing.source_root === source.root &&
        existing.absolute_path === filePath
      ) {
        unchangedBatch.push(relativePath);
        unchanged += 1;
        indexed += 1;
        sourceIndexed += 1;
        if (unchangedBatch.length >= 500) flush();
        return;
      }

      const row = await toMediaRow(source, filePath, scanToken, stat);
      if (!row) return;

      batch.push(row);
      changed += 1;
      indexed += 1;
      sourceIndexed += 1;

      if (batch.length >= 500) {
        flush();
      }
    }

    async function processSnapshotFile(
      directoryPath: string,
      snapshotFile: ScanSnapshotFile,
      stat: Stats
    ): Promise<void> {
      const filePath = path.join(directoryPath, snapshotFile.name);
      if (snapshotFile.kind === "sidecar") {
        sidecarCandidates.push({ source, filePath });
        return;
      }
      await processMediaFile(filePath, stat);
    }

    async function reuseSnapshotFile(
      directoryPath: string,
      snapshotFile: ScanSnapshotFile
    ): Promise<void> {
      const filePath = path.join(directoryPath, snapshotFile.name);
      if (snapshotFile.kind === "sidecar") {
        sidecarCandidates.push({ source, filePath });
        filesReused += 1;
        return;
      }

      const sourceRelativePath = normalizeRelativePath(source, filePath);
      const relativePath = `${source.category}/${source.name}/${sourceRelativePath}`;
      const existing = existingRows.get(relativePath);
      if (
        existing &&
        existing.size === snapshotFile.size &&
        existing.mtime_ms === snapshotFile.mtimeMs &&
        existing.source_root === source.root &&
        existing.absolute_path === filePath
      ) {
        unchangedBatch.push(relativePath);
        unchanged += 1;
        indexed += 1;
        sourceIndexed += 1;
        filesReused += 1;
        if (unchangedBatch.length >= 500) flush();
        return;
      }

      await processMediaFile(filePath, await fs.stat(filePath));
    }

    async function scanDirectory(
      directoryPath: string,
      relativeDirectory: string,
      knownDirectoryStat?: Stats
    ): Promise<void> {
      const directoryStat = knownDirectoryStat ?? await fs.stat(directoryPath);
      if (!directoryStat.isDirectory()) {
        throw new Error(`Expected a directory while scanning: ${directoryPath}`);
      }

      const previousDirectory = previousSource?.directories[relativeDirectory];
      if (previousDirectory && sameDirectoryStat(previousDirectory, directoryStat)) {
        const fileStats = new Map<string, Stats>();
        const childStats = new Map<string, Stats>();
        let cacheIsValid = true;

        // Stable snapshots avoid thousands of NAS stat calls. The periodic full scan remains
        // the safety net for filesystems that do not reliably propagate directory timestamps.
        try {
          if (!trustsStableDirectorySnapshots()) {
            for (const file of previousDirectory.files) {
              const stat = await fs.stat(path.join(directoryPath, file.name));
              if (!stat.isFile() || !sameSnapshotFile(file, stat)) {
                cacheIsValid = false;
                break;
              }
              fileStats.set(file.name, stat);
            }
          }
          if (cacheIsValid) {
            for (const child of previousDirectory.children) {
              const stat = await fs.stat(path.join(directoryPath, child));
              if (!stat.isDirectory()) {
                cacheIsValid = false;
                break;
              }
              childStats.set(child, stat);
            }
          }
        } catch {
          cacheIsValid = false;
        }

        if (cacheIsValid) {
          directoriesSkipped += 1;
          directories[relativeDirectory] = {
            ...roundedStat(directoryStat),
            files: previousDirectory.files,
            children: previousDirectory.children
          };
          for (const file of previousDirectory.files) {
            const knownStat = fileStats.get(file.name);
            if (knownStat) await processSnapshotFile(directoryPath, file, knownStat);
            else await reuseSnapshotFile(directoryPath, file);
          }
          for (const child of previousDirectory.children) {
            await scanDirectory(
              path.join(directoryPath, child),
              relativeDirectory ? `${relativeDirectory}/${child}` : child,
              childStats.get(child)
            );
          }
          return;
        }
      }

      directoriesRead += 1;
      const files: ScanSnapshotFile[] = [];
      const children: string[] = [];
      const entries = await fs.readdir(directoryPath, { withFileTypes: true });
      const videoNames = entries.filter(entry => entry.isFile() && supportedExtensions.has(path.extname(entry.name).toLowerCase()) && getMediaType(path.extname(entry.name).toLowerCase()) === "video").map(entry => entry.name);
      for (const entry of entries) {
        if (isLibraryArtwork(entry.name, videoNames)) continue;
        const filePath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
          children.push(entry.name);
          continue;
        }
        if (!entry.isFile()) continue;

        const extension = path.extname(entry.name).toLowerCase();
        const kind = sidecarExtensions.has(extension)
          ? "sidecar"
          : supportedExtensions.has(extension)
            ? "media"
            : null;
        if (!kind) continue;

        const stat = await fs.stat(filePath);
        files.push(toSnapshotFile(entry.name, kind, stat));
        if (kind === "sidecar") {
          sidecarCandidates.push({ source, filePath });
        } else {
          await processMediaFile(filePath, stat);
        }
      }

      files.sort((left, right) => left.name.localeCompare(right.name));
      children.sort((left, right) => left.localeCompare(right));
      directories[relativeDirectory] = {
        ...roundedStat(directoryStat),
        files,
        children
      };

      for (const child of children) {
        await scanDirectory(
          path.join(directoryPath, child),
          relativeDirectory ? `${relativeDirectory}/${child}` : child
        );
      }
    }

    await scanDirectory(source.root, "", rootStat);

    flush();
    nextSources[sourceKey] = {
      category: source.category,
      name: source.name,
      root: source.root,
      directories
    };
    return { name: `${source.category}:${source.name}`, root: source.root, indexed: sourceIndexed };
  }

  const sourceGroups = new Map<string, MediaSource[]>();
  for (const source of availableSources) {
    const storageRoot = path.dirname(source.root);
    sourceGroups.set(storageRoot, [...(sourceGroups.get(storageRoot) ?? []), source]);
  }
  const scannedRoots = (
    await Promise.all(
      [...sourceGroups.values()].map(async (sources) => {
        const results: ScanSummary["roots"] = [];
        for (const source of sources) results.push(await scanSource(source));
        return results;
      })
    )
  ).flat();
  const roots: ScanSummary["roots"] = [
    ...scannedRoots.map((root) => ({ ...root, state: "ready" as const, message: "已连接且可读取" })),
    ...unavailableSources.map((source) => ({
      name: `${source.category}:${source.name}`,
      root: source.root,
      indexed: 0,
      state: source.state,
      message: source.message
    }))
  ];

  const availableRoots = [...new Set(availableSources.map((source) => source.root))];
  db.prepare("UPDATE media_files SET normalized_code='LOCAL-' || UPPER(id) WHERE normalized_code=''").run();
  // A brand-new library has no historical IDs to reconcile. Make its local
  // metadata and subtitles available before reading every media byte for the
  // migration fingerprint. Existing libraries keep the conservative order.
  let sidecars = 0;
  if (oldIds.size === 0) {
    report("importing");
    await importLocalLibrary(scanToken);
    sidecars = await indexSidecars(sidecarCandidates, scanToken, availableRoots);
    enqueuePendingSubtitleJobs(500);
    initialReady = true;
    options.onInitialReady?.();
  }
  const identityRows = db.prepare("SELECT id,absolute_path,size,mtime_ms FROM media_files WHERE scan_token=?").all(scanToken) as Array<{ id: string; absolute_path: string; size: number; mtime_ms: number }>;
  report("fingerprinting", 0, identityRows.length);
  let fingerprinted = 0;
  for (const media of identityRows) {
    try { await recordFileIdentity(db, media); }
    catch (error) { console.warn("Identity fingerprint deferred", media.id, error instanceof Error ? error.message : String(error)); }
    report("fingerprinting", ++fingerprinted, identityRows.length);
  }
  report("finalizing");
  reconcileLibraryMoves(db, scanToken, oldIds);
  // Missing/offline sources retain their IDs and every dependent user record.
  // Removal is an explicit maintenance action, never a scan side effect.
  const removed = 0;
  if (!initialReady) {
    await importLocalLibrary(scanToken);
    sidecars = await indexSidecars(sidecarCandidates, scanToken, availableRoots);
    enqueuePendingSubtitleJobs(500);
  }
  const finishedAt = new Date().toISOString();
  const nextSnapshot: ScanSnapshot = {
    version: scanSnapshotVersion,
    generatedAt: finishedAt,
    lastFullScanAt:
      scanMode === "full" ? finishedAt : (previousSnapshot?.lastFullScanAt ?? finishedAt),
    sourcesFingerprint,
    sources: nextSources
  };
  let snapshotSaved = unavailableSources.length === 0;
  if (snapshotSaved) {
    try {
      await saveScanSnapshot(config.dataDir, nextSnapshot);
    } catch (error) {
      snapshotSaved = false;
      console.warn("Unable to persist scan snapshots; the next scan will use conservative fallback.", error);
    }
  } else {
    console.warn("Scan completed with unavailable sources; snapshot was not replaced and offline indexes were preserved.");
  }

  return {
    roots,
    indexed,
    sidecars,
    unchanged,
    changed,
    removed,
    scanMode,
    fullScanReason,
    directoriesRead,
    directoriesSkipped,
    filesReused,
    snapshotSaved,
    startedAt,
    finishedAt
  };
}
