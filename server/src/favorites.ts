import fs from "node:fs";
import { db } from "./db.js";
import { config } from "./config.js";

function normalizeFavoriteKey(value: string): string {
  return value.replace(/\r/g, "").trim();
}

export function readFavoriteKeys(): Set<string> {
  fs.mkdirSync(config.dataDir, { recursive: true });

  if (!fs.existsSync(config.favoritesPath)) {
    return new Set();
  }

  const text = fs.readFileSync(config.favoritesPath, "utf8");
  const keys = text.split("\n").map(normalizeFavoriteKey).filter(Boolean);
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name='library_path_aliases'").get();
  if (!exists) return new Set(keys);
  const aliases = new Map((db.prepare("SELECT old_path,new_path FROM library_path_aliases").all() as Array<{old_path: string; new_path: string}>).map(row => [row.old_path,row.new_path]));
  return new Set(keys.map(key => aliases.get(key) ?? key));
}

export function writeFavoriteKeys(keys: Set<string>): void {
  fs.mkdirSync(config.dataDir, { recursive: true });

  const lines = [...keys].sort((a, b) => a.localeCompare(b));
  fs.writeFileSync(config.favoritesPath, `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`, "utf8");
}

export function setFavoriteKey(relativePath: string, favorite: boolean): Set<string> {
  const key = normalizeFavoriteKey(relativePath);
  const keys = readFavoriteKeys();

  if (!key) {
    return keys;
  }

  if (favorite) {
    keys.add(key);
  } else {
    keys.delete(key);
  }

  writeFavoriteKeys(keys);
  return keys;
}

export function parseFavoriteText(text: string): Set<string> {
  return new Set(text.split(/\r?\n/).map(normalizeFavoriteKey).filter(Boolean));
}
