import type { Express } from "express";
import { z } from "zod";
import { config } from "./config.js";
import { ENTITY_FAVORITE_TYPES, setEntityFavorite } from "./entityFavorites.js";
import { parseFavoriteText, readFavoriteKeys, setFavoriteKey, writeFavoriteKeys } from "./favorites.js";
import { buildFavoritesResponse } from "./queries/favoriteQueries.js";

const favoriteSchema = z.object({
  relativePath: z.string().trim().min(1),
  favorite: z.boolean()
});

const entityFavoriteSchema = z.object({
  type: z.enum(ENTITY_FAVORITE_TYPES),
  value: z.string().trim().min(1).max(500),
  label: z.string().trim().max(500).optional(),
  favorite: z.boolean()
});

const favoriteImportSchema = z.object({
  text: z.string(),
  mode: z.enum(["merge", "replace"]).default("merge")
});

export function registerFavoriteRoutes(
  app: Express,
  options: { onDataChanged?: () => void } = {}
): void {
  app.get("/api/favorites", (_req, res) => {
    res.json(buildFavoritesResponse());
  });

  app.post("/api/favorites", (req, res, next) => {
    try {
      const body = favoriteSchema.parse(req.body);
      const keys = setFavoriteKey(body.relativePath, body.favorite);
      options.onDataChanged?.();

      res.json({
        ...buildFavoritesResponse(),
        relativePath: body.relativePath,
        favorite: keys.has(body.relativePath)
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/favorites/entities", (req, res, next) => {
    try {
      const body = entityFavoriteSchema.parse(req.body);
      const favorite = setEntityFavorite(body);
      res.json({
        ...buildFavoritesResponse(),
        entity: {
          type: body.type,
          value: body.value,
          label: body.label || body.value,
          favorite
        }
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/favorites/export", (_req, res) => {
    const keys = readFavoriteKeys();
    const text = `${[...keys].sort((a, b) => a.localeCompare(b)).join("\n")}${keys.size > 0 ? "\n" : ""}`;

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="adult-media-wall-favorites.txt"');
    res.send(text);
  });

  app.post("/api/favorites/import", (req, res, next) => {
    try {
      const body = favoriteImportSchema.parse(req.body);
      const imported = parseFavoriteText(body.text);
      const nextKeys = body.mode === "replace" ? imported : new Set([...readFavoriteKeys(), ...imported]);

      writeFavoriteKeys(nextKeys);
      options.onDataChanged?.();

      res.json({
        count: nextKeys.size,
        imported: imported.size,
        filePath: config.favoritesPath
      });
    } catch (error) {
      next(error);
    }
  });
}
