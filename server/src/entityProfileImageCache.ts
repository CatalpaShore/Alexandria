import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Express } from "express";
import { config } from "./config.js";
import { db } from "./db.js";
import {
  isEntityImageCacheDecisionAccepted,
  isEntityImageAttributionAccepted,
  safePublicActorDirectoryImageUrl,
  safeOfficialAgencyImageUrl,
  type EntityExtendedProfile,
  type EntityImageAttribution,
  type EntityImageCacheDecision,
  type PublicEntityType
} from "./entityProfiles.js";
import { inspectExternalAiStorage } from "./externalAiStorage.js";

const CACHE_VERSION = 1;
const REQUESTED_THUMB_WIDTH = 720;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const DOWNLOAD_INTERVAL_MS = 1_500;
const MAX_DOWNLOAD_ATTEMPTS = 5;
const SHA1_PATTERN = /^[a-f0-9]{40}$/u;
const CACHE_KEY_PATTERN = /^[a-f0-9]{64}$/u;
const CONTENT_TYPE_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp"
};
let nextDownloadAt = 0;

type LicensedImagePayload = {
  imageUrl?: unknown;
  image?: unknown;
  licenseDecision?: unknown;
};

type EntityImageSource = {
  type: PublicEntityType;
  value: string;
  wikidataId: string;
  remoteUrl: string;
  attribution: EntityImageAttribution;
  sourceKind: "wikimedia-commons" | "official-agency" | "official-source" | "public-actor-directory";
  cacheDecision?: EntityImageCacheDecision;
};

export type EntityProfileImageCacheSidecar = {
  kind: "alexandria-entity-profile-image";
  schemaVersion: number;
  storageId: string;
  cacheKey: string;
  type: PublicEntityType;
  value: string;
  wikidataId: string;
  remoteUrl: string;
  requestedThumbWidth: number;
  attribution: EntityImageAttribution;
  sourceKind?: "wikimedia-commons" | "official-agency" | "official-source" | "public-actor-directory";
  cacheDecision?: EntityImageCacheDecision;
  rightsStatus?: EntityImageAttribution["rightsStatus"];
  contentType: keyof typeof CONTENT_TYPE_EXTENSION;
  sizeBytes: number;
  binarySha256: string;
  etag?: string;
  lastModified?: string;
  localModified: false;
  cachedAt: string;
  licenseVerifiedAt: string;
  nextCheckAt: string;
};

export type EntityProfileImageCacheResult = {
  status: "cached" | "already-cached" | "storage-unavailable" | "source-unavailable";
  type: PublicEntityType;
  value: string;
  cacheKey?: string;
  sizeBytes?: number;
  message?: string;
};

export function isEntityImageDownloadUrlAllowed(input: {
  sourceKind: "wikimedia-commons" | "official-agency" | "official-source" | "public-actor-directory";
  sourceUrl: string;
  responseUrl: string;
}): boolean {
  if (input.sourceKind === "wikimedia-commons") return Boolean(safeRemoteImageUrl(input.responseUrl));
  if (input.sourceKind === "public-actor-directory") {
    return Boolean(safePublicActorDirectoryImageUrl(input.sourceUrl, input.responseUrl));
  }
  return Boolean(safeOfficialAgencyImageUrl(input.sourceUrl, input.responseUrl));
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function safeRemoteImageUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "upload.wikimedia.org" ? url.toString() : "";
  } catch {
    return "";
  }
}

function safeCommonsSourceUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "commons.wikimedia.org" ? url.toString() : "";
  } catch {
    return "";
  }
}

function safeSha1(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SHA1_PATTERN.test(normalized) ? normalized : "";
}

