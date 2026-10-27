import { getIntlLocale } from "../i18n/core";
import { t } from "../i18n/core";
import {
  recommendationFeedbackResponseSchema,
  type MetadataQualityIssueContract
} from "../../../server/src/contracts/platform";

import { requestJson } from "./http";
export * from "../features/agent/api";

export type MediaType = "video" | "image";

export type MediaItem = {
  id: string;
  libraryCategory: string;
  sourceName: string;
  relativePath: string;
  name: string;
  basename: string;
  extension: string;
  mimeType: string;
  size: number;
  mtimeMs: number;
  directory: string;
  firstLetter: string;
  collectionBucket: string;
  codePrefix: string;
  codeNumber: string;
  normalizedCode: string;
  variantTags: string;
  qualityTag: string;
  mediaType: MediaType;
  durationSeconds: number | null;
  width?: number | null;
  height?: number | null;
  containerFormat?: string;
  videoCodec?: string;
  audioCodec?: string;
  compatibilityStatus?: "unknown" | "native" | "remux" | "transcode" | "unsupported";
  probeStatus?: "pending" | "queued" | "ready" | "failed";
  probeError?: string | null;
  versionCount?: number;
  thumbnailStatus: "pending" | "ready" | "failed" | "unsupported";
  indexedAt: string;
  ingestedAt?: string;
  ingestionDay?: string;
  ingestionDayCount?: number;
  isFavorite: boolean;
  playback: PlaybackProgress | null;
  metadata: MediaMetadata | null;
  recommendationReason?: string;
};

export type PlaybackProgress = {
  positionSeconds: number;
  durationSeconds: number | null;
  completed: boolean;
  playCount: number;
  lastPlayedAt: string;
};

export type MediaMetadata = {
  status: "pending" | "fetching" | "ready" | "not_found" | "failed" | "skipped" | string;
  title: string;
  summary?: string;
  director?: string;
  actors: string[];
  genres: string[];
  maker?: string;
  label?: string;
  series?: string;
  titleZh: string;
  summaryZh?: string;
  directorZh?: string;
  actorsZh: string[];
  genresZh: string[];
  makerZh?: string;
  labelZh?: string;
  seriesZh?: string;
  translationStatus: string;
  translatedAt?: string | null;
  releaseDate?: string | null;
  runtimeMinutes?: number | null;
  score?: number | null;
  provider?: string;
  source?: string;
  fetchedAt?: string | null;
  updatedAt?: string | null;
  completeness?: number;
  confidence?: number;
  qualityScore?: number;
  durationConflict?: boolean;
  durationDeltaMinutes?: number | null;
  issues?: MetadataQualityIssueContract[];
  homepage?: string;
  coverUrl?: string;
  thumbUrl?: string;
  previewVideoUrl?: string;
  previewVideoHlsUrl?: string;
  previewImages?: string[];
};

export type MediaSidecar = {
  id: string;
  kind: "subtitle" | "metadata";
  relativePath: string;
  language: string;
  label: string;
  format: string;
  size: number;
  mtimeMs: number;
  isTranslated?: boolean;
  trackUrl?: string;
  rawUrl?: string;
};

export type SubtitleTranslationStatus = "pending" | "running" | "ready" | "failed" | "cancelled";
export type SubtitleTranslationPipelineStepStatus = "pending" | "active" | "complete" | "skipped" | "failed" | "cancelled";

export type SubtitleTranslationPipelineStep = {
  key: "queued" | "source" | "extracting" | "transcribing" | "translating" | "writing";
  label: string;
  status: SubtitleTranslationPipelineStepStatus;
};

export type SubtitleTranslation = {
  mediaId: string;
  mediaJobId: string;
  status: SubtitleTranslationStatus;
  stage: "queued" | "source" | "extracting" | "transcribing" | "translating" | "writing" | "ready" | "failed" | "cancelled";
  progress: number;
  stageProgress: number;
  stageStartedAt: string | null;
  elapsedSeconds: number;
  stageElapsedSeconds: number;
  estimatedRemainingSeconds: number | null;
  estimateConfidence: "calculating" | "low" | "medium" | "high";
  pipelineSteps: SubtitleTranslationPipelineStep[];
  sourceKind: string;
  sourceSidecarId: string | null;
  sourceLanguage: string;
  targetLanguage: string;
  outputPath: string;
  bytes: number;
  cueCount: number;
  translatedCueCount: number;
  provider: string;
  model: string;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
};

export type SubtitleTranslationListItem = SubtitleTranslation & {
  normalizedCode: string;
  basename: string;
  sourceName: string;
  durationSeconds: number | null;
};

export type TranslationCapabilities = {
  provider: string;
  contextualTranslation: boolean;
  contextualTranslationModel: string;
  asrCorrection: boolean;
  asrCorrectionModel: string;
  dedicatedTranslation: boolean;
  dedicatedTranslationModel: string;
  targetLanguage: string;
  translationRequestBatchSize: number;
  translationRequestConcurrency: number;
  contextualTranslationBatchSize: number;
  asrCorrectionStrategy: "integrated" | "standalone";
  whisperAvailable: boolean;
  whisperCommand: string;
  whisperModel: string;
  whisperBackend: "whisper-cpp" | "openai" | "unavailable";
  preferredWhisperBackend: "auto" | "whisper-cpp" | "openai";
  whisperThreads: number;
  whisperCppAvailable: boolean;
  whisperCppMetal: boolean;
  whisperCppVadAvailable: boolean;
  openAiWhisperAvailable: boolean;
  maxConcurrentTranslations: number;
  pausesForPlayback: boolean;
  autoTranslateFavorites: boolean;
  favoriteBacklogCount: number;
  priorityBacklogCount: number;
  priorityBacklog: {
    total: number;
    mediaFavorites: number;
    topicFavorites: number;
    actorFavorites: number;
    library: number;
  };
  externalStorageRequired: boolean;
  externalStorageReady: boolean;
  externalStorageMessage: string | null;
};

export type SubtitleTranslationListResponse = {
  items: SubtitleTranslationListItem[];
  total: number;
  page: number;
  pageSize: number;
  counts: Partial<Record<SubtitleTranslationStatus, number>>;
  capabilities: TranslationCapabilities;
};

export type MediaDerivativeInfo = {
  kind: "poster" | "remux" | "hls";
  variant: string;
  status: "pending" | "ready" | "failed";
  bytes: number;
  error: string | null;
  updatedAt: string;
};

export type MediaDetailResponse = {
  item: MediaItem;
  versions: MediaItem[];
  sidecars: MediaSidecar[];
  derivatives: MediaDerivativeInfo[];
  translation: SubtitleTranslation | null;
};

