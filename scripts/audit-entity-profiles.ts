import { db } from "../server/src/db.js";
import { getEntityExtendedProfile, getEntityProfileCoverage } from "../server/src/entityProfiles.js";
import { getCanonicalTopicProfileCandidates, getTopicGraphItems } from "../server/src/productRoutes.js";

type CountAudit = { name: string; count: number };
type ProfileIdentityRow = {
  facetType: string;
  facetValue: string;
  aliasesJson: string;
  externalIdsJson: string;
  wikidataId: string;
};

const countAudits: Array<{ name: string; sql: string }> = [
  {
    name: "invalid-profile-json",
    sql: `SELECT COUNT(*) AS count FROM entity_profiles
      WHERE NOT json_valid(names_json) OR NOT json_valid(aliases_json)
        OR NOT json_valid(measurements_json) OR NOT json_valid(occupations_json)
        OR NOT json_valid(social_links_json) OR NOT json_valid(external_ids_json)
        OR NOT json_valid(facts_json)`
  },
  {
    name: "invalid-source-json",
    sql: `SELECT COUNT(*) AS count FROM entity_profile_sources
      WHERE NOT json_valid(fields_json) OR NOT json_valid(payload_json)`
  },
  {
    name: "reliable-profile-without-source",
    sql: `SELECT COUNT(*) AS count FROM entity_profiles profiles
      WHERE profiles.source_status IN ('verified', 'auto-matched', 'auto-resolved')
        AND NOT EXISTS (
          SELECT 1 FROM entity_profile_sources sources
          WHERE sources.facet_type = profiles.facet_type
            AND sources.facet_value = profiles.facet_value
        )`
  },
  {
    name: "orphan-source",
    sql: `SELECT COUNT(*) AS count FROM entity_profile_sources sources
      WHERE NOT EXISTS (
        SELECT 1 FROM entity_profiles profiles
        WHERE profiles.facet_type = sources.facet_type
          AND profiles.facet_value = sources.facet_value
      )`
  },
  {
    name: "failed-enrichment",
    sql: "SELECT COUNT(*) AS count FROM entity_profile_enrichment WHERE status = 'failed'"
  },
  {
    name: "implausible-actor-height",
    sql: `SELECT COUNT(*) AS count FROM entity_profiles
      WHERE facet_type = 'actor' AND height_cm IS NOT NULL
        AND (height_cm < 130 OR height_cm > 210)`
  },
  {
    name: "implausible-actor-measurements",
    sql: `SELECT COUNT(*) AS count FROM entity_profiles
      WHERE facet_type = 'actor' AND (
        (json_extract(measurements_json, '$.bustCm') IS NOT NULL
          AND CAST(json_extract(measurements_json, '$.bustCm') AS REAL) NOT BETWEEN 50 AND 160)
        OR (json_extract(measurements_json, '$.waistCm') IS NOT NULL
          AND CAST(json_extract(measurements_json, '$.waistCm') AS REAL) NOT BETWEEN 40 AND 120)
        OR (json_extract(measurements_json, '$.hipsCm') IS NOT NULL
          AND CAST(json_extract(measurements_json, '$.hipsCm') AS REAL) NOT BETWEEN 50 AND 150)
      )`
  },
  {
    name: "series-image-candidate",
    sql: `SELECT COUNT(*) AS count FROM entity_profile_sources
      WHERE facet_type = 'series'
        AND COALESCE(json_extract(payload_json, '$.profileImageCandidateUrl'), '') != ''`
  },
  {
    name: "series-profile-image-url",
    sql: `SELECT COUNT(*) AS count FROM entity_profiles
      WHERE facet_type = 'series' AND image_url != ''`
  },
  {
    name: "director-product-bridge-image",
    sql: `SELECT COUNT(*) AS count FROM entity_profile_sources
      WHERE facet_type = 'director' AND provider LIKE '%product-bridge%'
        AND COALESCE(json_extract(payload_json, '$.profileImageCandidateUrl'), '') != ''`
  },
  {
    name: "known-wrong-wikidata-id",
    sql: `SELECT COUNT(*) AS count FROM entity_profiles
      WHERE wikidata_id = 'Q6747187' OR external_ids_json LIKE '%Q6747187%'`
  },
  {
    name: "duplicate-source-identity",
    sql: `SELECT COUNT(*) AS count FROM (
      SELECT facet_type, facet_value, provider, source_url, COUNT(*) AS duplicates
      FROM entity_profile_sources
      GROUP BY facet_type, facet_value, provider, source_url
      HAVING duplicates > 1
    )`
  }
];

const uniqueExternalIdKeys = new Set([
  "fanzaActress", "allcinema", "naxModel", "madonnaActress", "attackersActress",
  "sodSakabaProfile", "maxingActress", "bibianActress", "hmvArtist", "avwikidb",
  "imdb", "s1Series", "madonnaSeries", "mkoLaboSeries", "ideapocketSeries"
]);

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function normalizedIdentity(value: string): string {
  return value.normalize("NFKC").replace(/[\s・·._-]+/gu, "").toLocaleLowerCase("ja");
}

