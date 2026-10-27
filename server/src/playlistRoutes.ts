import crypto from "node:crypto";
import type { Express } from "express";
import { z } from "zod";
import { db } from "./db.js";

const playlistInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default(""),
  kind: z.enum(["manual", "smart"]).default("manual"),
  query: z.record(z.string(), z.unknown()).default({}),
  mediaIds: z.array(z.string().trim().min(1)).max(200).default([])
});

const playlistItemSchema = z.object({
  mediaId: z.string().trim().min(1),
  favorite: z.boolean().default(true)
});

const mediaPlaylistsSchema = z.object({
  playlistIds: z.array(z.string().trim().min(1)).max(500)
});

const playlistOrderSchema = z.object({
  mediaIds: z.array(z.string().trim().min(1)).max(10_000)
});

function parseQuery(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function getPlaylist(id: string) {
  const row = db.prepare(
    `
    SELECT playlists.id, playlists.name, playlists.description, playlists.kind,
      playlists.query_json AS queryJson, playlists.created_at AS createdAt,
      playlists.updated_at AS updatedAt, COUNT(playlist_items.media_id) AS itemCount
    FROM playlists
    LEFT JOIN playlist_items ON playlist_items.playlist_id = playlists.id
    WHERE playlists.id = ?
    GROUP BY playlists.id
  `
  ).get(id) as {
    id: string;
    name: string;
    description: string;
    kind: "manual" | "smart";
    queryJson: string;
    createdAt: string;
    updatedAt: string;
    itemCount: number;
  } | undefined;
  return row ? { ...row, query: parseQuery(row.queryJson), queryJson: undefined } : null;
}

function getMediaPlaylistAssignments(mediaId: string) {
  const rows = db.prepare(
    `
    SELECT playlists.id, playlists.name, playlists.description, playlists.kind,
      playlists.query_json AS queryJson, playlists.created_at AS createdAt,
      playlists.updated_at AS updatedAt, COUNT(all_items.media_id) AS itemCount,
      MAX(CASE WHEN selected_item.media_id IS NOT NULL THEN 1 ELSE 0 END) AS containsMedia
    FROM playlists
    LEFT JOIN playlist_items AS all_items ON all_items.playlist_id = playlists.id
    LEFT JOIN playlist_items AS selected_item
      ON selected_item.playlist_id = playlists.id AND selected_item.media_id = ?
    WHERE playlists.kind = 'manual'
    GROUP BY playlists.id
    ORDER BY containsMedia DESC, playlists.updated_at DESC
  `
  ).all(mediaId) as Array<{
    id: string;
    name: string;
    description: string;
    kind: "manual";
    queryJson: string;
    createdAt: string;
    updatedAt: string;
    itemCount: number;
    containsMedia: number;
  }>;

  return rows.map((row) => ({
    ...row,
    containsMedia: Boolean(row.containsMedia),
    query: parseQuery(row.queryJson),
    queryJson: undefined
  }));
}

export function registerPlaylistRoutes(app: Express): void {
  app.get("/api/playlists", (_req, res) => {
    const rows = db.prepare(
      `
      SELECT playlists.id, playlists.name, playlists.description, playlists.kind,
        playlists.query_json AS queryJson, playlists.created_at AS createdAt,
        playlists.updated_at AS updatedAt, COUNT(playlist_items.media_id) AS itemCount
      FROM playlists
      LEFT JOIN playlist_items ON playlist_items.playlist_id = playlists.id
      GROUP BY playlists.id
      ORDER BY playlists.updated_at DESC
    `
    ).all() as Array<{
      id: string;
      name: string;
      description: string;
      kind: "manual" | "smart";
      queryJson: string;
      createdAt: string;
      updatedAt: string;
      itemCount: number;
    }>;
    res.json({ items: rows.map((row) => ({ ...row, query: parseQuery(row.queryJson), queryJson: undefined })) });
  });

  app.post("/api/playlists", (req, res, next) => {
    try {
      const input = playlistInputSchema.parse(req.body ?? {});
      const mediaIds = [...new Set(input.mediaIds)];
      if (mediaIds.length > 0) {
        const placeholders = mediaIds.map(() => "?").join(", ");
        const available = db.prepare(`SELECT id FROM media_files WHERE id IN (${placeholders})`)
          .all(...mediaIds) as Array<{ id: string }>;
        if (available.length !== mediaIds.length) {
          return void res.status(400).json({ error: "片单包含已不存在或不可用的视频" });
        }
      }
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.transaction(() => {
        db.prepare(
          `INSERT INTO playlists (id, name, description, kind, query_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(id, input.name, input.description, "manual", "{}", now, now);
        const insertItem = db.prepare(
          `INSERT INTO playlist_items (playlist_id, media_id, position, added_at)
           VALUES (?, ?, ?, ?)`
        );
        mediaIds.forEach((mediaId, position) => insertItem.run(id, mediaId, position, now));
      })();
      res.status(201).json(getPlaylist(id));
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/playlists/:id", (req, res, next) => {
    try {
      const input = playlistInputSchema.parse(req.body ?? {});
      const result = db.prepare(
        `UPDATE playlists SET name = ?, description = ?, kind = ?, query_json = ?, updated_at = ? WHERE id = ?`
      ).run(input.name, input.description, "manual", "{}", new Date().toISOString(), req.params.id);
      if (!result.changes) return void res.status(404).json({ error: "Playlist not found" });
      res.json(getPlaylist(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/playlists/:id", (req, res) => {
    const result = db.prepare("DELETE FROM playlists WHERE id = ?").run(req.params.id);
    if (!result.changes) return void res.status(404).json({ error: "Playlist not found" });
    res.status(204).end();
  });

  app.get("/api/media/:mediaId/playlists", (req, res) => {
    const media = db.prepare("SELECT id FROM media_files WHERE id = ?").get(req.params.mediaId);
    if (!media) return void res.status(404).json({ error: "Media not found" });
    res.json({ items: getMediaPlaylistAssignments(req.params.mediaId) });
  });

  app.put("/api/media/:mediaId/playlists", (req, res, next) => {
    try {
      const input = mediaPlaylistsSchema.parse(req.body ?? {});
      const media = db.prepare("SELECT id FROM media_files WHERE id = ?").get(req.params.mediaId);
      if (!media) return void res.status(404).json({ error: "Media not found" });

      const playlistIds = [...new Set(input.playlistIds)];
      if (playlistIds.length > 0) {
        const placeholders = playlistIds.map(() => "?").join(", ");
        const validRows = db.prepare(
          `SELECT id FROM playlists WHERE kind = 'manual' AND id IN (${placeholders})`
        ).all(...playlistIds) as Array<{ id: string }>;
        if (validRows.length !== playlistIds.length) {
          return void res.status(400).json({ error: "Only existing manual playlists can contain videos" });
        }
      }

      const currentRows = db.prepare(
        `SELECT playlist_items.playlist_id AS playlistId
         FROM playlist_items
         JOIN playlists ON playlists.id = playlist_items.playlist_id
         WHERE playlist_items.media_id = ? AND playlists.kind = 'manual'`
      ).all(req.params.mediaId) as Array<{ playlistId: string }>;
      const currentIds = new Set(currentRows.map((row) => row.playlistId));
      const selectedIds = new Set(playlistIds);
      const removedIds = [...currentIds].filter((id) => !selectedIds.has(id));
      const addedIds = playlistIds.filter((id) => !currentIds.has(id));
      const changedIds = [...new Set([...removedIds, ...addedIds])];
      const now = new Date().toISOString();

      db.transaction(() => {
        const removeItem = db.prepare(
          "DELETE FROM playlist_items WHERE playlist_id = ? AND media_id = ?"
        );
        for (const playlistId of removedIds) removeItem.run(playlistId, req.params.mediaId);

        const nextPosition = db.prepare(
          "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM playlist_items WHERE playlist_id = ?"
        );
        const addItem = db.prepare(
          "INSERT INTO playlist_items (playlist_id, media_id, position, added_at) VALUES (?, ?, ?, ?)"
        );
        for (const playlistId of addedIds) {
          const position = (nextPosition.get(playlistId) as { position: number }).position;
          addItem.run(playlistId, req.params.mediaId, position, now);
        }

        const touchPlaylist = db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?");
        for (const playlistId of changedIds) touchPlaylist.run(now, playlistId);
      })();

      res.json({ items: getMediaPlaylistAssignments(req.params.mediaId) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/playlists/:id/items", (req, res) => {
    const playlist = getPlaylist(req.params.id);
    if (!playlist) return void res.status(404).json({ error: "Playlist not found" });
    const items = db.prepare(
      `
      SELECT media_files.id, media_files.normalized_code AS normalizedCode,
        media_files.basename, media_files.relative_path AS relativePath,
        media_files.duration_seconds AS durationSeconds,
        COALESCE(NULLIF(media_metadata.title_zh, ''), media_metadata.title, '') AS title,
        playlist_items.position, playlist_items.added_at AS addedAt
      FROM playlist_items
      JOIN media_files ON media_files.id = playlist_items.media_id
      LEFT JOIN media_metadata ON media_metadata.normalized_code = media_files.normalized_code
      WHERE playlist_items.playlist_id = ?
      ORDER BY playlist_items.position, playlist_items.added_at
    `
    ).all(req.params.id);
    res.json({ playlist, items });
  });

  app.post("/api/playlists/:id/items", (req, res, next) => {
    try {
      const playlist = getPlaylist(req.params.id);
      if (!playlist) return void res.status(404).json({ error: "Playlist not found" });
      const input = playlistItemSchema.parse(req.body ?? {});
      if (input.favorite) {
        const media = db.prepare("SELECT id FROM media_files WHERE id = ?").get(input.mediaId);
        if (!media) return void res.status(404).json({ error: "Media not found" });
        const position = (db.prepare(
          "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM playlist_items WHERE playlist_id = ?"
        ).get(req.params.id) as { position: number }).position;
        db.prepare(
          `INSERT INTO playlist_items (playlist_id, media_id, position, added_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(playlist_id, media_id) DO NOTHING`
        ).run(req.params.id, input.mediaId, position, new Date().toISOString());
      } else {
        db.prepare("DELETE FROM playlist_items WHERE playlist_id = ? AND media_id = ?")
          .run(req.params.id, input.mediaId);
      }
      db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), req.params.id);
      res.json(getPlaylist(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/playlists/:id/items/order", (req, res, next) => {
    try {
      const playlist = getPlaylist(req.params.id);
      if (!playlist) return void res.status(404).json({ error: "Playlist not found" });
      if (playlist.kind !== "manual") {
        return void res.status(400).json({ error: "Only manual playlists can be reordered" });
      }

      const input = playlistOrderSchema.parse(req.body ?? {});
      const mediaIds = [...new Set(input.mediaIds)];
      if (mediaIds.length !== input.mediaIds.length) {
        return void res.status(400).json({ error: "Playlist order contains duplicate media" });
      }
      const existingRows = db.prepare(
        "SELECT media_id AS mediaId FROM playlist_items WHERE playlist_id = ?"
      ).all(req.params.id) as Array<{ mediaId: string }>;
      const existingIds = new Set(existingRows.map((row) => row.mediaId));
      if (mediaIds.length !== existingIds.size || mediaIds.some((id) => !existingIds.has(id))) {
        return void res.status(400).json({ error: "Playlist order must include every current item exactly once" });
      }

      const now = new Date().toISOString();
      db.transaction(() => {
        const updatePosition = db.prepare(
          "UPDATE playlist_items SET position = ? WHERE playlist_id = ? AND media_id = ?"
        );
        mediaIds.forEach((mediaId, position) => updatePosition.run(position, req.params.id, mediaId));
        db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(now, req.params.id);
      })();
      res.json(getPlaylist(req.params.id));
    } catch (error) {
      next(error);
    }
  });
}