export type SavedFilter = {
  id: string;
  name: string;
  query: Partial<MediaQuery>;
  createdAt?: string;
  updatedAt: string;
};

export type TopicType = "actor" | "series" | "genre" | "prefix" | "director" | "maker" | "label";

export type ViewingDeskPresetId = "quick" | "explore" | "favorites" | "unwatched";
export type ViewingDeskLaneId = "core" | "adjacent" | "wildcard";
export type ViewingDeskSignal = {
  type: "actor" | "series" | "genre" | "director" | "maker" | "label";
  value: string;
  score: number;
};

export type ViewingDeskPreset = {
  id: ViewingDeskPresetId;
  label: string;
  description: string;
  durationMinutes: number;
};

export type ViewingDeskConfig = {
  preset: ViewingDeskPresetId;
  durationMinutes: number;
  category: "ALL" | "JAV" | "FC2";
  excludeRecentlyWatched: boolean;
  favoriteBias: boolean;
  limit: number;
  preferredGenre?: string;
  preferredActor?: string;
  preferredSeries?: string;
  preferredDirector?: string;
  preferredMaker?: string;
  preferredLabel?: string;
  preferredGenreLabel?: string;
  preferredActorLabel?: string;
  preferredSeriesLabel?: string;
  preferredDirectorLabel?: string;
  preferredMakerLabel?: string;
  preferredLabelLabel?: string;
  focusLane?: ViewingDeskLaneId;
};

export type ViewingDeskSessionItem = {
  mediaId: string;
  position: number;
  lane: ViewingDeskLaneId;
  reason: string;
  score: number;
  feedback: "" | "like" | "dislike" | "skip";
  media: MediaItem;
};

export type ViewingDeskSession = {
  id: string;
  preset: ViewingDeskPresetId;
  config: ViewingDeskConfig;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  items: ViewingDeskSessionItem[];
  arena: {
    rounds: Array<{
      roundIndex: number;
      leftMediaId: string;
      rightMediaId: string;
      winnerMediaId: string | null;
      decision: "" | "choose" | "both" | "reject" | "reroll" | "skip" | "neutral";
      strategy: string;
      strategyLabel: string;
      prompt: string;
      left: MediaItem;
      right: MediaItem;
    }>;
    completed: boolean;
    answered: number;
    total: number;
    canBranch: boolean;
    profile: {
      positiveSignals: ViewingDeskSignal[];
      negativeSignals: ViewingDeskSignal[];
      confidence: number;
      diversity: number;
      decidedRounds: number;
      lastImpact: {
        action: "choose" | "both" | "reject" | "skip" | "neutral";
        positiveSignals: ViewingDeskSignal[];
        negativeSignals: ViewingDeskSignal[];
      } | null;
    };
  };
  lanes: Array<{
    id: ViewingDeskLaneId;
    label: string;
    description: string;
    count: number;
  }>;
  summary: {
    total: number;
    unwatched: number;
    favoriteMatches: number;
    estimatedMinutes: number;
    queueMinutes?: number;
  };
};

export type ViewingDeskBootstrap = {
  coldStart: boolean;
  realSignalCount: number;
  exitThreshold: number;
  signals: Array<{
    id: "browse" | "favorite" | "pace";
    label: string;
    value: string;
    simulated: boolean;
  }>;
  items: MediaItem[];
  summary: {
    total: number;
    unwatched: number;
    favoriteMatches: number;
  };
};

export type ViewingDeskResponse = {
  session: ViewingDeskSession | null;
  presets: ViewingDeskPreset[];
  bootstrap: ViewingDeskBootstrap;
};

export type ViewingDeskSessionSummary = {
  id: string;
  preset: ViewingDeskPresetId;
  config: ViewingDeskConfig;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  summary: {
    total: number;
    liked: number;
    hidden: number;
    estimatedMinutes: number;
  };
};

export type KnowledgeGraphNodeType = Exclude<TopicType, "prefix">;

export type KnowledgeGraphNode = {
  id: string;
  type: KnowledgeGraphNodeType;
  value: string;
  label: string;
  aliases: string[];
  mediaCount: number;
  isFavorite: boolean;
  degree: number;
  mediaId: string | null;
  coverKind: "manual" | "representative" | "none";
  latestReleaseDate: string | null;
};

export type KnowledgeGraphEdge = {
  id: string;
  source: string;
  target: string;
  weight: number;
  sharedCount: number;
  sourceCount: number;
  targetCount: number;
  affinity: number;
  strength: number;
  relationType?: string;
  relationLabel?: string;
};

export type KnowledgeGraphYearBucket = {
  year: number;
  count: number;
};

export type KnowledgeGraphData = {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  summary: {
    nodeCount: number;
    edgeCount: number;
    mediaConnections: number;
    types: Array<{ type: KnowledgeGraphNodeType; count: number }>;
  };
  generatedAt: string;
  yearDistribution?: KnowledgeGraphYearBucket[];
};

export type KnowledgeGraphPageInfo = {
  nextCursor: string | null;
  hasMore: boolean;
  total?: number;
};

export type KnowledgeGraphNeighborsResponse = {
  source?: KnowledgeGraphNode;
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  pageInfo?: KnowledgeGraphPageInfo;
  pagination?: KnowledgeGraphPageInfo;
  yearDistribution?: KnowledgeGraphYearBucket[];
};

export type KnowledgeGraphPathResponse = {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  found?: boolean;
  path?: string[];
  summary?: {
    hopCount: number | null;
    visitedNodeCount: number;
    maxDepth?: number;
    truncated?: boolean;
  };
};

export type KnowledgeGraphConnectionResponse = {
  items: MediaItem[];
  pageInfo?: KnowledgeGraphPageInfo;
  pagination?: KnowledgeGraphPageInfo;
  total?: number;
  relationType?: string;
  relationLabel?: string;
};

export type TopicListItem = {
  value: string;
  label: string;
  aliases?: string[];
  mediaCount: number;
  latestReleaseDate: string | null;
  mediaId: string | null;
  customCoverMediaId?: string | null;
  isFavorite: boolean;
};

export type TopicOverviewResponse = {
  dimensions: Array<{
    type: TopicType;
    label: string;
    entityCount: number;
    mediaCount: number;
    profileCoverage?: {
      total: number;
      enriched: number;
      verified: number;
      autoMatched: number;
      autoResolved: number;
      noMatch: number;
      failed: number;
      pending: number;
      coveragePercent: number;
      withBirthDate: number;
      withHeight: number;
      withMeasurements: number;
      withBiography: number;
      withImage: number;
      withWikipedia: number;
      withOfficialWebsite: number;
      withStructuredFacts: number;
    };
    highlights: TopicListItem[];
  }>;
};

