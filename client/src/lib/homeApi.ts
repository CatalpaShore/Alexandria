import { fetchMedia, type MediaItem, type MediaQuery, type MediaResponse } from "./api";
import { requestJson } from "./http";

export type HomeSectionKey = "continue" | "history" | "completed" | "recent" | "favorites" | "discover";

export type HomeSectionData = {
  items: MediaItem[];
  total: number;
};

export type RecentIngestionPage = HomeSectionData & {
  page: number;
  pageSize: number;
  totalPages: number;
  startedAt: string;
};

const HOME_ITEM_LIMIT = 12;

const baseQuery: MediaQuery = {
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
  pageSize: HOME_ITEM_LIMIT,
  sort: "mtime",
  direction: "desc",
  randomSeed: 0
};

function getDiscoverySeed(now = Date.now()): number {
  // Keep discovery stable long enough for React Query caching and refresh it four times a day.
  return Math.floor(now / (6 * 60 * 60 * 1000));
}

function buildSectionQuery(section: HomeSectionKey): MediaQuery {
  switch (section) {
    case "continue":
      return {
        ...baseQuery,
        playbackState: "inProgress",
        sort: "recentPlayed",
        direction: "desc"
      };
    case "history":
      return {
        ...baseQuery,
        playbackState: "history",
        sort: "recentPlayed",
        direction: "desc"
      };
    case "completed":
      return {
        ...baseQuery,
        playbackState: "completed",
        sort: "recentPlayed",
        direction: "desc"
      };
    case "favorites":
      return {
        ...baseQuery,
        favoriteOnly: true,
        sort: "mtime",
        direction: "desc"
      };
    case "discover":
      return {
        ...baseQuery,
        sort: "random",
        direction: "asc",
        randomSeed: getDiscoverySeed()
      };
    case "recent":
    default:
      return baseQuery;
  }
}

export const homeQueryKeys = {
  all: ["home-dashboard"] as const,
  section: (section: HomeSectionKey) => ["home-dashboard", section] as const
};

export function getHomeWallQuery(section: HomeSectionKey): Partial<MediaQuery> {
  const query = buildSectionQuery(section);

  return {
    favoriteOnly: query.favoriteOnly,
    sort: query.sort,
    direction: query.direction,
    randomSeed: query.randomSeed,
    playbackState: query.playbackState,
    page: 1
  };
}

export async function fetchHomeSection(section: HomeSectionKey): Promise<HomeSectionData> {
  const response = await fetchMedia(buildSectionQuery(section));
  const items = response.items.slice(0, HOME_ITEM_LIMIT);

  return {
    items,
    total: response.total
  };
}

export function fetchHomeSectionPage(
  section: HomeSectionKey,
  page = 1,
  pageSize = 48
): Promise<MediaResponse> {
  return fetchMedia({ ...buildSectionQuery(section), page, pageSize });
}

export async function fetchRecentIngestionPage(page = 1, pageSize = HOME_ITEM_LIMIT): Promise<RecentIngestionPage> {
  const params = new URLSearchParams({ page: String(page), limit: String(pageSize) });
  return requestJson<RecentIngestionPage>(`/api/ingestion/recent-media?${params}`, { cache: "no-store" });
}

export async function fetchRecentIngestionSection(): Promise<HomeSectionData> {
  return fetchRecentIngestionPage();
}
