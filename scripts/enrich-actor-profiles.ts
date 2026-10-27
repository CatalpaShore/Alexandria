import {
  getActorAliasRegistry,
  getActorDisplayName,
  getCanonicalActorName,
  isActorNameCandidate,
  resolveActorMetadataTranslation
} from "../server/src/actorAliases.js";
import { db } from "../server/src/db.js";
import {
  enrichActorFromWikimedia,
  getEntityExtendedProfile,
  getEntityProfileCoverage,
  recordEntityEnrichmentFailure
} from "../server/src/entityProfiles.js";
import { getCanonicalTopicProfileCandidates } from "../server/src/productRoutes.js";

type ActorCandidate = { value: string; label: string; mediaCount: number; searchNames: string[] };

function coveredActorSourceFromSharedMedia(value: string, mediaCount: number): string | null {
  const rows = db.prepare(`
    SELECT TRIM(CAST(source.value AS TEXT)) AS source,
      COUNT(DISTINCT facets.normalized_code) AS overlap
    FROM media_metadata_facets facets
    JOIN media_metadata metadata ON metadata.normalized_code = facets.normalized_code
    JOIN json_each(metadata.actors_json) source
    WHERE facets.facet_type = 'actor' AND facets.facet_value = @value
      AND TRIM(CAST(source.value AS TEXT)) != ''
    GROUP BY TRIM(CAST(source.value AS TEXT))
    HAVING COUNT(DISTINCT facets.normalized_code) = @mediaCount
  `).all({ value, mediaCount }) as Array<{ source: string; overlap: number }>;
  const covered = new Map<string, string>();
  for (const row of rows) {
    const profile = getEntityExtendedProfile("actor", row.source);
    if (profile) covered.set(profile.value, row.source);
  }
  return covered.size === 1 ? [...covered.values()][0]! : null;
}

function coveredActorSourceFromTranslation(
  translated: string,
  rows: Array<{ source: string; translated: string }>
): string | null {
  if (!translated) return null;
  const covered = new Map<string, string>();
  for (const row of rows) {
    if (row.translated.normalize("NFKC").trim() !== translated.normalize("NFKC").trim()) continue;
    const profile = getEntityExtendedProfile("actor", row.source);
    if (profile) covered.set(profile.value, row.source);
  }
  return covered.size === 1 ? [...covered.values()][0]! : null;
}

function isCoveredByRegisteredIdentity(value: string): boolean {
  if (getEntityExtendedProfile("actor", value)) return true;
  const canonical = getCanonicalActorName(value);
  return Boolean(canonical && getEntityExtendedProfile("actor", canonical));
}

function actorIdentityKey(value: string): string {
  return (getCanonicalActorName(value) || value).normalize("NFKC").toLocaleLowerCase("ja")
    .replace(/[\s\-_.・·()（）]+/gu, "");
}

function readArg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? "" : null;
}

