import crypto from "node:crypto";
import { config } from "./config.js";
import { db } from "./db.js";
import { getCanonicalActorName, isActorNameCandidate, normalizeActorIdentityKey } from "./actorAliases.js";

const WIKIMEDIA_USER_AGENT = "AlexandriaArchive/0.1 (local entity enrichment; contact: local-user)";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const WIKIDATA_ENTITY = "https://www.wikidata.org/wiki/Special:EntityData";
const WIKIMEDIA_COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const REQUEST_INTERVAL_MS = 750;
const MAX_REQUEST_ATTEMPTS = 5;
const ADULT_PERFORMER_OCCUPATION_IDS = new Set(["Q1079215"]);
let nextRequestAt = 0;

export type EntityProfileSource = {
  provider: string;
  title: string;
  url: string;
  license: string;
  language: string;
  fields: string[];
  confidence: number;
  retrievedAt: string;
  facts?: Record<string, unknown> & {
    heightCm?: number | null;
    measurements?: { bustCm?: number; waistCm?: number; hipsCm?: number; cup?: string };
    birthDate?: string | null;
  };
};

export type EntityImageAttribution = {
  fileName: string;
  sourceUrl: string;
  creator: string;
  creatorUrl?: string;
  license: string;
  licenseUrl: string;
  rightsStatus?: EntityImageRightsStatus;
  credit?: string;
  attributionText?: string;
  pageId?: number;
  sha1?: string;
  fileTimestamp?: string;
  attributionRequired?: boolean;
  copyrighted?: boolean;
  permissionSummary?: string;
  originalUrl?: string;
  contentType?: string;
  originalWidth?: number;
  originalHeight?: number;
  originalSizeBytes?: number;
  requestedThumbWidth?: number;
  thumbWidth?: number;
  thumbHeight?: number;
};

export type EntityProfileImagePolicy = "research" | "strict";
export type EntityImageCacheDecision = "allowed-v1" | "research-cache-v1";
export type EntityImageRightsStatus = "open-license" | "public-domain" | "restricted" | "unknown";

export function isEntityImageCacheDecisionAccepted(
  decision: unknown,
  policy: EntityProfileImagePolicy = config.externalAi.entityProfileImagePolicy
): decision is EntityImageCacheDecision {
  return decision === "allowed-v1" || (policy === "research" && decision === "research-cache-v1");
}

export type EntityExtendedProfile = {
  type: string;
  value: string;
  displayName: string;
  originalName?: string;
  names: Record<string, string>;
  aliases: string[];
  biography: string;
  birthDate: string | null;
  birthplace: string;
  nationality: string;
  heightCm: number | null;
  measurements: { bustCm?: number; waistCm?: number; hipsCm?: number; cup?: string };
  facts: Record<string, string | string[]>;
  occupations: string[];
  imageUrl: string;
  imageAttribution?: EntityImageAttribution | null;
  officialWebsite: string;
  socialLinks: Record<string, string>;
  externalIds: Record<string, string>;
  wikidataId: string;
  wikipediaUrl: string;
  status: "verified" | "auto-matched" | "auto-resolved" | "unverified";
  confidence: number;
  fetchedAt: string | null;
  updatedAt: string;
  sources: EntityProfileSource[];
};

const ENTITY_NAME_LOCALIZATION_COLUMNS: Partial<Record<PublicEntityType, {
  source: "director" | "maker" | "label" | "series";
  localized: "director_zh" | "maker_zh" | "label_zh" | "series_zh";
}>> = {
  director: { source: "director", localized: "director_zh" },
  maker: { source: "maker", localized: "maker_zh" },
  label: { source: "label", localized: "label_zh" },
  series: { source: "series", localized: "series_zh" }
};

const LOCALIZABLE_ENTITY_TYPES = new Set<PublicEntityType>([
  "actor", "director", "maker", "label", "series"
]);

const CHINESE_NAME_KEYS = ["zh-hans", "zh_cn", "zh-cn", "zh_hans", "zh"];

function normalizedLanguageNames(names: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(names).map(([key, value]) => [key.trim().toLocaleLowerCase(), value.trim()]));
}

function isEnglishOrAsciiEntityName(value: string): boolean {
  const normalized = value.normalize("NFKC").trim();
  return Boolean(normalized) && /[A-Za-z]/u.test(normalized)
    && !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(normalized);
}

function isChineseEntityNameCandidate(value: string): boolean {
  const normalized = value.normalize("NFKC").trim();
  return Boolean(normalized) && /\p{Script=Han}/u.test(normalized)
    && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(normalized);
}

function isNonJapaneseEntityNameCandidate(value: string): boolean {
  const normalized = value.normalize("NFKC").trim();
  return Boolean(normalized) && /[A-Za-z\p{Script=Han}]/u.test(normalized)
    && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(normalized);
}

export function chooseLocalizedEntityDisplayName(input: {
  type: string;
  storedDisplayName: string;
  names?: Record<string, string>;
  localizedCandidates?: string[];
}): string {
  const storedDisplayName = input.storedDisplayName.normalize("NFKC").trim();
  if (!LOCALIZABLE_ENTITY_TYPES.has(input.type as PublicEntityType)
    || isEnglishOrAsciiEntityName(storedDisplayName)) {
    return storedDisplayName;
  }
  const languageNames = normalizedLanguageNames(input.names ?? {});
  const persistedChineseNames = CHINESE_NAME_KEYS.map((key) => languageNames.get(key) ?? "");
  const metadataCandidates = input.localizedCandidates ?? [];
  const candidates = input.type === "actor"
    ? [...metadataCandidates, ...persistedChineseNames]
    : [...persistedChineseNames, ...metadataCandidates];
  const normalizedCandidates = candidates.map((value) => value.normalize("NFKC").trim()).filter(Boolean);
  const chineseName = normalizedCandidates.find(isChineseEntityNameCandidate);
  const japaneseSource = /[ぁ-ゖァ-ヺ]/u.test(storedDisplayName)
    || Boolean(languageNames.get("ja"))
    || /\p{Script=Han}/u.test(storedDisplayName);
  if (japaneseSource) {
    if (chineseName) return chineseName;
    // Official maker/label names are often Latin brands (for example MOODYZ,
    // PRESTIGE and Dream Ticket). When that value is deliberately persisted in
    // a Chinese-language slot, prefer it over leaving the Japanese alias in UI.
    if (input.type === "maker" || input.type === "label") {
      const officialBrandName = persistedChineseNames
        .map((value) => value.normalize("NFKC").trim())
        .find(isNonJapaneseEntityNameCandidate);
      if (officialBrandName) return officialBrandName;
    }
    return storedDisplayName;
  }
  return chineseName || normalizedCandidates.find(isNonJapaneseEntityNameCandidate) || storedDisplayName;
}

export function chooseEntityOriginalName(input: {
  facetValue: string;
  storedDisplayName: string;
  displayName: string;
  names?: Record<string, string>;
}): string | undefined {
  const displayName = input.displayName.normalize("NFKC").trim();
  const languageNames = normalizedLanguageNames(input.names ?? {});
  return [
    languageNames.get("ja") ?? "",
    languageNames.get("ja-jp") ?? "",
    input.facetValue,
    input.storedDisplayName
  ].map((value) => value.normalize("NFKC").trim())
    .find((value) => Boolean(value) && value !== displayName);
}

function getMetadataLocalizedEntityNames(
  type: string,
  identityNames: string[]
): string[] {
  const names = [...new Set(identityNames.flatMap((value) => {
    const trimmed = value.trim();
    const normalized = trimmed.normalize("NFKC");
    return [trimmed, normalized];
  }).filter(Boolean))];
  if (type === "actor" && names.length) {
    const placeholders = names.map(() => "?").join(", ");
    return (db.prepare(`
      SELECT TRIM(CAST(translated.value AS TEXT)) AS localizedName, COUNT(*) AS frequency
      FROM media_metadata metadata
      JOIN json_each(metadata.actors_json) source
      LEFT JOIN json_each(metadata.actors_zh_json) translated ON translated.key = source.key
      WHERE TRIM(CAST(source.value AS TEXT)) IN (${placeholders})
        AND TRIM(COALESCE(CAST(translated.value AS TEXT), '')) != ''
        AND metadata.status = 'ready' AND metadata.translation_status = 'ready'
      GROUP BY TRIM(CAST(translated.value AS TEXT))
      ORDER BY frequency DESC, localizedName COLLATE NOCASE ASC
    `).all(...names) as Array<{ localizedName: string }>).map((row) => row.localizedName);
  }
  const columns = ENTITY_NAME_LOCALIZATION_COLUMNS[type as PublicEntityType];
  if (!columns || !names.length) return [];
  const placeholders = names.map(() => "?").join(", ");
  return (db.prepare(`
    SELECT TRIM(${columns.localized}) AS localizedName, COUNT(*) AS frequency
    FROM media_metadata
    WHERE TRIM(${columns.source}) IN (${placeholders})
      AND TRIM(${columns.localized}) != ''
      AND status = 'ready' AND translation_status = 'ready'
    GROUP BY TRIM(${columns.localized})
    ORDER BY frequency DESC, localizedName COLLATE NOCASE ASC
  `).all(...names) as Array<{ localizedName: string }>).map((row) => row.localizedName);
}

export type EntityProfileCoverage = {
  total: number;
  enriched: number;
  verified: number;
  autoMatched: number;
  autoResolved: number;
  noMatch: number;
  failed: number;
  pending: number;
  coveragePercent: number;
  withBirthDate: number;
  withHeight: number;
  withMeasurements: number;
  withBiography: number;
  withImage: number;
  withWikipedia: number;
  withOfficialWebsite: number;
  withStructuredFacts: number;
};

export type EntityProfileCandidate = {
  value: string;
  aliases?: string[];
};

export type ActorProfileMissingField = "birth_date" | "height" | "measurements" | "cup" | "biography"
  | "image" | "wikipedia" | "official_website";
export type ActorProfileRankingMetric = "height" | "birth_date" | "bust" | "cup" | "measurements"
  | "biography" | "image" | "wikipedia" | "official_website" | "completeness" | "missing_fields";

export type ActorProfileRankingInput = {
  metric: ActorProfileRankingMetric;
  order?: "asc" | "desc";
  limit?: number;
  minHeightCm?: number;
  maxHeightCm?: number;
  birthYearFrom?: number;
  birthYearTo?: number;
  minBustCm?: number;
  maxBustCm?: number;
  minCupRank?: number;
  maxCupRank?: number;
  missingFields?: ActorProfileMissingField[];
};

export type ActorProfileRankingRow = {
  value: string;
  label: string;
  mediaCount: number;
  metricValue: number;
  detail: string;
};

export type PublicProfileRankingType = Extract<PublicEntityType, "director" | "maker" | "label" | "series">;
export type PublicProfileRankingMetric = "inception" | "completeness" | "official_website" | "wikipedia" | "image" | "public_profile"
  | "country" | "headquarters" | "parent_organization" | "related_maker";
export type PublicProfileRankingInput = {
  type: PublicProfileRankingType;
  metric: PublicProfileRankingMetric;
  order?: "asc" | "desc";
  limit?: number;
  filterValue?: string;
};
export type PublicProfileRankingRow = {
  value: string;
  label: string;
  mediaCount: number;
  metricValue: number;
  detail: string;
};

type WikidataSnak = {
  datatype?: string;
  datavalue?: { type?: string; value?: unknown };
};
type WikidataClaim = { rank?: string; mainsnak?: WikidataSnak };
type WikidataEntity = {
  id: string;
  labels?: Record<string, { value?: string }>;
  descriptions?: Record<string, { value?: string }>;
  aliases?: Record<string, Array<{ value?: string }>>;
  claims?: Record<string, WikidataClaim[]>;
  sitelinks?: Record<string, { title?: string; url?: string }>;
};

type EnrichmentPreview = {
  actorValue: string;
  matched: boolean;
  reason?: string;
  profile?: Omit<EntityExtendedProfile, "type" | "value" | "sources" | "updatedAt">;
  sources?: EntityProfileSource[];
  identityDecision?: { method: "exact-rule" | "local-ai"; reason: string };
};

export type PublicEntityType = "actor" | "director" | "maker" | "label" | "series";

export type PublicEntityNamePair = {
  sourceName: string;
  localizedName: string;
};

function publicEntityNameKey(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s\-_・·:：.．]+/gu, "");
}

/**
 * Builds a multilingual search set before public-source lookup. Metadata pairs
 * can form a short transitive bridge (original -> localized -> romanized), but
 * they are search hints only: the existing deterministic/AI identity decision
 * still has to accept one unique public entity before anything is persisted.
 */
export function buildPublicEntitySearchNames(
  type: Exclude<PublicEntityType, "actor">,
  seedNames: string[],
  metadataPairs: PublicEntityNamePair[] = [],
  persistedNames: string[] = []
): string[] {
  const expandIdentityNames = (names: string[]) => type === "director"
    ? expandActorIdentityNames(names)
    : [...new Set(names.map((name) => name.normalize("NFKC").trim()).filter(Boolean))];
  const expanded = expandIdentityNames([...seedNames, ...persistedNames]);
  const names = [...expanded];
  const keys = new Set(names.map(publicEntityNameKey).filter(Boolean));

  for (let pass = 0; pass < 3; pass += 1) {
    let changed = false;
    for (const pair of metadataPairs) {
      const pairNames = expandIdentityNames([pair.sourceName, pair.localizedName]);
      const pairKeys = pairNames.map(publicEntityNameKey).filter(Boolean);
      if (!pairKeys.some((key) => keys.has(key))) continue;
      for (const name of pairNames) {
        const key = publicEntityNameKey(name);
        if (!key || keys.has(key)) continue;
        keys.add(key);
        names.push(name);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const unique = [...new Map(names.map((name) => [publicEntityNameKey(name), name.trim()]))
    .values()].filter(Boolean);
  const kana = unique.filter((name) => /[\u3040-\u30ff]/u.test(name));
  const han = unique.filter((name) => !/[\u3040-\u30ff]/u.test(name) && /[\u3400-\u9fff]/u.test(name));
  const latin = unique.filter((name) => /[a-z]/iu.test(name) && !/[\u3040-\u30ff\u3400-\u9fff]/u.test(name));
  const other = unique.filter((name) => !kana.includes(name) && !han.includes(name) && !latin.includes(name));

  // Keep the canonical source name first, then guarantee that Japanese,
  // localized Han, and Roman/Latin variants survive downstream query limits.
  return [...new Set([
    unique[0],
    kana[0],
    han[0],
    latin[0],
    ...unique,
    ...other
  ].filter((name): name is string => Boolean(name)))];
}

export type PublicEntityEnrichmentPreview = {
  type: PublicEntityType;
  value: string;
  matched: boolean;
  reason?: string;
  profile?: Omit<EntityExtendedProfile, "type" | "value" | "sources" | "updatedAt">;
  sources?: EntityProfileSource[];
  identityDecision?: { method: "exact-rule" | "local-ai"; reason: string };
};

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

const GENERIC_ENTITY_BIOGRAPHY_LOCALIZATIONS = new Map<string, string>([
  ["av idol", "AV女优。"],
  ["japanese av idol", "日本AV女优。"],
  ["japanese av actress", "日本AV女优。"],
  ["japanese pornographic actress", "日本AV女优。"],
  ["japanese av director", "日本AV导演。"],
  ["japanese av idol and actress", "日本AV女优、演员。"],
  ["japanese former av actress", "日本前AV女优。"],
  ["japanese gravure idol, former pornographic actress and mainstream actress", "日本写真偶像、前AV女优及演员。"]
]);

export function localizeEntityBiography(value: string): string {
  const trimmed = value.trim();
  return GENERIC_ENTITY_BIOGRAPHY_LOCALIZATIONS.get(trimmed.toLocaleLowerCase("en-US")) ?? trimmed;
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("ja").replace(/[\s\-_.・·()（）]+/g, "");
}

function normalizePrimaryName(value: string): string {
  return value.normalize("NFKC").trim().replace(/[\s\-_.・·()（）]+/g, "");
}

export function scoreActorIdentityCandidate(input: {
  hasWikipedia: boolean;
  hasBirthDate: boolean;
  exactPrimaryName: boolean;
  isAdultPerformer: boolean;
}): number {
  return Math.min(0.95, 0.72 + (input.hasWikipedia ? 0.12 : 0) + (input.hasBirthDate ? 0.04 : 0) +
    (input.exactPrimaryName ? 0.03 : 0) + (input.isAdultPerformer ? 0.04 : 0));
}

export function isActorIdentityRoleCompatible(occupationIds: string[]): boolean {
  return occupationIds.some((id) => ADULT_PERFORMER_OCCUPATION_IDS.has(id));
}

export function expandActorIdentityNames(names: string[]): string[] {
  const expanded = new Set<string>();
  for (const rawName of names) {
    const name = rawName.normalize("NFKC").trim();
    if (!name) continue;
    expanded.add(name);
    const parentheticalAliases = [...name.matchAll(/[（(]([^（）()]{2,80})[）)]/gu)].map((match) => match[1].trim());
    const primary = name.replace(/[（(][^（）()]{2,80}[）)]/gu, " ").trim();
    if (primary) expanded.add(primary);
    for (const alias of parentheticalAliases) expanded.add(alias);
    for (const part of [primary, ...parentheticalAliases].flatMap((value) => value.split(/[／/、]/u))) {
      const trimmed = part.trim();
      if (trimmed.length >= 2) expanded.add(trimmed);
    }
  }
  return [...expanded];
}

async function fetchJson<T>(url: string): Promise<T> {
  for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt += 1) {
    const waitMs = Math.max(0, nextRequestAt - Date.now());
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": WIKIMEDIA_USER_AGENT },
      signal: AbortSignal.timeout(20_000)
    });
    nextRequestAt = Date.now() + REQUEST_INTERVAL_MS;
    if (response.ok) return response.json() as Promise<T>;
    if (response.status !== 429 || attempt === MAX_REQUEST_ATTEMPTS - 1) throw new Error(`Wikimedia request failed (${response.status})`);
    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    const retryMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? Math.min(60_000, retryAfterSeconds * 1000)
      : Math.min(60_000, 5_000 * 2 ** attempt);
    nextRequestAt = Date.now() + retryMs;
  }
  throw new Error("Wikimedia request failed");
}

