import { t, useLocale } from "../i18n";
import { lazy, Suspense } from "react";
import { Button, Skeleton } from "antd";
import { House } from "lucide-react";
import { FilterActiveStrip } from "../components/FilterBar";
import { MediaWall } from "../components/MediaWall";
import { MotionSurface } from "../components/motion/MotionSurface";
import type { ActiveEntity } from "../hooks/useOverlayState";
import type {
  FacetsResponse,
  MediaItem,
  MediaQuery,
  TopicType
} from "../lib/api";
import type { MetadataLanguage } from "../lib/metadataDisplay";
import type { ContentMode } from "./types";
import type { AgentEntryContext } from "../features/agent/api";

const HomeDashboard = lazy(() =>
  import("../components/HomeDashboard").then((module) => ({ default: module.HomeDashboard }))
);
const LibraryAnalyticsDashboard = lazy(() =>
  import("../components/LibraryAnalyticsDashboard").then((module) => ({ default: module.LibraryAnalyticsDashboard }))
);
const ProductIntroduction = lazy(() =>
  import("../components/ProductIntroduction").then((module) => ({ default: module.ProductIntroduction }))
);
const ViewingDesk = lazy(() =>
  import("../components/ViewingDesk").then((module) => ({ default: module.ViewingDesk }))
);
const loadAgentWorkspace = () =>
  import("../components/AgentWorkspace").then((module) => ({ default: module.AgentWorkspace }));
const AgentWorkspace = lazy(loadAgentWorkspace);

export function preloadAgentWorkspace(): Promise<unknown> {
  return loadAgentWorkspace();
}
const KnowledgeGraph = lazy(() =>
  import("../components/KnowledgeGraph").then((module) => ({ default: module.KnowledgeGraph }))
);
const TopicExplorer = lazy(() =>
  import("../components/TopicExplorer").then((module) => ({ default: module.TopicExplorer }))
);

type EntityFavoriteHandler = (
  entity: { type: TopicType; value: string; label: string },
  favorite: boolean
) => void;

type AppContentProps = {
  contentMode: ContentMode;
  query: MediaQuery;
  facets?: FacetsResponse;
  metadataLanguage: MetadataLanguage;
  mediaItems: MediaItem[];
  total: number;
  pageLabel: string;
  isLoading: boolean;
  isRefreshing: boolean;
  isViewPending: boolean;
  motionDirection: "backward" | "forward" | "neutral";
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  viewMode: "grid" | "reel";
  onChangeQuery: (patch: Partial<MediaQuery>) => void;
  onChangeContentMode: (mode: ContentMode) => void;
  onOpenMedia: (item: MediaItem, queue?: MediaItem[]) => void;
  onPlayMedia: (item: MediaItem, queue?: MediaItem[]) => void;
  onOpenMediaById: (id: string) => void;
  onOpenEntity: (entity: ActiveEntity) => void;
  onOpenFavorites: () => void;
  onOpenPlaylists: (playlistId?: string) => void;
  onToggleFavorite: (item: MediaItem, favorite: boolean) => void;
  onToggleEntityFavorite: EntityFavoriteHandler;
  onExitReel: () => void;
  onLoadMore: () => void;
  containedWallScroll: boolean;
  wallScrollResetKey: string;
  agentEntryContext: AgentEntryContext | null;
  onClearAgentEntryContext: () => void;
};

const pageFallback = <Skeleton active className="topic-page-skeleton" />;

