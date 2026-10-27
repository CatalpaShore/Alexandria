import { useVirtualizer } from "@tanstack/react-virtual";
import { Image } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type MediaItem } from "../lib/api";
import { getMediaDisplayTitle, type MetadataLanguage } from "../lib/metadataDisplay";
import { EntityMediaCard } from "./EntityMediaCard";

type EntityMediaVirtualGridProps = {
  items: MediaItem[];
  metadataLanguage: MetadataLanguage;
  onOpenMedia: (item: MediaItem, queue: MediaItem[]) => void;
  onPlay: (item: MediaItem, queue: MediaItem[]) => void;
  onSetCover: (item: MediaItem) => void;
  coverMediaId: string | null;
  settingCoverMediaId: string | null;
};

type GridMetrics = {
  cardHeight: number;
  columns: number;
  gap: number;
};

const DEFAULT_CARD_WIDTH = 240;
const CARD_CONTENT_HEIGHT = 78;

function getGridMetrics(width: number): GridMetrics {
  const gap = width <= 520 ? 8 : 10;
  const columns = width <= 720
    ? 2
    : Math.max(1, Math.floor((width + gap) / (220 + gap)));
  const cardWidth = width > 0
    ? (width - gap * (columns - 1)) / columns
    : DEFAULT_CARD_WIDTH;

  return {
    cardHeight: cardWidth * 9 / 16 + CARD_CONTENT_HEIGHT,
    columns,
    gap
  };
}

export function EntityMediaVirtualGrid({
  items,
  metadataLanguage,
  onOpenMedia,
  onPlay,
  onSetCover,
  coverMediaId,
  settingCoverMediaId
}: EntityMediaVirtualGridProps) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [gridWidth, setGridWidth] = useState(0);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  const updateMeasurements = useCallback((grid: HTMLDivElement, scrollRoot: HTMLElement) => {
    const nextWidth = grid.clientWidth;
    const nextScrollMargin = grid.getBoundingClientRect().top
      - scrollRoot.getBoundingClientRect().top
      + scrollRoot.scrollTop;

    setGridWidth((current) => current === nextWidth ? current : nextWidth);
    setScrollMargin((current) => Math.abs(current - nextScrollMargin) < 0.5 ? current : nextScrollMargin);
  }, []);

  const setGridElement = useCallback((grid: HTMLDivElement | null) => {
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    resizeCleanupRef.current?.();
    resizeCleanupRef.current = null;
    gridRef.current = grid;

    if (!grid) {
      setScrollElement(null);
      return;
    }

    const scrollRoot = grid.closest<HTMLElement>(".ant-drawer-body");
    if (!scrollRoot) return;

    setScrollElement(scrollRoot);
    updateMeasurements(grid, scrollRoot);

    const observer = new ResizeObserver(() => updateMeasurements(grid, scrollRoot));
    observer.observe(grid);
    observer.observe(scrollRoot);
    resizeObserverRef.current = observer;
    const handleResize = () => updateMeasurements(grid, scrollRoot);
    window.addEventListener("resize", handleResize);
    resizeCleanupRef.current = () => window.removeEventListener("resize", handleResize);
  }, [updateMeasurements]);

  useLayoutEffect(() => () => {
    resizeObserverRef.current?.disconnect();
    resizeCleanupRef.current?.();
  }, []);

  const metrics = useMemo(() => getGridMetrics(gridWidth), [gridWidth]);
  const rowCount = Math.ceil(items.length / metrics.columns);
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    estimateSize: () => metrics.cardHeight + metrics.gap,
    getScrollElement: () => scrollElement,
    overscan: 3,
    scrollMargin
  });

  useLayoutEffect(() => {
    rowVirtualizer.measure();
  }, [metrics.cardHeight, metrics.columns, metrics.gap, rowVirtualizer, scrollMargin]);

  return (
    <div
      aria-label="关联视频"
      className="entity-virtual-grid"
      data-columns={metrics.columns}
      data-loaded={items.length}
      ref={setGridElement}
      role="list"
      style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
    >
      {rowVirtualizer.getVirtualItems().map((virtualRow) => {
        const start = virtualRow.index * metrics.columns;
        const rowItems = items.slice(start, start + metrics.columns);

        return (
          <div
            className="entity-virtual-row"
            key={virtualRow.key}
            role="presentation"
            style={{
              gap: `${metrics.gap}px`,
              gridTemplateColumns: `repeat(${metrics.columns}, minmax(0, 1fr))`,
              height: `${metrics.cardHeight}px`,
              transform: `translateY(${virtualRow.start - scrollMargin}px)`
            }}
          >
            {rowItems.map((item) => (
              <EntityMediaCard
                key={item.id}
                item={item}
                title={getMediaDisplayTitle(item, metadataLanguage)}
                onOpen={() => onOpenMedia(item, items)}
                onPlay={() => onPlay(item, items)}
                coverAction={
                  <button
                    aria-label={`将 ${item.normalizedCode || item.basename} 设为专题封面`}
                    aria-pressed={coverMediaId === item.id}
                    className={`entity-virtual-set-cover${coverMediaId === item.id ? " is-active" : ""}`}
                    disabled={settingCoverMediaId !== null}
                    onClick={() => onSetCover(item)}
                    title={coverMediaId === item.id ? "当前专题封面" : "设为专题封面"}
                    type="button"
                  ><Image size={14} /></button>
                }
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