type CommonsExtMetadataValue = { value?: string };

type CommonsCategoryImageCandidate = {
  pageId?: number;
  fileName: string;
  mime: string;
  width: number;
  height: number;
  description: string;
  depictsWikidataIds?: string[];
};

type CommonsImageResult = {
  imageUrl: string;
  attribution: EntityImageAttribution;
  cacheDecision: EntityImageCacheDecision;
  discovery?: {
    method: "wikidata-p373";
    commonsCategory: string;
    score: number;
  };
};

function decodeHtmlText(value: string): string {
  return value
    .replace(/<br\s*\/?>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;|&#34;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/\s+/gu, " ")
    .trim();
}

function safeHttpUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export function safeOfficialAgencyImageUrl(sourceUrl: unknown, imageUrl: unknown): string {
  if (typeof sourceUrl !== "string" || typeof imageUrl !== "string") return "";
  try {
    const source = new URL(sourceUrl);
    const image = new URL(imageUrl);
    const upTimelySources = new Set([
      "attackers.net", "av-e-body.com", "bi-av.com", "bibian-av.com", "dasdas.jp",
      "fitch-av.com", "hhh-av.com", "honnaka.jp", "ideapocket.com", "kawaiikawaii.jp",
      "madonna-av.com", "mko-labo.net", "moodyz.com", "oppai-av.com", "premium-beauty.com",
      "rookie-av.jp", "s1s1s1.com", "tameikegoro.jp", "wanz-factory.com"
    ]);
    const trustedCrossHost = (image.hostname === "cdn.up-timely.com" && upTimelySources.has(source.hostname)) ||
      (image.hostname === "cdn.faleno.net" && new Set(["falenogroup.com", "dahlia-av.jp"]).has(source.hostname)) ||
      (image.hostname === "pbs.twimg.com" && new Set(["x.com", "twitter.com"]).has(source.hostname) &&
        /^\/profile_images\/[0-9]+\/[A-Za-z0-9_-]+(?:_[0-9]+x[0-9]+)?\.(?:jpe?g|png|webp)$/iu.test(image.pathname));
    return source.protocol === "https:" && image.protocol === "https:" &&
      (source.hostname === image.hostname || trustedCrossHost)
      ? image.toString()
      : "";
  } catch {
    return "";
  }
}

export function safePublicActorDirectoryImageUrl(sourceUrl: unknown, imageUrl: unknown): string {
  if (typeof sourceUrl !== "string" || typeof imageUrl !== "string") return "";
  try {
    const source = new URL(sourceUrl);
    const image = new URL(imageUrl);
    const trustedImageHosts = new Set(["awsimgsrc.dmm.com", "pics.dmm.co.jp"]);
    return source.protocol === "https:" && source.hostname === "r18.dev" &&
      image.protocol === "https:" && trustedImageHosts.has(image.hostname) &&
      /\/(?:dig\/)?mono\/actjpgs\/[a-z0-9_.-]+\.(?:jpe?g|png|webp)$/iu.test(image.pathname)
      ? image.toString()
      : "";
  } catch {
    return "";
  }
}

function safeWikimediaUrl(value: string, hosts: string[]): string {
  const parsed = safeHttpUrl(value);
  if (!parsed) return "";
  const url = new URL(parsed);
  return url.protocol === "https:" && hosts.includes(url.hostname) ? url.toString() : "";
}

function firstLink(value: string): string {
  const match = value.match(/href=["']([^"']+)["']/iu);
  if (!match?.[1]) return "";
  const href = match[1].replace(/&amp;/giu, "&");
  const absolute = href.startsWith("//") ? `https:${href}`
    : href.startsWith("/") ? `https://commons.wikimedia.org${href}` : href;
  return safeHttpUrl(absolute);
}

function metadataBoolean(value: string): boolean | null {
  const normalized = decodeHtmlText(value).toLowerCase();
  if (["true", "yes", "1"].includes(normalized)) return true;
  if (["false", "no", "0"].includes(normalized)) return false;
  return null;
}

function commonsPermissionSummary(value: string, licenseUrl: string): string | null {
  if (!value.trim()) return "";
  if (!licenseUrl) return null;
  const normalized = value.toLowerCase();
  const containsKnownLicenseTemplate = normalized.includes("licensetpl") &&
    normalized.includes(new URL(licenseUrl).pathname.replace(/\/$/u, "").toLowerCase());
  if (!containsKnownLicenseTemplate) return null;
  const unknownExtraCondition = /(?:non-commercial|no derivatives|no derivative|permission is granted|vrt|otrs|ticket|model release)/iu.test(decodeHtmlText(value));
  if (unknownExtraCondition) return null;
  if (normalized.includes("flickrreview") || normalized.includes("commons:license_review")) {
    return "Commons 已核验原始平台许可";
  }
  return "Commons 标准许可模板";
}

function canonicalCommonsLicenseUrl(value: string, licenseUrl: string, copyrighted: boolean | null): string {
  const normalized = value.normalize("NFKC").trim();
  let url: URL;
  try { url = new URL(licenseUrl); } catch { return ""; }
  if (!["http:", "https:"].includes(url.protocol) || url.hostname.replace(/^www\./iu, "") !== "creativecommons.org") return "";
  const path = url.pathname.toLowerCase();
  if (/^CC0(?: 1\.0)?$/iu.test(normalized) && /^\/publicdomain\/zero\/1\.0(?:\/|$)/u.test(path)) {
    return "https://creativecommons.org/publicdomain/zero/1.0/";
  }
  if (/^(?:public domain|public domain mark 1\.0|CC-PD-Mark)$/iu.test(normalized)) {
    if (/^\/publicdomain\/mark\/1\.0(?:\/|$)/u.test(path) || copyrighted === false) {
      return "https://creativecommons.org/publicdomain/mark/1.0/";
    }
    return "";
  }
  const name = normalized.match(/^CC (BY(?:-SA)?) (1\.0|2\.0|2\.5|3\.0|4\.0)$/iu);
  if (!name) return "";
  const licensePath = `/licenses/${name[1].toLowerCase()}/${name[2]}`;
  return path === licensePath || path.startsWith(`${licensePath}/`)
    ? `https://creativecommons.org${licensePath}/` : "";
}

function isAllowedCommonsLicense(value: string, licenseUrl: string, copyrighted: boolean | null): boolean {
  return Boolean(canonicalCommonsLicenseUrl(value, licenseUrl, copyrighted));
}

export function isEntityImageAttributionAccepted(
  attribution: EntityImageAttribution | null | undefined,
  decision: unknown,
  policy: EntityProfileImagePolicy = config.externalAi.entityProfileImagePolicy
): boolean {
  if (!attribution || !isEntityImageCacheDecisionAccepted(decision, policy) ||
    !attribution.fileName || !safeWikimediaUrl(attribution.sourceUrl, ["commons.wikimedia.org"])) return false;
  if (decision === "allowed-v1") {
    const copyrighted = typeof attribution.copyrighted === "boolean" ? attribution.copyrighted : null;
    return Boolean(attribution.creator && attribution.license && attribution.licenseUrl &&
      isAllowedCommonsLicense(attribution.license, attribution.licenseUrl, copyrighted));
  }
  return true;
}

export async function fetchCommonsImageAttribution(
  fileName: string,
  policy: EntityProfileImagePolicy = config.externalAi.entityProfileImagePolicy
): Promise<CommonsImageResult | null> {
  const normalizedFileName = fileName.replace(/^File:/iu, "").trim();
  if (!normalizedFileName) return null;
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    redirects: "1",
    prop: "imageinfo",
    iiprop: "url|mime|size|sha1|timestamp|user|extmetadata",
    iiurlwidth: "720",
    iimetadataversion: "latest",
    iiextmetadatalanguage: "en",
    iiextmetadatafilter: [
      "Artist", "Credit", "Attribution", "LicenseShortName", "LicenseUrl", "UsageTerms",
      "AttributionRequired", "Copyrighted", "NonFree", "Restrictions", "Permission", "DeletionReason"
    ].join("|"),
    maxlag: "5",
    titles: `File:${normalizedFileName}`
  });
  const body = await fetchJson<{
    query?: { pages?: Array<{
      title?: string;
      pageid?: number;
      missing?: boolean;
      imageinfo?: Array<{
        url?: string;
        thumburl?: string;
        descriptionurl?: string;
        mime?: string;
        width?: number;
        height?: number;
        size?: number;
        sha1?: string;
        timestamp?: string;
        thumbwidth?: number;
        thumbheight?: number;
        extmetadata?: Record<string, CommonsExtMetadataValue>;
      }>;
    }> };
  }>(`${WIKIMEDIA_COMMONS_API}?${params}`);
  const page = body.query?.pages?.[0];
  const info = page?.imageinfo?.[0];
  if (!page || page.missing || !info) return null;
  const metadata = info.extmetadata ?? {};
  const rawCreator = metadata.Artist?.value?.trim() ?? "";
  const creator = decodeHtmlText(rawCreator) || "unknown";
  const license = decodeHtmlText(metadata.LicenseShortName?.value ?? metadata.UsageTerms?.value ?? "") || "unknown";
  const rawLicenseUrl = safeHttpUrl(metadata.LicenseUrl?.value ?? "");
  const sourceUrl = safeWikimediaUrl(info.descriptionurl ?? "", ["commons.wikimedia.org"]);
  const imageUrl = safeWikimediaUrl(info.thumburl ?? info.url ?? "", ["upload.wikimedia.org"]);
  const attributionRequired = metadataBoolean(metadata.AttributionRequired?.value ?? "");
  const copyrighted = metadataBoolean(metadata.Copyrighted?.value ?? "");
  const canonicalLicenseUrl = canonicalCommonsLicenseUrl(license, rawLicenseUrl, copyrighted);
  const licenseUrl = canonicalLicenseUrl || rawLicenseUrl;
  const nonFree = metadataBoolean(metadata.NonFree?.value ?? "");
  const restrictions = decodeHtmlText(metadata.Restrictions?.value ?? "");
  const rawPermission = metadata.Permission?.value ?? "";
  const permissionSummary = commonsPermissionSummary(rawPermission, canonicalLicenseUrl);
  const deletionReason = decodeHtmlText(metadata.DeletionReason?.value ?? "");
  const allowedMime = new Set(["image/jpeg", "image/png", "image/webp"]);
  if (!sourceUrl || !imageUrl || deletionReason || !allowedMime.has(info.mime ?? "")) return null;
  const strictAllowed = creator !== "unknown" && license !== "unknown" && Boolean(canonicalLicenseUrl) &&
    isAllowedCommonsLicense(license, canonicalLicenseUrl, copyrighted) && nonFree !== true && !restrictions &&
    permissionSummary != null;
  if (policy === "strict" && !strictAllowed) return null;
  const normalizedLicense = license.toLowerCase();
  const rightsStatus: EntityImageRightsStatus = canonicalLicenseUrl.includes("/publicdomain/") ||
    /^(?:public domain|public domain mark|cc0)(?:\s|$)/iu.test(normalizedLicense)
    ? "public-domain"
    : canonicalLicenseUrl || /^cc\s+by(?:-sa)?(?:\s|$)/iu.test(normalizedLicense)
      ? "open-license"
      : nonFree === true || Boolean(restrictions) || /all rights reserved|non[- ]?commercial|no derivatives?/iu.test(normalizedLicense)
        ? "restricted"
        : "unknown";
  const creatorUrl = firstLink(rawCreator);
  const credit = decodeHtmlText(metadata.Credit?.value ?? metadata.Attribution?.value ?? "");
  const attributionText = decodeHtmlText(metadata.Attribution?.value ?? "");
  if (attributionRequired === true && !attributionText && !creator) return null;
  return {
    imageUrl,
    cacheDecision: strictAllowed ? "allowed-v1" : "research-cache-v1",
    attribution: {
      fileName: String(page.title ?? `File:${normalizedFileName}`).replace(/^File:/iu, ""),
      sourceUrl,
      creator,
      ...(creatorUrl ? { creatorUrl } : {}),
      license,
      licenseUrl,
      rightsStatus,
      ...(credit && credit !== creator ? { credit } : {}),
      ...(attributionText ? { attributionText } : {}),
      ...(typeof page.pageid === "number" ? { pageId: page.pageid } : {}),
      ...(info.sha1 ? { sha1: info.sha1 } : {}),
      ...(info.timestamp ? { fileTimestamp: info.timestamp } : {}),
      ...(attributionRequired != null ? { attributionRequired } : {}),
      ...(copyrighted != null ? { copyrighted } : {}),
      ...(permissionSummary ? { permissionSummary } : {}),
      ...(safeWikimediaUrl(info.url ?? "", ["upload.wikimedia.org"]) ? {
        originalUrl: safeWikimediaUrl(info.url ?? "", ["upload.wikimedia.org"])
      } : {}),
      ...(info.mime ? { contentType: info.mime } : {}),
      ...(typeof info.width === "number" ? { originalWidth: info.width } : {}),
      ...(typeof info.height === "number" ? { originalHeight: info.height } : {}),
      ...(typeof info.size === "number" ? { originalSizeBytes: info.size } : {}),
      requestedThumbWidth: 720,
      ...(typeof info.thumbwidth === "number" ? { thumbWidth: info.thumbwidth } : {}),
      ...(typeof info.thumbheight === "number" ? { thumbHeight: info.thumbheight } : {})
    }
  };
}