export type TopicListResponse = {
  type: TopicType;
  label: string;
  items: TopicListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type TopicRelatedItem = {
  value: string;
  label: string;
  mediaCount: number;
  isFavorite: boolean;
};

export type EntityResponse = {
  entity: {
    type: TopicType;
    typeLabel: string;
    value: string;
    label: string;
    aliases: string[];
    isFavorite: boolean;
    description: string;
    mediaCount: number;
    latestReleaseDate: string | null;
    insights: {
      mediaCount: number;
      firstReleaseDate: string | null;
      latestReleaseDate: string | null;
      releaseYearCount: number;
      totalRuntimeMinutes: number;
      averageRuntimeMinutes: number | null;
      averageScore: number | null;
      scoredMediaCount: number;
      yearDistribution: Array<{ year: string; mediaCount: number }>;
      related: Record<Exclude<TopicType, "prefix">, Array<{ value: string; mediaCount: number }>>;
    };
    customCoverMediaId: string | null;
    makers: string[];
    genres: string[];
    related: Record<TopicType, TopicRelatedItem[]>;
  };
  profile: {
    type: string;
    value: string;
    displayName: string;
    originalName?: string;
    names: Record<string, string>;
    aliases: string[];
    biography: string;
    birthDate: string | null;
    birthplace: string;
    nationality: string;
    heightCm: number | null;
    measurements: { bustCm?: number; waistCm?: number; hipsCm?: number; cup?: string };
    facts: Record<string, string | string[]>;
    occupations: string[];
    imageUrl: string;
    imageAttribution?: {
      fileName: string;
      sourceUrl: string;
      creator: string;
      creatorUrl?: string;
      license: string;
      licenseUrl: string;
      rightsStatus?: "open-license" | "public-domain" | "restricted" | "unknown";
      credit?: string;
      attributionText?: string;
      pageId?: number;
      sha1?: string;
      fileTimestamp?: string;
      attributionRequired?: boolean;
      copyrighted?: boolean;
      permissionSummary?: string;
      originalUrl?: string;
      contentType?: string;
      originalWidth?: number;
      originalHeight?: number;
      originalSizeBytes?: number;
      requestedThumbWidth?: number;
      thumbWidth?: number;
      thumbHeight?: number;
    } | null;
    officialWebsite: string;
    socialLinks: Record<string, string>;
    externalIds: Record<string, string>;
    wikidataId: string;
    wikipediaUrl: string;
    status: "verified" | "auto-matched" | "auto-resolved" | "unverified";
    confidence: number;
    fetchedAt: string | null;
    updatedAt: string;
    sources: Array<{
      provider: string;
      title: string;
      url: string;
      license: string;
      language: string;
      fields: string[];
      confidence: number;
      retrievedAt: string;
      facts?: Record<string, unknown> & {
        heightCm?: number | null;
        measurements?: { bustCm?: number; waistCm?: number; hipsCm?: number; cup?: string };
        birthDate?: string | null;
        image?: {
          fileName: string;
          sourceUrl: string;
          creator: string;
          creatorUrl?: string;
          license: string;
          licenseUrl: string;
          credit?: string;
          attributionText?: string;
          pageId?: number;
          sha1?: string;
          fileTimestamp?: string;
          attributionRequired?: boolean;
          copyrighted?: boolean;
          permissionSummary?: string;
          originalUrl?: string;
          contentType?: string;
          originalWidth?: number;
          originalHeight?: number;
          originalSizeBytes?: number;
          requestedThumbWidth?: number;
          thumbWidth?: number;
          thumbHeight?: number;
        };
      };
    }>;
  } | null;
  items: MediaItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type EntityActorCard = {
  requestedValue: string;
  entity: Pick<EntityResponse["entity"], "value" | "label" | "aliases" | "mediaCount" | "customCoverMediaId">;
  profile: EntityResponse["profile"];
};

export type MetadataQualityResponse = {
  counts: {
    unmatched: number;
    missingCover: number;
    translation: number;
    duplicate: number;
    missingProbe: number;
    compatibility: number;
  };
  indexedIssues?: Array<{
    type: string;
    severity: "info" | "warning" | "error";
    count: number;
  }>;
  items: Array<{
    normalizedCode: string;
    status: string;
    title: string;
    titleZh: string;
    translationStatus: string;
    coverUrl: string;
    thumbUrl: string;
    error: string | null;
    qualityIssue?: string;
    qualitySeverity?: "info" | "warning" | "error";
    qualityDetails?: string;
    mediaCount: number;
    mediaId: string | null;
  }>;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type CompatibilityResponse = {
  items: Array<{
    id: string;
    normalizedCode: string;
    name: string;
    extension: string;
    size: number;
    durationSeconds: number | null;
    width: number | null;
    height: number | null;
    containerFormat: string;
    videoCodec: string;
    audioCodec: string;
    compatibilityStatus: string;
    probeStatus: string;
    probeError: string | null;
  }>;
  counts: Array<{ status: string; count: number }>;
  jobs: {
    running: boolean;
    probeToolAvailable?: boolean;
    ffmpegToolAvailable?: boolean;
    counts: Array<{ jobType: string; status: string; count: number }>;
  };
  total: number;
  page: number;
  pageSize: number;
};

export type PlaybackSourceResponse = {
  compatibilityStatus: string;
  probeStatus: string;
  sourceAvailable: boolean;
  preferred: "source" | "remux" | "hls";
  url: string;
  remuxReady: boolean;
  hlsReady: boolean;
  derivatives: Record<"remux" | "hls", {
    status: "missing" | "pending" | "ready" | "failed";
    failureReason: "source_unavailable" | "ffmpeg_unavailable" | "preparation_failed" | null;
  }>;
};

export type MediaResponse = {
  items: MediaItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  nextCursor?: string | null;
};

export type Facet = {
  value: string;
  valueZh?: string;
  count: number;
  mediaId?: string;
  imageUrl?: string;
};

export type ScanSummary = {
  roots?: Array<{ name: string; root: string; indexed: number }>;
  root?: string;
  indexed: number;
  sidecars?: number;
  removed: number;
  startedAt: string;
  finishedAt: string;
};

export type LibraryPathEntry = {
  key: string;
  label: string;
  path: string;
  exists: boolean;
  readable?: boolean;
  state?: "ready" | "missing" | "permission-denied" | "not-directory" | "unavailable";
  mountPoint?: string | null;
  errorCode?: string | null;
  message?: string;
};

export type LibrarySourceEntry = {
  category: string;
  name: string;
  root: string;
  exists: boolean;
  readable?: boolean;
  state?: "ready" | "missing" | "permission-denied" | "not-directory" | "unavailable";
  mountPoint?: string | null;
  errorCode?: string | null;
  message?: string;
};

export type LibraryPathsResponse = {
  roots: LibraryPathEntry[];
  mediaSources: LibrarySourceEntry[];
  configPath: string;
  updatedAt: string | null;
  scanning?: boolean;
};

export type IngestionSettingsResponse = {
  enabled: boolean;
  persistedEnabled: boolean;
  workerRunning: boolean;
  runtimeMode: "local-pc" | "nas";
  clientMode: "web" | "android";
  canManageIngestion: boolean;
  canTriggerScan: boolean;
  disabledReason: string | null;
  scheduleTime: string;
  timezone: string;
  stableMinutes: number;
  updatedAt: string;
  sources: Array<{
    id: "primary" | "secondary";
    label: string;
    downloadRoot: string;
    libraryRootIndex: number;
    libraryRoot: string;
    enabled: boolean;
    updatedAt: string;
  }>;
};

export type RuntimeCapabilitiesResponse = {
  runtimeMode: "local-pc" | "nas";
  clientMode: "web" | "android";
  canManageIngestion: boolean;
  canTriggerScan: boolean;
  disabledReason: string | null;
};

export type IngestionRun = {
  id: string;
  triggerType: "manual" | "scheduled";
  status: string;
  phase: string;
  limitCount: number | null;
  statsJson: string;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
};

export type IngestionNotification = {
  id: string;
  readAt: string | null;
  createdAt: string;
  mediaId: string | null;
  normalizedCode: string;
  category: string;
  sourceId: string;
  metadataStatus: string;
  translationStatus: string;
  runStatus: string;
  title: string;
  actors: string[];
};

export type FavoritesResponse = {
  items: string[];
  mediaItems: FavoriteMediaItem[];
  entities: FavoriteEntity[];
  count: number;
  totalCount: number;
  counts: Record<"media" | TopicType, number>;
  filePath: string;
};

export type UserProfileStats = {
  favoriteCount: number;
  entityFavoriteCount: number;
  playlistCount: number;
  playlistItemCount: number;
  watchCount: number;
  inProgressCount: number;
  completedCount: number;
  savedFilterCount: number;
  viewingSessionCount: number;
};

export type UserProfile = {
  id: string;
  name: string;
  kind: "persistent" | "guest";
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string | null;
  stats: UserProfileStats;
};

export type UsersResponse = {
  activeUser: UserProfile;
  users: UserProfile[];
};

export type FavoriteMediaItem = {
  id: string;
  relativePath: string;
  basename: string;
  normalizedCode: string;
  title: string;
  titleZh: string;
};

export type FavoriteEntity = {
  type: TopicType;
  value: string;
  label: string;
  createdAt: string;
};

export type FavoriteTopicItem = FavoriteEntity & TopicListItem;

export function fetchFavoriteTopics(type: TopicType): Promise<{ items: FavoriteTopicItem[] }> {
  return requestJson(`/api/favorites/topics/${type}`, { cache: "no-store" });
}

export type FavoriteUpdateResponse = FavoritesResponse & {
  relativePath: string;
  favorite: boolean;
};

export type EntityFavoriteUpdateResponse = FavoritesResponse & {
  entity: FavoriteEntity & { favorite: boolean };
};

export type FacetsResponse = {
  letters: Facet[];
  extensions: Facet[];
  mediaTypes: Facet[];
  categories: Facet[];
  sources: Facet[];
  prefixes: Facet[];
  buckets: Facet[];
  quality: Facet[];
  tags: Facet[];
  actors: Facet[];
  genres: Facet[];
  directors: Facet[];
  makers: Facet[];
  labels: Facet[];
  metadataSeries: Facet[];
  totals: {
    count: number;
    totalSize: number;
  };
  scanning: boolean;
  latestScan: ScanSummary | null;
};

export type MetadataRunSummary = {
  enabled: boolean;
  configured: boolean;
  provider: string;
  reason: string;
  requested: number;
  processed: number;
  ready: number;
  notFound: number;
  failed: number;
  skipped: number;
  startedAt: string;
  finishedAt: string;
  message?: string;
  category?: string | null;
  excel?: {
    path: string;
    rows: number;
    exportedAt: string;
  };
};

export type MetadataStatusResponse = {
  enabled: boolean;
  configured: boolean;
  provider: string;
  serverUrl: string | null;
  excelPath: string;
  categoryFilter: string | null;
  running: boolean;
  latestRun: MetadataRunSummary | null;
  stats: {
    eligible: number;
    cached: number;
    pending: number;
    fetching: number;
    ready: number;
    notFound: number;
    failed: number;
    skipped: number;
  };
  categoryStats: Array<{
    category: string;
    eligible: number;
    pending: number;
    fetching: number;
    ready: number;
    notFound: number;
    failed: number;
    skipped: number;
  }>;
};

export type MetadataEnrichResponse = {
  summary: MetadataRunSummary;
  results?: Array<{
    normalizedCode: string;
    status: string;
    error: string | null;
    attempts: number;
    updatedAt: string;
  }>;
  status: MetadataStatusResponse;
};

export type MetadataItem = {
  normalizedCode: string;
  status: string;
  title: string;
  director: string;
  actors: string[];
  genres: string[];
  maker: string;
  label: string;
  series: string;
  titleZh: string;
  summaryZh: string;
  directorZh: string;
  actorsZh: string[];
  genresZh: string[];
  makerZh: string;
  labelZh: string;
  seriesZh: string;
  translationStatus: string;
  translationError: string | null;
  translatedAt: string | null;
  releaseDate: string | null;
  runtimeMinutes: number | null;
  provider: string;
  homepage: string;
  coverUrl: string;
  thumbUrl: string;
  error: string | null;
  attempts: number;
  updatedAt: string;
  mediaId: string | null;
  mediaBasename: string | null;
  mediaRelativePath: string | null;
  originalBasename: string | null;
  originalRelativePath: string | null;
  mediaCount: number;
};

export type RenameMetadataMediaResponse = {
  id: string;
  oldName: string;
  newName: string;
  oldRelativePath: string;
  newRelativePath: string;
  normalizedCode: string;
  targetDirectory: string;
  metadataRefreshAccepted: boolean;
};

export type RemoveMetadataMediaResponse = {
  id: string;
  name: string;
  oldRelativePath: string;
  destinationPath: string;
  destinationDirectory: string;
  normalizedCode: string;
};

export type MetadataItemsResponse = {
  items: MetadataItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  stats: Record<string, number>;
};

export type SearchSuggestionType = "code" | "actor" | "maker" | "genre";

export type SearchSuggestion = {
  type: SearchSuggestionType;
  value: string;
  label: string;
  subtitle: string;
  count: number;
  mediaId: string | null;
};

export type SearchSuggestionsResponse = {
  codes: SearchSuggestion[];
  actors: SearchSuggestion[];
  makers: SearchSuggestion[];
  genres: SearchSuggestion[];
};

export type RecommendationsResponse = {
  items: MediaItem[];
};

export type HealthSummaryResponse = {
  ok: boolean;
  totals: {
    count: number;
    totalSize: number;
    totalDurationSeconds: number;
  };
  categories: Array<{ value: string; count: number; totalSize: number }>;
  mediaTypes: Facet[];
  metadata: {
    total: number;
    ready: number;
    statuses: Facet[];
  };
  thumbnails: {
    statuses: Facet[];
    cache: { exists: boolean; files: number; bytes: number };
  };
  covers: {
    cache: { exists: boolean; files: number; bytes: number };
  };
  playback: {
    count: number;
    completed: number;
    inProgress: number;
    lastPlayedAt: string | null;
  };
  favorites: {
    count: number;
    path: string;
  };
  cache: {
    mediaEntries: number;
    facetEntries: number;
    warmupRunning: boolean;
  };
  storage: {
    dataDir: string;
    databasePath: string;
    databaseBytes: number;
    metadataSeedPath: string;
    metadataSeedBytes: number;
  };
  library: {
    sources: Array<{
      category: string;
      name: string;
      root: string;
      exists: boolean;
      readable: boolean;
      state: "ready" | "missing" | "permission-denied" | "not-directory" | "unavailable";
      message: string;
    }>;
    availability: {
      mode: "connected" | "partial" | "solid-state-only";
      connectedSources: number;
      totalSources: number;
      connectedSourceNames: string[];
      videoPlaybackAvailable: boolean;
      message: string;
    };
  };
  scanning: boolean;
  latestScan: ScanSummary | null;
};

export type MediaQuery = {
  q: string;
  letter: string;
  extension: string;
  prefix: string;
  category: string;
  bucket: string;
  source: string;
  tag: string;
  actor: string[];
  genre: string[];
  director: string[];
  maker: string[];
  label: string[];
  metadataSeries: string[];
  mediaType: "ALL" | MediaType;
  favoriteOnly: boolean;
  playbackState?: "ALL" | "history" | "inProgress" | "completed";
  groupVersions: boolean;
  pagination?: "offset" | "cursor";
  cursor?: string;
  page: number;
  pageSize: number;
  sort: "name" | "mtime" | "size" | "random" | "recentPlayed" | "progress";
  direction: "asc" | "desc";
  randomSeed?: number;
};

export function getStreamUrl(id: string): string {
  return `/api/media/${id}/stream`;
}

export function getThumbnailUrl(id: string): string {
  return `/api/media/${id}/thumbnail`;
}

export function getPosterUrl(id: string, size: "card" | "detail" = "card"): string {
  return `/api/media/${id}/poster?size=${size}&v=20261027-hd2`;
}

function appendListFilter(params: URLSearchParams, key: string, value: string[] | undefined): void {
  for (const item of value ?? []) {
    if (item && item !== "ALL") params.append(key, item);
  }
}

function appendFilterParams(params: URLSearchParams, query: Partial<MediaQuery>): void {
  if (query.q) params.set("q", query.q);
  if (query.letter && query.letter !== "ALL") params.set("letter", query.letter);
  if (query.extension && query.extension !== "ALL") params.set("extension", query.extension);
  if (query.prefix && query.prefix !== "ALL") params.set("prefix", query.prefix);
  if (query.category && query.category !== "ALL") params.set("category", query.category);
  if (query.bucket && query.bucket !== "ALL") params.set("bucket", query.bucket);
  if (query.source && query.source !== "ALL") params.set("source", query.source);
  if (query.tag && query.tag !== "ALL") params.set("tag", query.tag);
  appendListFilter(params, "actor", query.actor);
  appendListFilter(params, "genre", query.genre);
  appendListFilter(params, "director", query.director);
  appendListFilter(params, "maker", query.maker);
  appendListFilter(params, "label", query.label);
  appendListFilter(params, "metadataSeries", query.metadataSeries);
  if (query.mediaType && query.mediaType !== "ALL") params.set("mediaType", query.mediaType);
  if (query.favoriteOnly) params.set("favoriteOnly", "true");
  if (query.playbackState && query.playbackState !== "ALL") params.set("playbackState", query.playbackState);
  if (query.groupVersions === false) params.set("groupVersions", "false");
}

export function fetchMedia(query: MediaQuery): Promise<MediaResponse> {
  const params = new URLSearchParams();
  params.set("page", String(query.page));
  params.set("pageSize", String(query.pageSize));
  params.set("sort", query.sort);
  params.set("direction", query.direction);
  if (query.pagination) params.set("pagination", query.pagination);
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.randomSeed) params.set("randomSeed", String(query.randomSeed));

  appendFilterParams(params, query);

  return requestJson<MediaResponse>(`/api/media?${params.toString()}`);
}

export function fetchFacets(query?: Partial<MediaQuery>): Promise<FacetsResponse> {
  const params = new URLSearchParams();

  if (query) appendFilterParams(params, query);

  const suffix = params.toString();
  return requestJson<FacetsResponse>(`/api/media/facets${suffix ? `?${suffix}` : ""}`);
}

export function fetchSearchSuggestions(
  q: string,
  limit = 8
): Promise<SearchSuggestionsResponse> {
  const params = new URLSearchParams();
  params.set("q", q);
  params.set("limit", String(limit));
  return requestJson<SearchSuggestionsResponse>(`/api/search/suggestions?${params.toString()}`);
}

export type RecommendationSort = "relevance" | "recent" | "name" | "random";
export type RecommendationMode = "mixed" | "actor" | "series" | "genre";

export function fetchRecommendations(
  id: string,
  options: { limit?: number; sort?: RecommendationSort; mode?: RecommendationMode; randomSeed?: number } = {}
): Promise<RecommendationsResponse> {
  const params = new URLSearchParams();
  params.set("limit", String(options.limit ?? 12));
  params.set("sort", options.sort ?? "relevance");
  params.set("mode", options.mode ?? "mixed");
  if (options.randomSeed != null) params.set("randomSeed", String(options.randomSeed));
  return requestJson<RecommendationsResponse>(`/api/media/${id}/recommendations?${params.toString()}`);
}

export function setRecommendationFeedback(anchorId: string, mediaId: string): Promise<{
  anchorMediaId: string;
  mediaId: string;
  feedbackType: "not_interested";
  createdAt: string;
}> {
  return requestJson<unknown>(`/api/media/${anchorId}/recommendation-feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mediaId, feedbackType: "not_interested" })
  }).then((response) => recommendationFeedbackResponseSchema.parse(response));
}

export function clearRecommendationFeedback(anchorId: string, mediaId: string): Promise<void> {
  return requestJson<void>(`/api/media/${anchorId}/recommendation-feedback/${mediaId}`, {
    method: "DELETE"
  });
}

export function fetchMediaDetail(id: string): Promise<MediaDetailResponse> {
  return requestJson<MediaDetailResponse>(`/api/media/${id}/detail`);
}

export function fetchSubtitleTranslations(options: {
  status?: "ALL" | SubtitleTranslationStatus;
  page?: number;
  pageSize?: number;
} = {}): Promise<SubtitleTranslationListResponse> {
  const params = new URLSearchParams({
    status: options.status ?? "ALL",
    page: String(options.page ?? 1),
    pageSize: String(options.pageSize ?? 30)
  });
  return requestJson<SubtitleTranslationListResponse>(`/api/translations?${params.toString()}`, { cache: "no-store" });
}

export function updateSubtitleTranslationSettings(input: {
  autoTranslateFavorites: boolean;
}): Promise<{ capabilities: TranslationCapabilities }> {
  return requestJson<{ capabilities: TranslationCapabilities }>("/api/translations/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
}

export function requestSubtitleTranslation(id: string): Promise<SubtitleTranslation> {
  return requestJson<SubtitleTranslation>(`/api/media/${id}/translation`, { method: "POST" });
}

export function retrySubtitleTranslation(id: string): Promise<SubtitleTranslation> {
  return requestJson<SubtitleTranslation>(`/api/translations/${id}/retry`, { method: "POST" });
}

export function retranslateSubtitleTranslation(id: string): Promise<SubtitleTranslation> {
  return requestJson<SubtitleTranslation>(`/api/translations/${id}/retranslate`, { method: "POST" });
}

export function removeSubtitleTranslation(id: string): Promise<{ action: "cancelled" | "cancelling" | "removed" }> {
  return requestJson<{ action: "cancelled" | "cancelling" | "removed" }>(`/api/translations/${id}`, { method: "DELETE" });
}

export function fetchSavedFilters(): Promise<{ items: SavedFilter[] }> {
  return requestJson<{ items: SavedFilter[] }>("/api/saved-filters");
}

export function createSavedFilter(name: string, query: Partial<MediaQuery>): Promise<SavedFilter> {
  return requestJson<SavedFilter>("/api/saved-filters", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, query })
  });
}

export function updateSavedFilter(id: string, name: string, query: Partial<MediaQuery>): Promise<SavedFilter> {
  return requestJson<SavedFilter>(`/api/saved-filters/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, query })
  });
}

