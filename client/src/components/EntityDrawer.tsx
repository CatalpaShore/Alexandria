import { getIntlLocale } from "../i18n/core";
import { t, useLocale, useLocalizedMemo } from "../i18n";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Drawer, Empty, message, Select, Skeleton, Space, Spin, Statistic, Switch, Tooltip, Typography } from "antd";
import { Heart, Shuffle } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { fetchEntity, getPosterUrl, setTopicCover, type MediaItem, type TopicRelatedItem, type TopicType } from "../lib/api";
import type { MetadataLanguage } from "../lib/metadataDisplay";
import { useInfiniteScroll } from "../lib/useInfiniteScroll";
import "../entity-virtual-grid.css";
import { EntityMediaVirtualGrid } from "./EntityMediaVirtualGrid";
import { EntityInsightsPanel } from "./EntityInsightsPanel";
import { EntityProfilePanel } from "./EntityProfilePanel";

type EntityDrawerProps = {
  entity: { type: TopicType; value: string; label?: string } | null;
  metadataLanguage: MetadataLanguage;
  onClose: () => void;
  onOpenEntity: (entity: { type: TopicType; value: string; label?: string }) => void;
  onOpenMedia: (item: MediaItem, queue: MediaItem[]) => void;
  onPlay: (item: MediaItem, queue: MediaItem[]) => void;
  onToggleFavorite: (entity: { type: TopicType; value: string; label: string }, favorite: boolean) => void;
};

const { Paragraph, Text, Title } = Typography;
const PAGE_SIZE = 36;
type EntityMediaSort = "release" | "added" | "name" | "duration" | "size" | "random";
const RELATED_ORDER: TopicType[] = ["actor", "series", "genre", "prefix", "director", "maker", "label"];
const RELATED_LABELS: Record<TopicType, string> = {
  actor: "演员",
  series: "主题",
  genre: "标签",
  prefix: "番号",
  director: "导演",
  maker: "厂商",
  label: "厂牌"
};

type EntityRelatedGroupProps = {
  entityKey: string;
  items: TopicRelatedItem[];
  onOpenEntity: EntityDrawerProps["onOpenEntity"];
  onToggleFavorite: EntityDrawerProps["onToggleFavorite"];
  type: TopicType;
};

function EntityRelatedGroup({
  entityKey,
  items,
  onOpenEntity,
  onToggleFavorite,
  type
}: EntityRelatedGroupProps) {
  useLocale();
  const listRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);

  useLayoutEffect(() => {
    setExpanded(false);
  }, [entityKey]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || expanded) return;

    const measureOverflow = () => {
      setCanExpand(list.scrollHeight > list.clientHeight + 1);
    };
    measureOverflow();

    const observer = new ResizeObserver(measureOverflow);
    observer.observe(list);
    return () => observer.disconnect();
  }, [expanded, items]);

  return (
    <div className="entity-related-group motion-list-item">
      <Text type="secondary">{RELATED_LABELS[type]}</Text>
      <div
        className={`entity-related-list${expanded ? " is-expanded motion-expand-region" : ""}`}
        ref={listRef}
      >
        {items.map((item) => (
          <span className="entity-related-chip" key={`${type}:${item.value}`}>
            <button
              onClick={() => onOpenEntity({ type, value: item.value, label: item.label })}
              type="button"
            >
              {item.label} · {item.mediaCount}
            </button>
            <Button
              aria-pressed={item.isFavorite}
              aria-label={item.isFavorite ? t("取消收藏{{p0}}", { p0: item.label }) : `收藏${item.label}`}
              className={item.isFavorite ? "is-active" : ""}
              icon={<Heart fill={item.isFavorite ? "currentColor" : "none"} size={12} />}
              onClick={() => onToggleFavorite({ type, value: item.value, label: item.label }, !item.isFavorite)}
              size="small"
              type="text"
            />
          </span>
        ))}
      </div>
      {canExpand && (
        <Button
          className="entity-related-expand"
          onClick={() => setExpanded((current) => !current)}
          size="small"
          type="link"
        >
          {expanded ? t("收起") : t("展开")}
        </Button>
      )}
    </div>
  );
}