function normalizeCommonsEvidence(value: string): string {
  return decodeHtmlText(value).normalize("NFKC").toLocaleLowerCase("ja")
    .replace(/^file:/iu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

const COMMONS_PORTRAIT_REJECT = /(?:logo|logotype|icon|symbol|badge|banner|signature|autograph|sign(?:ed|ature)?|サイン|署名|ロゴ|アイコン|poster|cover|screenshot|screen[ -]?shot|collage|montage|contact[ -]?sheet|group|team|cast|line[ -]?up|members?|集合|集合写真|複数人|出演者一覧)/iu;
const COMMONS_EVENT_SIGNAL = /(?:event|festival|ceremony|awards?|expo|show|stage|interview|press conference|photo session|撮影会|イベント|祭|授賞|会見|ステージ)/iu;
const COMMONS_PORTRAIT_SIGNAL = /(?:portrait|profile|headshot|bust|ポートレート|プロフィール|宣材|人物)/iu;

/**
 * Scores only technically suitable, identity-bearing solo portrait candidates.
 * The Commons category itself is not treated as identity evidence: a candidate
 * must repeat one of the Wikidata entity's multilingual names in its filename
 * or file description.
 */
export function scoreCommonsCategoryPortraitCandidate(
  candidate: CommonsCategoryImageCandidate,
  entityNames: string[],
  wikidataId = ""
): number | null {
  if (!["image/jpeg", "image/png", "image/webp"].includes(candidate.mime)) return null;
  if (candidate.width < 480 || candidate.height < 480) return null;
  const ratio = candidate.width / candidate.height;
  if (ratio < 0.48 || ratio > 1.12) return null;
  const evidence = `${candidate.fileName} ${candidate.description}`;
  if (COMMONS_PORTRAIT_REJECT.test(evidence)) return null;

  const normalizedTitle = normalizeCommonsEvidence(candidate.fileName);
  const normalizedDescription = normalizeCommonsEvidence(candidate.description);
  const names = [...new Set(entityNames.map(normalizeCommonsEvidence).filter((name) => name.length >= 3))];
  const titleNameMatch = names.some((name) => normalizedTitle.includes(name));
  const descriptionNameMatch = names.some((name) => normalizedDescription.includes(name));
  const depictsIdentity = Boolean(wikidataId && candidate.depictsWikidataIds?.includes(wikidataId));
  if (!titleNameMatch && !descriptionNameMatch && !depictsIdentity) return null;
  if (COMMONS_EVENT_SIGNAL.test(evidence) && !descriptionNameMatch && !depictsIdentity) return null;
  // An event-only filename/description without the person's name has already
  // been rejected above. Named solo event photographs remain valid portraits,
  // but receive a small penalty compared with explicit profile photographs.
  const pixels = candidate.width * candidate.height;
  const resolutionScore = Math.min(1.5, Math.log2(Math.max(1, pixels / (480 * 480))) * 0.35);
  const ratioScore = Math.max(0, 1.5 - Math.abs(ratio - 0.74) * 3);
  return (depictsIdentity ? 8 : 0) + (titleNameMatch ? 6 : 0) + (descriptionNameMatch ? 2 : 0) +
    resolutionScore + ratioScore + (COMMONS_PORTRAIT_SIGNAL.test(evidence) ? 0.75 : 0) -
    (COMMONS_EVENT_SIGNAL.test(evidence) ? 0.5 : 0);
}

export function selectUniqueCommonsPortraitCandidate(
  candidates: CommonsCategoryImageCandidate[],
  entityNames: string[],
  wikidataId = ""
): { fileName: string; score: number } | null {
  const ranked = candidates.flatMap((candidate) => {
    const score = scoreCommonsCategoryPortraitCandidate(candidate, entityNames, wikidataId);
    return score == null ? [] : [{ fileName: candidate.fileName, score }];
  }).sort((left, right) => right.score - left.score || left.fileName.localeCompare(right.fileName, "ja"));
  const winner = ranked[0];
  if (!winner || winner.score < 7.25) return null;
  if (ranked[1] && winner.score - ranked[1].score < 0.35) return null;
  return winner;
}

export async function fetchCommonsCategoryPortrait(
  commonsCategory: string,
  entityNames: string[],
  policy: EntityProfileImagePolicy = config.externalAi.entityProfileImagePolicy,
  wikidataId = ""
): Promise<CommonsImageResult | null> {
  const category = commonsCategory.replace(/^Category:/iu, "").trim();
  if (!category || !entityNames.length) return null;
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    generator: "categorymembers",
    gcmtitle: `Category:${category}`,
    gcmnamespace: "6",
    gcmlimit: "50",
    prop: "imageinfo",
    iiprop: "mime|size|extmetadata",
    iimetadataversion: "latest",
    iiextmetadatalanguage: "en",
    iiextmetadatafilter: "ImageDescription|ObjectName",
    maxlag: "5"
  });
  const body = await fetchJson<{
    query?: { pages?: Array<{
      pageid?: number;
      title?: string;
      imageinfo?: Array<{
        mime?: string;
        width?: number;
        height?: number;
        extmetadata?: Record<string, CommonsExtMetadataValue>;
      }>;
    }> };
  }>(`${WIKIMEDIA_COMMONS_API}?${params}`);
  const candidates = (body.query?.pages ?? []).flatMap((page): CommonsCategoryImageCandidate[] => {
    const info = page.imageinfo?.[0];
    const fileName = String(page.title ?? "").replace(/^File:/iu, "").trim();
    if (!info || !fileName) return [];
    return [{
      ...(typeof page.pageid === "number" ? { pageId: page.pageid } : {}),
      fileName,
      mime: info.mime ?? "",
      width: info.width ?? 0,
      height: info.height ?? 0,
      description: decodeHtmlText(info.extmetadata?.ImageDescription?.value ?? info.extmetadata?.ObjectName?.value ?? "")
    }];
  });
  if (wikidataId) {
    const mediaInfoIds = candidates.flatMap((candidate) => candidate.pageId ? [`M${candidate.pageId}`] : []);
    if (mediaInfoIds.length) {
      const mediaInfo: {
        entities?: Record<string, {
          claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: { id?: string } } } }>>;
        }>;
      } = await fetchJson<{
        entities?: Record<string, {
          claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: { id?: string } } } }>>;
        }>;
      }>(`${WIKIMEDIA_COMMONS_API}?${new URLSearchParams({
        action: "wbgetentities", format: "json", props: "claims", ids: mediaInfoIds.join("|"), maxlag: "5"
      })}`).catch(() => ({ entities: {} }));
      for (const candidate of candidates) {
        if (!candidate.pageId) continue;
        candidate.depictsWikidataIds = (mediaInfo.entities?.[`M${candidate.pageId}`]?.claims?.P180 ?? [])
          .flatMap((claim) => claim.mainsnak?.datavalue?.value?.id ? [claim.mainsnak.datavalue.value.id] : []);
      }
    }
  }
  const selected = selectUniqueCommonsPortraitCandidate(candidates, entityNames, wikidataId);
  if (!selected) return null;
  const image = await fetchCommonsImageAttribution(selected.fileName, policy);
  return image ? {
    ...image,
    discovery: { method: "wikidata-p373", commonsCategory: category, score: selected.score }
  } : null;
}

async function resolveCommonsEntityImage(entity: WikidataEntity): Promise<CommonsImageResult | null> {
  const imageName = claimString(entity, "P18");
  if (imageName) return fetchCommonsImageAttribution(imageName).catch(() => null);
  const category = claimString(entity, "P373");
  if (!category) return null;
  return fetchCommonsCategoryPortrait(category, allEntityNames(entity), config.externalAi.entityProfileImagePolicy, entity.id).catch(() => null);
}

function commonsImageSourceFacts(image: CommonsImageResult): Record<string, unknown> {
  return {
    imageUrl: image.imageUrl,
    image: image.attribution,
    licenseDecision: image.cacheDecision,
    ...(image.discovery ? { discovery: image.discovery } : {})
  };
}

function bestClaim(entity: WikidataEntity, property: string): WikidataClaim | undefined {
  const claims = entity.claims?.[property] ?? [];
  return claims.find((claim) => claim.rank === "preferred" && claim.mainsnak?.datavalue) ??
    claims.find((claim) => claim.rank !== "deprecated" && claim.mainsnak?.datavalue);
}

function claimString(entity: WikidataEntity, property: string): string {
  const value = bestClaim(entity, property)?.mainsnak?.datavalue?.value;
  return typeof value === "string" ? value : "";
}

function claimEntityId(entity: WikidataEntity, property: string): string {
  const value = bestClaim(entity, property)?.mainsnak?.datavalue?.value;
  return value && typeof value === "object" && "id" in value ? String((value as { id: unknown }).id) : "";
}

function claimEntityIds(entity: WikidataEntity, property: string): string[] {
  return (entity.claims?.[property] ?? []).flatMap((claim) => {
    const value = claim.mainsnak?.datavalue?.value;
    return value && typeof value === "object" && "id" in value ? [String((value as { id: unknown }).id)] : [];
  });
}

function claimDate(entity: WikidataEntity, property: string): string | null {
  const value = bestClaim(entity, property)?.mainsnak?.datavalue?.value;
  if (!value || typeof value !== "object" || !("time" in value)) return null;
  const time = String((value as { time: unknown }).time).replace(/^\+/, "");
  const precision = Number((value as { precision?: unknown }).precision ?? 11);
  if (precision >= 11) return time.slice(0, 10);
  if (precision === 10) return time.slice(0, 7);
  return time.slice(0, 4);
}

function claimHeightCm(entity: WikidataEntity): number | null {
  const value = bestClaim(entity, "P2048")?.mainsnak?.datavalue?.value;
  if (!value || typeof value !== "object" || !("amount" in value)) return null;
  const amount = Number(String((value as { amount: unknown }).amount).replace(/^\+/, ""));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = String((value as { unit?: unknown }).unit ?? "");
  if (unit.endsWith("Q11573")) return Math.round(amount * 1000) / 10;
  if (unit.endsWith("Q174728")) return Math.round(amount * 10) / 10;
  return amount < 3 ? Math.round(amount * 1000) / 10 : Math.round(amount * 10) / 10;
}

function localizedValue(values: Record<string, { value?: string }> | undefined): string {
  for (const language of ["zh-cn", "zh-hans", "zh", "ja", "en"]) {
    const value = values?.[language]?.value?.trim();
    if (value) return value;
  }
  return "";
}

async function fetchEntityLabels(ids: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return {};
  const result: Record<string, string> = {};
  for (let offset = 0; offset < unique.length; offset += 40) {
    const params = new URLSearchParams({
      action: "wbgetentities",
      format: "json",
      origin: "*",
      ids: unique.slice(offset, offset + 40).join("|"),
      props: "labels",
      languages: "zh-cn|zh-hans|zh|ja|en",
      languagefallback: "1"
    });
    const body = await fetchJson<{ entities?: Record<string, WikidataEntity> }>(`${WIKIDATA_API}?${params}`);
    for (const [id, entity] of Object.entries(body.entities ?? {})) result[id] = localizedValue(entity.labels) || id;
  }
  return result;
}

async function searchWikidata(names: string[]): Promise<Array<{ id: string; label: string; description: string }>> {
  const results = new Map<string, { id: string; label: string; description: string }>();
  const exactResults = new Map<string, { id: string; label: string; description: string }>();
  for (const name of [...new Set(names.map((item) => item.trim()).filter(Boolean))].slice(0, 6)) {
    const languages = /[\u3040-\u30ff\u3400-\u9fff]/u.test(name) ? ["ja", "zh"] : ["en", "ja"];
    for (const language of languages) {
      const params = new URLSearchParams({
        action: "wbsearchentities", format: "json", origin: "*", type: "item",
        search: name, language, uselang: "zh", limit: "8"
      });
      const body = await fetchJson<{ search?: Array<{ id?: string; label?: string; description?: string }> }>(`${WIKIDATA_API}?${params}`);
      for (const item of body.search ?? []) {
        if (!item.id) continue;
        const result = { id: item.id, label: item.label ?? "", description: item.description ?? "" };
        results.set(item.id, result);
        if (normalizeName(result.label) === normalizeName(name)) exactResults.set(item.id, result);
      }
    }
  }
  return [
    ...exactResults.values(),
    ...[...results.values()].filter((item) => !exactResults.has(item.id))
  ].slice(0, 16);
}

async function searchWikipediaEntityIds(names: string[]): Promise<Array<{ id: string; label: string; description: string }>> {
  const results = new Map<string, { id: string; label: string; description: string }>();
  for (const name of [...new Set(names.map((item) => item.trim()).filter(Boolean))].slice(0, 6)) {
    const languages = /[\u3040-\u30ff\u3400-\u9fff]/u.test(name) ? ["ja", "zh"] : ["zh", "ja", "en"];
    for (const language of languages) {
      const params = new URLSearchParams({
        action: "query", format: "json", origin: "*", generator: "search",
        gsrsearch: name, gsrnamespace: "0", gsrlimit: "6", prop: "pageprops"
      });
      const body = await fetchJson<{
        query?: { pages?: Record<string, { title?: string; pageprops?: { wikibase_item?: string } }> };
      }>(`https://${language}.wikipedia.org/w/api.php?${params}`);
      for (const page of Object.values(body.query?.pages ?? {})) {
        const id = page.pageprops?.wikibase_item;
        if (!id || results.has(id)) continue;
        results.set(id, { id, label: page.title ?? name, description: `${language}.wikipedia 搜索结果` });
      }
      if (results.size >= 8) return [...results.values()].slice(0, 8);
    }
  }
  return [...results.values()].slice(0, 8);
}

async function loadWikidataEntity(id: string): Promise<WikidataEntity> {
  const body = await fetchJson<{ entities?: Record<string, WikidataEntity> }>(`${WIKIDATA_ENTITY}/${encodeURIComponent(id)}.json`);
  const entity = body.entities?.[id];
  if (!entity) throw new Error(`Wikidata entity ${id} was not found`);
  return entity;
}

function allEntityNames(entity: WikidataEntity): string[] {
  return [...new Set([
    ...Object.values(entity.labels ?? {}).map((item) => item.value ?? ""),
    ...Object.values(entity.aliases ?? {}).flatMap((items) => items.map((item) => item.value ?? ""))
  ].map((item) => item.trim()).filter(Boolean))];
}

function publicEntityAliases(type: Exclude<PublicEntityType, "actor">, value: string, entity: WikidataEntity): string[] {
  const aliases = [...new Set([value, ...allEntityNames(entity)])];
  // Wikidata lists UP'S as a historical name for MAX-A, while the library also
  // contains a separate maker facet named アップス/UP'S. Keeping that historical
  // corporate alias on MAX-A would collapse two independently credited makers.
  if (type === "maker" && entity.id === "Q6794497") {
    const blocked = new Set(["アップス(アダルトビデオ)", "up's", "up’s"]);
    return aliases.filter((item) => !blocked.has(item.normalize("NFKC").replace(/\s+/gu, "").toLocaleLowerCase("en-US")));
  }
  return aliases;
}

export type ActorIdentityCandidateEvidence = {
  id: string;
  names: string[];
  descriptions: Record<string, string>;
  birthDate: string | null;
  hasJapaneseWikipedia: boolean;
  hasChineseWikipedia: boolean;
  isAdultPerformer: boolean;
};

export function shouldUseAiForActorIdentity(scores: number[]): boolean {
  const ranked = scores.filter(Number.isFinite).sort((left, right) => right - left);
  return ranked.length > 1 && ranked[0] - ranked[1] <= 0.04;
}

export async function judgeActorIdentityWithLocalAi(
  names: string[],
  candidates: ActorIdentityCandidateEvidence[]
): Promise<{ selectedId: string; confidence: number; reason: string } | null> {
  try {
    const response = await fetch(`${config.externalAi.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.externalAi.chatModel,
        stream: false,
        think: false,
        format: "json",
        options: { temperature: 0, num_ctx: 4096, num_predict: 300 },
        messages: [
          {
            role: "system",
            content: "你负责人物实体消歧并自主判断是否合并。只根据给定名称、候选别名、简介、生日、Wikipedia 关联和公开职业标记选择同一演员。日文原名优先于中文翻译；同名但资料不同必须拒绝合并；证据不足时 selectedId 必须为 null。只输出 JSON：{selectedId:string|null, confidence:number, reason:string}。"
          },
          { role: "user", content: JSON.stringify({ libraryNames: names, candidates }) }
        ]
      }),
      signal: AbortSignal.timeout(120_000)
    });
    if (!response.ok) return null;
    const body = await response.json() as { message?: { content?: string } };
    const content = body.message?.content?.trim() ?? "";
    const json = content.match(/\{[\s\S]*\}/u)?.[0];
    if (!json) return null;
    const decision = JSON.parse(json) as { selectedId?: unknown; confidence?: unknown; reason?: unknown };
    const selectedId = typeof decision.selectedId === "string" ? decision.selectedId : "";
    const confidence = Number(decision.confidence);
    if (!candidates.some((item) => item.id === selectedId) || !Number.isFinite(confidence) || confidence < 0.82) return null;
    return {
      selectedId,
      confidence: Math.min(0.9, confidence),
      reason: typeof decision.reason === "string" ? decision.reason.slice(0, 500) : "本地模型完成多语言人物消歧"
    };
  } catch {
    return null;
  }
}

async function selectAmbiguousActorWithAi(
  names: string[],
  matches: Array<{ entity: WikidataEntity; score: number }>
): Promise<{ entity: WikidataEntity; confidence: number; reason: string } | null> {
  const candidates = matches.slice(0, 6).map(({ entity }) => ({
    id: entity.id,
    names: allEntityNames(entity).slice(0, 30),
    descriptions: Object.fromEntries(Object.entries(entity.descriptions ?? {})
      .filter(([language]) => ["zh", "ja", "en"].includes(language))
      .map(([language, item]) => [language, item.value ?? ""])),
    birthDate: claimDate(entity, "P569"),
    hasJapaneseWikipedia: Boolean(entity.sitelinks?.jawiki),
    hasChineseWikipedia: Boolean(entity.sitelinks?.zhwiki),
    isAdultPerformer: isActorIdentityRoleCompatible(claimEntityIds(entity, "P106"))
  }));
  const decision = await judgeActorIdentityWithLocalAi(names, candidates);
  const selected = decision ? matches.find((item) => item.entity.id === decision.selectedId) : null;
  return selected && decision ? { entity: selected.entity, confidence: decision.confidence, reason: decision.reason } : null;
}

async function findWikidataMatch(names: string[]): Promise<{
  entity: WikidataEntity;
  confidence: number;
  decision: { method: "exact-rule" | "local-ai"; reason: string };
} | null> {
  const identityNames = expandActorIdentityNames(names);
  const expected = new Set(identityNames.map(normalizeName).filter(Boolean));
  const expectedPrimaryNames = new Set(identityNames.map(normalizePrimaryName).filter(Boolean));
  const directCandidates = await searchWikidata(identityNames);
  const matches: Array<{ entity: WikidataEntity; score: number }> = [];
  const inspectedIds = new Set<string>();
  const collectMatches = async (candidates: Array<{ id: string }>) => {
    for (const candidate of candidates.slice(0, 20)) {
      if (inspectedIds.has(candidate.id)) continue;
      inspectedIds.add(candidate.id);
      const entity = await loadWikidataEntity(candidate.id);
      const isHuman = claimEntityIds(entity, "P31").includes("Q5");
      if (!isHuman) continue;
      const entityNames = allEntityNames(entity).map(normalizeName);
      const exact = entityNames.some((name) => expected.has(name));
      if (!exact) continue;
      const hasWikipedia = Boolean(entity.sitelinks?.jawiki || entity.sitelinks?.zhwiki || entity.sitelinks?.enwiki);
      const exactPrimaryName = Object.values(entity.labels ?? {})
        .some((item) => expectedPrimaryNames.has(normalizePrimaryName(item.value ?? "")));
      const isAdultPerformer = isActorIdentityRoleCompatible(claimEntityIds(entity, "P106"));
      // An exact name alone is insufficient for actor enrichment: short stage
      // names frequently collide with athletes, historical figures, musicians,
      // and other public people. Only entities explicitly classified as adult
      // performers may enter the actor identity candidate set.
      if (!isAdultPerformer) continue;
      matches.push({ entity, score: scoreActorIdentityCandidate({
        hasWikipedia,
        hasBirthDate: Boolean(claimDate(entity, "P569")),
        exactPrimaryName,
        isAdultPerformer
      }) });
    }
  };
  await collectMatches(directCandidates);
  if (!matches.length || matches.every((item) => item.score < 0.92)) {
    await collectMatches(await searchWikipediaEntityIds(identityNames));
  }
  matches.sort((left, right) => right.score - left.score);
  if (!matches[0]) return null;
  if (shouldUseAiForActorIdentity(matches.map((item) => item.score))) {
    const selected = await selectAmbiguousActorWithAi(
      identityNames,
      matches.filter((item) => matches[0].score - item.score <= 0.04)
    );
    return selected ? {
      entity: selected.entity,
      confidence: selected.confidence,
      decision: { method: "local-ai", reason: selected.reason }
    } : null;
  }
  return {
    entity: matches[0].entity,
    confidence: matches[0].score,
    decision: { method: "exact-rule", reason: "日文/原始主名、多语言别名与公开职业共同形成唯一高分人物实体" }
  };
}

type WikipediaTarget = { language: string; title: string; url: string };

function wikipediaTargets(entity: WikidataEntity): WikipediaTarget[] {
  const targets: WikipediaTarget[] = [];
  for (const language of ["ja", "zh", "en"]) {
    const sitelink = entity.sitelinks?.[`${language}wiki`];
    if (!sitelink?.title) continue;
    targets.push({
      language,
      title: sitelink.title,
      url: sitelink.url || `https://${language}.wikipedia.org/wiki/${encodeURIComponent(sitelink.title.replace(/ /g, "_"))}`
    });
  }
  return targets;
}

