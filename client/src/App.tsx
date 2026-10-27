import { getIntlLocale } from "./i18n/core";
import { t, useLocale, useLocalizedMemo } from "./i18n";
import { LibrarySourcesEditor } from "./components/LibrarySourcesEditor";
import { LanguageSwitcher } from "./components/LanguageSwitcher";
import { LibraryWelcome } from "./components/LibraryWelcome";
import { DemoNotice, useDemoStatus } from "./components/DemoNotice";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { flushSync } from "react-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Badge,
  Button,
  Collapse,
  Drawer,
  Dropdown,
  FloatButton,
  Input,
  Layout,
  message,
  Space,
  Select,
  Tag,
  Tooltip,
  Typography
} from "antd";
import type { InputRef } from "antd/es/input";
import type { MenuProps } from "antd";
import {
  Activity,
  BadgeCheck,
  Bell,
  Bot,
  Bookmark,
  Captions,
  ChevronsUp,
  Database,
  DatabaseBackup,
  House,
  Languages,
  ListVideo,
  History,
  HardDrive,
  FolderPlus,
  MoreHorizontal,
  MonitorPlay,
  Orbit,
  PanelsTopLeft,
  RefreshCw,
  RotateCcw,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Shuffle,
  UserRound,
  X
} from "lucide-react";
import { FilterBar } from "./components/FilterBar";
import { SearchSuggestInput } from "./components/SearchSuggestInput";
import { AnimatedMetric } from "./components/AnimatedMetric";
import {
  fetchFacets,
  fetchHealthSummary,
  fetchNotificationUnreadCount,
  fetchMedia,
  fetchMediaDetail,
  fetchMetadataStatus,
  fetchRuntimeCapabilities,
  fetchUsers,
  formatBytes,
  requestMetadataEnrich,
  requestScan,
  type MediaItem,
  type MediaQuery,
} from "./lib/api";
import { CATALOG_CACHE_GC_TIME, CATALOG_CACHE_STALE_TIME, useCatalogWarmup } from "./hooks/useCatalogWarmup";
import { useFavorites } from "./hooks/useFavorites";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { useLibrarySettings } from "./hooks/useLibrarySettings";
import { DEFAULT_MEDIA_QUERY, useMediaFilters } from "./hooks/useMediaFilters";
import { useMetadataLanguage } from "./hooks/useMetadataLanguage";
import { useOverlayState } from "./hooks/useOverlayState";
import { useOverlayHistory } from "./hooks/useOverlayHistory";
import { usePlaybackController } from "./hooks/usePlaybackController";
import { useResponsiveMediaMode } from "./hooks/useResponsiveMediaMode";
import { AppContent, preloadAgentWorkspace } from "./app/AppContent";
import { AppOverlays } from "./app/AppOverlays";
import type { AppOverlayKey } from "./app/AppOverlays";
import type { ContentMode } from "./app/types";
import {
  fetchAgentCapabilities,
  fetchAgentThread,
  fetchAgentThreads,
  type AgentEntryContext
} from "./features/agent/api";
import "./animated-metrics.css";
import "./operations-drawer.css";
import "./admin-management.css";

const { Content, Header, Sider } = Layout;
const { Text, Title } = Typography;

const STORAGE_NOTICE_SESSION_KEY = "alexandria-storage-notice-dismissed";

function readStorageNoticeDismissed() {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(STORAGE_NOTICE_SESSION_KEY) === "true";
  } catch {
    return false;
  }
}

const WORKSPACE_MOTION_ORDER: Record<ContentMode, number> = {
  intro: -1,
  wall: 0,
  topics: 1,
  graph: 1.5,
  viewing: 2,
  agent: 3,
  home: 5,
  analytics: 5.25
};

type WorkspaceViewTransition = {
  finished: Promise<void>;
  skipTransition: () => void;
};

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => WorkspaceViewTransition;
};

const MOBILE_RESUME_KEY = "alexandria.mobile-resume.v1";

function readMobileResume(): { query: typeof DEFAULT_MEDIA_QUERY; mode: ContentMode } | null {
  if (!navigator.userAgent.includes("AdultMediaWallAndroid/")) return null;
  try {
    const saved = JSON.parse(localStorage.getItem(MOBILE_RESUME_KEY) ?? "null");
    if (!saved || typeof saved.savedAt !== "number" || Date.now() - saved.savedAt > 24 * 60 * 60 * 1000
      || !Object.prototype.hasOwnProperty.call(WORKSPACE_MOTION_ORDER, saved.mode)
      || !saved.query || typeof saved.query !== "object") return null;
    const query = { ...DEFAULT_MEDIA_QUERY };
    for (const key of Object.keys(query) as Array<keyof typeof query>) {
      const value = saved.query[key];
      const current = query[key];
      if (Array.isArray(current)
        ? Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string")
        : typeof value === typeof current && (typeof value !== "number" || Number.isFinite(value))) {
        Object.assign(query, { [key]: value });
      }
    }
    return { query: { ...query, page: 1 }, mode: saved.mode };
  } catch { return null; }
}

