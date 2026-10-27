import { lazy, Suspense } from "react";
import type { ActiveEntity } from "../hooks/useOverlayState";
import type {
  FavoritesResponse,
  MediaItem,
  MediaQuery,
  TopicType
} from "../lib/api";
import type { MetadataLanguage } from "../lib/metadataDisplay";

const HealthCenterDrawer = lazy(() =>
  import("../components/HealthCenterDrawer").then((module) => ({ default: module.HealthCenterDrawer }))
);
const MediaDetailDrawer = lazy(() =>
  import("../components/MediaDetailDrawer").then((module) => ({ default: module.MediaDetailDrawer }))
);
const MetadataManagerDrawer = lazy(() =>
  import("../components/MetadataManagerDrawer").then((module) => ({ default: module.MetadataManagerDrawer }))
);
const PlayerModal = lazy(() =>
  import("../components/PlayerModal").then((module) => ({ default: module.PlayerModal }))
);
const SavedFiltersDrawer = lazy(() =>
  import("../components/SavedFiltersDrawer").then((module) => ({ default: module.SavedFiltersDrawer }))
);
const EntityDrawer = lazy(() =>
  import("../components/EntityDrawer").then((module) => ({ default: module.EntityDrawer }))
);
const FavoriteCenterDrawer = lazy(() =>
  import("../components/FavoriteCenterDrawer").then((module) => ({ default: module.FavoriteCenterDrawer }))
);
const MetadataQualityDrawer = lazy(() =>
  import("../components/MetadataQualityDrawer").then((module) => ({ default: module.MetadataQualityDrawer }))
);
const CompatibilityCenterDrawer = lazy(() =>
  import("../components/CompatibilityCenterDrawer").then((module) => ({ default: module.CompatibilityCenterDrawer }))
);
const TranslationManagerDrawer = lazy(() =>
  import("../components/TranslationManagerDrawer").then((module) => ({ default: module.TranslationManagerDrawer }))
);
const MaintenanceCenterDrawer = lazy(() =>
  import("../components/MaintenanceCenterDrawer").then((module) => ({ default: module.MaintenanceCenterDrawer }))
);
const BackupCenterDrawer = lazy(() =>
  import("../components/BackupCenterDrawer").then((module) => ({ default: module.BackupCenterDrawer }))
);
const PlaylistDrawer = lazy(() =>
  import("../components/PlaylistDrawer").then((module) => ({ default: module.PlaylistDrawer }))
);
const IngestionSettingsDrawer = lazy(() =>
  import("../components/IngestionSettingsDrawer").then((module) => ({ default: module.IngestionSettingsDrawer }))
);
const NotificationCenterDrawer = lazy(() =>
  import("../components/NotificationCenterDrawer").then((module) => ({ default: module.NotificationCenterDrawer }))
);
const ChangelogDrawer = lazy(() =>
  import("../components/ChangelogDrawer").then((module) => ({ default: module.ChangelogDrawer }))
);
const UserManagerDrawer = lazy(() =>
  import("../components/UserManagerDrawer").then((module) => ({ default: module.UserManagerDrawer }))
);

type EntityFavoriteHandler = (
  entity: { type: TopicType; value: string; label: string },
  favorite: boolean
) => void;

type PlaybackProgressHandler = (
  item: MediaItem,
  payload: {
    positionSeconds: number;
    durationSeconds?: number | null;
    completed?: boolean;
    started?: boolean;
  }
) => void;

export type AppOverlayKey = "metadata" | "health" | "saved" | "quality" | "compatibility" | "translation" | "maintenance" | "backup" | "playlist" | "ingestion" | "notifications" | "changelog" | "users" | "favorites";

function OverlayLoadingFallback() {
  return (
    <div aria-label="正在打开操作面板" aria-live="polite" className="overlay-loading-backdrop" role="status">
      <div className="overlay-loading-card">
        <span aria-hidden="true" className="overlay-loading-indicator" />
        <strong>正在打开</strong>
        <span>载入操作面板与当前数据…</span>
      </div>
    </div>
  );
}

type AppOverlaysProps = {
  selected: MediaItem | null;
  playbackStartSeconds: number | null;
  detailItem: MediaItem | null;
  detailPlaybackQueue: MediaItem[] | null;
  detailNavigationDirection: -1 | 1 | null;
  hasNextDetail: boolean;
  hasPreviousDetail: boolean;
  metadataLanguage: MetadataLanguage;
  query: MediaQuery;
  favorites?: FavoritesResponse;
  favoritesLoading: boolean;
  entity: ActiveEntity | null;
  metadataManagerOpen: boolean;
  healthOpen: boolean;
  savedFiltersOpen: boolean;
  metadataQualityOpen: boolean;
  compatibilityOpen: boolean;
  translationManagerOpen: boolean;
  maintenanceOpen: boolean;
  backupCenterOpen: boolean;
  playlistOpen: boolean;
  playlistInitialId: string | null;
  ingestionSettingsOpen: boolean;
  notificationCenterOpen: boolean;
  changelogOpen: boolean;
  userManagerOpen: boolean;
  favoriteCenterOpen: boolean;
  onClosePlayer: () => void;
  onCloseDetail: () => void;
  onNavigateDetail: (direction: -1 | 1) => void;
  onSelectVersion: (item: MediaItem) => void;
  onPlaybackProgress: PlaybackProgressHandler;
  onToggleFavorite: (item: MediaItem, favorite: boolean) => void;
  onApplyDetailFilter: (patch: Partial<MediaQuery>) => void;
  onOpenEntity: (entity: ActiveEntity | null) => void;
  onOpenMedia: (item: MediaItem, queue?: MediaItem[]) => void;
  onPlayMedia: (item: MediaItem, queue?: MediaItem[], options?: { startSeconds?: number | null }) => void;
  onOpenMediaById: (id: string) => Promise<boolean>;
  onPlayMediaById: (id: string) => void | Promise<void>;
  onRefreshMetadata: (item: MediaItem) => void;
  onAskAgent: (item: MediaItem) => void;
  onApplySavedFilter: (query: Partial<MediaQuery>) => void;
  onRemoveFavorite: (relativePath: string) => void;
  onShowFavoriteMedia: () => void;
  onToggleEntityFavorite: EntityFavoriteHandler;
  onCloseOverlay: (overlay: AppOverlayKey) => void;
};

