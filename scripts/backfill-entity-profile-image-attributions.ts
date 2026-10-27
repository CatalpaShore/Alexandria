import { db } from "../server/src/db.js";
import { config } from "../server/src/config.js";
import {
  refreshEntityProfileImageAttribution,
  type PublicEntityType
} from "../server/src/entityProfiles.js";

function readArg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? "" : null;
}

function positiveInt(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const requestedType = readArg("--type");
const requestedEntity = readArg("--entity");
const allowedTypes = new Set<PublicEntityType>(["actor", "director", "maker", "label"]);
if (requestedType && !allowedTypes.has(requestedType as PublicEntityType)) {
  throw new Error(`不支持的类型：${requestedType}`);
}
const limit = positiveInt(readArg("--limit"), 20);
const offset = Math.max(0, Number(readArg("--offset") ?? 0) || 0);
const refresh = process.argv.includes("--refresh");
const rows = db.prepare(`
  SELECT facet_type AS type, facet_value AS value, wikidata_id AS wikidataId
  FROM entity_profiles profiles
  WHERE wikidata_id != ''
    AND (@type = '' OR facet_type = @type)
    AND (@entity = '' OR facet_value = @entity)
    AND (@refresh = 1 OR (
      NOT EXISTS (
        SELECT 1 FROM entity_profile_sources sources
        WHERE sources.facet_type = profiles.facet_type
          AND sources.facet_value = profiles.facet_value
          AND sources.provider = 'wikimedia-commons'
          AND (json_extract(sources.payload_json, '$.licenseDecision') = 'allowed-v1'
            OR (@researchImagePolicy = 1
              AND json_extract(sources.payload_json, '$.licenseDecision') = 'research-cache-v1'))
      )
      AND NOT EXISTS (
        SELECT 1 FROM entity_profile_sources audits
        WHERE audits.facet_type = profiles.facet_type
          AND audits.facet_value = profiles.facet_value
          AND audits.provider = 'wikimedia-commons-audit'
          AND json_extract(audits.payload_json, '$.retryAfter') > @now
      )
    ))
  ORDER BY CASE facet_type WHEN 'actor' THEN 0 WHEN 'director' THEN 1 ELSE 2 END,
    updated_at DESC
  LIMIT @limit OFFSET @offset
`).all({
  type: requestedType ?? "",
  entity: requestedEntity ?? "",
  refresh: refresh ? 1 : 0,
  now: new Date().toISOString(),
  researchImagePolicy: config.externalAi.entityProfileImagePolicy === "research" ? 1 : 0,
  limit: requestedEntity ? 1 : limit,
  offset
}) as Array<{
  type: PublicEntityType;
  value: string;
  wikidataId: string;
}>;

console.log(`Commons 图片元数据回填：${rows.length} 条 · policy=${config.externalAi.entityProfileImagePolicy} · limit=${limit} · offset=${offset}${refresh ? " · 强制复查" : ""}`);
let updated = 0;
let noImage = 0;
let unresolved = 0;
let failed = 0;
for (const [index, row] of rows.entries()) {
  try {
    const result = await refreshEntityProfileImageAttribution(row);
    if (result.status === "updated") updated += 1;
    else if (result.status === "no-image") noImage += 1;
    else unresolved += 1;
    console.log(`[${index + 1}/${rows.length}] ${row.type}:${row.value} · ${result.status}${result.fileName ? ` · ${result.fileName}` : ""}`);
  } catch (error) {
    failed += 1;
    console.warn(`[${index + 1}/${rows.length}] ${row.type}:${row.value} · failed · ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(`完成：策略通过 ${updated} · 无 P18 ${noImage} · 图片不可用 ${unresolved} · 请求失败 ${failed}`);
