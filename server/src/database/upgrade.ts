import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

// Keep the legacy schema and IDs. Back up a populated database before the
// public edition adds tables; VACUUM INTO includes committed WAL contents.
export function preparePublicUpgrade(database: Database.Database, databasePath: string): void {
  const marker = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='alexandria_schema'").get();
  if (marker) {
    const row = database.prepare("SELECT version FROM alexandria_schema WHERE id=1").get() as { version: number } | undefined;
    if (!row || row.version > 1) throw new Error("Unsupported Alexandria 18+ database version; restore using its owning version.");
    return;
  }
  const legacy = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='media_files'").get();
  if (legacy) {
    const directory = path.join(path.dirname(databasePath), "upgrade-backups");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, `before-public-v1-${Date.now()}.sqlite`);
    database.prepare("VACUUM INTO ?").run(target);
    fs.chmodSync(target, 0o600);
  }
  database.exec("CREATE TABLE alexandria_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL); INSERT INTO alexandria_schema VALUES(1,1)");
}
