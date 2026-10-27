import {
  getActorAliasRegistry,
  getActorDisplayName,
  getCanonicalActorName,
  isActorNameCandidate,
  normalizeActorIdentityKey
} from "./actorAliases.js";
import { db, type MediaRow } from "./db.js";
import {
  enrichActorFromWikimedia,
  enrichPublicEntityFromWikimedia,
  type PublicEntityType,
  recordEntityEnrichmentFailure
} from "./entityProfiles.js";
import { scheduleContentPreview } from "./contentPreviews.js";

export type ActorMetadataIdentity = {
  source: string;
  translated: string;
};

export const INGESTION_ENTITY_PROFILE_TYPES = ["actor", "director", "maker", "label"] as const;
export type IngestionEntityProfileType = typeof INGESTION_ENTITY_PROFILE_TYPES[number];

export type FirstTimeActorCandidate = {
  value: string;
  displayName: string;
  searchNames: string[];
};

export type FirstTimeActorPlan = {
  candidates: FirstTimeActorCandidate[];
  skipped: number;
};

export type ActorEnrichmentStats = {
  discovered: number;
  attempted: number;
  skipped: number;
  matched: number;
  notFound: number;
  failed: number;
};

export type ActorEnrichmentQueueStats = {
  discovered: number;
  queued: number;
  skipped: number;
};

export type EntityProfileQueueStats = ActorEnrichmentQueueStats;
export type EntityProfileQueueStatsByType = Record<IngestionEntityProfileType, EntityProfileQueueStats>;

export type ContentPreviewSchedulingStats = {
  total: number;
  queued: number;
  ready: number;
  deferred: number;
};

function entityEnrichmentConcurrency(): number {
  const configured = Number.parseInt(
    process.env.INGESTION_ENTITY_ENRICH_CONCURRENCY
      ?? process.env.INGESTION_ACTOR_ENRICH_CONCURRENCY
      ?? "6",
    10
  );
  if (!Number.isFinite(configured)) return 6;
  return Math.min(6, Math.max(1, configured));
}

function uniqueActorNames(values: string[]): string[] {
  return [...new Set(values.map((value) => value.normalize("NFKC").trim())
    .filter(isActorNameCandidate))];
}

export function planFirstTimeActorEnrichment(
  rows: ActorMetadataIdentity[],
  previouslyFetchedNames: string[]
): FirstTimeActorPlan {
  const fetchedKeys = new Set(previouslyFetchedNames.map(normalizeActorIdentityKey).filter(Boolean));
  const plannedKeys = new Set<string>();
  const registry = getActorAliasRegistry();
  const candidates: FirstTimeActorCandidate[] = [];
  let skipped = 0;

  for (const row of rows) {
    const source = row.source.normalize("NFKC").trim();
    if (!isActorNameCandidate(source)) continue;
    const canonical = getCanonicalActorName(source) || source;
    const aliasGroup = registry.find((group) =>
      [group.canonicalName, ...group.aliases]
        .some((name) => normalizeActorIdentityKey(name) === normalizeActorIdentityKey(canonical))
    );
    const searchNames = uniqueActorNames([
      canonical,
      source,
      row.translated,
      ...(aliasGroup ? [aliasGroup.canonicalName, ...aliasGroup.aliases] : [])
    ]);
    const identityKeys = searchNames.map(normalizeActorIdentityKey).filter(Boolean);
    const primaryKey = normalizeActorIdentityKey(canonical);
    if (identityKeys.some((key) => fetchedKeys.has(key)) || plannedKeys.has(primaryKey)) {
      skipped += 1;
      continue;
    }
    for (const key of identityKeys) plannedKeys.add(key);
    candidates.push({
      value: canonical,
      displayName: getActorDisplayName(canonical, row.translated),
      searchNames
    });
  }
  return { candidates, skipped };
}

function publicEntityIdentityKey(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase()
    .replace(/[\s\-_・·:：.．]+/gu, "");
}

function uniquePublicEntityNames(values: string[]): string[] {
  const names = new Map<string, string>();
  for (const value of values) {
    const normalized = value.normalize("NFKC").trim();
    const key = publicEntityIdentityKey(normalized);
    if (key && !names.has(key)) names.set(key, normalized);
  }
  return [...names.values()];
}

