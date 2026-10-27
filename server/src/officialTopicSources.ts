import crypto from "node:crypto";
import {readOptionalSourceRegistry} from "./optionalSourceRegistry.js";
import { db } from "./db.js";
import { recordEntityEnrichmentFailure, type EntityExtendedProfile, type EntityProfileSource, type PublicEntityType } from "./entityProfiles.js";

export type OfficialTopicSourceDefinition = {
  type: Extract<PublicEntityType, "actor" | "director" | "maker" | "label" | "series">;
  value: string;
  canonicalValue?: string;
  displayName?: string;
  aliases: string[];
  removeAliases?: string[];
  provider: string;
  sourceUrl: string;
  expectedNames: string[];
  requiredTerms?: string[];
  requiredSourceUrlTerms?: string[];
  identityCodes?: string[];
  preferSummaryFallback?: boolean;
  summaryFallback: string;
  facts?: Record<string, string | string[]>;
  birthDate?: string;
  preferOfficialBirthDate?: boolean;
  heightCm?: number;
  preferOfficialHeight?: boolean;
  measurements?: EntityExtendedProfile["measurements"];
  names?: Record<string, string>;
  confidence?: number;
  officialWebsite?: boolean;
  externalIds?: Record<string, string>;
  wikidataId?: string;
  wikipediaUrl?: string;
  entityKind?: "human" | "organization" | "creative-work";
  occupations?: string[];
  nationality?: string;
  suppressImage?: boolean;
  clearWikimediaIdentity?: boolean;
  removeFacts?: string[];
  clearBirthDate?: boolean;
  preserveExistingBiography?: boolean;
  preferOfficialNames?: boolean;
};

export type OfficialTopicFacts = {
  title: string;
  description: string;
  imageUrl: string;
};

export type OfficialTopicEnrichmentPreview = {
  definition: OfficialTopicSourceDefinition;
  matched: boolean;
  reason?: string;
  profile?: Omit<EntityExtendedProfile, "type" | "value" | "sources" | "updatedAt">;
  source?: EntityProfileSource;
};

export function resolveOfficialTopicBirthDate(
  existingBirthDate: string | null,
  existingStatus: string,
  officialBirthDate: string | null,
  preferOfficialBirthDate = false
): string | null {
  if (existingStatus === "verified" && existingBirthDate) return existingBirthDate;
  if (existingStatus === "auto-resolved" && existingBirthDate && !preferOfficialBirthDate) return existingBirthDate;
  return officialBirthDate || existingBirthDate;
}

export function resolveOfficialTopicHeight(
  existingHeightCm: number | null,
  existingStatus: string,
  officialHeightCm: number | null,
  preferOfficialHeight = false
): number | null {
  if (officialHeightCm == null) return existingHeightCm;
  if (preferOfficialHeight && existingStatus !== "verified") return officialHeightCm;
  return existingHeightCm ?? officialHeightCm;
}

export function mergeOfficialTopicMeasurements(
  existing: EntityExtendedProfile["measurements"],
  supplemental: EntityExtendedProfile["measurements"]
): EntityExtendedProfile["measurements"] {
  // Existing curated values win field by field; a supplemental source may only
  // fill gaps. This matters for partially populated profiles such as W/H/cup.
  return { ...supplemental, ...existing };
}

export function assertOfficialTopicCasMatches(currentUpdatedAt: string | null, expectedUpdatedAt?: string): void {
  if (expectedUpdatedAt && currentUpdatedAt !== expectedUpdatedAt) {
    throw new Error(`Official topic CAS mismatch: expected ${expectedUpdatedAt}, received ${currentUpdatedAt ?? "missing"}`);
  }
}

// No catalog or personal library data is bundled. Supply definitions explicitly.
export const OFFICIAL_TOPIC_SOURCES: readonly OfficialTopicSourceDefinition[] = readOptionalSourceRegistry<OfficialTopicSourceDefinition>("official-topic-sources.json");

function decodeHtml(value: string): string {
  return value.replace(/&amp;/giu, "&").replace(/&quot;|&#34;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'").replace(/&lt;/giu, "<").replace(/&gt;/giu, ">")
    .replace(/&nbsp;|&#160;/giu, " ").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
}

function normalize(value: string): string {
  return decodeHtml(value).normalize("NFKC").toLocaleLowerCase("ja").replace(/[\s\-_.・·()（）【】「」『』]+/gu, "");
}

function attribute(tag: string, name: string): string {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "iu"));
  return match?.[1] ? decodeHtml(match[1]) : "";
}

