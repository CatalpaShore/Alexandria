import { db } from "./db.js";
import { getLocalizedActorDisplayName } from "./actorAliases.js";
import { getEntityExtendedProfile, type PublicEntityType } from "./entityProfiles.js";

export const ENTITY_INSIGHT_TYPES = ["actor", "genre", "series", "maker", "label", "director", "prefix"] as const;
export type EntityInsightType = typeof ENTITY_INSIGHT_TYPES[number];

export type EntityInsightRelation = { value: string; mediaCount: number };

export type EntityInsights = {
  mediaCount: number;
  firstReleaseDate: string | null;
  latestReleaseDate: string | null;
  releaseYearCount: number;
  totalRuntimeMinutes: number;
  averageRuntimeMinutes: number | null;
  averageScore: number | null;
  scoredMediaCount: number;
  yearDistribution: Array<{ year: string; mediaCount: number }>;
  related: Record<Exclude<EntityInsightType, "prefix">, EntityInsightRelation[]>;
};

const emptyRelated = (): EntityInsights["related"] => ({
  actor: [], genre: [], series: [], maker: [], label: [], director: []
});

function canonicalTopicAliases(): Map<string, string> {
  const rows = db.prepare(`
    SELECT facet_type AS type, facet_value AS value, aliases_json AS aliasesJson
    FROM topic_stats
    WHERE facet_type IN ('actor', 'genre', 'series', 'maker', 'label', 'director')
  `).all() as Array<{ type: string; value: string; aliasesJson: string }>;
  const result = new Map<string, string>();
  for (const row of rows) {
    let aliases: string[] = [];
    try {
      const parsed = JSON.parse(row.aliasesJson) as unknown;
      if (Array.isArray(parsed)) aliases = parsed.map(String).filter(Boolean);
    } catch {
      // A damaged topic cache falls back to its canonical value.
    }
    for (const alias of [row.value, ...aliases]) result.set(`${row.type}:${alias}`, row.value);
  }
  const profiles = db.prepare(`
    SELECT facet_type AS type, facet_value AS value, aliases_json AS aliasesJson
    FROM entity_profiles
    WHERE facet_type IN ('actor', 'genre', 'series', 'maker', 'label', 'director')
      AND source_status != 'unverified'
  `).all() as Array<{ type: string; value: string; aliasesJson: string }>;
  for (const row of profiles) {
    let aliases: string[] = [];
    try {
      const parsed = JSON.parse(row.aliasesJson) as unknown;
      if (Array.isArray(parsed)) aliases = parsed.map(String).filter(Boolean);
    } catch {
      // Keep the profile canonical even if an old alias payload is damaged.
    }
    for (const alias of [row.value, ...aliases]) result.set(`${row.type}:${alias}`, row.value);
  }
  return result;
}

export function resolveEntityInsightAliases(type: EntityInsightType, value: string): string[] {
  const aliases = new Set([value.trim()].filter(Boolean));
  if (type === "prefix") return [...aliases];
  if (type === "actor" || type === "genre") {
    const sourceColumn = type === "actor" ? "actors_json" : "genres_json";
    const translatedColumn = type === "actor" ? "actors_zh_json" : "genres_zh_json";
    const rows = db.prepare(`
      SELECT DISTINCT TRIM(CAST(source.value AS TEXT)) AS source,
        TRIM(CAST(translated.value AS TEXT)) AS translated
      FROM media_metadata metadata
      JOIN json_each(metadata.${sourceColumn}) source
      LEFT JOIN json_each(metadata.${translatedColumn}) translated ON translated.key = source.key
      WHERE TRIM(CAST(source.value AS TEXT)) = @value
        OR TRIM(CAST(translated.value AS TEXT)) = @value
    `).all({ value }) as Array<{ source: string; translated: string }>;
    for (const row of rows) {
      if (row.source) aliases.add(row.source);
      if (row.translated) aliases.add(row.translated);
    }
    return [...aliases];
  }
  const columns = {
    series: ["series", "series_zh"], maker: ["maker", "maker_zh"],
    label: ["label", "label_zh"], director: ["director", "director_zh"]
  } as const;
  const [sourceColumn, translatedColumn] = columns[type];
  const rows = db.prepare(`
    SELECT DISTINCT TRIM(${sourceColumn}) AS source, TRIM(${translatedColumn}) AS translated
    FROM media_metadata
    WHERE TRIM(${sourceColumn}) = @value OR TRIM(${translatedColumn}) = @value
  `).all({ value }) as Array<{ source: string; translated: string }>;
  for (const row of rows) {
    if (row.source) aliases.add(row.source);
    if (row.translated) aliases.add(row.translated);
  }
  return [...aliases];
}