function positiveInt(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function actorCandidates(limit: number, offset: number, actor: string | null, refresh: boolean, minWorks: number): ActorCandidate[] {
  if (actor) return isActorNameCandidate(actor)
    ? [{ value: actor, label: getActorDisplayName(actor), mediaCount: 0, searchNames: [actor] }]
    : [];
  const translationRows = db.prepare(`
    SELECT TRIM(CAST(source.value AS TEXT)) AS source,
      TRIM(CAST(translated.value AS TEXT)) AS translated, COUNT(*) AS frequency
    FROM media_metadata metadata
    JOIN json_each(metadata.actors_json) source
    JOIN json_each(metadata.actors_zh_json) translated ON translated.key = source.key
    WHERE metadata.status = 'ready' AND TRIM(CAST(source.value AS TEXT)) != ''
      AND TRIM(CAST(translated.value AS TEXT)) != ''
    GROUP BY source, translated
    ORDER BY frequency DESC
  `).all() as Array<{ source: string; translated: string; frequency: number }>;
  const rows = db.prepare(`
    SELECT facets.facet_value AS value,
      COUNT(DISTINCT LOWER(metadata.provider) || ':' || LOWER(
        COALESCE(NULLIF(TRIM(metadata.provider_id), ''), metadata.normalized_code)
      )) AS mediaCount
    FROM media_metadata_facets facets
    JOIN media_metadata metadata ON metadata.normalized_code = facets.normalized_code
    WHERE facet_type = 'actor' AND TRIM(facet_value) != ''
      AND (@refresh = 1 OR NOT EXISTS (
        SELECT 1 FROM entity_profiles profiles
        WHERE profiles.facet_type = 'actor' AND (
          profiles.facet_value = facets.facet_value OR EXISTS (
            SELECT 1 FROM json_each(profiles.aliases_json)
            WHERE TRIM(CAST(value AS TEXT)) = facets.facet_value
          )
        )
      ))
      AND (@refresh = 1 OR NOT EXISTS (
        SELECT 1 FROM entity_profile_enrichment attempts
        WHERE attempts.facet_type = 'actor' AND attempts.facet_value = facets.facet_value
          AND attempts.next_retry_at IS NOT NULL AND attempts.next_retry_at > @now
      ))
    GROUP BY facets.facet_value
    HAVING COUNT(DISTINCT LOWER(metadata.provider) || ':' || LOWER(
      COALESCE(NULLIF(TRIM(metadata.provider_id), ''), metadata.normalized_code)
    )) >= @minWorks
    ORDER BY mediaCount DESC, facet_value COLLATE NOCASE
    LIMIT @limit OFFSET @offset
  `).all({ refresh: refresh ? 1 : 0, now: new Date().toISOString(), minWorks, limit: limit * 4, offset }) as Array<{ value: string; mediaCount: number }>;
  const namePriority = (value: string) => /[\u3040-\u30ff]/u.test(value) ? 3
    : /[\u3400-\u9fff]/u.test(value) ? 2 : 1;
  const prepared = rows.filter((row) => isActorNameCandidate(row.value)).map((row) => {
    const resolved = resolveActorMetadataTranslation(row.value, translationRows);
    // Historical translated facets may no longer equal the latest actors_zh_json
    // value. If every work behind that facet contains exactly one already-covered
    // source actor, reuse that stable identity instead of searching the translation.
    const existingSourceProfile = getEntityExtendedProfile("actor", resolved.source);
    const translatedProfile = !existingSourceProfile && resolved.translated
      ? getEntityExtendedProfile("actor", resolved.translated) : null;
    const translatedSource = existingSourceProfile
      ? null : translatedProfile?.value ?? coveredActorSourceFromTranslation(resolved.translated, translationRows);
    const sharedMediaSource = existingSourceProfile || translatedSource
      ? null : coveredActorSourceFromSharedMedia(row.value, row.mediaCount);
    const source = translatedSource ?? sharedMediaSource ?? resolved.source;
    const existing = getEntityExtendedProfile("actor", source);
    const label = existing?.displayName ?? getActorDisplayName(source, resolved.translated);
    return {
      ...row,
      value: source,
      label,
      searchNames: [...new Set([source, row.value, ...resolved.searchNames].filter(isActorNameCandidate))]
    };
  }).filter((candidate) => isActorNameCandidate(candidate.label) &&
    (refresh || !isCoveredByRegisteredIdentity(candidate.value)));
  const grouped = new Map<string, ActorCandidate[]>();
  for (const candidate of prepared) {
    const key = candidate.label.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s\-_・·()（）]+/g, "");
    grouped.set(key || candidate.value, [...(grouped.get(key || candidate.value) ?? []), candidate]);
  }
  return [...grouped.values()]
    .map((items) => [...items].sort((left, right) =>
      namePriority(right.value) - namePriority(left.value) || right.mediaCount - left.mediaCount
    )[0])
    .sort((left, right) => right.mediaCount - left.mediaCount || left.label.localeCompare(right.label, "zh-CN"))
    .slice(0, limit);
}

