import { registerHighlightRoutes } from "./highlights.js";
import type { Express } from "express";
import { createCacheWarmup } from "./cacheWarmup.js";
import { config } from "./config.js";
import { importCoverSeedIfAvailable } from "./coverSeed.js";
import {
  ensureMediaSearchIndex,
  ensureMetadataFacetIndex,
  rebuildMediaSearchIndex
} from "./db.js";
import { isApiIdle } from "./diagnostics.js";
import { registerFavoriteRoutes } from "./favoriteRoutes.js";
import { registerDiscoveryRoutes } from "./discoveryRoutes.js";
import { registerIngestionRoutes, startIngestionAutomation } from "./ingestion.js";
import { registerMaintenanceRoutes } from "./maintenanceRoutes.js";
import { createMediaDomain } from "./mediaDomain.js";
import { enqueuePendingProbeJobs } from "./mediaJobs.js";
import { registerMediaRoutes } from "./mediaRoutes.js";
import { startMetadataEnrichment } from "./metadata.js";
import { registerMetadataRoutes } from "./metadataRoutes.js";
import { importMetadataOriginsFromWorkbookIfNeeded } from "./metadataOrigins.js";
import { importMetadataSeedIfAvailable } from "./metadataSeed.js";
import { registerPlaybackRoutes } from "./playbackRoutes.js";
import { registerPersonalRoutes } from "./personalRoutes.js";
import { registerLibraryAnalyticsRoutes } from "./libraryAnalyticsRoutes.js";
import { registerPlaylistRoutes } from "./playlistRoutes.js";
import { clearProductRouteCaches, registerProductRoutes, warmProductRouteCaches } from "./productRoutes.js";
import { registerEntityProfileImageRoutes } from "./entityProfileImageCache.js";
import { scanMediaLibrary, type ScanOptions, type ScanProgress, type ScanSummary } from "./scanner.js";
import { createSearchDomain } from "./searchDomain.js";
import { registerSearchRoutes } from "./searchRoutes.js";
import { refreshMetadataQualityIssues } from "./metadataQuality.js";
import { initializeUserProfiles, registerUserRoutes } from "./userProfiles.js";
import { registerTranslationRoutes } from "./translationRoutes.js";
import { registerAgentRoutes } from "./agentRoutes.js";
import { registerSystemRoutes } from "./systemRoutes.js";
import { registerContentPreviewRoutes } from "./contentPreviewRoutes.js";
import { registerGovernanceActionRoutes } from "./governanceActionRoutes.js";

let activeScan: Promise<ScanSummary> | null = null;
let latestScan: ScanSummary | null = null;
let scanProgress: ScanProgress | null = null;

const searchDomain = createSearchDomain({
  isScanActive: () => Boolean(activeScan),
  getLatestScan: () => latestScan,
  getScanProgress: () => scanProgress
});
const mediaDomain = createMediaDomain();
const cacheWarmup = createCacheWarmup({
  searchDomain,
  isScanActive: () => Boolean(activeScan),
  isApiIdle: () => isApiIdle(10_000)
});

function clearResponseCaches(): void {
  searchDomain.clearCaches();
  mediaDomain.clearCaches();
  clearProductRouteCaches();
}

function clearPlaybackResponseCaches(): void {
  searchDomain.clearPlaybackCaches();
  mediaDomain.clearCaches();
  clearProductRouteCaches();
}

export function startScan(options: ScanOptions = {}): Promise<ScanSummary> {
  if (!activeScan) {
    clearResponseCaches();
    activeScan = scanMediaLibrary({
      ...options,
      onProgress: (progress) => { scanProgress = progress; options.onProgress?.(progress); },
      onInitialReady: () => {
        rebuildMediaSearchIndex();
        enqueuePendingProbeJobs(500);
        clearResponseCaches();
        options.onInitialReady?.();
      }
    })
      .then((summary) => {
        latestScan = summary;
        if (summary.changed > 0 || summary.removed > 0) {
          rebuildMediaSearchIndex();
          refreshMetadataQualityIssues();
          enqueuePendingProbeJobs(Math.min(500, Math.max(summary.changed, 100)));
        }
        clearResponseCaches();
        if (config.metadata.autoEnrich) {
          startMetadataEnrichment({ reason: "scan-complete" })
            .then(() => {
              rebuildMediaSearchIndex();
              refreshMetadataQualityIssues();
              clearResponseCaches();
            })
            .catch((error) => {
              console.error("Metadata enrichment after scan failed:", error);
            });
        }
        return summary;
      })
      .finally(() => {
        activeScan = null;
        scanProgress = null;
        cacheWarmup.start("scan-complete");
      });
  }

  return activeScan;
}