export function getEntityInsightDisplayName(type: EntityInsightType, value: string): string {
  if (["actor", "director", "maker", "label", "series"].includes(type)) {
    for (const alias of resolveEntityInsightAliases(type, value)) {
      const profile = getEntityExtendedProfile(type as PublicEntityType, alias);
      if (profile && profile.status !== "unverified" && profile.confidence >= 0.82 && profile.displayName.trim()) {
        return profile.displayName.trim();
      }
    }
  }
  if (type === "actor") {
    const row = db.prepare(`
      SELECT TRIM(CAST(source.value AS TEXT)) AS source,
        TRIM(CAST(translated.value AS TEXT)) AS translated, COUNT(*) AS frequency
      FROM media_metadata metadata
      JOIN json_each(metadata.actors_json) source
      LEFT JOIN json_each(metadata.actors_zh_json) translated ON translated.key = source.key
      WHERE TRIM(CAST(source.value AS TEXT)) = @value
        OR TRIM(CAST(translated.value AS TEXT)) = @value
      GROUP BY source, translated ORDER BY frequency DESC LIMIT 1
    `).get({ value }) as { source: string; translated: string } | undefined;
    return row ? getLocalizedActorDisplayName(row.source, row.translated) : getLocalizedActorDisplayName(value);
  }
  const aliases = resolveEntityInsightAliases(type, value);
  return aliases.at(-1) || value;
}