function printCoverage(prefix: string, minWorks = 0): void {
  const coverage = getEntityProfileCoverage("actor", getCanonicalTopicProfileCandidates("actor", minWorks));
  console.log(`${prefix}：${coverage.enriched}/${coverage.total}（${coverage.coveragePercent}%）` +
    ` · 高置信 ${coverage.verified + coverage.autoMatched} · AI/规则择优 ${coverage.autoResolved}` +
    ` · 未匹配 ${coverage.noMatch} · 失败待重试 ${coverage.failed} · 待处理 ${coverage.pending}`);
  if (coverage.enriched > 0) console.log(
    `  字段完整度（已入库 ${coverage.enriched}）：生日 ${coverage.withBirthDate} · 身高 ${coverage.withHeight}` +
    ` · 完整三围 ${coverage.withMeasurements} · 简介 ${coverage.withBiography}` +
    ` · 图片 ${coverage.withImage} · Wikipedia ${coverage.withWikipedia}`
  );
}

// Identity matching is autonomous: a high-confidence rules match is accepted directly,
// while an ambiguous match is accepted only when the local AI clears the threshold.
// Keep a dry-run switch for operational diagnostics, but do not require a person to
// approve individual merge decisions before a normal batch can be persisted.
const execute = !process.argv.includes("--dry-run");
const refresh = process.argv.includes("--refresh");
const reportOnly = process.argv.includes("--report");
const listOnly = process.argv.includes("--list-only");
const actor = readArg("--actor");
const limit = positiveInt(readArg("--limit"), 10);
const minWorks = positiveInt(readArg("--min-works"), 4);
const offset = Math.max(0, Number(readArg("--offset") ?? 0) || 0);
const registry = getActorAliasRegistry();
const candidates = actorCandidates(limit, offset, actor, refresh, minWorks);

if (listOnly) {
  console.log(`演员候选预览：${candidates.length} 条，offset=${offset}，至少 ${minWorks} 部作品`);
  for (const [index, candidate] of candidates.entries()) {
    console.log(`[${index + 1}/${candidates.length}] ${candidate.label} · source=${candidate.value} · 馆藏 ${candidate.mediaCount} 部`);
  }
  process.exit(0);
}

if (reportOnly) {
  printCoverage("全量演员资料覆盖");
  printCoverage(`本批范围覆盖（至少 ${minWorks} 部）`, minWorks);
  const statusDetails = db.prepare(`
    SELECT facet_value AS value, status, attempt_count AS attempts
    FROM entity_profile_enrichment WHERE facet_type = 'actor'
  `).all() as Array<{ value: string; status: string; attempts: number }>;
  const statusIdentities = new Map<string, { status: string; attempts: number }>();
  for (const row of statusDetails.filter((item) =>
    isActorNameCandidate(item.value) && !isCoveredByRegisteredIdentity(item.value)
  )) {
    const key = actorIdentityKey(row.value);
    const current = statusIdentities.get(key);
    statusIdentities.set(key, {
      status: current?.status ?? row.status,
      attempts: (current?.attempts ?? 0) + row.attempts
    });
  }
  const statusRows = new Map<string, { count: number; attempts: number }>();
  for (const row of statusIdentities.values()) {
    const current = statusRows.get(row.status) ?? { count: 0, attempts: 0 };
    statusRows.set(row.status, { count: current.count + 1, attempts: current.attempts + row.attempts });
  }
  for (const [status, row] of statusRows) console.log(`  ${status}: ${row.count} 条 · ${row.attempts} 次尝试`);
  const recentFailures = db.prepare(`
    SELECT facet_value AS value, display_name AS displayName, last_error_code AS errorCode,
      last_error AS error, next_retry_at AS nextRetryAt
    FROM entity_profile_enrichment
    WHERE facet_type = 'actor' AND status IN ('failed', 'not-found')
    ORDER BY updated_at DESC LIMIT 40
  `).all() as Array<{ value: string; displayName: string; errorCode: string; error: string; nextRetryAt: string | null }>;
  const visibleFailureIdentities = new Set<string>();
  const visibleFailures = recentFailures.filter((item) => {
    const identityKey = actorIdentityKey(item.value);
    if (visibleFailureIdentities.has(identityKey)) return false;
    const visible =
    isActorNameCandidate(item.value) && isActorNameCandidate(item.displayName) &&
    !isCoveredByRegisteredIdentity(item.value);
    if (visible) visibleFailureIdentities.add(identityKey);
    return visible;
  }).slice(0, 10);
  if (visibleFailures.length) {
    console.log("\n最近未完成项：");
    for (const item of visibleFailures) console.log(`  ${item.displayName} · ${item.errorCode} · ${item.error}` +
      `${item.nextRetryAt ? ` · 下次可重试 ${item.nextRetryAt}` : ""}`);
  }
  process.exit(0);
}

