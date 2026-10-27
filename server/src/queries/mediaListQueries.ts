import { db, type MediaRow } from "../db.js";

const HIDDEN_METADATA_GENRES = new Set(["样片", "樣片", "サンプル動画", "sample video"]);

export type MediaListRow = {
  id: string;
  absolutePath: string;
  mediaType: "video" | "image";
  durationSeconds: number | null;
  relativePath: string;
  playbackPositionSeconds: number | null;
  playbackDurationSeconds: number | null;
  playbackCompleted: number | null;
  playbackPlayCount: number | null;
  playbackLastPlayedAt: string | null;
  metadataStatus: string | null;
  metadataTitle: string | null;
  metadataSummary: string | null;
  metadataDirector: string | null;
  metadataActorsJson: string | null;
  metadataGenresJson: string | null;
  metadataMaker: string | null;
  metadataLabel: string | null;
  metadataSeries: string | null;
  metadataTitleZh: string | null;
  metadataSummaryZh: string | null;
  metadataDirectorZh: string | null;
  metadataActorsZhJson: string | null;
  metadataGenresZhJson: string | null;
  metadataMakerZh: string | null;
  metadataLabelZh: string | null;
  metadataSeriesZh: string | null;
  metadataTranslationStatus: string | null;
  metadataTranslatedAt: string | null;
  metadataReleaseDate: string | null;
  metadataRuntimeMinutes: number | null;
  metadataScore: number | null;
  metadataProvider: string | null;
  metadataHomepage: string | null;
  metadataCoverUrl: string | null;
  metadataThumbUrl: string | null;
  metadataPreviewVideoUrl: string | null;
  metadataPreviewVideoHlsUrl: string | null;
  metadataPreviewImagesJson: string | null;
  metadataOverrideJson: string | null;
  randomKeyCursor: string;
  versionCount: number;
  [key: string]: unknown;
};

export type MediaPosterRow = MediaRow & {
  metadataCoverUrl: string | null;
  metadataThumbUrl: string | null;
};

export const MEDIA_LIST_SELECT = `
  media_files.id,
  media_files.absolute_path AS absolutePath,
  media_files.library_category AS libraryCategory,
  media_files.source_name AS sourceName,
  media_files.relative_path AS relativePath,
  media_files.name,
  media_files.basename,
  media_files.extension,
  media_files.mime_type AS mimeType,
  media_files.size,
  media_files.mtime_ms AS mtimeMs,
  media_files.directory,
  media_files.first_letter AS firstLetter,
  media_files.collection_bucket AS collectionBucket,
  media_files.code_prefix AS codePrefix,
  media_files.code_number AS codeNumber,
  media_files.normalized_code AS normalizedCode,
  media_files.variant_tags AS variantTags,
  media_files.quality_tag AS qualityTag,
  media_files.random_key AS randomKey,
  CAST(media_files.random_key AS TEXT) AS randomKeyCursor,
  media_files.media_type AS mediaType,
  media_files.duration_seconds AS durationSeconds,
  media_files.width,
  media_files.height,
  media_files.container_format AS containerFormat,
  media_files.video_codec AS videoCodec,
  media_files.audio_codec AS audioCodec,
  media_files.compatibility_status AS compatibilityStatus,
  media_files.probe_status AS probeStatus,
  media_files.probe_error AS probeError,
  media_files.thumbnail_status AS thumbnailStatus,
  media_files.indexed_at AS indexedAt,
  playback_progress.position_seconds AS playbackPositionSeconds,
  playback_progress.duration_seconds AS playbackDurationSeconds,
  playback_progress.completed AS playbackCompleted,
  playback_progress.play_count AS playbackPlayCount,
  playback_progress.last_played_at AS playbackLastPlayedAt,
  media_metadata.status AS metadataStatus,
  media_metadata.title AS metadataTitle,
  media_metadata.summary AS metadataSummary,
  media_metadata.director AS metadataDirector,
  media_metadata.actors_json AS metadataActorsJson,
  media_metadata.genres_json AS metadataGenresJson,
  media_metadata.maker AS metadataMaker,
  media_metadata.label AS metadataLabel,
  media_metadata.series AS metadataSeries,
  media_metadata.title_zh AS metadataTitleZh,
  media_metadata.summary_zh AS metadataSummaryZh,
  media_metadata.director_zh AS metadataDirectorZh,
  media_metadata.actors_zh_json AS metadataActorsZhJson,
  media_metadata.genres_zh_json AS metadataGenresZhJson,
  media_metadata.maker_zh AS metadataMakerZh,
  media_metadata.label_zh AS metadataLabelZh,
  media_metadata.series_zh AS metadataSeriesZh,
  media_metadata.translation_status AS metadataTranslationStatus,
  media_metadata.translated_at AS metadataTranslatedAt,
  media_metadata.release_date AS metadataReleaseDate,
  media_metadata.runtime_minutes AS metadataRuntimeMinutes,
  media_metadata.score AS metadataScore,
  media_metadata.provider AS metadataProvider,
  media_metadata.homepage AS metadataHomepage,
  media_metadata.cover_url AS metadataCoverUrl,
  media_metadata.thumb_url AS metadataThumbUrl,
  media_metadata.preview_video_url AS metadataPreviewVideoUrl,
  media_metadata.preview_video_hls_url AS metadataPreviewVideoHlsUrl,
  media_metadata.preview_images_json AS metadataPreviewImagesJson,
  metadata_overrides.patch_json AS metadataOverrideJson
`;