export function deleteSavedFilter(id: string): Promise<void> {
  return requestJson<void>(`/api/saved-filters/${id}`, { method: "DELETE" });
}

export function fetchTopicOverview(): Promise<TopicOverviewResponse> {
  return requestJson<TopicOverviewResponse>("/api/topics");
}

export function fetchTopicItems(options: {
  type: TopicType;
  q?: string;
  sort?: "count" | "count-asc" | "name" | "latest" | "random";
  randomSeed?: number;
  page?: number;
  pageSize?: number;
}): Promise<TopicListResponse> {
  const params = new URLSearchParams();
  params.set("q", options.q ?? "");
  params.set("sort", options.sort ?? "count");
  if (options.randomSeed != null) params.set("randomSeed", String(options.randomSeed));
  params.set("page", String(options.page ?? 1));
  params.set("pageSize", String(options.pageSize ?? 36));
  return requestJson<TopicListResponse>(`/api/topics/${options.type}?${params.toString()}`, { cache: "no-store" });
}

export function fetchEntity(
  type: TopicType,
  value: string,
  options: {
    page?: number;
    pageSize?: number;
    sort?: "release" | "added" | "name" | "duration" | "size" | "random";
    randomSeed?: number;
    soloOnly?: boolean;
  } = {}
): Promise<EntityResponse> {
  const params = new URLSearchParams();
  params.set("page", String(options.page ?? 1));
  params.set("pageSize", String(options.pageSize ?? 36));
  params.set("sort", options.sort ?? "release");
  if (type === "actor") params.set("soloOnly", String(options.soloOnly ?? false));
  if (options.randomSeed != null) params.set("randomSeed", String(options.randomSeed));
  return requestJson<EntityResponse>(`/api/entities/${type}/${encodeURIComponent(value)}?${params.toString()}`, {
    cache: "no-store"
  });
}

