import crypto from "node:crypto";
import type { Express } from "express";
import { z } from "zod";
import { entitySoloFilter } from "./queries/entitySoloFilter.js";
import { db, refreshMediaSearchIndexForCode, replaceMetadataFacetsForCode, type MediaRow } from "./db.js";
import { readFavoriteKeys } from "./favorites.js";
import { readEntityFavorites, readEntityFavoriteValues } from "./entityFavorites.js";
import { getCanonicalActorName, getLocalizedActorDisplayName, isActorNameCandidate } from "./actorAliases.js";
import {
  requestPosterVariant,
  type PosterVariant
} from "./mediaDerivatives.js";
import { readTopicStats, writeTopicStats } from "./topicStats.js";
import { getReadyTranslationSidecar, getSubtitleTranslation } from "./subtitleTranslation.js";
import {
  chooseLocalizedEntityDisplayName,
  getEntityExtendedProfile,
  getEntityProfileCoverage
} from "./entityProfiles.js";
import { resolveEntityProfileImageUrl } from "./entityProfileImageCache.js";
import { getEntityInsights, resolveEntityInsightAliases } from "./entityInsights.js";
import {
  ensureMetadataQualityIssues,
  getMetadataQualityForCode,
  getMetadataQualityIssueCounts,
  refreshMetadataQualityIssues
} from "./metadataQuality.js";
export { subtitleToVtt } from "./services/subtitleService.js";

const HIDDEN_METADATA_GENRES = new Set(["样片", "樣片", "サンプル動画", "sample video"]);

const savedFilterSchema = z.object({
  name: z.string().trim().min(1).max(80),
  query: z.record(z.string(), z.unknown())
});

const metadataOverrideSchema = z.object({
  titleZh: z.string().trim().max(1000).optional(),
  summaryZh: z.string().trim().max(10_000).optional(),
  directorZh: z.string().trim().max(200).optional(),
  actorsZh: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  genresZh: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  makerZh: z.string().trim().max(300).optional(),
  labelZh: z.string().trim().max(300).optional(),
  seriesZh: z.string().trim().max(500).optional()
});

const topicCoverSchema = z.object({
  mediaId: z.string().trim().min(1)
});

const pagedSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(12).max(100).default(48)
});

const qualityQuerySchema = pagedSchema.extend({
  issue: z
    .enum([
      "all", "unmatched", "missing-cover", "translation", "duplicate", "missing-probe", "compatibility",
      "missing-title-zh", "missing-actor-zh", "missing-genre-zh", "duration-conflict",
      "future-release-date", "low-completeness"
    ])
    .default("all")
});

const TOPIC_TYPES = ["actor", "series", "genre", "prefix", "director", "maker", "label"] as const;
const topicTypeSchema = z.enum(TOPIC_TYPES);
export type TopicType = z.infer<typeof topicTypeSchema>;

const TOPIC_TYPE_LABELS: Record<TopicType, string> = {
  actor: "演员",
  series: "主题",
  genre: "标签",
  prefix: "番号",
  director: "导演",
  maker: "厂商",
  label: "厂牌"
};

const topicQuerySchema = pagedSchema.extend({
  q: z.string().trim().max(200).default(""),
  sort: z.enum(["count", "count-asc", "name", "latest", "random"]).default("count"),
  randomSeed: z.coerce.number().int().default(0)
});

function seededTopicRank(value: string, seed: number): number {
  let hash = seed | 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619);
  }
  return hash >>> 0;
}

const entityQuerySchema = pagedSchema.extend({
  soloOnly: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  pageSize: z.coerce.number().int().min(12).max(60).default(36),
  sort: z.enum(["release", "added", "name", "duration", "size", "random"]).default("release"),
  randomSeed: z.coerce.number().int().default(0)
});

const TOPIC_CACHE_TTL_MS = 10 * 60 * 1000;

type TopicListItem = {
  value: string;
  label: string;
  aliases: string[];
  mediaCount: number;
  latestReleaseDate: string | null;
  mediaId: string | null;
  customCoverMediaId?: string | null;
};

type TopicCacheEntry = {
  expiresAt: number;
  items: TopicListItem[];
  identityRevision: string;
};

const topicListCache = new Map<TopicType, TopicCacheEntry>();
const entityResponseCache = new Map<string, { expiresAt: number; value: unknown }>();
let canonicalTopicAliasCache: { expiresAt: number; value: Map<string, TopicListItem> } | null = null;
const ENTITY_RESPONSE_CACHE_TTL_MS = 60_000;
const MAX_ENTITY_RESPONSE_CACHE_ENTRIES = 128;
let topicLocalizationCache: {
  expiresAt: number;
  revision: string;
  values: Record<TopicType, Map<string, string>>;
} | null = null;

export function clearProductRouteCaches(): void {
  entityResponseCache.clear();
}

export function warmProductRouteCaches(): void {
  for (const type of TOPIC_TYPES) {
    try {
      loadTopicItems(type);
    } catch (error) {
      console.error(`Topic cache warmup failed (${type}):`, error);
    }
  }
  try {
    getCanonicalTopicAliasMap();
  } catch (error) {
    console.error("Canonical topic alias warmup failed:", error);
  }
}

function readEntityResponseCache(key: string): unknown | null {
  const cached = entityResponseCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    entityResponseCache.delete(key);
    return null;
  }
  entityResponseCache.delete(key);
  entityResponseCache.set(key, cached);
  return cached.value;
}

function writeEntityResponseCache(key: string, value: unknown): void {
  entityResponseCache.set(key, { expiresAt: Date.now() + ENTITY_RESPONSE_CACHE_TTL_MS, value });
  while (entityResponseCache.size > MAX_ENTITY_RESPONSE_CACHE_ENTRIES) {
    const oldestKey = entityResponseCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    entityResponseCache.delete(oldestKey);
  }
}

type DetailedRow = MediaRow & {
  metadata_status: string | null;
  metadata_title: string | null;
  metadata_summary: string | null;
  metadata_director: string | null;
  metadata_actors_json: string | null;
  metadata_genres_json: string | null;
  metadata_maker: string | null;
  metadata_label: string | null;
  metadata_series: string | null;
  metadata_title_zh: string | null;
  metadata_summary_zh: string | null;
  metadata_director_zh: string | null;
  metadata_actors_zh_json: string | null;
  metadata_genres_zh_json: string | null;
  metadata_maker_zh: string | null;
  metadata_label_zh: string | null;
  metadata_series_zh: string | null;
  metadata_release_date: string | null;
  metadata_runtime_minutes: number | null;
  metadata_score: number | null;
  metadata_cover_url: string | null;
  metadata_thumb_url: string | null;
  metadata_homepage: string | null;
  metadata_provider: string | null;
  metadata_source: string | null;
  metadata_translation_status: string | null;
  metadata_translated_at: string | null;
  metadata_fetched_at: string | null;
  metadata_updated_at: string | null;
  override_json: string | null;
  playback_position_seconds: number | null;
  playback_duration_seconds: number | null;
  playback_completed: number | null;
  playback_play_count: number | null;
  playback_last_played_at: string | null;
};

const detailedMediaSql = `
  SELECT
    media_files.*,
    media_metadata.status AS metadata_status,
    media_metadata.title AS metadata_title,
    media_metadata.summary AS metadata_summary,
    media_metadata.director AS metadata_director,
    media_metadata.actors_json AS metadata_actors_json,
    media_metadata.genres_json AS metadata_genres_json,
    media_metadata.maker AS metadata_maker,
    media_metadata.label AS metadata_label,
    media_metadata.series AS metadata_series,
    media_metadata.title_zh AS metadata_title_zh,
    media_metadata.summary_zh AS metadata_summary_zh,
    media_metadata.director_zh AS metadata_director_zh,
    media_metadata.actors_zh_json AS metadata_actors_zh_json,
    media_metadata.genres_zh_json AS metadata_genres_zh_json,
    media_metadata.maker_zh AS metadata_maker_zh,
    media_metadata.label_zh AS metadata_label_zh,
    media_metadata.series_zh AS metadata_series_zh,
    media_metadata.release_date AS metadata_release_date,
    media_metadata.runtime_minutes AS metadata_runtime_minutes,
    media_metadata.score AS metadata_score,
    media_metadata.cover_url AS metadata_cover_url,
    media_metadata.thumb_url AS metadata_thumb_url,
    media_metadata.homepage AS metadata_homepage,
    media_metadata.provider AS metadata_provider,
    media_metadata.source AS metadata_source,
    media_metadata.translation_status AS metadata_translation_status,
    media_metadata.translated_at AS metadata_translated_at,
    media_metadata.fetched_at AS metadata_fetched_at,
    media_metadata.updated_at AS metadata_updated_at,
    metadata_overrides.patch_json AS override_json,
    playback_progress.position_seconds AS playback_position_seconds,
    playback_progress.duration_seconds AS playback_duration_seconds,
    playback_progress.completed AS playback_completed,
    playback_progress.play_count AS playback_play_count,
    playback_progress.last_played_at AS playback_last_played_at
  FROM media_files
  LEFT JOIN media_metadata ON media_metadata.normalized_code = media_files.normalized_code
  LEFT JOIN metadata_overrides ON metadata_overrides.normalized_code = media_files.normalized_code
  LEFT JOIN playback_progress ON playback_progress.relative_path = media_files.relative_path
`;

function parseArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function createTopicLocalizationMaps(): Record<TopicType, Map<string, string>> {
  return {
    actor: new Map(),
    series: new Map(),
    genre: new Map(),
    prefix: new Map(),
    director: new Map(),
    maker: new Map(),
    label: new Map()
  };
}

function topicLocalizationRevision(): string {
  return String((db.prepare(`
    SELECT COALESCE((
      SELECT source_signature FROM app_cache_state WHERE cache_key = 'topic-localizations'
    ), '') AS revision
  `).get() as { revision: string }).revision);
}

function getTopicLocalizations(): Record<TopicType, Map<string, string>> {
  const revision = topicLocalizationRevision();
  if (topicLocalizationCache && topicLocalizationCache.expiresAt > Date.now()
    && topicLocalizationCache.revision === revision) {
    return topicLocalizationCache.values;
  }

  const values = createTopicLocalizationMaps();
  const rows = db
    .prepare(
      `
      SELECT actors_json AS actorsJson, genres_json AS genresJson, director, maker, label, series,
        actors_zh_json AS actorsZhJson, genres_zh_json AS genresZhJson,
        director_zh AS directorZh, maker_zh AS makerZh, label_zh AS labelZh, series_zh AS seriesZh
      FROM media_metadata
      WHERE status = 'ready' AND translation_status = 'ready'
    `
    )
    .all() as Array<{
      actorsJson: string | null;
      genresJson: string | null;
      director: string;
      maker: string;
      label: string;
      series: string;
      actorsZhJson: string | null;
      genresZhJson: string | null;
      directorZh: string;
      makerZh: string;
      labelZh: string;
      seriesZh: string;
    }>;

  const addValue = (type: TopicType, value: string | undefined, label: string | undefined) => {
    const source = value?.trim().replace(/\s+/g, " ") ?? "";
    const translated = label?.trim().replace(/\s+/g, " ") ?? "";
    if (type === "actor" && !isActorNameCandidate(source)) return;
    const localized = type === "actor" ? getLocalizedActorDisplayName(source, translated) : translated;
    if (!source || !localized || values[type].has(source)) return;
    if (["director", "maker", "label", "series"].includes(type) && /[ぁ-ゖァ-ヺ]/u.test(source)
      && (!/[\u3400-\u9fff]/u.test(localized) || /[ぁ-ゖァ-ヺ]/u.test(localized))) return;
    if (type === "genre") {
      const sourceKey = source.toLocaleLowerCase();
      const localizedKey = localized.toLocaleLowerCase();
      if (HIDDEN_METADATA_GENRES.has(sourceKey) || HIDDEN_METADATA_GENRES.has(localizedKey)) return;
    }
    values[type].set(source, localized);
  };

  for (const row of rows) {
    const actors = parseArray(row.actorsJson);
    const actorsZh = parseArray(row.actorsZhJson);
    const genres = parseArray(row.genresJson);
    const genresZh = parseArray(row.genresZhJson);
    actors.forEach((actor, index) => addValue("actor", actor, actorsZh[index]));
    genres.forEach((genre, index) => addValue("genre", genre, genresZh[index]));
    addValue("director", row.director, row.directorZh);
    addValue("maker", row.maker, row.makerZh);
    addValue("label", row.label, row.labelZh);
    addValue("series", row.series, row.seriesZh);
  }

  topicLocalizationCache = { expiresAt: Date.now() + TOPIC_CACHE_TTL_MS, revision, values };
  return values;
}

export function clearTopicCaches(): void {
  topicListCache.clear();
  topicLocalizationCache = null;
  canonicalTopicAliasCache = null;
}

function normalizeTopicNeedle(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\-_・·]+/g, "");
}

function preferredActorSourceName(values: string[]): string {
  const priority = (value: string) => /[\u3040-\u30ff]/u.test(value) ? 3
    : /[\u3400-\u9fff]/u.test(value) ? 2 : 1;
  return [...values].sort((left, right) =>
    priority(right) - priority(left) || left.localeCompare(right, "ja")
  )[0] ?? "";
}

function shouldMergeLocalizedTopics(type: TopicType): boolean {
  return type !== "prefix";
}

function isTopicEntityVisible(type: TopicType, value: string, label: string): boolean {
  if (type === "actor") return isActorNameCandidate(value) && isActorNameCandidate(label);
  if (type !== "genre") return true;
  return !HIDDEN_METADATA_GENRES.has(value.trim().toLocaleLowerCase()) &&
    !HIDDEN_METADATA_GENRES.has(label.trim().toLocaleLowerCase());
}

type TopicProfileIdentities = {
  identities: Map<string, string>;
  canonicalValues: Map<string, string>;
};

function topicProfileIdentityMap(type: TopicType): TopicProfileIdentities | undefined {
  if (!["actor", "director", "maker", "label", "series"].includes(type)) return undefined;
  const rows = db.prepare(`
    SELECT facet_value AS value, display_name AS displayName, aliases_json AS aliasesJson,
      names_json AS namesJson, wikidata_id AS wikidataId
    FROM entity_profiles
    WHERE facet_type = @type AND source_status != 'unverified'
      AND (@type = 'actor' OR confidence >= 0.82)
  `).all({ type }) as Array<{
    value: string;
    displayName: string;
    aliasesJson: string;
    namesJson: string;
    wikidataId: string;
  }>;
  const candidatesByAlias = new Map<string, Set<string>>();
  const identitiesByFacetValue = new Map<string, Set<string>>();
  const canonicalValues = new Map<string, string>();
  for (const row of rows) {
    const identity = row.wikidataId
      ? `wikidata:${row.wikidataId}`
      : `profile:${type}:${normalizeTopicNeedle(row.value)}`;
    canonicalValues.set(identity, row.value);
    const facetValueKey = normalizeTopicNeedle(row.value);
    const exactIdentities = identitiesByFacetValue.get(facetValueKey) ?? new Set<string>();
    exactIdentities.add(identity);
    identitiesByFacetValue.set(facetValueKey, exactIdentities);
    const names = Object.values(parseObject(row.namesJson)).filter((value): value is string => typeof value === "string");
    for (const alias of [row.value, row.displayName, ...parseArray(row.aliasesJson), ...names]) {
      if (type === "actor" && !isActorNameCandidate(alias)) continue;
      const key = normalizeTopicNeedle(alias);
      if (!key) continue;
      const candidates = candidatesByAlias.get(key) ?? new Set<string>();
      candidates.add(identity);
      candidatesByAlias.set(key, candidates);
    }
  }
  const identities = new Map<string, string>();
  for (const [alias, candidates] of candidatesByAlias) {
    // The same spelling may belong to multiple people or organizations. Only a
    // unique persisted identity is strong enough to merge separate topic cards.
    if (candidates.size === 1) identities.set(alias, [...candidates][0]!);
  }
  // A stored facet value is stronger evidence than an alias imported from a
  // public directory. This prevents a broad or stale public alias (for example
  // a reused romanized stage name) from stealing another profile's own key.
  for (const [value, candidates] of identitiesByFacetValue) {
    if (candidates.size === 1) identities.set(value, [...candidates][0]!);
  }
  return { identities, canonicalValues };
}

