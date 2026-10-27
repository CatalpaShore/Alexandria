import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { accessControl, createApp } from "./app/createApp.js";
import { config } from "./config.js";
import { enforceDerivativeCacheLimit } from "./mediaDerivatives.js";
import { enforceCoverCacheLimit } from "./covers.js";
import {
  enqueuePendingProbeJobs,
  startMediaJobWorker,
  stopMediaJobWorker,
  wakeMediaSourceWaitingJobs
} from "./mediaJobs.js";
import "./storyboards.js";
import "./contentPreviews.js";
import { enqueuePendingSubtitleJobs } from "./subtitleDerivatives.js";
import { runInitialScan } from "./routes.js";
import { startOperationalMaintenance } from "./operationalMaintenance.js";
import { startIngestionWorker } from "./ingestion-worker.js";
import {
  formatStorageStatus,
  hasRequiredStorageAccess,
  parseRemoteMounts,
  prepareStorageAccess
} from "./storageAccess.js";
import {
  shouldAllowDegradedStorageStartup,
  startStorageRecovery,
  stopStorageRecovery
} from "./storageRecovery.js";
import { startBackupManager, stopBackupManager } from "./backupManager.js";
import { startMetadataSourceRuntime, stopMetadataSourceRuntime } from "./metadataSourceRuntime.js";
import { db } from "./db.js";
import { verifyDemoAssets, seedDemoExperience } from "./demoSeed.js";
import { startScan } from "./routes.js";
import {
  startMetadataAcquisitionWorker,
  stopMetadataAcquisitionWorker
} from "./metadataAcquisition.js";

// The public edition uses its own data directory by default. Explicit external
// volumes still require the original identity-marker preflight.
if (config.externalAi.root === path.join(config.dataDir, "external-ai")) {
  fs.mkdirSync(config.externalAi.root,{recursive:true,mode:0o700});
  const marker = path.join(config.externalAi.root,config.externalAi.markerFile);
  if (!fs.existsSync(marker)) fs.writeFileSync(marker,JSON.stringify({product:"alexandria-ai",storageId:crypto.randomUUID()}),{flag:"wx",mode:0o600});
}

if (config.demoMode) verifyDemoAssets();
const remoteMounts = parseRemoteMounts(process.env.AMW_REMOTE_MOUNTS);
const storagePreparation = await prepareStorageAccess(config.mediaSources, {
  remoteMounts,
  waitMs: config.storageWaitMs
});

for (const source of storagePreparation.sources) {
  const logger = source.readable ? console.log : console.warn;
  logger(`[storage] ${formatStorageStatus(source)}`);
}

if (storagePreparation.mountAttempts.length > 0) {
  console.log(`[storage] Requested remote mounts: ${storagePreparation.mountAttempts.join(", ")}`);
}

if (storagePreparation.permissionSettingsOpened) {
  console.warn("[storage] macOS Full Disk Access settings were opened; restart after granting access.");
}

const hasStartupStorageAccess = hasRequiredStorageAccess(storagePreparation, false);
const allowDegradedStorageStartup = shouldAllowDegradedStorageStartup({
  storageRequired: config.storageRequired,
  hasRequiredAccess: hasStartupStorageAccess,
  recoveryEnabled: config.storageRecovery.enabled,
  remoteMountCount: remoteMounts.size
});

if (config.storageRequired && !hasStartupStorageAccess && !allowDegradedStorageStartup) {
  throw new Error(
    "No configured media source is readable. Mount a library disk or grant Full Disk Access before starting the server."
  );
}
if (allowDegradedStorageStartup) {
  console.warn(
    `[storage] No media source is currently readable; starting in degraded mode with a bounded ${config.storageRecovery.maxMountAttempts}-attempt remote recovery budget`
  );
}

const app = createApp();

const server = app.listen(config.port, config.host, () => {
  console.log(`Media Wall API listening on http://${config.host}:${config.port} (${accessControl.mode})`);
  if (config.network.requireAuthentication) {
    console.log(`[access] LAN pairing code: ${accessControl.getPairingCode()}`);
    console.log("[access] Enter this code on each trusted device; the session is stored only in that browser.");
  } else if (config.network.lanMode) {
    console.log("[access] LAN direct access is enabled; devices on this network do not need a pairing code.");
  }
  console.log(`MEDIA_ROOT=${config.mediaRoot}`);
  if (!config.demoMode) startIngestionWorker();
  if (config.mediaWorkerMode === "embedded") {
    startMediaJobWorker({ concurrency: config.mediaWorkerConcurrency });
  } else {
    console.log("Media jobs are delegated to the external worker service");
  }
  setTimeout(() => {
    const queued = config.mediaWorkerMode === "embedded"
      ? enqueuePendingProbeJobs(config.mediaProbeStartupBatch)
      : 0;
    if (queued > 0) console.log(`Queued ${queued} background media probes`);
    const subtitleJobs = enqueuePendingSubtitleJobs(240);
    if (subtitleJobs > 0) console.log(`Queued ${subtitleJobs} subtitle cache jobs`);
    enforceCoverCacheLimit();
    enforceDerivativeCacheLimit();
  }, 3_000).unref();
  if (config.demoMode) {
    void startScan().then(seedDemoExperience).catch(error => { console.error("Demo preparation failed", error); server.close(() => process.exit(1)); });
  } else {
  void runInitialScan();
  startOperationalMaintenance();
  startStorageRecovery(wakeMediaSourceWaitingJobs, {
    initialMountAttemptCount: storagePreparation.mountAttempts.length > 0 ? 1 : 0
  });
  startBackupManager(db);
  void startMetadataSourceRuntime();
  
  
  startMetadataAcquisitionWorker();
  }
  
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.log(`Media Wall API received ${signal}, stopping media jobs`);
    stopStorageRecovery();
    stopBackupManager();
    stopMetadataSourceRuntime();
    
    
    stopMetadataAcquisitionWorker();
    
    
    stopMediaJobWorker();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}