async function fetchWikipediaSummary(target: WikipediaTarget | null): Promise<{ extract: string; imageUrl: string }> {
  if (!target) return { extract: "", imageUrl: "" };
  const url = `https://${target.language}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(target.title.replace(/ /g, "_"))}`;
  const body = await fetchJson<{ extract?: string; thumbnail?: { source?: string }; originalimage?: { source?: string } }>(url);
  return { extract: body.extract?.trim() ?? "", imageUrl: body.originalimage?.source ?? body.thumbnail?.source ?? "" };
}

export type WikipediaInfoboxFacts = {
  heightCm: number | null;
  measurements: { bustCm?: number; waistCm?: number; hipsCm?: number; cup?: string };
};

export function normalizeActorCup(value: string | null | undefined): string {
  const normalized = String(value ?? "").normalize("NFKC").trim().toUpperCase();
  if (!normalized) return "";
  const leading = normalized.match(/^([A-Z]{1,3}\+*)(?=\s|[（(]|罩杯|カップ|CUP|\d)/u)?.[1];
  if (leading) return leading;
  const explicit = normalized.match(/([A-Z]{1,3}\+*)\s*(?:罩杯|カップ|CUP)/u)?.[1];
  if (explicit) return explicit;
  const bandSize = normalized.match(/(?:2[6-9]|3\d|4\d)([A-Z]{1,3}\+*)\b/u)?.[1];
  if (bandSize) return bandSize;
  return /^[A-Z]{1,3}\+*$/u.test(normalized) ? normalized : "";
}

function cleanWikitextValue(value: string): string {
  return value.replace(/<ref\b[^>]*>[\s\S]*?<\/ref>|<ref\b[^/]*\/>/giu, "")
    .replace(/\{\{[^{}]*\}\}/gu, " ").replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/gu, "$2")
    .replace(/<[^>]+>/gu, " ").replace(/&nbsp;|&thinsp;/gu, " ").trim();
}

function infoboxParam(wikitext: string, names: string[]): string {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = wikitext.match(new RegExp(`^\\s*\\|\\s*${escaped}\\s*=\\s*(.+)$`, "imu"));
    if (match?.[1]) return cleanWikitextValue(match[1]);
  }
  return "";
}

