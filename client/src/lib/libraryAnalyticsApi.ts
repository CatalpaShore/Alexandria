import type {PrefixAnalytics} from "../../../server/src/libraryPrefixAnalytics";
import type {PrefixTotal} from "../../../server/src/libraryPrefixTotals";
import type { TopicType } from "./api";
import { jsonRequest, requestJson } from "./http";

export const fetchPrefixTotals=()=>requestJson<PrefixTotal[]>('/api/library-analytics/prefix-totals',{cache:'no-store'});
export const updatePrefixTotal=(prefix:string,total:number|null)=>requestJson<PrefixTotal[]>(`/api/library-analytics/prefix-totals/${encodeURIComponent(prefix)}`,jsonRequest('PUT',{total}));

export type LibraryAnalyticsFacetType = Extract<TopicType, "actor" | "genre" | "series" | "maker" | "label" | "director">;
export type LibraryAnalyticsSection = "overview" | "time" | "content" | "technical" | "operations" | "quality" | "details";
export type LibraryAnalyticsContentMode = "actors" | "entities" | "relations" | "prefixes";

export type LibraryAnalyticsContract = {
  version: string;
  workIdentity: string;
  releaseDateField: string;
  generatedAt: string;
  metrics: Array<{
    key: string;
    label: string;
    grain: string;
    definition: string;
    denominator: string;
    source: string;
  }>;
};

export type LibraryAnalyticsDistribution = {
  key: string;
  label: string;
  files: number;
  works: number;
  bytes: number;
};

export type LibraryAnalyticsFacetItem = {
  value: string;
  label: string;
  works: number;
  files: number;
  bytes: number;
  averageScore: number;
  scoredWorks: number;
  averageRuntimeMinutes: number;
  latestReleaseDate: string | null;
};

export type LibraryAnalyticsYearMetric = {
  year: number;
  files: number;
  works: number;
  bytes: number;
  durationSeconds: number;
  averageFileBytes: number;
  fourKFiles: number;
  fullHdFiles: number;
  probedFiles: number;
  readyMetadataWorks: number;
  scoredWorks: number;
  averageScore: number;
  workGrowthRate: number | null;
  metadataCoverage: number;
  fourKShare: number;
  fullHdShare: number;
  probeCoverage: number;
  variantRate: number;
};

export type LibraryAnalyticsMatrix = {
  rows: Array<{ key: string; label: string }>;
  columns: Array<{ key: string; label: string }>;
  cells: Array<{ rowKey: string; columnKey: string; works: number }>;
};

export type LibraryActorSummary = {
  value: string;
  canonicalValue?: string;
  label: string;
  aliases?: string[];
  works: number;
  firstReleaseDate: string | null;
  lastReleaseDate: string | null;
  activeYears: number;
  scoredWorks: number;
  averageScore: number;
};

export type LibraryActorAnalytics = {
  scope: {
    totalWorks: number;
    actorCoveredWorks: number;
    actorCoverage: number;
    excludedFc2Works: number;
    validActors: number;
    assignments: number;
    invalidActors: number;
    invalidAssignments: number;
  };
  workBands: Array<{
    key: string;
    label: string;
    actors: number;
    assignments: number;
    actorShare: number;
    assignmentShare: number;
  }>;
  castSizeBands: Array<{ key: string; label: string; works: number }>;
  activity: {
    years: number[];
    actors: LibraryActorSummary[];
    cells: Array<{ actorValue: string; year: number; works: number; share: number }>;
  };
  genreAffinity: {
    actors: LibraryActorSummary[];
    genres: Array<{ value: string; label: string; aliases: string[]; group: string; works: number; globalShare: number }>;
    cells: Array<{
      actorValue: string;
      genreValue: string;
      works: number;
      actorShare: number;
      globalShare: number;
      lift: number;
      smoothedLift: number;
      expectedWorks: number;
      confidence: number;
      stable: boolean;
      recentWorks: number;
      previousWorks: number;
    }>;
  };
  score: {
    globalAverage: number;
    points: Array<{
      value: string;
      label: string;
      works: number;
      scoredWorks: number;
      averageScore: number;
      adjustedScore: number;
      averageRuntimeMinutes: number;
      latestReleaseDate: string | null;
    }>;
  };
  collaboration: {
    actors: LibraryActorSummary[];
    pairs: Array<{
      source: string;
      target: string;
      sourceLabel: string;
      targetLabel: string;
      works: number;
    }>;
  };
  profileCompleteness: Array<{ key: string; label: string; value: number; total: number; rate: number }>;
  coverageByYear: Array<{ year: string; works: number; actorWorks: number; rate: number }>;
  coverageByProvider: Array<{ key: string; label: string; works: number; actorWorks: number; rate: number; applicable: boolean }>;
};

