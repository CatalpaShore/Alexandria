import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useState, type Dispatch, type SetStateAction } from "react";
import { updatePlaybackProgress, type MediaItem, type MediaResponse } from "../lib/api";
import { updateMediaPlaybackCache } from "../lib/queryCacheUpdates";

type MediaSetter = Dispatch<SetStateAction<MediaItem | null>>;

export function usePlaybackController(options: {
  mediaItems: MediaItem[];
  hasNextPage?: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => Promise<{ data?: InfiniteData<MediaResponse> }>;
  setDetailItem: MediaSetter;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<MediaItem | null>(null);
  const [playbackQueue, setPlaybackQueue] = useState<MediaItem[] | null>(null);
  const [playbackStartSeconds, setPlaybackStartSeconds] = useState<number | null>(null);
  const activeQueue = playbackQueue ?? options.mediaItems;
  const selectedIndex = selected
    ? activeQueue.findIndex((item) => item.relativePath === selected.relativePath)
    : -1;
  const hasPreviousMedia = selectedIndex > 0;
  const hasNextMedia =
    selectedIndex >= 0 &&
    (selectedIndex < activeQueue.length - 1 || (playbackQueue === null && Boolean(options.hasNextPage)));

  const playbackMutation = useMutation({
    mutationFn: ({
      item,
      positionSeconds,
      durationSeconds,
      completed,
      started
    }: {
      item: MediaItem;
      positionSeconds: number;
      durationSeconds?: number | null;
      completed?: boolean;
      started?: boolean;
    }) => updatePlaybackProgress(item.id, { positionSeconds, durationSeconds, completed, started }),
    onMutate: ({ item, positionSeconds, durationSeconds, completed, started }) => {
      const playback = {
        positionSeconds,
        durationSeconds: durationSeconds ?? item.durationSeconds,
        completed: Boolean(completed),
        playCount: (item.playback?.playCount ?? 0) + (started ? 1 : 0),
        lastPlayedAt: new Date().toISOString()
      };
      updateMediaPlaybackCache(queryClient, item.relativePath, playback);
      setSelected((current) =>
        current?.relativePath === item.relativePath ? { ...current, playback } : current
      );
      setPlaybackQueue((current) => current?.map((candidate) =>
        candidate.relativePath === item.relativePath ? { ...candidate, playback } : candidate
      ) ?? null);
      options.setDetailItem((current) =>
        current?.relativePath === item.relativePath ? { ...current, playback } : current
      );
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ["health-summary"] });
    }
  });

  function handlePlaybackProgress(
    item: MediaItem,
    payload: {
      positionSeconds: number;
      durationSeconds?: number | null;
      completed?: boolean;
      started?: boolean;
    }
  ) {
    playbackMutation.mutate({ item, ...payload });
  }

  async function selectAdjacentMedia(direction: -1 | 1) {
    if (!selected) return;
    const currentIndex = activeQueue.findIndex(
      (item) => item.relativePath === selected.relativePath
    );
    if (currentIndex < 0) return;

    const nextIndex = currentIndex + direction;
    if (nextIndex >= 0 && nextIndex < activeQueue.length) {
      setPlaybackStartSeconds(null);
      setSelected(activeQueue[nextIndex]);
      return;
    }

    if (direction > 0 && playbackQueue === null && options.hasNextPage && !options.isFetchingNextPage) {
      const result = await options.fetchNextPage();
      const nextItems = result.data?.pages.flatMap((page) => page.items) ?? options.mediaItems;
      const loadedIndex = nextItems.findIndex(
        (item) => item.relativePath === selected.relativePath
      );
      if (loadedIndex >= 0 && loadedIndex + 1 < nextItems.length) {
        setPlaybackStartSeconds(null);
        setSelected(nextItems[loadedIndex + 1]);
      }
    }
  }

  function selectMedia(item: MediaItem, queue?: MediaItem[], options?: { startSeconds?: number | null }) {
    if (queue) {
      const seen = new Set<string>();
      setPlaybackQueue(queue.filter((candidate) => {
        if (seen.has(candidate.id)) return false;
        seen.add(candidate.id);
        return true;
      }));
    } else {
      setPlaybackQueue(null);
    }
    setPlaybackStartSeconds(options?.startSeconds ?? null);
    setSelected(item);
  }

  function selectVersion(item: MediaItem) {
    setPlaybackQueue((current) => current?.map((candidate) =>
      candidate.id === selected?.id ? item : candidate
    ) ?? null);
    setPlaybackStartSeconds(null);
    setSelected(item);
  }

  function closePlayback() {
    setSelected(null);
    setPlaybackQueue(null);
    setPlaybackStartSeconds(null);
  }

  return {
    selected,
    setSelected,
    playbackStartSeconds,
    selectMedia,
    selectVersion,
    closePlayback,
    hasPreviousMedia,
    hasNextMedia,
    handlePlaybackProgress,
    selectAdjacentMedia
  };
}
