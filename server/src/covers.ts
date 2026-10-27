import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { db } from "./db.js";

type CoverResult = {
  path: string;
  mimeType: string;
};

const MAX_COVER_BYTES = 8 * 1024 * 1024;
const COVER_REQUEST_TIMEOUT_MS = 15_000;
const COVER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const COVER_EXTENSIONS = ["jpg", "png", "webp", "gif", "avif"] as const;
const activeDownloads = new Map<string, Promise<CoverResult | null>>();
const memoryCache = new Map<string, CoverResult>();
const lastTouchCache = new Map<string, number>();

function getCoverHash(url: string): string {
  return crypto.createHash("sha256").update(url).digest("hex");
}

function getMimeExtension(mimeType: string): string {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase();

  if (normalized === "image/jpeg" || normalized === "image/jpg") return "jpg";
  if (normalized === "image/png") return "png";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/gif") return "gif";
  if (normalized === "image/avif") return "avif";

  return "jpg";
}

function inferMimeTypeFromPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  if (extension === ".avif") return "image/avif";

  return "image/jpeg";
}

function inferMimeTypeFromBytes(bytes: Buffer): string | null {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") {
    return "image/gif";
  }
  if (bytes.subarray(4, 12).toString("ascii") === "ftypavif") return "image/avif";

  return null;
}

function findCachedCover(url: string): CoverResult | null {
  const remembered = memoryCache.get(url);
  if (remembered && fs.existsSync(remembered.path)) {
    touchCoverCache(url, remembered);
    return remembered;
  }
  const hash = getCoverHash(url);

  if (!fs.existsSync(config.coverCacheDir)) return null;

  for (const extension of COVER_EXTENSIONS) {
    const filePath = path.join(config.coverCacheDir, `${hash}.${extension}`);
    if (!fs.existsSync(filePath)) continue;

    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) continue;

    const result = {
      path: filePath,
      mimeType: inferMimeTypeFromPath(filePath)
    };
    memoryCache.set(url, result);
    touchCoverCache(url, result);
    return result;
  }

  return null;
}

function touchCoverCache(url: string, cover: CoverResult): void {
  const previousTouch = lastTouchCache.get(url) ?? 0;
  if (Date.now() - previousTouch < 5 * 60 * 1000) return;
  lastTouchCache.set(url, Date.now());
  const now = new Date().toISOString();
  let bytes = 0;
  try {
    bytes = fs.statSync(cover.path).size;
  } catch {
    return;
  }
  db.prepare(
    `
    INSERT INTO asset_cache_index (
      cache_key, asset_type, path, bytes, source_signature, created_at, last_accessed_at
    ) VALUES (
      @cacheKey, 'cover', @path, @bytes, @sourceSignature, @now, @now
    )
    ON CONFLICT(cache_key) DO UPDATE SET
      path = excluded.path,
      bytes = excluded.bytes,
      source_signature = excluded.source_signature,
      last_accessed_at = excluded.last_accessed_at
  `
  ).run({
    cacheKey: `cover:${getCoverHash(url)}`,
    path: cover.path,
    bytes,
    sourceSignature: url,
    now
  });
}

function normalizeCoverUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function getCoverRequestHeaders(url: string): Record<string, string> {
  const parsedUrl = new URL(url);

  return {
    "User-Agent": COVER_USER_AGENT,
    Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Referer: `${parsedUrl.protocol}//${parsedUrl.hostname}/`
  };
}

async function downloadCover(url: string): Promise<CoverResult | null> {
  const cached = findCachedCover(url);
  if (cached) return cached;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COVER_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: getCoverRequestHeaders(url),
      signal: controller.signal
    });
    if (!response.ok) return null;

    const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_COVER_BYTES) return null;

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_COVER_BYTES) return null;

    fs.mkdirSync(config.coverCacheDir, { recursive: true });

    const responseMimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    const mimeType = responseMimeType.startsWith("image/")
      ? responseMimeType
      : inferMimeTypeFromBytes(bytes);
    if (!mimeType) return null;

    const extension = getMimeExtension(mimeType);
    const filePath = path.join(config.coverCacheDir, `${getCoverHash(url)}.${extension}`);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

    fs.writeFileSync(tempPath, bytes);
    fs.renameSync(tempPath, filePath);
    const result = {
      path: filePath,
      mimeType
    };
    memoryCache.set(url, result);
    touchCoverCache(url, result);
    return result;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function getCachedCover(url: string): CoverResult | null {
  const normalizedUrl = normalizeCoverUrl(url);
  return normalizedUrl ? findCachedCover(normalizedUrl) : null;
}

export async function ensureCachedCover(url: string): Promise<CoverResult | null> {
  const normalizedUrl = normalizeCoverUrl(url);
  if (!normalizedUrl) return null;

  const cached = findCachedCover(normalizedUrl);
  if (cached) return cached;

  const existingDownload = activeDownloads.get(normalizedUrl);
  if (existingDownload) return existingDownload;

  const download = downloadCover(normalizedUrl).finally(() => {
    activeDownloads.delete(normalizedUrl);
  });
  activeDownloads.set(normalizedUrl, download);

  return download;
}

export function enforceCoverCacheLimit(maxBytes = config.coverCacheMaxBytes): { removed: number; bytes: number } {
  const total = db
    .prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM asset_cache_index WHERE asset_type = 'cover'")
    .get() as { bytes: number };
  let bytes = total.bytes;
  let removed = 0;
  if (bytes <= maxBytes) return { removed, bytes };

  const rows = db
    .prepare(
      `
      SELECT cache_key AS cacheKey, path, bytes, source_signature AS sourceUrl
      FROM asset_cache_index
      WHERE asset_type = 'cover'
      ORDER BY last_accessed_at ASC
    `
    )
    .all() as Array<{ cacheKey: string; path: string; bytes: number; sourceUrl: string }>;

  for (const row of rows) {
    if (bytes <= maxBytes) break;
    try {
      fs.rmSync(row.path, { force: true });
    } catch {
      continue;
    }
    db.prepare("DELETE FROM asset_cache_index WHERE cache_key = ?").run(row.cacheKey);
    memoryCache.delete(row.sourceUrl);
    lastTouchCache.delete(row.sourceUrl);
    bytes -= row.bytes;
    removed += 1;
  }
  return { removed, bytes: Math.max(bytes, 0) };
}
