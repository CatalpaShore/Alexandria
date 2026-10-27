import { db } from "./db.js";
import { ACTOR_ALIAS_REGISTRY_SIGNATURE } from "./actorAliases.js";

export type PersistedTopicType = "actor" | "series" | "genre" | "prefix" | "director" | "maker" | "label";

export type PersistedTopicItem = {
  value: string;
  label: string;
  aliases: string[];
  mediaCount: number;
  latestReleaseDate: string | null;
  mediaId: string | null;
};

type TopicStatsRow = {
  value: string;
  label: string;
  aliasesJson: string;
  mediaCount: number;
  latestReleaseDate: string | null;
  mediaId: string | null;
};

function sourceSignature(): string {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM media_files) AS mediaCount,
      COALESCE((SELECT MAX(indexed_at) FROM media_files), '') AS mediaUpdated,
      (SELECT COUNT(*) FROM media_metadata_facets) AS facetCount,
      (SELECT COUNT(*) FROM media_metadata WHERE status = 'ready') AS metadataCount,
      COALESCE((SELECT MAX(updated_at) FROM media_metadata), '') AS metadataUpdated,
      COALESCE((SELECT MAX(updated_at) FROM topic_covers), '') AS coverUpdated,
      (SELECT COUNT(*) FROM entity_profiles) AS profileCount,
      COALESCE((SELECT MAX(updated_at) FROM entity_profiles), '') AS profileUpdated
  `).get() as Record<string, string | number>;
  return [
    "topic-stats-v15-localized-display-labels",
    ACTOR_ALIAS_REGISTRY_SIGNATURE,
    row.mediaCount,
    row.mediaUpdated,
    row.facetCount,
    row.metadataCount,
    row.metadataUpdated,
    row.coverUpdated,
    row.profileCount,
    row.profileUpdated
  ].join(":");
}

function parseAliases(value: string, fallback: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      const aliases = parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
      if (aliases.length > 0) return aliases;
    }
  } catch {
    // A damaged cache row is rebuilt on the next miss.
  }
  return [fallback];
}

export function readTopicStats(type: PersistedTopicType): PersistedTopicItem[] | null {
  const signature = sourceSignature();
  const state = db.prepare(`
    SELECT source_signature AS sourceSignature
    FROM app_cache_state
    WHERE cache_key = ?
  `).get(`topic-stats:${type}`) as { sourceSignature: string } | undefined;
  if (state?.sourceSignature !== signature) return null;

  const rows = db.prepare(`
    SELECT facet_value AS value, display_label AS label, aliases_json AS aliasesJson,
      media_count AS mediaCount, latest_release_date AS latestReleaseDate,
      cover_media_id AS mediaId
    FROM topic_stats
    WHERE facet_type = ?
    ORDER BY media_count DESC, display_label COLLATE NOCASE ASC
  `).all(type) as TopicStatsRow[];
  return rows.map((row) => ({
    value: row.value,
    label: row.label,
    aliases: parseAliases(row.aliasesJson, row.value),
    mediaCount: row.mediaCount,
    latestReleaseDate: row.latestReleaseDate,
    mediaId: row.mediaId
  }));
}

export function writeTopicStats(type: PersistedTopicType, items: PersistedTopicItem[]): void {
  const signature = sourceSignature();
  const updatedAt = new Date().toISOString();
  const replace = db.transaction(() => {
    db.prepare("DELETE FROM topic_stats WHERE facet_type = ?").run(type);
    const insert = db.prepare(`
      INSERT INTO topic_stats (
        facet_type, facet_value, display_label, aliases_json, media_count,
        latest_release_date, cover_media_id, source_signature, updated_at
      ) VALUES (
        @type, @value, @label, @aliasesJson, @mediaCount,
        @latestReleaseDate, @mediaId, @sourceSignature, @updatedAt
      )
    `);
    const seenValues = new Set<string>();
    for (const item of items) {
      if (seenValues.has(item.value)) {
        throw new Error(`duplicate topic stat before persistence: ${type}:${item.value}`);
      }
      seenValues.add(item.value);
      insert.run({
        type,
        value: item.value,
        label: item.label,
        aliasesJson: JSON.stringify(item.aliases),
        mediaCount: item.mediaCount,
        latestReleaseDate: item.latestReleaseDate,
        mediaId: item.mediaId,
        sourceSignature: signature,
        updatedAt
      });
    }
    db.prepare(`
      INSERT INTO app_cache_state (cache_key, source_signature, updated_at)
      VALUES (@cacheKey, @sourceSignature, @updatedAt)
      ON CONFLICT(cache_key) DO UPDATE SET
        source_signature = excluded.source_signature,
        updated_at = excluded.updated_at
    `).run({ cacheKey: `topic-stats:${type}`, sourceSignature: signature, updatedAt });
  });
  replace();
}

export function invalidateTopicStats(type?: PersistedTopicType): void {
  if (type) {
    db.prepare("DELETE FROM app_cache_state WHERE cache_key = ?").run(`topic-stats:${type}`);
    return;
  }
  db.prepare("DELETE FROM app_cache_state WHERE cache_key LIKE 'topic-stats:%'").run();
}

export function getTopicStatsStatus(): {
  typesReady: number;
  rows: number;
  sourceSignature: string;
} {
  const ready = db.prepare(`
    SELECT COUNT(*) AS typesReady
    FROM app_cache_state
    WHERE cache_key LIKE 'topic-stats:%' AND source_signature = ?
  `).get(sourceSignature()) as { typesReady: number };
  const rows = db.prepare("SELECT COUNT(*) AS rows FROM topic_stats").get() as { rows: number };
  return { typesReady: ready.typesReady, rows: rows.rows, sourceSignature: sourceSignature() };
}
