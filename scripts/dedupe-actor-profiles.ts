import { db } from "../server/src/db.js";

type ProfileRow = {
  value: string;
  displayName: string;
  namesJson: string;
  aliasesJson: string;
  biography: string;
  birthDate: string | null;
  birthplace: string;
  nationality: string;
  heightCm: number | null;
  measurementsJson: string;
  factsJson: string;
  occupationsJson: string;
  imageUrl: string;
  officialWebsite: string;
  socialLinksJson: string;
  externalIdsJson: string;
  wikidataId: string;
  wikipediaUrl: string;
  sourceStatus: string;
  confidence: number;
  fetchedAt: string | null;
  updatedAt: string;
  officialSourceCount: number;
  mediaCount: number;
};

type Measurements = { bustCm?: number; waistCm?: number; hipsCm?: number; cup?: string };

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function identityKey(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("ja")
    .replace(/[\s\u3000・·_\-()（）]+/gu, "");
}

function aliases(row: ProfileRow): string[] {
  return [...new Set([row.value, row.displayName, ...Object.values(parseJson<Record<string, string>>(row.namesJson, {})),
    ...parseJson<string[]>(row.aliasesJson, [])].map((value) => value.trim()).filter(Boolean))];
}

function stablePerformerIds(row: ProfileRow): string[] {
  const ids = parseJson<Record<string, unknown>>(row.externalIdsJson, {});
  return [...new Set([
    typeof ids["r18dev-actress"] === "string" ? ids["r18dev-actress"] : "",
    typeof ids.P9781 === "string" ? ids.P9781 : ""
  ].map((value) => value.trim()).filter((value) => /^\d+$/u.test(value)))];
}

function matchEvidence(left: ProfileRow, right: ProfileRow): string[] | null {
  const sharedNames = aliases(left).map(identityKey).filter((value) => value.length >= 2)
    .filter((value) => aliases(right).map(identityKey).includes(value));
  if (!sharedNames.length) return null;
  const sharedPerformerId = stablePerformerIds(left).find((id) => stablePerformerIds(right).includes(id));
  if (sharedPerformerId) return [`R18/DMM 演员 ID ${sharedPerformerId}`, "共享姓名"];
  if (left.wikidataId && right.wikidataId) {
    return left.wikidataId === right.wikidataId ? [`Wikidata ${left.wikidataId}`, "共享姓名"] : null;
  }
  const evidence: string[] = [];
  const conflict = (label: string, a: string | number | null | undefined, b: string | number | null | undefined): boolean => {
    if (a == null || a === "" || b == null || b === "") return false;
    if (a !== b) return true;
    evidence.push(label);
    return false;
  };
  if (conflict("出生日期", left.birthDate, right.birthDate)) return null;
  if (conflict("身高", left.heightCm, right.heightCm)) return null;
  const leftMeasurements = parseJson<Measurements>(left.measurementsJson, {});
  const rightMeasurements = parseJson<Measurements>(right.measurementsJson, {});
  for (const [key, label] of [["bustCm", "胸围"], ["waistCm", "腰围"], ["hipsCm", "臀围"], ["cup", "罩杯"]] as const) {
    if (conflict(label, leftMeasurements[key], rightMeasurements[key])) return null;
  }
  return evidence.includes("出生日期") && evidence.length >= 4 ? [...evidence, "共享姓名"] : null;
}

function canonicalOrder(left: ProfileRow, right: ProfileRow): [ProfileRow, ProfileRow] {
  const score = (row: ProfileRow): number => row.officialSourceCount * 1_000_000
    + (/[^\p{Script=Latin}\p{Number}\p{Punctuation}\p{Separator}]/u.test(row.value) ? 100_000 : 0)
    + row.mediaCount * 100 + Math.round(row.confidence * 10);
  return score(left) >= score(right) ? [left, right] : [right, left];
}

function mergeObjects(preferredJson: string, fallbackJson: string): string {
  return JSON.stringify({ ...parseJson<Record<string, unknown>>(fallbackJson, {}),
    ...parseJson<Record<string, unknown>>(preferredJson, {}) });
}

