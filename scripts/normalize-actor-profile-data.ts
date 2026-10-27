import { db } from "../server/src/db.js";
import { isActorNameCandidate } from "../server/src/actorAliases.js";
import { normalizeActorCup, type EntityExtendedProfile } from "../server/src/entityProfiles.js";

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

const execute = process.argv.includes("--execute");
const requestedValues = process.argv.flatMap((value, index, values) =>
  value === "--value" && values[index + 1] ? [values[index + 1]!] : []
);
const rows = db.prepare(`
  SELECT facet_value AS value, aliases_json AS aliasesJson, measurements_json AS measurementsJson
  FROM entity_profiles WHERE facet_type = 'actor'
    AND (@allValues = 1 OR facet_value IN (SELECT CAST(value AS TEXT) FROM json_each(@values)))
`).all({ allValues: requestedValues.length === 0 ? 1 : 0, values: JSON.stringify(requestedValues) }) as Array<{
  value: string; aliasesJson: string; measurementsJson: string;
}>;
const sourceRows = db.prepare(`
  SELECT provider, language, payload_json AS payloadJson
  FROM entity_profile_sources
  WHERE facet_type = 'actor' AND facet_value = ?
    AND json_extract(payload_json, '$.measurements.cup') IS NOT NULL
  ORDER BY CASE WHEN provider LIKE 'official-%' THEN 0 WHEN language = 'ja' THEN 1
    WHEN language = 'zh' THEN 2 ELSE 3 END, confidence DESC, retrieved_at DESC
`);
const update = db.prepare(`
  UPDATE entity_profiles SET aliases_json = ?, measurements_json = ?, updated_at = ?
  WHERE facet_type = 'actor' AND facet_value = ?
`);

let changed = 0;
let aliasesRemoved = 0;
let aliasesNormalized = 0;
let cupsNormalized = 0;
for (const row of rows) {
  const aliases = parseJson<string[]>(row.aliasesJson, []);
  const cleanAliases = [...new Set(aliases.map((value) => value.normalize("NFKC").trim())
    .filter(isActorNameCandidate))];
  const measurements = parseJson<EntityExtendedProfile["measurements"]>(row.measurementsJson, {});
  const rawCup = String(measurements.cup ?? "").trim();
  let cup = normalizeActorCup(rawCup);
  if (rawCup && !/^[A-Z]{1,3}\+*$/u.test(rawCup)) {
    for (const source of sourceRows.all(row.value) as Array<{ payloadJson: string }>) {
      const payload = parseJson<{ measurements?: { cup?: unknown } }>(source.payloadJson, {});
      const candidate = normalizeActorCup(typeof payload.measurements?.cup === "string" ? payload.measurements.cup : "");
      if (candidate) { cup = candidate; break; }
    }
  }
  const cleanMeasurements = { ...measurements };
  if (cup) cleanMeasurements.cup = cup;
  else delete cleanMeasurements.cup;
  const aliasChanged = JSON.stringify(cleanAliases) !== JSON.stringify(aliases);
  const cupChanged = JSON.stringify(cleanMeasurements) !== JSON.stringify(measurements);
  if (!aliasChanged && !cupChanged) continue;
  changed += 1;
  aliasesRemoved += aliases.length - cleanAliases.length;
  if (aliasChanged) aliasesNormalized += 1;
  if (cupChanged) cupsNormalized += 1;
  console.log(`${row.value}：${aliasChanged ? `规范别名并移除 ${aliases.length - cleanAliases.length} 个异常值` : "别名正常"}` +
    `${cupChanged ? ` · 罩杯 ${rawCup || "空"} → ${cup || "空"}` : ""}`);
  if (execute) update.run(JSON.stringify(cleanAliases), JSON.stringify(cleanMeasurements), new Date().toISOString(), row.value);
}

console.log(`${execute ? "已写入" : "只读预览"}：修改 ${changed} 条，规范别名 ${aliasesNormalized} 条，` +
  `移除异常别名 ${aliasesRemoved} 个，规范罩杯 ${cupsNormalized} 条`);