export function AppOverlays(props: AppOverlaysProps) {
  const close = props.onCloseOverlay;
  const handoffToMedia = async (overlay: AppOverlayKey, id: string) => {
    const opened = await props.onOpenMediaById(id);
    if (!opened) return;
    window.requestAnimationFrame(() => close(overlay));
  };
  return (
    <Suspense fallback={<OverlayLoadingFallback />}>
      {props.selected && <PlayerModal
        initialPositionSeconds={props.playbackStartSeconds}
        item={props.selected}
        metadataLanguage={props.metadataLanguage}
        onClose={props.onClosePlayer}
        onSelectVersion={props.onSelectVersion}
        onProgress={props.onPlaybackProgress}
        onToggleFavorite={props.onToggleFavorite}
      />}
      {props.detailItem && !props.selected && <MediaDetailDrawer
        hasNext={props.hasNextDetail}
        hasPrevious={props.hasPreviousDetail}
        item={props.detailItem}
        navigationDirection={props.detailNavigationDirection}
        metadataLanguage={props.metadataLanguage}
        onApplyFilter={props.onApplyDetailFilter}
        onClose={props.onCloseDetail}
        onNavigate={props.onNavigateDetail}
        onOpenEntity={(entity) => {
          props.onOpenEntity(entity);
          props.onCloseDetail();
        }}
        onOpenRelated={props.onOpenMedia}
        onPlay={(item, options) => props.onPlayMedia(item, props.detailPlaybackQueue ?? undefined, options)}
        onRefreshMetadata={props.onRefreshMetadata}
        onAskAgent={props.onAskAgent}
        onToggleFavorite={props.onToggleFavorite}
        open
      />}
      {props.metadataManagerOpen && <MetadataManagerDrawer
        open
        onClose={() => close("metadata")}
        onPlay={props.onPlayMediaById}
      />}
      {props.healthOpen && <HealthCenterDrawer open onClose={() => close("health")} />}
      {props.savedFiltersOpen && <SavedFiltersDrawer
        onApply={props.onApplySavedFilter}
        onClose={() => close("saved")}
        open
        query={props.query}
      />}
      {props.metadataQualityOpen && <MetadataQualityDrawer open onClose={() => close("quality")} />}
      {props.compatibilityOpen && <CompatibilityCenterDrawer open onClose={() => close("compatibility")} />}
      {props.translationManagerOpen && <TranslationManagerDrawer
        open
        onClose={() => close("translation")}
        onOpenMedia={(id) => {
          void handoffToMedia("translation", id);
        }}
      />}
      {props.maintenanceOpen && <MaintenanceCenterDrawer open onClose={() => close("maintenance")} />}
      {props.backupCenterOpen && <BackupCenterDrawer open onClose={() => close("backup")} />}
      {props.playlistOpen && <PlaylistDrawer
        initialPlaylistId={props.playlistInitialId}
        onClose={() => close("playlist")}
        onOpenMediaById={(id) => void handoffToMedia("playlist", id)}
        open
      />}
      {props.ingestionSettingsOpen && <IngestionSettingsDrawer open onClose={() => close("ingestion")} />}
      {props.notificationCenterOpen && <NotificationCenterDrawer
        open
        onClose={() => close("notifications")}
        onOpenMedia={(id) => {
          void handoffToMedia("notifications", id);
        }}
      />}
      {props.changelogOpen && <ChangelogDrawer open onClose={() => close("changelog")} />}
      {props.userManagerOpen && <UserManagerDrawer open onClose={() => close("users")} />}
      {props.favoriteCenterOpen && <FavoriteCenterDrawer
        data={props.favorites}
        metadataLanguage={props.metadataLanguage}
        loading={props.favoritesLoading}
        onClose={() => close("favorites")}
        onOpenEntity={(entity) => {
          props.onOpenEntity(entity);
          close("favorites");
        }}
        onRemoveMedia={props.onRemoveFavorite}
        onPlayMedia={props.onPlayMediaById}
        onOpenMedia={props.onOpenMediaById}
        onShowFavoriteMedia={props.onShowFavoriteMedia}
        onToggleEntityFavorite={props.onToggleEntityFavorite}
        open
      />}
      {props.entity && <EntityDrawer
        key={`${props.entity.type}:${props.entity.value}`}
        entity={props.entity}
        metadataLanguage={props.metadataLanguage}
        onClose={() => props.onOpenEntity(null)}
        onOpenEntity={props.onOpenEntity}
        onOpenMedia={props.onOpenMedia}
        onPlay={props.onPlayMedia}
        onToggleFavorite={props.onToggleEntityFavorite}
      />}
    </Suspense>
  );
}