function applyTrustedProfileDisplayNames(type: TopicType, items: TopicListItem[]): TopicListItem[] {
  if (!["actor", "director", "maker", "label", "series"].includes(type)) return items;
  const rows = db.prepare(`
    SELECT facet_value AS value, display_name AS displayName,
      aliases_json AS aliasesJson, names_json AS namesJson
    FROM entity_profiles
    WHERE facet_type = @type AND source_status != 'unverified' AND confidence >= 0.82
  `).all({ type }) as Array<{
    value: string;
    displayName: string;
    aliasesJson: string;
    namesJson: string;
  }>;
  const candidatesByAlias = new Map<string, Set<string>>();
  const localizations = getTopicLocalizations()[type];
  for (const row of rows) {
    const names = Object.values(parseObject(row.namesJson)).filter((value): value is string => typeof value === "string");
    const aliases = parseArray(row.aliasesJson);
    const identityNames = [row.value, row.displayName, ...aliases, ...names];
    const trustedDisplayName = chooseLocalizedEntityDisplayName({
      type,
      storedDisplayName: row.displayName.trim() || row.value,
      names: parseObject(row.namesJson) as Record<string, string>,
      localizedCandidates: type === "actor"
        ? [
            ...identityNames.map((name) => localizations.get(name) ?? "").filter(Boolean),
            ...identityNames
          ]
        : identityNames.map((name) => localizations.get(name) ?? "").filter(Boolean)
    });
    for (const alias of identityNames) {
      const key = normalizeTopicNeedle(alias);
      if (!key) continue;
      const candidates = candidatesByAlias.get(key) ?? new Set<string>();
      candidates.add(trustedDisplayName);
      candidatesByAlias.set(key, candidates);
    }
  }
  const uniqueNameByAlias = new Map<string, string>();
  for (const [alias, candidates] of candidatesByAlias) {
    if (candidates.size === 1) uniqueNameByAlias.set(alias, [...candidates][0]!);
  }
  return items.map((item) => {
    const trustedName = [item.value, ...item.aliases]
      .map((alias) => uniqueNameByAlias.get(normalizeTopicNeedle(alias)))
      .find((value): value is string => Boolean(value));
    return trustedName && trustedName !== item.label ? { ...item, label: trustedName } : item;
  });
}

function topicGroupKey(
  type: TopicType,
  value: string,
  label: string,
  profileIdentities?: Map<string, string>
): string {
  if (type === "actor") {
    // Only the original metadata value may resolve through a persisted identity alias.
    // A localized display label can be shared by unrelated people and is never evidence.
    const verifiedIdentity = profileIdentities?.get(normalizeTopicNeedle(value));
    if (verifiedIdentity) return verifiedIdentity;
    // A curated source-name alias remains the fallback when no persisted stable
    // identity exists. Once an enrichment has assigned one stable person ID, it
    // must win so an old registry spelling and a newly discovered alias cannot
    // produce two rows with the same canonical facet value.
    const configuredIdentity = getCanonicalActorName(value);
    if (configuredIdentity) {
      const persistedRegisteredIdentity = profileIdentities?.get(normalizeTopicNeedle(configuredIdentity));
      if (persistedRegisteredIdentity) return persistedRegisteredIdentity;
      return `registry:${normalizeTopicNeedle(configuredIdentity)}`;
    }
    // A translated display label is not identity evidence. Keep homonyms separate until
    // enrichment assigns the same stable public ID after an autonomous AI decision.
    return `source:${normalizeTopicNeedle(value)}`;
  }
  if (["director", "maker", "label"].includes(type)) {
    // As with actors, only the original source value may resolve through a
    // persisted alias. A translated label alone is not identity evidence.
    const verifiedIdentity = profileIdentities?.get(normalizeTopicNeedle(value));
    if (verifiedIdentity) return verifiedIdentity;
  }
  return shouldMergeLocalizedTopics(type)
    ? normalizeTopicNeedle(label) || normalizeTopicNeedle(value)
    : normalizeTopicNeedle(value);
}

function applyManualTopicCovers(type: TopicType, items: TopicListItem[]): TopicListItem[] {
  const coverRows = db.prepare(
    "SELECT facet_value AS value, media_id AS mediaId FROM topic_covers WHERE facet_type = ?"
  ).all(type) as Array<{ value: string; mediaId: string }>;
  const covers = new Map(coverRows.map((row) => [row.value, row.mediaId]));
  return items.map((item) => {
    const customCoverMediaId = item.aliases.map((alias) => covers.get(alias)).find(Boolean) ?? null;
    return {
      ...item,
      customCoverMediaId,
      mediaId: customCoverMediaId ?? item.mediaId
    };
  });
}

function loadTopicItems(type: TopicType): TopicListItem[] {
  const identityRevision = ["actor", "director", "maker", "label", "series"].includes(type) ? String((db.prepare(`
    SELECT
      (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), '') FROM entity_profiles WHERE facet_type = @type)
      || ':' ||
      (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), '') FROM media_metadata)
      AS revision
  `).get({ type }) as { revision: string }).revision) + `:${topicLocalizationRevision()}` : "";
  const cached = topicListCache.get(type);
  if (cached && cached.expiresAt > Date.now() && cached.identityRevision === identityRevision) return cached.items;
  const persisted = readTopicStats(type);
  if (persisted) {
    const resolved = applyTrustedProfileDisplayNames(type, applyManualTopicCovers(type, persisted))
      .filter((item) => isTopicEntityVisible(type, item.value, item.label));
    topicListCache.set(type, { expiresAt: Date.now() + TOPIC_CACHE_TTL_MS, items: resolved, identityRevision });
    return resolved;
  }

  const localizations = getTopicLocalizations()[type];
  const rows = (type === "prefix"
    ? db.prepare(
      `
      SELECT
        media_files.code_prefix AS value,
        COUNT(DISTINCT media_files.library_category || ':' || media_files.normalized_code) AS mediaCount,
        MAX(NULLIF(media_metadata.release_date, '')) AS latestReleaseDate,
        COALESCE(
          MIN(CASE WHEN media_files.thumbnail_status = 'ready' THEN media_files.id END),
          MIN(media_files.id)
        ) AS mediaId
      FROM media_files
      LEFT JOIN media_metadata ON media_metadata.normalized_code = media_files.normalized_code
      WHERE media_files.code_prefix != '' AND UPPER(media_files.code_prefix) != 'FC2'
      GROUP BY media_files.code_prefix
      ORDER BY mediaCount DESC, media_files.code_prefix COLLATE NOCASE ASC
      `
    ).all()
    : db
    .prepare(
      `
      SELECT
        facets.facet_value AS value,
        media_files.library_category || ':' || media_files.normalized_code AS logicalMediaKey,
        1 AS mediaCount,
        MAX(NULLIF(media_metadata.release_date, '')) AS latestReleaseDate,
        COALESCE(
          MIN(CASE WHEN media_files.thumbnail_status = 'ready' THEN media_files.id END),
          MIN(media_files.id)
        ) AS mediaId
      FROM media_metadata_facets facets
      JOIN media_files ON media_files.normalized_code = facets.normalized_code
      LEFT JOIN media_metadata ON media_metadata.normalized_code = facets.normalized_code
      WHERE facets.facet_type = @type
      GROUP BY facets.facet_value, media_files.library_category, media_files.normalized_code
      ORDER BY facets.facet_value COLLATE NOCASE ASC
    `
    )
    .all({ type })) as Array<{
      value: string;
      mediaCount: number;
      latestReleaseDate: string | null;
      mediaId: string | null;
      logicalMediaKey: string;
      aliases?: string[];
    }>;

  const localizedRows = rows
    .map((row) => ({ ...row, label: localizations.get(row.value) || row.value }))
    .filter((row) => isTopicEntityVisible(type, row.value, row.label));
  const profileIdentity = topicProfileIdentityMap(type);
  const items = type === "prefix"
    ? localizedRows.map((row) => ({ ...row, aliases: [row.value] }))
    : Array.from(localizedRows.reduce((groups, row) => {
        const key = topicGroupKey(type, row.value, row.label, profileIdentity?.identities);
        const group = groups.get(key) ?? {
          value: row.value,
          label: row.label,
          aliases: new Set<string>(),
          mediaKeys: new Set<string>(),
          mediaCount: 0,
          latestReleaseDate: null as string | null,
          mediaId: null as string | null
        };
        group.aliases.add(row.value);
        group.mediaKeys.add(row.logicalMediaKey);
        if ((row.latestReleaseDate ?? "") > (group.latestReleaseDate ?? "")) {
          group.latestReleaseDate = row.latestReleaseDate;
        }
        if (!group.mediaId && row.mediaId) group.mediaId = row.mediaId;
        groups.set(key, group);
        return groups;
      }, new Map<string, {
        value: string;
        label: string;
        aliases: Set<string>;
        mediaKeys: Set<string>;
        mediaCount: number;
        latestReleaseDate: string | null;
        mediaId: string | null;
      }>()).values()).map((group) => {
        const aliases = [...group.aliases];
        const registeredActorName = type === "actor" ? getCanonicalActorName(...aliases) : null;
        const profileCanonicalValue = profileIdentity?.canonicalValues.get(
          topicGroupKey(type, group.value, group.label, profileIdentity.identities)
        );
        return {
          value: profileCanonicalValue || (
            type === "actor"
              ? registeredActorName || preferredActorSourceName(aliases)
              : aliases.sort((left, right) => left.localeCompare(right, "ja"))[0] ?? group.value
          ),
          label: type === "actor" ? group.label : registeredActorName || group.label,
          aliases,
          mediaCount: group.mediaKeys.size,
          latestReleaseDate: group.latestReleaseDate,
          mediaId: group.mediaId
        };
      });
  const profileNamedItems = applyTrustedProfileDisplayNames(type, items);
  writeTopicStats(type, profileNamedItems);
  const resolvedItems = applyManualTopicCovers(type, profileNamedItems);
  topicListCache.set(type, { expiresAt: Date.now() + TOPIC_CACHE_TTL_MS, items: resolvedItems, identityRevision });
  return resolvedItems;
}

