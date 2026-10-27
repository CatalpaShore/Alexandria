import type { Express } from "express";
import { z } from "zod";
import { db } from "./db.js";
import { ENTITY_FAVORITE_TYPES } from "./entityFavorites.js";
import { readFavoriteKeys, writeFavoriteKeys } from "./favorites.js";
import { getTopicLabel, isTopicVisible } from "./productRoutes.js";

type ScalarRow = { value: number | null };

function scalar(sql: string, params: Record<string, unknown> = {}): number {
  return Number((db.prepare(sql).get(params) as ScalarRow | undefined)?.value ?? 0);
}

function monthStart(offset = 0): string {
  const date = new Date();
  date.setUTCDate(1);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString();
}

const personalImportSchema = z.object({
  format: z.literal("adult-media-wall-personal-data"),
  version: z.literal(1),
  exportedAt: z.string().optional(),
  dashboardSnapshot: z.record(z.string(), z.unknown()).optional(),
  playback: z.array(z.object({
    relativePath: z.string().min(1), mediaId: z.string().default(""),
    positionSeconds: z.number().nonnegative(), durationSeconds: z.number().nonnegative().nullable(),
    completed: z.boolean(), playCount: z.number().int().nonnegative(),
    lastPlayedAt: z.string().min(1), updatedAt: z.string().min(1)
  })).max(100_000),
  mediaFavorites: z.array(z.string().min(1)).max(100_000),
  entityFavorites: z.array(z.object({
    type: z.enum(ENTITY_FAVORITE_TYPES), value: z.string().min(1).max(500),
    label: z.string().max(500), createdAt: z.string().min(1)
  })).max(100_000),
  playlists: z.array(z.object({
    id: z.string().min(1), name: z.string().min(1).max(120), description: z.string().max(500),
    kind: z.enum(["manual", "smart"]), query: z.record(z.string(), z.unknown()),
    createdAt: z.string().min(1), updatedAt: z.string().min(1),
    items: z.array(z.object({ relativePath: z.string().min(1), mediaId: z.string().default(""), position: z.number().int().nonnegative(), addedAt: z.string().min(1) })).max(100_000)
  })).max(10_000)
});

