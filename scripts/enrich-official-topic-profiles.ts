import {
  enrichTopicFromOfficialSource,
  OFFICIAL_TOPIC_SOURCES,
  persistVerifiedOfficialTopicSnapshot
} from "../server/src/officialTopicSources.js";

const execute = !process.argv.includes("--dry-run");
const requestedType = process.argv.includes("--type") ? process.argv[process.argv.indexOf("--type") + 1] : "";
const requestedProvider = process.argv.includes("--provider") ? process.argv[process.argv.indexOf("--provider") + 1] : "";
const requestedValue = process.argv.includes("--value") ? process.argv[process.argv.indexOf("--value") + 1] : "";
const useVerifiedSnapshot = process.argv.includes("--verified-registry-snapshot");
const definitions = OFFICIAL_TOPIC_SOURCES.filter((item) =>
  (!requestedType || item.type === requestedType)
  && (!requestedProvider || item.provider === requestedProvider)
  && (!requestedValue || item.value === requestedValue)
);

console.log(`${execute ? "自动写入" : "只读演练"}${useVerifiedSnapshot ? "已核验注册表快照" : "官方专题资料"}：${definitions.length} 条`);
let matched = 0;
let failed = 0;
for (const [index, definition] of definitions.entries()) {
  try {
    const preview = useVerifiedSnapshot && execute
      ? persistVerifiedOfficialTopicSnapshot(definition)
      : await enrichTopicFromOfficialSource(definition, execute);
    matched += 1;
    console.log(`[${index + 1}/${definitions.length}] ${definition.type}:${definition.value} · matched · ${preview.source?.title}`);
  } catch (error) {
    failed += 1;
    console.log(`[${index + 1}/${definitions.length}] ${definition.type}:${definition.value} · failed · ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(`完成：成功 ${matched} · 失败 ${failed}`);