function metaContent(html: string, keys: string[]): string {
  for (const tag of html.match(/<meta\b[^>]*>/giu) ?? []) {
    const key = attribute(tag, "name") || attribute(tag, "property");
    if (keys.some((candidate) => key.toLocaleLowerCase("en") === candidate)) {
      const content = attribute(tag, "content");
      if (content) return content;
    }
  }
  return "";
}

function safeImageUrl(sourceUrl: string, candidate: string): string {
  if (!candidate) return "";
  try {
    const resolved = new URL(candidate, sourceUrl);
    return resolved.protocol === "https:" ? resolved.toString() : "";
  } catch { return ""; }
}

export function parseOfficialTopicPage(definition: OfficialTopicSourceDefinition, html: string): OfficialTopicFacts | null {
  const title = decodeHtml(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu)?.[1] ?? "");
  const primaryHeading = decodeHtml(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/iu)?.[1] ?? "");
  const pageIdentity = normalize(`${title} ${html.slice(0, 200_000)}`);
  // Official series directories often keep exact catalog codes in product-link
  // attributes rather than visible text. Preserve markup for code-only identity
  // checks while keeping names and role terms constrained to decoded page text.
  const rawCodeIdentity = html.slice(0, 200_000).normalize("NFKC").toLocaleLowerCase("ja")
    .replace(/[\s\-_.・·()（）【】「」『』]+/gu, "");
  const identityScope = definition.provider.startsWith("public-catalog-")
    && definition.provider !== "public-catalog-imdb-title-bridge"
    ? normalize(`${title} ${primaryHeading}`)
    : pageIdentity;
  if (!definition.expectedNames.some((name) => identityScope.includes(normalize(name)))) return null;
  if ((definition.requiredTerms ?? []).some((term) => !pageIdentity.includes(normalize(term)))) return null;
  if ((definition.requiredSourceUrlTerms ?? []).some((term) => !normalize(definition.sourceUrl).includes(normalize(term)))) return null;
  if ((definition.identityCodes ?? []).some((code) => {
    const normalizedCode = normalize(code);
    return !pageIdentity.includes(normalizedCode) && !rawCodeIdentity.includes(normalizedCode);
  })) return null;
  const rawDescription = metaContent(html, ["description", "og:description"]);
  const description = !definition.preferSummaryFallback && rawDescription
    && !/年齢チェックページ/u.test(rawDescription) && !/elementor\s*-\s*v/iu.test(rawDescription)
    ? rawDescription : definition.summaryFallback;
  // Product pages expose the studio/label OG logo, not a portrait of the credited director.
  // Treat those images as identity evidence only so a brand logo can never become a director avatar.
  const suppressProductCreditImage = definition.type === "director"
    && definition.provider.includes("product-bridge");
  const imageCandidate = safeImageUrl(definition.sourceUrl, metaContent(html, ["og:image", "twitter:image"]));
  const suppressGenericDirectorImage = definition.type === "director"
    && /(?:^|[/_-])(?:logo|favicon|icon[_-]?sns|site[_-]?design)(?:[/_.-]|$)/iu.test(new URL(imageCandidate || "https://invalid.local/").pathname);
  // A series page's OG image is normally a product cover or studio logo rather than
  // a stable series identity image. Keep it as textual evidence only.
  const imageUrl = definition.suppressImage || definition.type === "series"
    || suppressProductCreditImage || suppressGenericDirectorImage ? "" : imageCandidate;
  return { title: title || definition.value, description, imageUrl };
}

