import type Database from "better-sqlite3";
import { db } from "./db.js";

export type MetadataQualityIssueType =
  | "missing_title_zh"
  | "missing_actor_zh"
  | "missing_genre_zh"
  | "missing_cover"
  | "duration_conflict"
  | "future_release_date"
  | "low_completeness";

export type MetadataQualityIssue = {
  type: MetadataQualityIssueType;
  severity: "info" | "warning" | "error";
  details: Record<string, unknown>;
  detectedAt: string;
};

type QualityIssueRow = {
  issueType: MetadataQualityIssueType;
  severity: MetadataQualityIssue["severity"];
  detailsJson: string;
  detectedAt: string;
};

function parseDetails(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function calculateCompleteness(issueTypes: Set<MetadataQualityIssueType>): number {
  let score = 100;
  if (issueTypes.has("missing_title_zh")) score -= 20;
  if (issueTypes.has("missing_actor_zh")) score -= 15;
  if (issueTypes.has("missing_genre_zh")) score -= 10;
  if (issueTypes.has("missing_cover")) score -= 20;
  if (issueTypes.has("duration_conflict")) score -= 10;
  if (issueTypes.has("future_release_date")) score -= 10;
  if (issueTypes.has("low_completeness")) score -= 20;
  return Math.max(0, score);
}

const refreshAllTransaction = db.transaction((detectedAt: string) => {
  db.prepare("DELETE FROM metadata_quality_issues").run();

  db.prepare(`
    INSERT INTO metadata_quality_issues
      (normalized_code, issue_type, severity, details_json, detected_at)
    SELECT normalized_code, 'missing_title_zh', 'warning', '{}', @detectedAt
    FROM media_metadata
    WHERE status = 'ready'
      AND TRIM(COALESCE(title, '')) != ''
      AND TRIM(COALESCE(title_zh, '')) = ''
  `).run({ detectedAt });

  db.prepare(`
    INSERT INTO metadata_quality_issues
      (normalized_code, issue_type, severity, details_json, detected_at)
    SELECT normalized_code, 'missing_actor_zh', 'warning',
      json_object('sourceCount', COALESCE(json_array_length(actors_json), 0)), @detectedAt
    FROM media_metadata
    WHERE status = 'ready'
      AND COALESCE(json_array_length(actors_json), 0) > 0
      AND COALESCE(json_array_length(actors_zh_json), 0) = 0
  `).run({ detectedAt });

  db.prepare(`
    INSERT INTO metadata_quality_issues
      (normalized_code, issue_type, severity, details_json, detected_at)
    SELECT normalized_code, 'missing_genre_zh', 'info',
      json_object('sourceCount', COALESCE(json_array_length(genres_json), 0)), @detectedAt
    FROM media_metadata
    WHERE status = 'ready'
      AND COALESCE(json_array_length(genres_json), 0) > 0
      AND COALESCE(json_array_length(genres_zh_json), 0) = 0
  `).run({ detectedAt });

  db.prepare(`
    INSERT INTO metadata_quality_issues
      (normalized_code, issue_type, severity, details_json, detected_at)
    SELECT normalized_code, 'missing_cover', 'warning', '{}', @detectedAt
    FROM media_metadata
    WHERE status = 'ready'
      AND TRIM(COALESCE(cover_url, '')) = ''
      AND TRIM(COALESCE(thumb_url, '')) = ''
  `).run({ detectedAt });

  db.prepare(`
    INSERT INTO metadata_quality_issues
      (normalized_code, issue_type, severity, details_json, detected_at)
    SELECT metadata.normalized_code, 'duration_conflict', 'warning',
      json_object(
        'metadataMinutes', metadata.runtime_minutes,
        'fileMinutes', ROUND(files.duration_seconds / 60.0, 1),
        'deltaMinutes', ROUND(ABS(files.duration_seconds / 60.0 - metadata.runtime_minutes), 1)
      ), @detectedAt
    FROM media_metadata metadata
    JOIN (
      SELECT normalized_code, MAX(duration_seconds) AS duration_seconds
      FROM media_files
      WHERE duration_seconds > 0 AND normalized_code != ''
      GROUP BY normalized_code
    ) files ON files.normalized_code = metadata.normalized_code
    WHERE metadata.status = 'ready'
      AND metadata.runtime_minutes > 0
      AND ABS(files.duration_seconds - metadata.runtime_minutes * 60.0) >= 1800
      AND ABS(files.duration_seconds - metadata.runtime_minutes * 60.0) /
          MAX(files.duration_seconds, metadata.runtime_minutes * 60.0) >= 0.2
  `).run({ detectedAt });

  db.prepare(`
    INSERT INTO metadata_quality_issues
      (normalized_code, issue_type, severity, details_json, detected_at)
    SELECT normalized_code, 'future_release_date', 'error',
      json_object('releaseDate', release_date), @detectedAt
    FROM media_metadata
    WHERE status = 'ready'
      AND date(release_date) > date('now', '+1 day')
  `).run({ detectedAt });

  db.prepare(`
    INSERT INTO metadata_quality_issues
      (normalized_code, issue_type, severity, details_json, detected_at)
    SELECT normalized_code, 'low_completeness', 'warning',
      json_object('availableFields',
        (TRIM(COALESCE(title, '')) != '') +
        (COALESCE(json_array_length(actors_json), 0) > 0) +
        (COALESCE(json_array_length(genres_json), 0) > 0) +
        (TRIM(COALESCE(maker, '')) != '') +
        (TRIM(COALESCE(release_date, '')) != '') +
        (runtime_minutes > 0) +
        (TRIM(COALESCE(cover_url, '')) != '' OR TRIM(COALESCE(thumb_url, '')) != '')
      ), @detectedAt
    FROM media_metadata
    WHERE status = 'ready'
      AND (
        (TRIM(COALESCE(title, '')) != '') +
        (COALESCE(json_array_length(actors_json), 0) > 0) +
        (COALESCE(json_array_length(genres_json), 0) > 0) +
        (TRIM(COALESCE(maker, '')) != '') +
        (TRIM(COALESCE(release_date, '')) != '') +
        (runtime_minutes > 0) +
        (TRIM(COALESCE(cover_url, '')) != '' OR TRIM(COALESCE(thumb_url, '')) != '')
      ) < 4
  `).run({ detectedAt });

  return db.prepare("SELECT COUNT(*) AS count FROM metadata_quality_issues").get() as { count: number };
});

export function refreshMetadataQualityIssues(): { issues: number; detectedAt: string } {
  const detectedAt = new Date().toISOString();
  const result = refreshAllTransaction(detectedAt);
  return { issues: result.count, detectedAt };
}

export function ensureMetadataQualityIssues(): { rebuilt: boolean; issues: number } {
  const issueCount = db.prepare("SELECT COUNT(*) AS count FROM metadata_quality_issues").get() as { count: number };
  const readyCount = db.prepare("SELECT COUNT(*) AS count FROM media_metadata WHERE status = 'ready'").get() as { count: number };
  if (issueCount.count === 0 && readyCount.count > 0) {
    const refreshed = refreshMetadataQualityIssues();
    return { rebuilt: true, issues: refreshed.issues };
  }
  return { rebuilt: false, issues: issueCount.count };
}

export function getMetadataQualityForCode(normalizedCode: string): {
  completeness: number;
  confidence: number;
  durationConflict: boolean;
  durationDeltaMinutes: number | null;
  issues: MetadataQualityIssue[];
} {
  const rows = db.prepare(`
    SELECT issue_type AS issueType, severity, details_json AS detailsJson, detected_at AS detectedAt
    FROM metadata_quality_issues
    WHERE normalized_code = ?
    ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, issue_type
  `).all(normalizedCode) as QualityIssueRow[];
  const issues = rows.map((row) => ({
    type: row.issueType,
    severity: row.severity,
    details: parseDetails(row.detailsJson),
    detectedAt: row.detectedAt
  }));
  const issueTypes = new Set(issues.map((issue) => issue.type));
  const durationIssue = issues.find((issue) => issue.type === "duration_conflict");
  const completeness = calculateCompleteness(issueTypes);
  return {
    completeness,
    confidence: Math.max(0, completeness - (issueTypes.has("future_release_date") ? 15 : 0)),
    durationConflict: Boolean(durationIssue),
    durationDeltaMinutes: typeof durationIssue?.details.deltaMinutes === "number"
      ? durationIssue.details.deltaMinutes
      : null,
    issues
  };
}

export function getMetadataQualityIssueCounts(database: Database.Database = db): Array<{
  type: MetadataQualityIssueType;
  severity: MetadataQualityIssue["severity"];
  count: number;
}> {
  return database.prepare(`
    SELECT issue_type AS type, severity, COUNT(*) AS count
    FROM metadata_quality_issues
    GROUP BY issue_type, severity
    ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, count DESC
  `).all() as Array<{
    type: MetadataQualityIssueType;
    severity: MetadataQualityIssue["severity"];
    count: number;
  }>;
}
