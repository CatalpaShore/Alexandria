import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "../config.js";
import { preparePublicUpgrade } from "./upgrade.js";

function ensureRuntimeDirectories(): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.thumbnailDir, { recursive: true });
  fs.mkdirSync(config.derivativeDir, { recursive: true });
  fs.mkdirSync(config.posterVariantDir, { recursive: true });
  fs.mkdirSync(config.streamCacheDir, { recursive: true });
}

function createDatabase(): Database.Database {
  ensureRuntimeDirectories();
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  const database = new Database(config.databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  preparePublicUpgrade(database, config.databasePath);
  database.pragma("temp_store = MEMORY");
  database.pragma("cache_size = -32768");
  database.pragma("mmap_size = 134217728");
  return database;
}

export const db = createDatabase();
