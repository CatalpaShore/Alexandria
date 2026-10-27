import type { Express } from "express";
import type { SearchDomain } from "./searchDomain.js";

export type SearchRouteDependencies = {
  domain: SearchDomain;
};

export function registerSearchRoutes(app: Express, dependencies: SearchRouteDependencies): void {
  app.get("/api/search/suggestions", (req, res, next) => {
    try {
      const result = dependencies.domain.getSuggestions(req.query);
      res.setHeader("X-AMW-Cache", result.cacheStatus);
      res.json(result.body);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/media", (req, res, next) => {
    try {
      const result = dependencies.domain.getMedia(req.query);
      res.setHeader("X-AMW-Cache", result.cacheStatus);
      res.json(result.body);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/media/facets", (req, res, next) => {
    const startedAt = performance.now();
    try {
      const result = dependencies.domain.getFacets(req.query);
      res.setHeader("X-AMW-Cache", result.cacheStatus);
      res.setHeader("Server-Timing", `facets;dur=${(performance.now() - startedAt).toFixed(1)}`);
      res.json(result.body);
    } catch (error) {
      next(error);
    }
  });
}
