import fs from "node:fs";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { config } from "./config.js";

export type AssetIntegrityKind = "thumbnail" | "cover" | "derivative";

export type AssetIntegrityIssue = {
  kind: AssetIntegrityKind | "database";
  code: string;
  path?: string;
  reference?: string;
  detail: string;
};

export type AssetIntegrityBucket = {
  indexed: number;
  indexedBytes: number;
  present: number;
  missing: number;
  unsafePaths: number;
  scannedFiles: number;
  scannedBytes: number;
  orphanFiles: number;
  orphanBytes: number;
  orphanIndexEntries: number;
};

export type AssetIntegrityReport = {
  generatedAt: string;
  durationMs: number;
  readOnly: true;
  sampleLimit: number;
  truncatedIssueSamples: number;
  assets: Record<AssetIntegrityKind, AssetIntegrityBucket>;
  database: {
    orphanDerivatives: number;
    orphanSidecars: number;
    unlinkedMetadata: number;
    invalidThumbnailStates: number;
    duplicateAssetPaths: number;
  };
  traversal: {
    skippedSymlinks: number;
    unreadableEntries: number;
  };
  issues: AssetIntegrityIssue[];
};

export type AssetIntegrityOptions = {
  database: BetterSqlite3.Database;
  thumbnailDir?: string;
  coverCacheDir?: string;
  derivativeDir?: string;
  sampleLimit?: number;
  signal?: AbortSignal;
};

type PathRow = {
  id: string;
  path: string | null;
  bytes?: number;
  status?: string;
  mediaId?: string;
  assetType?: string;
  source?: string;
};

type DiskFile = {
  path: string;
  bytes: number;
};

const EMPTY_BUCKET = (): AssetIntegrityBucket => ({
  indexed: 0,
  indexedBytes: 0,
  present: 0,
  missing: 0,
  unsafePaths: 0,
  scannedFiles: 0,
  scannedBytes: 0,
  orphanFiles: 0,
  orphanBytes: 0,
  orphanIndexEntries: 0
});

function normalizeStoredPath(value: string): string {
  return path.resolve(value);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function fileStat(filePath: string): fs.Stats | null {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isSymbolicLink() ? null : stat;
  } catch {
    return null;
  }
}

