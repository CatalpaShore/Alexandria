import { useEffect, useRef } from "react";

type InfiniteScrollOptions = {
  enabled?: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => Promise<unknown> | void;
  rootMargin?: string;
};

export function useInfiniteScroll({
  enabled = true,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  rootMargin = "700px 0px"
}: InfiniteScrollOptions) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!enabled || !sentinel || !hasNextPage) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage) {
          void onLoadMore();
        }
      },
      { rootMargin }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [enabled, hasNextPage, isFetchingNextPage, onLoadMore, rootMargin]);

  return sentinelRef;
}
