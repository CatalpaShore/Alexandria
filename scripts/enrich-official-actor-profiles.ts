import {
  enrichActorFromOfficialSource,
  OFFICIAL_ACTOR_SOURCES,
  type OfficialActorSourceId
} from "../server/src/officialEntitySources.js";

function readArg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? "" : null;
}

const execute = !process.argv.includes("--dry-run");
const requestedActor = readArg("--actor");
const requestedSource = readArg("--source") as OfficialActorSourceId | null;
const knownSources = new Set(OFFICIAL_ACTOR_SOURCES.map((item) => item.id));
if (requestedSource && !knownSources.has(requestedSource)) {
  throw new Error(`未知官方来源：${requestedSource}`);
}
const selected = OFFICIAL_ACTOR_SOURCES.filter((item) =>
  (!requestedActor || item.actorValue === requestedActor) && (!requestedSource || item.id === requestedSource)
);
if (!selected.length) throw new Error("没有匹配的预核验官方人物来源");

console.log(`${execute ? "自动写入" : "只读演练"}官方人物资料：${selected.length} 条`);
if (!execute) console.log("--dry-run 仅用于检查解析结果，不构成人工核验步骤。\n");

let matched = 0;
let failed = 0;
for (const [index, definition] of selected.entries()) {
  try {
    const result = await enrichActorFromOfficialSource(definition, execute);
    if (!result.matched || !result.profile) {
      failed += 1;
      console.log(`[${index + 1}/${selected.length}] ${definition.actorValue} · 未匹配 · ${result.reason ?? "未知原因"}`);
      continue;
    }
    matched += 1;
    const measurements = result.profile.measurements;
    const sizes = [measurements.bustCm, measurements.waistCm, measurements.hipsCm].every((value) => value != null)
      ? `${measurements.bustCm}/${measurements.waistCm}/${measurements.hipsCm}${measurements.cup ? ` (${measurements.cup})` : ""}`
      : "缺失";
    console.log(`[${index + 1}/${selected.length}] ${definition.actorValue} · ${definition.agency} · matched`);
    console.log(`  URL ${definition.sourceUrl}`);
    console.log(`  日文名 ${result.profile.names.ja ?? "缺失"} · 罗马字 ${result.profile.names.en ?? "缺失"}`);
    console.log(`  生日 ${result.profile.birthDate ?? "缺失"} · 身高 ${result.profile.heightCm ?? "缺失"} · 三围 ${sizes}`);
    console.log(`  社交 ${Object.entries(result.profile.socialLinks).map(([key, value]) => `${key}:${value}`).join(" · ") || "缺失"}`);
    console.log(`  官方主图候选 ${typeof result.profile.facts.profileImageCandidateUrl === "string"
      ? result.profile.facts.profileImageCandidateUrl : "缺失"}`);
  } catch (error) {
    failed += 1;
    console.warn(`[${index + 1}/${selected.length}] ${definition.actorValue} · failed · ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\n完成：匹配 ${matched} · 失败 ${failed} · ${execute ? "已写入" : "未写数据库"}`);
if (failed) process.exitCode = 1;
