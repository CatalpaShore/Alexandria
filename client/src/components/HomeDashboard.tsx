import { useDemoStatus } from "./DemoNotice";
import { getIntlLocale } from "../i18n/core";
import { t, useLocale, useLocalizedMemo } from "../i18n";
import { HighlightsDrawer } from "./Highlights";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Drawer, Empty, message, Modal, Progress, Skeleton, Spin, Typography } from "antd";
import {
  BarChart3,
  Bell,
  Bookmark,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Download,
  Heart,
  History,
  ListVideo,
  MoreHorizontal,
  PackageCheck,
  Play,
  Scissors,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
  type LucideIcon
} from "lucide-react";
import { useCallback, useRef, useState } from "react";
import {
  deletePlaybackProgress,
  fetchFavorites,
  fetchRecommendations,
  getPosterUrl,
  getThumbnailUrl,
  updatePlaybackProgress,
  type MediaItem,
  type TopicType
} from "../lib/api";
import { PosterImage } from "./PosterImage";
import {
  fetchHomeSection,
  fetchHomeSectionPage,
  fetchRecentIngestionPage,
  homeQueryKeys,
  type HomeSectionKey
} from "../lib/homeApi";
import { useInfiniteScroll } from "../lib/useInfiniteScroll";
import { getDisplayMetadata } from "../lib/metadataDisplay";
import { AnimatedMetric } from "./AnimatedMetric";
import { fetchPersonalDashboard, getPersonalDataExportUrl, importPersonalData } from "../lib/personalApi";
import { fetchPlaylists } from "../lib/playlistApi";
import "../home-dashboard.css";
import "../product-p1.css";

type HomeDashboardProps = {
  onOpen: (item: MediaItem, queue: MediaItem[]) => void;
  onPlay: (item: MediaItem, queue: MediaItem[]) => void;
  onOpenEntity: (entity: { type: TopicType; value: string; label?: string }) => void;
  onOpenFavorites: () => void;
  onOpenPlaylists: (playlistId?: string) => void;
  onOpenLibraryAnalytics: () => void;
};

type SectionDefinition = {
  key: HomeSectionKey | "recommended" | "recent-ingestion";
  title: string;
  emptyText: string;
  icon: LucideIcon;
  allowDelete?: boolean;
};

type TimelineFilter = "all" | "watch" | "ingestion" | "favorite";
type JournalStatAction = "history" | "continue" | "completed" | "watch-timeline" | "favorites" | "playlists";

type TimelineEvent = {
  key: string;
  kind: "watch" | "completed" | "ingestion" | "favorite";
  occurredAt: string;
  media?: MediaItem;
  update?: {
    type: TopicType;
    value: string;
    label: string;
    newCount: number;
  };
};

const RECENT_INGESTION_PAGE_SIZE = 48;
const JOURNAL_PAGE_SIZE = 24;

const topicLabels: Record<TopicType, string> = {
  actor: "演员", series: "系列", genre: "标签", prefix: "番号", director: "导演", maker: "厂商", label: "厂牌"
};

function getTitle(item: MediaItem): string {
  return item.metadata?.status === "ready" ? getDisplayMetadata(item.metadata, "zh").title || item.basename : item.basename;
}

function getActors(item: MediaItem): string {
  return item.metadata?.status === "ready" ? getDisplayMetadata(item.metadata, "zh").actors.slice(0, 2).join(" / ") : "";
}

function getPlaybackPercent(item: MediaItem): number {
  const duration = item.playback?.durationSeconds ?? item.durationSeconds;
  if (!item.playback || !duration || duration <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round(item.playback.positionSeconds / duration * 100)));
}

function formatHours(seconds: number): string {
  if (seconds < 3600) return t("{{p0}} 分钟", { p0: Math.max(0, Math.round(seconds / 60)) });
  return t("{{p0}} 小时", { p0: (seconds / 3600).toFixed(seconds >= 36_000 ? 0 : 1) });
}

function formatCompactDuration(seconds?: number | null): string {
  if (!seconds || seconds <= 0) return "";
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return t("{{p0}} 分钟", { p0: minutes });
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? t("{{p0}} 小时 {{p1}} 分", { p0: hours, p1: remainder }) : t("{{p0}} 小时", { p0: hours });
}

function getTimelineFacts(item: MediaItem): string[] {
  const metadata = item.metadata?.status === "ready" ? getDisplayMetadata(item.metadata, "zh") : null;
  const runtime = formatCompactDuration(item.playback?.durationSeconds ?? item.durationSeconds);
  return [
    metadata?.actors.slice(0, 2).join(" / ") || "",
    ...(metadata?.genres.filter((genre) => genre !== "样片").slice(0, 2) ?? []),
    runtime ? t("片长 {{p0}}", { p0: runtime }) : ""
  ].filter(Boolean).slice(0, 4);
}

function getLocalDayKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatIngestionDay(dayKey: string): string {
  const [year, month, day] = dayKey.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const prefix = dayKey === getLocalDayKey(today)
    ? t("今天")
    : dayKey === getLocalDayKey(yesterday) ? t("昨天") : "";
  const formatted = new Intl.DateTimeFormat(getIntlLocale(), {
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
    month: "long",
    day: "numeric",
    weekday: "short"
  }).format(date);
  return prefix ? `${prefix} · ${formatted}` : formatted;
}

