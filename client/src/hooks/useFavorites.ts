import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { message } from "antd";
import type { Dispatch, SetStateAction } from "react";
import {
  fetchFavorites,
  updateEntityFavorite,
  updateFavorite,
  type FavoritesResponse,
  type MediaItem,
  type TopicType
} from "../lib/api";
import { updateEntityFavoriteCache, updateMediaFavoriteCache } from "../lib/queryCacheUpdates";

type MediaSetter = Dispatch<SetStateAction<MediaItem | null>>;

export function useFavorites(options: {
  enabled?: boolean;
  favoriteOnly: boolean;
  setSelected: MediaSetter;
  setDetailItem: MediaSetter;
}) {
  const queryClient = useQueryClient();
  const favorites = useQuery({
    queryKey: ["favorites"],
    queryFn: fetchFavorites,
    enabled: options.enabled ?? true
  });

  const favoriteMutation = useMutation({
    mutationFn: ({ relativePath, favorite }: { relativePath: string; favorite: boolean; item?: MediaItem }) =>
      updateFavorite(relativePath, favorite),
    onMutate: ({ relativePath, favorite }) => {
      updateMediaFavoriteCache(queryClient, relativePath, favorite, options.favoriteOnly);
      options.setSelected((current) =>
        current?.relativePath === relativePath ? { ...current, isFavorite: favorite } : current
      );
      options.setDetailItem((current) =>
        current?.relativePath === relativePath ? { ...current, isFavorite: favorite } : current
      );
    },
    onSuccess: (data) => queryClient.setQueryData<FavoritesResponse>(["favorites"], data),
    onError: async (error) => {
      message.error(error instanceof Error ? error.message : "收藏更新失败");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["favorites"] }),
        queryClient.invalidateQueries({ queryKey: ["media"] }),
        queryClient.invalidateQueries({ queryKey: ["media-detail"] }),
        queryClient.invalidateQueries({ queryKey: ["media-recommendations-v2"] }),
        queryClient.invalidateQueries({ queryKey: ["media-recommendations-v3"] }),
        queryClient.invalidateQueries({ queryKey: ["personal-recommendations"] }),
        queryClient.invalidateQueries({ queryKey: ["home-dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["entity"] })
      ]);
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["favorites"] }),
        queryClient.invalidateQueries({ queryKey: ["health-summary"] }),
        queryClient.invalidateQueries({ queryKey: ["media"] }),
        queryClient.invalidateQueries({ queryKey: ["media-detail"] }),
        queryClient.invalidateQueries({ queryKey: ["media-recommendations-v2"] }),
        queryClient.invalidateQueries({ queryKey: ["media-recommendations-v3"] }),
        queryClient.invalidateQueries({ queryKey: ["personal-recommendations"] }),
        queryClient.invalidateQueries({ queryKey: ["home-dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["entity"] })
      ]);
    }
  });

  const entityFavoriteMutation = useMutation({
    mutationFn: updateEntityFavorite,
    onMutate: ({ type, value, favorite }) => {
      updateEntityFavoriteCache(queryClient, type, value, favorite);
    },
    onSuccess: (data) => queryClient.setQueryData<FavoritesResponse>(["favorites"], data),
    onError: async (error) => {
      message.error(error instanceof Error ? error.message : "专题收藏更新失败");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["topic-items"] }),
        queryClient.invalidateQueries({ queryKey: ["entity"] })
      ]);
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["favorites"] }),
        queryClient.invalidateQueries({ queryKey: ["topic-items"] }),
        queryClient.invalidateQueries({ queryKey: ["entity"] }),
        queryClient.invalidateQueries({ queryKey: ["topic-overview"] })
      ]);
    }
  });

  function handleToggleFavorite(item: MediaItem, favorite: boolean) {
    favoriteMutation.mutate({ relativePath: item.relativePath, favorite, item });
  }

  function handleRemoveFavorite(relativePath: string) {
    favoriteMutation.mutate({ relativePath, favorite: false });
  }

  function handleToggleEntityFavorite(
    entity: { type: TopicType; value: string; label: string },
    favorite: boolean
  ) {
    entityFavoriteMutation.mutate({ ...entity, favorite });
  }

  return { favorites, handleToggleFavorite, handleRemoveFavorite, handleToggleEntityFavorite };
}
