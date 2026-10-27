import fs from "node:fs";
import type { Express } from "express";
import { db, type MediaRow } from "./db.js";
import {
  getContentPreview,
  getContentPreviewAsset,
  requestContentPreview
} from "./contentPreviews.js";
import { pipeFileStream } from "./services/fileStreaming.js";

export function registerContentPreviewRoutes(app: Express): void {
  app.get("/api/media/:id/content-preview", (req, res) => {
    const startedAt = performance.now();
    const media = db.prepare("SELECT id FROM media_files WHERE id = ?").get(req.params.id) as { id: string } | undefined;
    if (!media) return void res.status(404).json({ error: "Media not found" });
    const preview = getContentPreview(media.id);
    res.setHeader("Cache-Control", "private, no-cache");
    res.setHeader("Server-Timing", `content-preview;dur=${(performance.now() - startedAt).toFixed(1)}`);
    res.json(preview);
  });

  app.post("/api/media/:id/content-preview", (req, res, next) => {
    try {
      const media = db.prepare("SELECT * FROM media_files WHERE id = ?").get(req.params.id) as MediaRow | undefined;
      if (!media) return void res.status(404).json({ error: "Media not found" });
      const jobId = requestContentPreview(media);
      res.status(jobId ? 202 : 200).json({ jobId, preview: getContentPreview(media.id) });
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code === "CONTENT_PREVIEW_STORAGE_WAIT") {
        return void res.status(503).json({ error: error instanceof Error ? error.message : "辅助存储 storage unavailable", code });
      }
      next(error);
    }
  });

  app.get("/api/media/:id/content-preview/assets/:assetKey", (req, res) => {
    const asset = getContentPreviewAsset(req.params.id, req.params.assetKey);
    if (!asset) return void res.status(404).end();
    try {
      const stat = fs.statSync(asset.path);
      res.setHeader("Content-Type", asset.mimeType);
      res.setHeader("Content-Length", stat.size);
      res.setHeader("Cache-Control", "private, max-age=86400, immutable");
      pipeFileStream(fs.createReadStream(asset.path), res);
    } catch {
      res.status(404).end();
    }
  });
}
