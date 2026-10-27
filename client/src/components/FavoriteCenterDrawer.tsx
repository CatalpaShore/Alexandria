import { getIntlLocale } from "../i18n/core";
import { t, useLocale } from "../i18n";
import { useQuery } from "@tanstack/react-query";
import { Button, Drawer, Empty, Skeleton, Tabs, Tag, Typography } from "antd";
import { useState } from "react";
import {
  Badge,
  Clapperboard,
  Download,
  Factory,
  Film,
  Heart,
  Hash,
  Layers3,
  Tags,
  UsersRound,
  type LucideIcon
} from "lucide-react";
import {
  getFavoritesExportUrl,
  fetchFavoriteTopics,
  type FavoriteEntity,
  type FavoritesResponse,
  type TopicType
} from "../lib/api";

import type { MetadataLanguage } from "../lib/metadataDisplay";
import { TopicEntityCard } from "./TopicEntityCard";
import { EntityMediaCard } from "./EntityMediaCard";

type FavoriteCenterDrawerProps = {
  metadataLanguage: MetadataLanguage;
  data?: FavoritesResponse;
  loading?: boolean;
  open: boolean;
  onClose: () => void;
  onOpenEntity: (entity: { type: TopicType; value: string; label?: string }) => void;
  onRemoveMedia: (relativePath: string) => void;
  onPlayMedia: (id: string) => void | Promise<void>;
  onOpenMedia: (id: string) => Promise<boolean>;
  onShowFavoriteMedia: () => void;
  onToggleEntityFavorite: (entity: { type: TopicType; value: string; label: string }, favorite: boolean) => void;
};

const { Text } = Typography;

const DIMENSIONS: Array<{ key: "media" | TopicType; label: string; icon: LucideIcon }> = [
  { key: "media", label: "视频", icon: Film },
  { key: "actor", label: "演员", icon: UsersRound },
  { key: "series", label: "主题", icon: Layers3 },
  { key: "genre", label: "标签", icon: Tags },
  { key: "prefix", label: "番号", icon: Hash },
  { key: "director", label: "导演", icon: Clapperboard },
  { key: "maker", label: "厂商", icon: Factory },
  { key: "label", label: "厂牌", icon: Badge }
];

function EntityList({
  type, active, items, onOpen, onRemove
}: {
  type: TopicType;
  active: boolean;
  items: FavoriteEntity[];
  onOpen: (item: FavoriteEntity) => void;
  onRemove: (item: FavoriteEntity) => void;
}) {
  useLocale();
  const result = useQuery({
    queryKey: ["favorites", "topics", type],
    queryFn: () => fetchFavoriteTopics(type),
    enabled: active && items.length > 0,
    staleTime: 60_000
  });
  if (!items.length) return <Empty description={t("这个维度还没有收藏")} image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  if (result.isPending) return <Skeleton active paragraph={{ rows: 4 }} />;
  const details = new Map(result.data?.items.map((item) => [item.value, item]));
  return (
    <>
      {result.isError && <Button size="small" onClick={() => void result.refetch()}>{t("封面与馆藏信息加载失败，重试")}</Button>}
      <div className="favorite-topic-grid">
        {items.map((favorite) => (
          <TopicEntityCard
            key={favorite.value}
            type={type}
            statsUnavailable={!details.has(favorite.value)}
            item={details.get(favorite.value) ?? { ...favorite, mediaId: null, mediaCount: 0, latestReleaseDate: null, isFavorite: true }}
            onOpenEntity={() => onOpen(favorite)}
            onToggleFavorite={() => onRemove(favorite)}
          />
        ))}
      </div>
    </>
  );
}

export function FavoriteCenterDrawer({
  data,
  metadataLanguage,
  loading,
  open,
  onClose,
  onOpenEntity,
  onRemoveMedia,
  onPlayMedia,
  onOpenMedia,
  onShowFavoriteMedia,
  onToggleEntityFavorite
}: FavoriteCenterDrawerProps) {
  useLocale();
  const [activeTab, setActiveTab] = useState("media");
  const [busyId, setBusyId] = useState<string | null>(null);
  const openMedia = async (id: string, play: boolean) => {
    if (busyId) return;
    setBusyId(id);
    try {
      if (play) await onPlayMedia(id);
      else await onOpenMedia(id);
    } finally {
      setBusyId(null);
    }
  };
  const counts = data?.counts;
  const tabItems = DIMENSIONS.map((dimension) => {
    const Icon = dimension.icon;
    const count = counts?.[dimension.key] ?? 0;
    const children = dimension.key === "media" ? (
      <div className="favorite-media-library motion-tab-panel">
        <div className="favorite-library-actions">
          <div>
            <Text strong>{count.toLocaleString(getIntlLocale())} {t("个视频收藏")}</Text>
            <Text type="secondary">{t("直接播放或查看详情，关闭后回到收藏列表")}</Text>
          </div>
          <Button onClick={onShowFavoriteMedia}>
            {t("在媒体墙浏览收藏")} </Button>
        </div>
        {data?.mediaItems.length ? (
          <div className="favorite-video-grid" role="list" aria-label={t("收藏视频")}>
            {data.mediaItems.map((item) => (
              <EntityMediaCard
                key={item.relativePath}
                item={item}
                title={(metadataLanguage === "zh" ? item.titleZh || item.title : item.title) || item.basename}
                busy={Boolean(busyId)}
                onOpen={() => void openMedia(item.id, false)}
                onPlay={() => void openMedia(item.id, true)}
                coverAction={
                  <button
                    className="entity-virtual-set-cover is-active"
                    aria-label={t("取消收藏{{p0}}", { p0: item.normalizedCode || item.basename })}
                    aria-pressed="true"
                    title={t("取消收藏")}
                    type="button"
                    onClick={() => onRemoveMedia(item.relativePath)}
                  ><Heart fill="currentColor" size={14} /></button>
                }
              />
            ))}
          </div>
        ) : (
          <Empty description={t("还没有收藏视频")} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </div>
    ) : (
      <div className="favorite-entity-panel motion-tab-panel">
        <EntityList
          type={dimension.key}
          active={activeTab === dimension.key}
          items={(data?.entities ?? []).filter((item) => item.type === dimension.key)}
          onOpen={(item) => onOpenEntity(item)}
          onRemove={(item) => onToggleEntityFavorite(item, false)}
        />
      </div>
    );

    return {
      key: dimension.key,
      label: (
        <span className="favorite-tab-label">
          <Icon size={14} />
          {dimension.label}
          <Tag>{count.toLocaleString(getIntlLocale())}</Tag>
        </span>
      ),
      children
    };
  });

  return (
    <Drawer
      className="favorite-center-drawer"
      extra={(
        <Button href={getFavoritesExportUrl()} icon={<Download size={15} />} size="small">
          {t("导出视频 TXT")} </Button>
      )}
      loading={loading}
      onClose={onClose}
      open={open}
      size={860}
      title={t("我的收藏 · {{p0}}", { p0: (data?.totalCount ?? 0).toLocaleString(getIntlLocale()) })}
    >
      <Tabs activeKey={activeTab} onChange={setActiveTab} animated={{ inkBar: true, tabPane: false }} className="favorite-dimension-tabs" items={tabItems} tabPlacement="top" />
    </Drawer>
  );
}