export function getCanonicalTopicProfileCandidates(type: TopicType, minWorks = 0): Array<{
  value: string;
  aliases: string[];
}> {
  return loadTopicItems(type)
    .filter((item) => item.mediaCount >= minWorks && isTopicEntityVisible(type, item.value, item.label))
    .map((item) => ({ value: item.value, aliases: item.aliases }));
}

export function getTopicLabel(type: TopicType, value: string): string {
  return loadTopicItems(type).find((item) => item.aliases.includes(value))?.label ||
    getTopicLocalizations()[type].get(value) || value;
}

export function getTopicAliases(type: TopicType, value: string): string[] {
  const topicAliases = loadTopicItems(type).find((item) => item.value === value || item.aliases.includes(value))?.aliases ?? [value];
  return [...new Set([...topicAliases, ...resolveEntityInsightAliases(type, value)])];
}

export function getTopicGraphItems(type: TopicType): TopicListItem[] {
  return loadTopicItems(type).filter((item) => isTopicVisible(type, item.value, item.label));
}

export function isTopicVisible(type: TopicType, value: string, label = getTopicLabel(type, value)): boolean {
  return isTopicEntityVisible(type, value, label);
}

function buildEntityDescription(options: {
  type: TopicType;
  label: string;
  mediaCount: number;
  latestReleaseDate: string | null;
  related: Partial<Record<TopicType, Array<{ label: string }>>>;
}): string {
  const typeLabel = TOPIC_TYPE_LABELS[options.type];
  const parts = [`${typeLabel}「${options.label}」当前关联 ${options.mediaCount.toLocaleString("zh-CN")} 部作品`];
  const actors = options.related.actor?.slice(0, 3).map((item) => item.label) ?? [];
  const makers = options.related.maker?.slice(0, 3).map((item) => item.label) ?? [];
  const genres = options.related.genre?.slice(0, 5).map((item) => item.label) ?? [];
  if (options.type !== "actor" && actors.length > 0) parts.push(`常见演员包括 ${actors.join("、")}`);
  if (options.type !== "maker" && makers.length > 0) parts.push(`主要关联厂商为 ${makers.join("、")}`);
  if (options.type !== "genre" && genres.length > 0) parts.push(`常见标签有 ${genres.join("、")}`);
  if (options.latestReleaseDate) parts.push(`最近发行记录为 ${options.latestReleaseDate}`);
  return `${parts.join("；")}。`;
}

function filterMetadataGenres(genres: string[], genresZh: string[]): { genres: string[]; genresZh: string[] } {
  const visible = genres
    .map((genre, index) => ({ genre, genreZh: genresZh[index] ?? genre }))
    .filter(({ genre, genreZh }) => {
      const source = genre.trim().toLocaleLowerCase();
      const translated = genreZh.trim().toLocaleLowerCase();
      return !HIDDEN_METADATA_GENRES.has(source) && !HIDDEN_METADATA_GENRES.has(translated);
    });
  return {
    genres: visible.map(({ genre }) => genre),
    genresZh: visible.map(({ genreZh }) => genreZh)
  };
}

function mapMedia(row: DetailedRow, favoriteKeys: Set<string>, options: { compact?: boolean } = {}) {
  const override = parseObject(row.override_json);
  const overrideGenresZh = Array.isArray(override.genresZh)
    ? override.genresZh.filter((item): item is string => typeof item === "string")
    : parseArray(row.metadata_genres_zh_json);
  const visibleGenres = filterMetadataGenres(
    parseArray(row.metadata_genres_json),
    overrideGenresZh
  );
  const metadata = row.metadata_status
    ? {
        status: row.metadata_status,
        title: row.metadata_title ?? "",
        summary: row.metadata_summary ?? "",
        director: row.metadata_director ?? "",
        actors: parseArray(row.metadata_actors_json),
        maker: row.metadata_maker ?? "",
        label: row.metadata_label ?? "",
        series: row.metadata_series ?? "",
        titleZh: row.metadata_title_zh ?? "",
        summaryZh: row.metadata_summary_zh ?? "",
        directorZh: row.metadata_director_zh ?? "",
        actorsZh: parseArray(row.metadata_actors_zh_json),
        makerZh: row.metadata_maker_zh ?? "",
        labelZh: row.metadata_label_zh ?? "",
        seriesZh: row.metadata_series_zh ?? "",
        releaseDate: row.metadata_release_date,
        runtimeMinutes: row.metadata_runtime_minutes,
        score: row.metadata_score,
        coverUrl: row.metadata_cover_url ?? "",
        thumbUrl: row.metadata_thumb_url ?? "",
        homepage: row.metadata_homepage ?? "",
        provider: row.metadata_provider ?? "",
        source: row.metadata_source ?? "",
        translationStatus: row.metadata_translation_status ?? "pending",
        translatedAt: row.metadata_translated_at,
        fetchedAt: row.metadata_fetched_at,
        updatedAt: row.metadata_updated_at,
        ...override,
        genres: visibleGenres.genres,
        genresZh: visibleGenres.genresZh
      }
    : null;

  const durationSeconds = row.duration_seconds ?? (
    row.metadata_runtime_minutes && row.metadata_runtime_minutes > 0
      ? row.metadata_runtime_minutes * 60
      : null
  );
  let exposedMetadata = metadata;
  if (metadata && options.compact) {
    const {
      summary: _summary,
      summaryZh: _summaryZh,
      homepage: _homepage,
      ...compactMetadata
    } = metadata;
    exposedMetadata = compactMetadata as typeof metadata;
  }
  return {
    id: row.id,
    libraryCategory: row.library_category,
    sourceName: row.source_name,
    relativePath: row.relative_path,
    name: row.name,
    basename: row.basename,
    extension: row.extension,
    mimeType: row.mime_type,
    size: row.size,
    mtimeMs: row.mtime_ms,
    directory: row.directory,
    firstLetter: row.first_letter,
    collectionBucket: row.collection_bucket,
    normalizedCode: row.normalized_code,
    codePrefix: row.code_prefix,
    codeNumber: row.code_number,
    variantTags: row.variant_tags,
    qualityTag: row.quality_tag,
    mediaType: row.media_type,
    durationSeconds,
    width: row.width,
    height: row.height,
    containerFormat: row.container_format,
    videoCodec: row.video_codec,
    audioCodec: row.audio_codec,
    compatibilityStatus: row.compatibility_status,
    probeStatus: row.probe_status,
    probeError: row.probe_error,
    thumbnailStatus: row.thumbnail_status,
    indexedAt: row.indexed_at,
    isFavorite: favoriteKeys.has(row.relative_path),
    playback: row.playback_last_played_at
      ? {
          positionSeconds: row.playback_position_seconds ?? 0,
          durationSeconds: row.playback_duration_seconds ?? durationSeconds,
          completed: Boolean(row.playback_completed),
          playCount: row.playback_play_count ?? 0,
          lastPlayedAt: row.playback_last_played_at
        }
      : null,
    metadata: exposedMetadata
  };
}