export function fetchActorCards(values: string[]): Promise<{ items: EntityActorCard[] }> {
  const params = new URLSearchParams();
  values.forEach((value) => params.append("value", value));
  return requestJson<{ items: EntityActorCard[] }>(`/api/entities/actor-cards?${params.toString()}`);
}

export function setTopicCover(type: TopicType, value: string, mediaId: string): Promise<{
  type: TopicType;
  value: string;
  mediaId: string;
  updatedAt: string;
}> {
  return requestJson(`/api/entities/${type}/${encodeURIComponent(value)}/cover`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mediaId })
  });
}

export function clearTopicCover(type: TopicType, value: string): Promise<void> {
  return requestJson(`/api/entities/${type}/${encodeURIComponent(value)}/cover`, { method: "DELETE" });
}

export function fetchMetadataQuality(options: {
  issue?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<MetadataQualityResponse> {
  const params = new URLSearchParams();
  params.set("issue", options.issue ?? "all");
  params.set("page", String(options.page ?? 1));
  params.set("pageSize", String(options.pageSize ?? 48));
  return requestJson<MetadataQualityResponse>(`/api/metadata/quality?${params.toString()}`);
}

export function updateMetadataOverride(
  code: string,
  patch: Record<string, unknown>
): Promise<{ normalizedCode: string; patch: Record<string, unknown>; updatedAt: string }> {
  return requestJson(`/api/metadata/${encodeURIComponent(code)}/override`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch)
  });
}