function formatTimelineGroup(dateText: string): string {
  const date = new Date(dateText);
  const dayKey = getLocalDayKey(date);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (dayKey === getLocalDayKey(today)) return t("今天");
  if (dayKey === getLocalDayKey(yesterday)) return t("昨天");
  return new Intl.DateTimeFormat(getIntlLocale(), { month: "long", day: "numeric", weekday: "short" }).format(date);
}

function formatTimelineTime(dateText: string): string {
  const date = new Date(dateText);
  if (Number.isNaN(date.getTime())) return t("刚刚");
  return new Intl.DateTimeFormat(getIntlLocale(), { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function HomeMediaCard({ item, showProgress, onOpen, onPlay, onDeleteProgress, onToggleCompleted }: {
  item: MediaItem;
  showProgress: boolean;
  onOpen: (item: MediaItem) => void;
  onPlay: (item: MediaItem) => void;
  onDeleteProgress?: (item: MediaItem) => void;
  onToggleCompleted?: (item: MediaItem) => void;
}) {
  useLocale();
  const actorLine = getActors(item);
  const progress = showProgress ? getPlaybackPercent(item) : 0;
  return (
    <article className="home-media-card">
      <div className="home-media-cover">
        <button aria-label={t("查看 {{p0}}", { p0: item.normalizedCode || item.basename })} className="home-media-cover-open" onClick={() => onOpen(item)} type="button">
          <PosterImage alt="" loading="lazy" onError={(event) => {
            const fallback = getThumbnailUrl(item.id);
            if (!event.currentTarget.src.endsWith(fallback)) event.currentTarget.src = fallback;
          }} src={getPosterUrl(item.id)} />
        </button>
        {onDeleteProgress && (
          <button aria-label={t("删除 {{p0}} 的观看记录", { p0: item.normalizedCode || item.basename })} className="home-media-delete" onClick={() => onDeleteProgress(item)} title={t("删除观看记录")} type="button">
            <Trash2 size={14} />
          </button>
        )}
        {onToggleCompleted && (
          <button
            aria-label={item.playback?.completed ? t("恢复 {{p0}} 为未看完", { p0: item.normalizedCode || item.basename }) : t("标记 {{p0}} 为已看完", { p0: item.normalizedCode || item.basename })}
            className={`home-media-complete${item.playback?.completed ? " is-completed" : ""}`}
            onClick={() => onToggleCompleted(item)}
            title={item.playback?.completed ? t("恢复为未看完") : t("标记为已看完")}
            type="button"
          >
            <CheckCircle2 size={14} />
          </button>
        )}
        {showProgress && progress > 0 && <Progress className="home-media-progress" percent={progress} showInfo={false} size="small" strokeColor="#ff9900" railColor="rgba(255,255,255,.2)" />}
        <button aria-label={t("播放 {{p0}}", { p0: item.normalizedCode || item.basename })} className="home-media-play" onClick={() => onPlay(item)} title={t("播放")} type="button"><Play fill="currentColor" size={15} /></button>
      </div>
      <button aria-label={t("查看 {{p0}}", { p0: item.normalizedCode || item.basename })} className="home-media-copy" onClick={() => onOpen(item)} type="button">
        <span className="home-media-topline">
          <span className="home-media-code" title={item.normalizedCode || item.basename}>{item.normalizedCode || item.basename}</span>
          {actorLine && <span className="home-media-actors" title={actorLine}>{actorLine}</span>}
        </span>
        <span className="home-media-title" title={getTitle(item)}>{getTitle(item)}</span>
      </button>
    </article>
  );
}

function RecentIngestionDrawer({ open, onClose, onOpen, onPlay }: {
  open: boolean;
  onClose: () => void;
  onOpen: (item: MediaItem, queue: MediaItem[]) => void;
  onPlay: (item: MediaItem, queue: MediaItem[]) => void;
}) {
  useLocale();
  const recent = useInfiniteQuery({
    queryKey: ["home-dashboard", "recent-ingestion", "all"],
    queryFn: ({ pageParam }) => fetchRecentIngestionPage(pageParam, RECENT_INGESTION_PAGE_SIZE),
    enabled: open,
    initialPageParam: 1,
    getNextPageParam: (lastPage) =>
      lastPage.page < lastPage.totalPages ? lastPage.page + 1 : undefined,
    refetchOnMount: "always",
    staleTime: 5_000
  });
  const items = useLocalizedMemo(() => {
    const seen = new Set<string>();
    return (recent.data?.pages ?? []).flatMap((page) => page.items).filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }, [recent.data?.pages]);
  const groups = useLocalizedMemo(() => {
    const grouped = new Map<string, MediaItem[]>();
    for (const item of items) {
      const dayKey = item.ingestionDay || getLocalDayKey(new Date(item.ingestedAt || item.indexedAt));
      const group = grouped.get(dayKey) ?? [];
      group.push(item);
      grouped.set(dayKey, group);
    }
    return Array.from(grouped, ([dayKey, dayItems]) => ({ dayKey, items: dayItems }));
  }, [items]);
  const sentinelRef = useInfiniteScroll({
    enabled: open,
    hasNextPage: Boolean(recent.hasNextPage),
    isFetchingNextPage: recent.isFetchingNextPage,
    onLoadMore: recent.fetchNextPage
  });
  const total = recent.data?.pages[0]?.total ?? 0;

  return (
    <Drawer
      className="recent-ingestion-drawer"
      extra={<span className="recent-ingestion-loaded">{t("已加载")} {items.length.toLocaleString(getIntlLocale())} / {total.toLocaleString(getIntlLocale())}</span>}
      onClose={onClose}
      open={open}
      size={1080}
      title={t("全部最近入库")}
    >
      {recent.isLoading ? (
        <div className="recent-ingestion-loading"><Spin /></div>
      ) : groups.length === 0 ? (
        <Empty description={t("还没有入库记录")} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <div className="recent-ingestion-days">
          {groups.map((group) => (
            <section className="recent-ingestion-day" key={group.dayKey}>
              <header>
                <div><CalendarDays size={17} /><strong>{formatIngestionDay(group.dayKey)}</strong></div>
                <span>{(group.items[0]?.ingestionDayCount ?? group.items.length).toLocaleString(getIntlLocale())} {t("部")}</span>
              </header>
              <div className="home-drawer-grid recent-ingestion-grid" role="list">
                {group.items.map((item) => (
                  <div key={item.id} role="listitem">
                    <HomeMediaCard
                      item={item}
                      onOpen={(next) => onOpen(next, items)}
                      onPlay={(next) => onPlay(next, items)}
                      showProgress={false}
                    />
                  </div>
                ))}
              </div>
            </section>
          ))}
          <div className="recent-ingestion-sentinel" ref={sentinelRef}>
            {recent.isFetchingNextPage ? <><Spin size="small" /><span>{t("正在加载更多入库记录")}</span></> : recent.hasNextPage ? <span>{t("继续滚动加载")}</span> : <span>{t("已加载全部入库记录")}</span>}
          </div>
        </div>
      )}
    </Drawer>
  );
}

function HomeCollectionDrawer({ definition, onClose, onOpen, onPlay, onDeleteProgress, onToggleCompleted }: {
  definition: SectionDefinition | null;
  onClose: () => void;
  onOpen: (item: MediaItem, queue: MediaItem[]) => void;
  onPlay: (item: MediaItem, queue: MediaItem[]) => void;
  onDeleteProgress: (item: MediaItem) => void;
  onToggleCompleted: (item: MediaItem) => void;
}) {
  useLocale();
  const section = definition?.key as HomeSectionKey | undefined;
  const collection = useInfiniteQuery({
    queryKey: ["home-dashboard", "collection-drawer", section],
    queryFn: ({ pageParam }) => fetchHomeSectionPage(section ?? "history", pageParam, 48),
    enabled: Boolean(section),
    initialPageParam: 1,
    getNextPageParam: (lastPage) =>
      lastPage.page < lastPage.totalPages ? lastPage.page + 1 : undefined,
    refetchOnMount: "always",
    staleTime: 5_000
  });
  const items = useLocalizedMemo(() => {
    const seen = new Set<string>();
    return (collection.data?.pages ?? []).flatMap((page) => page.items).filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }, [collection.data?.pages]);
  const sentinelRef = useInfiniteScroll({
    enabled: Boolean(section),
    hasNextPage: Boolean(collection.hasNextPage),
    isFetchingNextPage: collection.isFetchingNextPage,
    onLoadMore: collection.fetchNextPage
  });
  const total = collection.data?.pages[0]?.total ?? 0;
  const showProgress = section === "history" || section === "continue";
  const allowProgressActions = section === "history" || section === "continue" || section === "completed";

  return (
    <Drawer
      className="recent-ingestion-drawer home-collection-drawer"
      extra={<span className="recent-ingestion-loaded">{t("已加载")} {items.length.toLocaleString(getIntlLocale())} / {total.toLocaleString(getIntlLocale())}</span>}
      onClose={onClose}
      open={Boolean(definition)}
      size={1080}
      title={definition ? t("全部{{p0}}", { p0: definition.title }) : t("全部视频")}
    >
      {collection.isLoading ? (
        <div className="recent-ingestion-loading"><Spin /></div>
      ) : items.length === 0 ? (
        <Empty description={definition?.emptyText ?? t("暂无视频")} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <>
          <div className="home-drawer-grid" role="list">
            {items.map((item) => (
              <div key={item.id} role="listitem">
                <HomeMediaCard
                  item={item}
                  onDeleteProgress={allowProgressActions ? onDeleteProgress : undefined}
                  onOpen={(next) => onOpen(next, items)}
                  onPlay={(next) => onPlay(next, items)}
                  onToggleCompleted={allowProgressActions ? onToggleCompleted : undefined}
                  showProgress={showProgress}
                />
              </div>
            ))}
          </div>
          <div className="recent-ingestion-sentinel" ref={sentinelRef}>
            {collection.isFetchingNextPage ? <><Spin size="small" /><span>{t("正在加载更多视频")}</span></> : collection.hasNextPage ? <span>{t("继续滚动加载")}</span> : <span>{t("已加载全部视频")}</span>}
          </div>
        </>
      )}
    </Drawer>
  );
}

export function HomeDashboard({ onOpen, onPlay, onOpenEntity, onOpenFavorites, onOpenPlaylists, onOpenLibraryAnalytics }: HomeDashboardProps) {
  const demoStatus = useDemoStatus();
  useLocale();
  const queryClient = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<MediaItem | null>(null);
  const [importFile, setImportFile] = useState<{ name: string; text: string } | null>(null);
  const [recentIngestionOpen, setRecentIngestionOpen] = useState(false);
  const [highlightsOpen, setHighlightsOpen] = useState(false);
  const [collectionDrawer, setCollectionDrawer] = useState<SectionDefinition | null>(null);
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>("all");
  const importInputRef = useRef<HTMLInputElement>(null);
  const timelineScrollRef = useRef<HTMLElement>(null);
  const personal = useQuery({ queryKey: ["personal-dashboard"], queryFn: fetchPersonalDashboard, staleTime: 30_000 });
  const playlists = useQuery({ queryKey: ["playlists"], queryFn: fetchPlaylists, staleTime: 60_000 });
  const favorites = useQuery({ queryKey: ["favorites"], queryFn: fetchFavorites, staleTime: 60_000 });
  const historyTimeline = useInfiniteQuery({
    queryKey: ["home-dashboard", "journal-history"],
    queryFn: ({ pageParam }) => fetchHomeSectionPage("history", pageParam, JOURNAL_PAGE_SIZE),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => lastPage.page < lastPage.totalPages ? lastPage.page + 1 : undefined,
    staleTime: 30_000
  });
  const ingestionTimeline = useInfiniteQuery({
    queryKey: ["home-dashboard", "journal-ingestion"],
    queryFn: ({ pageParam }) => fetchRecentIngestionPage(pageParam, JOURNAL_PAGE_SIZE),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => lastPage.page < lastPage.totalPages ? lastPage.page + 1 : undefined,
    staleTime: 5_000,
    refetchOnMount: "always"
  });
  const recommendations = useQuery({
    queryKey: ["personal-recommendations", personal.data?.recommendationAnchor],
    queryFn: async () => {
      const anchor = personal.data?.recommendationAnchor;
      if (anchor) {
        try {
          const response = await fetchRecommendations(anchor, { limit: 12 });
          if (response.items.length > 0) return { items: response.items, total: response.items.length };
        } catch {
          // A discovery fallback keeps this section useful if personalized matching is unavailable.
        }
      }
      return fetchHomeSection("discover");
    },
    enabled: !personal.isPending,
    staleTime: 10 * 60_000
  });
  const deleteProgress = useMutation({
    mutationFn: deletePlaybackProgress,
    onError: (error) => message.error(error instanceof Error ? error.message : t("删除观看记录失败")),
    onSuccess: () => message.success(t("观看记录已删除")),
    onSettled: async () => Promise.all([
      queryClient.invalidateQueries({ queryKey: homeQueryKeys.all }),
      queryClient.invalidateQueries({ queryKey: ["personal-dashboard"] }),
      queryClient.invalidateQueries({ queryKey: ["media"] })
    ])
  });
  const toggleCompleted = useMutation({
    mutationFn: (item: MediaItem) => updatePlaybackProgress(item.id, {
      positionSeconds: item.playback?.positionSeconds ?? 0,
      durationSeconds: item.playback?.durationSeconds ?? item.durationSeconds,
      completed: !item.playback?.completed
    }),
    onSuccess: async (_result, item) => {
      message.success(item.playback?.completed ? t("已恢复为未看完") : t("已标记为看完"));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: homeQueryKeys.all }),
        queryClient.invalidateQueries({ queryKey: ["personal-dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["media"] })
      ]);
    },
    onError: (error) => message.error(error instanceof Error ? error.message : t("更新观看状态失败"))
  });
  const importPersonal = useMutation({
    mutationFn: importPersonalData,
    onSuccess: async (result) => {
      setImportFile(null);
      message.success(t("个人数据已恢复{{p0}}", { p0: result.skippedMedia ? `，跳过 ${result.skippedMedia} 条失效媒体` : "" }));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: homeQueryKeys.all }),
        queryClient.invalidateQueries({ queryKey: ["personal-dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["personal-recommendations"] }),
        queryClient.invalidateQueries({ queryKey: ["favorites"] }),
        queryClient.invalidateQueries({ queryKey: ["playlists"] }),
        queryClient.invalidateQueries({ queryKey: ["media"] })
      ]);
    },
    onError: (error) => message.error(error instanceof Error ? error.message : t("个人数据导入失败"))
  });
  const maxTrend = Math.max(1, ...(personal.data?.trend.map((item) => item.played) ?? [1]));
  const favoriteEntities = favorites.data?.entities.slice(0, 12) ?? [];
  const updates = useLocalizedMemo(
    () => personal.data?.favoriteUpdates.filter((item) => item.newCount > 0) ?? [],
    [personal.data?.favoriteUpdates]
  );
  const monthName = new Intl.DateTimeFormat(getIntlLocale(), { month: "long" }).format(new Date());
  const statItems = useLocalizedMemo(() => {
    if (!personal.data) return [];
    const stats = personal.data.stats;
    const completionRate = stats.played > 0 ? Math.round(stats.completed / stats.played * 100) : 0;
    const inProgressRate = stats.played > 0 ? Math.round(stats.inProgress / stats.played * 100) : 0;
    return [
      { action: "history" as const, actionLabel: t("查看全部"), description: t("{{p0}} 部待继续 · {{p1}} 部已完成", { p0: stats.inProgress, p1: stats.completed }), label: t("观看记录"), value: stats.played, formatter: undefined, icon: History },
      { action: "continue" as const, actionLabel: t("继续观看"), description: stats.inProgress > 0 ? t("占观看记录 {{p0}}%", { p0: inProgressRate }) : t("当前没有未看完的影片"), label: t("进行中"), value: stats.inProgress, formatter: undefined, icon: Play },
      { action: "completed" as const, actionLabel: t("查看完成"), description: stats.completed > 0 ? t("观看完成率 {{p0}}%", { p0: completionRate }) : t("还没有标记为已看完"), label: t("已看完"), value: stats.completed, formatter: undefined, icon: CheckCircle2 },
      { action: "watch-timeline" as const, actionLabel: t("筛选时间轴"), description: stats.played > 0 ? t("平均每条 {{p0}}", { p0: formatHours(stats.watchSeconds / stats.played) }) : t("开始观看后生成统计"), label: t("累计观看"), value: stats.watchSeconds, formatter: formatHours, icon: BarChart3 },
      { action: "favorites" as const, actionLabel: t("打开收藏"), description: stats.favoriteCount > 0 ? t("集中查看喜欢的影片与专题") : t("收藏后可在这里快速访问"), label: t("收藏"), value: stats.favoriteCount, formatter: undefined, icon: Heart },
      { action: "playlists" as const, actionLabel: t("管理片单"), description: stats.playlistCount > 0 ? t("已建立 {{p0}} 个自定义片单", { p0: stats.playlistCount }) : t("创建你的第一个自定义片单"), label: t("片单"), value: stats.playlistCount, formatter: undefined, icon: ListVideo }
    ];
  }, [personal.data]);
  const historyItems = useLocalizedMemo(() => {
    const seen = new Set<string>();
    return (historyTimeline.data?.pages ?? []).flatMap((page) => page.items).filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }, [historyTimeline.data?.pages]);
  const recentItems = useLocalizedMemo(() => {
    const seen = new Set<string>();
    return (ingestionTimeline.data?.pages ?? []).flatMap((page) => page.items).filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }, [ingestionTimeline.data?.pages]);
  const timelineEvents = useLocalizedMemo<TimelineEvent[]>(() => {
    const watchEvents = historyItems.map((media) => ({
      key: `watch:${media.id}`,
      kind: media.playback?.completed ? "completed" as const : "watch" as const,
      occurredAt: media.playback?.lastPlayedAt || media.indexedAt,
      media
    }));
    const ingestionEvents = recentItems.map((media) => ({
      key: `ingestion:${media.id}`,
      kind: "ingestion" as const,
      occurredAt: media.ingestedAt || media.indexedAt,
      media
    }));
    const favoriteEvents = updates.slice(0, 6).map((update, index) => ({
      key: `favorite:${update.type}:${update.value}`,
      kind: "favorite" as const,
      occurredAt: new Date(Date.now() - index * 60_000).toISOString(),
      update
    }));
    return [...watchEvents, ...ingestionEvents, ...favoriteEvents]
      .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
  }, [historyItems, recentItems, updates]);
  const mixedTimelineEvents = timelineEvents.reduce<{ favoriteCount: number; events: TimelineEvent[] }>((result, event) => {
    if (event.kind === "favorite" && result.favoriteCount >= 2) return result;
    result.events.push(event);
    if (event.kind === "favorite") result.favoriteCount += 1;
    return result;
  }, { favoriteCount: 0, events: [] }).events;
  const visibleTimelineEvents = (timelineFilter === "all" ? mixedTimelineEvents : timelineEvents.filter((event) => {
    if (timelineFilter === "watch") return event.kind === "watch" || event.kind === "completed";
    return event.kind === timelineFilter;
  }));
  const timelineFilterCounts: Record<TimelineFilter, number> = {
    all: mixedTimelineEvents.length,
    watch: timelineEvents.filter((event) => event.kind === "watch" || event.kind === "completed").length,
    ingestion: timelineEvents.filter((event) => event.kind === "ingestion").length,
    favorite: timelineEvents.filter((event) => event.kind === "favorite").length
  };
  const timelineGroups = visibleTimelineEvents.reduce<Array<{ label: string; events: TimelineEvent[] }>>((groups, event) => {
    const label = formatTimelineGroup(event.occurredAt);
    const last = groups.at(-1);
    if (last?.label === label) last.events.push(event);
    else groups.push({ label, events: [event] });
    return groups;
  }, []);
  const timelineHasNextPage = timelineFilter === "all"
    ? Boolean(historyTimeline.hasNextPage || ingestionTimeline.hasNextPage)
    : timelineFilter === "watch" ? Boolean(historyTimeline.hasNextPage)
      : timelineFilter === "ingestion" ? Boolean(ingestionTimeline.hasNextPage) : false;
  const timelineIsFetchingNextPage = timelineFilter === "all"
    ? historyTimeline.isFetchingNextPage || ingestionTimeline.isFetchingNextPage
    : timelineFilter === "watch" ? historyTimeline.isFetchingNextPage
      : timelineFilter === "ingestion" ? ingestionTimeline.isFetchingNextPage : false;
  const loadMoreTimeline = useCallback(async () => {
    if (timelineFilter === "watch") {
      if (historyTimeline.hasNextPage) await historyTimeline.fetchNextPage();
      return;
    }
    if (timelineFilter === "ingestion") {
      if (ingestionTimeline.hasNextPage) await ingestionTimeline.fetchNextPage();
      return;
    }
    if (timelineFilter === "all") {
      await Promise.all([
        historyTimeline.hasNextPage ? historyTimeline.fetchNextPage() : Promise.resolve(),
        ingestionTimeline.hasNextPage ? ingestionTimeline.fetchNextPage() : Promise.resolve()
      ]);
    }
  }, [historyTimeline, ingestionTimeline, timelineFilter]);
  const timelineSentinelRef = useInfiniteScroll({
    enabled: timelineFilter !== "favorite",
    hasNextPage: timelineHasNextPage,
    isFetchingNextPage: timelineIsFetchingNextPage,
    onLoadMore: loadMoreTimeline,
    rootMargin: "360px 0px"
  });
  const selectTimelineFilter = useCallback((nextFilter: TimelineFilter) => {
    setTimelineFilter(nextFilter);
    timelineScrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, []);
  const activateJournalStat = useCallback((action: JournalStatAction) => {
    if (action === "favorites") {
      onOpenFavorites();
      return;
    }
    if (action === "playlists") {
      onOpenPlaylists();
      return;
    }
    if (action === "watch-timeline") {
      selectTimelineFilter("watch");
      timelineScrollRef.current?.focus({ preventScroll: true });
      return;
    }
    const definitions: Record<"history" | "continue" | "completed", SectionDefinition> = {
      history: { key: "history", title: t("观看记录"), emptyText: t("还没有观看记录"), icon: History, allowDelete: true },
      continue: { key: "continue", title: t("进行中"), emptyText: t("当前没有未看完的影片"), icon: Play, allowDelete: true },
      completed: { key: "completed", title: t("已看完"), emptyText: t("还没有标记为已看完的影片"), icon: CheckCircle2, allowDelete: true }
    };
    setCollectionDrawer(definitions[action]);
  }, [onOpenFavorites, onOpenPlaylists, selectTimelineFilter]);

  return (
    <>
      <Modal cancelText={t("取消")} confirmLoading={deleteProgress.isPending} okButtonProps={{ danger: true }} okText={t("删除记录")} onCancel={() => setDeleteTarget(null)} onOk={async () => {
        if (!deleteTarget) return;
        await deleteProgress.mutateAsync(deleteTarget.id);
        setDeleteTarget(null);
      }} open={Boolean(deleteTarget)} title={t("删除观看记录？")}>{t("将清除")} {deleteTarget?.normalizedCode || deleteTarget?.basename} {t("的播放进度，此操作不会删除视频。")}</Modal>
      <Modal cancelText={t("取消")} confirmLoading={importPersonal.isPending} okButtonProps={{ danger: true }} okText={t("导入并替换")} onCancel={() => setImportFile(null)} onOk={() => importFile && importPersonal.mutate(importFile.text)} open={Boolean(importFile)} title={t("恢复我的数据？")}>{t("将从")} <strong>{importFile?.name}</strong> {t("重新解析观看进度、收藏、专题收藏和片单，并替换当前“我的”数据。媒体库文件不会被修改。")}</Modal>
      <HighlightsDrawer open={highlightsOpen} onClose={() => setHighlightsOpen(false)}/>
      <RecentIngestionDrawer onClose={() => setRecentIngestionOpen(false)} onOpen={onOpen} onPlay={onPlay} open={recentIngestionOpen} />
      <HomeCollectionDrawer
        definition={collectionDrawer}
        onClose={() => setCollectionDrawer(null)}
        onDeleteProgress={setDeleteTarget}
        onOpen={onOpen}
        onPlay={onPlay}
        onToggleCompleted={(item) => toggleCompleted.mutate(item)}
      />
      <main className="home-dashboard home-journal">
        <header className="journal-header">
          <div className="journal-heading-copy">
            <span className="journal-kicker">PERSONAL MEDIA JOURNAL</span>
            <Typography.Title level={2}>{t("我的媒体手记")}</Typography.Title>
            <Typography.Text>{t("把观看、收藏与新入库，整理成一条属于你的时间线")}</Typography.Text>
          </div>
          <div className="journal-data-actions">
            <Button icon={<Scissors size={14}/>} onClick={() => setHighlightsOpen(true)}>{t("我的高光")}</Button>
            <Button className="journal-analytics-entry" icon={<BarChart3 size={14} />} onClick={onOpenLibraryAnalytics} size="small" type="primary">{t("馆藏分析")}</Button>
            <Button disabled={demoStatus.data?.demo === true} href={getPersonalDataExportUrl()} icon={<Download size={14} />} size="small">{t("导出")}</Button>
            <Button disabled={demoStatus.data?.demo === true} icon={<Upload size={14} />} onClick={() => importInputRef.current?.click()} size="small">{t("恢复")}</Button>
            <input accept=".txt,text/plain,application/json" aria-label={t("选择个人数据 TXT")} hidden onChange={async (event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; try { setImportFile({ name: file.name, text: await file.text() }); } catch { message.error(t("无法读取所选文件")); } }} ref={importInputRef} type="file" />
          </div>
        </header>

        <section className="journal-summary" aria-label={t("个人媒体概览")}>
          {personal.isPending ? Array.from({ length: 6 }, (_, index) => <Skeleton.Node active className="journal-stat-skeleton" key={index} />) : statItems.map((item, index) => (
            <button className={`journal-stat journal-stat-${index + 1}`} key={item.label} onClick={() => activateJournalStat(item.action)} title={`${item.label} · ${item.actionLabel}`} type="button">
              <span className="journal-stat-heading"><span><item.icon size={15} />{item.label}</span><ChevronRight size={14} /></span>
              <span className="journal-stat-value"><AnimatedMetric delay={index * 45} formatter={item.formatter} value={item.value} /><small>{item.actionLabel}</small></span>
              <span className="journal-stat-detail">{item.description}</span>
            </button>
          ))}
        </section>

        <div className="journal-layout">
          <section aria-label={t("活动时间轴")} className="journal-main-column" id="journal-timeline" ref={timelineScrollRef} tabIndex={-1}>
            <div className="journal-timeline-toolbar">
              <div className="journal-filter-tabs" role="tablist" aria-label={t("活动类型")}>
                {([
                  ["all", t("全部")], ["watch", t("观看")], ["ingestion", t("入库")], ["favorite", t("收藏")]
                ] as Array<[TimelineFilter, string]>).map(([value, label]) => (
                  <button aria-controls="journal-timeline-events" aria-selected={timelineFilter === value} className={timelineFilter === value ? "is-active" : ""} key={value} onClick={() => selectTimelineFilter(value)} role="tab" type="button"><span>{label}</span><small>{timelineFilterCounts[value]}</small></button>
                ))}
              </div>
              <span>{t("显示")} {visibleTimelineEvents.length} {t("条 · 共加载")} {timelineEvents.length} {t("条")}</span>
            </div>

            <div className="journal-timeline" id="journal-timeline-events">
              {timelineGroups.length === 0 ? <div className="journal-empty-card">{t("当前筛选下还没有活动记录")}</div> : timelineGroups.map((group) => (
                <section className="journal-day" key={group.label}>
                  <header><span>{group.label}</span><small>{group.events.length} {t("条")}</small></header>
                  <div className="journal-day-events">
                    {group.events.map((event) => {
                      const media = event.media;
                      const isWatch = event.kind === "watch" || event.kind === "completed";
                      const EventIcon = event.kind === "ingestion" ? PackageCheck : event.kind === "favorite" ? Bookmark : event.kind === "completed" ? CheckCircle2 : History;
                      if (event.kind === "favorite" && event.update) return (
                        <article className="journal-event journal-event-favorite motion-list-item" key={event.key}>
                          <span className="journal-event-marker"><EventIcon size={14} /></span>
                          <div className="journal-event-copy">
                            <span className="journal-event-type">{t("收藏更新")}</span>
                            <strong>{event.update.label || event.update.value}</strong>
                            <small>{topicLabels[event.update.type]}{t("专题有")} {event.update.newCount} {t("部新入库影片")}</small>
                          </div>
                          <span className="journal-event-time">{t("持续更新")}</span>
                          <Button icon={<ChevronRight size={15} />} onClick={() => onOpenEntity(event.update!)} shape="circle" type="text" />
                        </article>
                      );
                      if (!media) return null;
                      const playbackPercent = getPlaybackPercent(media);
                      const durationSeconds = media.playback?.durationSeconds ?? media.durationSeconds ?? 0;
                      const watchedSeconds = Math.min(durationSeconds, media.playback?.positionSeconds ?? 0);
                      const remainingSeconds = Math.max(0, durationSeconds - watchedSeconds);
                      const timelineFacts = getTimelineFacts(media);
                      return (
                        <article className={`journal-event journal-event-${event.kind} motion-list-item`} key={event.key}>
                          <span className="journal-event-marker"><EventIcon size={14} /></span>
                          <button className="journal-event-poster" onClick={() => onOpen(media, isWatch ? historyItems : recentItems)} type="button"><PosterImage alt="" loading="lazy" src={getPosterUrl(media.id)} /></button>
                          <div className="journal-event-copy">
                            <span className="journal-event-type">{event.kind === "ingestion" ? t("新入库") : event.kind === "completed" ? t("已看完") : t("观看")}</span>
                            <strong>{media.normalizedCode || media.basename}</strong>
                            <small>{getTitle(media)}</small>
                          </div>
                          <div className="journal-event-context">
                            <div className="journal-event-facts">
                              {timelineFacts.map((fact, index) => <span key={`${fact}:${index}`}>{fact}</span>)}
                            </div>
                            {isWatch ? (
                              <div className="journal-event-progress-row">
                                <span className="journal-event-progress"><i style={{ width: `${event.kind === "completed" ? 100 : playbackPercent}%` }} /></span>
                                <small>{event.kind === "completed" ? t("完整观看") : remainingSeconds > 0 ? t("剩余 {{p0}}", { p0: formatCompactDuration(remainingSeconds) }) : t("已观看 {{p0}}%", { p0: playbackPercent })}</small>
                              </div>
                            ) : <small className="journal-event-ingestion-note">{t("新内容已进入推荐与专题关系")}</small>}
                          </div>
                          <div className="journal-event-meta">
                            <span>{formatTimelineTime(event.occurredAt)}</span>
                            {isWatch && <small>{event.kind === "completed" ? t("已完成") : t("观看到 {{p0}}%", { p0: getPlaybackPercent(media) })}</small>}
                            {event.kind === "ingestion" && <small>{t("已加入媒体库")}</small>}
                          </div>
                          <div className="journal-event-actions">
                            <Button aria-label={event.kind === "watch" ? t("继续播放") : event.kind === "completed" ? t("重新播放") : t("播放")} className="journal-event-play-action" icon={<Play fill="currentColor" size={13} />} onClick={() => onPlay(media, isWatch ? historyItems : recentItems)} type="primary">{event.kind === "watch" ? t("继续播放") : event.kind === "completed" ? t("重新播放") : t("播放")}</Button>
                            {isWatch && <Button aria-label={t("标记看完")} icon={<CheckCircle2 size={14} />} onClick={() => toggleCompleted.mutate(media)} shape="circle" />}
                            {isWatch && <Button aria-label={t("删除观看记录")} icon={<Trash2 size={14} />} onClick={() => setDeleteTarget(media)} shape="circle" />}
                            {!isWatch && <Button aria-label={t("查看详情")} icon={<MoreHorizontal size={15} />} onClick={() => onOpen(media, recentItems)} shape="circle" />}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>

            <div className="journal-infinite-sentinel" ref={timelineSentinelRef}>
              {timelineIsFetchingNextPage ? <><Spin size="small" /><span>{t("正在加载更多活动")}</span></>
                : timelineHasNextPage ? <span>{t("继续滚动加载")}</span>
                  : <span>{timelineFilter === "favorite" ? t("已显示全部收藏更新") : t("已加载全部活动")}</span>}
            </div>
          </section>

          <aside aria-label={t("个人洞察")} className="journal-insights">
            <section className="journal-side-panel journal-recommendations">
              <header><div><Sparkles size={16} /><strong>{t("为你继续发现")}</strong></div><span>{recommendations.data?.total ?? 0}</span></header>
              {recommendations.isPending ? <Skeleton active paragraph={{ rows: 4 }} /> : <div className="journal-recommendation-list">{recommendations.data?.items.slice(0, 5).map((item) => (
                <article className="journal-recommendation-item" key={item.id}>
                  <button className="journal-recommendation-open" onClick={() => onOpen(item, recommendations.data?.items ?? [])} type="button">
                    <PosterImage alt="" loading="lazy" src={getPosterUrl(item.id)} />
                    <span><strong>{item.normalizedCode || item.basename}</strong><small>{item.recommendationReason || getActors(item) || t("基于最近观看")}</small></span>
                    <ChevronRight size={14} />
                  </button>
                  <button
                    aria-label={t("播放 {{p0}}", { p0: item.normalizedCode || item.basename })}
                    className="journal-recommendation-play"
                    onClick={() => onPlay(item, recommendations.data?.items ?? [])}
                    title={t("直接播放")}
                    type="button"
                  >
                    <Play fill="currentColor" size={12} />
                  </button>
                </article>
              ))}</div>}
            </section>

            <section className="journal-side-panel">
              <header><div><ListVideo size={16} /><strong>{t("我的片单")}</strong></div><Button onClick={() => onOpenPlaylists()} size="small" type="text">{t("管理")}</Button></header>
              {playlists.isPending ? <Skeleton active paragraph={{ rows: 2 }} /> : <div className="journal-playlist-list">{playlists.data?.items.slice(0, 4).map((item) => <button key={item.id} onClick={() => onOpenPlaylists(item.id)} type="button"><span><ListVideo size={14} /><strong>{item.name}</strong></span><small>{item.itemCount} {t("个视频")}</small><ChevronRight size={14} /></button>)}</div>}
            </section>

            <section className="journal-side-panel">
              <header><div><UserRound size={16} /><strong>{t("收藏专题")}</strong></div><Button onClick={onOpenFavorites} size="small" type="text">{t("全部")}</Button></header>
              {favoriteEntities.length === 0 ? <Empty description={t("还没有收藏专题")} image={Empty.PRESENTED_IMAGE_SIMPLE} /> : <div className="journal-topic-cloud">{favoriteEntities.map((item) => <button key={`${item.type}:${item.value}`} onClick={() => onOpenEntity(item)} type="button"><span>{item.label || item.value}</span><small>{topicLabels[item.type]}</small></button>)}</div>}
            </section>

            <section className="journal-side-panel journal-recap-panel">
              <header><div><CalendarDays size={16} /><strong>{monthName}{t("观影回顾")}</strong></div><span>{t("近 6 个月")}</span></header>
              <div className="journal-recap-metrics"><div><strong>{personal.data?.month.played ?? 0}</strong><span>{t("观看")}</span></div><div><strong>{personal.data?.month.completed ?? 0}</strong><span>{t("看完")}</span></div><div><strong>{formatHours(personal.data?.month.watchSeconds ?? 0)}</strong><span>{t("时长")}</span></div></div>
              <div className="journal-mini-trend" aria-label={t("近六个月观看趋势")}>{personal.data?.trend.map((item) => <div key={item.month}><span style={{ height: `${Math.max(4, item.played / maxTrend * 100)}%` }} title={t("{{p0}} 部", { p0: item.played })} /><small>{Number(item.month.slice(5))}{t("月")}</small></div>)}</div>
            </section>

            <section className="journal-side-panel journal-update-panel">
              <header><div><Bell size={16} /><strong>{t("收藏更新")}</strong></div><span>{updates.reduce((sum, item) => sum + item.newCount, 0)} {t("部")}</span></header>
              <div>{updates.slice(0, 6).map((item) => <button key={`${item.type}:${item.value}`} onClick={() => onOpenEntity(item)} type="button"><span>{item.label || item.value}</span><small>{topicLabels[item.type]}</small><b>+{item.newCount}</b></button>)}</div>
            </section>
          </aside>
        </div>
      </main>
    </>
  );
}

export type { HomeDashboardProps };