function mergeProfiles(canonical: ProfileRow, duplicate: ProfileRow): void {
  const now = new Date().toISOString();
  const canonicalAliases = [...new Set([...aliases(canonical), ...aliases(duplicate)])];
  const occupations = [...new Set([...parseJson<string[]>(canonical.occupationsJson, []),
    ...parseJson<string[]>(duplicate.occupationsJson, [])])];
  const preferredBiography = canonical.biography.length >= duplicate.biography.length
    ? canonical.biography : duplicate.biography;
  db.transaction(() => {
    db.prepare(`
      UPDATE entity_profiles SET display_name = @displayName, names_json = @namesJson,
        aliases_json = @aliasesJson, biography = @biography, birth_date = @birthDate,
        birthplace = @birthplace, nationality = @nationality, height_cm = @heightCm,
        measurements_json = @measurementsJson, facts_json = @factsJson,
        occupations_json = @occupationsJson, image_url = @imageUrl,
        official_website = @officialWebsite, social_links_json = @socialLinksJson,
        external_ids_json = @externalIdsJson, wikidata_id = @wikidataId,
        wikipedia_url = @wikipediaUrl, source_status = @sourceStatus,
        confidence = @confidence, fetched_at = @fetchedAt, updated_at = @updatedAt
      WHERE facet_type = 'actor' AND facet_value = @value
    `).run({
      value: canonical.value,
      displayName: canonical.displayName || duplicate.displayName,
      namesJson: mergeObjects(canonical.namesJson, duplicate.namesJson),
      aliasesJson: JSON.stringify(canonicalAliases),
      biography: preferredBiography,
      birthDate: canonical.birthDate ?? duplicate.birthDate,
      birthplace: canonical.birthplace || duplicate.birthplace,
      nationality: canonical.nationality || duplicate.nationality,
      heightCm: canonical.heightCm ?? duplicate.heightCm,
      measurementsJson: mergeObjects(canonical.measurementsJson, duplicate.measurementsJson),
      factsJson: mergeObjects(canonical.factsJson, duplicate.factsJson),
      occupationsJson: JSON.stringify(occupations),
      imageUrl: canonical.imageUrl || duplicate.imageUrl,
      officialWebsite: canonical.officialWebsite || duplicate.officialWebsite,
      socialLinksJson: mergeObjects(canonical.socialLinksJson, duplicate.socialLinksJson),
      externalIdsJson: mergeObjects(canonical.externalIdsJson, duplicate.externalIdsJson),
      wikidataId: canonical.wikidataId || duplicate.wikidataId,
      wikipediaUrl: canonical.wikipediaUrl || duplicate.wikipediaUrl,
      sourceStatus: canonical.sourceStatus === "verified" || duplicate.sourceStatus === "verified" ? "verified"
        : canonical.sourceStatus === "auto-resolved" || duplicate.sourceStatus === "auto-resolved" ? "auto-resolved" : "auto-matched",
      confidence: Math.max(canonical.confidence, duplicate.confidence),
      fetchedAt: [canonical.fetchedAt, duplicate.fetchedAt].filter(Boolean).sort().at(-1) ?? null,
      updatedAt: now
    });
    db.prepare(`
      INSERT INTO entity_profile_sources (
        id, facet_type, facet_value, provider, source_title, source_url, license, language,
        fields_json, payload_json, confidence, retrieved_at
      ) SELECT lower(hex(randomblob(16))), facet_type, @canonical, provider, source_title, source_url,
        license, language, fields_json, payload_json, confidence, retrieved_at
      FROM entity_profile_sources WHERE facet_type = 'actor' AND facet_value = @duplicate
      ON CONFLICT(facet_type, facet_value, provider, source_url) DO UPDATE SET
        source_title = excluded.source_title, fields_json = excluded.fields_json,
        payload_json = excluded.payload_json,
        confidence = MAX(entity_profile_sources.confidence, excluded.confidence),
        retrieved_at = MAX(entity_profile_sources.retrieved_at, excluded.retrieved_at)
    `).run({ canonical: canonical.value, duplicate: duplicate.value });
    db.prepare(`
      UPDATE entity_profile_enrichment SET attempt_count = attempt_count + COALESCE((
        SELECT attempt_count FROM entity_profile_enrichment WHERE facet_type = 'actor' AND facet_value = @duplicate
      ), 0), confidence = MAX(confidence, COALESCE((
        SELECT confidence FROM entity_profile_enrichment WHERE facet_type = 'actor' AND facet_value = @duplicate
      ), 0)), updated_at = @now
      WHERE facet_type = 'actor' AND facet_value = @canonical
    `).run({ canonical: canonical.value, duplicate: duplicate.value, now });
    db.prepare("DELETE FROM entity_profile_enrichment WHERE facet_type = 'actor' AND facet_value = ?").run(duplicate.value);
    db.prepare(`
      INSERT INTO entity_favorites (facet_type, facet_value, label, created_at)
      SELECT 'actor', @canonical, label, created_at FROM entity_favorites
      WHERE facet_type = 'actor' AND facet_value = @duplicate
      ON CONFLICT(facet_type, facet_value) DO NOTHING
    `).run({ canonical: canonical.value, duplicate: duplicate.value });
    db.prepare("DELETE FROM entity_favorites WHERE facet_type = 'actor' AND facet_value = ?").run(duplicate.value);
    db.prepare(`
      INSERT INTO topic_covers (facet_type, facet_value, media_id, updated_at)
      SELECT 'actor', @canonical, media_id, updated_at FROM topic_covers
      WHERE facet_type = 'actor' AND facet_value = @duplicate
      ON CONFLICT(facet_type, facet_value) DO NOTHING
    `).run({ canonical: canonical.value, duplicate: duplicate.value });
    db.prepare("DELETE FROM topic_covers WHERE facet_type = 'actor' AND facet_value = ?").run(duplicate.value);
    db.prepare("DELETE FROM actor_portraits WHERE actor_key = ?").run(duplicate.value);
    db.prepare("DELETE FROM entity_profiles WHERE facet_type = 'actor' AND facet_value = ?").run(duplicate.value);
  })();
}