function hasJapaneseKanaLetters(value: string): boolean {
  return /[ぁ-ゖァ-ヺ]/u.test(value);
}

function hasStrictChineseName(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(value) && !hasJapaneseKanaLetters(value);
}

const counts: CountAudit[] = countAudits.map(({ name, sql }) => ({
  name,
  count: Number((db.prepare(sql).get() as { count?: number } | undefined)?.count ?? 0)
}));
counts.push({ name: "foreign-key-violation", count: db.prepare("PRAGMA foreign_key_check").all().length });
for (const [type, minWorks] of [
  ["actor", 3], ["director", 3], ["maker", 2], ["label", 2], ["series", 3]
] as const) {
  const coverage = getEntityProfileCoverage(type, getCanonicalTopicProfileCandidates(type, minWorks));
  counts.push({ name: `priority-pending-${type}-min${minWorks}`, count: coverage.pending });
}

const profiles = db.prepare(`
  SELECT facet_type AS facetType, facet_value AS facetValue, aliases_json AS aliasesJson,
    external_ids_json AS externalIdsJson, wikidata_id AS wikidataId
  FROM entity_profiles
`).all() as ProfileIdentityRow[];

const localizedProfileRows = db.prepare(`
  SELECT facet_type AS type, facet_value AS value, display_name AS source, names_json AS namesJson
  FROM entity_profiles
  WHERE facet_type IN ('actor', 'director', 'maker', 'label', 'series')
    AND source_status IN ('verified', 'auto-matched', 'auto-resolved')
`).all() as Array<{ type: string; value: string; source: string; namesJson: string }>;
counts.push({
  name: "localized-display-japanese-kana",
  count: localizedProfileRows.filter(({ type, value }) => {
    const profile = getEntityExtendedProfile(type, value);
    return profile != null && hasJapaneseKanaLetters(profile.displayName);
  }).length
});
counts.push({
  name: "japanese-source-missing-chinese",
  count: localizedProfileRows.filter(({ type, value, source }) => {
    if (!hasJapaneseKanaLetters(source)) return false;
    const profile = getEntityExtendedProfile(type, value);
    const displayName = profile?.displayName ?? "";
    const officialLatinBrand = (type === "maker" || type === "label")
      && /[A-Za-z]/u.test(displayName)
      && !hasJapaneseKanaLetters(displayName);
    return profile == null || (!hasStrictChineseName(displayName) && !officialLatinBrand);
  }).length
});
counts.push({
  name: "topic-display-japanese-kana",
  count: (["actor", "director", "maker", "label", "series"] as const)
    .flatMap((type) => getTopicGraphItems(type))
    .filter((item) => hasJapaneseKanaLetters(item.label)).length
});

const ownersByAlias = new Map<string, Set<string>>();
const ownersByStableId = new Map<string, Set<string>>();
for (const profile of profiles) {
  for (const candidate of [profile.facetValue, ...parseList(profile.aliasesJson)]) {
    const normalized = normalizedIdentity(candidate);
    if (!normalized) continue;
    const key = `${profile.facetType}:${normalized}`;
    const owners = ownersByAlias.get(key) ?? new Set<string>();
    owners.add(profile.facetValue);
    ownersByAlias.set(key, owners);
  }
  const externalIds = parseObject(profile.externalIdsJson);
  const ids: Array<[string, string]> = profile.wikidataId
    ? [["wikidata", profile.wikidataId]] : [];
  for (const [key, rawValue] of Object.entries(externalIds)) {
    if (!uniqueExternalIdKeys.has(key) || typeof rawValue !== "string" || !rawValue.trim()) continue;
    ids.push([key, rawValue.trim()]);
  }
  for (const [key, value] of ids) {
    const identityKey = `${profile.facetType}:${key}:${value}`;
    const owners = ownersByStableId.get(identityKey) ?? new Set<string>();
    owners.add(profile.facetValue);
    ownersByStableId.set(identityKey, owners);
  }
}

const aliasCollisions = [...ownersByAlias.entries()]
  .filter(([, owners]) => owners.size > 1)
  .map(([identity, owners]) => ({ identity, owners: [...owners].sort() }));
const stableIdCollisions = [...ownersByStableId.entries()]
  .filter(([, owners]) => owners.size > 1)
  .map(([identity, owners]) => ({ identity, owners: [...owners].sort() }));

const report = {
  ok: counts.every((item) => item.count === 0) && aliasCollisions.length === 0 && stableIdCollisions.length === 0,
  counts,
  normalizedAliasCollisions: aliasCollisions,
  duplicateStableIds: stableIdCollisions
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("实体资料质量审计");
  for (const item of counts) console.log(`- ${item.name}: ${item.count}`);
  console.log(`- normalized-alias-collision: ${aliasCollisions.length}`);
  for (const collision of aliasCollisions) console.log(`  ${collision.identity} -> ${collision.owners.join(" | ")}`);
  console.log(`- duplicate-stable-id: ${stableIdCollisions.length}`);
  for (const collision of stableIdCollisions) console.log(`  ${collision.identity} -> ${collision.owners.join(" | ")}`);
  console.log(report.ok ? "审计通过" : "审计失败");
}

if (!report.ok) process.exitCode = 1;