export function planFirstTimePublicEntityEnrichment(
  type: Exclude<IngestionEntityProfileType, "actor">,
  rows: ActorMetadataIdentity[],
  previouslyFetchedNames: string[]
): FirstTimeActorPlan {
  const fetchedKeys = new Set(previouslyFetchedNames.map(publicEntityIdentityKey).filter(Boolean));
  const plannedKeys = new Set<string>();
  const candidates: FirstTimeActorCandidate[] = [];
  let skipped = 0;

  for (const row of rows) {
    const source = row.source.normalize("NFKC").trim();
    if (!source) continue;
    const searchNames = uniquePublicEntityNames([source, row.translated]);
    const identityKeys = searchNames.map(publicEntityIdentityKey).filter(Boolean);
    if (identityKeys.some((key) => fetchedKeys.has(key) || plannedKeys.has(key))) {
      skipped += 1;
      continue;
    }
    for (const key of identityKeys) plannedKeys.add(key);
    candidates.push({
      value: source,
      displayName: row.translated.normalize("NFKC").trim() || source,
      searchNames
    });
  }
  return { candidates, skipped };
}

function actorRowsForCodes(codes: string[]): ActorMetadataIdentity[] {
  if (codes.length === 0) return [];
  const values = codes.map(() => "(?)").join(", ");
  return db.prepare(`
    WITH requested(code) AS (VALUES ${values})
    SELECT DISTINCT TRIM(CAST(source.value AS TEXT)) AS source,
      TRIM(COALESCE(CAST(translated.value AS TEXT), '')) AS translated
    FROM requested
    JOIN media_metadata metadata ON metadata.normalized_code = requested.code
    JOIN json_each(metadata.actors_json) source
    LEFT JOIN json_each(metadata.actors_zh_json) translated ON translated.key = source.key
    WHERE metadata.status = 'ready' AND TRIM(CAST(source.value AS TEXT)) != ''
    ORDER BY source
  `).all(...codes) as ActorMetadataIdentity[];
}

function publicEntityRowsForCodes(
  type: Exclude<IngestionEntityProfileType, "actor">,
  codes: string[]
): ActorMetadataIdentity[] {
  if (codes.length === 0) return [];
  const columns = {
    director: { source: "director", translated: "director_zh" },
    maker: { source: "maker", translated: "maker_zh" },
    label: { source: "label", translated: "label_zh" }
  } as const;
  const column = columns[type];
  const values = codes.map(() => "(?)").join(", ");
  return db.prepare(`
    WITH requested(code) AS (VALUES ${values})
    SELECT DISTINCT TRIM(metadata.${column.source}) AS source,
      TRIM(COALESCE(metadata.${column.translated}, '')) AS translated
    FROM requested
    JOIN media_metadata metadata ON metadata.normalized_code = requested.code
    WHERE metadata.status = 'ready' AND TRIM(metadata.${column.source}) != ''
    ORDER BY source
  `).all(...codes) as ActorMetadataIdentity[];
}

function previouslyFetchedActorNames(): string[] {
  const profiles = db.prepare(`
    SELECT facet_value AS value, aliases_json AS aliasesJson
    FROM entity_profiles WHERE facet_type = 'actor'
  `).all() as Array<{ value: string; aliasesJson: string }>;
  const attempts = db.prepare(`
    SELECT facet_value AS value
    FROM entity_profile_enrichment
    WHERE facet_type = 'actor' AND (
      attempt_count > 0 OR last_attempt_at IS NOT NULL OR status IN ('pending', 'running')
    )
  `).all() as Array<{ value: string }>;
  return [
    ...profiles.flatMap((row) => {
      let aliases: string[] = [];
      try {
        const parsed = JSON.parse(row.aliasesJson) as unknown;
        if (Array.isArray(parsed)) aliases = parsed.filter((value): value is string => typeof value === "string");
      } catch {
        aliases = [];
      }
      return [row.value, ...aliases];
    }),
    ...attempts.map((row) => row.value)
  ];
}

function parseStoredNames(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string");
    }
    if (parsed && typeof parsed === "object") {
      return Object.values(parsed).filter((item): item is string => typeof item === "string");
    }
  } catch {
    // Malformed historical aliases must not block first-time enrichment for other entities.
  }
  return [];
}

