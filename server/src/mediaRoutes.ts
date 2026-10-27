import fs from "node:fs/promises";
import { db } from "./db.js";
import { ensureInsideMediaRoot, streamFile } from "./services/fileStreaming.js";
import type { Express } from "express";
import type { MediaDomain } from "./mediaDomain.js";

export type MediaRouteDependencies = {
  domain: MediaDomain;
};

export function registerMediaRoutes(app: Express, dependencies: MediaRouteDependencies): void {
  app.get("/api/media/:id/recommendations", (req, res, next) => {
    try {
      const result = dependencies.domain.getRecommendations(req.params.id, req.query);
      if (!result) {
        res.status(404).json({ error: "Media not found" });
        return;
      }
      res.setHeader("X-AMW-Cache", result.cacheStatus);
      res.json(result.body);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/media/:id/recommendation-feedback", (req, res, next) => {
    try {
      const feedback = dependencies.domain.setRecommendationFeedback(req.params.id, req.body);
      if (!feedback) {
        res.status(404).json({ error: "Media not found" });
        return;
      }
      res.status(201).json(feedback);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/media/:id/recommendation-feedback/:mediaId", (req, res, next) => {
    try {
      dependencies.domain.clearRecommendationFeedback(req.params.id, req.params.mediaId);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/media/:id/thumbnail", async (req, res, next) => {
    try {
      const found = await dependencies.domain.sendThumbnail(req.params.id, res);
      if (!found) res.status(404).json({ error: "Media not found" });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/media/:id/poster", async (req, res, next) => {
    try {
      const hasLocal = db.prepare("SELECT 1 FROM sqlite_master WHERE name='library_local_import'").get();
      const artwork = hasLocal ? db.prepare("SELECT artwork_path FROM library_local_import WHERE media_id=?").get(req.params.id) as { artwork_path: string } | undefined : undefined;
      if (artwork?.artwork_path) {
        try {
          const real = await fs.realpath(artwork.artwork_path);
          ensureInsideMediaRoot(real);
          await fs.access(real);
          const mime = real.toLowerCase().endsWith(".svg") ? "image/svg+xml" : "image/" + (real.toLowerCase().endsWith(".png") ? "png" : real.toLowerCase().endsWith(".webp") ? "webp" : "jpeg");
          streamFile(real, mime, req, res);
          return;
        } catch { /* A removed local poster falls back to the original cover pipeline. */ }
      }
      const found = await dependencies.domain.sendPoster(req.params.id, req.query.size, res);
      if (!found) res.status(404).json({ error: "Media not found" });
    } catch (error) {
      next(error);
    }
  });
}
