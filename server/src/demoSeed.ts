import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import { db } from "./db.js";
import { readFavoriteKeys, writeFavoriteKeys } from "./favorites.js";
import { generateViewingSession, discoveryRouteTestUtils } from "./discoveryRoutes.js";
import { clearTopicCaches } from "./productRoutes.js";

type DemoFilm = {
  slug: string; title: string; year: number; director: string; actors: string[];
  tags: string[]; collection: string; summary: string; source: string; credits: string; studio: string;
  artwork: { file: string; sha256: string; originalUrl: string; license: string; licenseUrl: string; licenseSource: string; attribution: string; changes: string };
};
export function readDemoFilmCatalog(): DemoFilm[] {
  const file = ["client/public/demo/films/catalog.json", "dist/client/demo/films/catalog.json"].find(file => fs.existsSync(file));
  if (!file) throw new Error("Missing reviewed film catalog");
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { films: DemoFilm[] }).films;
}
const stem = (film: DemoFilm, index: number) => path.join(film.collection, `DEMO-${String(index + 1).padStart(3, "0")}-${film.slug}`);

export function verifyDemoAssets(): void {
  const base = path.resolve(".local/public-demo"), root = path.join(base, "movies");
  const manifest = JSON.parse(fs.readFileSync(path.join(base, "film-manifest.json"), "utf8")) as { kind: string; files: Array<{file: string; sha256: string}> };
  const expected = new Set(readDemoFilmCatalog().flatMap((film, index) => {
    const base = stem(film, index);
    return [base + ".mp4", base + ".media.json", base + "-poster.png", ...["zh", "en", "ja"].map(lang => base + `.${lang}.srt`)];
  }));
  if (manifest.kind !== "alexandria-open-film-mock-v2" || manifest.files.length !== expected.size) throw new Error("Prepare the verified film demo first: pnpm demo:prepare");
  if (fs.lstatSync(base).isSymbolicLink() || fs.lstatSync(root).isSymbolicLink()) throw new Error("Demo roots cannot be symbolic links");
  const realRoot = fs.realpathSync(root), seen = new Set<string>();
  function visit(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Demo assets cannot use symbolic links");
      if (entry.isDirectory()) visit(file);
      else if (!expected.has(path.relative(root, file))) throw new Error("Unexpected demo content");
    }
  }
  visit(root);
  for (const item of manifest.files) {
    if (!expected.has(item.file) || seen.has(item.file)) throw new Error("Unexpected or duplicate demo asset");
    seen.add(item.file);
    const file = path.resolve(root, item.file);
    if (!file.startsWith(root + path.sep) || !fs.realpathSync(file).startsWith(realRoot + path.sep)) throw new Error("Demo content must stay inside its own directory");
    if (crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== item.sha256) throw new Error("Demo content changed; recreate a clean demo");
  }
}

export function demoFilmExperience() {
  if (!config.demoMode) return { films: [] };
  const rows = db.prepare("SELECT media_files.id,media_files.relative_path,playback_progress.completed,playback_progress.last_played_at FROM media_files LEFT JOIN playback_progress ON playback_progress.media_id=media_files.id").all() as Array<{id: string; relative_path: string; completed: number | null; last_played_at: string | null}>;
  const favorites = readFavoriteKeys();
  return { films: readDemoFilmCatalog().map((film, index) => {
    const row = rows.find(row => row.relative_path.endsWith(stem(film, index) + ".mp4"));
    return { ...film, mediaId: row?.id ?? null, favorite: row ? favorites.has(row.relative_path) : false, completed: Boolean(row?.completed), lastPlayedAt: row?.last_played_at ?? "" };
  }) };
}

export function seedDemoExperience(): void {
  if (!config.demoMode) return;
  const films = readDemoFilmCatalog();
  const all = db.prepare("SELECT id,relative_path,normalized_code FROM media_files").all() as Array<{id: string; relative_path: string; normalized_code: string}>;
  const rows = films.map((film, index) => {
    const row = all.find(row => row.relative_path.endsWith(stem(film, index) + ".mp4"));
    if (!row) throw new Error("Demo catalog scan is incomplete");
    return { ...row, film };
  });
  const now = new Date().toISOString();
  writeFavoriteKeys(new Set(rows.filter((_, index) => [0, 1, 2, 3, 6, 7].includes(index)).map(item => item.relative_path)));
  db.transaction(() => {
    const collections = [
      { id: "demo-weekend", name: "周末动画小剧场", description: "轻松的开放电影精选 · 模拟片单", slugs: ["big-buck-bunny", "wing-it", "glass-half", "caminandes-3"] },
      { id: "demo-fantasy", name: "奇幻与远行", description: "山林、旅途与未知世界 · 模拟片单", slugs: ["sintel", "spring", "cosmos-laundromat"] },
      { id: "demo-art", name: "动画的不同可能", description: "从手绘到科幻 · 模拟片单", slugs: ["hero", "charge", "coffee-run", "elephants-dream"] }
    ];
    for (const collection of collections) {
      db.prepare("INSERT OR IGNORE INTO playlists(id,name,description,created_at,updated_at) VALUES(?,?,?,?,?)").run(collection.id, collection.name, collection.description, now, now);
      collection.slugs.forEach((slug, index) => db.prepare("INSERT OR IGNORE INTO playlist_items VALUES(?,?,?,?)").run(collection.id, rows.find(row => row.film.slug === slug)!.id, index, now));
    }
    rows.slice(0, 8).forEach((row, index) => {
      const played = new Date(Date.now() - index * 86400000).toISOString();
      db.prepare("INSERT OR REPLACE INTO playback_progress VALUES(?,?,?,?,?,?,?,?)").run(row.relative_path, row.id, index % 3 === 0 ? 12 : 3 + index % 7, 12, Number(index % 3 === 0), 1 + index % 4, played, now);
    });
    for (const row of rows) {
      db.prepare("UPDATE media_metadata SET homepage=?,release_date=? WHERE normalized_code=?").run(row.film.source, String(row.film.year), row.normalized_code);
      for (const [type, names] of [["actor", row.film.actors], ["director", [row.film.director]], ["series", [row.film.collection]]] as const) {
        for (const name of names) {
          const related = rows.filter(item => type === "actor" ? item.film.actors.includes(name) : type === "director" ? item.film.director === name : item.film.collection === name);
          const biography = type === "series" ? (name === "Caminandes" ? "Caminandes 动画短片系列。本 Demo 展示 Gran Dillama 与 Llamigos 两部作品。" : "Demo 编辑主题，用于组织真实开放电影；不是官方系列归属。") : `${type === "actor" ? "配音演职人员" : "导演"}。相关开放电影：${related.map(item => item.film.title).join("、")}。资料来源：Blender Studio 官方演职员表。`;
          db.prepare("INSERT OR REPLACE INTO entity_profiles(facet_type,facet_value,display_name,biography,official_website,source_status,confidence,updated_at) VALUES(?,?,?,?,?,'manual',1,?)").run(type, name, name, biography, row.film.credits, now);
        }
      }
    }
    for (const [type, value] of [["director", "Hjalti Hjálmarsson"], ["series", "Caminandes"], ["genre", "奇幻"], ["actor", "Halina Reijn"]]) db.prepare("INSERT OR IGNORE INTO entity_favorites VALUES(?,?,?,?)").run(type, value, value, now);
    db.prepare("UPDATE user_profiles SET name='演示访客'").run();
  })();
  clearTopicCaches();
  generateViewingSession(discoveryRouteTestUtils.viewingConfigSchema.parse({ preset: "explore", excludeRecentlyWatched: false }));
}