export function fetchCompatibility(options: {
  status?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<CompatibilityResponse> {
  const params = new URLSearchParams();
  params.set("status", options.status ?? "ALL");
  params.set("page", String(options.page ?? 1));
  params.set("pageSize", String(options.pageSize ?? 48));
  return requestJson<CompatibilityResponse>(`/api/compatibility?${params.toString()}`);
}

export function requestCompatibilityAction(
  id: string,
  action: "probe" | "remux" | "hls"
): Promise<{ jobId: string; action: string }> {
  return requestJson(`/api/media/${id}/compatibility`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action })
  });
}

export function fetchPlaybackSource(id: string): Promise<PlaybackSourceResponse> {
  return requestJson<PlaybackSourceResponse>(`/api/media/${id}/playback-source`);
}

export function fetchHealthSummary(): Promise<HealthSummaryResponse> {
  return requestJson<HealthSummaryResponse>("/api/health/summary");
}

export function requestScan(): Promise<ScanSummary> {
  return requestJson<ScanSummary>("/api/scan", { method: "POST" });
}

export function fetchMetadataStatus(): Promise<MetadataStatusResponse> {
  return requestJson<MetadataStatusResponse>("/api/metadata/status");
}

export function fetchMetadataItems(query: {
  q?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}): Promise<MetadataItemsResponse> {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.status && query.status !== "ALL") params.set("status", query.status);
  params.set("page", String(query.page ?? 1));
  params.set("pageSize", String(query.pageSize ?? 30));
  return requestJson<MetadataItemsResponse>(`/api/metadata/items?${params.toString()}`);
}

