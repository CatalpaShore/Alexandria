import { getIntlLocale } from "../i18n/core";
import { t, useLocale, useLocalizedMemo } from "../i18n";
import { Button, Descriptions, Divider, Drawer, Dropdown, Image, message, Progress, Select, Space, Tabs, Tag, Tooltip, Typography, type MenuProps } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Bot, Captions, ChevronDown, EyeOff, Heart, MoreHorizontal, Play, RefreshCw, RotateCcw, Shuffle, UserRound } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  fetchRecommendations,
  fetchActorCards,
  fetchMediaDetail,
  formatBytes,
  formatDate,
  formatDuration,
  getPosterUrl,
  parseVariantTags,
  requestSubtitleTranslation,
  setRecommendationFeedback,
  type MediaItem,
  type MediaQuery,
  type RecommendationMode,
  type RecommendationSort,
  type TopicType
} from "../lib/api";
import { getDisplayMetadata, getMediaDisplayTitle, type MetadataLanguage } from "../lib/metadataDisplay";
import { fetchContentPreview, requestContentPreview } from "../lib/contentPreviewApi";
import { AddToPlaylistPopover } from "./AddToPlaylistPopover";
import { PosterImage } from "./PosterImage";
import "../product-p1.css";
import "../media-detail-operations.css";

type MediaDetailDrawerProps = {
  item: MediaItem | null;
  hasNext?: boolean;
  hasPrevious?: boolean;
  metadataLanguage: MetadataLanguage;
  navigationDirection?: -1 | 1 | null;
  open: boolean;
  onApplyFilter: (patch: Partial<MediaQuery>) => void;
  onClose: () => void;
  onNavigate?: (direction: -1 | 1) => void;
  onOpenRelated?: (item: MediaItem, queue: MediaItem[]) => void;
  onOpenEntity?: (entity: { type: TopicType; value: string; label?: string }) => void;
  onPlay: (item: MediaItem, options?: { startSeconds?: number | null }) => void;
  onRefreshMetadata: (item: MediaItem) => void;
  onAskAgent?: (item: MediaItem) => void;
  onToggleFavorite?: (item: MediaItem, favorite: boolean) => void;
};

const { Paragraph, Text, Title } = Typography;

type MetadataInsightFields = {
  completeness?: number | null;
  confidence?: number | null;
  durationConflict?: boolean;
  durationDeltaMinutes?: number | null;
  fetchedAt?: string | null;
  qualityScore?: number | null;
  source?: string | null;
  updatedAt?: string | null;
};

type DetailMetadata = NonNullable<MediaItem["metadata"]> & MetadataInsightFields;

function formatMetadataSummary(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .trim();
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || Boolean(target.closest(
    "input, textarea, select, [contenteditable='true'], [role='textbox'], [role='combobox']"
  ));
}

function hasVisibleDetailKeyboardLayer(): boolean {
  const layers = document.querySelectorAll<HTMLElement>(
    ".ant-image-preview-wrap, .ant-modal-wrap, .ant-select-dropdown, .ant-dropdown, .ant-popover"
  );
  return [...layers].some((layer) => {
    const style = window.getComputedStyle(layer);
    const bounds = layer.getBoundingClientRect();
    return style.display !== "none"
      && style.visibility !== "hidden"
      && bounds.width > 0
      && bounds.height > 0;
  });
}

function getProgressPercent(item: MediaItem): number {
  const duration = item.playback?.durationSeconds ?? item.durationSeconds;
  const position = item.playback?.positionSeconds ?? 0;

  if (!duration || duration <= 0) return 0;
  return Math.min(100, Math.round((position / duration) * 100));
}

function normalizeComparableTitle(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function formatMetadataTimestamp(value: string | null | undefined): string {
  if (!value) return "";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(getIntlLocale(), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(timestamp);
}

function formatMetadataProvider(value: string): string {
  const knownProviders: Record<string, string> = {
    metatube: "MetaTube",
    r18dev: "R18.dev",
    r18: "R18"
  };
  return knownProviders[value.trim().toLocaleLowerCase()] ?? value;
}

function calculateMetadataCompleteness(metadata: DetailMetadata): number {
  if (typeof metadata.completeness === "number") {
    return Math.round(Math.min(100, Math.max(0, metadata.completeness <= 1 ? metadata.completeness * 100 : metadata.completeness)));
  }
  const checks = [
    Boolean(metadata.title),
    metadata.actors.length > 0,
    metadata.genres.length > 0,
    Boolean(metadata.releaseDate),
    Boolean(metadata.runtimeMinutes),
    Boolean(metadata.maker),
    Boolean(metadata.director),
    Boolean(metadata.coverUrl || metadata.thumbUrl)
  ];
  return Math.round(checks.filter(Boolean).length / checks.length * 100);
}

function calculateTranslationCompleteness(metadata: DetailMetadata): number | null {
  const fields = [
    [metadata.title, metadata.titleZh],
    [metadata.summary, metadata.summaryZh],
    [metadata.director, metadata.directorZh],
    [metadata.maker, metadata.makerZh],
    [metadata.label, metadata.labelZh],
    [metadata.series, metadata.seriesZh]
  ].filter(([source]) => Boolean(source?.trim()));
  if (metadata.actors.length > 0) fields.push([metadata.actors.join("|"), metadata.actorsZh.join("|")]);
  if (metadata.genres.length > 0) fields.push([metadata.genres.join("|"), metadata.genresZh.join("|")]);
  if (fields.length === 0) return null;
  return Math.round(fields.filter(([, translated]) => Boolean(translated?.trim())).length / fields.length * 100);
}

const subtitleStageLabels = {
  queued: "等待处理",
  source: "检查字幕源",
  extracting: "提取音频",
  transcribing: "识别语音",
  translating: "翻译字幕",
  writing: "生成字幕文件",
  ready: "汉化完成",
  failed: "汉化失败",
  cancelled: "已取消"
} as const;

const compatibilityLabels: Record<NonNullable<MediaItem["compatibilityStatus"]>, string> = {
  get unknown() { return t("待探测"); },
  get native() { return t("原生播放"); },
  get remux() { return t("快速封装"); },
  get transcode() { return t("需要转码"); },
  get unsupported() { return t("暂不支持"); }
};

function formatTranslationTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.round(seconds));
  if (safeSeconds < 60) return t("{{p0}} 秒", { p0: safeSeconds });
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainingSeconds = safeSeconds % 60;
  if (hours > 0) return t("{{p0}} 小时 {{p1}} 分", { p0: hours, p1: minutes });
  return remainingSeconds > 0 ? t("{{p0}} 分 {{p1}} 秒", { p0: minutes, p1: remainingSeconds }) : t("{{p0}} 分", { p0: minutes });
}

