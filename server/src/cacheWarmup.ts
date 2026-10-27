import type { SearchDomain } from "./searchDomain.js";

const CACHE_WARMUP_STEP_DELAY_MS = 700;

function waitForSlot(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createCacheWarmup(options: {
  searchDomain: SearchDomain;
  isScanActive: () => boolean;
  isApiIdle: () => boolean;
}) {
  let activeWarmup: Promise<void> | null = null;

  async function waitUntilIdle(): Promise<boolean> {
    while (!options.isApiIdle()) {
      if (options.isScanActive()) return false;
      await waitForSlot(1_000);
    }
    return !options.isScanActive();
  }

  function start(reason: string): void {
    if (activeWarmup || options.isScanActive()) return;

    activeWarmup = (async () => {
      for (const category of options.searchDomain.getWarmupCategories()) {
        if (!await waitUntilIdle()) return;
        options.searchDomain.warmFacets({ category, mediaType: undefined });

        await waitForSlot(CACHE_WARMUP_STEP_DELAY_MS);
        if (!await waitUntilIdle()) return;
        options.searchDomain.warmMedia({
          category,
          page: 1,
          pageSize: 48,
          sort: "name",
          direction: "asc"
        });

        await waitForSlot(CACHE_WARMUP_STEP_DELAY_MS);
      }

      for (const searchQuery of options.searchDomain.getWarmupSearchQueries()) {
        if (!await waitUntilIdle()) return;
        options.searchDomain.warmMedia({
          ...searchQuery,
          page: 1,
          pageSize: 48,
          sort: "name",
          direction: "asc"
        });
        await waitForSlot(CACHE_WARMUP_STEP_DELAY_MS);
      }
    })()
      .catch((error) => {
        console.error(`Media cache warmup failed (${reason}):`, error);
      })
      .finally(() => {
        activeWarmup = null;
      });
  }

  return {
    start,
    isRunning: () => Boolean(activeWarmup)
  };
}
