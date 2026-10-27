import fs from "node:fs";
import path from "node:path";
import type { Express } from "express";
import { z } from "zod";
import { generateAssetIntegrityReport, type AssetIntegrityReport } from "./assetIntegrity.js";
import {
  createBackup,
  executeBackupRestore,
  planBackupRestore,
  validateBackup,
  type RestorePlan
} from "./backup.js";
import { config } from "./config.js";
import { db } from "./db.js";
import { startMediaJobWorker, stopMediaJobWorker, waitForMediaJobWorkerStop } from "./mediaJobs.js";
import {
  BACKUP_SCOPES,
  controlBackupJob,
  getBackupSettings,
  inspectBackupTarget,
  listBackupJobs,
  saveBackupSettings,
  startBackupJob
} from "./backupManager.js";

const backupIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);
const createBackupSchema = z.object({ id: backupIdSchema.optional() });
const backupScopeSchema = z.enum(BACKUP_SCOPES);
const backupTaskSchema = z.object({
  targetRoot: z.string().trim().min(1).max(1024),
  scopes: z.array(backupScopeSchema).min(1)
});
const backupSettingsSchema = backupTaskSchema.extend({
  enabled: z.boolean(),
  frequency: z.enum(["daily", "weekly"]),
  hour: z.number().int().min(0).max(23),
  weekday: z.number().int().min(0).max(6)
});
const backupControlSchema = z.object({ action: z.enum(["pause", "resume", "cancel"]) });
const restoreSchema = z.object({ confirmationToken: z.string().min(8).max(80) });
const backupRoot = path.join(config.dataDir, "backups");
const restoreLockPath = path.join(config.dataDir, "restore.lock");
const restoreWorkerAckPath = path.join(config.dataDir, "restore-worker.stopped");

let latestIntegrityReport: AssetIntegrityReport | null = null;
let integrityScan: Promise<AssetIntegrityReport> | null = null;
const restorePlans = new Map<string, RestorePlan>();

function startIntegrityScan(): Promise<AssetIntegrityReport> {
  if (integrityScan) return integrityScan;
  integrityScan = generateAssetIntegrityReport({ database: db })
    .then((report) => {
      latestIntegrityReport = report;
      return report;
    })
    .finally(() => {
      integrityScan = null;
    });
  return integrityScan;
}

function getBackupDir(id: string): string {
  return path.join(backupRoot, backupIdSchema.parse(id));
}

function listBackups() {
  if (!fs.existsSync(backupRoot)) return [];
  return fs.readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => {
      const directory = path.join(backupRoot, entry.name);
      const manifestPath = path.join(directory, "manifest.json");
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
          createdAt?: string;
          inventory?: Record<string, number>;
          artifacts?: Array<{ bytes?: number }>;
        };
        return {
          id: entry.name,
          createdAt: manifest.createdAt ?? fs.statSync(directory).mtime.toISOString(),
          bytes: manifest.artifacts?.reduce((sum, artifact) => sum + Number(artifact.bytes ?? 0), 0) ?? 0,
          inventory: manifest.inventory ?? {}
        };
      } catch {
        return { id: entry.name, createdAt: fs.statSync(directory).mtime.toISOString(), bytes: 0, invalid: true };
      }
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 100);
}

async function waitForExternalWorker(timeoutMs = 20_000): Promise<void> {
  if (config.mediaWorkerMode !== "external") return;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(restoreWorkerAckPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("External media worker did not acknowledge the restore lock");
}

export function registerMaintenanceRoutes(app: Express): void {
  app.get("/api/backup-center", (_req, res) => {
    const settings = getBackupSettings();
    res.json({
      settings,
      target: inspectBackupTarget(settings.targetRoot),
      jobs: listBackupJobs(),
      defaultTargetRoot: path.join(config.externalAi.root, "backups", "alexandria"),
      scopes: BACKUP_SCOPES
    });
  });

  app.post("/api/backup-center/inspect-target", (req, res, next) => {
    try {
      const targetRoot = z.object({ targetRoot: z.string().trim().min(1).max(1024) }).parse(req.body ?? {}).targetRoot;
      res.json(inspectBackupTarget(targetRoot));
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/backup-center/settings", (req, res, next) => {
    try {
      const settings = saveBackupSettings(backupSettingsSchema.parse(req.body ?? {}));
      res.json({ settings, target: inspectBackupTarget(settings.targetRoot) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/backup-center/jobs", (req, res, next) => {
    try {
      const input = backupTaskSchema.parse(req.body ?? {});
      res.status(202).json(startBackupJob(input));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/backup-center/jobs/:id/control", (req, res, next) => {
    try {
      const id = backupIdSchema.parse(req.params.id);
      const { action } = backupControlSchema.parse(req.body ?? {});
      res.json(controlBackupJob(id, action));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/maintenance/integrity", (_req, res) => {
    res.json({ running: Boolean(integrityScan), report: latestIntegrityReport });
  });

  app.post("/api/maintenance/integrity", (req, res, next) => {
    const wait = req.query.wait === "true";
    const scan = startIntegrityScan();
    if (!wait) {
      res.status(202).json({ running: true, report: latestIntegrityReport });
      return;
    }
    scan.then((report) => res.json({ running: false, report })).catch(next);
  });

  app.get("/api/maintenance/backups", (_req, res) => {
    res.json({ items: listBackups(), backupRoot });
  });

  app.post("/api/maintenance/backups", async (req, res, next) => {
    try {
      const input = createBackupSchema.parse(req.body ?? {});
      const result = await createBackup({ database: db, backupId: input.id });
      res.status(201).json({
        id: path.basename(result.backupDir),
        backupDir: result.backupDir,
        manifest: result.manifest
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/maintenance/backups/:id/validate", async (req, res, next) => {
    try {
      res.json(await validateBackup(getBackupDir(req.params.id)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/maintenance/backups/:id/restore-plan", async (req, res, next) => {
    try {
      const id = backupIdSchema.parse(req.params.id);
      const plan = await planBackupRestore(getBackupDir(id));
      restorePlans.set(`${id}:${plan.confirmationToken}`, plan);
      res.json(plan);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/maintenance/backups/:id/restore", async (req, res, next) => {
    try {
      const id = backupIdSchema.parse(req.params.id);
      const input = restoreSchema.parse(req.body ?? {});
      const key = `${id}:${input.confirmationToken}`;
      const plan = restorePlans.get(key);
      if (!plan) return void res.status(409).json({ error: "Create and confirm a fresh restore plan first" });
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(
        restoreLockPath,
        `${JSON.stringify({ backupId: id, requestedAt: new Date().toISOString() })}\n`,
        { encoding: "utf8", flag: "wx" }
      );
      stopMediaJobWorker();
      await waitForMediaJobWorkerStop(15_000);
      await waitForExternalWorker();
      const result = await executeBackupRestore(plan, {
        confirmationToken: input.confirmationToken,
        closeDatabase: () => {
          db.close();
        }
      });
      restorePlans.delete(key);
      fs.rmSync(restoreWorkerAckPath, { force: true });
      fs.rmSync(restoreLockPath, { force: true });
      res.json(result);
      setTimeout(() => process.exit(0), 300).unref();
    } catch (error) {
      fs.rmSync(restoreWorkerAckPath, { force: true });
      fs.rmSync(restoreLockPath, { force: true });
      if (config.mediaWorkerMode === "embedded" && db.open) {
        startMediaJobWorker({ concurrency: config.mediaWorkerConcurrency });
      }
      next(error);
    }
  });
}
