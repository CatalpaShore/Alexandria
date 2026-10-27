import type { Express } from "express";
import { z } from "zod";
import { db, rebuildMediaSearchIndex } from "./db.js";
import { enqueueMetadataEnrichmentAfterCurrentRun, getMetadataStatus, startMetadataEnrichment } from "./metadata.js";
import { exportMetadataWorkbook } from "./metadataExport.js";
import { MediaRepairError, moveMediaBackToDownload, renameMediaAndRefreshMetadata } from "./mediaRepair.js";
import { buildMetadataItemsResponse } from "./queries/metadataQueries.js";
import {
  actOnAcquisitionRun,
  createAcquisitionPlan,
  createAcquisitionRun,
  getAcquisitionSources,
  readAcquisitionRun
} from "./metadataAcquisition.js";

const booleanQuery = z.preprocess((value) => {
  if (value == null || value === "") return undefined;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return value;
}, z.boolean().optional());

const metadataEnrichSchema = z.object({
  force: booleanQuery.default(false),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  category: z.string().trim().toUpperCase().optional(),
  codes: z.array(z.string().trim().min(1)).max(500).optional(),
  async: booleanQuery.default(false)
});

const metadataItemsQuerySchema = z.object({
  q: z.string().trim().optional(),
  status: z.enum(["ALL", "ready", "not_found", "failed", "pending", "fetching", "skipped"]).default("ALL"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(30)
});

const renameMediaSchema = z.object({
  basename: z.string().trim().min(1).max(240)
});

const acquisitionPlanSchema = z.object({
  category: z.string().trim().toUpperCase().optional(),
  codes: z.array(z.string().trim().min(1)).max(500).optional(),
  packages: z.array(z.enum(["work-facts", "local-gallery"])).min(1).max(2).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  mode: z.enum(["missing-or-stale", "all"]).default("missing-or-stale")
});

const acquisitionRunSchema = z.object({
  planId: z.string().uuid(),
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  requestKey: z.string().trim().min(8).max(160)
});

const acquisitionActionSchema = z.object({
  action: z.enum(["pause", "resume", "cancel", "retry-failed"])
});

export function registerMetadataRoutes(
  app: Express,
  options: { onDataChanged?: () => void } = {}
): void {
  app.get("/api/metadata/status", (_req, res) => {
    res.json(getMetadataStatus());
  });

  app.get("/api/metadata/sources", async (_req, res, next) => {
    try {
      res.json({ sources: await getAcquisitionSources() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/metadata/acquisition/plans", (req, res, next) => {
    try {
      res.json(createAcquisitionPlan(acquisitionPlanSchema.parse(req.body ?? {})));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/metadata/acquisition/runs", (req, res, next) => {
    try {
      const result = createAcquisitionRun(acquisitionRunSchema.parse(req.body ?? {}));
      res.status(202).json(result);
    } catch (error) {
      const statusCode = error instanceof Error && "statusCode" in error
        ? Number(error.statusCode)
        : 0;
      if (statusCode >= 400 && statusCode < 600) {
        res.status(statusCode).json({ error: error instanceof Error ? error.message : String(error) });
        return;
      }
      next(error);
    }
  });

  app.get("/api/metadata/acquisition/runs/:id", (req, res) => {
    const run = readAcquisitionRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: "Acquisition run not found" });
      return;
    }
    res.json(run);
  });

  app.post("/api/metadata/acquisition/runs/:id/actions", (req, res, next) => {
    try {
      const { action } = acquisitionActionSchema.parse(req.body ?? {});
      res.json(actOnAcquisitionRun(req.params.id, action));
    } catch (error) {
      const statusCode = error instanceof Error && "statusCode" in error
        ? Number(error.statusCode)
        : 0;
      if (statusCode >= 400 && statusCode < 600) {
        res.status(statusCode).json({ error: error instanceof Error ? error.message : String(error) });
        return;
      }
      next(error);
    }
  });

  app.get("/api/metadata/items", (req, res, next) => {
    try {
      res.json(buildMetadataItemsResponse(metadataItemsQuerySchema.parse(req.query)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/metadata/enrich", async (req, res, next) => {
    try {
      const body = metadataEnrichSchema.parse(req.body ?? {});
      const enrichmentOptions = {
        force: body.force,
        limit: body.limit,
        category: body.category,
        codes: body.codes,
        reason: "manual" as const
      };
      const job = body.codes?.length
        ? enqueueMetadataEnrichmentAfterCurrentRun(enrichmentOptions)
        : startMetadataEnrichment(enrichmentOptions);

      if (body.async) {
        job.then(() => {
          rebuildMediaSearchIndex();
          options.onDataChanged?.();
        }).catch((error) => {
          console.error("Async metadata enrichment failed:", error);
        });
        res.status(202).json({ accepted: true, status: getMetadataStatus() });
        return;
      }

      const summary = await job;
      rebuildMediaSearchIndex();
      options.onDataChanged?.();
      const results = body.codes?.length
        ? db.prepare(`
            SELECT normalized_code AS normalizedCode, status, error, attempts, updated_at AS updatedAt
            FROM media_metadata
            WHERE normalized_code IN (${body.codes.map(() => "?").join(", ")})
            ORDER BY normalized_code
          `).all(...body.codes)
        : [];
      res.json({ summary, results, status: getMetadataStatus() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/metadata/media/:id/rename", async (req, res, next) => {
    try {
      const body = renameMediaSchema.parse(req.body ?? {});
      const result = await renameMediaAndRefreshMetadata(req.params.id, body.basename);
      options.onDataChanged?.();
      res.json(result);
    } catch (error) {
      if (error instanceof MediaRepairError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  app.post("/api/metadata/media/:id/remove", async (req, res, next) => {
    try {
      const result = await moveMediaBackToDownload(req.params.id);
      options.onDataChanged?.();
      res.json(result);
    } catch (error) {
      if (error instanceof MediaRepairError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  app.get("/api/metadata/export", async (_req, res, next) => {
    try {
      const result = await exportMetadataWorkbook();
      res.setHeader("X-AMW-Exported-Rows", String(result.rows));
      res.download(result.path, "adult-media-metadata.xlsx");
    } catch (error) {
      next(error);
    }
  });
}
