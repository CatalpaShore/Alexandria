import { getIntlLocale } from "../i18n/core";
import { t, useLocale, useLocalizedMemo } from "../i18n";
import { Empty, Skeleton, Spin, Typography } from "antd";
import { useVirtualizer, useWindowVirtualizer } from "@tanstack/react-virtual";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import type { VirtualItem } from "@tanstack/react-virtual";
import type { MediaItem } from "../lib/api";
import { getMediaCardTagLimit, MEDIA_WALL_ROW_OVERSCAN } from "../lib/mediaWallLayout";
import type { MetadataLanguage } from "../lib/metadataDisplay";
import { MediaCard } from "./MediaCard";
import { useVisibleReorderMotion } from "../hooks/useVisibleReorderMotion";

const MobileReel = lazy(() =>
  import("./MobileReel").then((module) => ({ default: module.MobileReel }))
);

type MediaWallProps = {
  items: MediaItem[];
  total: number;
  loaded: number;
  isLoading: boolean;
  isRefreshing: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  minimumColumns?: number;
  metadataLanguage: MetadataLanguage;
  pageLabel: string;
  headerAction?: ReactNode;
  viewMode?: "grid" | "reel";
  onOpen: (item: MediaItem) => void;
  onPlay?: (item: MediaItem) => void;
  onExitReel?: () => void;
  onToggleFavorite?: (item: MediaItem, favorite: boolean) => void;
  onLoadMore: () => void;
  containedScroll?: boolean;
  scrollResetKey?: string;
};

type VirtualizedMediaGridProps = {
  items: MediaItem[];
  columns: number;
  cardHeight: number;
  gap: number;
  gridWidth: number;
  visibleTagLimit: number;
  metadataLanguage: MetadataLanguage;
  onOpen: (item: MediaItem) => void;
  onPlay?: (item: MediaItem) => void;
  onToggleFavorite?: (item: MediaItem, favorite: boolean) => void;
  gridElementRef: RefObject<HTMLDivElement | null>;
  setGridElement: (grid: HTMLDivElement | null) => void;
};

type MediaGridSurfaceProps = VirtualizedMediaGridProps & {
  scrollMargin: number;
  totalSize: number;
  virtualRows: VirtualItem[];
};