function previouslyFetchedPublicEntityNames(
  type: Exclude<IngestionEntityProfileType, "actor">
): string[] {
  const profiles = db.prepare(`
    SELECT facet_value AS value, display_name AS displayName,
      names_json AS namesJson, aliases_json AS aliasesJson
    FROM entity_profiles WHERE facet_type = ?
  `).all(type) as Array<{
    value: string;
    displayName: string;
    namesJson: string;
    aliasesJson: string;
  }>;
  const attempts = db.prepare(`
    SELECT facet_value AS value, display_name AS displayName,
      search_names_json AS searchNamesJson
    FROM entity_profile_enrichment
    WHERE facet_type = ? AND (
      attempt_count > 0 OR last_attempt_at IS NOT NULL OR status IN ('pending', 'running')
    )
  `).all(type) as Array<{ value: string; displayName: string; searchNamesJson: string }>;
  return [
    ...profiles.flatMap((row) => [
      row.value,
      row.displayName,
      ...parseStoredNames(row.namesJson),
      ...parseStoredNames(row.aliasesJson)
    ]),
    ...attempts.flatMap((row) => [row.value, row.displayName, ...parseStoredNames(row.searchNamesJson)])
  ];
}

function scheduleFirstTimeEntityTypeForCodes(
  type: IngestionEntityProfileType,
  codes: string[]
): EntityProfileQueueStats {
  const uniqueCodes = [...new Set(codes.filter(Boolean))];
  const plan = type === "actor"
    ? planFirstTimeActorEnrichment(actorRowsForCodes(uniqueCodes), previouslyFetchedActorNames())
    : planFirstTimePublicEntityEnrichment(
      type,
      publicEntityRowsForCodes(type, uniqueCodes),
      previouslyFetchedPublicEntityNames(type)
    );
  const now = new Date().toISOString();
  const queue = db.prepare(`
    INSERT INTO entity_profile_enrichment (
      facet_type, facet_value, display_name, status, attempt_count,
      matched_external_id, confidence, last_error_code, last_error,
      decision_method, decision_reason, last_attempt_at, next_retry_at,
      updated_at, search_names_json
    ) VALUES (
      @type, @value, @displayName, 'pending', 0,
      '', 0, '', '', '', '', NULL, NULL, @now, @searchNamesJson
    )
    ON CONFLICT(facet_type, facet_value) DO NOTHING
  `);
  let queued = 0;
  db.transaction(() => {
    for (const candidate of plan.candidates) {
      queued += queue.run({
        type,
        value: candidate.value,
        displayName: candidate.displayName,
        searchNamesJson: JSON.stringify(candidate.searchNames),
        now
      }).changes > 0 ? 1 : 0;
    }
  })();
  return {
    discovered: plan.candidates.length + plan.skipped,
    queued,
    skipped: plan.skipped
  };
}

export function scheduleFirstTimeActorsForCodes(codes: string[]): ActorEnrichmentQueueStats {
  return scheduleFirstTimeEntityTypeForCodes("actor", codes);
}

export function scheduleFirstTimeEntityProfilesForCodes(codes: string[]): EntityProfileQueueStatsByType {
  return Object.fromEntries(INGESTION_ENTITY_PROFILE_TYPES.map((type) => [
    type,
    scheduleFirstTimeEntityTypeForCodes(type, codes)
  ])) as unknown as EntityProfileQueueStatsByType;
}

type PendingEntityEnrichment = {
  type: IngestionEntityProfileType;
  value: string;
  displayName: string;
  searchNamesJson: string;
};

let entityEnrichmentQueueRunning = false;

function claimPendingEntityEnrichments(limit = 120): PendingEntityEnrichment[] {
  return db.transaction(() => {
    const rows = db.prepare(`
      SELECT facet_type AS type, facet_value AS value, display_name AS displayName,
        search_names_json AS searchNamesJson
      FROM entity_profile_enrichment
      WHERE facet_type IN ('actor', 'director', 'maker', 'label')
        AND status = 'pending' AND attempt_count = 0
      ORDER BY updated_at, facet_type, facet_value
      LIMIT ?
    `).all(limit) as PendingEntityEnrichment[];
    const claim = db.prepare(`
      UPDATE entity_profile_enrichment SET status = 'running', updated_at = ?
      WHERE facet_type = ? AND facet_value = ?
        AND status = 'pending' AND attempt_count = 0
    `);
    const now = new Date().toISOString();
    return rows.filter((row) => claim.run(now, row.type, row.value).changes === 1);
  })();
}

