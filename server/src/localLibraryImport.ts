import fs from "node:fs/promises";
import path from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { db, replaceMetadataFacetsForCode } from "./db.js";
import { decodeText } from "./services/subtitleService.js";

type Patch = Partial<Record<"title" | "summary" | "director" | "actors_json" | "genres_json" | "maker" | "label" | "series" | "release_date", string>>;
const list = (value: unknown): unknown[] => value == null ? [] : Array.isArray(value) ? value : [value];
const text = (value: unknown, limit = 10000): string => typeof value === "string" ? value.trim().slice(0, limit) : "";
const strings = (value: unknown): string[] => [...new Set(list(value).map(v => text(v, 300)).filter(Boolean))].slice(0, 100);

export function parseLocalNfo(xml: string): Patch {
  if (Buffer.byteLength(xml) > 256000 || /<!\s*(DOCTYPE|ENTITY)/i.test(xml)) throw new Error("Unsupported NFO declaration");
  if (XMLValidator.validate(xml) !== true) throw new Error("Invalid NFO XML");
  const document = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true }).parse(xml);
  const nfo = document.movie ?? document.episodedetails ?? document.musicvideo;
  if (!nfo || typeof nfo !== "object") throw new Error("Unsupported NFO type");
  const patch: Patch = {};
  for (const [target, value] of Object.entries({ title: nfo.title, summary: nfo.plot ?? nfo.outline, director: nfo.director, maker: nfo.studio, label: nfo.label, series: typeof nfo.set === "object" ? nfo.set?.name : nfo.set ?? nfo.showtitle })) {
    if (value !== undefined) patch[target as keyof Patch] = text(list(value)[0]);
  }
  if (nfo.actor !== undefined || nfo.artist !== undefined) patch.actors_json = JSON.stringify(strings([...list(nfo.actor).map(v => typeof v === "object" && v ? (v as { name?: unknown }).name : v), ...list(nfo.artist)]));
  if (nfo.genre !== undefined || nfo.tag !== undefined) patch.genres_json = JSON.stringify(strings([...list(nfo.genre), ...list(nfo.tag)]));
  const date = text(nfo.premiered ?? nfo.releasedate ?? nfo.year);
  if (/^\d{4}(?:-\d{2}-\d{2})?$/.test(date)) patch.release_date = date.length === 4 ? `${date}-01-01` : date;
  return patch;
}

export function parseLocalJson(value: unknown): Patch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a metadata object");
  const object = value as Record<string, unknown>, patch: Patch = {};
  for (const [source, target] of Object.entries({ title: "title", description: "summary", summary: "summary", director: "director", maker: "maker", studio: "maker", label: "label", collection: "series", series: "series" })) {
    if (object[source] !== undefined) {
      if (typeof object[source] !== "string") throw new Error(`Invalid metadata field: ${source}`);
      patch[target as keyof Patch] = text(object[source]);
    }
  }
  for (const [source, target] of Object.entries({ people: "actors_json", actors: "actors_json", tags: "genres_json", genres: "genres_json" })) {
    if (object[source] !== undefined) {
      if (!Array.isArray(object[source]) || !(object[source] as unknown[]).every(v => typeof v === "string")) throw new Error(`Invalid metadata field: ${source}`);
      patch[target as keyof Patch] = JSON.stringify(strings(object[source]));
    }
  }
  if (Number.isInteger(object.year) && Number(object.year) > 0 && Number(object.year) <= 9999) patch.release_date = `${String(object.year).padStart(4,"0")}-01-01`;
  return patch;
}

export function isLibraryArtwork(name: string, videoNames: string[]): boolean {
  if (!videoNames.length) return false;
  if (/^(poster|folder|cover|movie-poster|fanart|background|banner|landscape|clearlogo|disc)\.(jpg|jpeg|png|webp|tbn|svg)$/i.test(name)) return true;
  return videoNames.some(video => new RegExp(`^${path.parse(video).name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}[.-](poster|thumb|cover|fanart)\\.(jpg|jpeg|png|webp|tbn|svg)$`,"i").test(name));
}

export function ensureLocalImportSchema(): void {
  db.exec(`CREATE TABLE IF NOT EXISTS library_local_import (media_id TEXT PRIMARY KEY REFERENCES media_files(id) ON DELETE CASCADE, base_json TEXT NOT NULL, artwork_path TEXT NOT NULL DEFAULT '', warnings_json TEXT NOT NULL DEFAULT '[]', imported_at TEXT NOT NULL);`);
}