function positiveNumber(value: string): number | null {
  const match = value.replace(/,/g, "").match(/\d+(?:\.\d+)?/u);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function parseWikipediaInfobox(wikitext: string): WikipediaInfoboxFacts {
  const heightRaw = infoboxParam(wikitext, ["身長", "身高", "height"]);
  const height = positiveNumber(heightRaw);
  const heightCm = height == null ? null : Math.round((height < 3 ? height * 100 : height) * 10) / 10;
  const measurementsRaw = infoboxParam(wikitext, ["スリーサイズ", "三圍", "三围", "measurements"]);
  const measurementNumbers = measurementsRaw.match(/\d+(?:\.\d+)?/g)?.map(Number).filter((value) => value > 0) ?? [];
  const bust = positiveNumber(infoboxParam(wikitext, ["バスト", "胸圍", "胸围", "bust"]));
  const waist = positiveNumber(infoboxParam(wikitext, ["ウエスト", "腰圍", "腰围", "waist"]));
  const hips = positiveNumber(infoboxParam(wikitext, ["ヒップ", "臀圍", "臀围", "hips"]));
  const cup = normalizeActorCup(infoboxParam(wikitext, ["カップ", "罩杯", "cup size", "cup"]));
  return {
    heightCm,
    measurements: {
      ...((bust ?? measurementNumbers[0]) ? { bustCm: bust ?? measurementNumbers[0] } : {}),
      ...((waist ?? measurementNumbers[1]) ? { waistCm: waist ?? measurementNumbers[1] } : {}),
      ...((hips ?? measurementNumbers[2]) ? { hipsCm: hips ?? measurementNumbers[2] } : {}),
      ...(cup ? { cup } : {})
    }
  };
}

async function fetchWikipediaInfobox(target: WikipediaTarget): Promise<WikipediaInfoboxFacts> {
  const params = new URLSearchParams({
    action: "query", format: "json", prop: "revisions", rvprop: "content",
    rvslots: "main", titles: target.title, redirects: "1", origin: "*"
  });
  const body = await fetchJson<{ query?: { pages?: Record<string, { revisions?: Array<{ slots?: { main?: { "*"?: string; content?: string } } }> }> } }>(
    `https://${target.language}.wikipedia.org/w/api.php?${params}`
  );
  const page = Object.values(body.query?.pages ?? {})[0];
  const slot = page?.revisions?.[0]?.slots?.main;
  return parseWikipediaInfobox(slot?.["*"] ?? slot?.content ?? "");
}

function mergeWikipediaFacts(facts: WikipediaInfoboxFacts[]): { facts: WikipediaInfoboxFacts; hasConflict: boolean } {
  const values = <T>(pick: (fact: WikipediaInfoboxFacts) => T | null | undefined) =>
    facts.map(pick).filter((value): value is T => value != null && value !== "");
  const pickFirst = <T>(items: T[]): T | undefined => items[0];
  const heightValues = values((fact) => fact.heightCm);
  const bustValues = values((fact) => fact.measurements.bustCm);
  const waistValues = values((fact) => fact.measurements.waistCm);
  const hipsValues = values((fact) => fact.measurements.hipsCm);
  const cupValues = values((fact) => fact.measurements.cup);
  const hasConflict = [heightValues, bustValues, waistValues, hipsValues, cupValues]
    .some((items) => new Set(items.map(String)).size > 1);
  return {
    facts: {
      heightCm: pickFirst(heightValues) ?? null,
      measurements: {
        ...(pickFirst(bustValues) ? { bustCm: pickFirst(bustValues) } : {}),
        ...(pickFirst(waistValues) ? { waistCm: pickFirst(waistValues) } : {}),
        ...(pickFirst(hipsValues) ? { hipsCm: pickFirst(hipsValues) } : {}),
        ...(pickFirst(cupValues) ? { cup: pickFirst(cupValues) } : {})
      }
    },
    hasConflict
  };
}

function upsertEntityProfile(input: {
  type: PublicEntityType;
  value: string;
  profile: NonNullable<PublicEntityEnrichmentPreview["profile"]>;
  sources: EntityProfileSource[];
}): void {
  const { type, value, profile, sources } = input;
  const now = new Date().toISOString();
  const existingIdentity = profile.wikidataId ? db.prepare(`
    SELECT facet_value AS value, aliases_json AS aliasesJson
    FROM entity_profiles
    WHERE facet_type = @type AND wikidata_id = @wikidataId
    ORDER BY CASE WHEN source_status = 'verified' THEN 0 ELSE 1 END, updated_at
    LIMIT 1
  `).get({ type, wikidataId: profile.wikidataId }) as { value: string; aliasesJson: string } | undefined : undefined;
  const facetValue = existingIdentity?.value ?? value;
  const existing = db.prepare(`
    SELECT *, EXISTS (
      SELECT 1 FROM entity_profile_sources sources
      WHERE sources.facet_type = entity_profiles.facet_type
        AND sources.facet_value = entity_profiles.facet_value
        AND sources.provider LIKE 'official-%'
    ) AS has_official_source
    FROM entity_profiles WHERE facet_type = ? AND facet_value = ?
  `).get(type, facetValue) as Record<string, unknown> | undefined;
  const hasOfficialSource = Boolean(existing?.has_official_source);
  const existingNames = parseJson<Record<string, string>>(String(existing?.names_json ?? "{}"), {});
  const existingFacts = parseJson<Record<string, string | string[]>>(String(existing?.facts_json ?? "{}"), {});
  const existingMeasurements = parseJson<EntityExtendedProfile["measurements"]>(
    String(existing?.measurements_json ?? "{}"), {}
  );
  const existingSocialLinks = parseJson<Record<string, string>>(String(existing?.social_links_json ?? "{}"), {});
  const existingExternalIds = parseJson<Record<string, string>>(String(existing?.external_ids_json ?? "{}"), {});
  const existingOccupations = parseJson<string[]>(String(existing?.occupations_json ?? "[]"), []);
  const reservedActorIdentities = type === "actor" ? new Set((db.prepare(`
    SELECT facet_value AS value, aliases_json AS aliasesJson
    FROM entity_profiles
    WHERE facet_type = 'actor' AND facet_value != ?
  `).all(facetValue) as Array<{ value: string; aliasesJson: string }>).flatMap((row) => [
    row.value,
    ...parseJson<string[]>(row.aliasesJson, [])
  ]).map(normalizeActorIdentityKey).filter(Boolean)) : new Set<string>();
  const belongsToCurrentActor = (candidate: string) => type !== "actor"
    || [value, facetValue].some((current) => normalizeActorIdentityKey(current) === normalizeActorIdentityKey(candidate));
  const isUnclaimedActorIdentity = (candidate: string) => belongsToCurrentActor(candidate)
    || !reservedActorIdentities.has(normalizeActorIdentityKey(candidate));
  const aliases = [...new Set([
    ...parseJson<string[]>(String(existing?.aliases_json ?? existingIdentity?.aliasesJson ?? "[]"), []),
    value,
    ...profile.aliases
  ].filter(isActorNameCandidate).filter(isUnclaimedActorIdentity))];
  const mergedNames = hasOfficialSource ? { ...profile.names, ...existingNames } : { ...existingNames, ...profile.names };
  const names = Object.fromEntries(Object.entries(mergedNames)
    .filter(([, candidate]) => isUnclaimedActorIdentity(candidate)));
  const measurements = hasOfficialSource
    ? { ...profile.measurements, ...existingMeasurements }
    : { ...existingMeasurements, ...profile.measurements };
  const facts = hasOfficialSource ? { ...profile.facts, ...existingFacts } : { ...existingFacts, ...profile.facts };
  const socialLinks = hasOfficialSource
    ? { ...profile.socialLinks, ...existingSocialLinks }
    : { ...existingSocialLinks, ...profile.socialLinks };
  const externalIds = { ...profile.externalIds, ...existingExternalIds };
  const occupations = [...new Set([...existingOccupations, ...profile.occupations])];
  const existingBiography = String(existing?.biography ?? "");
  const biography = existingBiography.length > profile.biography.length ? existingBiography : profile.biography;
  const existingStatus = String(existing?.source_status ?? "");
  const sourceStatus = existingStatus === "verified" ? "verified"
    : existingStatus === "auto-resolved" ? "auto-resolved" : profile.status;
  db.transaction(() => {
    db.prepare(`
      INSERT INTO entity_profiles (
        facet_type, facet_value, display_name, names_json, aliases_json, biography,
        birth_date, birthplace, nationality, height_cm, measurements_json, facts_json, occupations_json,
        image_url, official_website, social_links_json, external_ids_json, wikidata_id,
        wikipedia_url, source_status, confidence, fetched_at, updated_at
      ) VALUES (
        @type, @facetValue, @displayName, @namesJson, @aliasesJson, @biography,
        @birthDate, @birthplace, @nationality, @heightCm, @measurementsJson, @factsJson, @occupationsJson,
        @imageUrl, @officialWebsite, @socialLinksJson, @externalIdsJson, @wikidataId,
        @wikipediaUrl, @sourceStatus, @confidence, @fetchedAt, @updatedAt
      )
      ON CONFLICT(facet_type, facet_value) DO UPDATE SET
        display_name = excluded.display_name, names_json = excluded.names_json,
        aliases_json = excluded.aliases_json, biography = excluded.biography,
        birth_date = excluded.birth_date, birthplace = excluded.birthplace,
        nationality = excluded.nationality, height_cm = excluded.height_cm,
        measurements_json = excluded.measurements_json, facts_json = excluded.facts_json,
        occupations_json = excluded.occupations_json,
        image_url = excluded.image_url, official_website = excluded.official_website,
        social_links_json = excluded.social_links_json, external_ids_json = excluded.external_ids_json,
        wikidata_id = excluded.wikidata_id, wikipedia_url = excluded.wikipedia_url,
        source_status = CASE WHEN entity_profiles.source_status = 'verified' THEN 'verified' ELSE excluded.source_status END,
        confidence = excluded.confidence, fetched_at = excluded.fetched_at, updated_at = excluded.updated_at
    `).run({
      type, facetValue,
      displayName: hasOfficialSource && existing?.display_name ? String(existing.display_name) : profile.displayName,
      namesJson: JSON.stringify(names), aliasesJson: JSON.stringify(aliases),
      biography,
      birthDate: hasOfficialSource && existing?.birth_date ? String(existing.birth_date) : profile.birthDate,
      birthplace: hasOfficialSource && existing?.birthplace ? String(existing.birthplace) : profile.birthplace || String(existing?.birthplace ?? ""),
      nationality: profile.nationality || String(existing?.nationality ?? ""),
      heightCm: hasOfficialSource && existing?.height_cm != null ? Number(existing.height_cm) : profile.heightCm,
      measurementsJson: JSON.stringify(measurements), factsJson: JSON.stringify(facts),
      occupationsJson: JSON.stringify(occupations),
      imageUrl: String(existing?.image_url ?? "") || profile.imageUrl,
      officialWebsite: String(existing?.official_website ?? "") || profile.officialWebsite,
      socialLinksJson: JSON.stringify(socialLinks), externalIdsJson: JSON.stringify(externalIds),
      wikidataId: profile.wikidataId || String(existing?.wikidata_id ?? ""),
      wikipediaUrl: profile.wikipediaUrl || String(existing?.wikipedia_url ?? ""),
      sourceStatus, confidence: Math.max(profile.confidence, Number(existing?.confidence ?? 0)),
      fetchedAt: profile.fetchedAt, updatedAt: now
    });
    // Each provider refresh is authoritative for that provider only. Sources from a verified
    // agency or official brand page remain attached when Wikidata/Wikipedia is refreshed.
    const incomingProviders = [...new Set(sources.map((source) => source.provider))];
    if (incomingProviders.length) db.prepare(`
      DELETE FROM entity_profile_sources
      WHERE facet_type = @type AND facet_value = @facetValue
        AND provider IN (SELECT CAST(value AS TEXT) FROM json_each(@providersJson))
    `).run({ type, facetValue, providersJson: JSON.stringify(incomingProviders) });
    const upsertSource = db.prepare(`
      INSERT INTO entity_profile_sources (
        id, facet_type, facet_value, provider, source_title, source_url, license,
        language, fields_json, payload_json, confidence, retrieved_at
      ) VALUES (@id, @type, @facetValue, @provider, @sourceTitle, @sourceUrl, @license,
        @language, @fieldsJson, @payloadJson, @confidence, @retrievedAt)
      ON CONFLICT(facet_type, facet_value, provider, source_url) DO UPDATE SET
        source_title = excluded.source_title, license = excluded.license,
        language = excluded.language, fields_json = excluded.fields_json,
        payload_json = excluded.payload_json, confidence = excluded.confidence,
        retrieved_at = excluded.retrieved_at
    `);
    for (const source of sources) upsertSource.run({
      id: crypto.randomUUID(), type, facetValue, provider: source.provider,
      sourceTitle: source.title, sourceUrl: source.url, license: source.license,
      language: source.language, fieldsJson: JSON.stringify(source.fields),
      payloadJson: JSON.stringify(source.facts ?? { wikidataId: profile.wikidataId, wikipediaUrl: profile.wikipediaUrl }),
      confidence: source.confidence, retrievedAt: source.retrievedAt
    });
  })();
}

export async function refreshEntityProfileImageAttribution(input: {
  type: PublicEntityType;
  value: string;
  wikidataId: string;
}): Promise<{ status: "updated" | "no-image" | "license-unresolved"; fileName?: string }> {
  const entity = await loadWikidataEntity(input.wikidataId);
  const fileName = claimString(entity, "P18");
  const commonsCategory = claimString(entity, "P373");
  const commonsImage = await resolveCommonsEntityImage(entity);
  const now = new Date().toISOString();
  const status = commonsImage ? "updated" : fileName ? "license-unresolved" : "no-image";
  db.transaction(() => {
    db.prepare(`
      DELETE FROM entity_profile_sources
      WHERE facet_type = @type AND facet_value = @value
        AND provider IN ('wikimedia-commons', 'wikimedia-commons-audit')
    `).run(input);
    db.prepare(`
      UPDATE entity_profiles SET image_url = @imageUrl, updated_at = @updatedAt
      WHERE facet_type = @type AND facet_value = @value AND wikidata_id = @wikidataId
    `).run({ ...input, imageUrl: commonsImage?.imageUrl ?? "", updatedAt: now });
    if (!commonsImage) {
      db.prepare(`
        INSERT INTO entity_profile_sources (
          id, facet_type, facet_value, provider, source_title, source_url, license,
          language, fields_json, payload_json, confidence, retrieved_at
        ) VALUES (
          @id, @type, @value, 'wikimedia-commons-audit', @sourceTitle,
          @sourceUrl, '', 'mul', '[]', @payloadJson, 1, @retrievedAt
        )
      `).run({
        ...input,
        id: crypto.randomUUID(),
        sourceTitle: fileName || `${input.wikidataId} 图片检查`,
        sourceUrl: `https://www.wikidata.org/wiki/${encodeURIComponent(input.wikidataId)}`,
        payloadJson: JSON.stringify({
          status,
          fileName,
          commonsCategory,
          retryAfter: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        }),
        retrievedAt: now
      });
      return;
    }
    db.prepare(`
      INSERT INTO entity_profile_sources (
        id, facet_type, facet_value, provider, source_title, source_url, license,
        language, fields_json, payload_json, confidence, retrieved_at
      ) VALUES (
        @id, @type, @value, 'wikimedia-commons', @sourceTitle, @sourceUrl, @license,
        'mul', '["imageUrl"]', @payloadJson, 1, @retrievedAt
      )
    `).run({
      ...input,
      id: crypto.randomUUID(),
      sourceTitle: commonsImage.attribution.fileName,
      sourceUrl: commonsImage.attribution.sourceUrl,
      license: commonsImage.attribution.license,
      payloadJson: JSON.stringify(commonsImageSourceFacts(commonsImage)),
      retrievedAt: now
    });
  })();
  if (commonsImage) return { status: "updated", fileName: commonsImage.attribution.fileName };
  return fileName ? { status: "license-unresolved", fileName } : { status: "no-image" };
}

function recordEnrichmentAttempt(input: {
  type: string;
  value: string;
  displayName: string;
  status: "matched" | "auto-resolved" | "not-found" | "failed";
  matchedExternalId?: string;
  confidence?: number;
  errorCode?: string;
  error?: string;
  decisionMethod?: string;
  decisionReason?: string;
  nextRetryAt?: string | null;
}): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO entity_profile_enrichment (
      facet_type, facet_value, display_name, status, attempt_count,
      matched_external_id, confidence, last_error_code, last_error,
      decision_method, decision_reason, last_attempt_at, next_retry_at, updated_at
    ) VALUES (
      @type, @value, @displayName, @status, 1,
      @matchedExternalId, @confidence, @errorCode, @error,
      @decisionMethod, @decisionReason, @now, @nextRetryAt, @now
    )
    ON CONFLICT(facet_type, facet_value) DO UPDATE SET
      display_name = excluded.display_name,
      status = excluded.status,
      attempt_count = entity_profile_enrichment.attempt_count + 1,
      matched_external_id = excluded.matched_external_id,
      confidence = excluded.confidence,
      last_error_code = excluded.last_error_code,
      last_error = excluded.last_error,
      decision_method = excluded.decision_method,
      decision_reason = excluded.decision_reason,
      last_attempt_at = excluded.last_attempt_at,
      next_retry_at = excluded.next_retry_at,
      updated_at = excluded.updated_at
  `).run({
    ...input,
    matchedExternalId: input.matchedExternalId ?? "",
    confidence: input.confidence ?? 0,
    errorCode: input.errorCode ?? "",
    error: (input.error ?? "").slice(0, 1000),
    decisionMethod: input.decisionMethod ?? "",
    decisionReason: (input.decisionReason ?? "").slice(0, 1000),
    nextRetryAt: input.nextRetryAt ?? null,
    now
  });
}

export function recordEntityEnrichmentFailure(type: string, value: string, displayName: string, error: unknown): void {
  if (type === "actor" && !isActorNameCandidate(value)) return;
  const message = error instanceof Error ? error.message : String(error);
  const errorCode = /429|rate/i.test(message) ? "rate-limited"
    : /timeout|timed out/i.test(message) ? "timeout"
      : "request-failed";
  const current = db.prepare(`
    SELECT attempt_count AS attemptCount FROM entity_profile_enrichment
    WHERE facet_type = ? AND facet_value = ?
  `).get(type, value) as { attemptCount: number } | undefined;
  const retryHours = Math.min(24, 2 ** Math.min(4, current?.attemptCount ?? 0));
  recordEnrichmentAttempt({
    type,
    value,
    displayName,
    status: "failed",
    errorCode,
    error: message,
    nextRetryAt: new Date(Date.now() + retryHours * 60 * 60 * 1000).toISOString()
  });
}

export function recordActorEnrichmentRejection(input: {
  value: string;
  displayName: string;
  errorCode: string;
  reason: string;
  retryDays?: number;
}): void {
  recordEntityEnrichmentRejection({ type: "actor", ...input });
}

export function recordEntityEnrichmentRejection(input: {
  type: PublicEntityType;
  value: string;
  displayName: string;
  errorCode: string;
  reason: string;
  retryDays?: number;
}): void {
  if (input.type === "actor" && (!isActorNameCandidate(input.value) || !isActorNameCandidate(input.displayName))) return;
  const retryDays = Math.max(1, Math.min(180, input.retryDays ?? 30));
  recordEnrichmentAttempt({
    type: input.type,
    value: input.value,
    displayName: input.displayName,
    status: "not-found",
    errorCode: input.errorCode,
    error: input.reason,
    decisionMethod: "autonomous-evidence-policy",
    decisionReason: input.reason,
    nextRetryAt: new Date(Date.now() + retryDays * 24 * 60 * 60 * 1000).toISOString()
  });
}

export async function enrichActorFromWikimedia(actorValue: string, names: string[], execute = false): Promise<EnrichmentPreview> {
  if (!isActorNameCandidate(actorValue)) {
    return { actorValue, matched: false, reason: "演员字段包含 HTML 或图片查看器残片，已跳过公开资料检索" };
  }
  const identityNames = [...new Set([actorValue, ...names].filter(isActorNameCandidate))];
  const matched = await findWikidataMatch(identityNames);
  if (!matched) {
    if (execute) recordEnrichmentAttempt({
      type: "actor",
      value: actorValue,
      displayName: identityNames[0] || actorValue,
      status: "not-found",
      errorCode: "no-unique-exact-match",
      error: "没有找到唯一、精确匹配的人物实体",
      nextRetryAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    });
    return { actorValue, matched: false, reason: "没有找到唯一、精确匹配的人物实体" };
  }
  const { entity, confidence, decision } = matched;
  const linkedIds = [claimEntityId(entity, "P19"), claimEntityId(entity, "P27"), ...claimEntityIds(entity, "P106")];
  const labels = await fetchEntityLabels(linkedIds);
  const wikiTargets = wikipediaTargets(entity);
  const wiki = wikiTargets[0] ?? null;
  const summary = await fetchWikipediaSummary(wiki).catch(() => ({ extract: "", imageUrl: "" }));
  const infoboxes: WikipediaInfoboxFacts[] = [];
  const successfulWikiTargets: WikipediaTarget[] = [];
  for (const target of wikiTargets) {
    try {
      infoboxes.push(await fetchWikipediaInfobox(target));
      successfulWikiTargets.push(target);
    } catch {
      // A secondary language edition must not invalidate otherwise trustworthy Wikidata fields.
    }
  }
  const wikidataHeight = claimHeightCm(entity);
  const wikidataBirthDate = claimDate(entity, "P569");
  const infobox = mergeWikipediaFacts([
    { heightCm: wikidataHeight, measurements: {} },
    ...infoboxes
  ]);
  const retrievedAt = new Date().toISOString();
  const entityNames = allEntityNames(entity);
  const displayName = entity.labels?.ja?.value?.trim() || localizedValue(entity.labels) || actorValue;
  const namesByLanguage = Object.fromEntries(Object.entries(entity.labels ?? {})
    .filter(([, item]) => item.value?.trim()).map(([language, item]) => [language, item.value!.trim()]));
  const commonsImage = await resolveCommonsEntityImage(entity);
  const officialWebsite = claimString(entity, "P856");
  const socialLinks = Object.fromEntries([
    claimString(entity, "P2002") ? ["x", `https://x.com/${claimString(entity, "P2002")}`] : null,
    claimString(entity, "P2003") ? ["instagram", `https://www.instagram.com/${claimString(entity, "P2003")}/`] : null,
    claimString(entity, "P2397") ? ["youtube", `https://www.youtube.com/channel/${claimString(entity, "P2397")}`] : null,
    claimString(entity, "P7085") ? ["tiktok", `https://www.tiktok.com/@${claimString(entity, "P7085")}`] : null
  ].filter((item): item is [string, string] => Boolean(item)));
  const externalIds = Object.fromEntries(Object.entries(entity.claims ?? {}).flatMap(([property, claims]) => {
    const value = claims.find((claim) => claim.rank !== "deprecated")?.mainsnak;
    return value?.datatype === "external-id" && typeof value.datavalue?.value === "string"
      ? [[property, value.datavalue.value] as [string, string]] : [];
  }));
  const profile = {
    displayName,
    names: namesByLanguage,
    aliases: [...new Set([actorValue, ...identityNames, ...entityNames])],
    biography: summary.extract,
    birthDate: wikidataBirthDate,
    birthplace: labels[claimEntityId(entity, "P19")] ?? "",
    nationality: labels[claimEntityId(entity, "P27")] ?? "",
    heightCm: infobox.facts.heightCm,
    measurements: infobox.facts.measurements,
    facts: {},
    occupations: claimEntityIds(entity, "P106").map((id) => labels[id]).filter(Boolean),
    imageUrl: commonsImage?.imageUrl ?? "",
    imageAttribution: commonsImage?.attribution ?? null,
    officialWebsite,
    socialLinks,
    externalIds,
    wikidataId: entity.id,
    wikipediaUrl: wiki?.url ?? "",
    status: infobox.hasConflict ? "auto-resolved" as const : "auto-matched" as const,
    confidence: infobox.hasConflict ? Math.min(confidence, 0.8) : confidence,
    fetchedAt: retrievedAt
  };
  const sources: EntityProfileSource[] = [{
    provider: "wikidata", title: `${displayName} · Wikidata`,
    url: `https://www.wikidata.org/wiki/${entity.id}`, license: "CC0 1.0", language: "mul",
    fields: ["names", "aliases", "birthDate", "birthplace", "nationality", "heightCm", "occupations", "imageReference", "socialLinks", "externalIds"],
    confidence, retrievedAt,
    facts: { heightCm: wikidataHeight, measurements: {}, birthDate: wikidataBirthDate }
  }];
  for (const [index, target] of successfulWikiTargets.entries()) sources.push({
    provider: "wikipedia", title: target.title, url: target.url,
    license: "CC BY-SA", language: target.language,
    fields: target.url === wiki?.url
      ? ["biography", "heightCm", "measurements"]
      : ["heightCm", "measurements"],
    confidence: Math.min(confidence, 0.9), retrievedAt,
    facts: infoboxes[index]
  });
  if (commonsImage) sources.push({
    provider: "wikimedia-commons",
    title: commonsImage.attribution.fileName,
    url: commonsImage.attribution.sourceUrl,
    license: commonsImage.attribution.license,
    language: "mul",
    fields: ["imageUrl"],
    confidence: 1,
    retrievedAt,
    facts: commonsImageSourceFacts(commonsImage)
  });
  const preview: EnrichmentPreview = { actorValue, matched: true, profile, sources, identityDecision: decision };
  if (execute) {
    upsertEntityProfile({ type: "actor", value: actorValue, profile, sources });
    recordEnrichmentAttempt({
      type: "actor",
      value: actorValue,
      displayName: profile.displayName,
      status: profile.status === "auto-resolved" ? "auto-resolved" : "matched",
      matchedExternalId: profile.wikidataId,
      confidence: profile.confidence,
      decisionMethod: decision.method,
      decisionReason: decision.reason
    });
  }
  return preview;
}

type GenericIdentityEvidence = {
  id: string;
  names: string[];
  descriptions: Record<string, string>;
  entityKind: "human" | "organization";
  hasWikipedia: boolean;
  hasOfficialWebsite: boolean;
  roleSignals: string[];
};

const DIRECTOR_DESCRIPTION = /director|filmmaker|監督|导演|導演/iu;
const MEDIA_ORGANIZATION_DESCRIPTION = /adult\s*(?:video|film)|pornograph|film\s+production|video\s+production|motion\s+picture|AV(?:\s|-)?(?:maker|studio|manufacturer|label)|アダルト(?:ビデオ|映画)|AV(?:メーカー|レーベル|制作|製作)|映像(?:制作|製作|メーカー)|成人视频|成人(?:影片|影像)|AV片商|色情片|电影制作公司|電影製作公司/iu;
const SERIES_DESCRIPTION = /series|franchise|作品シリーズ|企画シリーズ|系列|シリーズ/iu;
const PUBLIC_ENTITY_AI_TIMEOUT_MS = 30_000;

function genericRoleSignals(type: Exclude<PublicEntityType, "actor">, entity: WikidataEntity): string[] {
  const descriptions = Object.values(entity.descriptions ?? {}).map((item) => item.value ?? "").filter(Boolean);
  const matcher = type === "director" ? DIRECTOR_DESCRIPTION
    : type === "series" ? SERIES_DESCRIPTION : MEDIA_ORGANIZATION_DESCRIPTION;
  const matching = descriptions.filter((description) => matcher.test(description));
  return [...new Set(matching)].slice(0, 8);
}

export function isPublicEntityRoleCompatible(
  type: Exclude<PublicEntityType, "actor">,
  roleSignals: string[]
): boolean {
  if (type === "director") return roleSignals.some((signal) => DIRECTOR_DESCRIPTION.test(signal));
  if (type === "series") return roleSignals.some((signal) => SERIES_DESCRIPTION.test(signal));
  return roleSignals.some((signal) => MEDIA_ORGANIZATION_DESCRIPTION.test(signal));
}

function scoreGenericIdentityCandidate(input: {
  hasWikipedia: boolean;
  hasOfficialWebsite: boolean;
  exactPrimaryName: boolean;
  hasRoleSignal: boolean;
}): number {
  return Math.min(0.97, 0.68 + (input.hasWikipedia ? 0.1 : 0) + (input.hasOfficialWebsite ? 0.06 : 0) +
    (input.exactPrimaryName ? 0.05 : 0) + (input.hasRoleSignal ? 0.08 : 0));
}

