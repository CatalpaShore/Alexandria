import { db } from "./db.js";
import {
  cleanupUnknownDatabaseSidecars,
  runDatabaseMaintenance,
  type DatabaseMaintenanceReport
} from "./databaseMaintenance.js";
import {
  cleanupDerivativeTemps,
  reconcileDerivativeCacheIndex
} from "./mediaDerivatives.js";
import { config, getMediaSources } from "./config.js";
import { refreshMetadataQualityIssues } from "./metadataQuality.js";

export type OperationalMaintenanceReason = "startup" | "database" | "derivatives" | "temporary-files" | "manual";

export type OperationalMaintenanceReport = {
  id: number;
  reason: OperationalMaintenanceReason;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  ok: boolean;
  database: (DatabaseMaintenanceReport & { sidecarsRemoved: number; durationMs: number }) | null;
  derivativeIndex: { updated: number; missing: number; durationMs: number } | null;
  temporaryFiles: { removed: number; bytes: number; durationMs: number } | null;
  errors: Array<{ operation: "database" | "derivative-index" | "temporary-files"; message: string }>;
};

export type OperationalMaintenanceStatus = {
  started: boolean;
  startedAt: string | null;
  running: boolean;
  currentReason: OperationalMaintenanceReason | null;
  skippedRuns: number;
  schedule: {
    startupDelayMs: number;
    databaseIntervalMs: number;
    derivativeIntervalMs: number;
    temporaryFileIntervalMs: number;
    temporaryFileMaxAgeMs: number;
  } | null;
  lastReport: OperationalMaintenanceReport | null;
  recentReports: OperationalMaintenanceReport[];
};

export type OperationalMaintenanceOptions = {
  startupDelayMs?: number;
  databaseIntervalMs?: number;
  derivativeIntervalMs?: number;
  temporaryFileIntervalMs?: number;
  temporaryFileMaxAgeMs?: number;
  historyLimit?: number;
};

type MaintenanceSelection = {
  database?: boolean;
  derivativeIndex?: boolean;
  temporaryFiles?: boolean;
  temporaryFileMaxAgeMs?: number;
};

const defaults = {
  startupDelayMs: 90_000,
  databaseIntervalMs: 24 * 60 * 60 * 1000,
  derivativeIntervalMs: 6 * 60 * 60 * 1000,
  temporaryFileIntervalMs: 30 * 60 * 1000,
  temporaryFileMaxAgeMs: 20 * 60 * 1000,
  historyLimit: 12
};

let timers: NodeJS.Timeout[] = [];
let startedAt: string | null = null;
let currentReason: OperationalMaintenanceReason | null = null;
let activeRun: Promise<OperationalMaintenanceReport> | null = null;
let sequence = 0;
let skippedRuns = 0;
let recentReports: OperationalMaintenanceReport[] = [];
let schedule: OperationalMaintenanceStatus["schedule"] = null;
let historyLimit = defaults.historyLimit;

function errorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  const privateRoots = [
    config.dataDir,
    config.derivativeDir,
    config.thumbnailDir,
    config.coverCacheDir,
    ...getMediaSources().map((source) => source.root)
  ].sort((left, right) => right.length - left.length);
  for (const root of privateRoots) {
    if (root) message = message.split(root).join("[path]");
  }
  message = message.replace(/(?:\/[A-Za-z0-9._~-]+){2,}/g, "[path]");
  return message.trim().slice(-1200) || "未知维护错误";
}

function rememberReport(report: OperationalMaintenanceReport): void {
  recentReports = [report, ...recentReports].slice(0, historyLimit);
}