async function safeLocalFile(root: string, file: string): Promise<string> {
  const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
  const relative = path.relative(realRoot, realFile);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Sidecar is outside the media root");
  return realFile;
}

export async function importLocalLibrary(scanToken: string): Promise<void> {
  ensureLocalImportSchema();
  const directories = new Map<string, string[]>();
  const rows = db.prepare("SELECT id,absolute_path,source_root,normalized_code,basename,media_type FROM media_files WHERE scan_token=?").all(scanToken) as Array<{ id: string; absolute_path: string; source_root: string; normalized_code: string; basename: string; media_type: string }>;
  const videoCounts = new Map<string,number>();
  for (const row of rows) if (row.media_type === "video") { const dir = path.dirname(row.absolute_path); videoCounts.set(dir,(videoCounts.get(dir) ?? 0) + 1); }
  for (const media of rows) {
    const dir = path.dirname(media.absolute_path);
    let names = directories.get(dir);
    if (!names) { names = await fs.readdir(dir); directories.set(dir, names); }
    const lookup = (candidate: string) => names!.find(name => name.toLowerCase() === candidate.toLowerCase());
    const single = videoCounts.get(dir) === 1;
    const warnings: string[] = [];
    const patch: Patch = {};
    for (const [format, candidate] of [["nfo", lookup(media.basename + ".nfo") ?? (single ? lookup("movie.nfo") : undefined)], ["json", lookup(media.basename + ".media.json")]] as const) {
      if (!candidate) continue;
      try {
        const file = await safeLocalFile(media.source_root,path.join(dir,candidate));
        if ((await fs.stat(file)).size > 256000) throw new Error("Metadata exceeds 256 KB");
        const content = decodeText(await fs.readFile(file));
        Object.assign(patch,format === "nfo" ? parseLocalNfo(content) : parseLocalJson(JSON.parse(content)));
      } catch (error) { warnings.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    let artwork = "";
    const stems = [media.basename+"-poster",media.basename+".poster",media.basename+".cover",...(single ? ["poster","folder","cover","movie-poster"] : []),media.basename+"-thumb"];
    const candidates = stems.flatMap(stem => ["jpg","jpeg","png","webp","tbn"].map(ext => lookup(`${stem}.${ext}`))).filter(Boolean) as string[];
    if (candidates[0]) { try { artwork = await safeLocalFile(media.source_root,path.join(dir,candidates[0])); } catch { warnings.push("Artwork outside media root was ignored"); } }
    const previous = db.prepare("SELECT base_json FROM library_local_import WHERE media_id=?").get(media.id) as { base_json: string } | undefined;
    const base = previous ? JSON.parse(previous.base_json) as Patch : {};
    const current = db.prepare("SELECT * FROM media_metadata WHERE normalized_code=?").get(media.normalized_code) as Record<string, unknown> | undefined;
    // Leave externally acquired/curated metadata and user overrides in charge.
    if (Object.keys(patch).length && (!current || current.source === "local-import" || current.status !== "ready")) {
      const accepted = Object.fromEntries(Object.entries(patch).filter(([key]) => !current || current.source !== "local-import" || current[key] === base[key as keyof Patch] || current[key] === "" || current[key] === "[]"));
      const fields = Object.keys(accepted);
      if (fields.length) {
        db.prepare(`INSERT INTO media_metadata(normalized_code,source,provider,status,translation_status,updated_at,${fields.join(",")}) VALUES(?, 'local-import','local', 'ready','skipped',?,${fields.map(()=>"?").join(",")}) ON CONFLICT(normalized_code) DO UPDATE SET source='local-import',provider='local',status='ready',updated_at=excluded.updated_at,${fields.map(f=>`${f}=excluded.${f}`).join(",")}`).run(media.normalized_code,new Date().toISOString(),...Object.values(accepted));
        const updated = db.prepare("SELECT * FROM media_metadata WHERE normalized_code=?").get(media.normalized_code) as Record<string,string>;
        replaceMetadataFacetsForCode({ normalizedCode: media.normalized_code, actors: JSON.parse(updated.actors_json), genres: JSON.parse(updated.genres_json), director: updated.director, maker: updated.maker, label: updated.label, series: updated.series });
      }
    }
    db.prepare("INSERT OR REPLACE INTO library_local_import VALUES(?,?,?,?,?)").run(media.id,JSON.stringify({...base,...patch}),artwork,JSON.stringify(warnings),new Date().toISOString());
  }
}