export function requestMetadataEnrich(options?: {
  force?: boolean;
  limit?: number;
  category?: string;
  codes?: string[];
  async?: boolean;
}): Promise<MetadataEnrichResponse> {
  return requestJson<MetadataEnrichResponse>("/api/metadata/enrich", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options ?? {})
  });
}

export function renameMetadataMedia(id: string, basename: string): Promise<RenameMetadataMediaResponse> {
  return requestJson<RenameMetadataMediaResponse>(`/api/metadata/media/${id}/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ basename })
  });
}

export function removeMetadataMedia(id: string): Promise<RemoveMetadataMediaResponse> {
  return requestJson<RemoveMetadataMediaResponse>(`/api/metadata/media/${id}/remove`, {
    method: "POST"
  });
}

export function updatePlaybackProgress(
  id: string,
  payload: {
    positionSeconds: number;
    durationSeconds?: number | null;
    completed?: boolean;
    started?: boolean;
  }
): Promise<{ id: string; relativePath: string; playback: PlaybackProgress | null }> {
  return requestJson<{ id: string; relativePath: string; playback: PlaybackProgress | null }>(`/api/media/${id}/progress`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export function deletePlaybackProgress(id: string): Promise<void> {
  return requestJson<void>(`/api/media/${id}/progress`, { method: "DELETE" });
}

export function fetchLibraryPaths(): Promise<LibraryPathsResponse> {
  return requestJson<LibraryPathsResponse>("/api/settings/library-paths");
}

export function updateLibraryPaths(roots: [string, string]): Promise<LibraryPathsResponse> {
  return requestJson<LibraryPathsResponse>("/api/settings/library-paths", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roots })
  });
}

export function fetchIngestionSettings(): Promise<IngestionSettingsResponse> {
  return requestJson<IngestionSettingsResponse>("/api/ingestion/settings", { cache: "no-store" });
}

export function fetchRuntimeCapabilities(): Promise<RuntimeCapabilitiesResponse> {
  return requestJson<RuntimeCapabilitiesResponse>("/api/runtime-capabilities", { cache: "no-store" });
}

export function updateIngestionSettings(input: {
  enabled: boolean;
  scheduleTime: string;
  sources: Array<{ id: "primary" | "secondary"; downloadRoot: string; enabled: boolean }>;
}): Promise<IngestionSettingsResponse> {
  return requestJson<IngestionSettingsResponse>("/api/ingestion/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
}

export function triggerIngestionRun(limit?: number): Promise<{ id: string; status: string; limit: number | null }> {
  return requestJson("/api/ingestion/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(limit ? { limit } : {})
  });
}

export function fetchIngestionRuns(): Promise<{ items: IngestionRun[] }> {
  return requestJson("/api/ingestion/runs?limit=20", { cache: "no-store" });
}

export function fetchNotifications(): Promise<{ items: IngestionNotification[] }> {
  return requestJson("/api/notifications?limit=100", { cache: "no-store" });
}

export function fetchNotificationUnreadCount(): Promise<{ count: number; latestCreatedAt: string | null }> {
  return requestJson("/api/notifications/unread-count", { cache: "no-store" });
}

export function markNotificationRead(id: string): Promise<{ ok: boolean }> {
  return requestJson(`/api/notifications/${encodeURIComponent(id)}/read`, { method: "PATCH" });
}

export function markAllNotificationsRead(): Promise<{ updated: number }> {
  return requestJson("/api/notifications/read-all", { method: "POST" });
}

export function fetchFavorites(): Promise<FavoritesResponse> {
  return requestJson<FavoritesResponse>("/api/favorites", { cache: "no-store" });
}

export function fetchViewingDeskSession(): Promise<ViewingDeskResponse> {
  return requestJson<ViewingDeskResponse>("/api/viewing-desk/session", { cache: "no-store" });
}

export function generateViewingDeskSession(config: ViewingDeskConfig): Promise<ViewingDeskResponse> {
  return requestJson<ViewingDeskResponse>("/api/viewing-desk/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config)
  });
}

export function fetchViewingDeskSessions(limit = 8): Promise<{ sessions: ViewingDeskSessionSummary[] }> {
  return requestJson(`/api/viewing-desk/sessions?limit=${limit}`, { cache: "no-store" });
}

export function fetchViewingDeskSessionById(id: string): Promise<{ session: ViewingDeskSession }> {
  return requestJson(`/api/viewing-desk/session/${encodeURIComponent(id)}`, { cache: "no-store" });
}

export function deleteViewingDeskSession(id: string): Promise<{
  deletedId: string;
  session: ViewingDeskSession | null;
}> {
  return requestJson(`/api/viewing-desk/session/${encodeURIComponent(id)}`, {
    method: "DELETE",
    cache: "no-store"
  });
}

export function submitViewingDeskFeedback(input: {
  sessionId: string;
  mediaId: string;
  feedback: "like" | "dislike" | "skip" | "clear";
}): Promise<{ session: ViewingDeskSession }> {
  return requestJson(`/api/viewing-desk/session/${encodeURIComponent(input.sessionId)}/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mediaId: input.mediaId, feedback: input.feedback })
  });
}

