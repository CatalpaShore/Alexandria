import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "amw-sidecar-check-"));
const sourceDir = path.join(root, "source");
const dataDir = path.join(root, "data");
fs.mkdirSync(sourceDir, { recursive: true });
fs.writeFileSync(path.join(sourceDir, "ABC-123.mp4"), "fixture");
fs.writeFileSync(
  path.join(sourceDir, "ABC-123.zh-CN.srt"),
  "1\n00:00:01,250 --> 00:00:03,500\nSubtitle fixture\n"
);
fs.writeFileSync(path.join(sourceDir, "ABC-123.nfo"), "<movie><title>Fixture</title></movie>\n");

process.env.DATA_DIR = dataDir;
process.env.MEDIA_SOURCES = `JAV:Fixture=${sourceDir}`;

const [
  { scanMediaLibrary },
  { db, rebuildMediaSearchIndex, refreshMediaSearchIndexForCode },
  { subtitleToVtt }
] = await Promise.all([
  import("../dist/server/scanner.js"),
  import("../dist/server/db.js"),
  import("../dist/server/productRoutes.js")
]);

try {
  const summary = await scanMediaLibrary();
  assert.equal(summary.indexed, 1);
  assert.equal(summary.sidecars, 2);

  const rows = db
    .prepare("SELECT kind, language, format FROM media_sidecars ORDER BY kind, format")
    .all();
  assert.deepEqual(rows, [
    { kind: "metadata", language: "", format: "nfo" },
    { kind: "subtitle", language: "zh-CN", format: "srt" }
  ]);

  rebuildMediaSearchIndex();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO metadata_overrides (normalized_code, patch_json, updated_at) VALUES (?, ?, ?)")
    .run("ABC-123", JSON.stringify({ titleZh: "增量索引测试" }), now);
  assert.equal(refreshMediaSearchIndexForCode("ABC-123"), 1);
  const searchMatch = db.prepare("SELECT media_id AS mediaId FROM media_search_fts WHERE media_search_fts MATCH ?")
    .get("增量索引");
  assert.ok(searchMatch?.mediaId);

  const vtt = subtitleToVtt(
    "1\n00:00:01,250 --> 00:00:03,500\nSubtitle fixture\n",
    "srt"
  );
  assert.ok(vtt.startsWith("WEBVTT\n\n"));
  assert.ok(vtt.includes("00:00:01.250 --> 00:00:03.500"));

  const ass = subtitleToVtt(
    "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:02.10,0:00:04.20,Default,,0,0,0,,ASS\\Nfixture",
    "ass"
  );
  assert.ok(ass.includes("00:00:02.100 --> 00:00:04.200"));
  assert.ok(ass.includes("ASS\nfixture"));

  console.log(JSON.stringify({
    ok: true,
    indexed: summary.indexed,
    sidecars: summary.sidecars,
    incrementalSearch: true
  }, null, 2));
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