function getDashboardSnapshot() {
  const currentMonth = monthStart();
  const nextMonth = monthStart(1);
  const playbackWhere = "last_played_at >= @start AND last_played_at < @end";
  const params = { start: currentMonth, end: nextMonth };
  const month = {
    played: scalar(`SELECT COUNT(*) AS value FROM playback_progress WHERE ${playbackWhere}`, params),
    completed: scalar(`SELECT COUNT(*) AS value FROM playback_progress WHERE completed = 1 AND ${playbackWhere}`, params),
    watchSeconds: scalar(
      `SELECT COALESCE(SUM(MIN(position_seconds, COALESCE(duration_seconds, position_seconds))), 0) AS value
       FROM playback_progress WHERE ${playbackWhere}`,
      params
    )
  };
  const stats = {
    played: scalar("SELECT COUNT(*) AS value FROM playback_progress"),
    inProgress: scalar("SELECT COUNT(*) AS value FROM playback_progress WHERE position_seconds > 0 AND completed = 0"),
    completed: scalar("SELECT COUNT(*) AS value FROM playback_progress WHERE completed = 1"),
    watchSeconds: scalar(
      "SELECT COALESCE(SUM(MIN(position_seconds, COALESCE(duration_seconds, position_seconds))), 0) AS value FROM playback_progress"
    ),
    favoriteCount: readFavoriteKeys().size,
    playlistCount: scalar("SELECT COUNT(*) AS value FROM playlists")
  };
  const favoriteUpdates = db.prepare(`
    SELECT favorites.facet_type AS type, favorites.facet_value AS value, favorites.label,
      favorites.created_at AS followedAt,
      CASE WHEN favorites.facet_type = 'prefix' THEN (
        SELECT COUNT(DISTINCT media_files.normalized_code) FROM media_files
        WHERE media_files.code_prefix = favorites.facet_value AND media_files.first_seen_at > favorites.created_at
      ) ELSE (
        SELECT COUNT(DISTINCT media_files.normalized_code) FROM media_metadata_facets
        JOIN media_files ON media_files.normalized_code = media_metadata_facets.normalized_code
        WHERE media_metadata_facets.facet_type = favorites.facet_type
          AND media_metadata_facets.facet_value = favorites.facet_value
          AND media_files.first_seen_at > favorites.created_at
      ) END AS newCount
    FROM entity_favorites favorites
    ORDER BY newCount DESC, favorites.created_at DESC LIMIT 12
  `).all();
  const topEntities = (db.prepare(`
    SELECT facets.facet_type AS type, facets.facet_value AS value, COUNT(*) AS count
    FROM playback_progress
    JOIN media_files ON media_files.id = playback_progress.media_id
    JOIN media_metadata_facets facets ON facets.normalized_code = media_files.normalized_code
    WHERE playback_progress.last_played_at >= @start AND playback_progress.last_played_at < @end
      AND facets.facet_type IN ('actor', 'genre', 'series')
    GROUP BY facets.facet_type, facets.facet_value
    ORDER BY count DESC, facets.facet_value COLLATE NOCASE LIMIT 24
  `).all(params) as Array<{ type: "actor" | "genre" | "series"; value: string; count: number }>)
    .map((item) => ({ ...item, label: getTopicLabel(item.type, item.value) }))
    .filter((item) => isTopicVisible(item.type, item.value, item.label))
    .slice(0, 8);
  const trend = db.prepare(`
    WITH RECURSIVE months(value, start, end) AS (
      SELECT 0, datetime('now', 'start of month', '-5 months'), datetime('now', 'start of month', '-4 months')
      UNION ALL SELECT value + 1, end, datetime(end, '+1 month') FROM months WHERE value < 5
    )
    SELECT strftime('%Y-%m', months.start) AS month, COUNT(playback_progress.relative_path) AS played,
      COALESCE(SUM(playback_progress.completed), 0) AS completed,
      COALESCE(SUM(MIN(playback_progress.position_seconds,
        COALESCE(playback_progress.duration_seconds, playback_progress.position_seconds))), 0) AS watchSeconds
    FROM months
    LEFT JOIN playback_progress ON playback_progress.last_played_at >= months.start
      AND playback_progress.last_played_at < months.end
    GROUP BY months.value, months.start ORDER BY months.value
  `).all();
  const recommendationAnchor = db.prepare(`
    SELECT playback_progress.media_id AS mediaId FROM playback_progress
    JOIN media_files ON media_files.id = playback_progress.media_id
    WHERE playback_progress.media_id != '' AND datetime(playback_progress.last_played_at) IS NOT NULL
    ORDER BY datetime(playback_progress.last_played_at) DESC LIMIT 1
  `).get() as { mediaId: string } | undefined;

  return { stats, month: { ...month, topEntities }, trend, favoriteUpdates, recommendationAnchor: recommendationAnchor?.mediaId ?? null };
}

