import { getIntlLocale } from "../i18n/core";
import { t, useLocale, useLocalizedMemo } from "../i18n";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { Button, Empty, Input, Select, Skeleton, Spin, Statistic, Tabs, Tag, Typography } from "antd";
import {
  Badge,
  Clapperboard,
  Factory,
  Hash,
  Layers3,
  Network,
  Search,
  Tags,
  UsersRound,
  type LucideIcon
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  fetchTopicItems,
  fetchTopicOverview,
  type TopicListItem,
  type TopicType
} from "../lib/api";
import { TopicEntityCard } from "./TopicEntityCard";
import { useVisibleReorderMotion } from "../hooks/useVisibleReorderMotion";

type TopicExplorerProps = {
  onOpenGraph: () => void;
  onOpenEntity: (entity: { type: TopicType; value: string; label?: string }) => void;
  onToggleFavorite: (entity: { type: TopicType; value: string; label: string }, favorite: boolean) => void;
};

const { Text, Title } = Typography;
const PAGE_SIZE = 60;
const PROFILE_TOPIC_TYPES = new Set<TopicType>(["actor", "director", "maker", "label", "series"]);

function profileCoverageTitle(type: TopicType, coverage: NonNullable<
  Awaited<ReturnType<typeof fetchTopicOverview>>["dimensions"][number]["profileCoverage"]
>): string {
  const noun = type === "actor" ? t("位演员") : type === "director" ? t("位导演") : type === "maker" ? t("个厂商") : type === "series" ? t("个系列") : t("个厂牌");
  const fields = type === "actor"
    ? [
      t("生日 {{p0}}", { p0: coverage.withBirthDate.toLocaleString(getIntlLocale()) }),
      t("身高 {{p0}}", { p0: coverage.withHeight.toLocaleString(getIntlLocale()) }),
      t("完整三围 {{p0}}", { p0: coverage.withMeasurements.toLocaleString(getIntlLocale()) })
    ]
    : [
      t("官网 {{p0}}", { p0: coverage.withOfficialWebsite.toLocaleString(getIntlLocale()) }),
      t("结构化事实 {{p0}}", { p0: coverage.withStructuredFacts.toLocaleString(getIntlLocale()) }),
      `Wikipedia ${coverage.withWikipedia.toLocaleString(getIntlLocale())}`
    ];
  return [
    t("{{p0}} {{p1}}资料待处理", { p0: coverage.pending.toLocaleString(getIntlLocale()), p1: noun }),
    ...fields,
    t("简介 {{p0}}", { p0: coverage.withBiography.toLocaleString(getIntlLocale()) }),
    t("图片 {{p0}}", { p0: coverage.withImage.toLocaleString(getIntlLocale()) })
  ].join(" · ");
}

const TOPIC_DIMENSIONS: Array<{
  type: TopicType;
  label: string;
  icon: LucideIcon;
}> = [
  { type: "actor", get label() { return t("演员"); }, icon: UsersRound },
  { type: "series", get label() { return t("主题"); }, icon: Layers3 },
  { type: "genre", get label() { return t("标签"); }, icon: Tags },
  { type: "prefix", get label() { return t("番号"); }, icon: Hash },
  { type: "director", get label() { return t("导演"); }, icon: Clapperboard },
  { type: "maker", get label() { return t("厂商"); }, icon: Factory },
  { type: "label", get label() { return t("厂牌"); }, icon: Badge }
];

