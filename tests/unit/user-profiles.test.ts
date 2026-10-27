import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createUserProfileManager, DEFAULT_USER_ID } from "../../server/src/userProfiles.js";

const databases: Database.Database[] = [];

function createFixture() {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(`
    CREATE TABLE playback_progress (relative_path TEXT PRIMARY KEY, position_seconds REAL, completed INTEGER);
    CREATE TABLE saved_filters (id TEXT PRIMARY KEY);
    CREATE TABLE playlists (id TEXT PRIMARY KEY);
    CREATE TABLE playlist_items (playlist_id TEXT, media_id TEXT);
    CREATE TABLE entity_favorites (facet_type TEXT, facet_value TEXT);
    CREATE TABLE topic_covers (facet_type TEXT, facet_value TEXT);
    CREATE TABLE recommendation_feedback (anchor_id TEXT, media_id TEXT);
    CREATE TABLE viewing_sessions (id TEXT PRIMARY KEY);
    CREATE TABLE viewing_session_items (session_id TEXT, media_id TEXT);
    CREATE TABLE viewing_arena_rounds (session_id TEXT, round_index INTEGER);
  `);
  let favorites = new Set<string>();
  const manager = createUserProfileManager(database, {
    read: () => new Set(favorites),
    write: (keys) => { favorites = new Set(keys); }
  });
  manager.initialize();
  return {
    database,
    manager,
    getFavorites: () => [...favorites].sort(),
    setFavorites: (keys: string[]) => { favorites = new Set(keys); }
  };
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

describe("用户资料切换", () => {
  it("把迁移前的个人数据保留为用户1，并隔离正式用户的数据", () => {
    const fixture = createFixture();
    fixture.database.prepare("INSERT INTO playback_progress VALUES (?, ?, ?)").run("user1.mp4", 125, 0);
    fixture.database.prepare("INSERT INTO playlists VALUES (?)").run("favorites-list");
    fixture.database.prepare("INSERT INTO entity_favorites VALUES (?, ?)").run("actor", "演员A");
    fixture.setFavorites(["user1.mp4"]);

    const user1 = fixture.manager.getUsers().activeUser;
    expect(user1.id).toBe(DEFAULT_USER_ID);
    expect(user1.name).toBe("用户1");
    expect(user1.stats).toMatchObject({ favoriteCount: 1, playlistCount: 1, entityFavoriteCount: 1, watchCount: 1 });

    const user2 = fixture.manager.createPersistent("用户2");
    fixture.manager.activate(user2.id);
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM playback_progress").get()).toEqual({ count: 0 });
    expect(fixture.getFavorites()).toEqual([]);

    fixture.database.prepare("INSERT INTO playback_progress VALUES (?, ?, ?)").run("user2.mp4", 0, 1);
    fixture.setFavorites(["user2.mp4"]);
    fixture.manager.activate(DEFAULT_USER_ID);

    expect(fixture.database.prepare("SELECT relative_path AS path FROM playback_progress").all()).toEqual([{ path: "user1.mp4" }]);
    expect(fixture.getFavorites()).toEqual(["user1.mp4"]);
    expect(fixture.manager.getUsers().users.find((user) => user.id === user2.id)?.stats.completedCount).toBe(1);
  });

  it("离开临时访客时丢弃访客记录并恢复用户1", () => {
    const fixture = createFixture();
    fixture.database.prepare("INSERT INTO playback_progress VALUES (?, ?, ?)").run("kept.mp4", 42, 0);
    fixture.setFavorites(["kept.mp4"]);

    const guest = fixture.manager.startGuest();
    expect(guest.kind).toBe("guest");
    fixture.database.prepare("INSERT INTO playback_progress VALUES (?, ?, ?)").run("guest.mp4", 99, 0);
    fixture.setFavorites(["guest.mp4"]);

    fixture.manager.activate(DEFAULT_USER_ID);

    expect(fixture.database.prepare("SELECT relative_path AS path FROM playback_progress").all()).toEqual([{ path: "kept.mp4" }]);
    expect(fixture.getFavorites()).toEqual(["kept.mp4"]);
    expect(fixture.manager.getUsers().users.some((user) => user.id === guest.id)).toBe(false);
  });
});