export function registerRoutes(app: Express): void {
  initializeUserProfiles();
  void importMetadataOriginsFromWorkbookIfNeeded()
    .then((result) => {
      if (!result.skipped) console.log(`Imported ${result.imported} metadata filename origins from ${result.sourcePath}`);
    })
    .catch((error) => console.error("Metadata filename origin import failed:", error));
  registerEntityProfileImageRoutes(app);
  registerProductRoutes(app, { onDataChanged: clearResponseCaches });
  // Topic aliases/localizations feed entity pages and actor cards. Build their
  // stable lookup maps before the HTTP listener is exposed so the first detail
  // view does not pay the full-library localization scan.
  warmProductRouteCaches();
  registerUserRoutes(app, { onDataChanged: clearResponseCaches });
  registerDiscoveryRoutes(app);
  registerAgentRoutes(app);
  registerPersonalRoutes(app, { onDataChanged: clearResponseCaches });
  registerLibraryAnalyticsRoutes(app);
  registerGovernanceActionRoutes(app, { onDataChanged: clearResponseCaches });
  registerFavoriteRoutes(app, { onDataChanged: clearResponseCaches });
  registerIngestionRoutes(app);
  registerMetadataRoutes(app, { onDataChanged: clearResponseCaches });
  registerTranslationRoutes(app, { onDataChanged: clearResponseCaches });
  registerPlaybackRoutes(app, { onDataChanged: clearPlaybackResponseCaches });
  registerContentPreviewRoutes(app);
  registerMaintenanceRoutes(app);
  registerPlaylistRoutes(app);
  registerHighlightRoutes(app);
  registerSearchRoutes(app, { domain: searchDomain });
  registerMediaRoutes(app, { domain: mediaDomain });
  ensureMetadataFacetIndex();

  registerSystemRoutes(app, {
    startScan,
    isScanActive: () => Boolean(activeScan),
    getLatestScan: () => latestScan,
    clearResponseCaches,
    getCacheStats: () => ({
      ...searchDomain.getCacheStats(),
      ...mediaDomain.getCacheStats()
    }),
    isCacheWarmupRunning: () => cacheWarmup.isRunning()
  });
}

export async function runInitialScan(): Promise<void> {
  try {
    importMetadataSeedIfAvailable();
  } catch (error) {
    console.error("Metadata seed import failed:", error);
  }

  try {
    importCoverSeedIfAvailable();
  } catch (error) {
    console.error("Cover seed import failed:", error);
  }

  try {
    const searchIndex = ensureMediaSearchIndex();
    if (searchIndex.rebuilt) {
      console.log(`Media search index rebuilt: ${searchIndex.documents} documents`);
    }
  } catch (error) {
    console.error("Media search index initialization failed:", error);
  }

  try {
    const quality = refreshMetadataQualityIssues();
    console.log(`Metadata quality index refreshed: ${quality.issues} issues`);
  } catch (error) {
    console.error("Metadata quality index initialization failed:", error);
  }

  if (config.scanOnStart) {
    setTimeout(() => {
      startScan().catch((error) => {
        console.error("Initial media scan failed:", error);
      });
    }, config.scanStartDelayMs).unref();
  }

  cacheWarmup.start("startup");
  startIngestionAutomation({
    startScan,
    onDataChanged: clearResponseCaches,
    onWarmCache: () => cacheWarmup.start("scan-complete")
  });
  if (config.metadata.autoEnrich && !config.scanOnStart) {
    startMetadataEnrichment({ reason: "startup" })
      .then(() => {
        rebuildMediaSearchIndex();
        refreshMetadataQualityIssues();
        clearResponseCaches();
      })
      .catch((error) => {
        console.error("Startup metadata enrichment failed:", error);
      });
  }
}
