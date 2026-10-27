import crypto from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { db } from "./db.js";
import { assertIngestionStorageAccess } from "./ingestionStorage.js";

const videoExtensions = new Set([
  ".mp4", ".mkv", ".avi", ".wmv", ".mpg", ".mpeg", ".mov", ".m4v",
  ".ts", ".m2ts", ".flv", ".webm"
]);
const incompleteExtensions = new Set([
  ".xltd", ".aria2", ".part", ".crdownload", ".download", ".tmp", ".td"
]);
const ignoredPrefixes = new Set([
  "CH", "HD", "FHD", "H264", "H265", "UN", "UNCEN", "VID", "IMG", "PXL", "DSC", "PPV"
]);
const blockedPlatformKeywordPattern = /(?:^|[^a-z])(?:onlyfans|myfans|fansly|fanbox|patreon|fans)(?=$|[^a-z])/i;
const codeTerminatorSource = String.raw`(?=$|[^A-Za-z0-9]|(?:C|CH|U|UN|UNCEN|UNCENSORED|A|B|HHB|P(?:AR|RA)T\d+)$)`;

export type IngestionFilenameRisk =
  | "blocked-platform-keyword"
  | "descriptive-english-title"
  | "opaque-random-name";

export type IngestionRejectionReason = IngestionFilenameRisk | "invalid-code-boundary";

export type IngestionSource = {
  id: string;
  label: string;
  downloadRoot: string;
  libraryRoot: string;
};

export type IngestionMoveStats = {
  scanned: number;
  eligible: number;
  moved: number;
  unstable: number;
  unmatched: number;
  rejected: number;
  rejectionReasons: Partial<Record<IngestionRejectionReason, number>>;
  conflicts: number;
  failed: number;
};

type NormalizedCandidate = {
  category: "JAV" | "FC2";
  normalizedCode: string;
  normalizedName: string;
  bucket: string;
};

export type IngestionTargetResolution = {
  kind: "available" | "duplicate";
  targetPath: string;
  normalizedName: string;
  segment: number | null;
};

export async function filesAreIdentical(
  leftPath: string,
  rightPath: string,
  onProgress?: () => void
): Promise<boolean> {
  const [leftStat, rightStat] = await Promise.all([fs.stat(leftPath), fs.stat(rightPath)]);
  if (!leftStat.isFile() || !rightStat.isFile() || leftStat.size !== rightStat.size) return false;

  const [left, right] = await Promise.all([fs.open(leftPath, "r"), fs.open(rightPath, "r")]);
  const hashFile = async (file: Awaited<ReturnType<typeof fs.open>>, size: number): Promise<string> => {
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(16 * 1024 * 1024);
    let position = 0;
    while (position < size) {
      const length = Math.min(buffer.length, size - position);
      const result = await file.read(buffer, 0, length, position);
      if (result.bytesRead !== length) throw new Error("文件完整性比对期间发生短读");
      hash.update(buffer.subarray(0, result.bytesRead));
      position += result.bytesRead;
      onProgress?.();
    }
    return hash.digest("hex");
  };

  try {
    // Hash the files one after the other. Alternating small reads between two
    // locations on the same HDD/NAS volume causes severe seek thrashing for
    // multi-gigabyte duplicates, while sequential hashing retains a complete
    // byte-level verification without increasing collision risk in practice.
    const leftHash = await hashFile(left, leftStat.size);
    const rightHash = await hashFile(right, rightStat.size);
    return leftHash === rightHash;
  } finally {
    // Some NAS/SMB mounts can report a delayed close as ETIMEDOUT after every
    // requested byte has already been read successfully. Closing is cleanup,
    // so it must not turn a valid comparison into an ingestion failure.
    await Promise.allSettled([left.close(), right.close()]);
  }
}

function numberedIngestionName(candidate: NormalizedCandidate, segment: number): string {
  const extension = path.extname(candidate.normalizedName);
  const stem = path.basename(candidate.normalizedName, extension);
  let variantSuffix = stem.slice(candidate.normalizedCode.length);
  if (candidate.category === "FC2") variantSuffix = variantSuffix.replace(/^-\d+/, "");
  return `${candidate.normalizedCode}-${segment}${variantSuffix}${extension}`;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    if (code === "ENOENT") return false;
    throw error;
  }
}

