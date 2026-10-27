import fs from "node:fs";
import path from "node:path";
import { db, rebuildMediaSearchIndex, type MediaRow } from "./db.js";
import { readFavoriteKeys, writeFavoriteKeys } from "./favorites.js";
import { parseMediaName } from "./mediaName.js";
import { enqueueMetadataEnrichmentAfterCurrentRun } from "./metadata.js";

export class MediaRepairError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function assertInsideRoot(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new MediaRepairError("目标路径不在当前媒体源内", 400);
  }
}

function normalizeRequestedBasename(value: string, originalExtension: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || /[\\/\0]/.test(trimmed)) {
    throw new MediaRepairError("请输入有效的文件名，且不要包含路径分隔符", 400);
  }

  const suppliedExtension = path.extname(trimmed);
  if (suppliedExtension && suppliedExtension.slice(1).toLowerCase() !== originalExtension.toLowerCase()) {
    throw new MediaRepairError(`文件扩展名必须保持为 .${originalExtension}`, 400);
  }

  return suppliedExtension ? path.basename(trimmed, suppliedExtension) : trimmed;
}

function getTargetBucket(category: string, codePrefix: string, codeNumber: string): string {
  if (category === "FC2") return codeNumber.charAt(0);
  return codePrefix.charAt(0).toUpperCase();
}

export type RenameMediaResult = {
  id: string;
  oldName: string;
  newName: string;
  oldRelativePath: string;
  newRelativePath: string;
  normalizedCode: string;
  targetDirectory: string;
  metadataRefreshAccepted: boolean;
};

export type RemoveMediaResult = {
  id: string;
  name: string;
  oldRelativePath: string;
  destinationPath: string;
  destinationDirectory: string;
  normalizedCode: string;
};

const DOWNLOAD_FALLBACK_DIRECTORY = "AMW-Pending";

function getDownloadRoot(row: MediaRow): string {
  const volumeRoot = path.dirname(path.dirname(row.source_root));
  return path.join(volumeRoot, "Download");
}