export function registerPersonalRoutes(app: Express, options: { onDataChanged?: () => void } = {}): void {
  app.get("/api/personal-dashboard", (_req, res) => {
    res.setHeader("Cache-Control", "private, max-age=30");
    res.json(getDashboardSnapshot());
  });

  app.get("/api/personal-data/export", (_req, res) => {
    const playback = db.prepare(`SELECT relative_path AS relativePath, media_id AS mediaId,
      position_seconds AS positionSeconds, duration_seconds AS durationSeconds, completed,
      play_count AS playCount, last_played_at AS lastPlayedAt, updated_at AS updatedAt
      FROM playback_progress ORDER BY last_played_at DESC`).all() as Array<Record<string, unknown>>;
    const entityFavorites = db.prepare(`SELECT facet_type AS type, facet_value AS value, label,
      created_at AS createdAt FROM entity_favorites ORDER BY facet_type, facet_value`).all();
    const playlists = (db.prepare(`SELECT id, name, description, kind, query_json AS queryJson,
      created_at AS createdAt, updated_at AS updatedAt FROM playlists ORDER BY created_at`).all() as Array<Record<string, string>>)
      .map((playlist) => ({
        id: playlist.id, name: playlist.name, description: playlist.description, kind: playlist.kind,
        query: JSON.parse(playlist.queryJson || "{}") as Record<string, unknown>,
        createdAt: playlist.createdAt, updatedAt: playlist.updatedAt,
        items: db.prepare(`SELECT media_files.relative_path AS relativePath, playlist_items.media_id AS mediaId,
          playlist_items.position, playlist_items.added_at AS addedAt FROM playlist_items
          LEFT JOIN media_files ON media_files.id = playlist_items.media_id
          WHERE playlist_items.playlist_id = ? ORDER BY playlist_items.position`).all(playlist.id)
      }));
    const payload = {
      format: "adult-media-wall-personal-data", version: 1, exportedAt: new Date().toISOString(),
      dashboardSnapshot: getDashboardSnapshot(),
      playback: playback.map((item) => ({ ...item, completed: Boolean(item.completed) })),
      mediaFavorites: [...readFavoriteKeys()].sort((a, b) => a.localeCompare(b)), entityFavorites, playlists
    };
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="adult-media-wall-personal-${new Date().toISOString().slice(0, 10)}.txt"`);
    res.send(`${JSON.stringify(payload, null, 2)}\n`);
  });

  app.post("/api/personal-data/import", (req, res, next) => {
    try {
      const text = z.object({ text: z.string().min(1).max(10_000_000) }).parse(req.body).text;
      let decoded: unknown;
      try { decoded = JSON.parse(text); } catch { throw new Error("TXT 内容不是有效的个人数据文件"); }
      const input = personalImportSchema.parse(decoded);
      const findMedia = db.prepare(`SELECT id, relative_path AS relativePath FROM media_files
        WHERE relative_path = @relativePath OR id = @mediaId
        ORDER BY CASE WHEN relative_path = @relativePath THEN 0 ELSE 1 END LIMIT 1`);
      let skippedMedia = 0;
      const restore = db.transaction(() => {
        db.prepare("DELETE FROM playlist_items").run();
        db.prepare("DELETE FROM playlists").run();
        db.prepare("DELETE FROM entity_favorites").run();
        db.prepare("DELETE FROM playback_progress").run();
        const insertProgress = db.prepare(`INSERT INTO playback_progress
          (relative_path, media_id, position_seconds, duration_seconds, completed, play_count, last_played_at, updated_at)
          VALUES (@relativePath, @mediaId, @positionSeconds, @durationSeconds, @completed, @playCount, @lastPlayedAt, @updatedAt)`);
        for (const item of input.playback) {
          const media = findMedia.get(item) as { id: string; relativePath: string } | undefined;
          if (!media) { skippedMedia += 1; continue; }
          insertProgress.run({ ...item, relativePath: media.relativePath, mediaId: media.id, completed: Number(item.completed) });
        }
        const insertEntity = db.prepare(`INSERT INTO entity_favorites (facet_type, facet_value, label, created_at) VALUES (?, ?, ?, ?)`);
        input.entityFavorites.forEach((item) => insertEntity.run(item.type, item.value, item.label, item.createdAt));
        const insertPlaylist = db.prepare(`INSERT INTO playlists (id, name, description, kind, query_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
        const insertItem = db.prepare(`INSERT INTO playlist_items (playlist_id, media_id, position, added_at) VALUES (?, ?, ?, ?)`);
        for (const playlist of input.playlists) {
          insertPlaylist.run(playlist.id, playlist.name, playlist.description, "manual", "{}", playlist.createdAt, playlist.updatedAt);
          for (const item of playlist.items) {
            const media = findMedia.get(item) as { id: string } | undefined;
            if (!media) { skippedMedia += 1; continue; }
            insertItem.run(playlist.id, media.id, item.position, item.addedAt);
          }
        }
        writeFavoriteKeys(new Set(input.mediaFavorites));
      });
      restore();
      options.onDataChanged?.();
      res.json({ imported: { playback: input.playback.length, mediaFavorites: input.mediaFavorites.length, entityFavorites: input.entityFavorites.length, playlists: input.playlists.length }, skippedMedia });
    } catch (error) { next(error); }
  });
}