export type LibraryCrossMatrixMember = {
  key: string;
  label: string;
  aliases: string[];
  value: number;
  group?: string;
};

export type LibraryCrossMatrixCell = {
  rowKey: string;
  columnKey: string;
  value: number;
  rowShare: number;
  columnShare: number;
  globalShare: number;
  lift: number;
  smoothedLift: number;
  expectedValue: number;
  confidence: number;
  stable: boolean;
  recentValue: number;
  previousValue: number;
};

export type LibraryCrossMatrix = {
  id: string;
  title: string;
  subtitle: string;
  rowDimension: LibraryAnalyticsFacetType | "source" | "provider";
  columnDimension: LibraryAnalyticsFacetType | "year" | "resolution" | "compatibility" | "field";
  grain: "works" | "files";
  total: number;
  rows: LibraryCrossMatrixMember[];
  columns: LibraryCrossMatrixMember[];
  cells: LibraryCrossMatrixCell[];
};

export type LibraryAnalyticsJobType = {
  key: string;
  label: string;
  total: number;
  ready: number;
  failed: number;
  pending: number;
  running: number;
  cancelled: number;
  successRate: number;
  averageDurationSeconds: number;
  latestUpdatedAt: string | null;
};

export type LibraryAnalyticsPipelineStage = {
  key: string;
  label: string;
  grain: string;
  total: number;
  ready: number;
  failed: number;
  pending: number;
  running: number;
  cancelled: number;
  bytes: number;
  latestUpdatedAt: string | null;
};

export type LibraryAnalyticsIngestionRun = {
  id: string;
  status: string;
  phase: string;
  triggerType: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  durationSeconds: number;
  scanned: number;
  eligible: number;
  moved: number;
  unstable: number;
  rejected: number;
  conflicts: number;
  failed: number;
  previewsQueued: number;
  previewsReady: number;
  actorsDiscovered: number;
  error: string;
};