export async function judgePublicEntityIdentityWithLocalAi(
  type: Exclude<PublicEntityType, "actor">,
  names: string[],
  candidates: GenericIdentityEvidence[]
): Promise<{ selectedId: string; confidence: number; reason: string } | null> {
  try {
    const response = await fetch(`${config.externalAi.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.externalAi.chatModel,
        stream: false,
        think: false,
        format: "json",
        options: { temperature: 0, num_ctx: 4096, num_predict: 350 },
        messages: [
          {
            role: "system",
            content: `你负责${type === "director" ? "导演人物" : type === "maker" ? "影视厂商" : type === "series" ? "影视系列" : "影视厂牌"}实体消歧。` +
              "根据馆藏原名、译名、公开候选名称、简介、实体类型、Wikipedia 和官网信号，自主判断是否为同一实体。" +
              "同名但类别或业务不一致必须拒绝；证据不足 selectedId 必须为 null。只输出 JSON：{selectedId:string|null,confidence:number,reason:string}。"
          },
          { role: "user", content: JSON.stringify({ entityType: type, libraryNames: names, candidates }) }
        ]
      }),
      signal: AbortSignal.timeout(PUBLIC_ENTITY_AI_TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const body = await response.json() as { message?: { content?: string } };
    const json = body.message?.content?.match(/\{[\s\S]*\}/u)?.[0];
    if (!json) return null;
    const decision = JSON.parse(json) as { selectedId?: unknown; confidence?: unknown; reason?: unknown };
    const selectedId = typeof decision.selectedId === "string" ? decision.selectedId : "";
    const confidence = Number(decision.confidence);
    const selected = candidates.find((item) => item.id === selectedId);
    if (!selected || !isPublicEntityRoleCompatible(type, selected.roleSignals) ||
      !Number.isFinite(confidence) || confidence < 0.82) return null;
    return {
      selectedId,
      confidence: Math.min(0.9, confidence),
      reason: typeof decision.reason === "string" ? decision.reason.slice(0, 500) : "本地模型完成公开实体消歧"
    };
  } catch {
    return null;
  }
}

async function findGenericWikidataMatch(type: Exclude<PublicEntityType, "actor">, names: string[]): Promise<{
  entity: WikidataEntity;
  confidence: number;
  decision: { method: "exact-rule" | "local-ai"; reason: string };
} | null> {
  const identityNames = type === "director"
    ? expandActorIdentityNames(names)
    : [...new Set(names.map((name) => name.normalize("NFKC").trim()).filter(Boolean))];
  const expected = new Set(identityNames.map(normalizeName).filter(Boolean));
  const expectedPrimary = new Set(identityNames.map(normalizePrimaryName).filter(Boolean));
  const candidates = [...await searchWikidata(identityNames), ...await searchWikipediaEntityIds(identityNames)];
  const inspected = new Set<string>();
  const matches: Array<{ entity: WikidataEntity; score: number; evidence: GenericIdentityEvidence }> = [];
  for (const candidate of candidates.slice(0, 28)) {
    if (inspected.has(candidate.id)) continue;
    inspected.add(candidate.id);
    const entity = await loadWikidataEntity(candidate.id);
    const namesForEntity = allEntityNames(entity);
    if (!namesForEntity.map(normalizeName).some((name) => expected.has(name))) continue;
    const isHuman = claimEntityIds(entity, "P31").includes("Q5");
    if (type === "director" ? !isHuman : isHuman) continue;
    const roleSignals = genericRoleSignals(type, entity);
    if (!isPublicEntityRoleCompatible(type, roleSignals)) continue;
    const evidence: GenericIdentityEvidence = {
      id: entity.id,
      names: namesForEntity.slice(0, 40),
      descriptions: Object.fromEntries(Object.entries(entity.descriptions ?? {})
        .filter(([language]) => ["zh", "ja", "en"].includes(language))
        .map(([language, item]) => [language, item.value ?? ""])),
      entityKind: isHuman ? "human" : "organization",
      hasWikipedia: Boolean(entity.sitelinks?.jawiki || entity.sitelinks?.zhwiki || entity.sitelinks?.enwiki),
      hasOfficialWebsite: Boolean(claimString(entity, "P856")),
      roleSignals
    };
    matches.push({
      entity,
      evidence,
      score: scoreGenericIdentityCandidate({
        hasWikipedia: evidence.hasWikipedia,
        hasOfficialWebsite: evidence.hasOfficialWebsite,
        exactPrimaryName: Object.values(entity.labels ?? {}).some((item) => expectedPrimary.has(normalizePrimaryName(item.value ?? ""))),
        hasRoleSignal: roleSignals.length > 0
      })
    });
  }
  matches.sort((left, right) => right.score - left.score);
  if (!matches[0]) return null;
  const gap = matches[1] ? matches[0].score - matches[1].score : 1;
  if (matches[0].score < 0.92 || gap <= 0.05) {
    const decision = await judgePublicEntityIdentityWithLocalAi(type, identityNames, matches.slice(0, 6).map((item) => item.evidence));
    const selected = decision ? matches.find((item) => item.entity.id === decision.selectedId) : null;
    return selected && decision ? {
      entity: selected.entity,
      confidence: decision.confidence,
      decision: { method: "local-ai", reason: decision.reason }
    } : null;
  }
  return {
    entity: matches[0].entity,
    confidence: matches[0].score,
    decision: { method: "exact-rule", reason: "原始主名、公开实体类别、Wikipedia 与官网信号形成唯一高分实体" }
  };
}

function collectPersistedPublicEntityNames(
  type: Exclude<PublicEntityType, "actor">,
  seedNames: string[]
): string[] {
  const expected = new Set(seedNames.map(publicEntityNameKey).filter(Boolean));
  if (!expected.size) return [];
  const rows = db.prepare(`
    SELECT facet_value AS value, display_name AS displayName,
      names_json AS namesJson, aliases_json AS aliasesJson
    FROM entity_profiles WHERE facet_type = ?
  `).all(type) as Array<{
    value: string;
    displayName: string;
    namesJson: string;
    aliasesJson: string;
  }>;
  return rows.flatMap((row) => {
    const names = [
      row.value,
      row.displayName,
      ...Object.values(parseJson<Record<string, string>>(row.namesJson, {})),
      ...parseJson<string[]>(row.aliasesJson, [])
    ].filter(Boolean);
    return names.some((name) => expected.has(publicEntityNameKey(name))) ? names : [];
  });
}

function collectPublicEntityMetadataNamePairs(
  type: Exclude<PublicEntityType, "actor">
): PublicEntityNamePair[] {
  const columns = type === "director"
    ? { source: "director", localized: "director_zh" }
    : type === "maker"
      ? { source: "maker", localized: "maker_zh" }
      : type === "series"
        ? { source: "series", localized: "series_zh" }
        : { source: "label", localized: "label_zh" };
  return db.prepare(`
    SELECT DISTINCT ${columns.source} AS sourceName, ${columns.localized} AS localizedName
    FROM media_metadata
    WHERE status = 'ready' AND TRIM(${columns.source}) != ''
  `).all() as PublicEntityNamePair[];
}

export function getPublicEntitySearchNames(
  type: Exclude<PublicEntityType, "actor">,
  value: string,
  names: string[]
): string[] {
  const seeds = [value, ...names].filter(Boolean);
  return buildPublicEntitySearchNames(
    type,
    seeds,
    collectPublicEntityMetadataNamePairs(type),
    collectPersistedPublicEntityNames(type, seeds)
  );
}

export async function enrichPublicEntityFromWikimedia(
  type: Exclude<PublicEntityType, "actor">,
  value: string,
  names: string[],
  execute = true
): Promise<PublicEntityEnrichmentPreview> {
  const searchNames = getPublicEntitySearchNames(type, value, names);
  const matched = await findGenericWikidataMatch(type, searchNames);
  if (!matched) {
    if (execute) recordEnrichmentAttempt({
      type, value, displayName: names[0] || value, status: "not-found",
      errorCode: "no-confident-autonomous-match",
      error: "规则与本地 AI 未形成可靠的同一实体判断",
      nextRetryAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    });
    return { type, value, matched: false, reason: "规则与本地 AI 未形成可靠的同一实体判断" };
  }
  const { entity, confidence, decision } = matched;
  const properties = type === "director"
    ? ["P19", "P27", "P106"]
    : ["P159", "P17", "P452", "P749", "P1454", "P31"];
  const linkedIds = properties.flatMap((property) => claimEntityIds(entity, property));
  const labels = await fetchEntityLabels(linkedIds);
  const wikiTargets = wikipediaTargets(entity);
  const wiki = wikiTargets[0] ?? null;
  const summary = await fetchWikipediaSummary(wiki).catch(() => ({ extract: "", imageUrl: "" }));
  const retrievedAt = new Date().toISOString();
  const displayName = entity.labels?.ja?.value?.trim() || localizedValue(entity.labels) || value;
  const namesByLanguage = Object.fromEntries(Object.entries(entity.labels ?? {})
    .filter(([, item]) => item.value?.trim()).map(([language, item]) => [language, item.value!.trim()]));
  const imageName = claimString(entity, "P18");
  const commonsImage = imageName
    ? await fetchCommonsImageAttribution(imageName).catch(() => null)
    : null;
  const officialWebsite = claimString(entity, "P856");
  const facts: Record<string, string | string[]> = type === "director" ? {} : {
    ...(claimDate(entity, "P571") ? { inceptionDate: claimDate(entity, "P571")! } : {}),
    ...(claimEntityId(entity, "P159") ? { headquarters: labels[claimEntityId(entity, "P159")] ?? claimEntityId(entity, "P159") } : {}),
    ...(claimEntityId(entity, "P17") ? { country: labels[claimEntityId(entity, "P17")] ?? claimEntityId(entity, "P17") } : {}),
    ...(claimEntityIds(entity, "P452").length ? { industry: claimEntityIds(entity, "P452").map((id) => labels[id] ?? id) } : {}),
    ...(claimEntityId(entity, "P749") ? { parentOrganization: labels[claimEntityId(entity, "P749")] ?? claimEntityId(entity, "P749") } : {}),
    ...(claimEntityId(entity, "P1454") ? { legalForm: labels[claimEntityId(entity, "P1454")] ?? claimEntityId(entity, "P1454") } : {}),
    ...(claimEntityIds(entity, "P31").length ? { entityTypes: claimEntityIds(entity, "P31").map((id) => labels[id] ?? id) } : {})
  };
  const profile = {
    displayName,
    names: namesByLanguage,
    aliases: [...new Set([...searchNames, ...publicEntityAliases(type, value, entity)])],
    biography: summary.extract,
    birthDate: type === "director" ? claimDate(entity, "P569") : null,
    birthplace: type === "director" ? labels[claimEntityId(entity, "P19")] ?? "" : "",
    nationality: type === "director" ? labels[claimEntityId(entity, "P27")] ?? "" : String(facts.country ?? ""),
    heightCm: null,
    measurements: {},
    facts,
    occupations: type === "director" ? claimEntityIds(entity, "P106").map((id) => labels[id]).filter(Boolean) : [],
    imageUrl: commonsImage?.imageUrl ?? "",
    imageAttribution: commonsImage?.attribution ?? null,
    officialWebsite,
    socialLinks: {},
    externalIds: Object.fromEntries(Object.entries(entity.claims ?? {}).flatMap(([property, claims]) => {
      const claim = claims.find((item) => item.rank !== "deprecated")?.mainsnak;
      return claim?.datatype === "external-id" && typeof claim.datavalue?.value === "string"
        ? [[property, claim.datavalue.value] as [string, string]] : [];
    })),
    wikidataId: entity.id,
    wikipediaUrl: wiki?.url ?? "",
    status: "auto-matched" as const,
    confidence,
    fetchedAt: retrievedAt
  };
  const sources: EntityProfileSource[] = [{
    provider: "wikidata", title: `${displayName} · Wikidata`,
    url: `https://www.wikidata.org/wiki/${entity.id}`, license: "CC0 1.0", language: "mul",
    fields: ["names", "aliases", "birthDate", "birthplace", "nationality", "occupations", "facts", "imageReference", "officialWebsite", "externalIds"],
    confidence, retrievedAt, facts: { ...facts, birthDate: profile.birthDate }
  }];
  if (wiki) sources.push({
    provider: "wikipedia", title: wiki.title, url: wiki.url, license: "CC BY-SA", language: wiki.language,
    fields: ["biography"], confidence: Math.min(confidence, 0.9), retrievedAt
  });
  if (commonsImage) sources.push({
    provider: "wikimedia-commons",
    title: commonsImage.attribution.fileName,
    url: commonsImage.attribution.sourceUrl,
    license: commonsImage.attribution.license,
    language: "mul",
    fields: ["imageUrl"],
    confidence: 1,
    retrievedAt,
    facts: { imageUrl: commonsImage.imageUrl, image: commonsImage.attribution, licenseDecision: commonsImage.cacheDecision }
  });
  const preview: PublicEntityEnrichmentPreview = { type, value, matched: true, profile, sources, identityDecision: decision };
  if (execute) {
    upsertEntityProfile({ type, value, profile, sources });
    recordEnrichmentAttempt({
      type, value, displayName: profile.displayName, status: "matched",
      matchedExternalId: profile.wikidataId, confidence: profile.confidence,
      decisionMethod: decision.method, decisionReason: decision.reason
    });
  }
  return preview;
}

export function getEntityProfileCoverage(type: string, candidates: EntityProfileCandidate[]): EntityProfileCoverage {
  const eligibleCandidates = type === "actor"
    ? candidates.flatMap((candidate): EntityProfileCandidate[] => {
      if (!isActorNameCandidate(candidate.value)) return [];
      return [{
        value: candidate.value,
        aliases: (candidate.aliases ?? []).filter(isActorNameCandidate)
      }];
    })
    : candidates;
  const profileRows = db.prepare(`
    SELECT facet_value AS value, aliases_json AS aliasesJson, source_status AS status,
      birth_date AS birthDate, height_cm AS heightCm, measurements_json AS measurementsJson,
      biography, wikipedia_url AS wikipediaUrl, official_website AS officialWebsite,
      facts_json AS factsJson,
      EXISTS (
        SELECT 1 FROM entity_profile_sources sources
        WHERE sources.facet_type = entity_profiles.facet_type
          AND sources.facet_value = entity_profiles.facet_value
          AND ((sources.provider = 'wikimedia-commons'
            AND json_extract(sources.payload_json, '$.imageUrl') != ''
            AND (json_extract(sources.payload_json, '$.licenseDecision') = 'allowed-v1'
              OR (@researchImagePolicy = 1
                AND json_extract(sources.payload_json, '$.licenseDecision') = 'research-cache-v1')))
          OR (sources.provider LIKE 'official-%'
            AND json_extract(sources.payload_json, '$.profileImageCandidateUrl') != '')
          OR (entity_profiles.facet_type = 'actor' AND sources.provider = 'public-r18dev-actor'
            AND json_extract(sources.payload_json, '$.profileImageCandidateUrl') != ''))
      ) AS hasLicensedImage
    FROM entity_profiles WHERE facet_type = @type
  `).all({ type, researchImagePolicy: config.externalAi.entityProfileImagePolicy === "research" ? 1 : 0 }) as Array<{
    value: string;
    aliasesJson: string;
    status: EntityExtendedProfile["status"];
    birthDate: string | null;
    heightCm: number | null;
    measurementsJson: string;
    biography: string;
    hasLicensedImage: number;
    wikipediaUrl: string;
    officialWebsite: string;
    factsJson: string;
  }>;
  const attemptRows = db.prepare(`
    SELECT facet_value AS value, status FROM entity_profile_enrichment WHERE facet_type = ?
  `).all(type) as Array<{ value: string; status: string }>;
  // Keep coverage aligned with getEntityExtendedProfile: spacing and common
  // punctuation variants are the same exact identity hint, while collisions
  // still resolve to null below instead of being merged ambiguously.
  const coverageKey = (value: string) => type === "actor" ? normalizeActorIdentityKey(value) : normalizeName(value);
  const profiles = profileRows.map((row) => ({
    status: row.status,
    values: new Set([row.value, ...parseJson<string[]>(row.aliasesJson, [])]
      .map(coverageKey).filter(Boolean)),
    birthDate: Boolean(row.birthDate),
    height: row.heightCm != null,
    measurements: (() => {
      const facts = parseJson<EntityExtendedProfile["measurements"]>(row.measurementsJson, {});
      return facts.bustCm != null && facts.waistCm != null && facts.hipsCm != null;
    })(),
    biography: Boolean(row.biography.trim()),
    image: Boolean(row.hasLicensedImage),
    wikipedia: Boolean(row.wikipediaUrl.trim()),
    officialWebsite: Boolean(row.officialWebsite.trim()),
    structuredFacts: Object.keys(parseJson<Record<string, unknown>>(row.factsJson, {})).length > 0
  }));
  const profileByValue = new Map<string, typeof profiles[number] | null>();
  for (const profile of profiles) {
    for (const value of profile.values) {
      const existing = profileByValue.get(value);
      profileByValue.set(value, existing && existing !== profile ? null : profile);
    }
  }
  const attempts = new Map(attemptRows.map((row) => [coverageKey(row.value), row.status]));
  let verified = 0;
  let autoMatched = 0;
  let autoResolved = 0;
  let noMatch = 0;
  let failed = 0;
  let withBirthDate = 0;
  let withHeight = 0;
  let withMeasurements = 0;
  let withBiography = 0;
  let withImage = 0;
  let withWikipedia = 0;
  let withOfficialWebsite = 0;
  let withStructuredFacts = 0;
  for (const candidate of eligibleCandidates) {
    const values = [candidate.value, ...(candidate.aliases ?? [])].map(coverageKey).filter(Boolean);
    const profile = values.map((value) => profileByValue.get(value)).find((item) => item != null);
    if (profile?.status === "verified") verified += 1;
    else if (profile?.status === "auto-resolved") autoResolved += 1;
    else if (profile) autoMatched += 1;
    else {
      const attempt = values.map((value) => attempts.get(value)).find(Boolean);
      if (attempt === "not-found") noMatch += 1;
      else if (attempt === "failed") failed += 1;
    }
    if (profile) {
      if (profile.birthDate) withBirthDate += 1;
      if (profile.height) withHeight += 1;
      if (profile.measurements) withMeasurements += 1;
      if (profile.biography) withBiography += 1;
      if (profile.image) withImage += 1;
      if (profile.wikipedia) withWikipedia += 1;
      if (profile.officialWebsite) withOfficialWebsite += 1;
      if (profile.structuredFacts) withStructuredFacts += 1;
    }
  }
  const enriched = verified + autoMatched + autoResolved;
  const total = eligibleCandidates.length;
  return {
    total,
    enriched,
    verified,
    autoMatched,
    autoResolved,
    noMatch,
    failed,
    pending: Math.max(0, total - enriched - noMatch - failed),
    coveragePercent: total ? Math.round(enriched / total * 1000) / 10 : 0,
    withBirthDate,
    withHeight,
    withMeasurements,
    withBiography,
    withImage,
    withWikipedia,
    withOfficialWebsite,
    withStructuredFacts
  };
}