export function AppContent({
  contentMode,
  query,
  facets,
  metadataLanguage,
  mediaItems,
  total,
  pageLabel,
  isLoading,
  isRefreshing,
  isViewPending,
  motionDirection,
  isFetchingNextPage,
  hasNextPage,
  viewMode,
  onChangeQuery,
  onChangeContentMode,
  onOpenMedia,
  onPlayMedia,
  onOpenMediaById,
  onOpenEntity,
  onOpenFavorites,
  onOpenPlaylists,
  onToggleFavorite,
  onToggleEntityFavorite,
  onExitReel,
  onLoadMore,
  containedWallScroll,
  wallScrollResetKey,
  agentEntryContext,
  onClearAgentEntryContext
}: AppContentProps) {
  useLocale();
  return (
    <>
      {contentMode === "wall" && (
        <FilterActiveStrip
          query={query}
          metadataLanguage={metadataLanguage}
          actors={facets?.actors ?? []}
          genres={facets?.genres ?? []}
          directors={facets?.directors ?? []}
          makers={facets?.makers ?? []}
          labels={facets?.labels ?? []}
          metadataSeries={facets?.metadataSeries ?? []}
          onChange={onChangeQuery}
        />
      )}
      <MotionSurface
        className="content-motion-surface"
        direction={motionDirection}
        motionKey={contentMode}
        pending={isViewPending}
      >
        {contentMode === "intro" ? (
          <Suspense fallback={pageFallback}>
            <ProductIntroduction
              onEnterLibrary={() => onChangeContentMode("wall")}
              onOpenCurator={() => onChangeContentMode("agent")}
              onOpenEntity={onOpenEntity}
              onOpenMedia={onOpenMedia}
              onOpenMine={() => onChangeContentMode("home")}
              onOpenTopics={() => onChangeContentMode("topics")}
              onOpenViewingDesk={() => onChangeContentMode("viewing")}
            />
          </Suspense>
        ) : contentMode === "analytics" ? (
          <Suspense fallback={pageFallback}>
            <LibraryAnalyticsDashboard
              onBack={() => onChangeContentMode("home")}
              onOpenEntity={onOpenEntity}
              onOpenMedia={onOpenMedia}
            />
          </Suspense>
        ) : contentMode === "home" ? (
          <Suspense fallback={pageFallback}>
            <HomeDashboard
              onOpen={onOpenMedia}
              onOpenEntity={onOpenEntity}
              onOpenFavorites={onOpenFavorites}
              onOpenLibraryAnalytics={() => onChangeContentMode("analytics")}
              onOpenPlaylists={onOpenPlaylists}
              onPlay={onPlayMedia}
            />
          </Suspense>
        ) : contentMode === "viewing" ? (
          <Suspense fallback={pageFallback}>
            <ViewingDesk
              metadataLanguage={metadataLanguage}
              onOpenMedia={onOpenMedia}
              onPlay={onPlayMedia}
            />
          </Suspense>
        ) : contentMode === "agent" ? (
          <Suspense fallback={pageFallback}>
            <AgentWorkspace
              onOpenEntity={onOpenEntity}
              onOpenMedia={onOpenMediaById}
              onOpenViewingDesk={() => onChangeContentMode("viewing")}
              entryContext={agentEntryContext}
              onClearEntryContext={onClearAgentEntryContext}
            />
          </Suspense>
        ) : contentMode === "graph" ? (
          <Suspense fallback={pageFallback}>
            <KnowledgeGraph
              metadataLanguage={metadataLanguage}
              onBack={() => onChangeContentMode("topics")}
              onOpenEntity={onOpenEntity}
              onOpenMedia={onOpenMedia}
              onToggleFavorite={onToggleEntityFavorite}
            />
          </Suspense>
        ) : contentMode === "topics" ? (
          <Suspense fallback={pageFallback}>
            <TopicExplorer
              onOpenEntity={onOpenEntity}
              onOpenGraph={() => onChangeContentMode("graph")}
              onToggleFavorite={onToggleEntityFavorite}
            />
          </Suspense>
        ) : (
          <MediaWall
            items={mediaItems}
            total={total}
            loaded={mediaItems.length}
            isFetchingNextPage={isFetchingNextPage}
            isRefreshing={isRefreshing}
            hasNextPage={hasNextPage}
            containedScroll={containedWallScroll}
            headerAction={(
              <Button
                className="topic-entry-button desktop-topic-entry motion-pressable"
                icon={<House size={15} />}
                onClick={() => onChangeContentMode("home")}
                size="small"
              >
                {t("我的")} </Button>
            )}
            isLoading={isLoading}
            minimumColumns={containedWallScroll ? 3 : 2}
            metadataLanguage={metadataLanguage}
            onOpen={onOpenMedia}
            onPlay={onPlayMedia}
            onExitReel={onExitReel}
            onToggleFavorite={onToggleFavorite}
            onLoadMore={onLoadMore}
            viewMode={viewMode}
            pageLabel={pageLabel}
            scrollResetKey={wallScrollResetKey}
          />
        )}
      </MotionSurface>
    </>
  );
}
