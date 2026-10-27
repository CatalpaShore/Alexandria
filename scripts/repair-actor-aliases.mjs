import path from "node:path";
import Database from "better-sqlite3";
import { getCanonicalActorName } from "./lib/actor-aliases.mjs";

const databasePath = path.resolve(process.env.METADATA_DB_PATH ?? ".local/data/media-wall.sqlite");
const dryRun = process.env.DRY_RUN === "true";
const db = new Database(databasePath);
const rows = db.prepare(`
  SELECT normalized_code AS normalizedCode, actors_json AS actorsJson, actors_zh_json AS actorsZhJson
  FROM media_metadata
  WHERE status = 'ready' AND json_valid(actors_json) AND json_valid(actors_zh_json)
`).all();
const update = db.prepare(`
  UPDATE media_metadata
  SET actors_zh_json = @actorsZhJson, updated_at = @updatedAt
  WHERE normalized_code = @normalizedCode
`);
const changes = [];

const repair = db.transaction(() => {
  for (const row of rows) {
    const actors = JSON.parse(row.actorsJson);
    const actorsZh = JSON.parse(row.actorsZhJson);
    if (!Array.isArray(actors) || !Array.isArray(actorsZh)) continue;
    const next = actors.map((actor, index) =>
      getCanonicalActorName(actor, actorsZh[index]) || actorsZh[index] || actor
    );
    if (JSON.stringify(next) === JSON.stringify(actorsZh)) continue;
    changes.push({ normalizedCode: row.normalizedCode, before: actorsZh, after: next });
    if (!dryRun) {
      update.run({
        normalizedCode: row.normalizedCode,
        actorsZhJson: JSON.stringify(next),
        updatedAt: new Date().toISOString()
      });
    }
  }
  if (!dryRun && changes.length > 0) {
    db.prepare("DELETE FROM app_cache_state WHERE cache_key = 'topic-stats:actor'").run();
    db.prepare("DELETE FROM topic_stats WHERE facet_type = 'actor'").run();
  }
});

repair();
console.log(JSON.stringify({ databasePath, dryRun, repaired: changes.length, sample: changes.slice(0, 20) }, null, 2));
db.close();
