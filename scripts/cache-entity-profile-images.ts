import { db } from "../server/src/db.js";
import { config } from "../server/src/config.js";
import { cacheEntityProfileImage } from "../server/src/entityProfileImageCache.js";
import type { PublicEntityType } from "../server/src/entityProfiles.js";

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
const requestedProvider = readArg("--provider");
const allowedTypes = new Set<PublicEntityType>(["actor", "director", "maker", "label", "series"]);
if (requestedType && !allowedTypes.has(requestedType as PublicEntityType)) {
  throw new Error(`不支持的类型：${requestedType}`);
}
const limit = positiveInt(readArg("--limit"), 20);
const offset = Math.max(0, Number(readArg("--offset") ?? 0) || 0);
const rows = db.prepare(`
  SELECT DISTINCT sources.facet_type AS type, sources.facet_value AS value
  FROM entity_profile_sources sources
  WHERE ((sources.provider = 'wikimedia-commons'
      AND (json_extract(sources.payload_json, '$.licenseDecision') = 'allowed-v1'
        OR (@researchImagePolicy = 1
          AND json_extract(sources.payload_json, '$.licenseDecision') = 'research-cache-v1'))
      AND json_extract(sources.payload_json, '$.image.sha1') GLOB '[0-9a-f]*')
    OR (sources.provider LIKE 'official-%'
      AND json_extract(sources.payload_json, '$.profileImageCandidateUrl') != '')
    OR (sources.facet_type = 'actor' AND sources.provider = 'public-r18dev-actor'
      AND json_extract(sources.payload_json, '$.profileImageCandidateUrl') != ''))
    AND (@type = '' OR sources.facet_type = @type)
    AND (@entity = '' OR sources.facet_value = @entity)
    AND (@provider = '' OR sources.provider = @provider)
  ORDER BY CASE sources.facet_type WHEN 'actor' THEN 0 WHEN 'director' THEN 1 ELSE 2 END,
    sources.facet_value COLLATE NOCASE
  LIMIT @limit OFFSET @offset
`).all({
  type: requestedType ?? "",
  entity: requestedEntity ?? "",
  provider: requestedProvider ?? "",
  researchImagePolicy: config.externalAi.entityProfileImagePolicy === "research" ? 1 : 0,
  limit: requestedEntity ? 1 : limit,
  offset
}) as Array<{ type: PublicEntityType; value: string }>;

console.log(`辅助存储 实体资料图片缓存：${rows.length} 条 · policy=${config.externalAi.entityProfileImagePolicy}` +
  `${requestedProvider ? ` · provider=${requestedProvider}` : ""} · limit=${limit} · offset=${offset}`);
let cached = 0;
let existing = 0;
let unavailable = 0;
let failed = 0;
for (const [index, row] of rows.entries()) {
  try {
    const result = await cacheEntityProfileImage(row.type, row.value);
    if (result.status === "cached") cached += 1;
    else if (result.status === "already-cached") existing += 1;
    else unavailable += 1;
    console.log(`[${index + 1}/${rows.length}] ${row.type}:${row.value} · ${result.status}` +
      `${result.sizeBytes ? ` · ${(result.sizeBytes / 1024).toFixed(0)} KB` : ""}` +
      `${result.message ? ` · ${result.message}` : ""}`);
    if (result.status === "storage-unavailable") break;
  } catch (error) {
    failed += 1;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[${index + 1}/${rows.length}] ${row.type}:${row.value} · failed · ${message}`);
    if (/\((?:429|503)\)/u.test(message)) {
      console.warn("实体图片来源持续限流，停止当前批次并保留断点。");
      break;
    }
  }
}
console.log(`完成：新增缓存 ${cached} · 已存在 ${existing} · 来源/存储不可用 ${unavailable} · 失败 ${failed}`);
