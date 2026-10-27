import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { Express } from "express";
import { z } from "zod";
import { db } from "./db.js";
import { readFavoriteKeys, writeFavoriteKeys } from "./favorites.js";

export const DEFAULT_USER_ID = "user-1";

const profileNameSchema = z.string().trim().min(1, "请输入用户名称").max(32, "用户名称不能超过 32 个字符");
const createUserSchema = z.object({ name: profileNameSchema });
const updateUserSchema = z.object({ name: profileNameSchema });

const personalTables = [
  "playback_progress",
  "saved_filters",
  "playlists",
  "playlist_items",
  "entity_favorites",
  "topic_covers",
  "recommendation_feedback",
  "viewing_sessions",
  "viewing_session_items",
  "viewing_arena_rounds"
] as const;

const clearOrder = [
  "viewing_arena_rounds",
  "viewing_session_items",
  "viewing_sessions",
  "recommendation_feedback",
  "topic_covers",
  "entity_favorites",
  "playlist_items",
  "playlists",
  "saved_filters",
  "playback_progress"
] as const;

type PersonalTable = (typeof personalTables)[number];
type ProfileKind = "persistent" | "guest";

type UserProfileRow = {
  id: string;
  name: string;
  kind: ProfileKind;
  snapshotJson: string;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string | null;
};

export type PersonalSnapshot = {
  version: 1;
  favorites: string[];
  tables: Partial<Record<PersonalTable, Array<Record<string, unknown>>>>;
};

export type UserProfileStats = {
  favoriteCount: number;
  entityFavoriteCount: number;
  playlistCount: number;
  playlistItemCount: number;
  watchCount: number;
  inProgressCount: number;
  completedCount: number;
  savedFilterCount: number;
  viewingSessionCount: number;
};

export type UserProfile = {
  id: string;
  name: string;
  kind: ProfileKind;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string | null;
  stats: UserProfileStats;
};

type FavoriteStore = {
  read(): Set<string>;
  write(keys: Set<string>): void;
};

function emptySnapshot(): PersonalSnapshot {
  return { version: 1, favorites: [], tables: {} };
}

export function parseUserSnapshot(value: string): PersonalSnapshot {
  try {
    const parsed = JSON.parse(value) as Partial<PersonalSnapshot>;
    if (parsed.version !== 1 || !parsed.tables || typeof parsed.tables !== "object") return emptySnapshot();
    return {
      version: 1,
      favorites: Array.isArray(parsed.favorites)
        ? parsed.favorites.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [],
      tables: parsed.tables
    };
  } catch {
    return emptySnapshot();
  }
}

