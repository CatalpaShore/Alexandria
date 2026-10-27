import fs from "node:fs";
import type Database from "better-sqlite3";
import { fileHash } from "./services/fileIdentity.js";

export function ensureLibraryIdentitySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS library_file_identity (
      media_id TEXT PRIMARY KEY REFERENCES media_files(id) ON DELETE CASCADE,
      sha256 TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_library_identity_hash ON library_file_identity(sha256);
    CREATE TABLE IF NOT EXISTS library_path_aliases (old_path TEXT PRIMARY KEY, new_path TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS library_availability (
      media_id TEXT PRIMARY KEY REFERENCES media_files(id) ON DELETE CASCADE,
      available INTEGER NOT NULL, checked_at TEXT NOT NULL
    );
  `);
}

type IdentityRow = { id: string; absolute_path: string; relative_path: string; library_category: string; source_name: string; size: number; mtime_ms: number; sha256: string; scan_token: string };

export async function recordFileIdentity(db: Database.Database, media: Pick<IdentityRow, "id" | "absolute_path" | "size" | "mtime_ms">): Promise<void> {
  const old = db.prepare("SELECT size,mtime_ms FROM library_file_identity WHERE media_id=?").get(media.id) as { size: number; mtime_ms: number } | undefined;
  if (old?.size === media.size && old.mtime_ms === media.mtime_ms) return;
  const sha256 = await fileHash(media.absolute_path);
  // Do not cache a hash under a stale stat if a copy completed during the scan.
  const stat = fs.statSync(media.absolute_path);
  if (stat.size !== media.size || Math.round(stat.mtimeMs) !== media.mtime_ms) throw new Error("Media changed during scan");
  db.prepare("INSERT OR REPLACE INTO library_file_identity VALUES(?,?,?,?)").run(media.id, sha256, media.size, media.mtime_ms);
}

function missing(file: string): boolean {
  try { fs.statSync(file); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}

// Match only one missing old record to one genuinely new file with the full
// same-content hash. Duplicates remain separate and are never guessed.
export function reconcileLibraryMoves(db: Database.Database, scanToken: string, oldIds: Set<string>): number {
  const rows = db.prepare(`SELECT m.*,i.sha256 FROM media_files m JOIN library_file_identity i ON i.media_id=m.id`).all() as IdentityRow[];
  const groups = new Map<string, { old: IdentityRow[]; fresh: IdentityRow[] }>();
  for (const row of rows) {
    const key = `${row.library_category}\0${row.sha256}`;
    const group = groups.get(key) ?? { old: [], fresh: [] };
    if (oldIds.has(row.id) && row.scan_token !== scanToken) group.old.push(row);
    if (!oldIds.has(row.id) && row.scan_token === scanToken) group.fresh.push(row);
    groups.set(key, group);
  }
  let relinked = 0;
  db.transaction(() => {
    for (const group of groups.values()) {
      if (group.old.length !== 1 || group.fresh.length !== 1) continue;
      const old = group.old[0], fresh = group.fresh[0];
      if (!missing(old.absolute_path) && old.absolute_path !== fresh.absolute_path) continue;
      const userTables = ["playback_progress", "playlist_items", "viewing_session_items", "topic_covers"];
      if (userTables.some(table => db.prepare(`SELECT 1 FROM ${table} WHERE media_id=? LIMIT 1`).get(fresh.id))) continue;
      // Existing foreign keys keep pointing at the proven ID. The temporary new
      // row has no user state and can be removed before its unique path is reused.
      db.prepare("DELETE FROM media_files WHERE id=?").run(fresh.id);
      db.prepare(`UPDATE media_files SET source_root=?,source_name=?,relative_path=?,absolute_path=?,name=?,basename=?,directory=?,size=?,mtime_ms=?,scan_token=? WHERE id=?`).run(
        (fresh as unknown as Record<string, unknown>).source_root, fresh.source_name, fresh.relative_path, fresh.absolute_path,
        (fresh as unknown as Record<string, unknown>).name, (fresh as unknown as Record<string, unknown>).basename,
        (fresh as unknown as Record<string, unknown>).directory, fresh.size, fresh.mtime_ms, scanToken, old.id
      );
      db.prepare("UPDATE library_path_aliases SET new_path=? WHERE new_path=?").run(fresh.relative_path,old.relative_path);
      db.prepare("INSERT OR REPLACE INTO library_path_aliases VALUES(?,?)").run(old.relative_path,fresh.relative_path);
      db.prepare("UPDATE playback_progress SET relative_path=? WHERE relative_path=? AND NOT EXISTS(SELECT 1 FROM playback_progress WHERE relative_path=?)").run(fresh.relative_path,old.relative_path,fresh.relative_path);
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='user_profiles'").get()) {
        for (const profile of db.prepare("SELECT id,snapshot_json FROM user_profiles").all() as Array<{id:string;snapshot_json:string}>) {
          const snapshot = JSON.parse(profile.snapshot_json, (_key,value) => value === old.relative_path ? fresh.relative_path : value);
          db.prepare("UPDATE user_profiles SET snapshot_json=? WHERE id=?").run(JSON.stringify(snapshot),profile.id);
        }
      }
      relinked += 1;
    }
    db.prepare(`INSERT OR REPLACE INTO library_availability SELECT id,CASE WHEN scan_token=? THEN 1 ELSE 0 END,? FROM media_files`).run(scanToken,new Date().toISOString());
  })();
  return relinked;
}
