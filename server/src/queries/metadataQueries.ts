import { db } from "../db.js";

const HIDDEN_METADATA_GENRES = new Set(["样片", "樣片", "サンプル動画", "sample video"]);

export type MetadataItemsQuery = {
  q?: string;
  status: "ALL" | "ready" | "not_found" | "failed" | "pending" | "fetching" | "skipped";
  page: number;
  pageSize: number;
};

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function isHiddenGenre(value: string | undefined): boolean {
  return HIDDEN_METADATA_GENRES.has(value?.trim().toLocaleLowerCase() ?? "");
}

function filterGenres(genres: string[], genresZh: string[]) {
  const visible = genres
    .map((genre, index) => ({ genre, genreZh: genresZh[index] ?? genre }))
    .filter(({ genre, genreZh }) => !isHiddenGenre(genre) && !isHiddenGenre(genreZh));
  return {
    genres: visible.map(({ genre }) => genre),
    genresZh: visible.map(({ genreZh }) => genreZh)
  };
}

export function buildMetadataItemsResponse(query: MetadataItemsQuery) {
  const clauses: string[] = [
    "media_metadata.normalized_code NOT LIKE 'FC2%'",
    `EXISTS (
      SELECT 1 FROM media_files AS scoped_media
      WHERE scoped_media.normalized_code = media_metadata.normalized_code
        AND scoped_media.library_category != 'FC2'
    )`
  ];
  const params: Record<string, string | number> = {};

  if (query.status !== "ALL") {
    clauses.push("media_metadata.status = @status");
    params.status = query.status;
  }

  if (query.q) {
    clauses.push(`(
      media_metadata.normalized_code LIKE @q
      OR media_metadata.title LIKE @q
      OR media_metadata.title_zh LIKE @q
      OR media_metadata.director LIKE @q
      OR media_metadata.director_zh LIKE @q
      OR media_metadata.maker LIKE @q
      OR media_metadata.maker_zh LIKE @q
      OR media_metadata.label LIKE @q
      OR media_metadata.label_zh LIKE @q
      OR media_metadata.series LIKE @q
      OR media_metadata.series_zh LIKE @q
      OR media_metadata.actors_json LIKE @q
      OR media_metadata.actors_zh_json LIKE @q
      OR media_metadata.genres_json LIKE @q
      OR media_metadata.genres_zh_json LIKE @q
      OR media_metadata.error LIKE @q
    )`);
    params.q = `%${query.q}%`;
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const offset = (query.page - 1) * query.pageSize;
  const total = db.prepare(`SELECT COUNT(*) AS count FROM media_metadata ${whereSql}`).get(params) as { count: number };
  const rows = db.prepare(`
    SELECT
      media_metadata.normalized_code AS normalizedCode,
      media_metadata.status,
      media_metadata.title,
      media_metadata.director,
      media_metadata.actors_json AS actorsJson,
      media_metadata.genres_json AS genresJson,
      media_metadata.maker,
      media_metadata.label,
      media_metadata.series,
      media_metadata.title_zh AS titleZh,
      media_metadata.summary_zh AS summaryZh,
      media_metadata.director_zh AS directorZh,
      media_metadata.actors_zh_json AS actorsZhJson,
      media_metadata.genres_zh_json AS genresZhJson,
      media_metadata.maker_zh AS makerZh,
      media_metadata.label_zh AS labelZh,
      media_metadata.series_zh AS seriesZh,
      media_metadata.translation_status AS translationStatus,
      media_metadata.translation_error AS translationError,
      media_metadata.translated_at AS translatedAt,
      media_metadata.release_date AS releaseDate,
      media_metadata.runtime_minutes AS runtimeMinutes,
      media_metadata.provider,
      media_metadata.homepage,
      media_metadata.cover_url AS coverUrl,
      media_metadata.thumb_url AS thumbUrl,
      media_metadata.error,
      media_metadata.attempts,
      media_metadata.updated_at AS updatedAt,
      (
        SELECT representative.id
        FROM media_files AS representative
        WHERE representative.normalized_code = media_metadata.normalized_code
        ORDER BY representative.mtime_ms DESC, representative.id ASC
        LIMIT 1
      ) AS mediaId,
      (
        SELECT representative.basename
        FROM media_files AS representative
        WHERE representative.normalized_code = media_metadata.normalized_code
        ORDER BY representative.mtime_ms DESC, representative.id ASC
        LIMIT 1
      ) AS mediaBasename,
      (
        SELECT representative.relative_path
        FROM media_files AS representative
        WHERE representative.normalized_code = media_metadata.normalized_code
        ORDER BY representative.mtime_ms DESC, representative.id ASC
        LIMIT 1
      ) AS mediaRelativePath,
      (
        SELECT origin.original_basename
        FROM metadata_file_origins AS origin
        WHERE origin.normalized_code = media_metadata.normalized_code
      ) AS originalBasename,
      (
        SELECT origin.original_relative_path
        FROM metadata_file_origins AS origin
        WHERE origin.normalized_code = media_metadata.normalized_code
      ) AS originalRelativePath,
      COUNT(DISTINCT media_files.id) AS mediaCount
    FROM media_metadata
    LEFT JOIN media_files ON media_files.normalized_code = media_metadata.normalized_code
    ${whereSql}
    GROUP BY media_metadata.normalized_code
    ORDER BY
      CASE media_metadata.status
        WHEN 'failed' THEN 0
        WHEN 'not_found' THEN 1
        WHEN 'pending' THEN 2
        WHEN 'fetching' THEN 3
        WHEN 'ready' THEN 4
        ELSE 5
      END,
      media_metadata.updated_at DESC,
      media_metadata.normalized_code ASC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: query.pageSize, offset }) as Array<{
    normalizedCode: string;
    status: string;
    title: string;
    director: string;
    actorsJson: string | null;
    genresJson: string | null;
    maker: string;
    label: string;
    series: string;
    titleZh: string;
    summaryZh: string;
    directorZh: string;
    actorsZhJson: string | null;
    genresZhJson: string | null;
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
  }>;
  const statusRows = db.prepare(`
    SELECT media_metadata.status, COUNT(*) AS count
    FROM media_metadata
    WHERE media_metadata.normalized_code NOT LIKE 'FC2%'
      AND EXISTS (
        SELECT 1 FROM media_files AS scoped_media
        WHERE scoped_media.normalized_code = media_metadata.normalized_code
          AND scoped_media.library_category != 'FC2'
      )
    GROUP BY media_metadata.status
  `).all() as Array<{
    status: string;
    count: number;
  }>;

  return {
    items: rows.map((row) => {
      const visibleGenres = filterGenres(parseStringArray(row.genresJson), parseStringArray(row.genresZhJson));
      const error = row.error === "No metadata match found"
        ? `未找到匹配的元数据：数据源未返回番号 ${row.normalizedCode} 的有效结果`
        : row.error;
      return {
        normalizedCode: row.normalizedCode,
        status: row.status,
        title: row.title,
        director: row.director,
        actors: parseStringArray(row.actorsJson),
        genres: visibleGenres.genres,
        maker: row.maker,
        label: row.label,
        series: row.series,
        titleZh: row.titleZh,
        summaryZh: row.summaryZh,
        directorZh: row.directorZh,
        actorsZh: parseStringArray(row.actorsZhJson),
        genresZh: visibleGenres.genresZh,
        makerZh: row.makerZh,
        labelZh: row.labelZh,
        seriesZh: row.seriesZh,
        translationStatus: row.translationStatus,
        translationError: row.translationError,
        translatedAt: row.translatedAt,
        releaseDate: row.releaseDate,
        runtimeMinutes: row.runtimeMinutes,
        provider: row.provider,
        homepage: row.homepage,
        coverUrl: row.coverUrl,
        thumbUrl: row.thumbUrl,
        error,
        attempts: row.attempts,
        updatedAt: row.updatedAt,
        mediaId: row.mediaId,
        mediaBasename: row.mediaBasename,
        mediaRelativePath: row.mediaRelativePath,
        originalBasename: row.originalBasename,
        originalRelativePath: row.originalRelativePath,
        mediaCount: row.mediaCount
      };
    }),
    page: query.page,
    pageSize: query.pageSize,
    total: total.count,
    totalPages: Math.ceil(total.count / query.pageSize),
    stats: statusRows.reduce<Record<string, number>>((accumulator, row) => {
      accumulator[row.status] = row.count;
      return accumulator;
    }, {})
  };
}