const execute = process.argv.includes("--execute");
const rows = db.prepare(`
  SELECT profiles.facet_value AS value, profiles.display_name AS displayName,
    profiles.names_json AS namesJson, profiles.aliases_json AS aliasesJson,
    profiles.biography, profiles.birth_date AS birthDate, profiles.birthplace,
    profiles.nationality, profiles.height_cm AS heightCm,
    profiles.measurements_json AS measurementsJson, profiles.facts_json AS factsJson,
    profiles.occupations_json AS occupationsJson, profiles.image_url AS imageUrl,
    profiles.official_website AS officialWebsite, profiles.social_links_json AS socialLinksJson,
    profiles.external_ids_json AS externalIdsJson, profiles.wikidata_id AS wikidataId,
    profiles.wikipedia_url AS wikipediaUrl, profiles.source_status AS sourceStatus,
    profiles.confidence, profiles.fetched_at AS fetchedAt, profiles.updated_at AS updatedAt,
    (SELECT COUNT(*) FROM entity_profile_sources sources WHERE sources.facet_type = 'actor'
      AND sources.facet_value = profiles.facet_value AND sources.provider LIKE 'official-%') AS officialSourceCount,
    (SELECT COUNT(DISTINCT normalized_code) FROM media_metadata_facets facets WHERE facets.facet_type = 'actor'
      AND facets.facet_value = profiles.facet_value) AS mediaCount
  FROM entity_profiles profiles
  WHERE profiles.facet_type = 'actor' AND profiles.source_status NOT IN ('unverified', 'not-found', 'failed')
`).all() as ProfileRow[];

const candidates: Array<{ canonical: ProfileRow; duplicate: ProfileRow; evidence: string[] }> = [];
for (let leftIndex = 0; leftIndex < rows.length; leftIndex += 1) {
  for (let rightIndex = leftIndex + 1; rightIndex < rows.length; rightIndex += 1) {
    const evidence = matchEvidence(rows[leftIndex], rows[rightIndex]);
    if (!evidence) continue;
    const [canonical, duplicate] = canonicalOrder(rows[leftIndex], rows[rightIndex]);
    candidates.push({ canonical, duplicate, evidence });
  }
}

const consumed = new Set<string>();
let merged = 0;
for (const candidate of candidates) {
  if (consumed.has(candidate.canonical.value) || consumed.has(candidate.duplicate.value)) continue;
  console.log(`${candidate.duplicate.value} -> ${candidate.canonical.value}：${candidate.evidence.join("、")}`);
  if (execute) mergeProfiles(candidate.canonical, candidate.duplicate);
  consumed.add(candidate.duplicate.value);
  merged += 1;
}
console.log(`${execute ? "已执行" : "只读预览"}：识别 ${merged} 组高置信重复演员档案`);
