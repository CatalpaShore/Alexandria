import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type TestUtils = typeof import("../../server/src/discoveryRoutes.js").discoveryRouteTestUtils;

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "amw-discovery-routes-"));
let utils: TestUtils;

beforeAll(async () => {
  process.env.DATA_DIR = testDataDir;
  process.env.THUMBNAIL_DIR = path.join(testDataDir, "thumbnails");
  process.env.DERIVATIVE_DIR = path.join(testDataDir, "derivatives");
  process.env.COVER_CACHE_DIR = path.join(testDataDir, "covers");
  utils = (await import("../../server/src/discoveryRoutes.js")).discoveryRouteTestUtils;
});

afterAll(async () => {
  const { db } = await import("../../server/src/db.js");
  db.close();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

describe("knowledge graph route contracts", () => {
  it("keeps year-only film dates without accepting malformed or future releases", async () => {
    const { db } = await import("../../server/src/db.js");
    const query = db.prepare(`SELECT release_date FROM (SELECT ? AS release_date) media_metadata WHERE ${utils.knownGraphReleaseSql()}`);
    for (const value of ["2006", "2019", "2010-09-30"]) expect(query.get(value), value).toBeDefined();
    for (const value of ["", "0000", "9999", "2010-02", "2010-02-30", "2010-13-01", "not-a-date", "9999-01-01"]) expect(query.get(value), value).toBeUndefined();
  });
  it("defaults viewing routes to a 24-item three-lane candidate pool", () => {
    expect(utils.viewingConfigSchema.parse({}).limit).toBe(24);
  });

  it("accepts flexible facet anchors with a larger recommendation set", () => {
    expect(utils.viewingConfigSchema.parse({
      preset: "explore",
      durationMinutes: 90,
      category: "JAV",
      excludeRecentlyWatched: true,
      favoriteBias: true,
      limit: 24,
      preferredGenre: "剧情",
      preferredActor: "测试演员",
      preferredSeries: "测试系列",
      preferredDirector: "测试导演",
      preferredMaker: "测试厂商",
      preferredLabel: "测试厂牌",
      focusLane: "adjacent"
    })).toMatchObject({
      limit: 24,
      preferredGenre: "剧情",
      preferredActor: "测试演员",
      preferredSeries: "测试系列",
      preferredDirector: "测试导演",
      preferredMaker: "测试厂商",
      preferredLabel: "测试厂牌",
      focusLane: "adjacent"
    });
  });

  it("supports explicit Arena decisions, rerolls, and result-lane branching", () => {
    expect(utils.viewingArenaChoiceSchema.parse({ roundIndex: 3, action: "both" })).toMatchObject({ action: "both" });
    expect(utils.viewingArenaChoiceSchema.parse({ roundIndex: 3, action: "reject" })).toMatchObject({ action: "reject" });
    expect(utils.viewingArenaChoiceSchema.parse({ roundIndex: 3, action: "reroll" })).toMatchObject({ action: "reroll" });
    expect(() => utils.viewingArenaChoiceSchema.parse({ roundIndex: 3, action: "choose" })).toThrow("winnerMediaId");
    expect(utils.viewingBranchSchema.parse({ lane: "wildcard" })).toEqual({ lane: "wildcard" });
  });

  it("round-trips opaque offset cursors and rejects malformed values", () => {
    const cursor = utils.encodeGraphCursor(42);
    expect(utils.decodeGraphCursor(cursor)).toBe(42);
    expect(() => utils.decodeGraphCursor("not-a-cursor")).toThrow("Invalid pagination cursor");
  });

  it("accepts ordered year ranges and rejects reversed ranges", () => {
    expect(utils.graphYearRangeSchema.parse({ yearFrom: "2018", yearTo: "2024" })).toEqual({
      yearFrom: 2018,
      yearTo: 2024
    });
    expect(() => utils.graphYearRangeSchema.parse({ yearFrom: 2025, yearTo: 2020 })).toThrow(
      "yearFrom must be less than or equal to yearTo"
    );
  });

  it("labels supported same-dimension relations explicitly", () => {
    expect(utils.relationDescriptor("actor", "actor")).toEqual({
      relationType: "actor_collaboration",
      relationLabel: "合作演员"
    });
    expect(utils.relationDescriptor("genre", "genre")).toEqual({
      relationType: "genre_cooccurrence",
      relationLabel: "共现标签"
    });
    expect(utils.relationDescriptor("maker", "maker")).toBeNull();
  });

  it("provides a stable relation type and label for every cross-dimension pair", () => {
    const types = ["actor", "series", "genre", "director", "maker", "label"] as const;
    for (let left = 0; left < types.length; left += 1) {
      for (let right = left + 1; right < types.length; right += 1) {
        expect(utils.relationDescriptor(types[left], types[right])).toMatchObject({
          relationType: expect.stringMatching(/^[a-z]+_[a-z]+$/),
          relationLabel: expect.any(String)
        });
      }
    }
  });

  it("deletes a viewing preference and promotes the newest remaining session", async () => {
    const { db } = await import("../../server/src/db.js");
    const config = JSON.stringify({ preset: "quick", durationMinutes: 30, category: "ALL", excludeRecentlyWatched: true, favoriteBias: false, limit: 8 });
    db.prepare("INSERT INTO viewing_sessions (id, preset, config_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("older-session", "quick", config, "archived", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    db.prepare("INSERT INTO viewing_sessions (id, preset, config_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("active-session", "quick", config, "active", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z");

    const result = utils.deleteViewingSession("active-session");

    expect(result?.deletedId).toBe("active-session");
    expect(result?.session?.id).toBe("older-session");
    expect(result?.session?.status).toBe("active");
    expect(db.prepare("SELECT COUNT(*) AS count FROM viewing_sessions WHERE id = ?").get("active-session"))
      .toEqual({ count: 0 });
  });

  it("provides temporary behavior signals without writing user history during cold start", async () => {
    const { db } = await import("../../server/src/db.js");
    const before = db.prepare("SELECT COUNT(*) AS count FROM playback_progress").get();

    const bootstrap = utils.loadViewingBootstrap();

    expect(bootstrap).toMatchObject({
      coldStart: true,
      realSignalCount: 0,
      exitThreshold: 4,
      signals: [
        { id: "browse", simulated: true },
        { id: "favorite", simulated: true },
        { id: "pace", simulated: true }
      ]
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM playback_progress").get()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM entity_favorites").get()).toEqual({ count: 0 });
  });

  it("keeps replaced-item feedback as hidden history while exposing only the refreshed lane", async () => {
    const { db } = await import("../../server/src/db.js");
    const insertMedia = db.prepare(`INSERT INTO media_files
      (id, relative_path, absolute_path, name, basename, extension, mime_type, size, mtime_ms,
       directory, first_letter, normalized_code, media_type, indexed_at, scan_token)
      VALUES (?, ?, ?, ?, ?, 'mp4', 'video/mp4', 1, 1, '/', 'T', ?, 'video', ?, 'test')`);
    const now = "2026-08-17T09:00:00.000Z";
    insertMedia.run("feedback-old", "feedback-old.mp4", "/feedback-old.mp4", "feedback-old.mp4", "feedback-old", "TEST-OLD", now);
    insertMedia.run("feedback-new", "feedback-new.mp4", "/feedback-new.mp4", "feedback-new.mp4", "feedback-new", "TEST-NEW", now);
    db.prepare("INSERT INTO viewing_sessions (id, preset, config_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("feedback-history-session", "quick", JSON.stringify({ preset: "quick", limit: 6 }), "archived", now, now);
    db.prepare(`INSERT INTO viewing_session_items
      (session_id, media_id, position, lane, reason, score, feedback, created_at, updated_at)
      VALUES (?, ?, 0, 'core', 'old', 10, 'dislike', ?, ?)`)
      .run("feedback-history-session", "feedback-old", now, now);

    const writeItems = utils.writeViewingSessionItems as unknown as (
      sessionId: string,
      items: Array<{ id: string; lane: "core" | "adjacent" | "wildcard"; reason: string; score: number }>,
      updatedAt: string
    ) => void;
    writeItems("feedback-history-session", [{ id: "feedback-new", lane: "adjacent", reason: "new", score: 20 }], now);

    expect(db.prepare(`SELECT media_id AS mediaId, position, feedback FROM viewing_session_items
      WHERE session_id = ? ORDER BY position`).all("feedback-history-session")).toEqual([
      { mediaId: "feedback-old", position: -1, feedback: "dislike" },
      { mediaId: "feedback-new", position: 0, feedback: "" }
    ]);
    expect(utils.loadViewingSession("feedback-history-session")?.items.map((item) => item.mediaId))
      .toEqual(["feedback-new"]);
  });

  it("updates legacy Arena prompts and recommendation reasons when a saved session is reopened", async () => {
    const { db } = await import("../../server/src/db.js");
    const now = "2026-08-17T10:00:00.000Z";
    const insertMedia = db.prepare(`INSERT INTO media_files
      (id, relative_path, absolute_path, name, basename, extension, mime_type, size, mtime_ms,
       directory, first_letter, normalized_code, media_type, indexed_at, scan_token)
      VALUES (?, ?, ?, ?, ?, 'mp4', 'video/mp4', 1, 1, '/', 'T', ?, 'video', ?, 'test')`);
    insertMedia.run("legacy-copy-left", "legacy-copy-left.mp4", "/legacy-copy-left.mp4", "legacy-copy-left.mp4", "legacy-copy-left", "LEGACY-LEFT", now);
    insertMedia.run("legacy-copy-right", "legacy-copy-right.mp4", "/legacy-copy-right.mp4", "legacy-copy-right.mp4", "legacy-copy-right", "LEGACY-RIGHT", now);
    db.prepare("INSERT INTO viewing_sessions (id, preset, config_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("legacy-copy-session", "quick", JSON.stringify({ preset: "quick", limit: 6 }), "archived", now, now);
    db.prepare(`INSERT INTO viewing_session_items
      (session_id, media_id, position, lane, reason, score, feedback, created_at, updated_at)
      VALUES (?, ?, 0, 'core', ?, 10, '', ?, ?)`).run(
      "legacy-copy-session",
      "legacy-copy-left",
      "延续 专题「剧情」",
      now,
      now
    );
    db.prepare(`INSERT INTO viewing_arena_rounds
      (session_id, round_index, left_media_id, right_media_id, winner_media_id, decision, strategy, prompt, created_at, updated_at)
      VALUES (?, 0, ?, ?, NULL, '', 'anchor', '先确认今晚最想靠近的核心感觉', ?, ?)`).run(
      "legacy-copy-session",
      "legacy-copy-left",
      "legacy-copy-right",
      now,
      now
    );

    const session = utils.loadViewingSession("legacy-copy-session");

    expect(session?.items[0]?.reason).toBe("符合你刚才偏好的题材「剧情」");
    expect(session?.arena.rounds[0]).toMatchObject({
      strategyLabel: "先看直觉",
      prompt: "先凭直觉选一部现在更想看的"
    });
  });
});