export function App() {
  useLocale();
  const demoStatus = useDemoStatus();
  const {
    query,
    setQuery,
    mediaRequestQuery,
    facetQuery,
    updateQuery,
    resetFilters,
    triggerRandomDiscovery,
    handleSearchSuggestion
  } = useMediaFilters(readMobileResume()?.query);
  const [detailItem, setDetailItem] = useState<MediaItem | null>(null);
  const [detailPlaybackQueue, setDetailPlaybackQueue] = useState<MediaItem[] | null>(null);
  const [detailNavigationDirection, setDetailNavigationDirection] = useState<-1 | 1 | null>(null);
  const detailNavigationLockRef = useRef(false);
  const detailNavigationMotionTimerRef = useRef<number | null>(null);
  const {
    filtersOpen, setFiltersOpen,
    librarySettingsOpen, setLibrarySettingsOpen,
    metadataManagerOpen, setMetadataManagerOpen,
    healthOpen, setHealthOpen,
    savedFiltersOpen, setSavedFiltersOpen,
    favoriteCenterOpen, setFavoriteCenterOpen,
    metadataQualityOpen, setMetadataQualityOpen,
    compatibilityOpen, setCompatibilityOpen,
    maintenanceOpen, setMaintenanceOpen,
    playlistOpen, setPlaylistOpen,
    playlistInitialId, setPlaylistInitialId,
    entity, setEntity
  } = useOverlayState();
  const { metadataLanguage, setMetadataLanguage } = useMetadataLanguage();
  const [contentMode, setContentMode] = useState<ContentMode>(() => readMobileResume()?.mode ?? "wall");
  const shouldLoadLiveWorkspaceData = contentMode !== "intro";
  const [storageNoticeDismissed, setStorageNoticeDismissed] = useState(readStorageNoticeDismissed);
  const [contentMotionDirection, setContentMotionDirection] = useState<"backward" | "forward" | "neutral">("neutral");
  const [isContentModePending, startContentModeTransition] = useTransition();
  const [wallChromeMotion, setWallChromeMotion] = useState<"entering" | "leaving" | null>(null);
  const wallChromeMotionTimerRef = useRef<number | null>(null);
  const workspaceViewTransitionRef = useRef<WorkspaceViewTransition | null>(null);
  const [agentEntryContext, setAgentEntryContext] = useState<AgentEntryContext | null>(null);
  const [desktopFilterExpanded, setDesktopFilterExpanded] = useState(true);
  const [ingestionSettingsOpen, setIngestionSettingsOpen] = useState(false);
  const [notificationCenterOpen, setNotificationCenterOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [userManagerOpen, setUserManagerOpen] = useState(false);
  const [translationManagerOpen, setTranslationManagerOpen] = useState(false);
  const [backupCenterOpen, setBackupCenterOpen] = useState(false);
  const isAndroidShell = useLocalizedMemo(
    () => navigator.userAgent.includes("AdultMediaWallAndroid/"),
    []
  );
  const { mobileViewMode, setMobileViewMode, isDesktop, canUseReelMode, isReelMode } =
    useResponsiveMediaMode(contentMode);
  const searchInputRef = useRef<InputRef>(null);
  const notificationVersionRef = useRef<string | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isAndroidShell) return;
    try {
      localStorage.setItem(MOBILE_RESUME_KEY, JSON.stringify({ query, mode: contentMode, savedAt: Date.now() }));
    } catch { /* Browsing remains available when storage is full or disabled. */ }
  }, [isAndroidShell, query, contentMode]);

  const changeContentMode = useCallback((nextMode: ContentMode) => {
    if (nextMode === contentMode) return;
    if (nextMode === "intro") void queryClient.cancelQueries();
    if (wallChromeMotionTimerRef.current !== null) window.clearTimeout(wallChromeMotionTimerRef.current);
    const nextOrder = WORKSPACE_MOTION_ORDER[nextMode];
    const currentOrder = WORKSPACE_MOTION_ORDER[contentMode];
    const direction = nextOrder === currentOrder ? "neutral" : nextOrder > currentOrder ? "forward" : "backward";
    const chromeMotion = contentMode === "wall" ? "leaving" : nextMode === "wall" ? "entering" : null;
    const applyMode = () => {
      setContentMotionDirection(direction);
      setWallChromeMotion(chromeMotion);
      setContentMode(nextMode);
    };
    wallChromeMotionTimerRef.current = window.setTimeout(() => {
      setWallChromeMotion(null);
      wallChromeMotionTimerRef.current = null;
    }, 240);

    const viewTransitionDocument = document as ViewTransitionDocument;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (viewTransitionDocument.startViewTransition && !reduceMotion) {
      workspaceViewTransitionRef.current?.skipTransition();
      document.documentElement.dataset.workspaceMotionDirection = direction;
      const transition = viewTransitionDocument.startViewTransition(() => flushSync(applyMode));
      workspaceViewTransitionRef.current = transition;
      void transition.finished.finally(() => {
        if (workspaceViewTransitionRef.current === transition) workspaceViewTransitionRef.current = null;
        delete document.documentElement.dataset.workspaceMotionDirection;
      });
      return;
    }

    setContentMotionDirection(direction);
    setWallChromeMotion(chromeMotion);
    startContentModeTransition(() => setContentMode(nextMode));
  }, [contentMode, queryClient]);

  useEffect(() => () => {
    if (wallChromeMotionTimerRef.current !== null) window.clearTimeout(wallChromeMotionTimerRef.current);
    workspaceViewTransitionRef.current?.skipTransition();
  }, []);

  useEffect(() => {
    if (!shouldLoadLiveWorkspaceData) return;
    const warmAgent = () => {
      void preloadAgentWorkspace();
      void queryClient.fetchQuery({
        queryKey: ["agent-capabilities"],
        queryFn: () => fetchAgentCapabilities(),
        staleTime: 30_000
      }).then((capabilities) => {
        if (!capabilities.agentAvailable) return;
        void queryClient.prefetchQuery({
          queryKey: ["agent-threads"],
          queryFn: fetchAgentThreads,
          staleTime: 30_000
        });
        const selectedThreadId = localStorage.getItem("alexandria.agent.selected-thread.v1");
        if (selectedThreadId) {
          void queryClient.prefetchQuery({
            queryKey: ["agent-thread", selectedThreadId],
            queryFn: () => fetchAgentThread(selectedThreadId),
            staleTime: 30_000
          });
        }
      }).catch(() => undefined);
    };
    let idleId: number | null = null;
    const timer = globalThis.setTimeout(() => {
      if ("requestIdleCallback" in window) {
        idleId = window.requestIdleCallback(warmAgent, { timeout: 2_800 });
        return;
      }
      warmAgent();
    }, 1_200);
    return () => {
      globalThis.clearTimeout(timer);
      if (idleId !== null) window.cancelIdleCallback(idleId);
    };
  }, [queryClient, shouldLoadLiveWorkspaceData]);

  useEffect(() => {
    if (!backupCenterOpen) return;
    void import("./components/BackupCenterDrawer");
  }, [backupCenterOpen]);
  const {
    libraryPaths,
    libraryPathDraft,
    setLibraryPathDraft,
    saveLibraryPaths,
    openLibrarySettings
  } = useLibrarySettings({
    enabled: shouldLoadLiveWorkspaceData && demoStatus.data?.demo === false,
    open: librarySettingsOpen,
    setOpen: setLibrarySettingsOpen
  });

  const facets = useQuery({
    queryKey: ["facets", facetQuery],
    queryFn: () => fetchFacets(facetQuery),
    enabled: shouldLoadLiveWorkspaceData,
    retry: 6,
    retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 4_000),
    staleTime: CATALOG_CACHE_STALE_TIME,
    gcTime: CATALOG_CACHE_GC_TIME,
    refetchInterval: (queryState) => (
      queryState.state.data?.scanning || (queryState.state.data?.totals.count ?? 0) === 0
        ? 2000
        : false
    )
  });
  const libraryOverview = useQuery({
    queryKey: ["facets", "library-overview"],
    queryFn: () => fetchFacets(),
    enabled: shouldLoadLiveWorkspaceData,
    retry: 6,
    retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 4_000),
    staleTime: CATALOG_CACHE_STALE_TIME,
    gcTime: CATALOG_CACHE_GC_TIME,
    refetchInterval: (queryState) => (
      queryState.state.data?.scanning || (queryState.state.data?.totals.count ?? 0) === 0
        ? 2000
        : false
    )
  });

  const metadataStatus = useQuery({
    queryKey: ["metadata-status"],
    queryFn: fetchMetadataStatus,
    enabled: shouldLoadLiveWorkspaceData,
    refetchInterval: (queryState) => (queryState.state.data?.running ? 2500 : false)
  });
  const runtimeCapabilities = useQuery({
    queryKey: ["runtime-capabilities"],
    queryFn: fetchRuntimeCapabilities,
    enabled: shouldLoadLiveWorkspaceData,
    staleTime: Number.POSITIVE_INFINITY
  });
  const healthSummary = useQuery({
    queryKey: ["health-summary"],
    queryFn: fetchHealthSummary,
    enabled: shouldLoadLiveWorkspaceData,
    retry: 2,
    retryDelay: (attempt) => Math.min(800 * 2 ** attempt, 4_000),
    refetchInterval: (queryState) => queryState.state.data?.library.availability.mode === "connected"
      ? 60_000
      : 10_000,
    staleTime: 5_000
  });
  const notificationUnread = useQuery({
    queryKey: ["notification-unread-count"],
    queryFn: fetchNotificationUnreadCount,
    enabled: shouldLoadLiveWorkspaceData,
    refetchInterval: 10_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: "always"
  });
  const users = useQuery({
    queryKey: ["users"],
    queryFn: fetchUsers,
    enabled: shouldLoadLiveWorkspaceData,
    staleTime: 30_000
  });

  useEffect(() => {
    if (!notificationUnread.data) return;
    const version = `${notificationUnread.data.count}:${notificationUnread.data.latestCreatedAt ?? "none"}`;
    const previousVersion = notificationVersionRef.current;
    notificationVersionRef.current = version;
    if (previousVersion === version) return;
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ["ingestion-notifications"] }),
      queryClient.invalidateQueries({ queryKey: ["home-dashboard", "recent-ingestion"] })
    ]);
  }, [notificationUnread.data, queryClient]);

  const media = useInfiniteQuery({
    queryKey: ["media", mediaRequestQuery],
    queryFn: ({ pageParam }) => fetchMedia({
      ...mediaRequestQuery,
      page: 1,
      pagination: "cursor",
      cursor: pageParam ?? undefined
    }),
    initialPageParam: null as string | null,
    enabled: shouldLoadLiveWorkspaceData,
    getNextPageParam: (lastPage) => lastPage.nextCursor || undefined,
    placeholderData: (previousData) => previousData,
    retry: 6,
    retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 4_000),
    refetchInterval: (queryState) => (
      (libraryOverview.data?.totals.count ?? 0) > 0
      && !(queryState.state.data?.pages.some((page) => page.items.length > 0) ?? false)
        ? 2000
        : false
    ),
    staleTime: CATALOG_CACHE_STALE_TIME,
    gcTime: CATALOG_CACHE_GC_TIME
  });

  useEffect(() => {
    if (contentMode !== "wall" || isReelMode || isDesktop) return;
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [contentMode, isDesktop, isReelMode, mediaRequestQuery]);

  const scan = useMutation({
    mutationFn: requestScan,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["facets"] }),
        queryClient.invalidateQueries({ queryKey: ["health-summary"] }),
        queryClient.invalidateQueries({ queryKey: ["media"] })
      ]);
    }
  });

  const metadataEnrich = useMutation({
    mutationFn: (options?: Parameters<typeof requestMetadataEnrich>[0]) =>
      requestMetadataEnrich(
        options ?? {
        category:
          query.category !== "ALL"
            ? query.category
            : (metadataStatus.data?.categoryFilter ?? undefined)
        }
      ),
    onSuccess: async (data) => {
      if (!data.status.configured) {
        message.warning(t("请先配置 METADATA_SERVER_URL 后再补全元数据"));
        return;
      }

      const categoryText = data.summary.category ? `${data.summary.category} ` : "";
      message.success(
        `${categoryText}元数据补全完成：成功 ${data.summary.ready}，未匹配 ${data.summary.notFound}，失败 ${data.summary.failed}`
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["metadata-status"] }),
        queryClient.invalidateQueries({ queryKey: ["facets"] }),
        queryClient.invalidateQueries({ queryKey: ["health-summary"] }),
        queryClient.invalidateQueries({ queryKey: ["media"] })
      ]);
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : t("元数据补全失败"));
    }
  });

  const statusText = useLocalizedMemo(() => {
    if (metadataStatus.data?.running) return t("正在补全元数据");
    if (scan.isPending || libraryOverview.data?.scanning) return t("正在扫描");
    if (libraryOverview.data?.latestScan) {
      return t("上次扫描 {{p0}} 个", { p0: libraryOverview.data.latestScan.indexed.toLocaleString(getIntlLocale()) });
    }
    if ((libraryOverview.data?.totals.count ?? 0) > 0) {
      return t("已索引 {{p0}} 个", { p0: libraryOverview.data?.totals.count.toLocaleString(getIntlLocale()) ?? "0" });
    }
    return t("等待索引");
  }, [libraryOverview.data, metadataStatus.data?.running, scan.isPending]);

  const headerMetrics = [
    {
      label: t("文件"),
      value: libraryOverview.data?.totals.count ?? 0,
      formatter: (value: number) => value.toLocaleString(getIntlLocale()),
      milestone: 10_000,
      milestoneAriaLabel: t("已达到一万部馆藏里程碑")
    },
    {
      label: t("容量"),
      value: libraryOverview.data?.totals.totalSize ?? 0,
      formatter: formatBytes,
      milestone: undefined,
      milestoneAriaLabel: undefined
    }
  ];

  const mediaItems = useLocalizedMemo(() => {
    const seen = new Set<string>();
    return (media.data?.pages ?? []).flatMap((page) => page.items).filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }, [media.data?.pages]);
  const firstPage = media.data?.pages[0];
  const activeDetailQueue = detailPlaybackQueue ?? mediaItems;
  const detailItemIndex = detailItem
    ? activeDetailQueue.findIndex((item) => item.relativePath === detailItem.relativePath)
    : -1;
  const hasPreviousDetail = detailItemIndex > 0;
  const hasNextDetail = detailItemIndex >= 0 && (
    detailItemIndex < activeDetailQueue.length - 1
    || (detailPlaybackQueue === null && Boolean(media.hasNextPage))
  );
  const {
    selected,
    setSelected,
    playbackStartSeconds,
    selectMedia,
    selectVersion,
    closePlayback,
    handlePlaybackProgress,
  } = usePlaybackController({
    mediaItems,
    hasNextPage: media.hasNextPage,
    isFetchingNextPage: media.isFetchingNextPage,
    fetchNextPage: media.fetchNextPage,
    setDetailItem
  });
  const connectedSourceNames = useLocalizedMemo(
    () => new Set(healthSummary.data?.library.availability.connectedSourceNames ?? []),
    [healthSummary.data?.library.availability.connectedSourceNames]
  );
  const storageAvailabilityMode = healthSummary.data?.library.availability.mode;
  const solidStateOnly = storageAvailabilityMode === "solid-state-only";
  const partialStorage = storageAvailabilityMode === "partial";
  const dismissStorageNotice = useCallback(() => {
    setStorageNoticeDismissed(true);
    try {
      window.sessionStorage.setItem(STORAGE_NOTICE_SESSION_KEY, "true");
    } catch {
      // The notice can still be dismissed when session storage is unavailable.
    }
  }, []);
  useEffect(() => {
    if (storageAvailabilityMode !== "connected") return;
    setStorageNoticeDismissed(false);
    try {
      window.sessionStorage.removeItem(STORAGE_NOTICE_SESSION_KEY);
    } catch {
      // A future offline state will still restore the notice in memory.
    }
  }, [storageAvailabilityMode]);
  const handlePlayMedia = useCallback((
    item: MediaItem,
    queue?: MediaItem[],
    options?: { startSeconds?: number | null }
  ) => {
    const sourceStateKnown = Boolean(healthSummary.data);
    if (item.mediaType === "video" && sourceStateKnown && !connectedSourceNames.has(item.sourceName)) {
      message.warning({
        content: t("视频源暂未连接，当前仅展示固态硬盘中的馆藏数据"),
        duration: 3,
        key: "media-source-unavailable"
      });
      return;
    }
    selectMedia(item, queue, options);
  }, [connectedSourceNames, healthSummary.data, selectMedia]);
  useEffect(() => {
    if (solidStateOnly && mobileViewMode === "reel") setMobileViewMode("grid");
  }, [mobileViewMode, setMobileViewMode, solidStateOnly]);
  const closeDetail = useOverlayHistory(Boolean(detailItem), "detail", () => {
    setDetailItem(null);
    setDetailPlaybackQueue(null);
  });
  const closePlayer = useOverlayHistory(Boolean(selected), "player", closePlayback);
  const { favorites, handleToggleFavorite, handleRemoveFavorite, handleToggleEntityFavorite } =
    useFavorites({
      enabled: shouldLoadLiveWorkspaceData,
      favoriteOnly: query.favoriteOnly,
      setSelected,
      setDetailItem
    });
  useCatalogWarmup({ enabled: shouldLoadLiveWorkspaceData, facets: facets.data, firstPage, query });

  useEffect(() => {
    window.__AMW_HANDLE_BACK__ = () => {
      if (selected) {
        closePlayer();
        return true;
      }
      if (detailItem) {
        closeDetail();
        return true;
      }
      if (entity) {
        setEntity(null);
        return true;
      }
      if (playlistOpen) {
        setPlaylistOpen(false);
        setPlaylistInitialId(null);
        return true;
      }
      if (favoriteCenterOpen) {
        setFavoriteCenterOpen(false);
        return true;
      }
      if (maintenanceOpen) {
        setMaintenanceOpen(false);
        return true;
      }
      if (compatibilityOpen) {
        setCompatibilityOpen(false);
        return true;
      }
      if (translationManagerOpen) {
        setTranslationManagerOpen(false);
        return true;
      }
      if (metadataQualityOpen) {
        setMetadataQualityOpen(false);
        return true;
      }
      if (savedFiltersOpen) {
        setSavedFiltersOpen(false);
        return true;
      }
      if (healthOpen) {
        setHealthOpen(false);
        return true;
      }
      if (metadataManagerOpen) {
        setMetadataManagerOpen(false);
        return true;
      }
      if (librarySettingsOpen) {
        setLibrarySettingsOpen(false);
        return true;
      }
      if (changelogOpen) {
        setChangelogOpen(false);
        return true;
      }
      if (filtersOpen) {
        setFiltersOpen(false);
        return true;
      }
      if (isReelMode) {
        setMobileViewMode("grid");
        return true;
      }
      if (contentMode === "graph") {
        setContentMode("topics");
        return true;
      }
      if (contentMode === "analytics") {
        changeContentMode("home");
        return true;
      }
      if (contentMode === "intro") {
        changeContentMode("wall");
        return true;
      }
      return false;
    };

    return () => {
      delete window.__AMW_HANDLE_BACK__;
    };
  }, [
    closeDetail,
    closePlayer,
    changelogOpen,
    changeContentMode,
    compatibilityOpen,
    contentMode,
    detailItem,
    entity,
    favoriteCenterOpen,
    filtersOpen,
    healthOpen,
    isReelMode,
    librarySettingsOpen,
    maintenanceOpen,
    metadataManagerOpen,
    metadataQualityOpen,
    playlistOpen,
    savedFiltersOpen,
    selected,
    translationManagerOpen,
    setCompatibilityOpen,
    setEntity,
    setFavoriteCenterOpen,
    setFiltersOpen,
    setHealthOpen,
    setLibrarySettingsOpen,
    setMaintenanceOpen,
    setMetadataManagerOpen,
    setMetadataQualityOpen,
    setMobileViewMode,
    setPlaylistInitialId,
    setPlaylistOpen,
    setSavedFiltersOpen
  ]);

  function openMediaDetail(item: MediaItem, queue?: MediaItem[]) {
    setDetailPlaybackQueue(queue ?? null);
    setDetailItem(item);
  }

  function cueDetailNavigationMotion(direction: -1 | 1) {
    if (detailNavigationMotionTimerRef.current !== null) {
      window.clearTimeout(detailNavigationMotionTimerRef.current);
    }
    setDetailNavigationDirection(direction);
    detailNavigationMotionTimerRef.current = window.setTimeout(() => {
      setDetailNavigationDirection(null);
      detailNavigationMotionTimerRef.current = null;
    }, 280);
  }

  useEffect(() => () => {
    if (detailNavigationMotionTimerRef.current !== null) {
      window.clearTimeout(detailNavigationMotionTimerRef.current);
    }
  }, []);

  async function navigateMediaDetail(direction: -1 | 1) {
    if (!detailItem || detailNavigationLockRef.current) return;
    const queue = detailPlaybackQueue ?? mediaItems;
    const currentIndex = queue.findIndex(
      (item) => item.relativePath === detailItem.relativePath
    );
    if (currentIndex < 0) return;

    const nextIndex = currentIndex + direction;
    if (nextIndex >= 0 && nextIndex < queue.length) {
      cueDetailNavigationMotion(direction);
      setDetailItem(queue[nextIndex]);
      return;
    }

    if (
      direction > 0
      && detailPlaybackQueue === null
      && media.hasNextPage
      && !media.isFetchingNextPage
    ) {
      detailNavigationLockRef.current = true;
      setDetailNavigationDirection(direction);
      let navigated = false;
      try {
        const result = await media.fetchNextPage();
        const nextItems = result.data?.pages.flatMap((page) => page.items) ?? mediaItems;
        const loadedIndex = nextItems.findIndex(
          (item) => item.relativePath === detailItem.relativePath
        );
        if (loadedIndex >= 0 && loadedIndex + 1 < nextItems.length) {
          cueDetailNavigationMotion(direction);
          setDetailItem(nextItems[loadedIndex + 1]);
          navigated = true;
        }
      } finally {
        detailNavigationLockRef.current = false;
        if (!navigated) setDetailNavigationDirection(null);
      }
    }
  }

  async function openMediaById(id: string) {
    try {
      const detail = await queryClient.fetchQuery({
        queryKey: ["media-detail", id],
        queryFn: () => fetchMediaDetail(id),
        staleTime: 5 * 60 * 1000
      });
      openMediaDetail(detail.item);
      return true;
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("无法打开视频详情"));
      return false;
    }
  }

  async function playMediaById(id: string) {
    try {
      const detail = await queryClient.fetchQuery({
        queryKey: ["media-detail", id],
        queryFn: () => fetchMediaDetail(id),
        staleTime: 5 * 60 * 1000
      });
      handlePlayMedia(detail.item);
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("无法播放视频"));
    }
  }

  function handleToolbarMenuClick({ key }: { key: string }) {
    if (key === "changelog") {
      setChangelogOpen(true);
      return;
    }

    if (key === "health") {
      setHealthOpen(true);
      return;
    }

    if (key === "library") {
      openLibrarySettings();
      return;
    }

    if (key === "ingestion") {
      setIngestionSettingsOpen(true);
      return;
    }

    if (key === "metadata-manager") {
      setMetadataManagerOpen(true);
      return;
    }

    if (key === "saved-filters") {
      setSavedFiltersOpen(true);
      return;
    }

    if (key === "metadata-quality") {
      setMetadataQualityOpen(true);
      return;
    }

    if (key === "compatibility") {
      setCompatibilityOpen(true);
      return;
    }

    if (key === "translations") {
      setTranslationManagerOpen(true);
      return;
    }

    if (key === "maintenance") {
      setMaintenanceOpen(true);
      return;
    }

    if (key === "backup") {
      setBackupCenterOpen(true);
      return;
    }

    if (key === "playlists") {
      setPlaylistInitialId(null);
      setPlaylistOpen(true);
      return;
    }

    if (key === "metadata-enrich") {
      metadataEnrich.mutate(undefined);
      return;
    }

    if (key === "reset") {
      resetFilters();
      return;
    }

    if (key === "scan") {
      if (!runtimeCapabilities.data?.canTriggerScan) {
        message.warning(runtimeCapabilities.data?.disabledReason ?? t("当前版本不支持手动扫描"));
        return;
      }
      scan.mutate();
    }
  }

  function applyDetailFilter(patch: Partial<MediaQuery>) {
    updateQuery(patch);
    changeContentMode("wall");
    closeDetail();
  }

  function closeAppOverlay(overlay: AppOverlayKey) {
    const closeHandlers: Record<AppOverlayKey, () => void> = {
      metadata: () => setMetadataManagerOpen(false),
      health: () => setHealthOpen(false),
      saved: () => setSavedFiltersOpen(false),
      quality: () => setMetadataQualityOpen(false),
      compatibility: () => setCompatibilityOpen(false),
      translation: () => setTranslationManagerOpen(false),
      maintenance: () => setMaintenanceOpen(false),
      backup: () => setBackupCenterOpen(false),
      playlist: () => {
        setPlaylistOpen(false);
        setPlaylistInitialId(null);
      },
      ingestion: () => setIngestionSettingsOpen(false),
      notifications: () => setNotificationCenterOpen(false),
      changelog: () => setChangelogOpen(false),
      users: () => setUserManagerOpen(false),
      favorites: () => setFavoriteCenterOpen(false)
    };
    closeHandlers[overlay]();
  }

  useGlobalShortcuts(searchInputRef, triggerRandomDiscovery);

  const filterPanel = (
    <FilterBar
      query={query}
      metadataLanguage={metadataLanguage}
      letters={facets.data?.letters ?? []}
      categories={facets.data?.categories ?? []}
      prefixes={facets.data?.prefixes ?? []}
      buckets={facets.data?.buckets ?? []}
      actors={facets.data?.actors ?? []}
      genres={facets.data?.genres ?? []}
      directors={facets.data?.directors ?? []}
      makers={facets.data?.makers ?? []}
      labels={facets.data?.labels ?? []}
      metadataSeries={facets.data?.metadataSeries ?? []}
      onChange={updateQuery}
      railMode={isDesktop}
      expanded={isDesktop ? desktopFilterExpanded : true}
      onExpandedChange={isDesktop ? setDesktopFilterExpanded : undefined}
    />
  );
  const toolbarMenuItems = useLocalizedMemo<MenuProps["items"]>(
    () => [
      {
        type: "group",
        label: t("馆藏与入库"),
        children: [
          {
            key: "library",
            disabled: demoStatus.data?.staticDemo === true,
            icon: <Settings size={15} />,
            label: t("资源路径")
          },
          {
            key: "ingestion",
            disabled: demoStatus.data?.staticDemo === true,
            icon: <RefreshCw size={15} />,
            label: t("自动入库")
          },
          ...(contentMode === "wall" ? [{
            key: "saved-filters",
            icon: <Bookmark size={15} />,
            label: t("保存的筛选")
          }] : []),
          {
            key: "playlists",
            icon: <ListVideo size={15} />,
            label: t("智能片单")
          },
          {
            key: "backup",
            disabled: demoStatus.data?.staticDemo === true,
            icon: <DatabaseBackup size={15} />,
            label: t("备份中心")
          }
        ]
      },
      {
        type: "group",
        label: t("内容处理"),
        children: [
          {
            key: "metadata-manager",
            disabled: demoStatus.data?.staticDemo === true,
            icon: <Database size={15} />,
            label: t("元数据管理")
          },
          {
            key: "metadata-quality",
            disabled: demoStatus.data?.staticDemo === true,
            icon: <BadgeCheck size={15} />,
            label: t("元数据质量中心")
          },
          {
            key: "translations",
            disabled: demoStatus.data?.staticDemo === true,
            icon: <Captions size={15} />,
            label: t("翻译管理")
          },
          {
            key: "compatibility",
            disabled: demoStatus.data?.staticDemo === true,
            icon: <MonitorPlay size={15} />,
            label: t("播放兼容中心")
          },
          {
            key: "metadata-enrich",
            disabled:
              !metadataStatus.data?.configured ||
              metadataEnrich.isPending ||
              Boolean(metadataStatus.data?.running),
            icon: <Sparkles size={15} />,
            label: metadataStatus.data?.running ? t("元数据补全中") : t("补全元数据")
          }
        ]
      },
      {
        type: "group",
        label: t("系统与维护"),
        children: [
          {
            key: "health",
            disabled: demoStatus.data?.staticDemo === true,
            icon: <Activity size={15} />,
            label: t("数据健康中心")
          },
          {
            key: "maintenance",
            disabled: demoStatus.data?.staticDemo === true,
            icon: <ShieldCheck size={15} />,
            label: t("资产与备份")
          },
          {
            key: "changelog",
            disabled: demoStatus.data?.staticDemo === true,
            icon: <History size={15} />,
            label: t("更新日志")
          },
          ...(contentMode === "wall" ? [{
            key: "reset",
            icon: <RotateCcw size={15} />,
            label: t("重置筛选")
          }] : []),
          {
            key: "scan",
            disabled: scan.isPending || !runtimeCapabilities.data?.canTriggerScan,
            icon: <RefreshCw size={15} className={scan.isPending ? "spin" : ""} />,
            label: scan.isPending ? t("重扫中") : t("重新扫描")
          }
        ]
      }
    ],
    [demoStatus.data?.staticDemo, metadataEnrich.isPending, metadataStatus.data?.configured, metadataStatus.data?.running, runtimeCapabilities.data?.canTriggerScan, scan.isPending, contentMode]
  );

  return (
    <>
      <Layout className={`app-shell${isReelMode ? " is-reel-mode" : ""}${contentMode === "wall" ? " is-wall-mode" : ""}${contentMode === "home" ? " is-home-mode" : ""}${contentMode === "analytics" ? " is-analytics-mode" : ""}${contentMode === "viewing" ? " is-viewing-mode" : ""}${contentMode === "agent" ? " is-agent-mode" : ""}${contentMode === "intro" ? " is-intro-mode" : ""}${contentMode === "topics" || contentMode === "graph" ? " is-topic-mode" : ""}`}>
        <Header className="topbar">
          <div className="brand-console">
            <div className="brand">
              <button
                aria-current={contentMode === "intro" ? "page" : undefined}
                aria-label={t("打开产品介绍")}
                className="brand-mark-button"
                onClick={() => changeContentMode("intro")}
                type="button"
              >
                <img alt="" aria-hidden="true" className="brand-mark" src="/brand-icon.png" />
              </button>
              <div className="brand-copy">
                <div className="brand-title-row">
                  <Title level={3}>Alexandria 18+</Title>
                  <Tag className="brand-badge">PRIVATE</Tag>
                </div>
                <div className="brand-meta-row">
                  <Text className="brand-subtitle">{t("亚历山大典藏")}</Text>
                  <Text className="brand-status" type="secondary">
                    {statusText}
                  </Text>
                </div>
              </div>
            </div>

            <div className="header-metrics" aria-label={t("媒体库概览")}>
              {headerMetrics.map((metric) => (
                <AnimatedMetric
                  className="metric-pill"
                  key={metric.label}
                  label={metric.label}
                  value={metric.value}
                  formatter={metric.formatter}
                  milestone={metric.milestone}
                  milestoneAriaLabel={metric.milestoneAriaLabel}
                />
              ))}
            </div>
            {isDesktop && (
              <div
                className="header-workspace-switcher"
                aria-label={t("内容工作区")}
                data-active-index={contentMode === "intro" ? 0 : contentMode === "wall" ? 1 : contentMode === "topics" || contentMode === "graph" ? 2 : contentMode === "viewing" ? 3 : contentMode === "agent" ? 4 : 5}
              >
                <Tooltip title={t("产品介绍")}>
                  <Button
                    aria-label={t("产品介绍")}
                    icon={<Orbit size={16} />}
                    onClick={() => changeContentMode("intro")}
                    type={contentMode === "intro" ? "primary" : "default"}
                  />
                </Tooltip>
                <Tooltip title={t("媒体墙")}>
                  <Button
                    aria-label={t("媒体墙")}
                    icon={<MonitorPlay size={16} />}
                    onClick={() => changeContentMode("wall")}
                    type={contentMode === "wall" ? "primary" : "default"}
                  />
                </Tooltip>
                <Tooltip title={t("专题")}>
                  <Button
                    aria-label={t("专题")}
                    icon={<PanelsTopLeft size={16} />}
                    onClick={() => changeContentMode("topics")}
                    type={contentMode === "topics" || contentMode === "graph" ? "primary" : "default"}
                  />
                </Tooltip>
                <Tooltip title={t("智能观影台")}>
                  <Button
                    aria-label={t("智能观影台")}
                    icon={<Sparkles size={16} />}
                    onClick={() => changeContentMode("viewing")}
                    type={contentMode === "viewing" ? "primary" : "default"}
                  />
                </Tooltip>
                <Tooltip title={t("智能馆长")}>
                  <Button
                    aria-label={t("智能馆长")}
                    icon={<Bot size={16} />}
                    onClick={() => changeContentMode("agent")}
                    type={contentMode === "agent" ? "primary" : "default"}
                  />
                </Tooltip>
                <Tooltip title={t("我的")}>
                  <Button
                    aria-label={t("我的")}
                    icon={<House size={16} />}
                    onClick={() => changeContentMode("home")}
                    type={contentMode === "home" || contentMode === "analytics" ? "primary" : "default"}
                  />
                </Tooltip>
              </div>
            )}
            <LanguageSwitcher />
            {demoStatus.data && !demoStatus.data.demo && <Button
              aria-label={t("接入媒体库")}
              className="header-connect-button"
              icon={<FolderPlus size={16} />}
              onClick={openLibrarySettings}
            ><span className="connect-label">{t("接入媒体库")}</span></Button>}
            <Tooltip title={t("切换或管理用户")}>
              <Button
                aria-label={users.data?.activeUser.name
                  ? t("用户管理，当前用户：{{p0}}", { p0: users.data.activeUser.name })
                  : t("用户信息加载中")}
                className={`header-user-button${users.data?.activeUser.kind === "guest" ? " is-guest" : ""}`}
                icon={users.data?.activeUser.kind === "guest" ? <BadgeCheck size={17} /> : <UserRound size={17} />}
                onClick={() => setUserManagerOpen(true)}
              >
                <span>{users.data?.activeUser.name ?? t("加载中")}</span>
              </Button>
            </Tooltip>
            <Tooltip title={t("任务与告警")}>
              <Badge count={notificationUnread.data?.count ?? 0} size="small">
                <Button
                  aria-label={t("任务与告警")}
                  className="header-notification-button"
                  icon={<Bell size={18} />}
                  onClick={() => setNotificationCenterOpen(true)}
                />
              </Badge>
            </Tooltip>
            <Dropdown
              menu={{ className: "toolbar-more-menu", items: toolbarMenuItems, onClick: handleToolbarMenuClick }}
              placement="bottomRight"
              trigger={["click"]}
            >
              <Button
                aria-label={t("更多工具")}
                className="header-more-button"
                icon={<MoreHorizontal size={18} />}
                title={t("更多工具")}
              />
            </Dropdown>
          </div>
        </Header>

        <Layout className={`workspace-layout${wallChromeMotion ? ` is-wall-chrome-${wallChromeMotion}` : ""}`}>
          {isDesktop && (contentMode === "wall" || wallChromeMotion === "leaving") && (
            <Sider className={`filter-sider wall-chrome-sider${desktopFilterExpanded ? " is-expanded" : " is-collapsed"}`} width={desktopFilterExpanded ? 356 : 76}>
              {filterPanel}
            </Sider>
          )}
          <Content
            aria-busy={isContentModePending}
            className="wall-content"
          >
            <DemoNotice />
            {contentMode === "wall" && demoStatus.data && !demoStatus.data.demo && libraryOverview.data && libraryOverview.data.totals.count === 0 && (
              <LibraryWelcome onConnect={openLibrarySettings} scanning={libraryOverview.data.scanning || scan.isPending} />
            )}
            {(contentMode === "wall" || wallChromeMotion === "leaving") && (
              <div className="toolbar-shell media-content-toolbar wall-chrome-toolbar" aria-label={t("筛选工具栏")}>
                <div className="toolbar">
                  <div className="toolbar-search-group">
                    <SearchSuggestInput
                      inputRef={searchInputRef}
                      onChange={(value) => updateQuery({ q: value })}
                      onSelectSuggestion={handleSearchSuggestion}
                      value={query.q}
                    />
                  </div>
                  <div className="toolbar-action-group">
                    {!isDesktop && (
                      <Button
                        className="mobile-filter-button"
                        icon={<SlidersHorizontal size={16} />}
                        onClick={() => setFiltersOpen(true)}
                      >
                        {t("筛选")} </Button>
                    )}
                    <Select
                      className="sort-select"
                      value={`${query.sort}:${query.direction}`}
                      onChange={(value) => {
                        const [sort, direction] = value.split(":") as [
                          MediaQuery["sort"],
                          MediaQuery["direction"]
                        ];
                        updateQuery({
                          sort,
                          direction,
                          randomSeed: sort === "random" ? Date.now() : query.randomSeed
                        });
                      }}
                      options={[
                        { value: "name:asc", label: t("名称 A-Z") },
                        { value: "name:desc", label: t("名称 Z-A") },
                        { value: "mtime:desc", label: t("最新修改") },
                        { value: "mtime:asc", label: t("最早修改") },
                        { value: "size:desc", label: t("文件最大") },
                        { value: "size:asc", label: t("文件最小") },
                        { value: "recentPlayed:desc", label: t("最近播放") },
                        { value: "progress:desc", label: t("观看进度") },
                        { value: "random:asc", label: t("随机发现") }
                      ]}
                    />
                    <Tooltip title={t("随机发现")}>
                      <Button
                        aria-label={t("随机发现")}
                        className="random-discovery-button"
                        icon={<Shuffle size={16} />}
                        onClick={triggerRandomDiscovery}
                        type={query.sort === "random" ? "primary" : "default"}
                      />
                    </Tooltip>
                    {!isDesktop && (
                    <Tooltip title={solidStateOnly ? t("视频源暂未连接") : mobileViewMode === "reel" ? t("返回双列") : t("刷视频")}>
                      <Button
                          aria-label={mobileViewMode === "reel" ? t("返回双列") : t("刷视频")}
                          className="mobile-reel-toggle-button"
                          disabled={!canUseReelMode || solidStateOnly}
                          icon={<ChevronsUp size={16} />}
                          onClick={() => setMobileViewMode((current) => (current === "reel" ? "grid" : "reel"))}
                          type={mobileViewMode === "reel" ? "primary" : "default"}
                        />
                      </Tooltip>
                    )}
                    <Tooltip title={metadataLanguage === "zh" ? t("切换为日文元数据") : t("切换为中文元数据")}>
                      <Button
                        aria-label={metadataLanguage === "zh" ? t("切换为日文元数据") : t("切换为中文元数据")}
                        className="tool-icon-button metadata-language-button"
                        icon={<Languages size={16} />}
                        onClick={() => setMetadataLanguage((current) => (current === "zh" ? "ja" : "zh"))}
                        type={metadataLanguage === "zh" ? "primary" : "default"}
                      >
                        {metadataLanguage === "zh" ? t("中") : t("日")}
                      </Button>
                    </Tooltip>
                  </div>
                </div>
              </div>
            )}
            {(solidStateOnly || partialStorage) && !storageNoticeDismissed && (
              <Alert
                action={(
                  <Space className="storage-notice-actions" size={0}>
                    <Button onClick={() => setHealthOpen(true)} size="small" type="text">{t("详情")}</Button>
                    <Button
                      aria-label={t("关闭视频源提示")}
                      className="storage-notice-close"
                      icon={<X size={13} />}
                      onClick={dismissStorageNotice}
                      size="small"
                      type="text"
                    />
                  </Space>
                )}
                className="solid-state-catalog-alert"
                icon={<HardDrive size={14} />}
                showIcon
                title={solidStateOnly ? t("视频源未连接，仅浏览本机馆藏") : t("部分视频源未连接")}
                type="warning"
              />
            )}
            <AppContent
              contentMode={contentMode}
              query={query}
              facets={facets.data}
              metadataLanguage={metadataLanguage}
              mediaItems={mediaItems}
              total={firstPage?.total ?? 0}
              pageLabel={firstPage
                ? t("已加载 {{p0}} / {{p1}}", { p0: mediaItems.length.toLocaleString(getIntlLocale()), p1: firstPage.total.toLocaleString(getIntlLocale()) })
                : t("正在读取")}
              isLoading={media.isLoading}
              isRefreshing={media.isFetching && !media.isFetchingNextPage}
              isViewPending={isContentModePending}
              motionDirection={contentMotionDirection}
              isFetchingNextPage={media.isFetchingNextPage}
              hasNextPage={media.hasNextPage}
              containedWallScroll={isDesktop}
              viewMode={canUseReelMode && !solidStateOnly ? mobileViewMode : "grid"}
              onChangeQuery={updateQuery}
              onChangeContentMode={changeContentMode}
              onOpenMedia={openMediaDetail}
              onPlayMedia={handlePlayMedia}
              onOpenMediaById={(id) => void openMediaById(id)}
              onOpenEntity={setEntity}
              onOpenFavorites={() => setFavoriteCenterOpen(true)}
              onOpenPlaylists={(playlistId) => {
                setPlaylistInitialId(playlistId ?? null);
                setPlaylistOpen(true);
              }}
              onToggleFavorite={handleToggleFavorite}
              onToggleEntityFavorite={handleToggleEntityFavorite}
              onExitReel={() => setMobileViewMode("grid")}
              onLoadMore={() => void media.fetchNextPage()}
              agentEntryContext={agentEntryContext}
              onClearAgentEntryContext={() => setAgentEntryContext(null)}
              wallScrollResetKey={JSON.stringify(mediaRequestQuery)}
            />
          </Content>
        </Layout>

        {(contentMode === "wall" || contentMode === "topics" || contentMode === "analytics") && !isReelMode && (
          <FloatButton.BackTop
            aria-label={t("回到顶部")}
            className="page-back-top"
            duration={360}
            target={isDesktop && contentMode === "wall"
              ? () => document.getElementById("media-wall-scroll") as HTMLElement
              : undefined}
            tooltip={t("回到顶部")}
            type="primary"
            visibilityHeight={360}
          />
        )}

        {!isDesktop && !isReelMode && (
          <nav
            className="mobile-bottom-navigation"
            aria-label={t("主要内容导航")}
            data-active-index={contentMode === "intro" ? -1 : contentMode === "wall" ? 0 : contentMode === "topics" || contentMode === "graph" ? 1 : contentMode === "viewing" ? 2 : contentMode === "agent" ? 3 : 4}
          >
            <span aria-hidden="true" className="mobile-bottom-navigation-indicator" />
            <button
              aria-current={contentMode === "wall" ? "page" : undefined}
              className={`mobile-bottom-navigation-item${contentMode === "wall" ? " is-active" : ""}`}
              onClick={() => changeContentMode("wall")}
              type="button"
            >
              <span className="mobile-bottom-navigation-icon"><MonitorPlay size={20} /></span>
              <span>{t("媒体")}</span>
            </button>
            <button
              aria-current={contentMode === "topics" || contentMode === "graph" ? "page" : undefined}
              className={`mobile-bottom-navigation-item${contentMode === "topics" || contentMode === "graph" ? " is-active" : ""}`}
              onClick={() => changeContentMode("topics")}
              type="button"
            >
              <span className="mobile-bottom-navigation-icon"><PanelsTopLeft size={20} /></span>
              <span>{t("专题")}</span>
            </button>
            <button
              aria-current={contentMode === "viewing" ? "page" : undefined}
              className={`mobile-bottom-navigation-item${contentMode === "viewing" ? " is-active" : ""}`}
              onClick={() => changeContentMode("viewing")}
              type="button"
            >
              <span className="mobile-bottom-navigation-icon"><Sparkles size={20} /></span>
              <span>{t("观影台")}</span>
            </button>
            <button
              aria-current={contentMode === "agent" ? "page" : undefined}
              className={`mobile-bottom-navigation-item${contentMode === "agent" ? " is-active" : ""}`}
              onClick={() => changeContentMode("agent")}
              type="button"
            >
              <span className="mobile-bottom-navigation-icon"><Bot size={20} /></span>
              <span>{t("馆长")}</span>
            </button>
            <button
              aria-current={contentMode === "home" || contentMode === "analytics" ? "page" : undefined}
              className={`mobile-bottom-navigation-item${contentMode === "home" || contentMode === "analytics" ? " is-active" : ""}`}
              onClick={() => changeContentMode("home")}
              type="button"
            >
              <span className="mobile-bottom-navigation-icon"><House size={20} /></span>
              <span>{t("我的")}</span>
            </button>
          </nav>
        )}

        <Drawer
          className="filter-drawer"
          extra={<Tag>{(firstPage?.total ?? 0).toLocaleString(getIntlLocale())} {t("个结果")}</Tag>}
          footer={(
            <Button block onClick={() => setFiltersOpen(false)} type="primary">
              {t("完成筛选")} </Button>
          )}
          title={t("媒体筛选")}
          open={filtersOpen}
          onClose={() => setFiltersOpen(false)}
          placement="left"
          size={340}
        >
          {filterPanel}
        </Drawer>

        <Drawer
          className="library-settings-drawer"
          title={<div className="operations-drawer-title"><span className="operations-title-icon"><HardDrive size={18} /></span><span><strong>{t("资源路径配置")}</strong><small>{t("管理馆藏根目录并确认实际扫描源")}</small></span></div>}
          open={librarySettingsOpen}
          onClose={() => setLibrarySettingsOpen(false)}
          placement="right"
          size={520}
          footer={<Button onClick={() => setLibrarySettingsOpen(false)}>{t("完成")}</Button>}
        >
          <LibrarySourcesEditor />
          <Collapse className="advanced-library-settings" items={[{
            key: "two-roots", label: t("高级：双根目录布局（Japan / FC2）"), children: <div className="path-form">
            <Typography.Paragraph type="secondary">{t("仅在需要 Japan / FC2 双根目录布局时使用。保存此配置会替换上方媒体源配置。")}</Typography.Paragraph>
            <div className="library-storage-summary">
              <HardDrive size={20} />
              <div>
                <strong>{(libraryPaths.data?.roots ?? []).filter((root) => root.exists).length} / {(libraryPaths.data?.roots ?? []).length || 2} {t("个根目录可读取")}</strong>
                <span>{t("保存前确认挂载身份和读写权限，路径变化会影响后续扫描。")}</span>
              </div>
              <Tag color={(libraryPaths.data?.roots ?? []).every((root) => root.exists) ? "success" : "warning"}>
                {(libraryPaths.data?.roots ?? []).every((root) => root.exists) ? t("存储就绪") : t("需要检查")}
              </Tag>
            </div>
            <div className="path-section-heading"><strong>{t("馆藏根目录")}</strong><span>{t("两个磁盘分别承载当前媒体库")}</span></div>
            {isAndroidShell && (
              <label className="path-field">
                <span>
                  {t("NAS 服务地址")} <Tag color="processing">Android</Tag>
                </span>
                <Space.Compact block>
                  <Input readOnly value={window.location.origin} />
                  <Button onClick={() => window.location.assign("mediawall://configure-nas")}>
                    {t("修改地址")} </Button>
                </Space.Compact>
              </label>
            )}

            {(libraryPaths.data?.roots ?? [
              { key: "primary", label: t("资源路径 1"), path: libraryPathDraft[0], exists: false },
              { key: "secondary", label: t("资源路径 2"), path: libraryPathDraft[1], exists: false }
            ]).map((entry, index) => {
              const statusLabel = entry.state === "permission-denied"
                ? t("需要权限")
                : entry.state === "not-directory"
                  ? t("路径无效")
                  : entry.state === "missing"
                    ? t("未挂载")
                    : entry.exists
                      ? t("可读取")
                      : t("待确认");
              const statusColor = entry.exists
                ? "success"
                : entry.state === "permission-denied"
                  ? "error"
                  : "warning";
              return (
              <label className="path-field" key={entry.key} title={entry.message}>
                <span>
                  {entry.label}
                  <Tag color={statusColor}>
                    {statusLabel}
                  </Tag>
                </span>
                <Input
                  value={libraryPathDraft[index] ?? ""}
                  onChange={(event) => {
                    const next = [...libraryPathDraft] as [string, string];
                    next[index] = event.target.value;
                    setLibraryPathDraft(next);
                  }}
                  placeholder={
                    index === 0
                      ? "/media/library-1"
                      : "/media/library-2"
                  }
                />
              </label>
              );
            })}

            {saveLibraryPaths.error && (
              <Text className="path-error" type="danger">
                {saveLibraryPaths.error instanceof Error
                  ? saveLibraryPaths.error.message
                  : t("保存失败")}
              </Text>
            )}

            <div className="source-preview">
              <div className="path-section-heading"><strong>{t("实际扫描源")}</strong><span>{t("由根目录自动解析出的分类路径")}</span></div>
              <Space orientation="vertical" size={6}>
                {(libraryPaths.data?.mediaSources ?? []).map((source) => {
                  const statusLabel = source.state === "permission-denied"
                    ? t("需要权限")
                    : source.state === "not-directory"
                      ? t("路径无效")
                      : source.state === "missing"
                        ? t("未挂载")
                        : source.exists
                          ? t("可读取")
                          : t("不可用");
                  return (
                  <div
                    className="source-row"
                    key={`${source.category}:${source.name}`}
                    title={source.message}
                  >
                    <span>{`${source.category}:${source.name}`}</span>
                    <Text ellipsis title={source.root}>
                      {source.root}
                    </Text>
                    <Tag color={source.exists ? "success" : source.state === "permission-denied" ? "error" : "warning"}>
                      {statusLabel}
                    </Tag>
                  </div>
                  );
                })}
              </Space>
            </div>

            {libraryPaths.data?.configPath && (
              <div className="config-path"><span>{t("配置文件")}</span><Text copyable type="secondary">{libraryPaths.data.configPath}</Text></div>
            )}
            <Button type="primary" disabled={!libraryPathDraft.every(path => path.trim().startsWith("/"))} loading={saveLibraryPaths.isPending} onClick={() => saveLibraryPaths.mutate()}>{t("保存双根目录布局")}</Button>
          </div> }]} />
        </Drawer>

        <AppOverlays
          selected={selected}
          playbackStartSeconds={playbackStartSeconds}
          detailItem={detailItem}
          detailPlaybackQueue={detailPlaybackQueue}
          detailNavigationDirection={detailNavigationDirection}
          hasNextDetail={hasNextDetail}
          hasPreviousDetail={hasPreviousDetail}
          metadataLanguage={metadataLanguage}
          query={query}
          favorites={favorites.data}
          favoritesLoading={favorites.isLoading}
          entity={entity}
          metadataManagerOpen={metadataManagerOpen}
          healthOpen={healthOpen}
          savedFiltersOpen={savedFiltersOpen}
          metadataQualityOpen={metadataQualityOpen}
          compatibilityOpen={compatibilityOpen}
          translationManagerOpen={translationManagerOpen}
          maintenanceOpen={maintenanceOpen}
          backupCenterOpen={backupCenterOpen}
          playlistOpen={playlistOpen}
          playlistInitialId={playlistInitialId}
          ingestionSettingsOpen={ingestionSettingsOpen}
          notificationCenterOpen={notificationCenterOpen}
          changelogOpen={changelogOpen}
          userManagerOpen={userManagerOpen}
          favoriteCenterOpen={favoriteCenterOpen}
          onClosePlayer={closePlayer}
          onCloseDetail={closeDetail}
          onNavigateDetail={(direction) => void navigateMediaDetail(direction)}
          onSelectVersion={selectVersion}
          onPlaybackProgress={handlePlaybackProgress}
          onToggleFavorite={handleToggleFavorite}
          onApplyDetailFilter={applyDetailFilter}
          onOpenEntity={setEntity}
          onOpenMedia={openMediaDetail}
          onPlayMedia={handlePlayMedia}
          onOpenMediaById={openMediaById}
          onPlayMediaById={playMediaById}
          onRefreshMetadata={(item) => {
            if (!item.normalizedCode) return;
            metadataEnrich.mutate({
              codes: [item.normalizedCode],
              force: true,
              limit: 1,
              category: item.libraryCategory
            });
          }}
          onAskAgent={(item) => {
            setAgentEntryContext({ source: "media-detail", mediaIds: [item.id], label: item.normalizedCode || item.basename });
            closeDetail();
            changeContentMode("agent");
          }}
          onApplySavedFilter={(savedQuery) => setQuery({
            ...DEFAULT_MEDIA_QUERY,
            ...savedQuery,
            source: "ALL",
            extension: "ALL",
            page: 1
          })}
          onRemoveFavorite={handleRemoveFavorite}
          onShowFavoriteMedia={() => {
            updateQuery({ favoriteOnly: true });
            changeContentMode("wall");
            setFavoriteCenterOpen(false);
          }}
          onToggleEntityFavorite={handleToggleEntityFavorite}
          onCloseOverlay={closeAppOverlay}
        />
      </Layout>
    </>
  );
}