export async function resolveIngestionTarget(
  sourcePath: string,
  requestedTargetPath: string,
  candidate: NormalizedCandidate,
  onProgress?: () => void
): Promise<IngestionTargetResolution> {
  if (!await pathExists(requestedTargetPath)) {
    return {
      kind: "available",
      targetPath: requestedTargetPath,
      normalizedName: candidate.normalizedName,
      segment: candidate.category === "FC2" ? 1 : null
    };
  }
  if (await filesAreIdentical(sourcePath, requestedTargetPath, onProgress)) {
    return {
      kind: "duplicate",
      targetPath: requestedTargetPath,
      normalizedName: path.basename(requestedTargetPath),
      segment: candidate.category === "FC2" ? 1 : null
    };
  }

  for (let segment = 2; segment <= 999; segment += 1) {
    const normalizedName = numberedIngestionName(candidate, segment);
    const targetPath = path.join(path.dirname(requestedTargetPath), normalizedName);
    if (!await pathExists(targetPath)) {
      return { kind: "available", targetPath, normalizedName, segment };
    }
    if (await filesAreIdentical(sourcePath, targetPath, onProgress)) {
      return { kind: "duplicate", targetPath, normalizedName, segment };
    }
  }

  throw new Error(`同一番号已存在过多片段，无法分配安全尾缀：${candidate.normalizedCode}`);
}

function cleanWrappedBasename(value: string): string {
  const afterAt = value.includes("@") ? value.slice(value.lastIndexOf("@") + 1) : value;
  return afterAt
    .replace(/^\[[^\]]+\]/, "")
    .replace(/^[A-Za-z0-9._-]+\.(?:com|net|org|xyz|cc|la)[-_]/i, "")
    .replace(/%20/g, " ")
    .trim();
}

function variantMarkers(value: string): string[] {
  const markers: string[] = [];
  if (/(?:^|[-_.\s\d])(C|CH|中字|中文)(?:$|[-_.\s])/i.test(value)) markers.push("C");
  if (/(?:^|[-_.\s\d])(U|UN|UNCEN|UNCENSORED|无码)(?:$|[-_.\s])/i.test(value)) markers.push("U");
  return markers;
}

function isOpaqueRandomName(value: string, normalizedCode: string): boolean {
  const prefix = normalizedCode.split("-", 1)[0] ?? "";
  const compactStem = value.replace(/[^A-Za-z0-9+/=]/g, "");
  const hasEncodedBlob = /[A-Za-z0-9+/]{32,}={0,2}/.test(value);
  const hasUuid = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/i.test(value);
  const hasLongMixedToken = (value.match(/[A-Za-z0-9]{10,}/g) ?? []).some((token) =>
    /[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token)
  );
  if (value.length < 20 || compactStem.length < 16) return false;
  return hasEncodedBlob || hasUuid || (prefix.length === 2 && hasLongMixedToken);
}

export function getIngestionFilenameRisk(
  filename: string,
  normalizedCode = ""
): IngestionFilenameRisk | null {
  const extension = path.extname(filename);
  const basename = cleanWrappedBasename(path.basename(filename, extension));
  if (blockedPlatformKeywordPattern.test(basename)) return "blocked-platform-keyword";
  if (isOpaqueRandomName(basename, normalizedCode)) return "opaque-random-name";

  const latinWords = basename.match(/[A-Za-z]{3,}/g) ?? [];
  const latinLetters = (basename.match(/[A-Za-z]/g) ?? []).length;
  if (basename.length >= 55 && latinWords.length >= 7 && latinLetters >= 35) {
    return "descriptive-english-title";
  }
  return null;
}

export function getIngestionRejectionReason(
  filename: string,
  knownPrefixes: ReadonlySet<string>
): IngestionRejectionReason | null {
  const risk = getIngestionFilenameRisk(filename);
  if (risk) return risk;

  const extension = path.extname(filename);
  const basename = cleanWrappedBasename(path.basename(filename, extension));
  if (/FC2\s*[-_. ]*\d{4,}/i.test(basename)) return "invalid-code-boundary";

  for (const prefix of [...knownPrefixes].sort((left, right) => right.length - left.length)) {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`${escaped}[-_ ]?\\d{1,12}`, "i").test(basename)) {
      return "invalid-code-boundary";
    }
  }
  return null;
}