export function getEntityExtendedProfile(type: string, value: string): EntityExtendedProfile | null {
  const canonicalValue = type === "actor" ? getCanonicalActorName(value) || value : value;
  let row = db.prepare(`
    SELECT * FROM entity_profiles
    WHERE facet_type = @type AND (
      facet_value IN (@value, @canonicalValue) OR EXISTS (
        SELECT 1 FROM json_each(entity_profiles.aliases_json)
        WHERE TRIM(CAST(value AS TEXT)) IN (@value, @canonicalValue)
      )
    )
    ORDER BY CASE WHEN facet_value = @canonicalValue THEN 0 WHEN facet_value = @value THEN 1 ELSE 2 END, confidence DESC
    LIMIT 1
  `).get({ type, value, canonicalValue }) as Record<string, unknown> | undefined;
  if (!row) {
    const identityKey = type === "actor" ? normalizeActorIdentityKey : normalizeName;
    const normalizedTargets = new Set([value, canonicalValue].map(identityKey).filter(Boolean));
    const normalizedMatches = (db.prepare(`
      SELECT facet_value AS value, aliases_json AS aliasesJson
      FROM entity_profiles WHERE facet_type = @type
    `).all({ type }) as Array<{ value: string; aliasesJson: string }>).filter((candidate) =>
      [candidate.value, ...parseJson<string[]>(candidate.aliasesJson, [])]
        .some((alias) => normalizedTargets.has(identityKey(alias)))
    );
    if (normalizedMatches.length === 1) {
      row = db.prepare("SELECT * FROM entity_profiles WHERE facet_type = ? AND facet_value = ?")
        .get(type, normalizedMatches[0]!.value) as Record<string, unknown> | undefined;
    }
  }
  if (!row) return null;
  const sources = db.prepare(`
    SELECT provider, source_title AS title, source_url AS url, license, language,
      fields_json AS fieldsJson, payload_json AS payloadJson, confidence, retrieved_at AS retrievedAt
    FROM entity_profile_sources
    WHERE facet_type = ? AND facet_value = ? AND provider != 'wikimedia-commons-audit'
    ORDER BY confidence DESC, retrieved_at DESC
  `).all(type, row.facet_value) as Array<Record<string, unknown>>;
  const profileSources: EntityProfileSource[] = sources.map((source) => {
    const payload = parseJson<Record<string, unknown>>(String(source.payloadJson), {});
    const measurements = payload.measurements && typeof payload.measurements === "object"
      ? payload.measurements as WikipediaInfoboxFacts["measurements"] : {};
    return {
      provider: String(source.provider), title: String(source.title), url: String(source.url),
      license: String(source.license), language: String(source.language),
      fields: parseJson(String(source.fieldsJson), []), confidence: Number(source.confidence),
      retrievedAt: String(source.retrievedAt),
      ...(Object.keys(payload).length ? { facts: {
        ...payload,
        ...(Object.hasOwn(payload, "heightCm") ? { heightCm: typeof payload.heightCm === "number" ? payload.heightCm : null } : {}),
        ...(Object.hasOwn(payload, "measurements") ? { measurements } : {}),
        ...(Object.hasOwn(payload, "birthDate") ? { birthDate: typeof payload.birthDate === "string" ? payload.birthDate : null } : {})
      } } : {})
    };
  });
  const commonsSource = profileSources.find((source) => source.provider === "wikimedia-commons");
  const commonsImage = commonsSource?.facts?.image;
  const licensedImageUrl = typeof commonsSource?.facts?.imageUrl === "string"
    ? safeWikimediaUrl(commonsSource.facts.imageUrl, ["upload.wikimedia.org"]) : "";
  const imageAttribution = commonsImage && typeof commonsImage === "object"
    ? commonsImage as EntityImageAttribution : null;
  const safeCommonsSourceUrl = safeWikimediaUrl(imageAttribution?.sourceUrl ?? "", ["commons.wikimedia.org"]);
  const copyrighted = typeof imageAttribution?.copyrighted === "boolean" ? imageAttribution.copyrighted : null;
  const licenseDecision = commonsSource?.facts?.licenseDecision;
  const strictAttributionValid = Boolean(safeCommonsSourceUrl && imageAttribution?.creator &&
    imageAttribution.license && imageAttribution.licenseUrl &&
    isAllowedCommonsLicense(imageAttribution.license, imageAttribution.licenseUrl, copyrighted));
  const hasLicensedImage = Boolean(licensedImageUrl &&
    isEntityImageAttributionAccepted(imageAttribution, licenseDecision));
  if (imageAttribution && !imageAttribution.rightsStatus) {
    imageAttribution.rightsStatus = strictAttributionValid
      ? (imageAttribution.licenseUrl.includes("/publicdomain/") ? "public-domain" : "open-license")
      : "unknown";
  }
  const officialImageSource = profileSources.find((source) => {
    if (source.provider.startsWith("official-")) {
      return !(type === "director" && source.provider.includes("product-bridge")) &&
        Boolean(safeOfficialAgencyImageUrl(source.url, source.facts?.profileImageCandidateUrl));
    }
    return type === "actor" && source.provider === "public-r18dev-actor" &&
      Boolean(safePublicActorDirectoryImageUrl(source.url, source.facts?.profileImageCandidateUrl));
  });
  const officialImageUrl = officialImageSource
    ? safeOfficialAgencyImageUrl(officialImageSource.url, officialImageSource.facts?.profileImageCandidateUrl) ||
      safePublicActorDirectoryImageUrl(officialImageSource.url, officialImageSource.facts?.profileImageCandidateUrl)
    : "";
  const officialImageAttribution: EntityImageAttribution | null = officialImageSource && officialImageUrl ? {
    fileName: (() => {
      try { return decodeURIComponent(new URL(officialImageUrl).pathname.split("/").filter(Boolean).at(-1) ?? "official-profile-image"); }
      catch { return "official-profile-image"; }
    })(),
    sourceUrl: officialImageSource.url,
    creator: [officialImageSource.facts?.agency, officialImageSource.facts?.brandName,
      officialImageSource.facts?.organizationName]
      .find((value) => typeof value === "string" && value.trim()) as string ||
      (officialImageSource.provider === "public-r18dev-actor" ? "R18.dev 演员索引" : officialImageSource.provider),
    license: "unknown",
    licenseUrl: "",
    rightsStatus: "unknown",
    originalUrl: officialImageUrl
  } : null;
  const selectedImageUrl = hasLicensedImage ? licensedImageUrl : officialImageUrl;
  const selectedImageAttribution = hasLicensedImage ? imageAttribution : officialImageAttribution;
  const storedDisplayName = String(row.display_name).normalize("NFKC").trim() || String(row.facet_value);
  const names = parseJson<Record<string, string>>(String(row.names_json), {});
  const storedAliases = parseJson<string[]>(String(row.aliases_json), []);
  const displayName = chooseLocalizedEntityDisplayName({
    type: String(row.facet_type),
    storedDisplayName,
    names,
    localizedCandidates: getMetadataLocalizedEntityNames(String(row.facet_type), [
      String(row.facet_value), storedDisplayName, ...storedAliases, ...Object.values(names)
    ])
  });
  const originalName = chooseEntityOriginalName({
    facetValue: String(row.facet_value), storedDisplayName, displayName, names
  });
  const aliases = [...new Set([
    ...storedAliases,
    ...(originalName ? [originalName] : [])
  ].map((alias) => alias.trim()).filter(Boolean))];
  const profile: EntityExtendedProfile = {
    type: String(row.facet_type), value: String(row.facet_value), displayName,
    ...(originalName ? { originalName } : {}),
    names, aliases,
    biography: localizeEntityBiography(String(row.biography)), birthDate: row.birth_date ? String(row.birth_date) : null,
    birthplace: String(row.birthplace), nationality: String(row.nationality),
    heightCm: row.height_cm == null ? null : Number(row.height_cm),
    measurements: parseJson(String(row.measurements_json), {}),
    facts: parseJson(String(row.facts_json ?? "{}"), {}), occupations: parseJson(String(row.occupations_json), []),
    imageUrl: selectedImageUrl,
    imageAttribution: selectedImageAttribution,
    officialWebsite: String(row.official_website),
    socialLinks: parseJson(String(row.social_links_json), {}), externalIds: parseJson(String(row.external_ids_json), {}),
    wikidataId: String(row.wikidata_id), wikipediaUrl: String(row.wikipedia_url),
    status: String(row.source_status) as EntityExtendedProfile["status"], confidence: Number(row.confidence),
    fetchedAt: row.fetched_at ? String(row.fetched_at) : null,
    updatedAt: String(row.updated_at),
    sources: profileSources
  };
  return profile;
}

export function actorCupRank(value: string | undefined): number {
  const normalized = normalizeActorCup(value);
  if (!normalized) return 0;
  const letters = normalized.replace(/\+/g, "");
  if (!letters) return 0;
  const base = letters === "AA" ? 0.5 : Math.max(1, letters.at(-1)!.charCodeAt(0) - 64) + (letters.length - 1) * 0.1;
  return base + (normalized.match(/\+/g)?.length ?? 0) * 0.25;
}

function dateRank(value: string | null): number {
  const [year, month = "01", day = "01"] = String(value ?? "").split("-");
  if (!/^\d{4}$/u.test(year)) return 0;
  return Number(`${year}${month.padStart(2, "0")}${day.padStart(2, "0")}`);
}

export function rankActorProfiles(input: ActorProfileRankingInput, resultLimitCap = 20): {
  profileTotal: number;
  eligibleTotal: number;
  rows: ActorProfileRankingRow[];
} {
  const rows = db.prepare(`
    WITH profile_aliases AS (
      SELECT facet_value AS profileValue, facet_value AS alias
      FROM entity_profiles
      WHERE facet_type = 'actor' AND source_status NOT IN ('unverified', 'not-found', 'failed')
      UNION
      SELECT profiles.facet_value AS profileValue, TRIM(CAST(alias.value AS TEXT)) AS alias
      FROM entity_profiles profiles, json_each(profiles.aliases_json) alias
      WHERE profiles.facet_type = 'actor' AND profiles.source_status NOT IN ('unverified', 'not-found', 'failed')
        AND TRIM(CAST(alias.value AS TEXT)) != ''
    ), media_counts AS (
      SELECT profile_aliases.profileValue, COUNT(DISTINCT facets.normalized_code) AS mediaCount
      FROM profile_aliases
      LEFT JOIN media_metadata_facets facets
        ON facets.facet_type = 'actor' AND facets.facet_value = profile_aliases.alias
      GROUP BY profile_aliases.profileValue
    ), actor_localizations AS (
      SELECT profile_aliases.profileValue,
        TRIM(CAST(translated.value AS TEXT)) AS localizedLabel,
        MAX(CASE WHEN profile_aliases.alias = profile_aliases.profileValue THEN 1 ELSE 0 END) AS canonicalMatch,
        COUNT(*) AS frequency
      FROM media_metadata metadata
      JOIN json_each(metadata.actors_json) source
      LEFT JOIN json_each(metadata.actors_zh_json) translated ON translated.key = source.key
      JOIN profile_aliases ON profile_aliases.alias = TRIM(CAST(source.value AS TEXT))
      WHERE TRIM(COALESCE(CAST(translated.value AS TEXT), '')) != ''
        AND metadata.status = 'ready' AND metadata.translation_status = 'ready'
      GROUP BY profile_aliases.profileValue, TRIM(CAST(translated.value AS TEXT))
    ), preferred_actor_localizations AS (
      SELECT profileValue, localizedLabel
      FROM (
        SELECT profileValue, localizedLabel,
          ROW_NUMBER() OVER (
            PARTITION BY profileValue
            ORDER BY (localizedLabel GLOB '*[一-龯]*'
              AND localizedLabel NOT GLOB '*[ぁ-ゖァ-ヺ]*') DESC,
              canonicalMatch DESC,
              frequency DESC, localizedLabel COLLATE NOCASE ASC
          ) AS localizationRank
        FROM actor_localizations
      )
      WHERE localizationRank = 1
    )
    SELECT profiles.facet_value AS value, profiles.display_name AS label,
      profiles.names_json AS namesJson,
      preferred_actor_localizations.localizedLabel,
      profiles.birth_date AS birthDate, profiles.height_cm AS heightCm,
      profiles.measurements_json AS measurementsJson, profiles.biography,
      EXISTS (
        SELECT 1 FROM entity_profile_sources sources
        WHERE sources.facet_type = profiles.facet_type
          AND sources.facet_value = profiles.facet_value
          AND ((sources.provider = 'wikimedia-commons'
            AND json_extract(sources.payload_json, '$.imageUrl') != ''
            AND (json_extract(sources.payload_json, '$.licenseDecision') = 'allowed-v1'
              OR (@researchImagePolicy = 1
                AND json_extract(sources.payload_json, '$.licenseDecision') = 'research-cache-v1')))
          OR (sources.provider LIKE 'official-%'
            AND json_extract(sources.payload_json, '$.profileImageCandidateUrl') != '')
          OR (sources.provider = 'public-r18dev-actor'
            AND json_extract(sources.payload_json, '$.profileImageCandidateUrl') != ''))
      ) AS hasLicensedImage,
      profiles.wikipedia_url AS wikipediaUrl,
      profiles.official_website AS officialWebsite,
      COALESCE(media_counts.mediaCount, 0) AS mediaCount
    FROM entity_profiles profiles
    LEFT JOIN media_counts ON media_counts.profileValue = profiles.facet_value
    LEFT JOIN preferred_actor_localizations
      ON preferred_actor_localizations.profileValue = profiles.facet_value
    WHERE profiles.facet_type = 'actor' AND profiles.source_status NOT IN ('unverified', 'not-found', 'failed')
  `).all({ researchImagePolicy: config.externalAi.entityProfileImagePolicy === "research" ? 1 : 0 }) as Array<{
    value: string;
    label: string;
    namesJson: string;
    localizedLabel: string | null;
    birthDate: string | null;
    heightCm: number | null;
    measurementsJson: string;
    biography: string;
    hasLicensedImage: number;
    wikipediaUrl: string;
    officialWebsite: string;
    mediaCount: number;
  }>;
  const year = (value: string | null) => Number(value?.slice(0, 4)) || 0;
  const prepared = rows.flatMap((row): ActorProfileRankingRow[] => {
    const label = chooseLocalizedEntityDisplayName({
      type: "actor",
      storedDisplayName: row.label,
      names: parseJson<Record<string, string>>(row.namesJson, {}),
      localizedCandidates: row.localizedLabel ? [row.localizedLabel] : []
    });
    const measurements = parseJson<EntityExtendedProfile["measurements"]>(row.measurementsJson, {});
    const completeMeasurements = measurements.bustCm != null && measurements.waistCm != null && measurements.hipsCm != null;
    if (input.minHeightCm != null && (row.heightCm == null || row.heightCm < input.minHeightCm)) return [];
    if (input.maxHeightCm != null && (row.heightCm == null || row.heightCm > input.maxHeightCm)) return [];
    const birthYear = year(row.birthDate);
    if (input.birthYearFrom != null && (!birthYear || birthYear < input.birthYearFrom)) return [];
    if (input.birthYearTo != null && (!birthYear || birthYear > input.birthYearTo)) return [];
    if (input.minBustCm != null && (measurements.bustCm == null || measurements.bustCm < input.minBustCm)) return [];
    if (input.maxBustCm != null && (measurements.bustCm == null || measurements.bustCm > input.maxBustCm)) return [];
    const rankedCup = actorCupRank(measurements.cup);
    if (input.minCupRank != null && (!rankedCup || rankedCup < input.minCupRank)) return [];
    if (input.maxCupRank != null && (!rankedCup || rankedCup > input.maxCupRank)) return [];
    const completeness = [row.birthDate, row.heightCm, measurements.bustCm, measurements.waistCm,
      measurements.hipsCm, measurements.cup, row.biography, row.hasLicensedImage ? "licensed-image" : "", row.wikipediaUrl]
      .filter((value) => value != null && value !== "").length;
    const missing: Array<{ field: ActorProfileMissingField; label: string }> = [
      ...(!row.birthDate ? [{ field: "birth_date" as const, label: "生日" }] : []),
      ...(row.heightCm == null ? [{ field: "height" as const, label: "身高" }] : []),
      ...(!completeMeasurements ? [{ field: "measurements" as const, label: "完整三围" }] : []),
      ...(!measurements.cup ? [{ field: "cup" as const, label: "罩杯" }] : []),
      ...(!row.biography ? [{ field: "biography" as const, label: "简介" }] : []),
      ...(!row.hasLicensedImage ? [{ field: "image" as const, label: "图片" }] : []),
      ...(!row.wikipediaUrl ? [{ field: "wikipedia" as const, label: "Wikipedia" }] : []),
      ...(!row.officialWebsite ? [{ field: "official_website" as const, label: "官网" }] : [])
    ];
    if (input.metric === "missing_fields") {
      if (!missing.length) return [];
      if (input.missingFields?.length && !input.missingFields.some((field) => missing.some((item) => item.field === field))) return [];
      return [{ value: row.value, label, mediaCount: row.mediaCount,
        metricValue: input.missingFields?.length ? row.mediaCount : missing.length,
        detail: `缺少 ${missing.map((item) => item.label).join("、")}` }];
    }
    if (input.metric === "height" && row.heightCm != null) return [{
      value: row.value, label, mediaCount: row.mediaCount,
      metricValue: row.heightCm, detail: `${row.heightCm} cm`
    }];
    if (input.metric === "birth_date" && birthYear) return [{
      value: row.value, label, mediaCount: row.mediaCount,
      metricValue: dateRank(row.birthDate), detail: row.birthDate ?? String(birthYear)
    }];
    if (input.metric === "bust" && measurements.bustCm != null) return [{
      value: row.value, label, mediaCount: row.mediaCount,
      metricValue: measurements.bustCm, detail: `${measurements.bustCm} cm`
    }];
    if (input.metric === "cup" && rankedCup) return [{
      value: row.value, label, mediaCount: row.mediaCount,
      metricValue: rankedCup, detail: `${measurements.cup} 杯`
    }];
    if (input.metric === "measurements" && completeMeasurements) return [{
      value: row.value, label, mediaCount: row.mediaCount,
      metricValue: row.mediaCount,
      detail: `${measurements.bustCm} / ${measurements.waistCm} / ${measurements.hipsCm} cm${measurements.cup ? ` · ${measurements.cup} 杯` : ""}`
    }];
    if (input.metric === "biography" && row.biography) return [{
      value: row.value, label, mediaCount: row.mediaCount,
      metricValue: row.mediaCount, detail: "有公开简介"
    }];
    if (input.metric === "image" && row.hasLicensedImage) return [{
      value: row.value, label, mediaCount: row.mediaCount,
      metricValue: row.mediaCount, detail: "有可展示头像"
    }];
    if (input.metric === "wikipedia" && row.wikipediaUrl) return [{
      value: row.value, label, mediaCount: row.mediaCount,
      metricValue: row.mediaCount, detail: "有 Wikipedia 档案"
    }];
    if (input.metric === "official_website" && row.officialWebsite) return [{
      value: row.value, label, mediaCount: row.mediaCount,
      metricValue: row.mediaCount, detail: "有官方网站"
    }];
    if (input.metric === "completeness") return [{
      value: row.value, label, mediaCount: row.mediaCount,
      metricValue: completeness, detail: `${completeness} / 9 项`
    }];
    return [];
  });
  const direction = input.order === "asc" ? 1 : -1;
  prepared.sort((left, right) => direction * (left.metricValue - right.metricValue) || right.mediaCount - left.mediaCount ||
    left.label.localeCompare(right.label, "ja"));
  return {
    profileTotal: rows.length,
    eligibleTotal: prepared.length,
    rows: prepared.slice(0, Math.min(Math.max(1, resultLimitCap), Math.max(1, input.limit ?? 10)))
  };
}