export const MEDIA_LIST_JOINS = `
  LEFT JOIN media_metadata
    ON media_metadata.normalized_code = media_files.normalized_code
  LEFT JOIN playback_progress
    ON playback_progress.relative_path = media_files.relative_path
  LEFT JOIN metadata_overrides
    ON metadata_overrides.normalized_code = media_files.normalized_code
`;

export function parseJsonStringArray(value: string | null): string[] {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function isHiddenMetadataGenre(value: string | undefined): boolean {
  return HIDDEN_METADATA_GENRES.has(value?.trim().toLocaleLowerCase() ?? "");
}

function filterMetadataGenres(genres: string[], genresZh: string[]): { genres: string[]; genresZh: string[] } {
  const visible = genres
    .map((genre, index) => ({ genre, genreZh: genresZh[index] ?? genre }))
    .filter(({ genre, genreZh }) => !isHiddenMetadataGenre(genre) && !isHiddenMetadataGenre(genreZh));

  return {
    genres: visible.map(({ genre }) => genre),
    genresZh: visible.map(({ genreZh }) => genreZh)
  };
}

export function hydrateMediaRows(
  rows: MediaListRow[],
  favoriteKeys: Set<string>,
  options: { compact?: boolean } = {}
): Array<Record<string, unknown> & { isFavorite: boolean; metadata: unknown; playback: unknown }> {
  return rows.map((row) => {
    const durationSeconds =
      row.durationSeconds ??
      (row.metadataRuntimeMinutes && row.metadataRuntimeMinutes > 0
        ? row.metadataRuntimeMinutes * 60
        : null);

    const visibleGenres = filterMetadataGenres(
      parseJsonStringArray(row.metadataGenresJson),
      parseJsonStringArray(row.metadataGenresZhJson)
    );
    const metadataOverride = parseJsonObject(row.metadataOverrideJson);
    const compactMetadata = row.metadataStatus
      ? {
          status: row.metadataStatus,
          title: row.metadataTitle ?? "",
          director: row.metadataDirector ?? "",
          directorZh: row.metadataDirectorZh ?? "",
          actors: parseJsonStringArray(row.metadataActorsJson),
          genres: visibleGenres.genres,
          titleZh: row.metadataTitleZh ?? "",
          actorsZh: parseJsonStringArray(row.metadataActorsZhJson),
          genresZh: visibleGenres.genresZh,
          translationStatus: row.metadataTranslationStatus ?? "pending"
        }
      : null;
    const metadata = compactMetadata && !options.compact
      ? {
          ...compactMetadata,
          summary: row.metadataSummary ?? "",
          director: row.metadataDirector ?? "",
          maker: row.metadataMaker ?? "",
          label: row.metadataLabel ?? "",
          series: row.metadataSeries ?? "",
          summaryZh: row.metadataSummaryZh ?? "",
          directorZh: row.metadataDirectorZh ?? "",
          makerZh: row.metadataMakerZh ?? "",
          labelZh: row.metadataLabelZh ?? "",
          seriesZh: row.metadataSeriesZh ?? "",
          translatedAt: row.metadataTranslatedAt,
          releaseDate: row.metadataReleaseDate,
          runtimeMinutes: row.metadataRuntimeMinutes,
          score: row.metadataScore,
          provider: row.metadataProvider ?? "",
          homepage: row.metadataHomepage ?? "",
          coverUrl: row.metadataCoverUrl ?? "",
          thumbUrl: row.metadataThumbUrl ?? "",
          previewVideoUrl: row.metadataPreviewVideoUrl ?? "",
          previewVideoHlsUrl: row.metadataPreviewVideoHlsUrl ?? "",
          previewImages: [],
          ...metadataOverride
        }
      : compactMetadata
        ? { ...compactMetadata, ...metadataOverride }
        : null;
    const playback = row.playbackLastPlayedAt
      ? {
          positionSeconds: row.playbackPositionSeconds ?? 0,
          durationSeconds: row.playbackDurationSeconds ?? durationSeconds,
          completed: Boolean(row.playbackCompleted),
          playCount: row.playbackPlayCount ?? 0,
          lastPlayedAt: row.playbackLastPlayedAt
        }
      : null;

    const {
      absolutePath: _absolutePath,
      playbackPositionSeconds: _playbackPositionSeconds,
      playbackDurationSeconds: _playbackDurationSeconds,
      playbackCompleted: _playbackCompleted,
      playbackPlayCount: _playbackPlayCount,
      playbackLastPlayedAt: _playbackLastPlayedAt,
      metadataStatus: _metadataStatus,
      metadataTitle: _metadataTitle,
      metadataSummary: _metadataSummary,
      metadataDirector: _metadataDirector,
      metadataActorsJson: _metadataActorsJson,
      metadataGenresJson: _metadataGenresJson,
      metadataMaker: _metadataMaker,
      metadataLabel: _metadataLabel,
      metadataSeries: _metadataSeries,
      metadataTitleZh: _metadataTitleZh,
      metadataSummaryZh: _metadataSummaryZh,
      metadataDirectorZh: _metadataDirectorZh,
      metadataActorsZhJson: _metadataActorsZhJson,
      metadataGenresZhJson: _metadataGenresZhJson,
      metadataMakerZh: _metadataMakerZh,
      metadataLabelZh: _metadataLabelZh,
      metadataSeriesZh: _metadataSeriesZh,
      metadataTranslationStatus: _metadataTranslationStatus,
      metadataTranslatedAt: _metadataTranslatedAt,
      metadataReleaseDate: _metadataReleaseDate,
      metadataRuntimeMinutes: _metadataRuntimeMinutes,
      metadataScore: _metadataScore,
      metadataProvider: _metadataProvider,
      metadataHomepage: _metadataHomepage,
      metadataCoverUrl: _metadataCoverUrl,
      metadataThumbUrl: _metadataThumbUrl,
      metadataPreviewVideoUrl: _metadataPreviewVideoUrl,
      metadataPreviewVideoHlsUrl: _metadataPreviewVideoHlsUrl,
      metadataPreviewImagesJson: _metadataPreviewImagesJson,
      metadataOverrideJson: _metadataOverrideJson,
      ...publicRow
    } = {
      ...row,
      durationSeconds,
      isFavorite: favoriteKeys.has(row.relativePath),
      metadata,
      playback
    };
    return publicRow;
  });
}

export function getMediaRowById(id: string): MediaRow | undefined {
  return db.prepare("SELECT * FROM media_files WHERE id = ?").get(id) as MediaRow | undefined;
}