console.log(`${execute ? "自动写入" : "只读演练"}演员扩展资料：${candidates.length} 条，offset=${offset}，至少 ${minWorks} 部作品`);
console.log(execute
  ? "系统将自主接受高置信唯一匹配，并由本地 AI 判断歧义候选；低置信结果保持分离并自动重试。\n"
  : "--dry-run 仅用于检查运行范围，不写数据库，也不构成人工实体核验步骤。\n");
printCoverage("当前批次覆盖", minWorks);
console.log();

let matched = 0;
let failed = 0;
let merged = 0;
for (const [index, candidate] of candidates.entries()) {
  const existingProfile = !refresh ? getEntityExtendedProfile("actor", candidate.value) : null;
  if (existingProfile) {
    merged += 1;
    console.log(`[${index + 1}/${candidates.length}] ${candidate.label}：已由 ${existingProfile.displayName} (${existingProfile.wikidataId}) 覆盖，跳过重复搜索`);
    continue;
  }
  const aliasGroup = registry.find((group) =>
    [group.canonicalName, ...group.aliases].some((name) => name === candidate.value || name === candidate.label)
  );
  const names = [...new Set([
    ...candidate.searchNames,
    candidate.label,
    ...(aliasGroup ? [aliasGroup.canonicalName, ...aliasGroup.aliases] : [])
  ])];
  try {
    const preview = await enrichActorFromWikimedia(candidate.value, names, execute);
    if (!preview.matched || !preview.profile) {
      failed += 1;
      console.log(`[${index + 1}/${candidates.length}] ${candidate.label}：未匹配（${preview.reason ?? "未知原因"}）`);
      continue;
    }
    matched += 1;
    const profile = preview.profile;
    const dimensions = [profile.measurements.bustCm, profile.measurements.waistCm, profile.measurements.hipsCm];
    const measurementCopy = dimensions.every((value) => value != null)
      ? `${dimensions.join("/")} cm${profile.measurements.cup ? ` · ${profile.measurements.cup} 杯` : ""}`
      : profile.measurements.bustCm
        ? `胸围 ${profile.measurements.bustCm} cm${profile.measurements.cup ? ` · ${profile.measurements.cup} 杯` : ""}`
        : profile.measurements.cup
          ? `罩杯 ${profile.measurements.cup}`
        : "缺失";
    console.log([
      `[${index + 1}/${candidates.length}] ${candidate.label} → ${profile.displayName} (${profile.wikidataId})`,
      `  状态 ${profile.status} · 置信度 ${Math.round(profile.confidence * 100)}% · 身高 ${profile.heightCm == null ? "缺失" : `${profile.heightCm} cm`} · 出生 ${profile.birthDate ?? "缺失"}`,
      `  三围/胸围 ${measurementCopy}`,
      `  身份判断 ${preview.identityDecision?.method === "local-ai" ? "本地 AI 消歧" : "日文主名/多语言别名精确匹配"}`,
      `  来源 ${[...new Set(preview.sources?.map((source) => source.provider) ?? [])].join("、") || "无"}${execute ? " · 已写入" : " · 未写入"}`
    ].join("\n"));
  } catch (error) {
    failed += 1;
    if (execute) recordEntityEnrichmentFailure("actor", candidate.value, candidate.label, error);
    console.warn(`[${index + 1}/${candidates.length}] ${candidate.label}：${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\n完成：匹配 ${matched}，重复合并跳过 ${merged}，未匹配/失败 ${failed}，模式=${execute ? "execute" : "preview"}`);
if (execute) printCoverage("写入后批次覆盖", minWorks);