async function fetchOfficialTopicPage(definition: OfficialTopicSourceDefinition): Promise<string> {
  const response = await fetch(definition.sourceUrl, {
    headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "AlexandriaArchive/0.1 (local topic enrichment)" },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`Official topic request failed (${response.status})`);
  const body = await response.arrayBuffer();
  const declaredCharset = response.headers.get("content-type")?.match(/charset\s*=\s*["']?([^;"'\s]+)/iu)?.[1]
    ?? Buffer.from(body).subarray(0, 4096).toString("latin1").match(/charset\s*=\s*["']?([^;"'\s>]+)/iu)?.[1]
    ?? "utf-8";
  try {
    return new TextDecoder(declaredCharset).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function topicEntityKind(definition: OfficialTopicSourceDefinition): "human" | "organization" | "creative-work" {
  if (definition.entityKind) return definition.entityKind;
  if (definition.type === "actor" || definition.type === "director") return "human";
  if (definition.type === "series") return "creative-work";
  return "organization";
}

function persistOfficialTopicProfile(
  definition: OfficialTopicSourceDefinition,
  profile: NonNullable<OfficialTopicEnrichmentPreview["profile"]>,
  source: EntityProfileSource,
  expectedUpdatedAt?: string
): void {
  const facetValue = definition.canonicalValue ?? definition.value;
  const candidates = [...new Set([facetValue, definition.value, ...definition.aliases])];
  const placeholders = candidates.map(() => "?").join(", ");
  const existing = db.prepare(`
    SELECT * FROM entity_profiles WHERE facet_type = ? AND (
      facet_value IN (${placeholders}) OR EXISTS (
        SELECT 1 FROM json_each(entity_profiles.aliases_json) WHERE TRIM(CAST(value AS TEXT)) IN (${placeholders})
      )
    ) ORDER BY CASE WHEN facet_value = ? THEN 0 ELSE 1 END, confidence DESC LIMIT 1
  `).get(definition.type, ...candidates, ...candidates, definition.value) as Record<string, unknown> | undefined;
  const existingFacetValue = String(existing?.facet_value ?? "").trim();
  const removedAliasKeys = new Set((definition.removeAliases ?? []).map((item) => item.normalize("NFKC").trim().toLocaleLowerCase("ja")));
  const aliases = [...new Set([
    ...(definition.clearWikimediaIdentity ? [] : parseJson<string[]>(String(existing?.aliases_json ?? "[]"), [])),
    existingFacetValue,
    facetValue,
    definition.value,
    ...definition.aliases
  ].map((item) => item.trim()).filter((item) => item && !removedAliasKeys.has(item.normalize("NFKC").trim().toLocaleLowerCase("ja"))))];
  const existingNames = parseJson<Record<string, string>>(String(existing?.names_json ?? "{}"), {});
  const existingMeasurements = parseJson<EntityExtendedProfile["measurements"]>(String(existing?.measurements_json ?? "{}"), {});
  const mergedMeasurements = mergeOfficialTopicMeasurements(existingMeasurements, profile.measurements);
  const existingFacts = parseJson<Record<string, string | string[]>>(String(existing?.facts_json ?? "{}"), {});
  if (definition.clearWikimediaIdentity) {
    for (const key of [
      "inceptionDate", "headquarters", "country", "industry", "parentOrganization", "legalForm", "entityTypes"
    ]) delete existingFacts[key];
  }
  const preserveCurated = ["verified", "auto-resolved"].includes(String(existing?.source_status ?? ""));
  const confidence = definition.confidence ?? 0.98;
  const resolvedBirthDate = definition.clearBirthDate ? null : resolveOfficialTopicBirthDate(
    existing?.birth_date ? String(existing.birth_date) : null,
    String(existing?.source_status ?? ""),
    profile.birthDate,
    definition.preferOfficialBirthDate
  );
  const resolvedHeightCm = resolveOfficialTopicHeight(
    existing?.height_cm == null ? null : Number(existing.height_cm),
    String(existing?.source_status ?? ""),
    profile.heightCm,
    definition.preferOfficialHeight
  );
  const now = new Date().toISOString();
  const biography = (preserveCurated || definition.preserveExistingBiography) && String(existing?.biography ?? "").trim()
    ? String(existing?.biography) : profile.biography;
  const officialWebsite = definition.officialWebsite === false
    ? String(existing?.official_website ?? "")
    : preserveCurated && String(existing?.official_website ?? "").trim()
      ? String(existing?.official_website) : definition.sourceUrl;
  const mergedFacts: Record<string, string | string[]> = preserveCurated
    ? { ...profile.facts, ...existingFacts }
    : { ...existingFacts, ...profile.facts };
  mergedFacts.entityKind = topicEntityKind(definition);
  mergedFacts.entityName = facetValue;
  if (typeof definition.facts?.profileImageCandidateUrl === "string") {
    mergedFacts.profileImageCandidateUrl = definition.facts.profileImageCandidateUrl;
    if (typeof definition.facts.profileImageProvenance === "string") {
      mergedFacts.profileImageProvenance = definition.facts.profileImageProvenance;
    }
  }
  for (const key of definition.removeFacts ?? []) delete mergedFacts[key];
  db.transaction(() => {
    if (expectedUpdatedAt) {
      const current = db.prepare(`
        SELECT updated_at AS updatedAt FROM entity_profiles WHERE facet_type = ? AND facet_value = ?
      `).get(definition.type, facetValue) as { updatedAt: string } | undefined;
      assertOfficialTopicCasMatches(current?.updatedAt ?? null, expectedUpdatedAt);
    }
    db.prepare(`
      INSERT INTO entity_profiles (
        facet_type, facet_value, display_name, names_json, aliases_json, biography, birth_date, birthplace,
        nationality, height_cm, measurements_json, facts_json, occupations_json, image_url, official_website,
        social_links_json, external_ids_json, wikidata_id, wikipedia_url, source_status, confidence,
        fetched_at, updated_at
      ) VALUES (
        @type, @value, @displayName, @namesJson, @aliasesJson, @biography, @birthDate, '', '', @heightCm, @measurementsJson,
        @factsJson, @occupationsJson, '', @officialWebsite, '{}', @externalIdsJson, @wikidataId,
        @wikipediaUrl, 'auto-matched', @confidence, @now, @now
      ) ON CONFLICT(facet_type, facet_value) DO UPDATE SET
        display_name = CASE
          WHEN entity_profiles.source_status IN ('verified', 'auto-resolved') AND entity_profiles.display_name != ''
            THEN entity_profiles.display_name
          ELSE excluded.display_name
        END,
        names_json = excluded.names_json, aliases_json = excluded.aliases_json, biography = excluded.biography,
        birth_date = excluded.birth_date,
        height_cm = excluded.height_cm,
        measurements_json = excluded.measurements_json,
        facts_json = excluded.facts_json, occupations_json = excluded.occupations_json,
        official_website = excluded.official_website,
        external_ids_json = CASE WHEN @clearWikimediaIdentity = 1 THEN excluded.external_ids_json
          ELSE json_patch(entity_profiles.external_ids_json, excluded.external_ids_json) END,
        wikidata_id = CASE WHEN @clearWikimediaIdentity = 1 THEN excluded.wikidata_id
          WHEN entity_profiles.wikidata_id = '' THEN excluded.wikidata_id ELSE entity_profiles.wikidata_id END,
        wikipedia_url = CASE WHEN @clearWikimediaIdentity = 1 THEN excluded.wikipedia_url
          WHEN entity_profiles.wikipedia_url = '' THEN excluded.wikipedia_url ELSE entity_profiles.wikipedia_url END,
        source_status = CASE WHEN entity_profiles.source_status IN ('verified', 'auto-resolved') THEN entity_profiles.source_status ELSE 'auto-matched' END,
        confidence = MAX(entity_profiles.confidence, excluded.confidence), fetched_at = excluded.fetched_at,
        updated_at = excluded.updated_at
    `).run({
      type: definition.type,
      value: facetValue,
      displayName: preserveCurated && existing?.display_name
        ? String(existing.display_name)
        : definition.displayName ?? facetValue,
      namesJson: JSON.stringify(definition.clearWikimediaIdentity
        ? profile.names
        : definition.preferOfficialNames
          ? { ...existingNames, ...profile.names }
          : { ...profile.names, ...existingNames }),
      aliasesJson: JSON.stringify(aliases),
      biography,
      birthDate: resolvedBirthDate,
      heightCm: resolvedHeightCm,
      measurementsJson: JSON.stringify(mergedMeasurements),
      factsJson: JSON.stringify(mergedFacts),
      occupationsJson: JSON.stringify(profile.occupations),
      officialWebsite,
      externalIdsJson: JSON.stringify({
        ...(definition.externalIds ?? {}),
        [definition.provider]: definition.sourceUrl
      }),
      wikidataId: definition.wikidataId ?? "",
      wikipediaUrl: definition.wikipediaUrl ?? "",
      clearWikimediaIdentity: definition.clearWikimediaIdentity ? 1 : 0,
      confidence,
      now
    });
    if (definition.clearWikimediaIdentity) {
      db.prepare(`
        DELETE FROM entity_profile_sources
        WHERE facet_type = @type AND facet_value = @value
          AND provider IN ('wikidata', 'wikipedia', 'wikimedia-commons')
      `).run({ type: definition.type, value: facetValue });
    }
    const duplicateValues = [...new Set([
      ...candidates,
      existingFacetValue
    ].map((value) => value.trim()).filter((value) => value && value !== facetValue))];
    for (const duplicateValue of duplicateValues) {
      db.prepare(`
        INSERT INTO entity_profile_sources (
          id, facet_type, facet_value, provider, source_title, source_url, license, language,
          fields_json, payload_json, confidence, retrieved_at
        )
        SELECT lower(hex(randomblob(16))), facet_type, @canonicalValue, provider, source_title, source_url,
          license, language, fields_json, payload_json, confidence, retrieved_at
        FROM entity_profile_sources WHERE facet_type = @type AND facet_value = @duplicateValue
        ON CONFLICT(facet_type, facet_value, provider, source_url) DO UPDATE SET
          source_title = excluded.source_title, fields_json = excluded.fields_json,
          payload_json = excluded.payload_json,
          confidence = MAX(entity_profile_sources.confidence, excluded.confidence),
          retrieved_at = MAX(entity_profile_sources.retrieved_at, excluded.retrieved_at)
      `).run({ type: definition.type, canonicalValue: facetValue, duplicateValue });
      db.prepare("DELETE FROM entity_profiles WHERE facet_type = ? AND facet_value = ?")
        .run(definition.type, duplicateValue);
      db.prepare("DELETE FROM entity_profile_enrichment WHERE facet_type = ? AND facet_value = ?")
        .run(definition.type, duplicateValue);
    }
    db.prepare(`
      INSERT INTO entity_profile_sources (
        id, facet_type, facet_value, provider, source_title, source_url, license, language,
        fields_json, payload_json, confidence, retrieved_at
      ) VALUES (@id, @type, @value, @provider, @title, @url, 'unknown', 'ja', @fields, @payload, @confidence, @now)
      ON CONFLICT(facet_type, facet_value, provider, source_url) DO UPDATE SET
        source_title = excluded.source_title, fields_json = excluded.fields_json,
        payload_json = excluded.payload_json, confidence = excluded.confidence, retrieved_at = excluded.retrieved_at
    `).run({ id: crypto.randomUUID(), type: definition.type, value: facetValue, provider: definition.provider,
      title: source.title, url: source.url, fields: JSON.stringify(source.fields),
      payload: JSON.stringify(source.facts ?? {}), confidence, now });
    db.prepare(`
      INSERT INTO entity_profile_enrichment (
        facet_type, facet_value, display_name, status, attempt_count, matched_external_id, confidence,
        decision_method, decision_reason, last_attempt_at, next_retry_at, updated_at
      ) VALUES (@type, @value, @displayName, 'matched', 1, @url, @confidence, 'exact-rule',
        '稳定来源页面标题与预登记实体名精确一致', @now, NULL, @now)
      ON CONFLICT(facet_type, facet_value) DO UPDATE SET status = 'matched',
        attempt_count = entity_profile_enrichment.attempt_count + 1,
        matched_external_id = excluded.matched_external_id, confidence = excluded.confidence,
        last_error_code = '', last_error = '', decision_method = excluded.decision_method,
        decision_reason = excluded.decision_reason, last_attempt_at = excluded.last_attempt_at,
        next_retry_at = NULL, updated_at = excluded.updated_at
    `).run({ type: definition.type, value: facetValue, displayName: definition.displayName ?? facetValue,
      url: definition.sourceUrl, confidence, now });
  })();
}

function buildOfficialTopicPreview(
  definition: OfficialTopicSourceDefinition,
  facts: OfficialTopicFacts
): OfficialTopicEnrichmentPreview {
  const now = new Date().toISOString();
  const confidence = definition.confidence ?? 0.98;
  const canonicalValue = definition.canonicalValue ?? definition.value;
  const officialWebsite = definition.officialWebsite === false ? "" : definition.sourceUrl;
  const entityKind = topicEntityKind(definition);
  const profile = {
      displayName: definition.displayName ?? canonicalValue,
      names: { ja: canonicalValue, ...(definition.names ?? {}) },
      aliases: [...new Set([definition.value, ...definition.aliases].filter((value) => value !== canonicalValue))],
      biography: definition.facts?.biographyPolicy === "alias-only" ? "" : facts.description,
      birthDate: definition.birthDate ?? null,
      birthplace: "",
      nationality: definition.nationality ?? (entityKind === "human" ? "日本" : ""),
      heightCm: definition.heightCm ?? null,
      measurements: definition.measurements ?? {},
      facts: {
        ...(definition.facts ?? {}),
        entityKind,
        entityName: definition.value,
        officialTitle: facts.title,
        ...((typeof definition.facts?.profileImageCandidateUrl === "string"
          ? definition.facts.profileImageCandidateUrl
          : facts.imageUrl)
          ? {
              profileImageCandidateUrl: typeof definition.facts?.profileImageCandidateUrl === "string"
                ? definition.facts.profileImageCandidateUrl
                : facts.imageUrl
            }
          : {})
      },
      occupations: definition.occupations ?? [definition.type === "actor" ? "AV女優" : definition.type === "director" ? "AV監督" : definition.type === "maker" ? "影像厂商" : definition.type === "series" ? "影像系列" : "影像厂牌"],
      imageUrl: "",
      imageAttribution: null,
      officialWebsite,
      socialLinks: {},
      externalIds: { ...(definition.externalIds ?? {}), [definition.provider]: definition.sourceUrl },
      wikidataId: definition.wikidataId ?? "",
      wikipediaUrl: definition.wikipediaUrl ?? "",
      status: "auto-matched" as const,
      confidence,
      fetchedAt: now
  };
  const source: EntityProfileSource = {
      provider: definition.provider,
      title: facts.title,
      url: definition.sourceUrl,
      license: "unknown",
      language: "ja",
      fields: ["names", "aliases", ...(definition.preserveExistingBiography ? [] : ["biography"]), ...(definition.birthDate ? ["birthDate"] : []),
        ...(definition.heightCm ? ["heightCm"] : []), ...(definition.measurements ? ["measurements"] : []),
        ...(definition.officialWebsite === false ? [] : ["officialWebsite"]), "facts",
        ...(definition.wikidataId ? ["wikidataId"] : []), ...(definition.wikipediaUrl ? ["wikipediaUrl"] : []),
        ...(facts.imageUrl ? ["image"] : [])],
      confidence,
      retrievedAt: now,
      facts: { title: facts.title, description: facts.description, entityName: definition.value, entityKind,
        ...(definition.birthDate ? { birthDate: definition.birthDate } : {}), ...(definition.facts ?? {}),
        ...(definition.heightCm ? { heightCm: definition.heightCm } : {}),
        ...(definition.measurements ? { measurements: definition.measurements } : {}),
        ...(definition.externalIds ? { externalIds: definition.externalIds } : {}),
        ...(definition.wikidataId ? { wikidataId: definition.wikidataId } : {}),
        ...(definition.wikipediaUrl ? { wikipediaUrl: definition.wikipediaUrl } : {}),
        ...(facts.imageUrl ? { profileImageCandidateUrl: facts.imageUrl } : {}),
        identityBridge: { expectedNames: definition.expectedNames, stableUrl: definition.sourceUrl } }
  };
  return { definition, matched: true, profile, source };
}

const VERIFIED_SERIES_RELATED_MAKERS: Record<string, string> = {};

function withVerifiedSeriesRelatedMaker(definition: OfficialTopicSourceDefinition): OfficialTopicSourceDefinition {
  const relatedMaker = definition.type === "series" ? VERIFIED_SERIES_RELATED_MAKERS[definition.value] : "";
  return relatedMaker && !definition.facts?.relatedMaker
    ? { ...definition, facts: { ...(definition.facts ?? {}), relatedMaker } }
    : definition;
}

export function persistVerifiedOfficialTopicSnapshot(
  definition: OfficialTopicSourceDefinition,
  expectedUpdatedAt?: string
): OfficialTopicEnrichmentPreview {
  definition = withVerifiedSeriesRelatedMaker(definition);
  const preview = buildOfficialTopicPreview(definition, {
    title: definition.value,
    description: definition.summaryFallback,
    imageUrl: ""
  });
  persistOfficialTopicProfile(definition, preview.profile!, preview.source!, expectedUpdatedAt);
  return preview;
}

export async function enrichTopicFromOfficialSource(
  definition: OfficialTopicSourceDefinition,
  execute = false,
  expectedUpdatedAt?: string
): Promise<OfficialTopicEnrichmentPreview> {
  try {
    const html = await fetchOfficialTopicPage(definition);
    const facts = parseOfficialTopicPage(definition, html);
    if (!facts) throw new Error(`Official topic identity mismatch: ${definition.value}`);
    const preview = buildOfficialTopicPreview(definition, facts);
    if (execute) persistOfficialTopicProfile(definition, preview.profile!, preview.source!, expectedUpdatedAt);
    return preview;
  } catch (error) {
    if (execute) recordEntityEnrichmentFailure(definition.type, definition.value, definition.value, error);
    throw error;
  }
}