export function submitViewingDeskArenaChoice(input: {
  sessionId: string;
  roundIndex: number;
  action?: "choose" | "both" | "reject" | "reroll" | "skip" | "neutral";
  winnerMediaId?: string;
}): Promise<{ session: ViewingDeskSession }> {
  return requestJson(`/api/viewing-desk/session/${encodeURIComponent(input.sessionId)}/arena`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roundIndex: input.roundIndex, action: input.action ?? "choose", winnerMediaId: input.winnerMediaId })
  });
}

export function branchViewingDeskSession(input: {
  sessionId: string;
  lane: ViewingDeskLaneId;
}): Promise<{ session: ViewingDeskSession }> {
  return requestJson(`/api/viewing-desk/session/${encodeURIComponent(input.sessionId)}/branch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lane: input.lane })
  });
}

export function fetchKnowledgeGraph(options: {
  types: KnowledgeGraphNodeType[];
  q?: string;
  limit?: number;
  minShared?: number;
  category?: "ALL" | "JAV" | "FC2";
  hideGeneric?: boolean;
  yearFrom?: number;
  yearTo?: number;
}): Promise<KnowledgeGraphData> {
  const params = new URLSearchParams({ types: options.types.join(",") });
  if (options.q) params.set("q", options.q);
  if (options.limit) params.set("limit", String(options.limit));
  if (options.minShared) params.set("minShared", String(options.minShared));
  if (options.category) params.set("category", options.category);
  if (options.hideGeneric != null) params.set("hideGeneric", String(options.hideGeneric));
  if (options.yearFrom) params.set("yearFrom", String(options.yearFrom));
  if (options.yearTo) params.set("yearTo", String(options.yearTo));
  return requestJson<KnowledgeGraphData>(`/api/knowledge-graph?${params.toString()}`);
}

export function fetchKnowledgeGraphConnection(options: {
  sourceType: KnowledgeGraphNodeType;
  sourceValue: string;
  targetType: KnowledgeGraphNodeType;
  targetValue: string;
  category?: "ALL" | "JAV" | "FC2";
  limit?: number;
  cursor?: string;
  yearFrom?: number;
  yearTo?: number;
  minShared?: number;
}): Promise<KnowledgeGraphConnectionResponse> {
  const params = new URLSearchParams({
    sourceType: options.sourceType,
    sourceValue: options.sourceValue,
    targetType: options.targetType,
    targetValue: options.targetValue,
    category: options.category ?? "ALL",
    limit: String(options.limit ?? 6)
  });
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.yearFrom) params.set("yearFrom", String(options.yearFrom));
  if (options.yearTo) params.set("yearTo", String(options.yearTo));
  if (options.minShared) params.set("minShared", String(options.minShared));
  return requestJson<KnowledgeGraphConnectionResponse>(`/api/knowledge-graph/connection?${params.toString()}`);
}

export function fetchKnowledgeGraphNeighbors(options: {
  sourceType: KnowledgeGraphNodeType;
  sourceValue: string;
  targetTypes: KnowledgeGraphNodeType[];
  category?: "ALL" | "JAV" | "FC2";
  limit?: number;
  minShared?: number;
  cursor?: string;
  yearFrom?: number;
  yearTo?: number;
}): Promise<KnowledgeGraphNeighborsResponse> {
  const params = new URLSearchParams({
    sourceType: options.sourceType,
    sourceValue: options.sourceValue,
    targetTypes: options.targetTypes.join(","),
    category: options.category ?? "ALL",
    limit: String(options.limit ?? 24),
    minShared: String(options.minShared ?? 1)
  });
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.yearFrom) params.set("yearFrom", String(options.yearFrom));
  if (options.yearTo) params.set("yearTo", String(options.yearTo));
  return requestJson<KnowledgeGraphNeighborsResponse>(`/api/knowledge-graph/neighbors?${params.toString()}`);
}

export function fetchKnowledgeGraphPath(options: {
  sourceType: KnowledgeGraphNodeType;
  sourceValue: string;
  targetType: KnowledgeGraphNodeType;
  targetValue: string;
  category?: "ALL" | "JAV" | "FC2";
  maxDepth?: number;
  yearFrom?: number;
  yearTo?: number;
  minShared?: number;
}): Promise<KnowledgeGraphPathResponse> {
  const params = new URLSearchParams({
    sourceType: options.sourceType,
    sourceValue: options.sourceValue,
    targetType: options.targetType,
    targetValue: options.targetValue,
    category: options.category ?? "ALL",
    maxDepth: String(options.maxDepth ?? 6)
  });
  if (options.yearFrom) params.set("yearFrom", String(options.yearFrom));
  if (options.yearTo) params.set("yearTo", String(options.yearTo));
  if (options.minShared) params.set("minShared", String(options.minShared));
  return requestJson<KnowledgeGraphPathResponse>(`/api/knowledge-graph/path?${params.toString()}`);
}

export function updateFavorite(
  relativePath: string,
  favorite: boolean
): Promise<FavoriteUpdateResponse> {
  return requestJson<FavoriteUpdateResponse>("/api/favorites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ relativePath, favorite })
  });
}

export function updateEntityFavorite(input: {
  type: TopicType;
  value: string;
  label?: string;
  favorite: boolean;
}): Promise<EntityFavoriteUpdateResponse> {
  return requestJson<EntityFavoriteUpdateResponse>("/api/favorites/entities", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
}

export function fetchUsers(): Promise<UsersResponse> {
  return requestJson<UsersResponse>("/api/users", { cache: "no-store" });
}

export function createUser(name: string): Promise<UserProfile> {
  return requestJson<UserProfile>("/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name })
  });
}

export function startGuestSession(): Promise<UserProfile> {
  return requestJson<UserProfile>("/api/users/guest", { method: "POST" });
}

export function activateUser(id: string): Promise<UserProfile> {
  return requestJson<UserProfile>(`/api/users/${encodeURIComponent(id)}/activate`, { method: "POST" });
}

export function renameUser(id: string, name: string): Promise<UserProfile> {
  return requestJson<UserProfile>(`/api/users/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name })
  });
}

export function deleteUser(id: string): Promise<void> {
  return requestJson<void>(`/api/users/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function getFavoritesExportUrl(): string {
  return "/api/favorites/export";
}

export function formatBytes(value: number): string {
  if (value === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** exponent;
  return `${amount.toFixed(amount >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function formatDate(value: number): string {
  return new Intl.DateTimeFormat(getIntlLocale(), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));
}

export function formatDuration(value: number | null): string {
  if (!value || !Number.isFinite(value) || value <= 0) return t("时长未知");

  const totalSeconds = Math.round(value);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function parseVariantTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
