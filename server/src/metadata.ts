import { config } from "./config.js";
import { clearMetadataFacetsForCode, db, replaceMetadataFacetsForCode } from "./db.js";
import { exportMetadataWorkbook, type MetadataWorkbookExport } from "./metadataExport.js";

type MetadataRunReason = "scan-complete" | "manual" | "startup";

export type MetadataRunSummary = {
  enabled: boolean;
  configured: boolean;
  provider: string;
  reason: MetadataRunReason;
  requested: number;
  processed: number;
  ready: number;
  notFound: number;
  failed: number;
  skipped: number;
  startedAt: string;
  finishedAt: string;
  category?: string | null;
  message?: string;
  excel?: MetadataWorkbookExport;
};

export type MetadataStatusSummary = {
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
    retryableFailed: number;
    retryableNotFound: number;
    skipped: number;
  }>;
};

type MetadataEnrichmentOptions = {
  force?: boolean;
  preserveReady?: boolean;
  limit?: number;
  category?: string;
  codes?: string[];
  reason?: MetadataRunReason;
  exportWorkbook?: boolean;
};

type MetadataQueueRow = {
  normalizedCode: string;
  status: string;
  attempts: number;
};

type MetadataEndpoint = {
  name: "primary" | "fallback";
  source: string;
  serverUrl: string;
  token: string;
};

type MetaTubeSearchResult = {
  id?: string;
  number?: string;
  title?: string;
  provider?: string;
  homepage?: string;
  thumb_url?: string;
  cover_url?: string;
  score?: number;
  actors?: unknown;
  release_date?: unknown;
};

type MetaTubeMovieInfo = MetaTubeSearchResult & {
  summary?: string;
  director?: string;
  big_thumb_url?: string;
  big_cover_url?: string;
  preview_video_url?: string;
  preview_video_hls_url?: string;
  preview_images?: unknown;
  maker?: string;
  label?: string;
  series?: string;
  genres?: unknown;
  runtime?: number;
};


class MetadataRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetadataRateLimitError";
  }
}

type NormalizedMetadata = {
  normalizedCode: string;
  provider: string;
  providerId: string;
  title: string;
  summary: string;
  director: string;
  actors: string[];
  genres: string[];
  maker: string;
  label: string;
  series: string;
  releaseDate: string | null;
  runtimeMinutes: number | null;
  score: number | null;
  homepage: string;
  thumbUrl: string;
  coverUrl: string;
  previewVideoUrl: string;
  previewVideoHlsUrl: string;
  previewImages: string[];
  source: string;
  raw: unknown;
};

type StoredMetadataRow = {
  normalizedCode: string;
  provider: string;
  providerId: string;
  title: string;
  summary: string;
  director: string;
  actorsJson: string;
  genresJson: string;
  maker: string;
  label: string;
  series: string;
  releaseDate: string | null;
  runtimeMinutes: number | null;
  score: number | null;
  homepage: string;
  thumbUrl: string;
  coverUrl: string;
  previewVideoUrl: string;
  previewVideoHlsUrl: string;
  previewImagesJson: string;
  source: string;
  rawJson: string;
};

let activeMetadataJob: Promise<MetadataRunSummary> | null = null;
let latestRun: MetadataRunSummary | null = null;