function getDownloadDirectory(row: MediaRow): string {
  const categoryDirectory = row.library_category === "FC2" ? "FC2" : "Japan";
  return path.join(getDownloadRoot(row), categoryDirectory);
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function moveToDownloadWithFallback(row: MediaRow): { destinationDirectory: string; destinationPath: string } {
  const preferredDirectory = getDownloadDirectory(row);
  const preferredPath = path.join(preferredDirectory, row.name);
  if (fs.existsSync(preferredPath)) {
    throw new MediaRepairError("Download 目录中已存在同名文件，请先处理冲突", 409);
  }

  fs.mkdirSync(preferredDirectory, { recursive: true });
  try {
    fs.renameSync(row.absolute_path, preferredPath);
    return { destinationDirectory: preferredDirectory, destinationPath: preferredPath };
  } catch (error) {
    if (!isFileSystemError(error, "EPERM")) throw error;
  }

  const fallbackDirectory = path.join(getDownloadRoot(row), DOWNLOAD_FALLBACK_DIRECTORY);
  const fallbackPath = path.join(fallbackDirectory, row.name);
  if (fs.existsSync(fallbackPath)) {
    throw new MediaRepairError(`${DOWNLOAD_FALLBACK_DIRECTORY} 目录中已存在同名文件，请先处理冲突`, 409);
  }

  try {
    fs.mkdirSync(fallbackDirectory, { recursive: true });
    fs.renameSync(row.absolute_path, fallbackPath);
    return { destinationDirectory: fallbackDirectory, destinationPath: fallbackPath };
  } catch (error) {
    if (isFileSystemError(error, "EPERM")) {
      throw new MediaRepairError(
        `没有权限移动文件。已尝试 ${preferredDirectory} 和兜底目录 ${fallbackDirectory}`,
        403
      );
    }
    throw error;
  }
}

function removeOrphanedMetadata(normalizedCode: string): void {
  if (!normalizedCode) return;
  const remaining = db.prepare("SELECT COUNT(*) AS count FROM media_files WHERE normalized_code = ?").get(normalizedCode) as { count: number };
  if (remaining.count > 0) return;

  db.transaction(() => {
    db.prepare("DELETE FROM media_metadata_facets WHERE normalized_code = ?").run(normalizedCode);
    db.prepare("DELETE FROM metadata_overrides WHERE normalized_code = ?").run(normalizedCode);
    db.prepare("DELETE FROM media_metadata WHERE normalized_code = ?").run(normalizedCode);
  })();
}

export async function renameMediaAndRefreshMetadata(
  id: string,
  requestedBasename: string
): Promise<RenameMediaResult> {
  const row = db.prepare("SELECT * FROM media_files WHERE id = ?").get(id) as MediaRow | undefined;
  if (!row) throw new MediaRepairError("未找到对应的媒体文件", 404);

  const basename = normalizeRequestedBasename(requestedBasename, row.extension);
  const parsed = parseMediaName(basename, "");
  if (!parsed.codePrefix || !parsed.codeNumber) {
    throw new MediaRepairError("无法从新文件名识别有效番号", 400);
  }
  if (row.library_category === "FC2" && parsed.codePrefix !== "FC2") {
    throw new MediaRepairError("FC2 分类的文件名必须是 FC2 番号", 400);
  }
  if (row.library_category !== "FC2" && parsed.codePrefix === "FC2") {
    throw new MediaRepairError("JAV 分类不能改为 FC2 番号", 400);
  }

  const bucket = getTargetBucket(row.library_category, parsed.codePrefix, parsed.codeNumber);
  if (!bucket) throw new MediaRepairError("无法确定新番号的归档目录", 400);

  const newName = `${basename}.${row.extension}`;
  const targetDirectory = path.join(row.source_root, bucket);
  const targetPath = path.join(targetDirectory, newName);
  assertInsideRoot(row.source_root, row.absolute_path);
  assertInsideRoot(row.source_root, targetPath);
  if (targetPath === row.absolute_path) throw new MediaRepairError("文件名和存放目录没有变化", 400);
  if (!fs.existsSync(row.absolute_path)) throw new MediaRepairError("源文件不存在或媒体盘尚未挂载", 409);
  if (fs.existsSync(targetPath)) throw new MediaRepairError("目标目录中已存在同名文件", 409);

  const newDirectory = bucket;
  const newRelativePath = `${row.library_category}/${row.source_name}/${bucket}/${newName}`;
  const oldCode = row.normalized_code;
  const previousOrigin = oldCode
    ? db.prepare(`SELECT original_basename AS basename, original_relative_path AS relativePath
        FROM metadata_file_origins WHERE normalized_code = ?`).get(oldCode) as { basename: string; relativePath: string } | undefined
    : undefined;
  fs.mkdirSync(targetDirectory, { recursive: true });
  fs.renameSync(row.absolute_path, targetPath);

  try {
    const stat = fs.statSync(targetPath);
    db.transaction(() => {
      db.prepare(`
        INSERT OR IGNORE INTO metadata_file_origins
          (normalized_code, original_basename, original_relative_path, source_path, imported_at)
        VALUES (@normalizedCode, @originalBasename, @originalRelativePath, 'application:rename', @importedAt)
      `).run({
        normalizedCode: parsed.normalizedCode,
        originalBasename: previousOrigin?.basename || row.basename,
        originalRelativePath: previousOrigin?.relativePath || row.relative_path,
        importedAt: new Date().toISOString()
      });
      db.prepare(`
        UPDATE media_files
        SET relative_path = @relativePath,
            absolute_path = @absolutePath,
            name = @name,
            basename = @basename,
            mtime_ms = @mtimeMs,
            directory = @directory,
            first_letter = @firstLetter,
            collection_bucket = @collectionBucket,
            code_prefix = @codePrefix,
            code_number = @codeNumber,
            normalized_code = @normalizedCode,
            variant_tags = @variantTags,
            quality_tag = @qualityTag,
            indexed_at = @indexedAt
        WHERE id = @id
      `).run({
        id,
        relativePath: newRelativePath,
        absolutePath: targetPath,
        name: newName,
        basename,
        mtimeMs: Math.round(stat.mtimeMs),
        directory: newDirectory,
        firstLetter: row.library_category === "FC2" ? "#" : parsed.codePrefix.charAt(0).toUpperCase(),
        collectionBucket: bucket,
        codePrefix: parsed.codePrefix,
        codeNumber: parsed.codeNumber,
        normalizedCode: parsed.normalizedCode,
        variantTags: JSON.stringify(parsed.variantTags),
        qualityTag: parsed.qualityTag,
        indexedAt: new Date().toISOString()
      });
      db.prepare(`
        UPDATE playback_progress
        SET relative_path = @newRelativePath
        WHERE media_id = @id OR relative_path = @oldRelativePath
      `).run({ id, oldRelativePath: row.relative_path, newRelativePath });
    })();
  } catch (error) {
    try {
      fs.renameSync(targetPath, row.absolute_path);
    } catch (rollbackError) {
      console.error("Unable to roll back media rename:", rollbackError);
    }
    throw error;
  }

  const favorites = readFavoriteKeys();
  if (favorites.delete(row.relative_path)) {
    favorites.add(newRelativePath);
    writeFavoriteKeys(favorites);
  }

  if (oldCode !== parsed.normalizedCode) {
    removeOrphanedMetadata(oldCode);
  }

  rebuildMediaSearchIndex();
  enqueueMetadataEnrichmentAfterCurrentRun({
    force: true,
    limit: 1,
    category: row.library_category,
    codes: [parsed.normalizedCode],
    reason: "manual"
  }).catch((error) => console.error(`Metadata refresh failed for ${parsed.normalizedCode}:`, error));

  return {
    id,
    oldName: row.name,
    newName,
    oldRelativePath: row.relative_path,
    newRelativePath,
    normalizedCode: parsed.normalizedCode,
    targetDirectory,
    metadataRefreshAccepted: true
  };
}

export async function moveMediaBackToDownload(id: string): Promise<RemoveMediaResult> {
  const row = db.prepare("SELECT * FROM media_files WHERE id = ?").get(id) as MediaRow | undefined;
  if (!row) throw new MediaRepairError("未找到对应的媒体文件", 404);
  assertInsideRoot(row.source_root, row.absolute_path);
  if (!fs.existsSync(row.absolute_path)) throw new MediaRepairError("源文件不存在或媒体盘尚未挂载", 409);

  const { destinationDirectory, destinationPath } = moveToDownloadWithFallback(row);

  try {
    db.transaction(() => {
      db.prepare("DELETE FROM playback_progress WHERE media_id = ? OR relative_path = ?").run(id, row.relative_path);
      db.prepare("DELETE FROM media_files WHERE id = ?").run(id);
    })();
  } catch (error) {
    try {
      fs.renameSync(destinationPath, row.absolute_path);
    } catch (rollbackError) {
      console.error("Unable to roll back media removal:", rollbackError);
    }
    throw error;
  }

  const favorites = readFavoriteKeys();
  if (favorites.delete(row.relative_path)) writeFavoriteKeys(favorites);
  removeOrphanedMetadata(row.normalized_code);
  rebuildMediaSearchIndex();

  return {
    id,
    name: row.name,
    oldRelativePath: row.relative_path,
    destinationPath,
    destinationDirectory,
    normalizedCode: row.normalized_code
  };
}
