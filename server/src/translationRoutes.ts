import fs from "node:fs";
import type { Express } from "express";
import { z } from "zod";
import { streamFile } from "./services/fileStreaming.js";
import {
  enqueueNextPriorityTranslationIfIdle,
  getSubtitleTranslation,
  getTranslationCapabilities,
  listSubtitleTranslations,
  removeSubtitleTranslation,
  requestSubtitleRetranslation,
  requestSubtitleTranslation,
  setAutoTranslateFavoritesEnabled
} from "./subtitleTranslation.js";

const translationListSchema = z.object({
  status: z.enum(["ALL", "pending", "running", "ready", "failed", "cancelled"]).default("ALL"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(12).max(100).default(30)
});
const translationSettingsSchema = z.object({
  autoTranslateFavorites: z.boolean()
});

export function registerTranslationRoutes(
  app: Express,
  options: { onDataChanged?: () => void } = {}
): void {
  app.get("/api/translations", (req, res, next) => {
    try {
      const query = translationListSchema.parse(req.query);
      res.setHeader("Cache-Control", "private, no-cache");
      res.json(listSubtitleTranslations(query));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/media/:id/translation", (req, res) => {
    res.setHeader("Cache-Control", "private, no-cache");
    res.json({ translation: getSubtitleTranslation(req.params.id) });
  });

  app.patch("/api/translations/settings", (req, res, next) => {
    try {
      const input = translationSettingsSchema.parse(req.body ?? {});
      setAutoTranslateFavoritesEnabled(input.autoTranslateFavorites);
      if (input.autoTranslateFavorites) enqueueNextPriorityTranslationIfIdle();
      options.onDataChanged?.();
      res.json({ capabilities: getTranslationCapabilities() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/media/:id/translation", (req, res, next) => {
    try {
      const translation = requestSubtitleTranslation(req.params.id);
      options.onDataChanged?.();
      res.status(translation.status === "ready" ? 200 : 202).json(translation);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/translations/:mediaId/retry", (req, res, next) => {
    try {
      const translation = requestSubtitleTranslation(req.params.mediaId);
      options.onDataChanged?.();
      res.status(202).json(translation);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/translations/:mediaId/retranslate", (req, res, next) => {
    try {
      const translation = requestSubtitleRetranslation(req.params.mediaId);
      options.onDataChanged?.();
      res.status(202).json(translation);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/translations/:mediaId", (req, res, next) => {
    try {
      const result = removeSubtitleTranslation(req.params.mediaId);
      options.onDataChanged?.();
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/media/:id/subtitle-translation.vtt", (req, res) => {
    const translation = getSubtitleTranslation(req.params.id);
    if (!translation || translation.status !== "ready" || !translation.outputPath || !fs.existsSync(translation.outputPath)) {
      return void res.status(404).json({ error: "汉化字幕尚未就绪" });
    }
    streamFile(translation.outputPath, "text/vtt; charset=utf-8", req, res, {
      cacheControl: "private, no-cache, no-store, must-revalidate"
    });
  });
}
