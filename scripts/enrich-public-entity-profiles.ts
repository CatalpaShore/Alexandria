import { db } from "../server/src/db.js";
import {
  enrichPublicEntityFromWikimedia,
  getEntityExtendedProfile,
  recordEntityEnrichmentFailure,
  type PublicEntityType
} from "../server/src/entityProfiles.js";
import { getTopicGraphItems } from "../server/src/productRoutes.js";

type SupportedType = Exclude<PublicEntityType, "actor">;

function readArg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? "" : null;
}

function positiveInt(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const rawType = readArg("--type") ?? "director";
if (!["director", "maker", "label"].includes(rawType)) {
  throw new Error("--type 只支持 director、maker 或 label");
}
const type = rawType as SupportedType;
const entity = readArg("--entity");
const limit = positiveInt(readArg("--limit"), 5);
const offset = Math.max(0, Number(readArg("--offset") ?? 0) || 0);
const minWorks = positiveInt(readArg("--min-works"), type === "director" ? 8 : 20);
const execute = !process.argv.includes("--dry-run");
const refresh = process.argv.includes("--refresh");

const retryRows = db.prepare(`
  SELECT facet_value AS value, next_retry_at AS nextRetryAt
  FROM entity_profile_enrichment WHERE facet_type = ?
`).all(type) as Array<{ value: string; nextRetryAt: string | null }>;
const retryByValue = new Map(retryRows.map((row) => [row.value, row.nextRetryAt]));
const now = new Date().toISOString();
const sourceItems = entity
  ? [{ value: entity, label: entity, aliases: [entity], mediaCount: 0 }]
  : getTopicGraphItems(type)
    .filter((item) => item.mediaCount >= minWorks)
    .filter((item) => refresh || !getEntityExtendedProfile(type, item.value))
    .filter((item) => refresh || !item.aliases.some((alias) => (retryByValue.get(alias) ?? "") > now))
    .sort((left, right) => right.mediaCount - left.mediaCount || left.value.localeCompare(right.value, "ja"));
const candidates = sourceItems.slice(offset, offset + limit);

console.log(`${execute ? "自动写入" : "只读演练"}${type}公开资料：${candidates.length} 条，至少 ${minWorks} 部作品`);
console.log(execute
  ? "规则处理唯一高置信匹配，歧义候选由本地 AI 自主选择或拒绝；不生成人工核验任务。\n"
  : "--dry-run 只检查抓取与判断结果，不写数据库。\n");

let matched = 0;
let rejected = 0;
for (const [index, candidate] of candidates.entries()) {
  const names = [...new Set([candidate.value, candidate.label, ...candidate.aliases].filter(Boolean))];
  try {
    const preview = await enrichPublicEntityFromWikimedia(type, candidate.value, names, execute);
    if (!preview.matched || !preview.profile) {
      rejected += 1;
      console.log(`[${index + 1}/${candidates.length}] ${candidate.label}：保持独立（${preview.reason ?? "证据不足"}）`);
      continue;
    }
    matched += 1;
    console.log([
      `[${index + 1}/${candidates.length}] ${candidate.label} → ${preview.profile.displayName} (${preview.profile.wikidataId})`,
      `  置信度 ${Math.round(preview.profile.confidence * 100)}% · ${preview.identityDecision?.method === "local-ai" ? "本地 AI 决策" : "唯一高置信匹配"}`,
      `  公开字段 ${Object.keys(preview.profile.facts).join("、") || "基础档案"} · ${execute ? "已写入" : "未写入"}`
    ].join("\n"));
  } catch (error) {
    rejected += 1;
    if (execute) recordEntityEnrichmentFailure(type, candidate.value, candidate.label, error);
    console.warn(`[${index + 1}/${candidates.length}] ${candidate.label}：${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\n完成：写入/命中 ${matched}，保持独立/失败 ${rejected}，模式=${execute ? "execute" : "dry-run"}`);