export type LibraryAnalyticsData = {
  prefixAnalytics:PrefixAnalytics;
  contract: LibraryAnalyticsContract;
  scope: {
    year: number | null;
    label: string;
    dateField: "release_date";
    generatedAt: string;
  };
  freshness: {
    indexedAt: string | null;
    metadataUpdatedAt: string | null;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
  };
  summary: {
    files: number;
    works: number;
    variants: number;
    totalBytes: number;
    totalDurationSeconds: number;
    averageFileBytes: number;
    averageDurationSeconds: number;
    readyMetadataWorks: number;
    recordedMetadataWorks: number;
    translatedWorks: number;
    artworkWorks: number;
    metadataCoverage: number;
    translationCoverage: number;
    artworkCoverage: number;
    variantRate: number;
    nativePlaybackRate: number;
    playbackRiskRate: number;
    fourKShare: number;
    fullHdShare: number;
    earliestReleaseDate: string | null;
    latestReleaseDate: string | null;
    averagePositiveScore: number;
    scoredWorks: number;
  };
  availableYears: Array<{ year: number; works: number }>;
  releaseHistory: Array<{ year: number; works: number }>;
  releaseByMonth: Array<{ month: number; works: number }>;
  releaseHeatmap: Array<{ year: number; month: number; works: number }>;
  yearlyMetrics: LibraryAnalyticsYearMetric[];
  categoryYearTrend: Array<{ year: number; category: string; works: number }>;
  catalogGrowth: Array<{
    day: string;
    files: number;
    works: number;
    bytes: number;
    cumulativeFiles: number;
    cumulativeWorks: number;
    cumulativeBytes: number;
  }>;
  libraryMix: LibraryAnalyticsDistribution[];
  sourceMix: LibraryAnalyticsDistribution[];
  sourceProfiles: Array<{
    key: string;
    label: string;
    files: number;
    works: number;
    bytes: number;
    durationSeconds: number;
    averageFileBytes: number;
    fourKFiles: number;
    fullHdFiles: number;
    nativeFiles: number;
    riskFiles: number;
    probedFiles: number;
    variantRate: number;
  }>;
  facets: Record<LibraryAnalyticsFacetType, {
    distinctValues: number;
    coveredWorks: number;
    totalAssignments: number;
    items: LibraryAnalyticsFacetItem[];
  }>;
  contentMatrix: LibraryAnalyticsMatrix;
  actorAnalytics: LibraryActorAnalytics;
  crossAnalysis: {
    scope: {
      canonicalActors: number;
      canonicalGenres: number;
      rawActors: number;
      rawGenres: number;
      recentWindow: string | null;
      previousWindow: string | null;
    };
    matrices: LibraryCrossMatrix[];
    catalog?: Array<Pick<LibraryCrossMatrix, "id" | "title" | "subtitle" | "grain" | "total">>;
    signals: Array<{
      key: string;
      title: string;
      description: string;
      tone: "orange" | "blue" | "gold" | "green";
      matrixId: string;
      rowKey: string;
      columnKey: string;
      value: number;
    }>;
  };
  technical: {
    resolutions: LibraryAnalyticsDistribution[];
    codecs: LibraryAnalyticsDistribution[];
    containers: LibraryAnalyticsDistribution[];
    audioCodecs: LibraryAnalyticsDistribution[];
    extensions: LibraryAnalyticsDistribution[];
    compatibility: LibraryAnalyticsDistribution[];
    resolutionCodecMatrix: Array<{
      rowKey: string;
      rowLabel: string;
      columnKey: string;
      columnLabel: string;
      files: number;
      bytes: number;
    }>;
    durationBands: Array<{ key: string; label: string; files: number }>;
    fileSizeBands: Array<{ key: string; label: string; files: number; bytes: number }>;
    durationBoxPlots: Array<{
      key: string;
      label: string;
      sampleSize: number;
      minimum: number;
      q1: number;
      median: number;
      q3: number;
      maximum: number;
    }>;
    scoreBands: Array<{ key: string; label: string; works: number }>;
    variantTags: Array<{ tag: string; files: number }>;
    variantBands: Array<{ key: string; label: string; works: number; files: number; extraBytes: number }>;
  };
  dataQuality: {
    coverage: Array<{
      key: string;
      label: string;
      value: number;
      total: number;
      unit: "works" | "files";
      rate: number;
    }>;
    metadataPipeline: Array<{ key: string; label: string; value: number }>;
    metadataStatuses: Array<{ key: string; label: string; works: number }>;
    metadataProviders: Array<{
      key: string;
      provider: string;
      works: number;
      readyWorks: number;
      notFoundWorks: number;
      failedWorks: number;
      translatedWorks: number;
      titleWorks: number;
      artworkWorks: number;
      scoredWorks: number;
      averageScore: number;
      actorWorks: number;
      averageAttempts: number;
      errorWorks: number;
      staleWorks: number;
      oldestUpdatedAt: string | null;
      latestUpdatedAt: string | null;
    }>;
    coverageByReleaseYear: Array<{
      year: string;
      works: number;
      readyWorks: number;
      titleWorks: number;
      translatedWorks: number;
      artworkWorks: number;
      actorWorks: number;
      genreWorks: number;
    }>;
    issues: Array<{ key: string; label: string; severity: string; works: number }>;
    backlog: Array<{
      key: string;
      label: string;
      value: number;
      total: number;
      unit: "works" | "files" | "entities";
      rate: number;
      severity: "info" | "warning" | "error";
      note: string;
    }>;
    facetConcentration: Array<{
      type: LibraryAnalyticsFacetType;
      label: string;
      entities: number;
      singletonEntities: number;
      assignments: number;
      topTenShare: number;
      hhi: number;
    }>;
    indexLagBands: Array<{
      key: string;
      label: string;
      works: number;
      averageDays: number;
    }>;
    exceptionWorks: Array<{
      code: string;
      title: string;
      releaseDate: string | null;
      provider: string;
      status: string;
      translationStatus: string;
      files: number;
      bytes: number;
      issueCount: number;
      issueTypes: Array<{ key: string; label: string }>;
      severity: "warning" | "error";
      missingFieldCount: number;
    }>;
  };
  entityKnowledge: {
    profiles: Array<{
      type: string;
      label: string;
      entities: number;
      profiles: number;
      images: number;
      biographies: number;
      birthDates: number;
      officialWebsites: number;
      averageConfidence: number;
      sources: number;
      sourceProviders: number;
      averageSourceConfidence: number;
      enrichment: Record<string, number>;
    }>;
    actorBirthDecades: Array<{ decade: number; actors: number }>;
  };
  operations: {
    scope: {
      label: string;
      timeField: "updated_at";
      ignoresReleaseYearFilter: true;
    };
    summary: {
      jobs: number;
      readyJobs: number;
      failedJobs: number;
      pendingJobs: number;
      runningJobs: number;
      cancelledJobs: number;
      successRate: number;
      currentAssetFailures: number;
      currentAssetPending: number;
      ingestionRuns: number;
      ingestionMoved: number;
      latestActivityAt: string | null;
    };
    jobTypes: LibraryAnalyticsJobType[];
    jobDaily: Array<{ day: string; ready: number; failed: number; total: number }>;
    pipelineStages: LibraryAnalyticsPipelineStage[];
    recentIngestionRuns: LibraryAnalyticsIngestionRun[];
    ingestionSummary: {
      runs: number;
      completed: number;
      partial: number;
      failed: number;
      manual: number;
      scheduled: number;
      moved: number;
      eligible: number;
      conflicts: number;
      unstable: number;
      previewsQueued: number;
      latestScanned: number;
      latestRunAt: string | null;
    };
    failedJobDetails: Array<{
      id: string;
      jobType: string;
      jobLabel: string;
      mediaId: string;
      code: string;
      status: string;
      attempts: number;
      maxAttempts: number;
      error: string;
      durationSeconds: number;
      createdAt: string;
      updatedAt: string;
    }>;
  };
};