function matchesImageMagic(bytes: Buffer, contentType: string): boolean {
  if (contentType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (contentType === "image/webp") return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

function inspectCacheStorage() {
  return inspectExternalAiStorage({
    enabled: config.externalAi.enabled,
    root: config.externalAi.root,
    markerFile: config.externalAi.markerFile,
    expectedStorageId: config.externalAi.expectedStorageId
  });
}

function cacheKeyForSource(source: Pick<EntityImageSource, "remoteUrl" | "attribution">): string {
  return crypto.createHash("sha256")
    .update(`${source.attribution.sourceUrl}|${safeSha1(source.attribution.sha1)}|${REQUESTED_THUMB_WIDTH}|${source.remoteUrl}`)
    .digest("hex");
}

function cacheDirectory(cacheKey: string): string {
  return path.join(config.externalAi.entityProfileImageCacheDir, cacheKey.slice(0, 2));
}

function sidecarPath(cacheKey: string): string {
  return path.join(cacheDirectory(cacheKey), `${cacheKey}.json`);
}

function imagePath(cacheKey: string, contentType: string): string {
  const extension = CONTENT_TYPE_EXTENSION[contentType];
  if (!extension) throw new Error(`Unsupported cached image content type: ${contentType}`);
  return path.join(cacheDirectory(cacheKey), `${cacheKey}.${extension}`);
}

function parseAttribution(value: unknown): EntityImageAttribution | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<EntityImageAttribution>;
  const sha1 = safeSha1(item.sha1);
  if (!sha1 || !safeCommonsSourceUrl(item.sourceUrl) || !item.fileName) return null;
  const rightsStatus = ["open-license", "public-domain", "restricted", "unknown"].includes(item.rightsStatus ?? "")
    ? item.rightsStatus
    : "unknown";
  return {
    ...item,
    sha1,
    sourceUrl: safeCommonsSourceUrl(item.sourceUrl),
    creator: item.creator || "unknown",
    license: item.license || "unknown",
    licenseUrl: item.licenseUrl || "",
    rightsStatus
  } as EntityImageAttribution;
}

function officialAttribution(input: {
  provider: string;
  sourceUrl: string;
  remoteUrl: string;
  payload: Record<string, unknown>;
}): EntityImageAttribution {
  let fileName = "official-profile-image";
  try { fileName = decodeURIComponent(new URL(input.remoteUrl).pathname.split("/").filter(Boolean).at(-1) ?? fileName); }
  catch { /* use stable fallback */ }
  return {
    fileName,
    sourceUrl: input.sourceUrl,
    creator: [input.payload.agency, input.payload.brandName, input.payload.organizationName]
      .find((value) => typeof value === "string" && value.trim()) as string ||
      (input.provider === "public-r18dev-actor" ? "R18.dev 演员索引" : input.provider),
    license: "unknown",
    licenseUrl: "",
    rightsStatus: "unknown",
    originalUrl: input.remoteUrl
  };
}

function sourceFromRow(row: {
  type: string;
  value: string;
  wikidataId: string;
  provider: string;
  sourceUrl: string;
  payloadJson: string;
} | undefined): EntityImageSource | null {
  if (!row || !["actor", "director", "maker", "label", "series"].includes(row.type)) return null;
  if (row.type === "director" && row.provider.includes("product-bridge")) return null;
  const payload = parseJson<LicensedImagePayload>(row.payloadJson, {});
  if (row.provider.startsWith("official-")) {
    const rawPayload = payload as Record<string, unknown>;
    const remoteUrl = safeOfficialAgencyImageUrl(row.sourceUrl, rawPayload.profileImageCandidateUrl);
    if (!remoteUrl) return null;
    return {
      type: row.type as PublicEntityType,
      value: row.value,
      wikidataId: row.wikidataId,
      remoteUrl,
      attribution: officialAttribution({ provider: row.provider, sourceUrl: row.sourceUrl, remoteUrl, payload: rawPayload }),
      sourceKind: row.provider.startsWith("official-agency-") ? "official-agency" : "official-source"
    };
  }
  if (row.type === "actor" && row.provider === "public-r18dev-actor") {
    const rawPayload = payload as Record<string, unknown>;
    const remoteUrl = safePublicActorDirectoryImageUrl(row.sourceUrl, rawPayload.profileImageCandidateUrl);
    if (!remoteUrl) return null;
    return {
      type: "actor",
      value: row.value,
      wikidataId: row.wikidataId,
      remoteUrl,
      attribution: officialAttribution({ provider: row.provider, sourceUrl: row.sourceUrl, remoteUrl, payload: rawPayload }),
      sourceKind: "public-actor-directory"
    };
  }
  const remoteUrl = safeRemoteImageUrl(payload.imageUrl);
  const attribution = parseAttribution(payload.image);
  if (row.provider !== "wikimedia-commons" || !isEntityImageCacheDecisionAccepted(payload.licenseDecision) ||
    !remoteUrl || !attribution || !isEntityImageAttributionAccepted(attribution, payload.licenseDecision)) return null;
  return {
    type: row.type as PublicEntityType,
    value: row.value,
    wikidataId: row.wikidataId,
    remoteUrl,
    attribution,
    sourceKind: "wikimedia-commons",
    cacheDecision: payload.licenseDecision
  };
}

function readCacheableSource(type: PublicEntityType, value: string): EntityImageSource | null {
  const rows = db.prepare(`
    SELECT sources.facet_type AS type, sources.facet_value AS value,
      profiles.wikidata_id AS wikidataId, sources.provider, sources.source_url AS sourceUrl,
      sources.payload_json AS payloadJson
    FROM entity_profile_sources sources
    JOIN entity_profiles profiles
      ON profiles.facet_type = sources.facet_type AND profiles.facet_value = sources.facet_value
    WHERE sources.facet_type = @type AND sources.facet_value = @value
      AND ((sources.provider = 'wikimedia-commons'
        AND (json_extract(sources.payload_json, '$.licenseDecision') = 'allowed-v1'
          OR (@researchImagePolicy = 1
            AND json_extract(sources.payload_json, '$.licenseDecision') = 'research-cache-v1')))
        OR (sources.provider LIKE 'official-%'
          AND json_extract(sources.payload_json, '$.profileImageCandidateUrl') != '')
        OR (sources.facet_type = 'actor' AND sources.provider = 'public-r18dev-actor'
          AND json_extract(sources.payload_json, '$.profileImageCandidateUrl') != ''))
    ORDER BY CASE WHEN sources.provider = 'wikimedia-commons' THEN 0 ELSE 1 END,
      sources.confidence DESC, sources.retrieved_at DESC
  `).all({
    type,
    value,
    researchImagePolicy: config.externalAi.entityProfileImagePolicy === "research" ? 1 : 0
  }) as Array<{ type: string; value: string; wikidataId: string; provider: string; sourceUrl: string; payloadJson: string }>;
  for (const row of rows) {
    const source = sourceFromRow(row);
    if (source) return source;
  }
  return null;
}

function readCacheSidecar(cacheKey: string): EntityProfileImageCacheSidecar | null {
  if (!CACHE_KEY_PATTERN.test(cacheKey)) return null;
  try {
    const sidecar = parseJson<EntityProfileImageCacheSidecar | null>(fs.readFileSync(sidecarPath(cacheKey), "utf8"), null);
    if (!sidecar || sidecar.kind !== "alexandria-entity-profile-image" || sidecar.schemaVersion !== CACHE_VERSION ||
      sidecar.cacheKey !== cacheKey ||
      ((sidecar.sourceKind ?? "wikimedia-commons") === "wikimedia-commons" && !safeSha1(sidecar.attribution?.sha1)) ||
      !CONTENT_TYPE_EXTENSION[sidecar.contentType]) return null;
    const file = imagePath(cacheKey, sidecar.contentType);
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() ? sidecar : null;
  } catch {
    return null;
  }
}

function profileImageRoute(type: PublicEntityType, value: string): string {
  return `/api/entities/${encodeURIComponent(type)}/${encodeURIComponent(value)}/profile-image`;
}

export function resolveEntityProfileImageUrl(profile: EntityExtendedProfile | null): EntityExtendedProfile | null {
  if (!profile?.imageUrl || !profile.imageAttribution) return profile;
  const isCommons = Boolean(safeSha1(profile.imageAttribution.sha1));
  const isOfficial = Boolean(safeOfficialAgencyImageUrl(profile.imageAttribution.sourceUrl, profile.imageUrl));
  const isPublicActorDirectory = profile.type === "actor" &&
    Boolean(safePublicActorDirectoryImageUrl(profile.imageAttribution.sourceUrl, profile.imageUrl));
  if (!isCommons && !isOfficial && !isPublicActorDirectory) return profile;
  return { ...profile, imageUrl: profileImageRoute(profile.type as PublicEntityType, profile.value) };
}

async function downloadEntityImage(source: EntityImageSource): Promise<Response> {
  for (let attempt = 0; attempt < MAX_DOWNLOAD_ATTEMPTS; attempt += 1) {
    const waitMs = Math.max(0, nextDownloadAt - Date.now());
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    let response: Response;
    try {
      response = await fetch(source.remoteUrl, {
        headers: { Accept: "image/webp,image/png,image/jpeg", "User-Agent": "AlexandriaArchive/0.1 (local entity image cache)" },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000)
      });
    } catch (error) {
      if (attempt === MAX_DOWNLOAD_ATTEMPTS - 1) throw error;
      nextDownloadAt = Date.now() + Math.min(30_000, 2_000 * 2 ** attempt);
      continue;
    }
    nextDownloadAt = Date.now() + DOWNLOAD_INTERVAL_MS;
    if (response.ok) {
      if (!isEntityImageDownloadUrlAllowed({
        sourceKind: source.sourceKind,
        sourceUrl: source.attribution.sourceUrl,
        responseUrl: response.url
      })) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("Entity image redirect resolved to an untrusted domain");
      }
      return response;
    }
    if (![429, 503].includes(response.status) || attempt === MAX_DOWNLOAD_ATTEMPTS - 1) {
      throw new Error(`Entity image download failed (${response.status})`);
    }
    await response.body?.cancel().catch(() => undefined);
    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    const retryMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? Math.min(30_000, retryAfterSeconds * 1000)
      : Math.min(30_000, 5_000 * 2 ** attempt);
    nextDownloadAt = Date.now() + retryMs;
  }
  throw new Error("Entity image download failed");
}

