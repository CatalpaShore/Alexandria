import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type {
  EntityResponse,
  MediaDetailResponse,
  MediaItem,
  MediaResponse,
  RecommendationsResponse,
  TopicListResponse,
  TopicType
} from "./api";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMediaItem(value: unknown): value is MediaItem {
  return isRecord(value) && typeof value.relativePath === "string";
}

export function updateMediaItemsInQueryData(
  data: unknown,
  updateItem: (item: MediaItem) => MediaItem
): unknown {
  if (!isRecord(data)) return data;

  if (Array.isArray(data.items)) {
    return {
      ...data,
      items: data.items.map((item) => isMediaItem(item) ? updateItem(item) : item)
    };
  }

  if (Array.isArray(data.pages)) {
    return {
      ...data,
      pages: data.pages.map((page) => {
        if (!isRecord(page) || !Array.isArray(page.items)) return page;
        return {
          ...page,
          items: page.items.map((item) => isMediaItem(item) ? updateItem(item) : item)
        };
      })
    };
  }

  return data;
}

export function updateMediaFavoriteCache(
  queryClient: QueryClient,
  relativePath: string,
  favorite: boolean,
  favoriteOnly: boolean
) {
  queryClient.setQueriesData<InfiniteData<MediaResponse>>({ queryKey: ["media"] }, (data) => {
    if (!data) return data;

    return {
      ...data,
      pages: data.pages.map((page) => {
        const items = page.items.map((item) =>
          item.relativePath === relativePath ? { ...item, isFavorite: favorite } : item
        );
        return { ...page, items: favoriteOnly ? items.filter((item) => item.isFavorite) : items };
      })
    };
  });

  queryClient.setQueriesData<MediaDetailResponse>({ queryKey: ["media-detail"] }, (data) => {
    if (!data) return data;
    const updateItem = (item: MediaItem) =>
      item.relativePath === relativePath ? { ...item, isFavorite: favorite } : item;

    return {
      ...data,
      item: updateItem(data.item),
      versions: data.versions.map(updateItem)
    };
  });

  queryClient.setQueriesData<RecommendationsResponse>(
    { queryKey: ["media-recommendations-v2"] },
    (data) => data ? {
      ...data,
      items: data.items.map((item) =>
        item.relativePath === relativePath ? { ...item, isFavorite: favorite } : item
      )
    } : data
  );

  const updateItem = (item: MediaItem) =>
    item.relativePath === relativePath ? { ...item, isFavorite: favorite } : item;

  queryClient.setQueriesData(
    { queryKey: ["media-recommendations-v3"] },
    (data) => updateMediaItemsInQueryData(data, updateItem)
  );

  queryClient.setQueriesData(
    { queryKey: ["personal-recommendations"] },
    (data) => updateMediaItemsInQueryData(data, updateItem)
  );

  queryClient.setQueriesData(
    { queryKey: ["home-dashboard"] },
    (data) => updateMediaItemsInQueryData(data, updateItem)
  );

  if (!favorite) {
    queryClient.setQueryData<{ items: MediaItem[]; total: number }>(
      ["home-dashboard", "favorites"],
      (data) => data ? {
        ...data,
        items: data.items.filter((item) => item.relativePath !== relativePath),
        total: Math.max(0, data.total - 1)
      } : data
    );
  }

  queryClient.setQueriesData<InfiniteData<EntityResponse>>({ queryKey: ["entity"] }, (data) => {
    if (!data) return data;
    return {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        items: page.items.map((item) =>
          item.relativePath === relativePath ? { ...item, isFavorite: favorite } : item
        )
      }))
    };
  });
}

export function updateEntityFavoriteCache(
  queryClient: QueryClient,
  type: TopicType,
  value: string,
  favorite: boolean
) {
  queryClient.setQueriesData<InfiniteData<TopicListResponse>>(
    { queryKey: ["topic-items"] },
    (data) => data ? {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        items: page.items.map((item) =>
          page.type === type && item.value === value ? { ...item, isFavorite: favorite } : item
        )
      }))
    } : data
  );
  queryClient.setQueriesData<InfiniteData<EntityResponse>>({ queryKey: ["entity"] }, (data) => {
    if (!data) return data;
    return {
      ...data,
      pages: data.pages.map((page) => {
        const related = { ...page.entity.related };
        related[type] = related[type].map((item) =>
          item.value === value ? { ...item, isFavorite: favorite } : item
        );
        return {
          ...page,
          entity: {
            ...page.entity,
            isFavorite:
              page.entity.type === type && page.entity.value === value
                ? favorite
                : page.entity.isFavorite,
            related
          }
        };
      })
    };
  });
}

export function updateMediaPlaybackCache(
  queryClient: QueryClient,
  relativePath: string,
  playback: NonNullable<MediaItem["playback"]>
) {
  queryClient.setQueriesData<InfiniteData<MediaResponse>>({ queryKey: ["media"] }, (data) => {
    if (!data) return data;
    return {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        items: page.items.map((item) =>
          item.relativePath === relativePath ? { ...item, playback } : item
        )
      }))
    };
  });

  const updateItem = (item: MediaItem) =>
    item.relativePath === relativePath ? { ...item, playback } : item;

  queryClient.setQueriesData<MediaDetailResponse>({ queryKey: ["media-detail"] }, (data) => data ? {
    ...data,
    item: updateItem(data.item),
    versions: data.versions.map(updateItem)
  } : data);

  queryClient.setQueriesData<RecommendationsResponse>(
    { queryKey: ["media-recommendations-v2"] },
    (data) => data ? { ...data, items: data.items.map(updateItem) } : data
  );

  queryClient.setQueriesData(
    { queryKey: ["media-recommendations-v3"] },
    (data) => updateMediaItemsInQueryData(data, updateItem)
  );

  queryClient.setQueriesData(
    { queryKey: ["personal-recommendations"] },
    (data) => updateMediaItemsInQueryData(data, updateItem)
  );

  queryClient.setQueriesData(
    { queryKey: ["home-dashboard"] },
    (data) => updateMediaItemsInQueryData(data, updateItem)
  );

  queryClient.setQueriesData<InfiniteData<EntityResponse>>({ queryKey: ["entity"] }, (data) => data ? {
    ...data,
    pages: data.pages.map((page) => ({ ...page, items: page.items.map(updateItem) }))
  } : data);
}