export function summarizeUserSnapshot(snapshot: PersonalSnapshot): UserProfileStats {
  const playback = snapshot.tables.playback_progress ?? [];
  const readNumber = (row: Record<string, unknown>, key: string) => Number(row[key] ?? 0);
  return {
    favoriteCount: snapshot.favorites.length,
    entityFavoriteCount: snapshot.tables.entity_favorites?.length ?? 0,
    playlistCount: snapshot.tables.playlists?.length ?? 0,
    playlistItemCount: snapshot.tables.playlist_items?.length ?? 0,
    watchCount: playback.length,
    inProgressCount: playback.filter((row) => readNumber(row, "position_seconds") > 0 && readNumber(row, "completed") === 0).length,
    completedCount: playback.filter((row) => readNumber(row, "completed") === 1).length,
    savedFilterCount: snapshot.tables.saved_filters?.length ?? 0,
    viewingSessionCount: snapshot.tables.viewing_sessions?.length ?? 0
  };
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function createUserProfileManager(database: Database.Database, favoriteStore: FavoriteStore) {
  function tableExists(table: string): boolean {
    return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  }

  function captureSnapshot(): PersonalSnapshot {
    const tables: PersonalSnapshot["tables"] = {};
    for (const table of personalTables) {
      tables[table] = tableExists(table)
        ? database.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all() as Array<Record<string, unknown>>
        : [];
    }
    return {
      version: 1,
      favorites: [...favoriteStore.read()].sort((left, right) => left.localeCompare(right)),
      tables
    };
  }

  function clearPersonalTables(): void {
    for (const table of clearOrder) {
      if (tableExists(table)) database.prepare(`DELETE FROM ${quoteIdentifier(table)}`).run();
    }
  }

  function restoreTable(table: PersonalTable, rows: Array<Record<string, unknown>>): void {
    if (rows.length === 0 || !tableExists(table)) return;
    const availableColumns = new Set(
      (database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>).map((column) => column.name)
    );
    const columns = Object.keys(rows[0]).filter((column) => availableColumns.has(column));
    if (columns.length === 0) return;
    const sql = `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
    const insert = database.prepare(sql);
    for (const row of rows) insert.run(...columns.map((column) => row[column] ?? null));
  }

  function restoreSnapshot(snapshot: PersonalSnapshot): void {
    for (const table of personalTables) restoreTable(table, snapshot.tables[table] ?? []);
  }

  function readActiveId(): string {
    return (database.prepare("SELECT user_id AS userId FROM active_user_state WHERE id = 1").get() as { userId: string }).userId;
  }

  function readProfile(id: string): UserProfileRow | undefined {
    return database.prepare(`
      SELECT id, name, kind, snapshot_json AS snapshotJson, created_at AS createdAt,
        updated_at AS updatedAt, last_active_at AS lastActiveAt
      FROM user_profiles WHERE id = ?
    `).get(id) as UserProfileRow | undefined;
  }

  function activate(id: string): UserProfile {
    const target = readProfile(id);
    if (!target) throw new Error("用户不存在");
    const currentId = readActiveId();
    if (currentId === id) return getUsers().activeUser;
    const current = readProfile(currentId);
    const currentSnapshot = captureSnapshot();
    const targetSnapshot = parseUserSnapshot(target.snapshotJson);
    const now = new Date().toISOString();

    database.transaction(() => {
      if (current?.kind === "persistent") {
        database.prepare("UPDATE user_profiles SET snapshot_json = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(currentSnapshot), now, current.id);
      }
      clearPersonalTables();
      restoreSnapshot(targetSnapshot);
      database.prepare("UPDATE active_user_state SET user_id = ?, updated_at = ? WHERE id = 1").run(target.id, now);
      database.prepare("UPDATE user_profiles SET last_active_at = ?, updated_at = ? WHERE id = ?").run(now, now, target.id);
      if (current?.kind === "guest") database.prepare("DELETE FROM user_profiles WHERE id = ?").run(current.id);
    })();

    favoriteStore.write(new Set(targetSnapshot.favorites));
    return getUsers().activeUser;
  }

  function initialize(): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'persistent',
        snapshot_json TEXT NOT NULL DEFAULT '{"version":1,"favorites":[],"tables":{}}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_active_at TEXT
      );
      CREATE TABLE IF NOT EXISTS active_user_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        user_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const now = new Date().toISOString();
    database.prepare(`
      INSERT OR IGNORE INTO user_profiles (id, name, kind, snapshot_json, created_at, updated_at, last_active_at)
      VALUES (?, '用户1', 'persistent', ?, ?, ?, ?)
    `).run(DEFAULT_USER_ID, JSON.stringify(emptySnapshot()), now, now, now);
    database.prepare("INSERT OR IGNORE INTO active_user_state (id, user_id, updated_at) VALUES (1, ?, ?)")
      .run(DEFAULT_USER_ID, now);

    const active = readProfile(readActiveId());
    if (!active) {
      database.prepare("UPDATE active_user_state SET user_id = ?, updated_at = ? WHERE id = 1")
        .run(DEFAULT_USER_ID, now);
      return;
    }
    if (active.kind === "guest") activate(DEFAULT_USER_ID);
  }

  function getUsers(): { activeUser: UserProfile; users: UserProfile[] } {
    const activeId = readActiveId();
    const activeSnapshot = captureSnapshot();
    const rows = database.prepare(`
      SELECT id, name, kind, snapshot_json AS snapshotJson, created_at AS createdAt,
        updated_at AS updatedAt, last_active_at AS lastActiveAt
      FROM user_profiles ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, created_at ASC
    `).all(DEFAULT_USER_ID) as UserProfileRow[];
    const users = rows.map((row) => {
      const isActive = row.id === activeId;
      return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        isDefault: row.id === DEFAULT_USER_ID,
        isActive,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        lastActiveAt: row.lastActiveAt,
        stats: summarizeUserSnapshot(isActive ? activeSnapshot : parseUserSnapshot(row.snapshotJson))
      } satisfies UserProfile;
    });
    const activeUser = users.find((user) => user.isActive);
    if (!activeUser) throw new Error("当前用户状态无效");
    return { activeUser, users };
  }

  function createPersistent(name: string): UserProfile {
    const id = `user-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO user_profiles (id, name, kind, snapshot_json, created_at, updated_at, last_active_at)
      VALUES (?, ?, 'persistent', ?, ?, ?, NULL)
    `).run(id, name, JSON.stringify(emptySnapshot()), now, now);
    return getUsers().users.find((user) => user.id === id)!;
  }

  function startGuest(): UserProfile {
    const current = getUsers().activeUser;
    if (current.kind === "guest") return current;
    const id = `guest-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO user_profiles (id, name, kind, snapshot_json, created_at, updated_at, last_active_at)
      VALUES (?, '临时访客', 'guest', ?, ?, ?, NULL)
    `).run(id, JSON.stringify(emptySnapshot()), now, now);
    return activate(id);
  }

  function rename(id: string, name: string): UserProfile {
    const profile = readProfile(id);
    if (!profile) throw new Error("用户不存在");
    if (profile.kind === "guest") throw new Error("临时访客不能重命名");
    const now = new Date().toISOString();
    database.prepare("UPDATE user_profiles SET name = ?, updated_at = ? WHERE id = ?").run(name, now, id);
    return getUsers().users.find((user) => user.id === id)!;
  }

  function remove(id: string): void {
    if (id === DEFAULT_USER_ID) throw new Error("用户1不能删除");
    if (id === readActiveId()) throw new Error("请先切换到其他用户再删除当前用户");
    const result = database.prepare("DELETE FROM user_profiles WHERE id = ?").run(id);
    if (!result.changes) throw new Error("用户不存在");
  }

  return { initialize, getUsers, createPersistent, startGuest, activate, rename, remove };
}

const manager = createUserProfileManager(db, {
  read: readFavoriteKeys,
  write: writeFavoriteKeys
});

export function initializeUserProfiles(): void {
  manager.initialize();
}

export function getActiveUserProfile(): UserProfile {
  return manager.getUsers().activeUser;
}

export function registerUserRoutes(app: Express, options: { onDataChanged: () => void }): void {
  app.get("/api/users", (_req, res) => res.json(manager.getUsers()));

  app.post("/api/users", (req, res, next) => {
    try {
      const input = createUserSchema.parse(req.body ?? {});
      res.status(201).json(manager.createPersistent(input.name));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/users/guest", (_req, res, next) => {
    try {
      const user = manager.startGuest();
      options.onDataChanged();
      res.status(201).json(user);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/users/:id/activate", (req, res, next) => {
    try {
      const user = manager.activate(req.params.id);
      options.onDataChanged();
      res.json(user);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/users/:id", (req, res, next) => {
    try {
      const input = updateUserSchema.parse(req.body ?? {});
      res.json(manager.rename(req.params.id, input.name));
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/users/:id", (req, res, next) => {
    try {
      manager.remove(req.params.id);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });
}