export async function cacheEntityProfileImage(type: PublicEntityType, value: string): Promise<EntityProfileImageCacheResult> {
  const source = readCacheableSource(type, value);
  if (!source) return { status: "source-unavailable", type, value, message: "没有符合当前策略的实体图片来源" };
  const cacheKey = cacheKeyForSource(source);
  const storage = inspectCacheStorage();
  if (!storage.ready || !storage.storageId) {
    return { status: "storage-unavailable", type, value, cacheKey, message: storage.message };
  }
  const existing = readCacheSidecar(cacheKey);
  if (existing) return { status: "already-cached", type, value, cacheKey, sizeBytes: existing.sizeBytes };

  const response = await downloadEntityImage(source);
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!CONTENT_TYPE_EXTENSION[contentType]) throw new Error(`Unsupported entity image type: ${contentType || "unknown"}`);
  const advertisedBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertisedBytes) && advertisedBytes > MAX_IMAGE_BYTES) throw new Error("Entity image exceeds the 12 MB cache limit");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("Entity image is empty or exceeds the 12 MB cache limit");
  if (!matchesImageMagic(bytes, contentType)) throw new Error("Entity image content does not match its declared type");

  const directory = cacheDirectory(cacheKey);
  fs.mkdirSync(directory, { recursive: true });
  const targetImagePath = imagePath(cacheKey, contentType);
  const targetSidecarPath = sidecarPath(cacheKey);
  const suffix = `${process.pid}-${crypto.randomUUID()}`;
  const temporaryImagePath = `${targetImagePath}.${suffix}.tmp`;
  const temporarySidecarPath = `${targetSidecarPath}.${suffix}.tmp`;
  const now = new Date();
  const sidecar: EntityProfileImageCacheSidecar = {
    kind: "alexandria-entity-profile-image",
    schemaVersion: CACHE_VERSION,
    storageId: storage.storageId,
    cacheKey,
    type,
    value,
    wikidataId: source.wikidataId,
    remoteUrl: source.remoteUrl,
    requestedThumbWidth: REQUESTED_THUMB_WIDTH,
    attribution: source.attribution,
    sourceKind: source.sourceKind,
    ...(source.cacheDecision ? { cacheDecision: source.cacheDecision } : {}),
    rightsStatus: source.attribution.rightsStatus ?? "unknown",
    contentType: contentType as keyof typeof CONTENT_TYPE_EXTENSION,
    sizeBytes: bytes.length,
    binarySha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}),
    ...(response.headers.get("last-modified") ? { lastModified: response.headers.get("last-modified")! } : {}),
    localModified: false,
    cachedAt: now.toISOString(),
    licenseVerifiedAt: now.toISOString(),
    nextCheckAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
  };
  try {
    fs.writeFileSync(temporaryImagePath, bytes, { flag: "wx" });
    fs.writeFileSync(temporarySidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, { flag: "wx" });
    fs.renameSync(temporaryImagePath, targetImagePath);
    fs.renameSync(temporarySidecarPath, targetSidecarPath);
  } finally {
    for (const temporaryPath of [temporaryImagePath, temporarySidecarPath]) {
      try { fs.unlinkSync(temporaryPath); } catch { /* already promoted or never created */ }
    }
  }
  return { status: "cached", type, value, cacheKey, sizeBytes: bytes.length };
}

export function registerEntityProfileImageRoutes(app: Express): void {
  app.get("/api/entities/:type/:value/profile-image", (req, res) => {
    const type = req.params.type as PublicEntityType;
    if (!["actor", "director", "maker", "label", "series"].includes(type)) {
      return void res.status(400).json({ error: "Unsupported entity type" });
    }
    const source = readCacheableSource(type, req.params.value.trim());
    if (!source) return void res.status(404).json({ error: "Cacheable image source not found" });
    const cacheKey = cacheKeyForSource(source);
    const storage = inspectCacheStorage();
    const sidecar = storage.ready ? readCacheSidecar(cacheKey) : null;
    if (!sidecar) {
      res.setHeader("Cache-Control", "private, no-store");
      return void res.redirect(307, source.remoteUrl);
    }
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.setHeader("Content-Type", sidecar.contentType);
    res.setHeader("ETag", `"${sidecar.binarySha256}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    return void res.sendFile(imagePath(cacheKey, sidecar.contentType), (error) => {
      if (!error) return;
      if (!res.headersSent) {
        res.setHeader("Cache-Control", "private, no-store");
        res.redirect(307, source.remoteUrl);
      } else {
        res.end();
      }
    });
  });
}