export function normalizeIngestionFilename(
  filename: string,
  knownPrefixes: ReadonlySet<string>
): NormalizedCandidate | null {
  const extension = path.extname(filename);
  const basename = cleanWrappedBasename(path.basename(filename, extension));
  if (getIngestionFilenameRisk(filename)) return null;
  const markers = variantMarkers(` ${basename} `);
  const markerSuffix = markers.map((marker) => `-${marker}`).join("");
  const fc2Match = basename.match(/FC2\s*[-_. ]*\s*PPV\s*[-_. ]*\s*(\d{3,9})(.*)$/i);
  if (fc2Match) {
    const number = fc2Match[1];
    const tail = fc2Match[2] ?? "";
    const partMatch = tail.match(/(?:^|[-_. ])(\d{1,2})(?:$|[-_. ])/);
    const part = Number.parseInt(partMatch?.[1] ?? "1", 10);
    const normalizedCode = `FC2-PPV-${number}`;
    return {
      category: "FC2",
      normalizedCode,
      normalizedName: `${normalizedCode}-${Math.max(1, part)}${markerSuffix}${extension}`,
      bucket: number.slice(0, 1)
    };
  }

  const candidates = [...basename.matchAll(new RegExp(
    String.raw`(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9})\s*[-_ ]?\s*(\d{2,7})${codeTerminatorSource}`,
    "gi"
  ))]
    .map((candidate) => ({ prefix: candidate[1].toUpperCase(), number: candidate[2], index: candidate.index ?? 0 }))
    .filter((candidate) => !ignoredPrefixes.has(candidate.prefix) && knownPrefixes.has(candidate.prefix));
  for (const prefix of [...knownPrefixes].sort((left, right) => right.length - left.length)) {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const knownMatch = basename.match(new RegExp(
      `(?:^|[^A-Za-z0-9])(${escaped})[-_ ]?(\\d{1,7})${codeTerminatorSource}`,
      "i"
    ));
    if (knownMatch) {
      candidates.push({ prefix, number: knownMatch[2], index: knownMatch.index ?? 0 });
    }
    const numberedStudioMatch = basename.match(new RegExp(
      `(?:^|[^A-Za-z0-9])\\d{3}(${escaped})[-_ ]?(\\d{1,7})${codeTerminatorSource}`,
      "i"
    ));
    if (numberedStudioMatch) {
      candidates.push({ prefix, number: numberedStudioMatch[2], index: numberedStudioMatch.index ?? 0 });
    }
  }
  const match = candidates
    .sort((left, right) => right.index - left.index)[0];
  if (!match) return null;

  const unpadded = match.number.replace(/^0+(?=\d)/, "");
  const number = unpadded.length < 3 ? unpadded.padStart(3, "0") : unpadded;
  const normalizedCode = `${match.prefix}-${number}`;
  if (getIngestionFilenameRisk(filename, normalizedCode)) return null;
  return {
    category: "JAV",
    normalizedCode,
    normalizedName: `${normalizedCode}${markerSuffix}${extension}`,
    bucket: match.prefix.slice(0, 1)
  };
}

async function listFiles(root: string, onProgress?: () => void): Promise<string[]> {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    onProgress?.();
    const current = stack.pop();
    if (!current) continue;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  }
  return files;
}

async function hasIncompleteSibling(filePath: string): Promise<boolean> {
  const directory = path.dirname(filePath);
  const stem = path.basename(filePath, path.extname(filePath)).toLowerCase();
  try {
    const entries = await fs.readdir(directory);
    return entries.some((entry) => {
      const extension = path.extname(entry).toLowerCase();
      if (!incompleteExtensions.has(extension)) return false;
      const partialStem = path.basename(entry, extension).toLowerCase();
      return partialStem === stem || partialStem.startsWith(stem) || stem.startsWith(partialStem);
    });
  } catch {
    return true;
  }
}