export type LibraryAnalyticsSummary = Pick<LibraryAnalyticsData, "contract" | "scope" | "freshness" | "summary" | "availableYears">;
export type LibraryAnalyticsSectionData = LibraryAnalyticsSummary & Partial<Omit<LibraryAnalyticsData, keyof LibraryAnalyticsSummary>>;

export type LibraryAnalyticsMatrixEvidence = {
  actor: { value: string; label: string; aliases: string[] };
  genre: { value: string; label: string; aliases: string[] };
  total: number;
  datedWorks: number;
  undatedWorks: number;
  recentWorks: number;
  previousWorks: number;
  recentWindow: string | null;
  previousWindow: string | null;
  items: Array<{
    normalizedCode: string;
    releaseDate: string | null;
    releaseYear: number | null;
    period: "recent" | "previous" | "historical" | "undated";
  }>;
};

export function fetchLibraryAnalytics(year: number | null, signal?: AbortSignal, forceRefresh = false): Promise<LibraryAnalyticsData> {
  const params = new URLSearchParams();
  if (year !== null) params.set("year", String(year));
  if (forceRefresh) params.set("refresh", "1");
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return requestJson<LibraryAnalyticsData>(`/api/library-analytics${query}`, { signal });
}

function analyticsQuery(year: number | null, forceRefresh = false, contentMode?: LibraryAnalyticsContentMode, matrixId?: string): string {
  const params = new URLSearchParams();
  if (year !== null) params.set("year", String(year));
  if (forceRefresh) params.set("refresh", "1");
  if (contentMode) params.set("mode", contentMode);
  if (matrixId) params.set("matrix", matrixId);
  return params.size > 0 ? `?${params.toString()}` : "";
}

export function fetchLibraryAnalyticsSummary(year: number | null, signal?: AbortSignal, forceRefresh = false): Promise<LibraryAnalyticsSummary> {
  return requestJson(`/api/library-analytics/summary${analyticsQuery(year, forceRefresh)}`, { signal });
}

export function fetchLibraryAnalyticsSection(section: LibraryAnalyticsSection, year: number | null, signal?: AbortSignal, forceRefresh = false, contentMode?: LibraryAnalyticsContentMode, matrixId?: string): Promise<LibraryAnalyticsSectionData> {
  return requestJson(`/api/library-analytics/sections/${section}${analyticsQuery(year, forceRefresh, contentMode, matrixId)}`, { signal });
}

export function fetchLibraryAnalyticsMatrixEvidence(input: { actor: string; genre: string; year: number | null; limit?: number }, signal?: AbortSignal): Promise<LibraryAnalyticsMatrixEvidence> {
  const params = new URLSearchParams({ actor: input.actor, genre: input.genre, limit: String(input.limit ?? 30) });
  if (input.year !== null) params.set("year", String(input.year));
  return requestJson(`/api/library-analytics/matrix-evidence?${params.toString()}`, { signal });
}
