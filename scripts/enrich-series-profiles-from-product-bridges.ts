import { db } from "../server/src/db.js";
import { getEntityExtendedProfile } from "../server/src/entityProfiles.js";
import { persistVerifiedOfficialTopicSnapshot, type OfficialTopicSourceDefinition } from "../server/src/officialTopicSources.js";
import { getTopicGraphItems, type TopicType } from "../server/src/productRoutes.js";

type BridgeTopicType = Extract<TopicType, "director" | "maker" | "label" | "series">;

type ProductBridge = {
  code: string;
  provider: string;
  providerId: string;
  title: string;
  director: string;
  directorZh: string;
  maker: string;
  makerZh: string;
  label: string;
  labelZh: string;
  rawJson: string;
};

function readArg(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? "" : "";
}

function positiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.normalize("NFKC").trim() : "";
}

function safePublicUrl(value: unknown): string {
  const candidate = text(value);
  try {
    const url = new URL(candidate);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function isSingleDirectorCredit(value: string): boolean {
  const normalized = text(value);
  if (!normalized) return false;
  if (/[,，、&＆/／]|\b(?:and|with)\b/iu.test(normalized)) return false;
  if (/(?:編集部|研究会|制作|倶楽部|クラブ)$/u.test(normalized)) return false;
  if (/(?:投稿|撮影)[＞>]/u.test(normalized)) return false;
  return true;
}

function nestedObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sourceUrlFor(bridge: ProductBridge, raw = parseObject(bridge.rawJson)): string {
  const primary = nestedObject(raw.primary);
  const candidates = [
    raw.homepage,
    nestedObject(raw.search).homepage,
    nestedObject(primary.search).homepage,
    nestedObject(primary.detail).homepage,
    nestedObject(raw.detail).homepage
  ];
  for (const candidate of candidates) {
    const url = safePublicUrl(candidate);
    if (url) return url;
  }
  const provider = bridge.provider.toLocaleLowerCase();
  const id = encodeURIComponent(bridge.providerId);
  const code = encodeURIComponent(bridge.code);
  if (provider === "r18dev" && id) return `https://r18.dev/videos/vod/movies/detail/-/id=${id}/`;
  if (provider === "javbus" && code) return `https://www.javbus.com/ja/${code}`;
  if (provider === "fanza" && id) return `https://video.dmm.co.jp/av/content/?id=${id}`;
  if (provider === "duga" && id) return `https://duga.jp/ppv/${id}/`;
  if (provider === "mgs" && id) return `https://www.mgstage.com/product/product_detail/${id}/`;
  return "";
}

function evidenceCodeFor(bridge: ProductBridge, raw = parseObject(bridge.rawJson)): string {
  const primary = nestedObject(raw.primary);
  const candidates = [
    raw.number,
    nestedObject(raw.search).number,
    nestedObject(primary.search).number,
    nestedObject(primary.detail).number,
    nestedObject(raw.detail).number,
    bridge.provider.toLocaleLowerCase() === "javbus" ? bridge.providerId : "",
    bridge.code
  ];
  return candidates.map(text).find((value) => /[A-Za-z]+-?\d+/u.test(value)) || bridge.code;
}

function bridgesForTopic(type: BridgeTopicType, aliases: string[], expectedWorks: number): ProductBridge[] | null {
  const placeholders = aliases.map(() => "?").join(", ");
  if (!placeholders) return null;
  const rows = db.prepare(`
    SELECT DISTINCT metadata.normalized_code AS code, metadata.provider,
      metadata.provider_id AS providerId, metadata.title, metadata.director,
      metadata.director_zh AS directorZh, metadata.maker,
      metadata.maker_zh AS makerZh, metadata.label, metadata.label_zh AS labelZh,
      metadata.raw_json AS rawJson
    FROM media_metadata_facets facets
    JOIN media_metadata metadata ON metadata.normalized_code = facets.normalized_code
    WHERE facets.facet_type = ? AND facets.facet_value IN (${placeholders})
      AND metadata.status = 'ready'
    ORDER BY metadata.updated_at DESC
  `).all(type, ...aliases) as ProductBridge[];
  // A single provider product can be stored under both padded and unpadded
  // normalized codes (for example SPSC-002 and SPSC-02). Treat the provider's
  // stable product ID as the evidence identity so these aliases neither inflate
  // the bridge count nor weaken the all-library-works evidence requirement.
  const uniqueRows = [...new Map(rows.map((row) => {
    const provider = row.provider.trim().toLocaleLowerCase();
    const providerId = row.providerId.trim().toLocaleLowerCase();
    const identity = providerId ? `${provider}:${providerId}` : `${provider}:${sourceUrlFor(row)}`;
    return [identity, row] as const;
  })).values()];
  if (!uniqueRows.length || uniqueRows.length > expectedWorks) return null;
  const bridges = uniqueRows.map((row) => ({ ...row, code: evidenceCodeFor(row) }));
  return bridges.every((row) => sourceUrlFor(row)) ? bridges : null;
}

function definitionFor(
  type: BridgeTopicType,
  item: ReturnType<typeof getTopicGraphItems>[number],
  bridges: ProductBridge[]
): OfficialTopicSourceDefinition {
  const bridge = bridges[0]!;
  const raw = parseObject(bridge.rawJson);
  const sourceUrl = sourceUrlFor(bridge, raw);
  const providerSlug = (bridge.provider || "metadata").toLocaleLowerCase().replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || "metadata";
  const relatedMaker = bridge.makerZh || bridge.maker;
  const relatedLabel = bridge.labelZh || bridge.label;
  const sourceTitle = text(raw.title) || bridge.title || bridge.code;
  const names = item.label !== item.value
    ? { ja: item.value, zh: item.label }
    : /[ぁ-ゖァ-ヺ]/u.test(item.value) ? { ja: item.value } : { en: item.value };
  const typeLabel = type === "series" ? "系列" : type === "maker" ? "厂商" : type === "label" ? "厂牌" : "导演";
  return {
    type,
    value: item.value,
    // Keep the source identity in storage. Runtime projection uses names.zh as
    // the primary label and can therefore expose this value as the Japanese
    // original for search, evidence, and disambiguation.
    displayName: item.value,
    aliases: item.aliases.filter((alias) => alias !== item.value),
    provider: `public-${providerSlug}-product-${type}-field`,
    sourceUrl,
    expectedNames: [item.value, item.label],
    identityCodes: bridges.map((item) => item.code),
    summaryFallback: `公开作品页 ${bridges.map((item) => item.code).join("、")} 的结构化${typeLabel}字段确认「${item.label}」；当前馆藏收录 ${bridges.length} 部关联作品。`,
    facts: {
      entityKind: type === "series" ? "creative-work" : type === "director" ? "human" : "organization",
      entityName: item.value,
      matchedLibraryWorkCount: String(bridges.length),
      identityBridgeCodes: bridges.map((item) => item.code),
      sourceProvider: [...new Set(bridges.map((item) => item.provider || "馆藏元数据"))],
      sourceField: `media_metadata.${type}`,
      sourceProductTitle: sourceTitle,
      ...(relatedMaker ? { relatedMaker } : {}),
      ...(relatedLabel ? { relatedLabel } : {})
    },
    names,
    confidence: 0.94,
    officialWebsite: false,
    entityKind: type === "series" ? "creative-work" : type === "director" ? "human" : "organization",
    occupations: [type === "series" ? "影像系列" : type === "maker" ? "影像厂商" : type === "label" ? "影像厂牌" : "影像导演"],
    suppressImage: true
  };
}

const limit = positiveInt(readArg("--limit"), 100);
const offset = Math.max(0, Number.parseInt(readArg("--offset") || "0", 10) || 0);
const minWorks = positiveInt(readArg("--min-works"), 1);
const maxWorks = positiveInt(readArg("--max-works"), 1);
const execute = !process.argv.includes("--dry-run");
const requestedType = readArg("--type") || "series";
if (!["director", "maker", "label", "series"].includes(requestedType)) {
  throw new Error("--type 只支持 director、maker、label 或 series");
}
const type = requestedType as BridgeTopicType;

if (execute && type === "series") {
  const repaired = db.prepare(`
    UPDATE entity_profiles
    SET display_name = facet_value, updated_at = @now
    WHERE facet_type = 'series' AND display_name != facet_value
      AND COALESCE(TRIM(json_extract(names_json, '$.zh')), '') != ''
      AND EXISTS (
        SELECT 1 FROM entity_profile_sources sources
        WHERE sources.facet_type = entity_profiles.facet_type
          AND sources.facet_value = entity_profiles.facet_value
          AND sources.provider LIKE 'public-%-product-series-field'
      )
  `).run({ now: new Date().toISOString() });
  if (repaired.changes > 0) console.log(`修复既有系列日文原名：${repaired.changes} 条`);
}

const candidates = getTopicGraphItems(type)
  .filter((item) => item.mediaCount >= minWorks && item.mediaCount <= maxWorks)
  .filter((item) => type !== "director" || isSingleDirectorCredit(item.value))
  .filter((item) => !getEntityExtendedProfile(type, item.value))
  .map((item) => ({ item, bridges: bridgesForTopic(type, item.aliases, item.mediaCount) }))
  .filter((candidate): candidate is { item: typeof candidate.item; bridges: ProductBridge[] } => Boolean(candidate.bridges))
  .sort((left, right) => (right.item.latestReleaseDate ?? "").localeCompare(left.item.latestReleaseDate ?? "")
    || left.item.value.localeCompare(right.item.value, "ja"))
  .slice(offset, offset + limit);

console.log(`${execute ? "自动写入" : "只读演练"}产品页桥接${type === "series" ? "系列" : type === "maker" ? "厂商" : type === "label" ? "厂牌" : "导演"}资料：${candidates.length} 条`);
let written = 0;
for (const [index, candidate] of candidates.entries()) {
  const definition = definitionFor(type, candidate.item, candidate.bridges);
  console.log(`[${index + 1}/${candidates.length}] ${candidate.item.label} · ${candidate.bridges.map((item) => item.code).join("、")} · ${definition.sourceUrl}`);
  if (!execute) continue;
  persistVerifiedOfficialTopicSnapshot(definition);
  written += 1;
}
console.log(`完成：候选 ${candidates.length} · 写入 ${written}`);