export function recoverPendingEntityEnrichments(): number {
  return db.prepare(`
    UPDATE entity_profile_enrichment SET status = 'pending', updated_at = ?
    WHERE facet_type IN ('actor', 'director', 'maker', 'label')
      AND status = 'running' AND attempt_count = 0
  `).run(new Date().toISOString()).changes;
}

export function recoverPendingActorEnrichments(): number {
  return db.prepare(`
    UPDATE entity_profile_enrichment SET status = 'pending', updated_at = ?
    WHERE facet_type = 'actor' AND status = 'running' AND attempt_count = 0
  `).run(new Date().toISOString()).changes;
}

export async function drainPendingEntityEnrichments(): Promise<void> {
  if (entityEnrichmentQueueRunning) return;
  entityEnrichmentQueueRunning = true;
  try {
    for (;;) {
      const candidates = claimPendingEntityEnrichments(entityEnrichmentConcurrency());
      if (candidates.length === 0) return;
      let nextCandidate = 0;
      const workerCount = Math.min(entityEnrichmentConcurrency(), candidates.length);
      await Promise.all(Array.from({ length: workerCount }, async () => {
        while (nextCandidate < candidates.length) {
          const candidate = candidates[nextCandidate];
          nextCandidate += 1;
          let searchNames: string[] = [];
          try {
            const parsed = JSON.parse(candidate.searchNamesJson) as unknown;
            if (Array.isArray(parsed)) {
              searchNames = parsed.filter((value): value is string => typeof value === "string");
            }
          } catch {
            searchNames = [];
          }
          try {
            const names = [...new Set([candidate.value, candidate.displayName, ...searchNames])];
            if (candidate.type === "actor") {
              await enrichActorFromWikimedia(candidate.value, names, true);
            } else {
              await enrichPublicEntityFromWikimedia(
                candidate.type as Exclude<PublicEntityType, "actor" | "series">,
                candidate.value,
                names,
                true
              );
            }
          } catch (error) {
            recordEntityEnrichmentFailure(candidate.type, candidate.value, candidate.displayName, error);
            console.warn(`${candidate.type} profile enrichment failed for ${candidate.displayName}:`, error);
          }
        }
      }));
    }
  } finally {
    entityEnrichmentQueueRunning = false;
  }
}

export async function drainPendingActorEnrichments(): Promise<void> {
  await drainPendingEntityEnrichments();
}

export function scheduleIngestionContentPreviews(mediaIds: string[]): ContentPreviewSchedulingStats {
  const stats: ContentPreviewSchedulingStats = {
    total: 0,
    queued: 0,
    ready: 0,
    deferred: 0
  };
  const readMedia = db.prepare("SELECT * FROM media_files WHERE id = ?");
  for (const mediaId of [...new Set(mediaIds.filter(Boolean))]) {
    const media = readMedia.get(mediaId) as MediaRow | undefined;
    if (!media || media.media_type !== "video") continue;
    stats.total += 1;
    const result = scheduleContentPreview(media, 60);
    stats[result.status] += 1;
  }
  return stats;
}

export async function enrichFirstTimeActorsForCodes(codes: string[]): Promise<ActorEnrichmentStats> {
  const rows = actorRowsForCodes([...new Set(codes.filter(Boolean))]);
  const plan = planFirstTimeActorEnrichment(rows, previouslyFetchedActorNames());
  const stats: ActorEnrichmentStats = {
    discovered: plan.candidates.length + plan.skipped,
    attempted: 0,
    skipped: plan.skipped,
    matched: 0,
    notFound: 0,
    failed: 0
  };
  let nextCandidate = 0;
  const workerCount = Math.min(entityEnrichmentConcurrency(), plan.candidates.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextCandidate < plan.candidates.length) {
      const candidate = plan.candidates[nextCandidate];
      nextCandidate += 1;
      stats.attempted += 1;
      try {
        const result = await enrichActorFromWikimedia(candidate.value, candidate.searchNames, true);
        if (result.matched) stats.matched += 1;
        else stats.notFound += 1;
      } catch (error) {
        stats.failed += 1;
        recordEntityEnrichmentFailure("actor", candidate.value, candidate.displayName, error);
        console.warn(`Actor profile enrichment failed for ${candidate.displayName}:`, error);
      }
    }
  }));
  return stats;
}