export function MediaDetailDrawer({
  item,
  hasNext = false,
  hasPrevious = false,
  metadataLanguage,
  navigationDirection = null,
  open,
  onApplyFilter,
  onClose,
  onNavigate,
  onOpenRelated,
  onOpenEntity,
  onPlay,
  onRefreshMetadata,
  onAskAgent,
  onToggleFavorite
}: MediaDetailDrawerProps) {
  useLocale();
  const queryClient = useQueryClient();
  const detailShellRef = useRef<HTMLDivElement | null>(null);
  const recommendationScrollRef = useRef<number | null>(null);
  const requestedContentPreviewIdsRef = useRef(new Set<string>());
  const previewClickTimerRef = useRef<number | null>(null);
  const [detailTab, setDetailTab] = useState("overview");
  const [previewCurrent, setPreviewCurrent] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [recommendationMode, setRecommendationMode] = useState<RecommendationMode>("mixed");
  const [recommendationSort, setRecommendationSort] = useState<RecommendationSort>("relevance");
  const [randomSeed, setRandomSeed] = useState(() => Date.now());
  const scrollDetailToTop = useCallback(() => {
    const scrollRoot = detailShellRef.current?.closest<HTMLElement>(".ant-drawer-body");
    if (scrollRoot) scrollRoot.scrollTop = 0;
  }, []);
  const detail = useQuery({
    queryKey: ["media-detail", item?.id],
    queryFn: () => fetchMediaDetail(item?.id ?? ""),
    enabled: open && Boolean(item?.id),
    staleTime: 5 * 60 * 1000,
    refetchInterval: (queryState) => {
      const status = queryState.state.data?.translation?.status;
      return status === "pending" || status === "running" ? 2_000 : false;
    }
  });
  const activeItem = detail.data?.item ?? item;
  const contentPreview = useQuery({
    queryKey: ["content-preview", activeItem?.id],
    queryFn: () => fetchContentPreview(activeItem?.id ?? ""),
    enabled: open && Boolean(activeItem?.id && activeItem.mediaType === "video"),
    refetchInterval: (queryState) => queryState.state.data?.status === "pending" ? 4_000 : false,
    staleTime: 60_000
  });
  const generateContentPreview = useMutation({
    mutationFn: () => requestContentPreview(activeItem?.id ?? ""),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["content-preview", activeItem?.id] });
    },
    onError: (error) => {
      if (contentPreview.data?.storageAvailable) {
        message.error(error instanceof Error ? error.message : t("内容预览生成失败"));
      }
    }
  });
  const metadata = activeItem?.metadata?.status === "ready" ? activeItem.metadata as DetailMetadata : null;
  const displayMetadata = metadata ? getDisplayMetadata(metadata, metadataLanguage) : null;
  const chineseMetadata = metadata ? getDisplayMetadata(metadata, "zh") : null;
  const primaryTitle = chineseMetadata?.title || activeItem?.basename || "";
  const originalTitle = metadata?.title.trim() ?? "";
  const showOriginalTitle = Boolean(originalTitle) && normalizeComparableTitle(originalTitle) !== normalizeComparableTitle(primaryTitle);
  const metadataSource = metadata ? (metadata.provider || metadata.source || "") : "";
  const metadataUpdatedAt = metadata
    ? formatMetadataTimestamp(metadata.updatedAt || metadata.fetchedAt || metadata.translatedAt)
    : "";
  const metadataCompleteness = metadata ? calculateMetadataCompleteness(metadata) : null;
  const translationCompleteness = metadata ? calculateTranslationCompleteness(metadata) : null;
  const sourceTranslationStatus = item?.metadata?.translationStatus;
  const translationStatus = metadata?.translationStatus || sourceTranslationStatus || "pending";
  const subtitleTranslation = detail.data?.translation ?? null;
  const translateSubtitle = useMutation({
    mutationFn: () => requestSubtitleTranslation(activeItem?.id ?? ""),
    onSuccess: async () => {
      message.success(t("已加入汉化翻译队列"));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["media-detail", activeItem?.id] }),
        queryClient.invalidateQueries({ queryKey: ["subtitle-translations"] })
      ]);
    },
    onError: (error) => message.error(error instanceof Error ? error.message : t("加入汉化翻译队列失败"))
  });
  const measuredFileMinutes = activeItem?.probeStatus === "ready" && activeItem.durationSeconds
    ? Math.round(activeItem.durationSeconds / 60)
    : null;
  const calculatedDurationDelta = measuredFileMinutes && metadata?.runtimeMinutes
    ? Math.abs(measuredFileMinutes - metadata.runtimeMinutes)
    : null;
  const durationDeltaMinutes = metadata?.durationDeltaMinutes ?? calculatedDurationDelta;
  const hasRuntimeConflict = Boolean(metadata?.durationConflict) || Boolean(durationDeltaMinutes && durationDeltaMinutes >= 30);
  const progressPercent = activeItem ? getProgressPercent(activeItem) : 0;
  const variantTags = activeItem ? parseVariantTags(activeItem.variantTags) : [];
  const actorEntries = useLocalizedMemo(() => {
    if (!metadata || !displayMetadata) return [];
    return displayMetadata.actors.slice(0, 6).map((label, index) => ({
      label,
      value: metadata.actors[index] ?? label
    }));
  }, [displayMetadata, metadata]);
  const actorProfiles = useQuery({
    queryKey: ["detail-actor-cards-v1", actorEntries.map((actor) => actor.value)],
    queryFn: () => fetchActorCards(actorEntries.map((actor) => actor.value)),
    enabled: open && actorEntries.length > 0,
    retry: false,
    staleTime: 10 * 60 * 1000
  });
  const actorProfilesByValue = useLocalizedMemo(() => new Map(
    (actorProfiles.data?.items ?? []).map((item) => [item.requestedValue, item])
  ), [actorProfiles.data]);
  const previewAssets = useLocalizedMemo(() => {
    if (contentPreview.data?.status !== "ready") return [];
    return [...contentPreview.data.gifs, ...contentPreview.data.photos];
  }, [contentPreview.data]);
  const cancelPreviewClick = useCallback(() => {
    if (previewClickTimerRef.current == null) return;
    window.clearTimeout(previewClickTimerRef.current);
    previewClickTimerRef.current = null;
  }, []);
  const schedulePreviewOpen = useCallback((current: number) => {
    cancelPreviewClick();
    previewClickTimerRef.current = window.setTimeout(() => {
      setPreviewCurrent(current);
      setPreviewOpen(true);
      previewClickTimerRef.current = null;
    }, 260);
  }, [cancelPreviewClick]);
  const playFromPreview = useCallback((timeSeconds: number) => {
    cancelPreviewClick();
    setPreviewOpen(false);
    if (activeItem) onPlay(activeItem, { startSeconds: timeSeconds });
  }, [activeItem, cancelPreviewClick, onPlay]);

  useEffect(() => () => cancelPreviewClick(), [cancelPreviewClick]);

  useEffect(() => {
    const mediaId = activeItem?.id;
    const preview = contentPreview.data;
    if (!mediaId || !preview?.storageAvailable || !["missing", "stale"].includes(preview.status)) return;
    if (requestedContentPreviewIdsRef.current.has(mediaId)) return;
    requestedContentPreviewIdsRef.current.add(mediaId);
    generateContentPreview.mutate();
  }, [activeItem?.id, contentPreview.data, generateContentPreview]);
  const recommendations = useQuery({
    queryKey: ["media-recommendations-v4", activeItem?.id, recommendationMode, recommendationSort, randomSeed],
    queryFn: () => fetchRecommendations(activeItem?.id ?? "", {
      limit: 24,
      mode: recommendationMode,
      sort: recommendationSort,
      randomSeed: recommendationSort === "random" ? randomSeed : undefined
    }),
    enabled: open && Boolean(activeItem?.id),
    placeholderData: (previousData) => previousData,
    staleTime: 10 * 60 * 1000
  });
  const hideRecommendation = useMutation({
    mutationFn: (mediaId: string) => setRecommendationFeedback(activeItem?.id ?? "", mediaId),
    onSuccess: async (_result, mediaId) => {
      queryClient.setQueriesData<{ items: MediaItem[] }>(
        { queryKey: ["media-recommendations-v4", activeItem?.id] },
        (current) => current ? { ...current, items: current.items.filter((entry) => entry.id !== mediaId) } : current
      );
      message.success(t("已减少此类推荐"));
      await queryClient.invalidateQueries({ queryKey: ["media-recommendations-v4", activeItem?.id] });
    },
    onError: (error) => message.error(error instanceof Error ? error.message : t("更新推荐偏好失败"))
  });
  const relatedItems = useLocalizedMemo(() => {
    const seen = new Set<string>();

    return (recommendations.data?.items ?? []).filter((related) => {
      const logicalKey = related.normalizedCode || related.id;
      if (seen.has(logicalKey)) return false;
      seen.add(logicalKey);
      return true;
    }).slice(0, 12);
  }, [recommendations.data?.items]);

  const preserveRecommendationScroll = useCallback((update: () => void) => {
    const scrollRoot = detailShellRef.current?.closest<HTMLElement>(".ant-drawer-body");
    if (recommendationScrollRef.current == null) {
      recommendationScrollRef.current = scrollRoot?.scrollTop ?? null;
    }
    update();
  }, []);

  const rememberRecommendationScroll = useCallback(() => {
    const scrollRoot = detailShellRef.current?.closest<HTMLElement>(".ant-drawer-body");
    recommendationScrollRef.current = scrollRoot?.scrollTop ?? null;
  }, []);

  const restoreRecommendationScroll = useCallback(() => {
    const savedScrollTop = recommendationScrollRef.current;
    const scrollRoot = detailShellRef.current?.closest<HTMLElement>(".ant-drawer-body");
    if (savedScrollTop == null || !scrollRoot) return;
    scrollRoot.scrollTop = Math.min(
      savedScrollTop,
      Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight)
    );
  }, []);

  useLayoutEffect(() => {
    const savedScrollTop = recommendationScrollRef.current;
    const scrollRoot = detailShellRef.current?.closest<HTMLElement>(".ant-drawer-body");
    if (savedScrollTop == null || !scrollRoot) return;

    const restoreScroll = restoreRecommendationScroll;
    restoreScroll();
    const animationFrame = window.requestAnimationFrame(restoreScroll);
    const focusTimer = window.setTimeout(restoreScroll, 0);
    const settleTimer = window.setTimeout(() => {
      restoreScroll();
    }, 180);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.clearTimeout(focusTimer);
      window.clearTimeout(settleTimer);
    };
  }, [randomSeed, recommendationMode, recommendationSort, recommendations.data, recommendations.isFetching, restoreRecommendationScroll]);

  useLayoutEffect(() => {
    if (open && item?.id) {
      setDetailTab("overview");
      cancelPreviewClick();
      setPreviewCurrent(0);
      setPreviewOpen(false);
      scrollDetailToTop();
    }
  }, [cancelPreviewClick, item?.id, open, scrollDetailToTop]);

  useEffect(() => {
    if (!open || !activeItem || !onNavigate) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (isEditableKeyboardTarget(event.target) || hasVisibleDetailKeyboardLayer()) return;

      const direction = event.key === "ArrowLeft" ? -1 : 1;
      if ((direction < 0 && !hasPrevious) || (direction > 0 && !hasNext)) return;
      event.preventDefault();
      onNavigate(direction);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeItem, hasNext, hasPrevious, onNavigate, open]);

  const handleOpenRelated = useCallback((related: MediaItem) => {
    scrollDetailToTop();
    onOpenRelated?.(related, relatedItems);
  }, [onOpenRelated, relatedItems, scrollDetailToTop]);

  const playbackPosition = activeItem?.playback?.positionSeconds ?? 0;
  const playbackDuration = activeItem?.playback?.durationSeconds ?? activeItem?.durationSeconds ?? 0;
  const canResume = playbackPosition > 15
    && !activeItem?.playback?.completed
    && (!playbackDuration || playbackPosition < playbackDuration - 30);
  const primaryPlayLabel = canResume
    ? t("继续播放 {{p0}}", { p0: formatDuration(playbackPosition) })
    : activeItem?.playback?.completed ? t("再次播放") : t("播放");
  const playPrimary = () => {
    if (!activeItem) return;
    onPlay(activeItem, activeItem.playback?.completed ? { startSeconds: 0 } : undefined);
  };
  const managementMenu: MenuProps = {
    items: [
      ...(canResume ? [{ key: "restart", icon: <RotateCcw size={15} />, label: t("从头播放") }] : []),
      { key: "agent", icon: <Bot size={15} />, label: t("问智能馆长"), disabled: !onAskAgent },
      { key: "refresh", icon: <RefreshCw size={15} />, label: t("重抓元数据") },
      {
        key: "subtitle",
        icon: <Captions size={15} />,
        label: subtitleTranslation?.status === "ready"
          ? t("字幕汉化已完成")
          : subtitleTranslation?.status === "pending" || subtitleTranslation?.status === "running"
            ? t("字幕汉化处理中")
            : t("汉化翻译"),
        disabled: subtitleTranslation?.status === "pending" || subtitleTranslation?.status === "running" || subtitleTranslation?.status === "ready"
      }
    ],
    onClick: ({ key }) => {
      if (!activeItem) return;
      if (key === "restart") onPlay(activeItem, { startSeconds: 0 });
      if (key === "agent") onAskAgent?.(activeItem);
      if (key === "refresh") onRefreshMetadata(activeItem);
      if (key === "subtitle") translateSubtitle.mutate();
    }
  };

  return (
    <Drawer
      className="media-detail-drawer"
      onClose={onClose}
      open={open}
      placement="right"
      title={activeItem ? activeItem.normalizedCode || activeItem.basename : t("媒体详情")}
      extra={(
        <Space className="detail-navigation-controls" size={6}>
          <Text className="detail-navigation-hint" type="secondary">{t("← / → 切换")}</Text>
          <Tooltip title={t("上一部（←）")}>
            <Button
              aria-label={t("上一部影片")}
              disabled={!hasPrevious || navigationDirection !== null}
              icon={<ArrowLeft size={16} />}
              loading={navigationDirection === -1}
              onClick={() => onNavigate?.(-1)}
              shape="circle"
              size="small"
            />
          </Tooltip>
          <Tooltip title={t("下一部（→）")}>
            <Button
              aria-label={t("下一部影片")}
              disabled={!hasNext || navigationDirection !== null}
              icon={<ArrowRight size={16} />}
              loading={navigationDirection === 1}
              onClick={() => onNavigate?.(1)}
              shape="circle"
              size="small"
            />
          </Tooltip>
        </Space>
      )}
      size={620}
      zIndex={1250}
    >
      {activeItem && (
        <div
          className={`detail-shell${navigationDirection === -1 ? " is-navigating-previous" : navigationDirection === 1 ? " is-navigating-next" : ""}`}
          key={activeItem.id}
          ref={detailShellRef}
        >
          <div className="detail-hero">
            <img src={getPosterUrl(activeItem.id, "detail")} alt="" />
            <div className="detail-hero-copy">
              <div className="detail-title-block">
                <span className="detail-code-label">{activeItem.normalizedCode || activeItem.basename}</span>
                <Title level={3}>{primaryTitle || getMediaDisplayTitle(activeItem, "zh")}</Title>
              </div>
              {showOriginalTitle && (
                <details className="detail-original-title">
                  <summary>{t("查看原始标题")}</summary>
                  <Text>{originalTitle}</Text>
                </details>
              )}
              <Text className="detail-file-path" ellipsis={{ tooltip: activeItem.relativePath }} type="secondary">{activeItem.relativePath}</Text>
              <Space className="detail-actions" wrap>
                <Button icon={<Play size={16} fill="currentColor" />} onClick={playPrimary} type="primary">
                  {primaryPlayLabel}
                </Button>
                {canResume && (
                  <Button icon={<RotateCcw size={15} />} onClick={() => onPlay(activeItem, { startSeconds: 0 })}>
                    {t("从头播放")} </Button>
                )}
                <Button
                  aria-pressed={activeItem.isFavorite}
                  className={activeItem.isFavorite ? "is-favorite-action" : ""}
                  icon={<Heart size={16} fill={activeItem.isFavorite ? "currentColor" : "none"} />}
                  onClick={() => onToggleFavorite?.(activeItem, !activeItem.isFavorite)}
                >
                  {activeItem.isFavorite ? t("已收藏") : t("收藏")}
                </Button>
                <AddToPlaylistPopover item={activeItem} />
                <Dropdown menu={managementMenu} placement="bottomRight" trigger={["click"]}>
                  <Button icon={<MoreHorizontal size={16} />} loading={translateSubtitle.isPending}>
                    {t("更多管理")} <ChevronDown size={13} />
                  </Button>
                </Dropdown>
              </Space>
            </div>
          </div>

          <Tabs
            activeKey={detailTab}
            className="detail-tabs"
            items={[
              { key: "overview", label: t("概览") },
              { key: "files", label: t("文件与管理") },
              { key: "related", label: t("相关推荐") }
            ]}
            onChange={setDetailTab}
          />

          {detailTab === "overview" && contentPreview.data?.storageAvailable && (
            <section className="detail-section detail-content-preview">
              <div className="detail-section-title">
                <div className="detail-content-preview-title">
                  <Text strong>{t("内容预览")}</Text>
                  {contentPreview.data.status === "ready" && (
                    <Text type="secondary">{t("3 段动图 · 9 张剧照")}</Text>
                  )}
                </div>
                <Space size={6}>
                  {contentPreview.data.fallbackShort && <Tag>{t("短片采样")}</Tag>}
                  {contentPreview.data.status === "ready" && <Tag>{formatBytes(contentPreview.data.totalBytes)}</Tag>}
                </Space>
              </div>

              {contentPreview.data.status === "ready" ? (
                <Image.PreviewGroup
                  items={previewAssets.map((asset) => ({ alt: t("内容预览 {{p0}}", { p0: formatDuration(asset.timeSeconds) }), src: asset.url }))}
                  preview={{
                    current: previewCurrent,
                    onChange: (current) => setPreviewCurrent(current),
                    onOpenChange: (nextOpen) => setPreviewOpen(nextOpen),
                    open: previewOpen
                  }}
                >
                  <div className="detail-content-preview-group">
                    <Text className="detail-content-preview-hint" type="secondary">{t("单击查看大图 · 双击从当前位置播放")}</Text>
                    <Text className="detail-content-preview-label" type="secondary">{t("动态片段")}</Text>
                    <div className="detail-content-preview-grid is-motion">
                      {contentPreview.data.gifs.map((asset, index) => (
                        <figure className="detail-content-preview-card" key={asset.key}>
                          <button
                            aria-label={t("查看动态片段 {{p0}}，双击从此处播放", { p0: formatDuration(asset.timeSeconds) })}
                            className="detail-preview-image-trigger"
                            onClick={(event) => {
                              if (event.detail > 1) {
                                playFromPreview(asset.timeSeconds);
                                return;
                              }
                              schedulePreviewOpen(index);
                            }}
                            title={t("单击查看大图，双击从此处播放")}
                            type="button"
                          >
                            <Image alt={t("动态片段 {{p0}}", { p0: formatDuration(asset.timeSeconds) })} loading="lazy" preview={false} src={asset.url} />
                          </button>
                          <figcaption>
                            <span>GIF</span>
                            <time>{formatDuration(asset.timeSeconds)}</time>
                          </figcaption>
                        </figure>
                      ))}
                    </div>
                    <Text className="detail-content-preview-label" type="secondary">{t("剧照")}</Text>
                    <div className="detail-content-preview-grid">
                      {contentPreview.data.photos.map((asset, index) => {
                        const previewIndex = contentPreview.data.gifs.length + index;
                        return (
                        <figure className="detail-content-preview-card" key={asset.key}>
                          <button
                            aria-label={t("查看剧照 {{p0}}，双击从此处播放", { p0: formatDuration(asset.timeSeconds) })}
                            className="detail-preview-image-trigger"
                            onClick={(event) => {
                              if (event.detail > 1) {
                                playFromPreview(asset.timeSeconds);
                                return;
                              }
                              schedulePreviewOpen(previewIndex);
                            }}
                            title={t("单击查看大图，双击从此处播放")}
                            type="button"
                          >
                            <Image alt={t("剧照 {{p0}}", { p0: formatDuration(asset.timeSeconds) })} loading="lazy" preview={false} src={asset.url} />
                          </button>
                          <figcaption>
                            <span>{t("剧照")}</span>
                            <time>{formatDuration(asset.timeSeconds)}</time>
                          </figcaption>
                        </figure>
                        );
                      })}
                    </div>
                  </div>
                </Image.PreviewGroup>
              ) : contentPreview.data.status === "failed" ? (
                <div className="detail-content-preview-state is-error">
                  <Text type="danger">{contentPreview.data.error || t("内容预览生成失败")}</Text>
                  <Button
                    loading={generateContentPreview.isPending}
                    onClick={() => {
                      if (!activeItem?.id) return;
                      requestedContentPreviewIdsRef.current.delete(activeItem.id);
                      generateContentPreview.mutate();
                    }}
                    size="small"
                  >
                    {t("重新生成")} </Button>
                </div>
              ) : (
                <div className="detail-content-preview-state" role="status">
                  <span className="spin" />
                  <Text type="secondary">
                    {contentPreview.data.status === "pending" ? t("正在后台生成 3 段动图与 9 张剧照") : t("正在准备内容预览")}
                  </Text>
                </div>
              )}
            </section>
          )}

          {detailTab === "files" && subtitleTranslation && (
            <div className={`detail-translation-state is-${subtitleTranslation.status}`}>
              <div className="detail-translation-heading">
                <div>
                  <Captions size={18} />
                  <strong>{subtitleStageLabels[subtitleTranslation.stage]}</strong>
                </div>
                <Tag color={subtitleTranslation.status === "ready" ? "success" : subtitleTranslation.status === "failed" ? "error" : "processing"}>
                  {subtitleTranslation.progress}%
                </Tag>
              </div>
              <Progress
                percent={subtitleTranslation.progress}
                railColor="#303030"
                showInfo={false}
                status={subtitleTranslation.status === "failed" ? "exception" : subtitleTranslation.status === "ready" ? "success" : "active"}
                strokeColor="#ff9900"
              />
              <div aria-label={t("翻译处理流程")} className="translation-pipeline is-detail">
                {subtitleTranslation.pipelineSteps.map((step) => (
                  <div className={`translation-pipeline-step is-${step.status}`} key={step.key}>
                    <span aria-hidden="true" className="translation-pipeline-dot" />
                    <span>{step.label}</span>
                  </div>
                ))}
              </div>
              <Text type={subtitleTranslation.error ? "danger" : "secondary"}>
                {subtitleTranslation.error
                  || (subtitleTranslation.status === "ready"
                    ? t("已生成 {{p0}} 条中文字幕，用时 {{p1}}，播放器会默认优先加载。", { p0: subtitleTranslation.cueCount, p1: formatTranslationTime(subtitleTranslation.elapsedSeconds) })
                    : subtitleTranslation.status === "running"
                      ? t("本阶段 {{p0}}% · 已耗时 {{p1}} · {{p2}}", { p0: Math.round(subtitleTranslation.stageProgress), p1: formatTranslationTime(subtitleTranslation.elapsedSeconds), p2: subtitleTranslation.estimatedRemainingSeconds === null
                          ? "正在计算剩余时间"
                          : `预计剩余 ${formatTranslationTime(subtitleTranslation.estimatedRemainingSeconds)}` })
                      : t("等待前序任务或播放结束，开始后会动态计算剩余时间。"))}
              </Text>
            </div>
          )}

          {detailTab === "overview" && <div className="detail-progress">
            <div>
              <Text strong>{t("播放记录")}</Text>
              <Text type="secondary">
                {activeItem.playback
                  ? t("上次 {{p0}} / {{p1}}", { p0: formatDuration(activeItem.playback.positionSeconds), p1: formatDuration(
                      activeItem.playback.durationSeconds ?? activeItem.durationSeconds
                    ) })
                  : t("还没有观看记录")}
              </Text>
            </div>
            <Progress percent={progressPercent} railColor="#303030" showInfo={false} strokeColor="#ff9900" />
          </div>}

          {detailTab === "files" && (
            <section className="detail-file-console">
              <div className="detail-file-console-heading">
                <div>
                  <Text strong>{t("当前文件")}</Text>
                  <Text type="secondary">{t("文件状态与常用管理操作")}</Text>
                </div>
                <Tag color={activeItem.compatibilityStatus === "native" ? "success" : activeItem.compatibilityStatus === "unsupported" ? "error" : "warning"}>
                  {compatibilityLabels[activeItem.compatibilityStatus ?? "unknown"]}
                </Tag>
              </div>

              <Descriptions className="detail-description detail-file-facts" column={2} size="small">
                <Descriptions.Item label={t("分类")}>{activeItem.libraryCategory}</Descriptions.Item>
                <Descriptions.Item label={t("来源")}>{activeItem.sourceName}</Descriptions.Item>
                <Descriptions.Item label={t("格式")}>{activeItem.extension.toUpperCase()}</Descriptions.Item>
                <Descriptions.Item label={t("容量")}>{formatBytes(activeItem.size)}</Descriptions.Item>
                <Descriptions.Item label={t("文件时长")}>{formatDuration(activeItem.durationSeconds)}</Descriptions.Item>
                <Descriptions.Item label={t("修改时间")}>{formatDate(activeItem.mtimeMs)}</Descriptions.Item>
                <Descriptions.Item label={t("视频编码")}>{activeItem.videoCodec || t("待探测")}</Descriptions.Item>
                <Descriptions.Item label={t("播放兼容")}>{compatibilityLabels[activeItem.compatibilityStatus ?? "unknown"]}</Descriptions.Item>
              </Descriptions>

              <div className="detail-file-location">
                <Text type="secondary">{t("存储位置")}</Text>
                <Text ellipsis={{ tooltip: activeItem.relativePath }}>{activeItem.relativePath}</Text>
              </div>

              <div className="detail-file-actions">
                <div>
                  <Text strong>{t("管理操作")}</Text>
                  <Text type="secondary">{t("不会修改或移动源视频文件")}</Text>
                </div>
                <Space size={8} wrap>
                  <Button icon={<RefreshCw size={15} />} onClick={() => onRefreshMetadata(activeItem)}>
                    {t("重抓元数据")} </Button>
                  <Button
                    disabled={subtitleTranslation?.status === "pending" || subtitleTranslation?.status === "running" || subtitleTranslation?.status === "ready"}
                    icon={<Captions size={15} />}
                    loading={translateSubtitle.isPending}
                    onClick={() => translateSubtitle.mutate()}
                  >
                    {subtitleTranslation?.status === "ready"
                      ? t("字幕汉化已完成")
                      : subtitleTranslation?.status === "pending" || subtitleTranslation?.status === "running"
                        ? t("字幕汉化处理中")
                        : t("汉化翻译")}
                  </Button>
                </Space>
              </div>
            </section>
          )}

          {detailTab === "files" && <Divider />}

          {detailTab === "overview" && <section className="detail-section detail-overview-profile">
            <div className="detail-section-title">
              <Text strong>{t("影片资料")}</Text>
              <Space className="detail-meta-health" size={6} wrap>
                {metadataCompleteness != null && <Tag color={metadataCompleteness >= 75 ? "success" : "warning"}>{t("完整度")} {metadataCompleteness}%</Tag>}
                {translationCompleteness != null && <Tag color={translationCompleteness >= 75 ? "blue" : "default"}>{t("翻译")} {translationCompleteness}%</Tag>}
                <Tag>{activeItem.metadata?.status === "ready" ? t("已就绪") : activeItem.metadata?.status ?? t("待处理")}</Tag>
              </Space>
            </div>
            {metadata ? (
              <>
                {hasRuntimeConflict && (
                  <div className="detail-runtime-warning" role="status">
                    <strong>{t("时长信息存在差异")}</strong>
                    <span>{t("文件实测约")} {measuredFileMinutes ?? "-"} {t("分钟，元数据记录")} {metadata.runtimeMinutes ?? "-"} {t("分钟")}{durationDeltaMinutes ? t("，相差约 {{p0}} 分钟", { p0: Math.round(durationDeltaMinutes) }) : ""}。</span>
                  </div>
                )}
                <Descriptions className="detail-description" column={2} size="small">
                  {metadataSource && <Descriptions.Item label={t("数据源")}>{formatMetadataProvider(metadataSource)}</Descriptions.Item>}
                  {metadataUpdatedAt && <Descriptions.Item label={t("更新时间")}>{metadataUpdatedAt}</Descriptions.Item>}
                  <Descriptions.Item label={t("翻译状态")}>{translationStatus === "ready" ? t("已完成") : translationStatus === "skipped" ? t("无需翻译") : t("待完善")}</Descriptions.Item>
                  <Descriptions.Item label={t("元数据完整度")}>{metadataCompleteness}%</Descriptions.Item>
                  <Descriptions.Item label={t("发行日期")}>{metadata.releaseDate || "-"}</Descriptions.Item>
                  <Descriptions.Item label={t("片长")}>
                    {metadata.runtimeMinutes ? t("{{p0}} 分钟", { p0: metadata.runtimeMinutes }) : "-"}
                  </Descriptions.Item>
                  <Descriptions.Item label={t("导演")}>
                    {displayMetadata?.director ? (
                      <Button
                        onClick={() => onOpenEntity?.({
                          type: "director",
                          value: metadata.director ?? displayMetadata.director,
                          label: displayMetadata.director
                        })}
                        size="small"
                        type="link"
                      >
                        {displayMetadata.director}
                      </Button>
                    ) : "-"}
                  </Descriptions.Item>
                  <Descriptions.Item label={t("厂商")}>
                    {displayMetadata?.maker ? (
                      <Button
                        onClick={() => onOpenEntity?.({
                          type: "maker",
                          value: metadata.maker ?? displayMetadata.maker,
                          label: displayMetadata.maker
                        })}
                        size="small"
                        type="link"
                      >
                        {displayMetadata.maker}
                      </Button>
                    ) : "-"}
                  </Descriptions.Item>
                  <Descriptions.Item label={t("厂牌")}>
                    {displayMetadata?.label ? (
                      <Button
                        onClick={() => onOpenEntity?.({
                          type: "label",
                          value: metadata.label ?? displayMetadata.label,
                          label: displayMetadata.label
                        })}
                        size="small"
                        type="link"
                      >
                        {displayMetadata.label}
                      </Button>
                    ) : "-"}
                  </Descriptions.Item>
                  <Descriptions.Item label={t("系列")}>
                    {displayMetadata?.series ? (
                      <Button
                        onClick={() => onOpenEntity?.({
                          type: "series",
                          value: metadata.series ?? displayMetadata.series,
                          label: displayMetadata.series
                        })}
                        size="small"
                        type="link"
                      >
                        {displayMetadata.series}
                      </Button>
                    ) : "-"}
                  </Descriptions.Item>
                </Descriptions>

                {displayMetadata && displayMetadata.actors.length > 0 && (
                  <div className="detail-chip-block">
                    <Text type="secondary">{t("演员资料")}</Text>
                    <div className="detail-actor-grid">
                      {actorEntries.map((actor) => {
                        const actorData = actorProfilesByValue.get(actor.value);
                        const actorProfile = actorData?.profile;
                        const actorImage = actorProfile?.imageUrl
                          || (actorData?.entity.customCoverMediaId ? getPosterUrl(actorData.entity.customCoverMediaId, "detail") : "");
                        const alternateNames = [...new Set([
                          actorProfile?.originalName,
                          ...(actorProfile?.aliases ?? []),
                          ...(actorData?.entity.aliases ?? [])
                        ].filter((value): value is string => Boolean(value?.trim()) && value !== actor.label))].slice(0, 2);
                        return (
                          <button
                            className="detail-actor-card"
                            key={`${actor.value}:${actor.label}`}
                            onClick={() => onOpenEntity?.({ type: "actor", value: actor.value, label: actor.label })}
                            type="button"
                          >
                            {actorImage ? (
                              <img alt="" loading="lazy" src={actorImage} />
                            ) : (
                              <span aria-hidden="true" className="detail-actor-placeholder"><UserRound size={20} /></span>
                            )}
                            <span className="detail-actor-copy">
                              <strong>{actorProfile?.displayName || actorData?.entity.label || actor.label}</strong>
                              <small>{alternateNames.join(" · ") || t("{{p0}} 部馆藏", { p0: actorData?.entity.mediaCount ?? "-" })}</small>
                            </span>
                            <span className="detail-actor-count">{actorData ? t("{{p0}} 部", { p0: actorData.entity.mediaCount }) : t("查看")}</span>
                          </button>
                        );
                      })}
                    </div>
                    {displayMetadata.actors.length > actorEntries.length && (
                      <Text type="secondary">{t("另有")} {displayMetadata.actors.length - actorEntries.length} {t("位演员")}</Text>
                    )}
                  </div>
                )}

                {displayMetadata && displayMetadata.genres.length > 0 && (
                  <div className="detail-chip-block">
                    <Text type="secondary">{t("标签")}</Text>
                    <Space size={[6, 6]} wrap>
                      {displayMetadata.genres.map((genre, index) => (
                        <button
                          className="detail-filter-tag clickable-tag"
                          key={`${metadata.genres[index] ?? genre}:${genre}`}
                          onClick={() => onOpenEntity?.({
                            type: "genre",
                            value: metadata.genres[index] ?? genre,
                            label: genre
                          })}
                          type="button"
                        >
                          {genre}
                        </button>
                      ))}
                    </Space>
                  </div>
                )}

                {displayMetadata?.summary && (
                  <Paragraph className="detail-summary">
                    {formatMetadataSummary(displayMetadata.summary)}
                  </Paragraph>
                )}
                {metadata.homepage && (
                  <a className="detail-homepage" href={metadata.homepage} rel="noreferrer" target="_blank">
                    {t("查看资料来源")} </a>
                )}
              </>
            ) : (
              <Text type="secondary">{activeItem.metadata?.status === "not_found" ? t("未匹配到元数据") : t("元数据待补全")}</Text>
            )}
          </section>}

          {detailTab === "files" && (variantTags.length > 0 || activeItem.codePrefix) && (
            <section className="detail-section">
              <div className="detail-section-title">
                <Text strong>{t("文件标签")}</Text>
              </div>
              <Space size={[6, 6]} wrap>
                {activeItem.codePrefix && (
                  <button
                    className="detail-filter-tag clickable-tag"
                    onClick={() => onApplyFilter({ prefix: activeItem.codePrefix })}
                    type="button"
                  >
                    {activeItem.codePrefix}
                  </button>
                )}
                {variantTags.map((tag) => (
                  <Tag key={tag}>{tag}</Tag>
                ))}
              </Space>
            </section>
          )}

          {detailTab === "files" && (detail.data?.versions.length ?? 0) > 1 && (
            <section className="detail-section">
              <div className="detail-section-title">
                <Text strong>{t("文件版本")}</Text>
                <Tag color="orange">{detail.data?.versions.length} {t("个版本")}</Tag>
              </div>
              <div className="detail-version-list">
                {detail.data?.versions.map((version) => (
                  <button
                    className={`detail-version-row${version.id === activeItem.id ? " is-active" : ""}`}
                    key={version.id}
                    onClick={() => handleOpenRelated(version)}
                    type="button"
                  >
                    <strong>{version.name}</strong>
                    <span>{version.sourceName}</span>
                    <Tag>{version.compatibilityStatus || "unknown"}</Tag>
                    <Tag>{formatBytes(version.size)}</Tag>
                  </button>
                ))}
              </div>
            </section>
          )}

          {detailTab === "files" && (detail.data?.sidecars.length ?? 0) > 0 && (
            <section className="detail-section">
              <div className="detail-section-title">
                <Text strong>{t("字幕与侧车文件")}</Text>
                <Tag>{detail.data?.sidecars.length}</Tag>
              </div>
              <div className="detail-sidecar-list">
                {detail.data?.sidecars.map((sidecar) => (
                  <div className="detail-sidecar-row" key={sidecar.id}>
                    <div>
                      <strong>{sidecar.label || sidecar.relativePath}</strong>
                      <span>{sidecar.language || sidecar.format.toUpperCase()}</span>
                    </div>
                    <Space size={6}>
                      <Tag>{sidecar.kind}</Tag>
                      <a href={sidecar.rawUrl ?? `/api/sidecars/${sidecar.id}/raw`} target="_blank" rel="noreferrer">{t("打开")}</a>
                    </Space>
                  </div>
                ))}
              </div>
            </section>
          )}

          {detailTab === "related" && <section className="detail-section">
            <div className="detail-section-title">
              <Text strong>{t("相关推荐")}</Text>
              <div
                className="detail-recommendation-controls"
                onMouseDownCapture={rememberRecommendationScroll}
                onPointerDownCapture={rememberRecommendationScroll}
              >
              <Space size={6}>
                {recommendations.isFetching && <Tag color="processing">{t("匹配中")}</Tag>}
                <Select<RecommendationMode>
                  aria-label={t("推荐维度")}
                  onChange={(value) => preserveRecommendationScroll(() => setRecommendationMode(value))}
                  options={[
                    { label: t("综合"), value: "mixed" },
                    { label: t("同演员"), value: "actor" },
                    { label: t("同系列"), value: "series" },
                    { label: t("相似标签"), value: "genre" }
                  ]}
                  size="small"
                  value={recommendationMode}
                />
                <Select<RecommendationSort>
                  aria-label={t("关联视频排序")}
                  onChange={(value) => {
                    preserveRecommendationScroll(() => {
                      setRecommendationSort(value);
                      if (value === "random") setRandomSeed(Date.now());
                    });
                  }}
                  onOpenChange={(open) => {
                    if (open) return;
                    window.setTimeout(restoreRecommendationScroll, 0);
                    window.setTimeout(restoreRecommendationScroll, 240);
                  }}
                  options={[
                    { label: t("智能推荐"), value: "relevance" },
                    { label: t("最近发行"), value: "recent" },
                    { label: t("番号排序"), value: "name" },
                    { label: t("随机展示"), value: "random" }
                  ]}
                  size="small"
                  value={recommendationSort}
                />
                {recommendationSort === "random" && (
                  <Button
                    aria-label={t("重新随机排序")}
                    icon={<Shuffle size={14} />}
                    onClick={() => preserveRecommendationScroll(() => setRandomSeed(Date.now()))}
                    size="small"
                    title={t("换一批顺序")}
                  />
                )}
              </Space>
              </div>
            </div>
            <div className="detail-related-grid">
              {relatedItems.map((related) => (
                <article className="detail-related-card detail-related-card-explained" key={related.id}>
                  <button
                    className="detail-related-open"
                    onClick={() => handleOpenRelated(related)}
                    type="button"
                  >
                    <div className="detail-related-poster">
                      <PosterImage src={getPosterUrl(related.id)} alt="" loading="lazy" />
                    </div>
                    <span>{related.normalizedCode || related.basename}</span>
                    {related.recommendationReason && <small>{related.recommendationReason}</small>}
                  </button>
                  <Tooltip title={t("直接播放")}>
                    <Button
                      aria-label={t("播放 {{p0}}", { p0: related.normalizedCode || related.basename })}
                      className="detail-related-play"
                      icon={<Play fill="currentColor" size={14} />}
                      onClick={() => onPlay(related)}
                      shape="circle"
                      size="small"
                      type="primary"
                    />
                  </Tooltip>
                  <Tooltip title={t("不感兴趣")}>
                    <Button
                      aria-label={t("不再推荐 {{p0}}", { p0: related.normalizedCode || related.basename })}
                      className="detail-related-dismiss"
                      icon={<EyeOff size={14} />}
                      loading={hideRecommendation.isPending && hideRecommendation.variables === related.id}
                      onClick={() => hideRecommendation.mutate(related.id)}
                      size="small"
                      type="text"
                    />
                  </Tooltip>
                </article>
              ))}
            </div>
            {!recommendations.isFetching && relatedItems.length === 0 && (
              <Text type="secondary">{t("暂时没有找到相似视频")}</Text>
            )}
          </section>}

          <div className="detail-mobile-action-bar">
            <Button icon={<Play fill="currentColor" size={16} />} onClick={playPrimary} type="primary">
              {canResume ? t("继续播放") : activeItem.playback?.completed ? t("再次播放") : t("播放")}
            </Button>
            <Button
              aria-label={activeItem.isFavorite ? t("取消收藏") : t("收藏")}
              aria-pressed={activeItem.isFavorite}
              className={activeItem.isFavorite ? "is-favorite-action" : ""}
              icon={<Heart fill={activeItem.isFavorite ? "currentColor" : "none"} size={16} />}
              onClick={() => onToggleFavorite?.(activeItem, !activeItem.isFavorite)}
            >
              {activeItem.isFavorite ? t("已收藏") : t("收藏")}
            </Button>
            <Dropdown menu={managementMenu} placement="topRight" trigger={["click"]}>
              <Button icon={<MoreHorizontal size={16} />}>{t("更多")}</Button>
            </Dropdown>
          </div>
        </div>
      )}
    </Drawer>
  );
}