async function performMaintenance(
  reason: OperationalMaintenanceReason,
  selection: MaintenanceSelection
): Promise<OperationalMaintenanceReport> {
  const startedMs = Date.now();
  const report: OperationalMaintenanceReport = {
    id: ++sequence,
    reason,
    startedAt: new Date(startedMs).toISOString(),
    finishedAt: "",
    durationMs: 0,
    ok: true,
    database: null,
    derivativeIndex: null,
    temporaryFiles: null,
    errors: []
  };

  if (selection.temporaryFiles) {
    const operationStarted = Date.now();
    try {
      report.temporaryFiles = {
        ...cleanupDerivativeTemps(selection.temporaryFileMaxAgeMs ?? defaults.temporaryFileMaxAgeMs),
        durationMs: Date.now() - operationStarted
      };
    } catch (error) {
      report.errors.push({ operation: "temporary-files", message: errorMessage(error) });
    }
  }

  if (selection.derivativeIndex) {
    const operationStarted = Date.now();
    try {
      report.derivativeIndex = {
        ...reconcileDerivativeCacheIndex(),
        durationMs: Date.now() - operationStarted
      };
    } catch (error) {
      report.errors.push({ operation: "derivative-index", message: errorMessage(error) });
    }
  }

  if (selection.database) {
    const operationStarted = Date.now();
    try {
      const sidecarsRemoved = cleanupUnknownDatabaseSidecars(config.databasePath);
      report.database = {
        ...runDatabaseMaintenance(db),
        sidecarsRemoved,
        durationMs: Date.now() - operationStarted
      };
      refreshMetadataQualityIssues();
    } catch (error) {
      report.errors.push({ operation: "database", message: errorMessage(error) });
    }
  }

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedMs;
  report.ok = report.errors.length === 0;
  rememberReport(report);
  return report;
}

export function runOperationalMaintenance(
  reason: OperationalMaintenanceReason = "manual",
  selection: MaintenanceSelection = { database: true, derivativeIndex: true, temporaryFiles: true }
): Promise<OperationalMaintenanceReport> {
  if (activeRun) {
    skippedRuns += 1;
    return activeRun;
  }

  currentReason = reason;
  activeRun = performMaintenance(reason, selection).finally(() => {
    activeRun = null;
    currentReason = null;
  });
  return activeRun;
}

function addInterval(callback: () => void, intervalMs: number): void {
  const timer = setInterval(callback, intervalMs);
  timer.unref();
  timers.push(timer);
}

function runScheduled(reason: OperationalMaintenanceReason, selection: MaintenanceSelection): void {
  void runOperationalMaintenance(reason, selection).catch((error) => {
    console.error(`Operational maintenance (${reason}) failed:`, error);
  });
}

export function startOperationalMaintenance(options: OperationalMaintenanceOptions = {}): void {
  if (timers.length > 0 || startedAt) return;

  const resolved = { ...defaults, ...options };
  historyLimit = Math.max(1, Math.min(resolved.historyLimit, 50));
  startedAt = new Date().toISOString();
  schedule = {
    startupDelayMs: Math.max(0, resolved.startupDelayMs),
    databaseIntervalMs: Math.max(60_000, resolved.databaseIntervalMs),
    derivativeIntervalMs: Math.max(60_000, resolved.derivativeIntervalMs),
    temporaryFileIntervalMs: Math.max(60_000, resolved.temporaryFileIntervalMs),
    temporaryFileMaxAgeMs: Math.max(60_000, resolved.temporaryFileMaxAgeMs)
  };

  const startupTimer = setTimeout(() => {
    runScheduled("startup", {
      database: true,
      derivativeIndex: true,
      temporaryFiles: true,
      temporaryFileMaxAgeMs: schedule?.temporaryFileMaxAgeMs
    });
  }, schedule.startupDelayMs);
  startupTimer.unref();
  timers.push(startupTimer);

  addInterval(
    () => runScheduled("database", { database: true }),
    schedule.databaseIntervalMs
  );
  addInterval(
    () => runScheduled("derivatives", { derivativeIndex: true }),
    schedule.derivativeIntervalMs
  );
  addInterval(
    () => runScheduled("temporary-files", {
      temporaryFiles: true,
      temporaryFileMaxAgeMs: schedule?.temporaryFileMaxAgeMs
    }),
    schedule.temporaryFileIntervalMs
  );
}

export function stopOperationalMaintenance(): void {
  for (const timer of timers) clearTimeout(timer);
  timers = [];
  startedAt = null;
  schedule = null;
}

export function getOperationalMaintenanceStatus(): OperationalMaintenanceStatus {
  return {
    started: Boolean(startedAt),
    startedAt,
    running: Boolean(activeRun),
    currentReason,
    skippedRuns,
    schedule,
    lastReport: recentReports[0] ?? null,
    recentReports: [...recentReports]
  };
}