const metadataStatements = {
  enqueueMissingCodes: db.prepare(`
    INSERT INTO media_metadata (
      normalized_code,
      source,
      status,
      updated_at
    )
    SELECT DISTINCT
      normalized_code,
      @source,
      'pending',
      @updatedAt
    FROM media_files
    WHERE normalized_code != ''
      AND code_prefix != ''
      AND (@category = '' OR library_category = @category)
    ON CONFLICT(normalized_code) DO NOTHING
  `),
  resetEligibleCodes: db.prepare(`
    UPDATE media_metadata
    SET status = 'pending',
        error = NULL,
        attempts = 0,
        updated_at = @updatedAt
    WHERE normalized_code IN (
      SELECT DISTINCT normalized_code
      FROM media_files
      WHERE normalized_code != ''
        AND code_prefix != ''
        AND (@category = '' OR library_category = @category)
    )
  `),
  recoverInterruptedFetchingCodes: db.prepare(`
    UPDATE media_metadata
    SET status = 'pending',
        attempts = CASE
          WHEN attempts > 0 THEN attempts - 1
          ELSE 0
        END,
        error = 'Recovered interrupted metadata fetch',
        updated_at = @updatedAt
    WHERE status = 'fetching'
      AND (
        @category = ''
        OR normalized_code IN (
          SELECT DISTINCT normalized_code
          FROM media_files
          WHERE normalized_code != ''
            AND code_prefix != ''
            AND library_category = @category
        )
      )
  `),
  selectPendingCodes: db.prepare(`
    SELECT
      normalized_code AS normalizedCode,
      status,
      attempts
    FROM media_metadata
    WHERE (
        status IN ('pending', 'failed')
        OR (@includeNotFoundRetry = 1 AND status = 'not_found')
      )
      AND attempts < @maxAttempts
      AND (
        @category = ''
        OR EXISTS (
          SELECT 1
          FROM media_files
          WHERE media_files.normalized_code = media_metadata.normalized_code
            AND media_files.library_category = @category
        )
      )
    ORDER BY
      CASE status
        WHEN 'pending' THEN 0
        WHEN 'failed' THEN 1
        WHEN 'not_found' THEN 2
        ELSE 3
      END,
      updated_at ASC,
      normalized_code ASC
    LIMIT @limit
  `),
  selectLookupRows: db.prepare(`
    SELECT
      basename,
      name,
      code_prefix AS codePrefix,
      code_number AS codeNumber,
      variant_tags AS variantTags
    FROM media_files
    WHERE normalized_code = @normalizedCode
    ORDER BY mtime_ms DESC, basename ASC
    LIMIT 8
  `),
  selectStoredMetadata: db.prepare(`
    SELECT
      normalized_code AS normalizedCode,
      provider,
      provider_id AS providerId,
      title,
      summary,
      director,
      actors_json AS actorsJson,
      genres_json AS genresJson,
      maker,
      label,
      series,
      release_date AS releaseDate,
      runtime_minutes AS runtimeMinutes,
      score,
      homepage,
      thumb_url AS thumbUrl,
      cover_url AS coverUrl,
      preview_video_url AS previewVideoUrl,
      preview_video_hls_url AS previewVideoHlsUrl,
      preview_images_json AS previewImagesJson,
      source,
      raw_json AS rawJson
    FROM media_metadata
    WHERE normalized_code = @normalizedCode
  `),
  markFetching: db.prepare(`
    UPDATE media_metadata
    SET status = 'fetching',
        attempts = attempts + 1,
        error = NULL,
        updated_at = @updatedAt
    WHERE normalized_code = @normalizedCode
  `),
  markNotFound: db.prepare(`
    UPDATE media_metadata
    SET status = 'not_found',
        error = @error,
        fetched_at = @fetchedAt,
        updated_at = @updatedAt
    WHERE normalized_code = @normalizedCode
  `),
  markFailed: db.prepare(`
    UPDATE media_metadata
    SET status = 'failed',
        error = @error,
        updated_at = @updatedAt
    WHERE normalized_code = @normalizedCode
  `),
  deferRetry: db.prepare(`
    UPDATE media_metadata
    SET status = @status,
        attempts = CASE
          WHEN attempts > 0 THEN attempts - 1
          ELSE 0
        END,
        error = @error,
        updated_at = @updatedAt
    WHERE normalized_code = @normalizedCode
  `),
  syncIngestionItemStatus: db.prepare(`
    UPDATE ingestion_items
    SET metadata_status = COALESCE((
          SELECT status FROM media_metadata WHERE normalized_code = @normalizedCode
        ), metadata_status),
        translation_status = COALESCE((
          SELECT translation_status FROM media_metadata WHERE normalized_code = @normalizedCode
        ), translation_status),
        updated_at = @updatedAt
    WHERE normalized_code = @normalizedCode
  `),
  upsertReady: db.prepare(`
    INSERT INTO media_metadata (
      normalized_code,
      provider,
      provider_id,
      title,
      summary,
      director,
      actors_json,
      genres_json,
      maker,
      label,
      series,
      release_date,
      runtime_minutes,
      score,
      homepage,
      thumb_url,
      cover_url,
      preview_video_url,
      preview_video_hls_url,
      preview_images_json,
      source,
      status,
      error,
      raw_json,
      fetched_at,
      updated_at
    )
    VALUES (
      @normalizedCode,
      @provider,
      @providerId,
      @title,
      @summary,
      @director,
      @actorsJson,
      @genresJson,
      @maker,
      @label,
      @series,
      @releaseDate,
      @runtimeMinutes,
      @score,
      @homepage,
      @thumbUrl,
      @coverUrl,
      @previewVideoUrl,
      @previewVideoHlsUrl,
      @previewImagesJson,
      @source,
      'ready',
      NULL,
      @rawJson,
      @fetchedAt,
      @updatedAt
    )
    ON CONFLICT(normalized_code) DO UPDATE SET
      provider = excluded.provider,
      provider_id = excluded.provider_id,
      title = excluded.title,
      summary = excluded.summary,
      director = excluded.director,
      actors_json = excluded.actors_json,
      genres_json = excluded.genres_json,
      maker = excluded.maker,
      label = excluded.label,
      series = excluded.series,
      release_date = excluded.release_date,
      runtime_minutes = excluded.runtime_minutes,
      score = excluded.score,
      homepage = excluded.homepage,
      thumb_url = excluded.thumb_url,
      cover_url = excluded.cover_url,
      preview_video_url = excluded.preview_video_url,
      preview_video_hls_url = excluded.preview_video_hls_url,
      preview_images_json = excluded.preview_images_json,
      source = excluded.source,
      status = 'ready',
      error = NULL,
      raw_json = excluded.raw_json,
      translation_status = CASE
        WHEN media_metadata.title != excluded.title
          OR media_metadata.summary != excluded.summary
          OR media_metadata.director != excluded.director
          OR media_metadata.actors_json != excluded.actors_json
          OR media_metadata.genres_json != excluded.genres_json
          OR media_metadata.maker != excluded.maker
          OR media_metadata.label != excluded.label
          OR media_metadata.series != excluded.series
        THEN 'pending'
        ELSE media_metadata.translation_status
      END,
      translation_error = CASE
        WHEN media_metadata.title != excluded.title
          OR media_metadata.summary != excluded.summary
          OR media_metadata.director != excluded.director
          OR media_metadata.actors_json != excluded.actors_json
          OR media_metadata.genres_json != excluded.genres_json
          OR media_metadata.maker != excluded.maker
          OR media_metadata.label != excluded.label
          OR media_metadata.series != excluded.series
        THEN NULL
        ELSE media_metadata.translation_error
      END,
      translated_at = CASE
        WHEN media_metadata.title != excluded.title
          OR media_metadata.summary != excluded.summary
          OR media_metadata.director != excluded.director
          OR media_metadata.actors_json != excluded.actors_json
          OR media_metadata.genres_json != excluded.genres_json
          OR media_metadata.maker != excluded.maker
          OR media_metadata.label != excluded.label
          OR media_metadata.series != excluded.series
        THEN NULL
        ELSE media_metadata.translated_at
      END,
      fetched_at = excluded.fetched_at,
      updated_at = excluded.updated_at
  `)
};