function getDetailedMedia(id: string): DetailedRow | null {
  return (db.prepare(`${detailedMediaSql} WHERE media_files.id = ?`).get(id) as DetailedRow | undefined) ?? null;
}

function getMediaVersions(row: DetailedRow, favoriteKeys: Set<string>) {
  const rows = row.normalized_code
    ? (db
        .prepare(
          `${detailedMediaSql}
           WHERE media_files.library_category = ? AND media_files.normalized_code = ?
           ORDER BY media_files.size DESC, media_files.mtime_ms DESC`
        )
        .all(row.library_category, row.normalized_code) as DetailedRow[])
    : [row];
  return rows.map((version) => mapMedia(version, favoriteKeys));
}

function getSidecars(mediaId: string) {
  const sidecars = db
    .prepare(
      `
      SELECT
        id, kind, relative_path AS relativePath, language, label, format, size, mtime_ms AS mtimeMs
      FROM media_sidecars
      WHERE media_id = ?
      ORDER BY kind, language, label
    `
    )
    .all(mediaId);
  const translated = getReadyTranslationSidecar(mediaId);
  return translated ? [translated, ...sidecars] : sidecars;
}

function getDerivatives(mediaId: string) {
  return db
    .prepare(
      `
      SELECT kind, variant, status, bytes, error, updated_at AS updatedAt
      FROM media_derivatives
      WHERE media_id = ?
      ORDER BY kind, variant
    `
    )
    .all(mediaId);
}

function buildQualityCounts() {
  const scalar = (sql: string) => (db.prepare(sql).get() as { count: number }).count;
  return {
    unmatched: scalar(`SELECT COUNT(*) AS count FROM media_metadata WHERE status IN ('not_found', 'failed')`),
    missingCover: scalar(`SELECT COUNT(*) AS count FROM media_metadata WHERE status = 'ready' AND cover_url = '' AND thumb_url = ''`),
    translation: scalar(`SELECT COUNT(*) AS count FROM media_metadata WHERE status = 'ready' AND translation_status != 'ready'`),
    duplicate: scalar(`SELECT COUNT(*) AS count FROM (SELECT normalized_code FROM media_files WHERE normalized_code != '' GROUP BY library_category, normalized_code HAVING COUNT(*) > 1)`),
    missingProbe: scalar(`
      SELECT COUNT(*) AS count FROM (
        SELECT library_category, CASE WHEN normalized_code != '' THEN normalized_code ELSE id END
        FROM media_files
        WHERE media_type = 'video' AND probe_status != 'ready'
        GROUP BY library_category, CASE WHEN normalized_code != '' THEN normalized_code ELSE id END
      )
    `),
    compatibility: scalar(`
      SELECT COUNT(*) AS count FROM (
        SELECT library_category, CASE WHEN normalized_code != '' THEN normalized_code ELSE id END
        FROM media_files
        WHERE media_type = 'video' AND compatibility_status IN ('remux', 'transcode', 'unsupported')
        GROUP BY library_category, CASE WHEN normalized_code != '' THEN normalized_code ELSE id END
      )
    `)
  };
}

function buildMediaQualityItems(issue: "missing-probe" | "compatibility", page: number, pageSize: number) {
  const predicate = issue === "missing-probe"
    ? "media_files.media_type = 'video' AND media_files.probe_status != 'ready'"
    : "media_files.media_type = 'video' AND media_files.compatibility_status IN ('remux', 'transcode', 'unsupported')";
  const groupedSql = `
    FROM media_files
    LEFT JOIN media_metadata ON media_metadata.normalized_code = media_files.normalized_code
    WHERE ${predicate}
    GROUP BY media_files.library_category, CASE
      WHEN media_files.normalized_code != '' THEN media_files.normalized_code
      ELSE media_files.id
    END
  `;
  const total = db.prepare(`SELECT COUNT(*) AS count FROM (SELECT media_files.id ${groupedSql})`).get() as { count: number };
  const items = db
    .prepare(
      `
      SELECT
        media_files.normalized_code AS normalizedCode,
        COALESCE(media_metadata.status, 'missing') AS status,
        COALESCE(media_metadata.title, '') AS title,
        COALESCE(media_metadata.title_zh, '') AS titleZh,
        COALESCE(media_metadata.translation_status, 'pending') AS translationStatus,
        COALESCE(media_metadata.cover_url, '') AS coverUrl,
        COALESCE(media_metadata.thumb_url, '') AS thumbUrl,
        MAX(COALESCE(media_files.probe_error, '')) AS error,
        COUNT(media_files.id) AS mediaCount,
        MIN(media_files.id) AS mediaId
      ${groupedSql}
      ORDER BY MAX(media_files.mtime_ms) DESC
      LIMIT @limit OFFSET @offset
    `
    )
    .all({ limit: pageSize, offset: (page - 1) * pageSize });
  return { items, total: total.count, page, pageSize, totalPages: Math.ceil(total.count / pageSize) };
}

const indexedQualityIssueTypes = {
  "missing-title-zh": "missing_title_zh",
  "missing-actor-zh": "missing_actor_zh",
  "missing-genre-zh": "missing_genre_zh",
  "duration-conflict": "duration_conflict",
  "future-release-date": "future_release_date",
  "low-completeness": "low_completeness"
} as const;

function buildIndexedQualityItems(
  issueType: (typeof indexedQualityIssueTypes)[keyof typeof indexedQualityIssueTypes],
  page: number,
  pageSize: number
) {
  const total = db.prepare(`
    SELECT COUNT(*) AS count FROM metadata_quality_issues WHERE issue_type = ?
  `).get(issueType) as { count: number };
  const items = db.prepare(`
    SELECT
      quality.normalized_code AS normalizedCode,
      metadata.status,
      metadata.title,
      metadata.title_zh AS titleZh,
      metadata.translation_status AS translationStatus,
      metadata.cover_url AS coverUrl,
      metadata.thumb_url AS thumbUrl,
      metadata.error,
      quality.issue_type AS qualityIssue,
      quality.severity AS qualitySeverity,
      quality.details_json AS qualityDetails,
      COUNT(DISTINCT media_files.id) AS mediaCount,
      MIN(media_files.id) AS mediaId
    FROM metadata_quality_issues quality
    JOIN media_metadata metadata ON metadata.normalized_code = quality.normalized_code
    LEFT JOIN media_files ON media_files.normalized_code = quality.normalized_code
    WHERE quality.issue_type = @issueType
    GROUP BY quality.normalized_code
    ORDER BY CASE quality.severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
      metadata.updated_at DESC
    LIMIT @limit OFFSET @offset
  `).all({ issueType, limit: pageSize, offset: (page - 1) * pageSize });
  return { items, total: total.count, page, pageSize, totalPages: Math.ceil(total.count / pageSize) };
}

function buildQualityItems(issue: z.infer<typeof qualityQuerySchema>["issue"], page: number, pageSize: number) {
  if (issue === "missing-probe" || issue === "compatibility") {
    return buildMediaQualityItems(issue, page, pageSize);
  }
  if (issue in indexedQualityIssueTypes) {
    return buildIndexedQualityItems(
      indexedQualityIssueTypes[issue as keyof typeof indexedQualityIssueTypes],
      page,
      pageSize
    );
  }
  const offset = (page - 1) * pageSize;
  const conditions: Record<string, string> = {
    unmatched: "media_metadata.status IN ('not_found', 'failed')",
    "missing-cover": "media_metadata.status = 'ready' AND media_metadata.cover_url = '' AND media_metadata.thumb_url = ''",
    translation: "media_metadata.status = 'ready' AND media_metadata.translation_status != 'ready'",
    duplicate: "EXISTS (SELECT 1 FROM media_files duplicate_files WHERE duplicate_files.normalized_code = media_metadata.normalized_code GROUP BY duplicate_files.library_category, duplicate_files.normalized_code HAVING COUNT(*) > 1)",
    "missing-probe": "1 = 0",
    compatibility: "1 = 0"
  };
  const where = issue === "all" ? "1 = 1" : conditions[issue];
  const total = db.prepare(`SELECT COUNT(*) AS count FROM media_metadata WHERE ${where}`).get() as { count: number };
  const rows = db
    .prepare(
      `
      SELECT
        media_metadata.normalized_code AS normalizedCode,
        media_metadata.status,
        media_metadata.title,
        media_metadata.title_zh AS titleZh,
        media_metadata.translation_status AS translationStatus,
        media_metadata.cover_url AS coverUrl,
        media_metadata.thumb_url AS thumbUrl,
        media_metadata.error,
        COUNT(DISTINCT media_files.id) AS mediaCount,
        MIN(media_files.id) AS mediaId
      FROM media_metadata
      LEFT JOIN media_files ON media_files.normalized_code = media_metadata.normalized_code
      WHERE ${where}
      GROUP BY media_metadata.normalized_code
      ORDER BY media_metadata.updated_at DESC, media_metadata.normalized_code
      LIMIT @limit OFFSET @offset
    `
    )
    .all({ limit: pageSize, offset });
  return { items: rows, total: total.count, page, pageSize, totalPages: Math.ceil(total.count / pageSize) };
}