async function* walkFiles(
  root: string,
  traversal: AssetIntegrityReport["traversal"],
  signal?: AbortSignal
): AsyncGenerator<DiskFile> {
  let directory: fs.Dir;
  try {
    directory = await fs.promises.opendir(root);
  } catch {
    traversal.unreadableEntries += 1;
    return;
  }

  try {
    for await (const entry of directory) {
      if (signal?.aborted) throw new Error("Asset integrity scan aborted");
      const entryPath = path.join(root, entry.name);
      if (entry.isSymbolicLink()) {
        traversal.skippedSymlinks += 1;
        continue;
      }
      if (entry.isDirectory()) {
        yield* walkFiles(entryPath, traversal, signal);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.promises.stat(entryPath);
        yield { path: entryPath, bytes: stat.size };
      } catch {
        traversal.unreadableEntries += 1;
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    traversal.unreadableEntries += 1;
  }
}

function countQuery(database: BetterSqlite3.Database, sql: string): number {
  return (database.prepare(sql).get() as { count: number }).count;
}

export async function generateAssetIntegrityReport(
  options: AssetIntegrityOptions
): Promise<AssetIntegrityReport> {
  const startedAt = Date.now();
  const roots: Record<AssetIntegrityKind, string> = {
    thumbnail: path.resolve(options.thumbnailDir ?? config.thumbnailDir),
    cover: path.resolve(options.coverCacheDir ?? config.coverCacheDir),
    derivative: path.resolve(options.derivativeDir ?? config.derivativeDir)
  };
  const sampleLimit = Math.max(0, Math.min(options.sampleLimit ?? 250, 5_000));
  const report: AssetIntegrityReport = {
    generatedAt: new Date().toISOString(),
    durationMs: 0,
    readOnly: true,
    sampleLimit,
    truncatedIssueSamples: 0,
    assets: {
      thumbnail: EMPTY_BUCKET(),
      cover: EMPTY_BUCKET(),
      derivative: EMPTY_BUCKET()
    },
    database: {
      orphanDerivatives: 0,
      orphanSidecars: 0,
      unlinkedMetadata: 0,
      invalidThumbnailStates: 0,
      duplicateAssetPaths: 0
    },
    traversal: {
      skippedSymlinks: 0,
      unreadableEntries: 0
    },
    issues: []
  };

  function issue(value: AssetIntegrityIssue): void {
    if (report.issues.length < sampleLimit) report.issues.push(value);
    else report.truncatedIssueSamples += 1;
  }

  const thumbnailRows = options.database.prepare(
    `SELECT id, thumbnail_path AS path, thumbnail_status AS status
     FROM media_files
     WHERE thumbnail_path IS NOT NULL OR thumbnail_status = 'ready'`
  );
  for (const row of thumbnailRows.iterate() as IterableIterator<PathRow>) {
    report.assets.thumbnail.indexed += 1;
    if (!row.path) {
      report.assets.thumbnail.missing += 1;
      report.database.invalidThumbnailStates += 1;
      issue({
        kind: "thumbnail",
        code: "ready-thumbnail-without-path",
        reference: row.id,
        detail: "Thumbnail is marked ready but has no stored path"
      });
      continue;
    }
    const storedPath = normalizeStoredPath(row.path);
    if (!isInside(roots.thumbnail, storedPath)) {
      report.assets.thumbnail.unsafePaths += 1;
      issue({
        kind: "thumbnail",
        code: "thumbnail-outside-root",
        path: storedPath,
        reference: row.id,
        detail: "Stored thumbnail path is outside the configured thumbnail directory"
      });
      continue;
    }
    const stat = fileStat(storedPath);
    if (!stat?.isFile()) {
      report.assets.thumbnail.missing += 1;
      issue({
        kind: "thumbnail",
        code: "missing-thumbnail",
        path: storedPath,
        reference: row.id,
        detail: "Database thumbnail reference does not resolve to a regular file"
      });
      continue;
    }
    report.assets.thumbnail.present += 1;
    report.assets.thumbnail.indexedBytes += stat.size;
  }

  const coverRows = options.database.prepare(
    `SELECT cache_key AS id, path, bytes, asset_type AS assetType, source_signature AS source
     FROM asset_cache_index
     WHERE asset_type = 'cover'`
  );
  const coverMetadataAssociation = options.database.prepare(
    `SELECT 1
     FROM media_metadata
     WHERE cover_url = ? OR thumb_url = ?
     UNION ALL
     SELECT 1
     FROM metadata_overrides
     WHERE instr(patch_json, ?) > 0
     LIMIT 1`
  );
  for (const row of coverRows.iterate() as IterableIterator<PathRow>) {
    report.assets.cover.indexed += 1;
    report.assets.cover.indexedBytes += Math.max(0, row.bytes ?? 0);
    const storedPath = row.path ? normalizeStoredPath(row.path) : "";
    if (!storedPath || !isInside(roots.cover, storedPath)) {
      report.assets.cover.unsafePaths += 1;
      issue({
        kind: "cover",
        code: "cover-index-outside-root",
        path: storedPath || undefined,
        reference: row.id,
        detail: "Cover cache index path is empty or outside the configured cover directory"
      });
    } else {
      const stat = fileStat(storedPath);
      if (!stat?.isFile()) {
        report.assets.cover.missing += 1;
        issue({
          kind: "cover",
          code: "missing-indexed-cover",
          path: storedPath,
          reference: row.id,
          detail: "Cover cache index points to a missing file"
        });
      } else {
        report.assets.cover.present += 1;
      }
    }
    if (!row.source || !coverMetadataAssociation.get(row.source, row.source, row.source)) {
      report.assets.cover.orphanIndexEntries += 1;
      issue({
        kind: "cover",
        code: "unlinked-cover-index",
        path: storedPath || undefined,
        reference: row.id,
        detail: "Cover index source URL is not referenced by current metadata"
      });
    }
  }

  const derivativeRows = options.database.prepare(
    `SELECT media_derivatives.id, media_derivatives.path, media_derivatives.bytes,
            media_derivatives.status, media_derivatives.media_id AS mediaId
     FROM media_derivatives
     UNION ALL
     SELECT 'storyboard-image:' || media_id, image_path, bytes, status, media_id
     FROM media_storyboards
     UNION ALL
     SELECT 'storyboard-cues:' || media_id, cues_path, 0, status, media_id
     FROM media_storyboards
     UNION ALL
     SELECT 'subtitle:' || sidecar_id, path, bytes, status, media_id
     FROM media_subtitle_cache`
  );
  for (const row of derivativeRows.iterate() as IterableIterator<PathRow>) {
    report.assets.derivative.indexed += 1;
    report.assets.derivative.indexedBytes += Math.max(0, row.bytes ?? 0);
    if (!row.path) {
      if (row.status === "ready") {
        report.assets.derivative.missing += 1;
        issue({
          kind: "derivative",
          code: "ready-derivative-without-path",
          reference: row.id,
          detail: "Derivative is marked ready but has no stored path"
        });
      }
      continue;
    }
    const storedPath = normalizeStoredPath(row.path);
    if (!isInside(roots.derivative, storedPath)) {
      report.assets.derivative.unsafePaths += 1;
      issue({
        kind: "derivative",
        code: "derivative-outside-root",
        path: storedPath,
        reference: row.id,
        detail: "Stored derivative path is outside the configured derivative directory"
      });
      continue;
    }
    const stat = fileStat(storedPath);
    if (!stat?.isFile()) {
      if (row.status === "ready") {
        report.assets.derivative.missing += 1;
        issue({
          kind: "derivative",
          code: "missing-ready-derivative",
          path: storedPath,
          reference: row.id,
          detail: "Ready derivative reference does not resolve to a regular file"
        });
      }
      continue;
    }
    report.assets.derivative.present += 1;
  }

  report.database.orphanDerivatives = countQuery(
    options.database,
    `SELECT COUNT(*) AS count FROM (
       SELECT media_id FROM media_derivatives
       UNION ALL SELECT media_id FROM media_storyboards
       UNION ALL SELECT media_id FROM media_subtitle_cache
     ) derivatives
     LEFT JOIN media_files ON media_files.id = derivatives.media_id
     WHERE media_files.id IS NULL`
  );
  report.database.orphanSidecars = countQuery(
    options.database,
    `SELECT COUNT(*) AS count FROM media_sidecars
     LEFT JOIN media_files ON media_files.id = media_sidecars.media_id
     WHERE media_files.id IS NULL`
  );
  report.database.unlinkedMetadata = countQuery(
    options.database,
    `SELECT COUNT(*) AS count FROM media_metadata
     WHERE normalized_code <> ''
       AND NOT EXISTS (
         SELECT 1 FROM media_files WHERE media_files.normalized_code = media_metadata.normalized_code
       )`
  );
  report.database.duplicateAssetPaths = countQuery(
    options.database,
    `SELECT COUNT(*) AS count FROM (
       SELECT path FROM asset_cache_index WHERE path <> '' GROUP BY path HAVING COUNT(*) > 1
     )`
  );

  if (report.database.orphanDerivatives > 0) {
    issue({
      kind: "database",
      code: "orphan-derivative-relations",
      detail: `${report.database.orphanDerivatives} derivative rows have no matching media row`
    });
  }
  if (report.database.orphanSidecars > 0) {
    issue({
      kind: "database",
      code: "orphan-sidecar-relations",
      detail: `${report.database.orphanSidecars} sidecar rows have no matching media row`
    });
  }

  const diskAssociation = {
    thumbnail: options.database.prepare("SELECT 1 FROM media_files WHERE thumbnail_path = ? LIMIT 1"),
    cover: options.database.prepare(
      "SELECT 1 FROM asset_cache_index WHERE asset_type = 'cover' AND path = ? LIMIT 1"
    ),
    derivative: options.database.prepare(
      `SELECT 1 FROM media_derivatives WHERE path = ?
       UNION ALL
       SELECT 1 FROM asset_cache_index WHERE asset_type LIKE 'derivative:%' AND path = ?
       UNION ALL
       SELECT 1 FROM media_storyboards WHERE image_path = ? OR cues_path = ?
       UNION ALL
       SELECT 1 FROM media_subtitle_cache WHERE path = ?
       LIMIT 1`
    )
  };

  for (const kind of ["thumbnail", "cover", "derivative"] as const) {
    for await (const file of walkFiles(roots[kind], report.traversal, options.signal)) {
      const bucket = report.assets[kind];
      bucket.scannedFiles += 1;
      bucket.scannedBytes += file.bytes;
      let associated = false;
      if (kind === "derivative") {
        associated = Boolean(diskAssociation.derivative.get(
          file.path,
          file.path,
          file.path,
          file.path,
          file.path
        ));
        if (!associated) {
          const manifestPath = path.join(path.dirname(file.path), "master.m3u8");
          associated = Boolean(diskAssociation.derivative.get(
            manifestPath,
            manifestPath,
            manifestPath,
            manifestPath,
            manifestPath
          ));
        }
      } else {
        associated = Boolean(diskAssociation[kind].get(file.path));
      }
      if (associated) continue;
      bucket.orphanFiles += 1;
      bucket.orphanBytes += file.bytes;
      issue({
        kind,
        code: "unindexed-asset-file",
        path: file.path,
        detail: "Asset file has no matching database reference"
      });
    }
  }

  const orphanDerivativeCache = countQuery(
    options.database,
    `SELECT COUNT(*) AS count
     FROM asset_cache_index
     WHERE asset_type LIKE 'derivative:%'
       AND NOT EXISTS (
         SELECT 1 FROM media_derivatives
         WHERE media_derivatives.id = asset_cache_index.cache_key
            OR media_derivatives.path = asset_cache_index.path
       )
       AND NOT EXISTS (
         SELECT 1 FROM media_storyboards
         WHERE ('storyboard:' || media_storyboards.media_id) = asset_cache_index.cache_key
            OR media_storyboards.image_path = asset_cache_index.path
       )`
  );
  report.assets.derivative.orphanIndexEntries = orphanDerivativeCache;
  if (orphanDerivativeCache > 0) {
    issue({
      kind: "derivative",
      code: "orphan-derivative-cache-index",
      detail: `${orphanDerivativeCache} derivative cache rows have no matching derivative record`
    });
  }

  report.durationMs = Date.now() - startedAt;
  return report;
}
