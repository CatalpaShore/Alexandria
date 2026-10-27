import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  fetchFacets,
  fetchMedia,
  type FacetsResponse,
  type MediaQuery,
  type MediaResponse
} from "../lib/api";
import { DEFAULT_MEDIA_QUERY } from "./useMediaFilters";

export const CATALOG_CACHE_STALE_TIME = 10 * 60 * 1000;
export const CATALOG_CACHE_GC_TIME = 30 * 60 * 1000;
const CACHE_WARMUP_START_DELAY_MS = 1600;
const CACHE_WARMUP_STEP_DELAY_MS = 650;

function waitForWarmupSlot(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function getWarmupCategories(categories: Array<{ value: string }>) {
  const preferredOrder = ["ALL", "JAV", "FC2"];
  const seen = new Set<string>();
  return [...preferredOrder, ...categories.map((category) => category.value)]
    .map((category) => category.toUpperCase())
    .filter((category) => {
      if (seen.has(category)) return false;
      seen.add(category);
      return true;
    })
    .slice(0, 6);
}

export function useCatalogWarmup(options: {
  enabled?: boolean;
  facets?: FacetsResponse;
  firstPage?: MediaResponse;
  query: MediaQuery;
}) {
  const queryClient = useQueryClient();
  const stateRef = useRef<"idle" | "scheduled" | "running" | "done">("idle");
  const { facets, firstPage, query } = options;

  useEffect(() => {
    if (
      stateRef.current !== "idle" ||
      options.enabled === false ||
      !facets ||
      facets.scanning ||
      !firstPage ||
      query.q ||
      query.favoriteOnly
    ) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      stateRef.current = "running";

      void (async () => {
        for (const category of getWarmupCategories(facets.categories)) {
          if (cancelled) return;
          const warmQuery: MediaQuery = {
            ...DEFAULT_MEDIA_QUERY,
            category,
            pageSize: query.pageSize,
            sort: query.sort,
            direction: query.direction,
            randomSeed: query.randomSeed
          };
          const warmFacetQuery: Partial<MediaQuery> = {
            q: "",
            letter: "ALL",
            extension: "ALL",
            prefix: "ALL",
            category,
            bucket: "ALL",
            source: "ALL",
            tag: "ALL",
            actor: [],
            genre: [],
            director: [],
            maker: [],
            label: [],
            metadataSeries: [],
            mediaType: "ALL",
            favoriteOnly: false
          };

          await queryClient.prefetchQuery({
            queryKey: ["facets", warmFacetQuery],
            queryFn: () => fetchFacets(warmFacetQuery),
            staleTime: CATALOG_CACHE_STALE_TIME,
            gcTime: CATALOG_CACHE_GC_TIME
          }).catch(() => undefined);
          if (cancelled) return;
          await waitForWarmupSlot(CACHE_WARMUP_STEP_DELAY_MS);

          await queryClient.prefetchInfiniteQuery({
            queryKey: ["media", warmQuery],
            queryFn: ({ pageParam }) => fetchMedia({
              ...warmQuery,
              page: 1,
              pagination: "cursor",
              cursor: typeof pageParam === "string" ? pageParam : undefined
            }),
            initialPageParam: null as string | null,
            getNextPageParam: (lastPage: MediaResponse) => lastPage.nextCursor || undefined,
            staleTime: CATALOG_CACHE_STALE_TIME,
            gcTime: CATALOG_CACHE_GC_TIME
          }).catch(() => undefined);
          if (cancelled) return;
          await waitForWarmupSlot(CACHE_WARMUP_STEP_DELAY_MS);
        }

        if (!cancelled) stateRef.current = "done";
      })().catch(() => {
        if (!cancelled) stateRef.current = "idle";
      });
    }, CACHE_WARMUP_START_DELAY_MS);

    stateRef.current = "scheduled";
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (stateRef.current === "scheduled" || stateRef.current === "running") {
        stateRef.current = "idle";
      }
    };
  }, [
    options.enabled,
    facets,
    firstPage,
    query.direction,
    query.favoriteOnly,
    query.pageSize,
    query.q,
    query.randomSeed,
    query.sort,
    queryClient
  ]);
}