async function removeEmptyParents(start: string, root: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  let current = path.resolve(start);
  while (current !== resolvedRoot && current.startsWith(`${resolvedRoot}${path.sep}`)) {
    try {
      await fs.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

function insertItem(input: {
  runId: string;
  sourceId: string;
  originalPath: string;
  originalName: string;
  candidate: NormalizedCandidate;
  targetPath: string;
  size: number;
  status: string;
  reason?: string;
  sourceMtimeMs?: number;
  targetMtimeMs?: number;
}): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO ingestion_items (
      id, run_id, source_id, original_path, original_name, normalized_name,
      normalized_code, category, target_path, size, status, reason, created_at, updated_at
      , source_mtime_ms, target_mtime_ms
    ) VALUES (
      @id, @runId, @sourceId, @originalPath, @originalName, @normalizedName,
      @normalizedCode, @category, @targetPath, @size, @status, @reason, @now, @now
      , @sourceMtimeMs, @targetMtimeMs
    )
  `).run({
    id,
    ...input,
    normalizedName: input.candidate.normalizedName,
    normalizedCode: input.candidate.normalizedCode,
    category: input.candidate.category,
    reason: input.reason ?? null,
    sourceMtimeMs: input.sourceMtimeMs ?? null,
    targetMtimeMs: input.targetMtimeMs ?? null,
    now
  });
  return id;
}

function refreshExistingDuplicateItem(input: {
  originalPath: string;
  candidate: NormalizedCandidate;
  targetPath: string;
  size: number;
  reason: string;
  sourceMtimeMs: number;
  targetMtimeMs: number;
}): boolean {
  const result = db.prepare(`
    UPDATE ingestion_items
    SET normalized_name = @normalizedName,
      normalized_code = @normalizedCode,
      category = @category,
      size = @size,
      reason = @reason,
      source_mtime_ms = @sourceMtimeMs,
      target_mtime_ms = @targetMtimeMs,
      updated_at = @now
    WHERE id = (
      SELECT id FROM ingestion_items
      WHERE original_path = @originalPath
        AND target_path = @targetPath
        AND status = 'conflict'
      ORDER BY updated_at DESC
      LIMIT 1
    )
  `).run({
    ...input,
    normalizedName: input.candidate.normalizedName,
    normalizedCode: input.candidate.normalizedCode,
    category: input.candidate.category,
    now: new Date().toISOString()
  });
  return result.changes > 0;
}

async function resolveCachedDuplicate(
  sourcePath: string,
  requestedTargetPath: string,
  candidate: NormalizedCandidate,
  sourceSize: number,
  sourceMtimeMs: number
): Promise<IngestionTargetResolution | null> {
  const rows = db.prepare(`
    SELECT target_path AS targetPath, size,
      source_mtime_ms AS sourceMtimeMs, target_mtime_ms AS targetMtimeMs,
      updated_at AS updatedAt
    FROM ingestion_items
    WHERE original_path = ? AND normalized_code = ? AND status = 'conflict'
    ORDER BY updated_at DESC
    LIMIT 10
  `).all(sourcePath, candidate.normalizedCode) as Array<{
    targetPath: string;
    size: number;
    sourceMtimeMs: number | null;
    targetMtimeMs: number | null;
    updatedAt: string;
  }>;
  for (const row of rows) {
    if (
      row.size !== sourceSize
      || path.dirname(row.targetPath) !== path.dirname(requestedTargetPath)
    ) continue;
    try {
      const target = await fs.stat(row.targetPath);
      if (!target.isFile() || target.size !== sourceSize) continue;
      const exactSnapshot = row.sourceMtimeMs === sourceMtimeMs
        && row.targetMtimeMs === target.mtimeMs;
      const verifiedAt = Date.parse(row.updatedAt);
      const safeLegacySnapshot = row.sourceMtimeMs === null
        && row.targetMtimeMs === null
        && Number.isFinite(verifiedAt)
        && sourceMtimeMs <= verifiedAt
        && target.mtimeMs <= verifiedAt;
      if (!exactSnapshot && !safeLegacySnapshot) continue;
      return {
        kind: "duplicate",
        targetPath: row.targetPath,
        normalizedName: path.basename(row.targetPath),
        segment: candidate.category === "FC2"
          ? Number.parseInt(path.basename(row.targetPath).match(/-(\d+)(?:-|\.)/)?.[1] ?? "1", 10)
          : null
      };
    } catch {
      // A missing or unreadable target invalidates the cache entry.
    }
  }
  return null;
}

function insertItemNotification(runId: string, itemId: string, createdAt = new Date().toISOString()): void {
  db.prepare(`
    INSERT OR IGNORE INTO ingestion_notifications (id, run_id, item_id, created_at)
    VALUES (?, ?, ?, ?)
  `).run(crypto.randomUUID(), runId, itemId, createdAt);
}

const rejectionReasonLabels: Record<IngestionRejectionReason, string> = {
  "blocked-platform-keyword": "命中 fans/OnlyFans/MyFans/Fansly/Fanbox 等非目标平台关键词",
  "descriptive-english-title": "长英文句子，不符合高置信番号文件名",
  "opaque-random-name": "Base64、UUID 或无序随机文件名",
  "invalid-code-boundary": "疑似番号嵌在其他字符中或缺少合法边界"
};

function insertRejectedItem(input: {
  runId: string;
  sourceId: string;
  originalPath: string;
  originalName: string;
  size: number;
  reason: IngestionRejectionReason;
}): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO ingestion_items (
      id, run_id, source_id, original_path, original_name, normalized_name,
      normalized_code, category, target_path, size, status,
      metadata_status, translation_status, reason, created_at, updated_at
    ) VALUES (
      @id, @runId, @sourceId, @originalPath, @originalName, '', '', '', '',
      @size, 'rejected', 'skipped', 'skipped', @reasonLabel, @now, @now
    )
  `).run({
    id: crypto.randomUUID(),
    ...input,
    reasonLabel: `安全拦截：${rejectionReasonLabels[input.reason]}`,
    now
  });
}

export async function moveIngestionFiles(options: {
  runId: string;
  sources: IngestionSource[];
  stableMinutes: number;
  limit?: number | null;
  onProgress?: (stats: Readonly<IngestionMoveStats>) => void;
}): Promise<IngestionMoveStats> {
  await assertIngestionStorageAccess(options.sources);
  const knownPrefixes = new Set(
    (db.prepare("SELECT DISTINCT code_prefix AS prefix FROM media_files WHERE code_prefix != ''").all() as Array<{ prefix: string }>)
      .map((row) => row.prefix.toUpperCase())
  );
  const stats: IngestionMoveStats = {
    scanned: 0,
    eligible: 0,
    moved: 0,
    unstable: 0,
    unmatched: 0,
    rejected: 0,
    rejectionReasons: {},
    conflicts: 0,
    failed: 0
  };
  const stableBefore = Date.now() - options.stableMinutes * 60_000;
  let lastProgressAt = 0;
  const reportProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressAt < 5_000) return;
    lastProgressAt = now;
    options.onProgress?.({
      ...stats,
      rejectionReasons: { ...stats.rejectionReasons }
    });
  };

  for (const source of options.sources) {
    const files = await listFiles(source.downloadRoot, reportProgress);
    for (const filePath of files) {
      if (options.limit && stats.moved >= options.limit) {
        reportProgress(true);
        return stats;
      }
      const extension = path.extname(filePath).toLowerCase();
      if (!videoExtensions.has(extension)) continue;
      stats.scanned += 1;
      reportProgress();
      const originalName = path.basename(filePath);
      const candidate = normalizeIngestionFilename(originalName, knownPrefixes);
      if (!candidate) {
        const rejectionReason = getIngestionRejectionReason(originalName, knownPrefixes);
        if (rejectionReason) {
          stats.rejected += 1;
          stats.rejectionReasons[rejectionReason] = (stats.rejectionReasons[rejectionReason] ?? 0) + 1;
          let size = 0;
          try {
            size = (await fs.stat(filePath)).size;
          } catch {
            // The rejection remains useful even when the file disappears during the scan.
          }
          insertRejectedItem({
            runId: options.runId,
            sourceId: source.id,
            originalPath: filePath,
            originalName,
            size,
            reason: rejectionReason
          });
          continue;
        }
        stats.unmatched += 1;
        continue;
      }
      stats.eligible += 1;

      let before;
      try {
        before = await fs.stat(filePath);
      } catch {
        stats.failed += 1;
        continue;
      }
      const targetRoot = path.join(source.libraryRoot, candidate.category === "FC2" ? "FC2" : "Japan");
      const targetPath = path.join(targetRoot, candidate.bucket, candidate.normalizedName);
      if (before.mtimeMs > stableBefore || await hasIncompleteSibling(filePath)) {
        stats.unstable += 1;
        insertItem({
          runId: options.runId, sourceId: source.id, originalPath: filePath,
          originalName: path.basename(filePath), candidate, targetPath, size: before.size,
          status: "waiting", reason: `文件尚未稳定 ${options.stableMinutes} 分钟或仍存在下载临时文件`
        });
        continue;
      }

      try {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        const finalStat = await fs.stat(filePath);
        if (finalStat.size !== before.size || finalStat.mtimeMs !== before.mtimeMs) {
          stats.unstable += 1;
          insertItem({
            runId: options.runId, sourceId: source.id, originalPath: filePath,
            originalName: path.basename(filePath), candidate, targetPath, size: finalStat.size,
            status: "waiting", reason: "移动前文件仍在变化"
          });
          continue;
        }
        const verifiedCandidate = normalizeIngestionFilename(path.basename(filePath), knownPrefixes);
        if (
          !verifiedCandidate
          || verifiedCandidate.normalizedCode !== candidate.normalizedCode
          || verifiedCandidate.normalizedName !== candidate.normalizedName
          || verifiedCandidate.category !== candidate.category
        ) {
          stats.rejected += 1;
          stats.rejectionReasons["invalid-code-boundary"] =
            (stats.rejectionReasons["invalid-code-boundary"] ?? 0) + 1;
          insertRejectedItem({
            runId: options.runId,
            sourceId: source.id,
            originalPath: filePath,
            originalName: path.basename(filePath),
            size: finalStat.size,
            reason: "invalid-code-boundary"
          });
          continue;
        }
        const target = await resolveCachedDuplicate(
          filePath,
          targetPath,
          verifiedCandidate,
          finalStat.size,
          finalStat.mtimeMs
        ) ?? await resolveIngestionTarget(filePath, targetPath, verifiedCandidate, reportProgress);
        const resolvedCandidate = { ...verifiedCandidate, normalizedName: target.normalizedName };
        if (target.kind === "duplicate") {
          stats.conflicts += 1;
          const reason = "目标中存在内容完全相同的文件，已保留源文件并跳过入库";
          const targetStat = await fs.stat(target.targetPath);
          if (refreshExistingDuplicateItem({
            originalPath: filePath,
            candidate: resolvedCandidate,
            targetPath: target.targetPath,
            size: before.size,
            reason,
            sourceMtimeMs: finalStat.mtimeMs,
            targetMtimeMs: targetStat.mtimeMs
          })) {
            continue;
          }
          const itemId = insertItem({
            runId: options.runId, sourceId: source.id, originalPath: filePath,
            originalName: path.basename(filePath), candidate: resolvedCandidate,
            targetPath: target.targetPath, size: before.size,
            status: "conflict", reason,
            sourceMtimeMs: finalStat.mtimeMs,
            targetMtimeMs: targetStat.mtimeMs
          });
          insertItemNotification(options.runId, itemId);
          continue;
        }
        await fs.rename(filePath, target.targetPath);
        const itemId = insertItem({
          runId: options.runId, sourceId: source.id, originalPath: filePath,
          originalName: path.basename(filePath), candidate: resolvedCandidate,
          targetPath: target.targetPath, size: before.size,
          status: "moved",
          reason: target.segment && target.segment > 1
            ? `同番号内容不同，已作为片段/版本 ${target.segment} 入库`
            : undefined
        });
        const now = new Date().toISOString();
        insertItemNotification(options.runId, itemId, now);
        db.prepare(`
          INSERT OR IGNORE INTO ingestion_history (normalized_code, ingested_at, source)
          VALUES (?, ?, 'automatic')
        `).run(resolvedCandidate.normalizedCode, now);
        stats.moved += 1;
        await removeEmptyParents(path.dirname(filePath), source.downloadRoot);
      } catch (error) {
        stats.failed += 1;
        const itemId = insertItem({
          runId: options.runId, sourceId: source.id, originalPath: filePath,
          originalName: path.basename(filePath), candidate, targetPath, size: before.size,
          status: "failed", reason: error instanceof Error ? error.message : "移动失败"
        });
        insertItemNotification(options.runId, itemId);
      }
    }
    reportProgress(true);
  }
  reportProgress(true);
  return stats;
}