function MediaGridSurface({
  items,
  columns,
  cardHeight,
  gap,
  gridWidth,
  visibleTagLimit,
  metadataLanguage,
  onOpen,
  onPlay,
  onToggleFavorite,
  scrollMargin,
  setGridElement,
  totalSize,
  virtualRows
}: MediaGridSurfaceProps) {
  useLocale();
  return (
    <div
      className="virtual-media-grid"
      data-columns={columns}
      data-grid-width={Math.round(gridWidth)}
      data-row-height={Math.round(cardHeight + gap)}
      ref={setGridElement}
      style={{ height: `${totalSize}px` }}
    >
      {virtualRows.map((virtualRow) => {
        const start = virtualRow.index * columns;
        const rowItems = items.slice(start, start + columns);
        return (
          <div
            className="virtual-media-row"
            key={virtualRow.key}
            style={{
              gap: `${gap}px`,
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              transform: `translateY(${virtualRow.start - scrollMargin}px)`
            }}
          >
            {rowItems.map((item) => (
              <MediaCard
                item={item}
                key={item.id}
                metadataLanguage={metadataLanguage}
                onOpen={onOpen}
                onPlay={onPlay}
                onToggleFavorite={onToggleFavorite}
                visibleTagLimit={visibleTagLimit}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function WindowVirtualMediaGrid(props: VirtualizedMediaGridProps) {
  useLocale();
  const rowCount = Math.ceil(props.items.length / props.columns);
  const rowVirtualizer = useWindowVirtualizer({
    count: rowCount,
    estimateSize: () => props.cardHeight + props.gap,
    overscan: MEDIA_WALL_ROW_OVERSCAN,
    scrollMargin: props.gridElementRef.current?.offsetTop ?? 0
  });

  useLayoutEffect(() => {
    rowVirtualizer.measure();
  }, [props.cardHeight, props.columns, props.gap, rowVirtualizer]);

  return (
    <MediaGridSurface
      {...props}
      scrollMargin={rowVirtualizer.options.scrollMargin}
      totalSize={rowVirtualizer.getTotalSize()}
      virtualRows={rowVirtualizer.getVirtualItems()}
    />
  );
}

function ContainedVirtualMediaGrid({
  scrollElementRef,
  ...props
}: VirtualizedMediaGridProps & { scrollElementRef: RefObject<HTMLElement | null> }) {
  useLocale();
  const rowCount = Math.ceil(props.items.length / props.columns);
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    estimateSize: () => props.cardHeight + props.gap,
    getScrollElement: () => scrollElementRef.current,
    overscan: MEDIA_WALL_ROW_OVERSCAN
  });

  useLayoutEffect(() => {
    rowVirtualizer.measure();
  }, [props.cardHeight, props.columns, props.gap, rowVirtualizer]);

  return (
    <MediaGridSurface
      {...props}
      scrollMargin={0}
      totalSize={rowVirtualizer.getTotalSize()}
      virtualRows={rowVirtualizer.getVirtualItems()}
    />
  );
}

export function MediaWall({
  items,
  total,
  loaded,
  isLoading,
  isRefreshing,
  isFetchingNextPage,
  hasNextPage,
  minimumColumns = 2,
  headerAction,
  metadataLanguage,
  pageLabel,
  viewMode = "grid",
  onOpen,
  onPlay,
  onExitReel,
  onToggleFavorite,
  onLoadMore,
  containedScroll = false,
  scrollResetKey
}: MediaWallProps) {
  useLocale();
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const gridObserverRef = useRef<ResizeObserver | null>(null);
  const gridResizeTimerRef = useRef<number | null>(null);
  const measuredGridWidthRef = useRef(0);
  const [gridWidth, setGridWidth] = useState(0);
  useVisibleReorderMotion(gridRef);
  const setGridElement = useCallback((grid: HTMLDivElement | null) => {
    gridObserverRef.current?.disconnect();
    gridObserverRef.current = null;
    if (gridResizeTimerRef.current !== null) {
      window.clearTimeout(gridResizeTimerRef.current);
      gridResizeTimerRef.current = null;
    }
    gridRef.current = grid;
    if (!grid) {
      measuredGridWidthRef.current = 0;
      return;
    }

    const update = () => {
      const nextWidth = grid.clientWidth;
      if (measuredGridWidthRef.current === 0) {
        measuredGridWidthRef.current = nextWidth;
        setGridWidth(nextWidth);
        return;
      }
      if (gridResizeTimerRef.current !== null) {
        window.clearTimeout(gridResizeTimerRef.current);
      }
      gridResizeTimerRef.current = window.setTimeout(() => {
        const settledWidth = grid.clientWidth;
        measuredGridWidthRef.current = settledWidth;
        setGridWidth(settledWidth);
        gridResizeTimerRef.current = null;
      }, 72);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(grid);
    gridObserverRef.current = observer;
  }, []);

  const gridMetrics = useLocalizedMemo(() => {
    const compactGrid = gridWidth <= 820;
    const gap = compactGrid ? (gridWidth <= 430 ? 8 : 10) : 14;
    const minimumWidth = gridWidth >= 1760 ? 240 : gridWidth >= 1180 ? 220 : 180;
    const fluidColumns = compactGrid
      ? 2
      : Math.max(1, Math.floor((gridWidth + gap) / (minimumWidth + gap)));
    const columns = Math.max(minimumColumns, fluidColumns);
    const cardWidth = gridWidth > 0 ? (gridWidth - gap * (columns - 1)) / columns : 240;
    const cardHeight = cardWidth * 9 / 16 + 86;
    const visibleTagLimit = getMediaCardTagLimit(cardWidth);
    return { gap, columns, cardHeight, visibleTagLimit };
  }, [gridWidth, minimumColumns]);
  useEffect(() => {
    if (!containedScroll) return;
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [containedScroll, scrollResetKey]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasNextPage) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage) {
          onLoadMore();
        }
      },
      {
        root: containedScroll ? scrollContainerRef.current : null,
        rootMargin: "900px 0px"
      }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [containedScroll, hasNextPage, isFetchingNextPage, onLoadMore]);

  if (isLoading) {
    return (
      <section className="wall-shell" id="media-wall-scroll" ref={scrollContainerRef}>
        <div className="result-line">
          <Skeleton.Button active className="result-skeleton-title" />
          <Skeleton.Button active className="result-skeleton-subtitle" />
        </div>
        <div className="media-grid skeleton-grid">
          {Array.from({ length: 12 }, (_, index) => (
            <div className="media-card-skeleton" key={index}>
              <Skeleton.Image active className="media-card-skeleton-thumb" />
              <Skeleton active paragraph={{ rows: 2 }} title={false} />
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (items.length === 0) {
    return (
      <div className="empty-state">
        <Empty description={t("没有找到匹配的媒体文件")} />
      </div>
    );
  }

  if (viewMode === "reel") {
    return (
      <Suspense fallback={<div className="reel-loading"><Spin /> {t("正在加载播放器")}</div>}>
        <MobileReel
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          items={items}
          loaded={loaded}
          onExitReel={onExitReel}
          onLoadMore={onLoadMore}
          metadataLanguage={metadataLanguage}
          onOpen={onOpen}
          onToggleFavorite={onToggleFavorite}
          total={total}
        />
      </Suspense>
    );
  }

  return (
    <section aria-busy={isRefreshing || undefined} className={`wall-shell${isRefreshing ? " is-refreshing" : ""}`} id="media-wall-scroll" ref={scrollContainerRef}>
      <div className="result-line">
        {headerAction ?? <Typography.Text strong>{total.toLocaleString(getIntlLocale())} {t("个文件")}</Typography.Text>}
        <Typography.Text type="secondary">{pageLabel}</Typography.Text>
        {isRefreshing && (
          <span aria-label={t("正在更新媒体结果")} className="media-results-refresh" role="status">
            <span aria-hidden="true" />{t("正在更新")} </span>
        )}
      </div>
      {containedScroll ? (
        <ContainedVirtualMediaGrid
          cardHeight={gridMetrics.cardHeight}
          columns={gridMetrics.columns}
          gap={gridMetrics.gap}
          gridElementRef={gridRef}
          gridWidth={gridWidth}
          items={items}
          visibleTagLimit={gridMetrics.visibleTagLimit}
          metadataLanguage={metadataLanguage}
          onOpen={onOpen}
          onPlay={onPlay}
          onToggleFavorite={onToggleFavorite}
          scrollElementRef={scrollContainerRef}
          setGridElement={setGridElement}
        />
      ) : (
        <WindowVirtualMediaGrid
          cardHeight={gridMetrics.cardHeight}
          columns={gridMetrics.columns}
          gap={gridMetrics.gap}
          gridElementRef={gridRef}
          gridWidth={gridWidth}
          items={items}
          visibleTagLimit={gridMetrics.visibleTagLimit}
          metadataLanguage={metadataLanguage}
          onOpen={onOpen}
          onPlay={onPlay}
          onToggleFavorite={onToggleFavorite}
          setGridElement={setGridElement}
        />
      )}
      <div className="load-sentinel" ref={sentinelRef}>
        {isFetchingNextPage && (
          <span>
            <Spin size="small" /> {t("正在加载更多")} </span>
        )}
        {!hasNextPage && loaded > 0 && <Typography.Text type="secondary">{t("已经到底了")}</Typography.Text>}
      </div>
    </section>
  );
}