export function EntityDrawer({
  entity,
  metadataLanguage,
  onClose,
  onOpenEntity,
  onOpenMedia,
  onPlay,
  onToggleFavorite
}: EntityDrawerProps) {
  useLocale();
  const [mediaSort, setMediaSort] = useState<EntityMediaSort>("release");
  const [soloOnly, setSoloOnly] = useState(false);
  const [randomSeed, setRandomSeed] = useState(() => Date.now());
  const queryClient = useQueryClient();
  const refreshRandomOrder = () => {
    setRandomSeed((current) => Math.max(Date.now(), current + 1));
  };
  const result = useInfiniteQuery({
    queryKey: ["entity", entity?.type, entity?.value, mediaSort, randomSeed, entity?.type === "actor" && soloOnly],
    queryFn: ({ pageParam }) =>
      fetchEntity(entity?.type ?? "actor", entity?.value ?? "", {
        page: pageParam,
        pageSize: PAGE_SIZE,
        sort: mediaSort,
        soloOnly: entity?.type === "actor" && soloOnly,
        randomSeed: mediaSort === "random" ? randomSeed : undefined
      }),
    enabled: Boolean(entity?.value),
    initialPageParam: 1,
    getNextPageParam: (lastPage) =>
      lastPage.page < lastPage.totalPages ? lastPage.page + 1 : undefined,
    staleTime: 10 * 60 * 1000
  });
  const data = result.data?.pages[0];
  const headingLabel = data?.profile?.displayName || data?.entity.label || entity?.label || "";
  const alternateLabels = data
    ? [...new Set([data.entity.label, entity?.label, data.entity.value, ...data.entity.aliases]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value) && value !== headingLabel))].slice(0, 6)
    : [];
  const coverMutation = useMutation({
    mutationFn: (mediaId: string) => setTopicCover(entity?.type ?? "actor", entity?.value ?? "", mediaId),
    onSuccess: async () => {
      message.success("专题封面已更新");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["entity", entity?.type, entity?.value] }),
        queryClient.invalidateQueries({ queryKey: ["topic-items", entity?.type] }),
        queryClient.invalidateQueries({ queryKey: ["favorites", "topics", entity?.type] }),
        queryClient.invalidateQueries({ queryKey: ["topic-overview"] })
      ]);
    },
    onError: (error) => message.error(error instanceof Error ? error.message : "专题封面设置失败")
  });
  const items = useLocalizedMemo(() => {
    const seen = new Set<string>();
    return (result.data?.pages ?? []).flatMap((page) => page.items).filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }, [result.data?.pages]);
  const sentinelRef = useInfiniteScroll({
    enabled: Boolean(entity?.value),
    hasNextPage: Boolean(result.hasNextPage),
    isFetchingNextPage: result.isFetchingNextPage,
    onLoadMore: result.fetchNextPage
  });
  return (
    <Drawer
      className="entity-drawer"
      onClose={onClose}
      open={Boolean(entity)}
      title={data ? `${data.entity.typeLabel}详情` : "专题详情"}
      size={860}
    >
      {result.isLoading ? (
        <Skeleton active />
      ) : data ? (
        <div
          aria-busy={result.isFetching && !result.isFetchingNextPage}
          className={`entity-shell motion-tab-panel${result.isPlaceholderData ? " is-refreshing" : ""}`}
          key={`${entity?.type}:${entity?.value}`}
        >
          <div className="entity-heading">
            <div className="entity-heading-identity">
              {data.entity.customCoverMediaId ? (
                <img
                  alt={`${data.entity.label}专题封面`}
                  className="entity-manual-cover"
                  src={getPosterUrl(data.entity.customCoverMediaId, "detail")}
                />
              ) : null}
              <div>
                <Text type="secondary">{data.entity.typeLabel}</Text>
                <div className="entity-title-row">
                  <Title level={2}>{headingLabel}</Title>
                  <Button
                    aria-pressed={data.entity.isFavorite}
                    className={data.entity.isFavorite ? "is-favorite-action" : ""}
                    icon={<Heart fill={data.entity.isFavorite ? "currentColor" : "none"} size={15} />}
                    onClick={() => onToggleFavorite({
                      type: data.entity.type,
                      value: data.entity.value,
                      label: data.entity.label
                    }, !data.entity.isFavorite)}
                    size="small"
                  >
                    {data.entity.isFavorite ? t("已收藏") : t("收藏")}
                  </Button>
                </div>
                {alternateLabels.length > 0 && (
                  <Text type="secondary">馆藏名称：{alternateLabels.join(" · ")}</Text>
                )}
              </div>
            </div>
            <Space>
              <Statistic title="聚合作品" value={data.entity.mediaCount} />
              <Statistic title={t("最近发行")} value={data.entity.latestReleaseDate ?? "-"} />
            </Space>
          </div>

          <Paragraph className="entity-description">{data.entity.description}</Paragraph>

          <EntityInsightsPanel insights={data.entity.insights} />

          {data.profile && <EntityProfilePanel profile={data.profile} />}

          <div className="entity-related-groups">
            {RELATED_ORDER.filter((type) => type !== data.entity.type && data.entity.related[type].length > 0).map((type) => (
              <EntityRelatedGroup
                entityKey={`${data.entity.type}:${data.entity.value}`}
                items={data.entity.related[type]}
                key={`${data.entity.value}:${type}`}
                onOpenEntity={onOpenEntity}
                onToggleFavorite={onToggleFavorite}
                type={type}
              />
            ))}
          </div>

          <div className="entity-media-heading">
            <Text strong>关联视频</Text>
            <div className="entity-media-tools">
              {entity?.type === "actor" && <Tooltip title="按元数据的单体作品标签筛选；关闭可查看全部关联作品。">
                <label className="entity-solo-filter"><Switch size="small" checked={soloOnly} onChange={setSoloOnly} aria-label="仅单体作品"/><span>仅单体作品</span></label>
              </Tooltip>}
              {result.isFetching && !result.isFetchingNextPage && <Spin size="small" />}
              <Text type="secondary">
                {t("已加载")} {items.length.toLocaleString(getIntlLocale())} / {data.total.toLocaleString(getIntlLocale())}
              </Text>
              <Select<EntityMediaSort>
                aria-label={t("关联视频排序")}
                onChange={(value) => {
                  setMediaSort(value);
                  if (value === "random") refreshRandomOrder();
                }}
                options={[
                  { label: "发行时间", value: "release" },
                  { label: "最近入库", value: "added" },
                  { label: "番号 A-Z", value: "name" },
                  { label: "时长最长", value: "duration" },
                  { label: t("文件最大"), value: "size" },
                  { label: t("随机展示"), value: "random" }
                ]}
                size="small"
                value={mediaSort}
              />
              {mediaSort === "random" && (
                <Button
                  aria-label="重新随机关联视频"
                  icon={<Shuffle size={14} />}
                  onClick={refreshRandomOrder}
                  size="small"
                  title="换一个随机顺序"
                />
              )}
            </div>
          </div>
          <EntityMediaVirtualGrid
            items={items}
            metadataLanguage={metadataLanguage}
            onOpenMedia={onOpenMedia}
            onPlay={onPlay}
            onSetCover={(item) => coverMutation.mutate(item.id)}
            coverMediaId={data.entity.customCoverMediaId}
            settingCoverMediaId={coverMutation.isPending ? coverMutation.variables ?? null : null}
          />
          {!items.length && entity?.type === "actor" && soloOnly && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无带单体作品标签的馆藏"><Button onClick={()=>setSoloOnly(false)}>查看全部关联作品</Button></Empty>}
          <div className="drawer-load-sentinel" ref={sentinelRef}>
            {result.isFetchingNextPage ? (
              <span><Spin size="small" /> {t("正在加载更多视频")}</span>
            ) : result.hasNextPage ? (
              <Text type="secondary">{t("继续滚动加载更多")}</Text>
            ) : items.length > 0 ? (
              <Text type="secondary">已显示全部关联视频</Text>
            ) : null}
          </div>
        </div>
      ) : (
        <Empty description="没有找到关联作品" />
      )}
    </Drawer>
  );
}