function nowIso(): string {
  return new Date().toISOString();
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function compactCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function canonicalCode(value: string): string {
  const compact = compactCode(value).replace(/^FC2PPV(?=\d)/, "FC2");
  const match = compact.match(/^([A-Z][A-Z0-9]*?)(\d+)$/);
  if (!match) return compact;
  return `${match[1]}${String(Number.parseInt(match[2], 10))}`;
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toNumberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of value) {
    const text = toStringValue(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= maxItems) break;
  }

  return result;
}

function parseStringArray(value: string, maxItems: number): string[] {
  try {
    return toStringArray(JSON.parse(value || "[]"), maxItems);
  } catch {
    return [];
  }
}

function parseRawJson(value: string): unknown {
  try {
    return JSON.parse(value || "null");
  } catch {
    return null;
  }
}

function normalizeDate(value: unknown): string | null {
  const text = toStringValue(value);
  if (!text || text.startsWith("0001-") || text.startsWith("0000-")) return null;

  const dateOnly = text.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  return dateOnly ?? null;
}

function normalizeCategory(value: string | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

function normalizeMetadataCode(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeMetadataCodes(values: string[] | undefined): string[] {
  if (!values) return [];

  const seen = new Set<string>();
  const codes: string[] = [];

  for (const value of values) {
    const code = normalizeMetadataCode(value);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }

  return codes;
}

function buildCodeInParams(codes: string[], prefix: string): {
  placeholders: string;
  params: Record<string, string>;
} {
  const params: Record<string, string> = {};
  const placeholders = codes
    .map((code, index) => {
      const key = `${prefix}${index}`;
      params[key] = code;
      return `@${key}`;
    })
    .join(", ");

  return { placeholders, params };
}

function unwrapApiData<T>(payload: unknown): T {
  if (
    payload &&
    typeof payload === "object" &&
    "data" in payload
  ) {
    return (payload as { data: T }).data;
  }

  return payload as T;
}

function buildMetadataHeaders(token = config.metadata.token): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json"
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

async function requestMetadataJson<T>(endpoint: MetadataEndpoint, pathname: string): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(config.metadata.requestTimeoutMs, 45_000));

  try {
    const response = await fetch(`${endpoint.serverUrl}${pathname}`, {
      headers: buildMetadataHeaders(endpoint.token),
      signal: controller.signal
    });

    if (response.status === 404) return null;
    if (response.status === 429) {
      throw new MetadataRateLimitError(`${endpoint.source} ${pathname}: HTTP 429`);
    }
    if (response.status >= 500) {
      throw new MetadataRateLimitError(`${endpoint.source} ${pathname}: HTTP ${response.status}`);
    }
    if (!response.ok) {
      throw new Error(`${endpoint.source} ${pathname}: HTTP ${response.status}`);
    }

    const payload = (await response.json()) as unknown;
    return unwrapApiData<T>(payload);
  } catch (error) {
    if (error instanceof MetadataRateLimitError) throw error;
    throw new Error(`${endpoint.source} ${pathname}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

export function pickBestSearchResult(
  normalizedCode: string,
  results: MetaTubeSearchResult[]
): MetaTubeSearchResult | null {
  if (results.length === 0) return null;

  const target = compactCode(normalizedCode);
  const canonicalTarget = canonicalCode(normalizedCode);
  const exact = results.filter((result) => {
    const number = toStringValue(result.number);
    return compactCode(number) === target || canonicalCode(number) === canonicalTarget;
  });
  // Substring matches can adopt another work (ABP-12 vs ABP-123), or an empty number.
  if (exact.length === 0) return null;

  const providerPriority = new Map([
    ["FANZA", 100],
    ["MGS", 95],
    ["DUGA", 90],
    ["JAVBUS", 60],
    ["JAV321", 50]
  ]);
  return [...exact].sort((left, right) => {
    const leftProvider = providerPriority.get(toStringValue(left.provider).toUpperCase()) ?? 0;
    const rightProvider = providerPriority.get(toStringValue(right.provider).toUpperCase()) ?? 0;
    const leftSignals = Number(Boolean(toStringValue(left.title))) + Number(Boolean(toStringValue(left.cover_url))) +
      Number(Array.isArray(left.actors)) + Number(Boolean(normalizeDate(left.release_date)));
    const rightSignals = Number(Boolean(toStringValue(right.title))) + Number(Boolean(toStringValue(right.cover_url))) +
      Number(Array.isArray(right.actors)) + Number(Boolean(normalizeDate(right.release_date)));
    return rightProvider + rightSignals - leftProvider - leftSignals;
  })[0] ?? null;
}

function normalizeMovieInfo(
  normalizedCode: string,
  result: MetaTubeSearchResult,
  detail: MetaTubeMovieInfo | null,
  endpoint: MetadataEndpoint
): NormalizedMetadata {
  const info = { ...result, ...(detail ?? {}) } as MetaTubeMovieInfo;
  const provider = toStringValue(info.provider || result.provider);
  const providerId = toStringValue(info.id || result.id);
  const thumbUrl = toStringValue(info.big_thumb_url) || toStringValue(info.thumb_url);
  const coverUrl = toStringValue(info.big_cover_url) || toStringValue(info.cover_url);

  return {
    normalizedCode,
    provider,
    providerId,
    title: toStringValue(info.title),
    summary: toStringValue(info.summary),
    director: toStringValue(info.director),
    actors: toStringArray(info.actors, 12),
    genres: toStringArray(info.genres, 18),
    maker: toStringValue(info.maker),
    label: toStringValue(info.label),
    series: toStringValue(info.series),
    releaseDate: normalizeDate(info.release_date),
    runtimeMinutes: toNumberValue(info.runtime),
    score: toNumberValue(info.score),
    homepage: toStringValue(info.homepage),
    thumbUrl,
    coverUrl,
    previewVideoUrl: toStringValue(info.preview_video_url),
    previewVideoHlsUrl: toStringValue(info.preview_video_hls_url),
    // Galleries are derived from the local media file by contentPreviews.ts.
    // Remote preview image arrays remain only inside raw source evidence.
    previewImages: [],
    source: endpoint.source,
    raw: { search: result, detail }
  };
}

function getPrimaryEndpoint(): MetadataEndpoint {
  return {
    name: "primary",
    source: config.metadata.provider,
    serverUrl: config.metadata.serverUrl,
    token: config.metadata.token
  };
}

function getFallbackEndpoint(): MetadataEndpoint | null {
  if (!config.metadata.fallbackServerUrl) return null;

  return {
    name: "fallback",
    source: `${config.metadata.provider}:fallback`,
    serverUrl: config.metadata.fallbackServerUrl,
    token: config.metadata.fallbackToken || config.metadata.token
  };
}

function hasFallbackMetadataProvider(): boolean {
  return Boolean(config.metadata.fallbackServerUrl);
}

const unavailableFc2Providers = new Map<string, { until: number; message: string }>();

async function fetchFc2Metadata(normalizedCode: string, endpoint: MetadataEndpoint): Promise<NormalizedMetadata | null> {
  const id = normalizedCode.match(/^FC2(?:[-_ ]?PPV)?[-_ ]?(\d+)$/i)?.[1];
  if (!id) return null;
  const errors: string[] = [];
  for (const provider of ["FC2", "FC2PPVDB"]) {
    const key = `${endpoint.serverUrl}:${provider}`;
    const unavailable = unavailableFc2Providers.get(key);
    if (unavailable && unavailable.until > Date.now()) {
      errors.push(unavailable.message);
      continue;
    }
    try {
      // These providers accept the stable numeric ID; a general search hides provider errors.
      const detail = await requestMetadataJson<MetaTubeMovieInfo>(endpoint,
        `/v1/movies/${provider}/${id}?lazy=true`);
      if (!detail) continue;
      if (!pickBestSearchResult(normalizedCode, [detail]) || !toStringValue(detail.title)) {
        errors.push(`${provider}: invalid or mismatched metadata for ${normalizedCode}`);
        continue;
      }
      return normalizeMovieInfo(normalizedCode, detail, detail, endpoint);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      if (/HTTP (401|403|429)/.test(message)) {
        unavailableFc2Providers.set(key, {
          until: Date.now() + 5 * 60_000,
          message: `${provider}: ${message.match(/HTTP \d+/)?.[0]} (source cooling down for 5 minutes)`
        });
      }
    }
  }
  if (errors.length) throw new Error(errors.join("; "));
  return null;
}

export async function fetchFromMetaTube(
  normalizedCode: string,
  endpoint = getPrimaryEndpoint()
): Promise<NormalizedMetadata | null> {
  if (/^FC2(?:[-_ ]?PPV)?[-_ ]?\d+$/i.test(normalizedCode)) {
    return fetchFc2Metadata(normalizedCode, endpoint);
  }
  const params = new URLSearchParams({
    q: normalizedCode,
    fallback: "true"
  });
  const searchData = await requestMetadataJson<MetaTubeSearchResult[] | MetaTubeSearchResult>(
    endpoint,
    `/v1/movies/search?${params.toString()}`
  );

  if (!searchData) return null;

  const searchResults = Array.isArray(searchData) ? searchData : [searchData];
  const bestResult = pickBestSearchResult(normalizedCode, searchResults);
  if (!bestResult) return null;

  let metadata: NormalizedMetadata | null = null;
  const candidates = [bestResult, ...searchResults.filter((item) => item !== bestResult &&
    pickBestSearchResult(normalizedCode, [item]))].slice(0, 3);
  for (const result of candidates) {
    const provider = toStringValue(result.provider);
    const providerId = toStringValue(result.id);
    let detail: MetaTubeMovieInfo | null = null;
    if (provider && providerId) {
      detail = await requestMetadataJson<MetaTubeMovieInfo>(endpoint,
        `/v1/movies/${encodeURIComponent(provider)}/${encodeURIComponent(providerId)}?lazy=true`
      ).catch(() => null);
    }
    if (detail && !pickBestSearchResult(normalizedCode, [detail])) detail = null;
    const next = normalizeMovieInfo(normalizedCode, result, detail, endpoint);
    if (!next.title) continue;
    metadata = metadata ? mergeMetadata(metadata, next, true) : next;
    if (metadata.summary && metadata.maker && metadata.releaseDate && metadata.runtimeMinutes) break;
  }
  return metadata;
}

function readStoredMetadata(normalizedCode: string): NormalizedMetadata | null {
  const row = metadataStatements.selectStoredMetadata.get({ normalizedCode }) as StoredMetadataRow | undefined;
  if (!row || (!row.title && !row.providerId)) return null;
  return {
    normalizedCode,
    provider: row.provider,
    providerId: row.providerId,
    title: row.title,
    summary: row.summary,
    director: row.director,
    actors: parseStringArray(row.actorsJson, 12),
    genres: parseStringArray(row.genresJson, 18),
    maker: row.maker,
    label: row.label,
    series: row.series,
    releaseDate: row.releaseDate,
    runtimeMinutes: row.runtimeMinutes,
    score: row.score,
    homepage: row.homepage,
    thumbUrl: row.thumbUrl,
    coverUrl: row.coverUrl,
    previewVideoUrl: row.previewVideoUrl,
    previewVideoHlsUrl: row.previewVideoHlsUrl,
    previewImages: parseStringArray(row.previewImagesJson, 40),
    source: row.source,
    raw: parseRawJson(row.rawJson)
  };
}

function pickLongerText(primary: string, supplement: string): string {
  if (!primary) return supplement;
  if (!supplement) return primary;
  return supplement.length > primary.length ? supplement : primary;
}

function mergeMetadata(
  primary: NormalizedMetadata,
  supplement: NormalizedMetadata,
  trackSupplementSource: boolean
): NormalizedMetadata {
  const genres = primary.genres.length >= 3 || primary.genres.length >= supplement.genres.length
    ? primary.genres
    : supplement.genres;
  return {
    normalizedCode: primary.normalizedCode,
    provider: primary.provider || supplement.provider,
    providerId: primary.providerId || supplement.providerId,
    title: primary.title || supplement.title,
    summary: pickLongerText(primary.summary, supplement.summary),
    director: primary.director || supplement.director,
    actors: primary.actors.length > 0 ? primary.actors : supplement.actors,
    genres,
    maker: primary.maker || supplement.maker,
    label: primary.label || supplement.label,
    series: primary.series || supplement.series,
    releaseDate: primary.releaseDate || supplement.releaseDate,
    runtimeMinutes: primary.runtimeMinutes || supplement.runtimeMinutes,
    score: primary.score ?? supplement.score,
    homepage: primary.homepage || supplement.homepage,
    thumbUrl: primary.thumbUrl || supplement.thumbUrl,
    coverUrl: primary.coverUrl || supplement.coverUrl,
    previewVideoUrl: primary.previewVideoUrl || supplement.previewVideoUrl,
    previewVideoHlsUrl: primary.previewVideoHlsUrl || supplement.previewVideoHlsUrl,
    previewImages: [],
    source: trackSupplementSource
      ? [...new Set([primary.source, supplement.source].filter(Boolean))].join("+")
      : primary.source,
    raw: trackSupplementSource
      ? { primary: primary.raw, supplement: supplement.raw }
      : primary.raw
  };
}

function needsMetaTubeSupplement(metadata: NormalizedMetadata | null): boolean {
  if (!metadata) return true;
  return !metadata.title || !metadata.summary || metadata.actors.length === 0 || metadata.genres.length < 3 ||
    !metadata.maker || !metadata.releaseDate || !metadata.runtimeMinutes || !metadata.coverUrl ||
    (!metadata.previewVideoUrl && !metadata.previewVideoHlsUrl);
}

async function fetchMetadataForQueueRow(row: MetadataQueueRow): Promise<NormalizedMetadata | null> {
  let metadata: NormalizedMetadata | null = null;
  const errors: Error[] = [];

  async function addSource(loader: () => Promise<NormalizedMetadata | null>): Promise<void> {
    try {
      const fetched = await loader();
      if (!fetched) return;
      metadata = metadata ? mergeMetadata(metadata, fetched, true) : fetched;
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error("Metadata source failed"));
    }
  }

  if (config.metadata.serverUrl) {
    await addSource(() => fetchFromMetaTube(row.normalizedCode, getPrimaryEndpoint()));
  }

  const fallbackEndpoint = getFallbackEndpoint();
  if (fallbackEndpoint && needsMetaTubeSupplement(metadata)) {
    await addSource(() => fetchFromMetaTube(row.normalizedCode, fallbackEndpoint));
  }


  const stored = readStoredMetadata(row.normalizedCode);
  if (metadata && stored) return mergeMetadata(metadata, stored, false);
  if (metadata) return metadata;
  // A temporary source outage must not hide already adopted facts or clear their facets.
  if (stored) return stored;
  if (errors.length > 0) throw errors[0];
  return null;
}

function saveReadyMetadata(metadata: NormalizedMetadata): void {
  const timestamp = nowIso();

  metadataStatements.upsertReady.run({
    normalizedCode: metadata.normalizedCode,
    provider: metadata.provider,
    providerId: metadata.providerId,
    title: metadata.title,
    summary: metadata.summary,
    director: metadata.director,
    actorsJson: JSON.stringify(metadata.actors),
    genresJson: JSON.stringify(metadata.genres),
    maker: metadata.maker,
    label: metadata.label,
    series: metadata.series,
    releaseDate: metadata.releaseDate,
    runtimeMinutes: metadata.runtimeMinutes,
    score: metadata.score,
    homepage: metadata.homepage,
    thumbUrl: metadata.thumbUrl,
    coverUrl: metadata.coverUrl,
    previewVideoUrl: metadata.previewVideoUrl,
    previewVideoHlsUrl: metadata.previewVideoHlsUrl,
    previewImagesJson: JSON.stringify(metadata.previewImages),
    source: metadata.source,
    rawJson: JSON.stringify(metadata.raw),
    fetchedAt: timestamp,
    updatedAt: timestamp
  });

  replaceMetadataFacetsForCode({
    normalizedCode: metadata.normalizedCode,
    actors: metadata.actors,
    genres: metadata.genres,
    director: metadata.director,
    maker: metadata.maker,
    label: metadata.label,
    series: metadata.series
  });
  metadataStatements.syncIngestionItemStatus.run({
    normalizedCode: metadata.normalizedCode,
    updatedAt: timestamp
  });
}

async function processMetadataQueueRow(row: MetadataQueueRow, summary: MetadataRunSummary): Promise<void> {
  const timestamp = nowIso();
  metadataStatements.markFetching.run({
    normalizedCode: row.normalizedCode,
    updatedAt: timestamp
  });

  try {
    const metadata = await fetchMetadataForQueueRow(row);
    summary.processed += 1;

    if (!metadata) {
      metadataStatements.markNotFound.run({
        normalizedCode: row.normalizedCode,
        error: `未找到匹配的元数据：数据源未返回番号 ${row.normalizedCode} 的有效结果`,
        fetchedAt: nowIso(),
        updatedAt: nowIso()
      });
      clearMetadataFacetsForCode(row.normalizedCode);
      metadataStatements.syncIngestionItemStatus.run({
        normalizedCode: row.normalizedCode,
        updatedAt: nowIso()
      });
      summary.notFound += 1;
    } else {
      saveReadyMetadata(metadata);
      summary.ready += 1;
    }
  } catch (error) {
    if (error instanceof MetadataRateLimitError) {
      metadataStatements.deferRetry.run({
        normalizedCode: row.normalizedCode,
        status: row.status,
        error: error.message,
        updatedAt: nowIso()
      });
      metadataStatements.syncIngestionItemStatus.run({
        normalizedCode: row.normalizedCode,
        updatedAt: nowIso()
      });
      summary.skipped += 1;
      if (config.metadata.requestDelayMs > 0) {
        await wait(config.metadata.requestDelayMs);
      }
      return;
    }

    metadataStatements.markFailed.run({
      normalizedCode: row.normalizedCode,
      error: error instanceof Error ? error.message : "Metadata fetch failed",
      updatedAt: nowIso()
    });
    clearMetadataFacetsForCode(row.normalizedCode);
    metadataStatements.syncIngestionItemStatus.run({
      normalizedCode: row.normalizedCode,
      updatedAt: nowIso()
    });
    summary.processed += 1;
    summary.failed += 1;
  }

  if (config.metadata.requestDelayMs > 0) {
    await wait(config.metadata.requestDelayMs);
  }
}

function enqueueSpecificMetadataCodes(codes: string[], category: string, preserveReady: boolean): number {
  if (codes.length === 0) return 0;

  const timestamp = nowIso();
  const { placeholders, params } = buildCodeInParams(codes, "code");
  const scopedMediaWhere = `
    normalized_code IN (${placeholders})
    AND normalized_code != ''
    AND code_prefix != ''
    AND (@category = '' OR library_category = @category)
  `;
  const reset = db.prepare(`
    UPDATE media_metadata
    SET status = 'pending',
        error = NULL,
        attempts = 0,
        updated_at = @updatedAt
    WHERE normalized_code IN (
      SELECT DISTINCT normalized_code
      FROM media_files
      WHERE ${scopedMediaWhere}
    )
      AND (@preserveReady = 0 OR status != 'ready')
  `);
  const enqueue = db.prepare(`
    INSERT INTO media_metadata (
      normalized_code,
      source,
      status,
      updated_at
    )
    SELECT DISTINCT
      normalized_code,
      @source,
      'pending',
      @updatedAt
    FROM media_files
    WHERE ${scopedMediaWhere}
    ON CONFLICT(normalized_code) DO NOTHING
  `);

  const args = {
    ...params,
    category,
    preserveReady: preserveReady ? 1 : 0,
    source: config.metadata.provider,
    updatedAt: timestamp
  };

  return reset.run(args).changes + enqueue.run(args).changes;
}

function enqueueMetadataCodes(force: boolean, preserveReady: boolean, category: string, codes: string[]): number {
  if (codes.length > 0) {
    return enqueueSpecificMetadataCodes(codes, category, preserveReady);
  }

  const timestamp = nowIso();

  if (force) {
    metadataStatements.resetEligibleCodes.run({ updatedAt: timestamp, category });
  }

  metadataStatements.recoverInterruptedFetchingCodes.run({ updatedAt: timestamp, category });

  // Exhausted attempts expire: temporary outages should not permanently strand a work.
  // This only runs when the existing scan/enrichment flow requests another batch.
  db.prepare(`
    UPDATE media_metadata SET status = 'pending', attempts = 0, error = NULL, updated_at = @now
    WHERE (
      (status = 'failed' AND julianday(updated_at) <= julianday(@now) - 1)
      OR (status = 'not_found' AND julianday(updated_at) <= julianday(@now) - 30)
    ) AND EXISTS (
      SELECT 1 FROM media_files f WHERE f.normalized_code = media_metadata.normalized_code
        AND f.code_prefix != '' AND (@category = '' OR f.library_category = @category)
    )
  `).run({ now: timestamp, category });

  return metadataStatements.enqueueMissingCodes.run({
    source: config.metadata.provider,
    updatedAt: timestamp,
    category
  }).changes;
}

function selectMetadataQueueRows(
  codes: string[],
  category: string,
  limit: number
): MetadataQueueRow[] {
  if (codes.length === 0) {
    return metadataStatements.selectPendingCodes.all({
      maxAttempts: config.metadata.maxAttempts,
      includeNotFoundRetry: hasFallbackMetadataProvider() ? 1 : 0,
      limit,
      category
    }) as MetadataQueueRow[];
  }

  const { placeholders, params } = buildCodeInParams(codes, "selectCode");

  return db
    .prepare(
      `
      SELECT
        normalized_code AS normalizedCode,
        status,
        attempts
      FROM media_metadata
      WHERE normalized_code IN (${placeholders})
        AND status IN ('pending', 'failed', 'not_found')
        AND (
          @category = ''
          OR EXISTS (
            SELECT 1
            FROM media_files
            WHERE media_files.normalized_code = media_metadata.normalized_code
              AND media_files.library_category = @category
          )
        )
      ORDER BY normalized_code ASC
      LIMIT @limit
    `
    )
    .all({ ...params, category, limit }) as MetadataQueueRow[];
}

async function runMetadataEnrichment(
  options: Required<MetadataEnrichmentOptions>
): Promise<MetadataRunSummary> {
  const startedAt = nowIso();
  const configured = Boolean(config.metadata.serverUrl);
  const category = normalizeCategory(options.category || config.metadata.categoryFilter);
  const codes = normalizeMetadataCodes(options.codes);
  const summary: MetadataRunSummary = {
    enabled: config.metadata.autoEnrich,
    configured,
    provider: config.metadata.provider,
    reason: options.reason,
    requested: 0,
    processed: 0,
    ready: 0,
    notFound: 0,
    failed: 0,
    skipped: 0,
    startedAt,
    finishedAt: startedAt,
    category: category || null
  };

  if (config.metadata.provider !== "metatube") {
    summary.message = `Unsupported metadata provider: ${config.metadata.provider}`;
    summary.skipped += 1;
    summary.finishedAt = nowIso();
    return summary;
  }

  if (!configured) {
    summary.message = "METADATA_SERVER_URL is not configured";
    summary.skipped += 1;
    summary.finishedAt = nowIso();
    return summary;
  }

  enqueueMetadataCodes(options.force, options.preserveReady, category, codes);

  const limit = Math.min(options.limit, config.metadata.batchSize);
  const rows = selectMetadataQueueRows(codes, category, limit);

  summary.requested = rows.length;

  const concurrency = Math.max(1, Math.min(config.metadata.concurrency, rows.length));
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const row = rows[nextIndex];
      nextIndex += 1;
      if (!row) return;
      await processMetadataQueueRow(row, summary);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  summary.finishedAt = nowIso();
  return summary;
}

export function startMetadataEnrichment(
  options: MetadataEnrichmentOptions = {}
): Promise<MetadataRunSummary> {
  if (activeMetadataJob) return activeMetadataJob;

  activeMetadataJob = runMetadataEnrichment({
    force: options.force ?? false,
    preserveReady: options.preserveReady ?? false,
    limit: options.limit ?? config.metadata.batchSize,
    category: options.category ?? config.metadata.categoryFilter,
    codes: options.codes ?? [],
    reason: options.reason ?? "manual",
    exportWorkbook: options.exportWorkbook ?? true
  })
    .then(async (summary) => {
      if (summary.processed > 0 && (options.exportWorkbook ?? true)) {
        try {
          summary.excel = await exportMetadataWorkbook();
        } catch (error) {
          console.error("Metadata workbook export failed:", error);
        }
      }

      latestRun = summary;
      return summary;
    })
    .finally(() => {
      activeMetadataJob = null;
    });

  return activeMetadataJob;
}

export async function enqueueMetadataEnrichmentAfterCurrentRun(
  options: MetadataEnrichmentOptions
): Promise<MetadataRunSummary> {
  if (activeMetadataJob) {
    try {
      await activeMetadataJob;
    } catch {
      // A corrected code still deserves its own bounded retry after a failed batch.
    }
  }
  return startMetadataEnrichment(options);
}

export function getMetadataStatus(): MetadataStatusSummary {
  const rows = db
    .prepare("SELECT status, COUNT(*) AS count FROM media_metadata GROUP BY status")
    .all() as Array<{ status: string; count: number }>;
  const byStatus = new Map(rows.map((row) => [row.status, row.count]));
  const eligible = db
    .prepare(
      `
      SELECT COUNT(DISTINCT normalized_code) AS count
      FROM media_files
      WHERE normalized_code != ''
        AND code_prefix != ''
    `
    )
    .get() as { count: number };
  const cached = db.prepare("SELECT COUNT(*) AS count FROM media_metadata").get() as {
    count: number;
  };
  const categoryRows = db
    .prepare(
      `
      SELECT
        media_files.library_category AS category,
        COALESCE(media_metadata.status, 'pending') AS status,
        media_metadata.attempts AS attempts,
        COUNT(DISTINCT media_files.normalized_code) AS count
      FROM media_files
      LEFT JOIN media_metadata
        ON media_metadata.normalized_code = media_files.normalized_code
      WHERE media_files.normalized_code != ''
        AND media_files.code_prefix != ''
      GROUP BY media_files.library_category, COALESCE(media_metadata.status, 'pending'), media_metadata.attempts
      ORDER BY media_files.library_category
    `
    )
    .all() as Array<{ category: string; status: string; attempts: number | null; count: number }>;
  const byCategory = new Map<
    string,
    MetadataStatusSummary["categoryStats"][number]
  >();

  for (const row of categoryRows) {
    const category = row.category || "UNKNOWN";
    const current =
      byCategory.get(category) ??
      {
        category,
        eligible: 0,
        pending: 0,
        fetching: 0,
        ready: 0,
        notFound: 0,
        failed: 0,
        retryableFailed: 0,
        retryableNotFound: 0,
        skipped: 0
      };

    current.eligible += row.count;
    if (row.status === "pending") current.pending += row.count;
    else if (row.status === "fetching") current.fetching += row.count;
    else if (row.status === "ready") current.ready += row.count;
    else if (row.status === "not_found") {
      current.notFound += row.count;
      if (hasFallbackMetadataProvider() && (row.attempts ?? 0) < config.metadata.maxAttempts) {
        current.retryableNotFound += row.count;
      }
    } else if (row.status === "failed") {
      current.failed += row.count;
      if ((row.attempts ?? 0) < config.metadata.maxAttempts) {
        current.retryableFailed += row.count;
      }
    }
    else if (row.status === "skipped") current.skipped += row.count;
    byCategory.set(category, current);
  }

  return {
    enabled: config.metadata.autoEnrich,
    configured: Boolean(config.metadata.serverUrl),
    provider: config.metadata.provider,
    serverUrl: config.metadata.serverUrl || null,
    excelPath: config.metadataExcelPath,
    categoryFilter: config.metadata.categoryFilter || null,
    running: Boolean(activeMetadataJob),
    latestRun,
    stats: {
      eligible: eligible.count,
      cached: cached.count,
      pending: byStatus.get("pending") ?? 0,
      fetching: byStatus.get("fetching") ?? 0,
      ready: byStatus.get("ready") ?? 0,
      notFound: byStatus.get("not_found") ?? 0,
      failed: byStatus.get("failed") ?? 0,
      skipped: byStatus.get("skipped") ?? 0
    },
    categoryStats: [...byCategory.values()]
  };
}