function structuredInceptionDate(facts: Record<string, string | string[]>): string {
  for (const key of ["inceptionDate", "foundedYear", "makerFoundedYear"]) {
    const raw = facts[key];
    const value = Array.isArray(raw) ? raw[0] ?? "" : raw ?? "";
    const match = String(value).match(/(19\d{2}|20\d{2})(?:-(\d{2})(?:-(\d{2}))?)?/u);
    if (!match) continue;
    return [match[1], match[2], match[3]].filter(Boolean).join("-");
  }
  return "";
}

function firstStructuredFact(facts: Record<string, string | string[]>, keys: string[]): string {
  for (const key of keys) {
    const raw = facts[key];
    const value = Array.isArray(raw) ? raw.find(Boolean) ?? "" : raw ?? "";
    if (String(value).trim()) return String(value).trim();
  }
  return "";
}

function normalizedPublicFact(value: string): string {
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase("ja")
    .replace(/[\s\u3000.,，。・·()（）「」『』【】\-_]+/gu, "");
  if (["日本", "日本国", "japan"].includes(normalized)) return "日本";
  if (["东京", "東京", "东京都", "東京都", "tokyo", "tokyometropolis"].includes(normalized)) return "东京";
  return normalized;
}

function publicFactMatches(value: string, filterValue?: string): boolean {
  if (!filterValue?.trim()) return true;
  const fact = normalizedPublicFact(value);
  const filter = normalizedPublicFact(filterValue);
  return Boolean(fact && filter && (fact === filter || fact.includes(filter) || filter.includes(fact)));
}

export function rankPublicEntityProfiles(input: PublicProfileRankingInput): {
  profileTotal: number;
  eligibleTotal: number;
  rows: PublicProfileRankingRow[];
} {
  const localizationColumns = ENTITY_NAME_LOCALIZATION_COLUMNS[input.type]!;
  const rows = db.prepare(`
    WITH profile_aliases AS (
      SELECT facet_value AS profileValue, facet_value AS alias
      FROM entity_profiles WHERE facet_type = @type AND source_status != 'unverified'
      UNION
      SELECT profiles.facet_value AS profileValue, TRIM(CAST(alias.value AS TEXT)) AS alias
      FROM entity_profiles profiles, json_each(profiles.aliases_json) alias
      WHERE profiles.facet_type = @type AND profiles.source_status != 'unverified'
        AND TRIM(CAST(alias.value AS TEXT)) != ''
    ), media_counts AS (
      SELECT profile_aliases.profileValue, COUNT(DISTINCT facets.normalized_code) AS mediaCount
      FROM profile_aliases
      LEFT JOIN media_metadata_facets facets
        ON facets.facet_type = @type AND facets.facet_value = profile_aliases.alias
      GROUP BY profile_aliases.profileValue
    ), entity_localizations AS (
      SELECT profile_aliases.profileValue,
        TRIM(metadata.${localizationColumns.localized}) AS localizedLabel,
        MAX(CASE WHEN profile_aliases.alias = profile_aliases.profileValue THEN 1 ELSE 0 END) AS canonicalMatch,
        COUNT(*) AS frequency
      FROM profile_aliases
      JOIN media_metadata metadata
        ON TRIM(metadata.${localizationColumns.source}) = profile_aliases.alias
      WHERE TRIM(metadata.${localizationColumns.localized}) != ''
        AND metadata.status = 'ready' AND metadata.translation_status = 'ready'
      GROUP BY profile_aliases.profileValue, TRIM(metadata.${localizationColumns.localized})
    ), preferred_entity_localizations AS (
      SELECT profileValue, localizedLabel
      FROM (
        SELECT profileValue, localizedLabel,
          ROW_NUMBER() OVER (
            PARTITION BY profileValue
            ORDER BY (localizedLabel GLOB '*[一-龯]*'
              AND localizedLabel NOT GLOB '*[ぁ-ゖァ-ヺ]*') DESC,
              canonicalMatch DESC,
              frequency DESC, localizedLabel COLLATE NOCASE ASC
          ) AS localizationRank
        FROM entity_localizations
      )
      WHERE localizationRank = 1
    )
    SELECT profiles.facet_value AS value, profiles.display_name AS label,
      profiles.names_json AS namesJson,
      preferred_entity_localizations.localizedLabel,
      profiles.aliases_json AS aliasesJson, profiles.biography,
      profiles.facts_json AS factsJson, profiles.official_website AS officialWebsite,
      profiles.wikipedia_url AS wikipediaUrl,
      (SELECT COUNT(*) FROM entity_profile_sources sources
        WHERE sources.facet_type = profiles.facet_type AND sources.facet_value = profiles.facet_value) AS sourceCount,
      EXISTS (SELECT 1 FROM entity_profile_sources sources
        WHERE sources.facet_type = profiles.facet_type AND sources.facet_value = profiles.facet_value
          AND (json_extract(sources.payload_json, '$.imageUrl') != ''
            OR json_extract(sources.payload_json, '$.profileImageCandidateUrl') != '')) AS hasImage,
      COALESCE(media_counts.mediaCount, 0) AS mediaCount
    FROM entity_profiles profiles
    LEFT JOIN media_counts ON media_counts.profileValue = profiles.facet_value
    LEFT JOIN preferred_entity_localizations
      ON preferred_entity_localizations.profileValue = profiles.facet_value
    WHERE profiles.facet_type = @type AND profiles.source_status != 'unverified'
  `).all({ type: input.type }) as Array<{
    value: string; label: string; namesJson: string; localizedLabel: string | null;
    aliasesJson: string; biography: string; factsJson: string;
    officialWebsite: string; wikipediaUrl: string; sourceCount: number; hasImage: number; mediaCount: number;
  }>;
  const prepared = rows.flatMap((row): PublicProfileRankingRow[] => {
    const label = chooseLocalizedEntityDisplayName({
      type: input.type,
      storedDisplayName: row.label,
      names: parseJson<Record<string, string>>(row.namesJson, {}),
      localizedCandidates: row.localizedLabel ? [row.localizedLabel] : []
    });
    const facts = parseJson<Record<string, string | string[]>>(row.factsJson, {});
    const inception = structuredInceptionDate(facts);
    const aliases = parseJson<string[]>(row.aliasesJson, []);
    const factsCount = Object.entries(facts).filter(([key, value]) =>
      !["entityKind", "entityName", "officialTitle", "profileImageCandidateUrl"].includes(key)
      && (Array.isArray(value) ? value.length > 0 : Boolean(value))
    ).length;
    const completeness = [row.biography, row.officialWebsite, row.wikipediaUrl, row.hasImage ? "image" : "",
      aliases.length > 1 ? "aliases" : "", row.sourceCount ? "sources" : "", factsCount ? "facts" : ""]
      .filter(Boolean).length;
    if (input.metric === "inception") {
      if (!inception) return [];
      return [{ value: row.value, label, mediaCount: row.mediaCount,
        metricValue: Number(inception.replace(/-/gu, "").padEnd(8, "0")), detail: `成立 ${inception}` }];
    }
    if (input.metric === "official_website") {
      if (!row.officialWebsite) return [];
      let host = row.officialWebsite;
      try { host = new URL(row.officialWebsite).hostname; } catch { /* keep the stored value */ }
      return [{ value: row.value, label, mediaCount: row.mediaCount,
        metricValue: row.mediaCount, detail: `官网 ${host}` }];
    }
    if (input.metric === "wikipedia") {
      if (!row.wikipediaUrl) return [];
      return [{ value: row.value, label, mediaCount: row.mediaCount,
        metricValue: row.mediaCount, detail: "有 Wikipedia 档案" }];
    }
    if (input.metric === "image") {
      if (!row.hasImage) return [];
      return [{ value: row.value, label, mediaCount: row.mediaCount,
        metricValue: row.mediaCount, detail: "有可展示图片" }];
    }
    const factMetric = input.metric === "country"
      ? { value: firstStructuredFact(facts, ["country"]), label: "国家" }
      : input.metric === "headquarters"
        ? { value: firstStructuredFact(facts, ["headquarters"]), label: "总部" }
        : input.metric === "parent_organization"
          ? { value: firstStructuredFact(facts, ["parentOrganization"]), label: "母公司" }
          : input.metric === "related_maker"
            ? { value: firstStructuredFact(facts, ["relatedMaker"]), label: "所属厂商" }
            : null;
    if (factMetric) {
      if (!factMetric.value || !publicFactMatches(factMetric.value, input.filterValue)) return [];
      return [{ value: row.value, label, mediaCount: row.mediaCount,
        metricValue: row.mediaCount, detail: `${factMetric.label} ${factMetric.value}` }];
    }
    return [{ value: row.value, label, mediaCount: row.mediaCount,
      metricValue: input.metric === "completeness" ? completeness : row.mediaCount,
      detail: input.metric === "completeness" ? `${completeness} / 7 项 · ${row.sourceCount} 个来源`
        : `${row.sourceCount} 个公开来源${row.officialWebsite ? " · 有官网" : ""}` }];
  });
  const direction = input.order === "asc" ? 1 : -1;
  prepared.sort((left, right) => direction * (left.metricValue - right.metricValue)
    || right.mediaCount - left.mediaCount || left.label.localeCompare(right.label, "ja"));
  return {
    profileTotal: rows.length,
    eligibleTotal: prepared.length,
    rows: prepared.slice(0, Math.min(20, Math.max(1, input.limit ?? 10)))
  };
}

export function formatEntityProfileForAgent(profile: EntityExtendedProfile | null): string {
  if (!profile) return "";
  const measurements = profile.measurements;
  const dimensions = [measurements.bustCm, measurements.waistCm, measurements.hipsCm].every((value) => value != null)
    ? `${measurements.bustCm}/${measurements.waistCm}/${measurements.hipsCm} cm` : "";
  const factLabels: Record<string, string> = {
    inceptionDate: "成立时间", headquarters: "总部", country: "所属国家", industry: "行业",
    foundedYear: "成立年份", parentOrganization: "母公司", parentGroup: "所属集团",
    relatedMaker: "所属厂商", founder: "创办者", legalForm: "组织形式", entityTypes: "实体类型",
    brandName: "品牌名", canonicalBrandName: "品牌标准名", brandPositioning: "品牌定位",
    businessActivities: "业务范围", formerName: "曾用名", independentSince: "独立运营时间",
    knownCatalogPrefix: "常见番号前缀", agency: "所属事务所", romanizedName: "罗马字",
    reading: "读音", nameReading: "姓名读音", birthYear: "出生年份", industrySince: "入行时间",
    organization: "所属机构", currentAffiliation: "当前所属", selfDescribedRole: "本人自述身份",
    matchedLibraryWorkCount: "馆藏身份验证作品数", identityCodes: "身份桥番号"
  };
  const formatFactValue = (value: string | string[]): string => {
    if (!Array.isArray(value)) return String(value);
    const visible = value.slice(0, 8).map(String).filter(Boolean);
    return `${visible.join("、")}${value.length > visible.length ? ` 等 ${value.length} 项` : ""}`;
  };
  const genericFacts = Object.entries(profile.facts).flatMap(([key, value]) => {
    const label = factLabels[key];
    if (!label || (Array.isArray(value) ? !value.length : !value)) return [];
    return [`${label}: ${formatFactValue(value)}`];
  });
  const normalizedDisplayName = profile.displayName.normalize("NFKC").trim().toLocaleLowerCase("ja");
  const seenAliases = new Set<string>();
  const aliases = [...profile.aliases, ...Object.values(profile.names)].filter((value) => {
    const key = value.normalize("NFKC").trim().toLocaleLowerCase("ja");
    if (!key || key === normalizedDisplayName || seenAliases.has(key)) return false;
    seenAliases.add(key);
    return true;
  }).slice(0, 12);
  const safeUrl = (value: string): string => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
    } catch {
      return "";
    }
  };
  const officialWebsite = safeUrl(profile.officialWebsite);
  const sourceLinks = profile.sources
    .filter((source, index, sources) => sources.findIndex((candidate) => candidate.url === source.url) === index)
    .slice(0, 8).map((source) => {
    const url = safeUrl(source.url);
    const title = source.title.trim() || source.provider;
    return url ? `${title}（${url}）` : title;
  }).filter(Boolean);
  return [
    `名称: ${profile.displayName}`,
    profile.originalName && profile.originalName !== profile.displayName ? `日文原名: ${profile.originalName}` : "",
    aliases.length ? `别名: ${aliases.join("、")}` : "",
    profile.birthDate ? `出生日期: ${profile.birthDate}` : "",
    profile.birthplace ? `出生地: ${profile.birthplace}` : "",
    profile.nationality ? `国籍: ${profile.nationality}` : "",
    profile.heightCm ? `身高: ${profile.heightCm} cm` : "",
    dimensions ? `三围: ${dimensions}` : "",
    measurements.cup ? `罩杯: ${measurements.cup}` : "",
    profile.occupations.length ? `职业: ${profile.occupations.join("、")}` : "",
    ...genericFacts,
    profile.biography ? `简介: ${profile.biography.slice(0, 800)}` : "",
    officialWebsite ? `官方网站: ${officialWebsite}` : "",
    sourceLinks.length ? `公开资料来源: ${sourceLinks.join("；")}` : "",
    `资料状态: ${formatEntityProfileStatus(profile.status)}；置信度: ${Math.round(profile.confidence * 100)}%`
  ].filter(Boolean).join("\n");
}

export function formatEntityProfileStatus(status: EntityExtendedProfile["status"]): string {
  if (status === "auto-resolved") return "来源存在差异，系统已自动择优";
  if (status === "auto-matched") return "公开实体自动精确匹配";
  if (status === "verified") return "高置信来源一致";
  return "资料尚未形成可靠匹配";
}
