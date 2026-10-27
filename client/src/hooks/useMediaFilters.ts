import { useEffect, useMemo, useState } from "react";
import type { MediaQuery, SearchSuggestion } from "../lib/api";

const SEARCH_REQUEST_DEBOUNCE_MS = 220;

export function createDefaultMediaQuery(): MediaQuery {
  return {
    q: "",
    letter: "ALL",
    extension: "ALL",
    prefix: "ALL",
    category: "ALL",
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
    favoriteOnly: false,
    groupVersions: true,
    page: 1,
    pageSize: 48,
    sort: "random",
    direction: "asc",
    randomSeed: Date.now()
  };
}

export const DEFAULT_MEDIA_QUERY: MediaQuery = createDefaultMediaQuery();

export function useMediaFilters(initialQuery?: MediaQuery) {
  const [query, setQuery] = useState<MediaQuery>(()=>initialQuery??createDefaultMediaQuery());
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState(query.q);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearchQuery(query.q);
    }, SEARCH_REQUEST_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [query.q]);

  useEffect(() => {
    if (query.source === "ALL" && query.extension === "ALL") return;
    setQuery((current) => ({ ...current, source: "ALL", extension: "ALL", page: 1 }));
  }, [query.extension, query.source]);

  const mediaRequestQuery = useMemo(
    () => ({ ...query, q: debouncedSearchQuery }),
    [debouncedSearchQuery, query]
  );

  const facetQuery = useMemo<Partial<MediaQuery>>(
    () => ({
      q: debouncedSearchQuery,
      letter: query.letter,
      extension: query.extension,
      prefix: query.prefix,
      category: query.category,
      bucket: query.bucket,
      source: query.source,
      tag: query.tag,
      actor: query.actor,
      genre: query.genre,
      director: query.director,
      maker: query.maker,
      label: query.label,
      metadataSeries: query.metadataSeries,
      mediaType: query.mediaType,
      favoriteOnly: query.favoriteOnly
    }),
    [
      debouncedSearchQuery,
      query.actor,
      query.bucket,
      query.category,
      query.director,
      query.extension,
      query.favoriteOnly,
      query.genre,
      query.label,
      query.letter,
      query.maker,
      query.mediaType,
      query.metadataSeries,
      query.prefix,
      query.source,
      query.tag
    ]
  );

  function updateQuery(patch: Partial<MediaQuery>) {
    setQuery((current) => {
      const next = { ...current, ...patch, page: 1 };

      if (patch.category && patch.category !== current.category) {
        next.letter = "ALL";
        next.bucket = "ALL";
        next.source = "ALL";
        next.prefix = "ALL";
        next.tag = "ALL";
        next.actor = [];
        next.genre = [];
        next.director = [];
        next.maker = [];
        next.label = [];
        next.metadataSeries = [];
      }

      return next;
    });
  }

  function resetFilters() {
    setQuery(createDefaultMediaQuery());
  }

  function triggerRandomDiscovery() {
    setQuery((current) => ({
      ...current,
      page: 1,
      sort: "random",
      direction: "asc",
      randomSeed: Math.max(Date.now(), Math.trunc(current.randomSeed ?? 0) + 1)
    }));
  }

  function handleSearchSuggestion(suggestion: SearchSuggestion) {
    if (suggestion.type === "code") {
      updateQuery({ q: suggestion.value });
    } else if (suggestion.type === "actor") {
      updateQuery({ q: "", actor: [suggestion.value] });
    } else if (suggestion.type === "maker") {
      updateQuery({ q: "", maker: [suggestion.value] });
    } else {
      updateQuery({ q: "", genre: [suggestion.value] });
    }
  }

  return {
    query,
    setQuery,
    mediaRequestQuery,
    facetQuery,
    updateQuery,
    resetFilters,
    triggerRandomDiscovery,
    handleSearchSuggestion
  };
}