function getRelatedTopics(type: TopicType, value: string) {
  const aliases = getTopicAliases(type, value);
  const aliasParams = Object.fromEntries(aliases.map((alias, index) => [`alias${index}`, alias]));
  const aliasPlaceholders = aliases.map((_, index) => `@alias${index}`).join(", ");
  const rows = (type === "prefix"
    ? db.prepare(
      `
      SELECT
        related.facet_type AS type,
        related.facet_value AS value,
        media_files.library_category || ':' || media_files.normalized_code AS logicalMediaKey
      FROM media_files
      JOIN media_metadata_facets related ON related.normalized_code = media_files.normalized_code
      WHERE media_files.code_prefix = @value
        AND related.facet_type IN ('actor', 'director', 'genre', 'series', 'maker', 'label')
      GROUP BY related.facet_type, related.facet_value, logicalMediaKey
      `
    ).all({ value })
    : db
    .prepare(
      `
      SELECT
        related.facet_type AS type,
        related.facet_value AS value,
        media_files.library_category || ':' || media_files.normalized_code AS logicalMediaKey
      FROM media_metadata_facets matched
      JOIN media_metadata_facets related ON related.normalized_code = matched.normalized_code
      JOIN media_files ON media_files.normalized_code = matched.normalized_code
      WHERE matched.facet_type = @type
        AND matched.facet_value IN (${aliasPlaceholders})
        AND related.facet_type IN ('actor', 'director', 'genre', 'series', 'maker', 'label')
        AND NOT (related.facet_type = @type AND related.facet_value IN (${aliasPlaceholders}))
      GROUP BY related.facet_type, related.facet_value, logicalMediaKey
    `
    )
    .all({ type, value, ...aliasParams })) as Array<{ type: TopicType; value: string; logicalMediaKey: string }>;
  const localizations = getTopicLocalizations();
  const favoriteValues = Object.fromEntries(
    TOPIC_TYPES.map((favoriteType) => [favoriteType, readEntityFavoriteValues(favoriteType)])
  ) as Record<TopicType, Set<string>>;
  const result: Record<TopicType, Array<{ value: string; label: string; mediaCount: number; isFavorite: boolean }>> = {
    actor: [],
    series: [],
    genre: [],
    prefix: [],
    director: [],
    maker: [],
    label: []
  };
  const canonicalByAlias = getCanonicalTopicAliasMap();
  const relationGroups = new Map<string, { type: TopicType; value: string; label: string; aliases: string[]; media: Set<string> }>();
  for (const row of rows) {
    const canonical = canonicalByAlias.get(`${row.type}:${row.value}`);
    const canonicalValue = canonical?.value ?? row.value;
    const canonicalLabel = canonical?.label ?? localizations[row.type].get(row.value) ?? row.value;
    if (row.type === "genre") {
      if (HIDDEN_METADATA_GENRES.has(row.value.toLocaleLowerCase()) || HIDDEN_METADATA_GENRES.has(canonicalLabel.toLocaleLowerCase())) {
        continue;
      }
    }
    const key = `${row.type}:${canonicalValue}`;
    const group = relationGroups.get(key) ?? {
      type: row.type, value: canonicalValue, label: canonicalLabel,
      aliases: canonical?.aliases ?? [row.value], media: new Set<string>()
    };
    group.media.add(row.logicalMediaKey);
    relationGroups.set(key, group);
  }
  for (const group of [...relationGroups.values()].sort((left, right) =>
    right.media.size - left.media.size || left.label.localeCompare(right.label, "zh-CN"))) {
    if (result[group.type].length >= 18) continue;
    result[group.type].push({
      value: group.value,
      label: group.label,
      mediaCount: group.media.size,
      isFavorite: group.aliases.some((alias) => favoriteValues[group.type].has(alias))
    });
  }
  return result;
}

function getCanonicalTopicAliasMap(): Map<string, TopicListItem> {
  if (canonicalTopicAliasCache && canonicalTopicAliasCache.expiresAt > Date.now()) {
    return canonicalTopicAliasCache.value;
  }
  const value = new Map<string, TopicListItem>();
  for (const relatedType of ["actor", "series", "genre", "director", "maker", "label"] as TopicType[]) {
    for (const item of loadTopicItems(relatedType)) {
      for (const alias of [item.value, ...item.aliases]) value.set(`${relatedType}:${alias}`, item);
    }
  }
  canonicalTopicAliasCache = { expiresAt: Date.now() + TOPIC_CACHE_TTL_MS, value };
  return value;
}