export function TopicExplorer({ onOpenEntity, onOpenGraph, onToggleFavorite }: TopicExplorerProps) {
  useLocale();
  const [type, setType] = useState<TopicType>("actor");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sort, setSort] = useState<"count" | "count-asc" | "name" | "latest" | "random">("count");
  const [gridWidth, setGridWidth] = useState(0);
  const gridRef = useRef<HTMLDivElement | null>(null);
  useVisibleReorderMotion(gridRef);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const gridObserverRef = useRef<ResizeObserver | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const overview = useQuery({
    queryKey: ["topic-overview"],
    queryFn: fetchTopicOverview,
    staleTime: 10 * 60 * 1000
  });
  const topics = useInfiniteQuery({
    queryKey: ["topic-items", type, debouncedSearch, sort],
    queryFn: ({ pageParam }) =>
      fetchTopicItems({ type, q: debouncedSearch, sort, page: pageParam, pageSize: PAGE_SIZE }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) =>
      lastPage.page < lastPage.totalPages ? lastPage.page + 1 : undefined,
    placeholderData: (previousData) => previousData,
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000
  });
  const items = useLocalizedMemo(
    () => topics.data?.pages.flatMap((page) => page.items) ?? [],
    [topics.data?.pages]
  );
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = topics;
  const total = topics.data?.pages[0]?.total ?? 0;
  const activeDimension = useLocalizedMemo(
    () => overview.data?.dimensions.find((dimension) => dimension.type === type),
    [overview.data?.dimensions, type]
  );

  const setGridElement = useCallback((grid: HTMLDivElement | null) => {
    gridObserverRef.current?.disconnect();
    gridObserverRef.current = null;
    gridRef.current = grid;
    if (!grid) return;

    const update = () => setGridWidth(grid.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(grid);
    gridObserverRef.current = observer;
  }, []);
  const gridMetrics = useLocalizedMemo(() => {
    const gap = gridWidth <= 520 ? 8 : 12;
    const minimumWidth = gridWidth <= 520
      ? 150
      : gridWidth >= 1760
        ? 250
        : gridWidth >= 1180
          ? 230
          : 190;
    const columns = Math.max(1, Math.floor((gridWidth + gap) / (minimumWidth + gap)));
    const cardWidth = gridWidth > 0 ? (gridWidth - gap * (columns - 1)) / columns : minimumWidth;
    const cardHeight = cardWidth * 9 / 16 + 80;
    return { gap, columns, cardHeight };
  }, [gridWidth]);
  const rowCount = Math.ceil(items.length / gridMetrics.columns);
  const rowVirtualizer = useWindowVirtualizer({
    count: rowCount,
    estimateSize: () => gridMetrics.cardHeight + gridMetrics.gap,
    overscan: 4,
    scrollMargin: gridRef.current?.offsetTop ?? 0
  });

  useLayoutEffect(() => {
    rowVirtualizer.measure();
  }, [gridMetrics.cardHeight, gridMetrics.columns, gridMetrics.gap, rowVirtualizer]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { rootMargin: "900px 0px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const tabs = TOPIC_DIMENSIONS.map((dimension) => {
    const Icon = dimension.icon;
    const count = overview.data?.dimensions.find((item) => item.type === dimension.type)?.entityCount;
    return {
      key: dimension.type,
      label: (
        <span className="topic-tab-label">
          <Icon size={15} />
          {t(dimension.label)}
          {typeof count === "number" && <Tag>{count.toLocaleString(getIntlLocale())}</Tag>}
        </span>
      )
    };
  });

  function renderTile(item: TopicListItem) {
    return <TopicEntityCard key={item.value} item={item} type={type} onOpenEntity={onOpenEntity} onToggleFavorite={onToggleFavorite} />;
  }

  return (
    <section aria-label={t("专题浏览")} className="topic-explorer">
      <div className="topic-heading">
        <div className="topic-heading-copy">
          <div className="topic-heading-title">
            <Text className="topic-heading-kicker" type="secondary">{t("专题")}</Text>
            <Title level={2}>{t(activeDimension?.label ?? TOPIC_DIMENSIONS.find((item) => item.type === type)?.label ?? "")}</Title>
            {PROFILE_TOPIC_TYPES.has(type) && activeDimension?.profileCoverage && (
              <Tag className="topic-profile-coverage" title={profileCoverageTitle(type, activeDimension.profileCoverage)}>
                {t("资料")} {activeDimension.profileCoverage.enriched.toLocaleString(getIntlLocale())} / {activeDimension.profileCoverage.total.toLocaleString(getIntlLocale())}
              </Tag>
            )}
          </div>
        </div>
        <div className="topic-stat-strip">
          <Button
            className="topic-graph-button"
            icon={<Network size={15} />}
            onClick={onOpenGraph}
            size="small"
          >
            {t("知识图谱")} </Button>
          <Statistic title={t("子维度")} value={activeDimension?.entityCount ?? 0} />
          <Statistic title={t("关联作品")} value={activeDimension?.mediaCount ?? 0} />
        </div>
      </div>

      <div aria-label={t("专题筛选")} className="topic-browse-controls">
        <Tabs
          activeKey={type}
          className="topic-dimension-tabs"
          items={tabs}
          more={{ icon: <span className="topic-tabs-more">{t("更多")}</span> }}
          onChange={(key) => {
            setType(key as TopicType);
            setSearch("");
            setDebouncedSearch("");
          }}
        />

        <div className="topic-toolbar">
          <Input
            allowClear
            aria-label={t("搜索{{p0}}", { p0: t(activeDimension?.label ?? "专题") })}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("搜索{{p0}}", { p0: t(activeDimension?.label ?? "专题") })}
            prefix={<Search size={15} />}
            value={search}
          />
          <Select
            aria-label={t("专题排序")}
            onChange={setSort}
            options={[
              { value: "count", label: t("作品最多") },
              { value: "count-asc", label: t("作品较少") },
              { value: "name", label: t("名称排序") },
              { value: "latest", label: t("最近发行") },
              { value: "random", label: t("随机探索") }
            ]}
            value={sort}
            virtual={false}
          />
        </div>
      </div>

      <div
        aria-busy={topics.isFetching && !topics.isFetchingNextPage}
        className={`topic-content-shell motion-tab-panel${topics.isPlaceholderData ? " is-refreshing" : ""}`}
        key={`${type}:${debouncedSearch}:${sort}`}
      >
        {topics.isLoading ? (
          <div className="topic-entity-grid" aria-label={t("专题加载中")}>
            {Array.from({ length: 12 }, (_, index) => (
              <div className="topic-entity-skeleton" key={index}>
                <Skeleton.Image active />
                <Skeleton active paragraph={{ rows: 1 }} title={{ width: "55%" }} />
              </div>
            ))}
          </div>
        ) : items.length ? (
          <>
            <div
              className="virtual-topic-grid"
              data-columns={gridMetrics.columns}
              data-loaded={items.length}
              data-total={total}
              ref={setGridElement}
              style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const start = virtualRow.index * gridMetrics.columns;
                return (
                  <div
                    className="virtual-topic-row"
                    key={virtualRow.key}
                    style={{
                      gap: `${gridMetrics.gap}px`,
                      gridTemplateColumns: `repeat(${gridMetrics.columns}, minmax(0, 1fr))`,
                      transform: `translateY(${virtualRow.start - rowVirtualizer.options.scrollMargin}px)`
                    }}
                  >
                    {items.slice(start, start + gridMetrics.columns).map(renderTile)}
                  </div>
                );
              })}
            </div>
            <div className="topic-load-sentinel" ref={sentinelRef}>
              {topics.isFetchingNextPage ? (
                <span><Spin size="small" /> {t("正在加载更多")}</span>
              ) : topics.hasNextPage ? (
                <Text type="secondary">{t("继续滚动加载更多")}</Text>
              ) : (
                <Text type="secondary">{t("已显示全部")} {total.toLocaleString(getIntlLocale())} {t("项")}</Text>
              )}
            </div>
          </>
        ) : (
          <Empty description={t("没有匹配的专题")} />
        )}
      </div>
    </section>
  );
}