export function getEntityInsights(type: EntityInsightType, value: string, suppliedAliases?: string[]): EntityInsights {
  const aliases = suppliedAliases?.length ? [...new Set(suppliedAliases)] : resolveEntityInsightAliases(type, value);
  const codes = (type === "prefix"
    ? db.prepare(`
        SELECT DISTINCT normalized_code AS normalizedCode FROM media_files
        WHERE media_type = 'video' AND code_prefix = @value AND normalized_code != ''
      `).all({ value })
    : db.prepare(`
        SELECT DISTINCT facets.normalized_code AS normalizedCode
        FROM media_metadata_facets facets
        JOIN media_files ON media_files.normalized_code = facets.normalized_code
          AND media_files.media_type = 'video'
        WHERE facets.facet_type = @type
          AND facets.facet_value IN (SELECT CAST(value AS TEXT) FROM json_each(@aliasesJson))
      `).all({ type, aliasesJson: JSON.stringify(aliases) })) as Array<{ normalizedCode: string }>;
  const codeValues = codes.map((row) => row.normalizedCode).filter(Boolean);
  if (!codeValues.length) return {
    mediaCount: 0, firstReleaseDate: null, latestReleaseDate: null, releaseYearCount: 0,
    totalRuntimeMinutes: 0, averageRuntimeMinutes: null, averageScore: null, scoredMediaCount: 0,
    yearDistribution: [], related: emptyRelated()
  };
  const codesJson = JSON.stringify(codeValues);
  const stats = db.prepare(`
    SELECT MIN(NULLIF(release_date, '')) AS firstReleaseDate,
      MAX(NULLIF(release_date, '')) AS latestReleaseDate,
      COUNT(DISTINCT CASE WHEN release_date GLOB '[0-9][0-9][0-9][0-9]-*' THEN SUBSTR(release_date, 1, 4) END) AS releaseYearCount,
      COALESCE(SUM(CASE WHEN runtime_minutes > 0 THEN runtime_minutes ELSE 0 END), 0) AS totalRuntimeMinutes,
      AVG(CASE WHEN runtime_minutes > 0 THEN runtime_minutes END) AS averageRuntimeMinutes,
      AVG(CASE WHEN score > 0 THEN score END) AS averageScore,
      COUNT(CASE WHEN score > 0 THEN 1 END) AS scoredMediaCount
    FROM media_metadata
    WHERE normalized_code IN (SELECT CAST(value AS TEXT) FROM json_each(@codesJson))
  `).get({ codesJson }) as Record<string, unknown>;
  const yearDistribution = db.prepare(`
    SELECT SUBSTR(release_date, 1, 4) AS year, COUNT(*) AS mediaCount
    FROM media_metadata
    WHERE normalized_code IN (SELECT CAST(value AS TEXT) FROM json_each(@codesJson))
      AND release_date GLOB '[0-9][0-9][0-9][0-9]-*'
    GROUP BY year ORDER BY year DESC LIMIT 12
  `).all({ codesJson }) as Array<{ year: string; mediaCount: number }>;
  const relationRows = db.prepare(`
    SELECT facet_type AS type, facet_value AS value, normalized_code AS normalizedCode
    FROM media_metadata_facets
    WHERE normalized_code IN (SELECT CAST(value AS TEXT) FROM json_each(@codesJson))
      AND facet_type IN ('actor', 'genre', 'series', 'maker', 'label', 'director')
      AND NOT (facet_type = @type AND facet_value IN (SELECT CAST(value AS TEXT) FROM json_each(@aliasesJson)))
  `).all({ codesJson, type, aliasesJson: JSON.stringify(aliases) }) as Array<{
    type: Exclude<EntityInsightType, "prefix">;
    value: string;
    normalizedCode: string;
  }>;
  const related = emptyRelated();
  const canonicalAliases = canonicalTopicAliases();
  const relationGroups = new Map<string, { type: Exclude<EntityInsightType, "prefix">; value: string; media: Set<string> }>();
  for (const row of relationRows) {
    const canonicalValue = canonicalAliases.get(`${row.type}:${row.value}`) ?? row.value;
    const key = `${row.type}:${canonicalValue}`;
    const group = relationGroups.get(key) ?? { type: row.type, value: canonicalValue, media: new Set<string>() };
    group.media.add(row.normalizedCode);
    relationGroups.set(key, group);
  }
  for (const group of [...relationGroups.values()].sort((left, right) =>
    right.media.size - left.media.size || left.value.localeCompare(right.value, "ja"))) {
    if (related[group.type].length < 8) related[group.type].push({ value: group.value, mediaCount: group.media.size });
  }
  const rounded = (input: unknown, digits = 0): number | null => {
    if (input == null || input === "") return null;
    const number = Number(input);
    if (!Number.isFinite(number)) return null;
    const scale = 10 ** digits;
    return Math.round(number * scale) / scale;
  };
  return {
    mediaCount: codeValues.length,
    firstReleaseDate: stats.firstReleaseDate ? String(stats.firstReleaseDate) : null,
    latestReleaseDate: stats.latestReleaseDate ? String(stats.latestReleaseDate) : null,
    releaseYearCount: Number(stats.releaseYearCount ?? 0),
    totalRuntimeMinutes: rounded(stats.totalRuntimeMinutes) ?? 0,
    averageRuntimeMinutes: rounded(stats.averageRuntimeMinutes),
    averageScore: rounded(stats.averageScore, 1),
    scoredMediaCount: Number(stats.scoredMediaCount ?? 0),
    yearDistribution: yearDistribution.reverse(),
    related
  };
}