export function registerProductRoutes(app: Express, options: { onDataChanged?: () => void } = {}): void {
  app.get("/api/saved-filters", (_req, res) => {
    const items = db
      .prepare("SELECT id, name, query_json AS queryJson, created_at AS createdAt, updated_at AS updatedAt FROM saved_filters ORDER BY updated_at DESC")
      .all() as Array<{ id: string; name: string; queryJson: string; createdAt: string; updatedAt: string }>;
    res.json({ items: items.map((item) => ({ ...item, query: parseObject(item.queryJson), queryJson: undefined })) });
  });

  app.post("/api/saved-filters", (req, res, next) => {
    try {
      const body = savedFilterSchema.parse(req.body);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare("INSERT INTO saved_filters (id, name, query_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, body.name, JSON.stringify(body.query), now, now);
      res.status(201).json({ id, name: body.name, query: body.query, createdAt: now, updatedAt: now });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/saved-filters/:id", (req, res, next) => {
    try {
      const body = savedFilterSchema.parse(req.body);
      const now = new Date().toISOString();
      const result = db.prepare("UPDATE saved_filters SET name = ?, query_json = ?, updated_at = ? WHERE id = ?")
        .run(body.name, JSON.stringify(body.query), now, req.params.id);
      if (result.changes === 0) return void res.status(404).json({ error: "Saved filter not found" });
      res.json({ id: req.params.id, name: body.name, query: body.query, updatedAt: now });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/saved-filters/:id", (req, res) => {
    const result = db.prepare("DELETE FROM saved_filters WHERE id = ?").run(req.params.id);
    if (result.changes === 0) return void res.status(404).json({ error: "Saved filter not found" });
    res.status(204).end();
  });

  app.get("/api/topics", (_req, res) => {
    const dimensions = TOPIC_TYPES.map((type) => {
      const items = loadTopicItems(type);
      const favorites = readEntityFavoriteValues(type);
      const mediaCount = (type === "prefix"
        ? db.prepare("SELECT COUNT(DISTINCT normalized_code) AS count FROM media_files WHERE code_prefix != '' AND UPPER(code_prefix) != 'FC2'").get()
        : db.prepare("SELECT COUNT(DISTINCT normalized_code) AS count FROM media_metadata_facets WHERE facet_type = ?").get(type)
      ) as { count: number };
      const highlights = [...items]
        .sort((left, right) =>
          Number(right.aliases.some((alias) => favorites.has(alias))) -
          Number(left.aliases.some((alias) => favorites.has(alias)))
        )
        .slice(0, 6);
      return {
        type,
        label: TOPIC_TYPE_LABELS[type],
        entityCount: items.length,
        mediaCount: mediaCount.count,
        ...(["actor", "director", "maker", "label", "series"].includes(type)
          ? { profileCoverage: getEntityProfileCoverage(type, items) }
          : {}),
        highlights: highlights.map((item) => ({
          ...item,
          isFavorite: item.aliases.some((alias) => favorites.has(alias))
        }))
      };
    });
    res.setHeader("Cache-Control", "private, no-cache");
    res.json({ dimensions });
  });

  app.get("/api/favorites/topics/:type", (req, res, next) => {
    try {
      const type = topicTypeSchema.parse(req.params.type);
      const favorites = readEntityFavorites(type);
      const byAlias = new Map<string, TopicListItem>();
      if (favorites.length) {
        for (const item of loadTopicItems(type)) {
          for (const alias of [item.value, ...item.aliases]) byAlias.set(alias, item);
        }
      }
      res.setHeader("Cache-Control", "private, no-cache");
      res.json({ items: favorites.map((favorite) => {
        const topic = byAlias.get(favorite.value);
        return {
          ...favorite,
          mediaId: topic?.mediaId ?? null,
          customCoverMediaId: topic?.customCoverMediaId ?? null,
          mediaCount: topic?.mediaCount ?? 0,
          latestReleaseDate: topic?.latestReleaseDate ?? null,
          isFavorite: true
        };
      }) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/topics/:type", (req, res, next) => {
    try {
      const type = topicTypeSchema.parse(req.params.type);
      const query = topicQuerySchema.parse(req.query);
      const needle = normalizeTopicNeedle(query.q);
      const filtered = needle
        ? loadTopicItems(type).filter((item) =>
            [item.value, item.label, ...item.aliases].some((value) => normalizeTopicNeedle(value).includes(needle))
          )
        : loadTopicItems(type);
      const favoriteValues = readEntityFavoriteValues(type);
      const sorted = [...filtered].sort((left, right) => {
        if (query.sort === "random") {
          return seededTopicRank(left.value, query.randomSeed) - seededTopicRank(right.value, query.randomSeed) ||
            left.label.localeCompare(right.label, "zh-CN");
        }
        const favoriteOrder = Number(right.aliases.some((alias) => favoriteValues.has(alias))) -
          Number(left.aliases.some((alias) => favoriteValues.has(alias)));
        if (favoriteOrder !== 0) return favoriteOrder;
        if (query.sort === "name") {
          return left.label.localeCompare(right.label, "zh-CN") || right.mediaCount - left.mediaCount;
        }
        if (query.sort === "latest") {
          return (right.latestReleaseDate ?? "").localeCompare(left.latestReleaseDate ?? "") ||
            right.mediaCount - left.mediaCount;
        }
        if (query.sort === "count-asc") {
          return left.mediaCount - right.mediaCount || left.label.localeCompare(right.label, "zh-CN");
        }
        return right.mediaCount - left.mediaCount || left.label.localeCompare(right.label, "zh-CN");
      });
      const offset = (query.page - 1) * query.pageSize;
      const pageItems = sorted.slice(offset, offset + query.pageSize);
      res.setHeader("Cache-Control", "private, no-cache");
      res.json({
        type,
        label: TOPIC_TYPE_LABELS[type],
        items: pageItems.map((item) => ({
          ...item,
          isFavorite: item.aliases.some((alias) => favoriteValues.has(alias))
        })),
        total: sorted.length,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: Math.ceil(sorted.length / query.pageSize)
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/media/:id/detail", (req, res) => {
    const row = getDetailedMedia(req.params.id);
    if (!row) return void res.status(404).json({ error: "Media not found" });
    const favorites = readFavoriteKeys();
    ensureMetadataQualityIssues();
    const item = mapMedia(row, favorites);
    const quality = row.normalized_code ? getMetadataQualityForCode(row.normalized_code) : null;
    const detailedItem = quality && item.metadata
      ? { ...item, metadata: { ...item.metadata, ...quality, qualityScore: quality.completeness } }
      : item;
    res.json({
      item: detailedItem,
      versions: getMediaVersions(row, favorites),
      sidecars: getSidecars(row.id),
      derivatives: getDerivatives(row.id),
      translation: getSubtitleTranslation(row.id)
    });
  });

  app.get("/api/media/:id/versions", (req, res) => {
    const row = getDetailedMedia(req.params.id);
    if (!row) return void res.status(404).json({ error: "Media not found" });
    res.json({ items: getMediaVersions(row, readFavoriteKeys()) });
  });

  app.get("/api/entities/actor-cards", (req, res, next) => {
    const startedAt = performance.now();
    try {
      const rawValues = Array.isArray(req.query.value) ? req.query.value : [req.query.value];
      const values = [...new Set(rawValues
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean))].slice(0, 12);
      if (values.length === 0) return void res.status(400).json({ error: "At least one actor value is required" });

      const topics = loadTopicItems("actor");
      const items = values.map((requestedValue) => {
        const topic = topics.find((item) => item.value === requestedValue || item.aliases.includes(requestedValue));
        const value = topic?.value ?? requestedValue;
        return {
          requestedValue,
          entity: {
            value,
            label: topic?.label ?? getTopicLabel("actor", requestedValue),
            aliases: topic?.aliases ?? [requestedValue],
            mediaCount: topic?.mediaCount ?? 0,
            customCoverMediaId: topic?.customCoverMediaId ?? null
          },
          profile: resolveEntityProfileImageUrl(getEntityExtendedProfile("actor", value))
        };
      });
      res.setHeader("Cache-Control", "private, max-age=600");
      res.setHeader("Server-Timing", `actor-cards;dur=${(performance.now() - startedAt).toFixed(1)}`);
      res.json({ items });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/entities/:type/:value", (req, res, next) => {
    const startedAt = performance.now();
    let stageStartedAt = startedAt;
    const stageTimings: string[] = [];
    const markStage = (name: string) => {
      const now = performance.now();
      stageTimings.push(`${name};dur=${(now - stageStartedAt).toFixed(1)}`);
      stageStartedAt = now;
    };
    try {
      const type = topicTypeSchema.parse(req.params.type);
      const query = entityQuerySchema.parse(req.query);
      const value = req.params.value.trim();
      const cacheKey = JSON.stringify({ type, value, query });
      const cached = readEntityResponseCache(cacheKey);
      if (cached) {
        res.setHeader("Cache-Control", "private, max-age=60");
        res.setHeader("X-AMW-Cache", "HIT");
        res.setHeader("Server-Timing", `entity;dur=${(performance.now() - startedAt).toFixed(1)}`);
        res.json(cached);
        return;
      }
      const aliases = getTopicAliases(type, value);
      markStage("aliases");
      const aliasParams = Object.fromEntries(aliases.map((alias, index) => [`alias${index}`, alias]));
      const aliasPlaceholders = aliases.map((_, index) => `@alias${index}`).join(", ");
      const entityStats = (type === "prefix"
        ? db.prepare(
          `
          SELECT
            COUNT(DISTINCT media_files.library_category || ':' || media_files.normalized_code) AS mediaCount,
            MAX(NULLIF(media_metadata.release_date, '')) AS latestReleaseDate
          FROM media_files
          LEFT JOIN media_metadata ON media_metadata.normalized_code = media_files.normalized_code
          WHERE media_files.code_prefix = @value
          `
        ).get({ value })
        : db
        .prepare(
          `
          SELECT
            COUNT(DISTINCT media_files.library_category || ':' || media_files.normalized_code) AS mediaCount,
            MAX(NULLIF(media_metadata.release_date, '')) AS latestReleaseDate
          FROM media_metadata_facets
          JOIN media_files ON media_files.normalized_code = media_metadata_facets.normalized_code
          LEFT JOIN media_metadata ON media_metadata.normalized_code = media_files.normalized_code
          WHERE media_metadata_facets.facet_type = @type
            AND media_metadata_facets.facet_value IN (${aliasPlaceholders})
        `
        )
        .get({ type, value, ...aliasParams })) as { mediaCount: number; latestReleaseDate: string | null };
      if (!entityStats.mediaCount) return void res.status(404).json({ error: "Entity not found" });
      markStage("stats");

      const entityMatchSql = type === "prefix"
        ? "media_files.code_prefix = @value"
        : `media_files.normalized_code IN (
             SELECT normalized_code FROM media_metadata_facets
             WHERE facet_type = @type AND facet_value IN (${aliasPlaceholders})
           )`;
      const soloFilter = entitySoloFilter(type, query.soloOnly);
      const matchingTotal = soloFilter ? (db.prepare(`SELECT COUNT(DISTINCT media_files.library_category || ':' || media_files.normalized_code) AS total
        FROM media_files WHERE ${entityMatchSql}${soloFilter}`).get({type,value,...aliasParams}) as {total:number}).total : entityStats.mediaCount;
      const entityOrderBy = query.sort === "added"
        ? "media_files.mtime_ms DESC, media_files.name COLLATE NOCASE ASC"
        : query.sort === "name"
          ? "media_files.name COLLATE NOCASE ASC"
          : query.sort === "duration"
            ? "COALESCE(media_files.duration_seconds, 0) DESC, media_files.name COLLATE NOCASE ASC"
            : query.sort === "size"
              ? "media_files.size DESC, media_files.name COLLATE NOCASE ASC"
              : query.sort === "random"
                ? `CASE WHEN media_files.random_key >= @randomPivot THEN 0 ELSE 1 END,
                   media_files.random_key, media_files.id ASC`
                : "COALESCE(media_metadata.release_date, '') DESC, media_files.mtime_ms DESC";
      const rows = db
        .prepare(
          `WITH ranked_entity_media AS (
             SELECT
               media_files.id,
               ROW_NUMBER() OVER (
                 PARTITION BY media_files.library_category,
                   CASE WHEN media_files.normalized_code != '' THEN media_files.normalized_code ELSE media_files.id END
                 ORDER BY
                   CASE WHEN media_files.thumbnail_status = 'ready' THEN 0 ELSE 1 END,
                   CASE WHEN media_files.compatibility_status != 'unknown' THEN 0 ELSE 1 END,
                   CASE WHEN media_files.duration_seconds IS NOT NULL THEN 0 ELSE 1 END,
                   media_files.size DESC,
                   media_files.mtime_ms DESC,
                   media_files.id ASC
               ) AS logicalRank
             FROM media_files
             WHERE ${entityMatchSql}${soloFilter}
           )
           ${detailedMediaSql}
           WHERE media_files.id IN (
             SELECT id FROM ranked_entity_media WHERE logicalRank = 1
           )
           ORDER BY ${entityOrderBy}
           LIMIT @limit OFFSET @offset`
        )
        .all({
          type,
          value,
          ...aliasParams,
          randomSeed: query.randomSeed,
          randomPivot: Math.abs(query.randomSeed) % 9_007_199_254_740_991,
          limit: query.pageSize,
          offset: (query.page - 1) * query.pageSize
        }) as DetailedRow[];
      const media = rows.map((row) => mapMedia(row, readFavoriteKeys(), { compact: true }));
      markStage("items");
      const related = getRelatedTopics(type, value);
      markStage("related");
      const insights = getEntityInsights(type, value, aliases);
      const label = getTopicLabel(type, value);
      const customCover = db.prepare(
        `SELECT media_id AS mediaId FROM topic_covers
         WHERE facet_type = @type AND facet_value IN (${aliasPlaceholders})
         LIMIT 1`
      ).get({ type, ...aliasParams }) as { mediaId: string } | undefined;
      const profile = (["actor", "director", "maker", "label", "series"] as TopicType[]).includes(type)
        ? resolveEntityProfileImageUrl(getEntityExtendedProfile(type, value)) : null;
      markStage("profile");
      res.setHeader("Cache-Control", "private, max-age=60");
      res.setHeader("X-AMW-Cache", "MISS");
      res.setHeader("Server-Timing", [
        `entity;dur=${(performance.now() - startedAt).toFixed(1)}`,
        ...stageTimings
      ].join(", "));
      const body = {
        entity: {
          type,
          typeLabel: TOPIC_TYPE_LABELS[type],
          value,
          label,
          aliases,
          isFavorite: aliases.some((alias) => readEntityFavoriteValues(type).has(alias)),
          description: buildEntityDescription({
            type,
            label,
            mediaCount: entityStats.mediaCount,
            latestReleaseDate: entityStats.latestReleaseDate,
            related
          }),
          mediaCount: entityStats.mediaCount,
          latestReleaseDate: entityStats.latestReleaseDate,
          insights,
          customCoverMediaId: customCover?.mediaId ?? null,
          related,
          makers: related.maker.map((item) => item.label),
          genres: related.genre.map((item) => item.label)
        },
        profile,
        items: media,
        page: query.page,
        pageSize: query.pageSize,
        total: matchingTotal,
        totalPages: Math.ceil(matchingTotal / query.pageSize)
      };
      writeEntityResponseCache(cacheKey, body);
      res.json(body);
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/entities/:type/:value/cover", (req, res, next) => {
    try {
      const type = topicTypeSchema.parse(req.params.type);
      const value = req.params.value.trim();
      const { mediaId } = topicCoverSchema.parse(req.body);
      const topic = loadTopicItems(type).find((item) => item.value === value || item.aliases.includes(value));
      if (!topic) return void res.status(404).json({ error: "Entity not found" });

      const aliases = topic.aliases;
      const placeholders = aliases.map((_, index) => `@alias${index}`).join(", ");
      const aliasParams = Object.fromEntries(aliases.map((alias, index) => [`alias${index}`, alias]));
      const match = (type === "prefix"
        ? db.prepare("SELECT id FROM media_files WHERE id = @mediaId AND code_prefix IN (" + placeholders + ")").get({ mediaId, ...aliasParams })
        : db.prepare(
          `SELECT media_files.id FROM media_files
           WHERE media_files.id = @mediaId
             AND media_files.normalized_code IN (
               SELECT normalized_code FROM media_metadata_facets
               WHERE facet_type = @type AND facet_value IN (${placeholders})
             )`
        ).get({ mediaId, type, ...aliasParams })) as { id: string } | undefined;
      if (!match) return void res.status(400).json({ error: "所选视频不属于当前专题" });

      const now = new Date().toISOString();
      db.transaction(() => {
        db.prepare(`DELETE FROM topic_covers WHERE facet_type = @type AND facet_value IN (${placeholders})`)
          .run({ type, ...aliasParams });
        db.prepare(
          `INSERT INTO topic_covers (facet_type, facet_value, media_id, updated_at)
           VALUES (@type, @value, @mediaId, @updatedAt)`
        ).run({ type, value: topic.value, mediaId, updatedAt: now });
      })();
      clearTopicCaches();
      res.json({ type, value: topic.value, mediaId, updatedAt: now });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/entities/:type/:value/cover", (req, res, next) => {
    try {
      const type = topicTypeSchema.parse(req.params.type);
      const value = req.params.value.trim();
      const aliases = getTopicAliases(type, value);
      const placeholders = aliases.map((_, index) => `@alias${index}`).join(", ");
      const aliasParams = Object.fromEntries(aliases.map((alias, index) => [`alias${index}`, alias]));
      db.prepare(`DELETE FROM topic_covers WHERE facet_type = @type AND facet_value IN (${placeholders})`)
        .run({ type, ...aliasParams });
      clearTopicCaches();
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/metadata/quality", (req, res, next) => {
    try {
      const query = qualityQuerySchema.parse(req.query);
      ensureMetadataQualityIssues();
      res.json({
        counts: buildQualityCounts(),
        indexedIssues: getMetadataQualityIssueCounts(),
        ...buildQualityItems(query.issue, query.page, query.pageSize)
      });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/metadata/:code/override", (req, res, next) => {
    try {
      const code = req.params.code.trim().toUpperCase();
      const patch = metadataOverrideSchema.parse(req.body);
      const now = new Date().toISOString();
      db.prepare(
        `
        INSERT INTO metadata_overrides (normalized_code, patch_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(normalized_code) DO UPDATE SET patch_json = excluded.patch_json, updated_at = excluded.updated_at
      `
      ).run(code, JSON.stringify(patch), now);

      const metadata = db.prepare("SELECT * FROM media_metadata WHERE normalized_code = ?").get(code) as Record<string, unknown> | undefined;
      if (metadata) {
        replaceMetadataFacetsForCode({
          normalizedCode: code,
          actors: parseArray(String(metadata.actors_json ?? "[]")),
          genres: parseArray(String(metadata.genres_json ?? "[]")),
          director: String(metadata.director ?? ""),
          maker: String(metadata.maker ?? ""),
          label: String(metadata.label ?? ""),
          series: String(metadata.series ?? "")
        });
      }
      clearTopicCaches();
      refreshMediaSearchIndexForCode(code);
      refreshMetadataQualityIssues();
      options.onDataChanged?.();
      res.json({ normalizedCode: code, patch, updatedAt: now });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/media/:id/poster-variant", (req, res) => {
    const variant = (req.body?.variant === "detail" ? "detail" : "card") as PosterVariant;
    const row = getDetailedMedia(req.params.id);
    if (!row) return void res.status(404).json({ error: "Media not found" });
    const jobId = requestPosterVariant(row, variant, row.metadata_cover_url ?? "", row.metadata_thumb_url ?? "");
    res.status(202).json({ jobId, variant });
  });
}
