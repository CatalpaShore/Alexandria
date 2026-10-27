import fs from "node:fs";
import path from "node:path";
import { initializeDataIntegrity } from "./databaseMaintenance.js";
import { db } from "./database/connection.js";
import { PREFIX_TOTALS_SCHEMA } from "./libraryPrefixTotals.js";

export { db } from "./database/connection.js";
db.exec(PREFIX_TOTALS_SCHEMA);

export type MediaRow = {
  id: string;
  library_category: string;
  source_name: string;
  source_root: string;
  relative_path: string;
  absolute_path: string;
  name: string;
  basename: string;
  extension: string;
  mime_type: string;
  size: number;
  mtime_ms: number;
  directory: string;
  first_letter: string;
  collection_bucket: string;
  code_prefix: string;
  code_number: string;
  normalized_code: string;
  variant_tags: string;
  quality_tag: string;
  media_type: "video" | "image";
  thumbnail_path: string | null;
  thumbnail_status: "pending" | "ready" | "failed" | "unsupported";
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  container_format: string;
  video_codec: string;
  audio_codec: string;
  compatibility_status: "unknown" | "native" | "remux" | "transcode" | "unsupported";
  probe_status: "pending" | "queued" | "ready" | "failed";
  probe_error: string | null;
  probed_at: string | null;
  indexed_at: string;
  scan_token: string;
};

export type MetadataStatus = "pending" | "fetching" | "ready" | "not_found" | "failed" | "skipped";

export type MediaMetadataRow = {
  normalized_code: string;
  provider: string;
  provider_id: string;
  title: string;
  summary: string;
  director: string;
  actors_json: string;
  genres_json: string;
  maker: string;
  label: string;
  series: string;
  title_zh: string;
  summary_zh: string;
  director_zh: string;
  actors_zh_json: string;
  genres_zh_json: string;
  maker_zh: string;
  label_zh: string;
  series_zh: string;
  release_date: string | null;
  runtime_minutes: number | null;
  score: number | null;
  homepage: string;
  thumb_url: string;
  cover_url: string;
  preview_video_url: string;
  preview_video_hls_url: string;
  preview_images_json: string;
  source: string;
  status: MetadataStatus;
  error: string | null;
  raw_json: string | null;
  attempts: number;
  translation_status: string;
  translation_error: string | null;
  translation_source: string;
  translation_input_hash: string;
  translated_at: string | null;
  fetched_at: string | null;
  updated_at: string;
};

export type MetadataFacetType = "actor" | "genre" | "director" | "maker" | "label" | "series";

export type MetadataFacetSource = {
  normalizedCode: string;
  actors?: string[];
  genres?: string[];
  director?: string;
  maker?: string;
  label?: string;
  series?: string;
};

db.exec(`
  CREATE TABLE IF NOT EXISTS media_files (
    id TEXT PRIMARY KEY,
    library_category TEXT NOT NULL DEFAULT 'JAV',
    source_name TEXT NOT NULL DEFAULT '',
    source_root TEXT NOT NULL DEFAULT '',
    relative_path TEXT NOT NULL UNIQUE,
    absolute_path TEXT NOT NULL,
    name TEXT NOT NULL,
    basename TEXT NOT NULL,
    extension TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    directory TEXT NOT NULL,
    first_letter TEXT NOT NULL,
    collection_bucket TEXT NOT NULL DEFAULT '',
    code_prefix TEXT NOT NULL DEFAULT '',
    code_number TEXT NOT NULL DEFAULT '',
    normalized_code TEXT NOT NULL DEFAULT '',
    variant_tags TEXT NOT NULL DEFAULT '[]',
    quality_tag TEXT NOT NULL DEFAULT '',
    media_type TEXT NOT NULL,
    thumbnail_path TEXT,
    thumbnail_status TEXT NOT NULL DEFAULT 'pending',
    duration_seconds REAL,
    width INTEGER,
    height INTEGER,
    container_format TEXT NOT NULL DEFAULT '',
    video_codec TEXT NOT NULL DEFAULT '',
    audio_codec TEXT NOT NULL DEFAULT '',
    compatibility_status TEXT NOT NULL DEFAULT 'unknown',
    probe_status TEXT NOT NULL DEFAULT 'pending',
    probe_error TEXT,
    probed_at TEXT,
    indexed_at TEXT NOT NULL,
    first_seen_at TEXT NOT NULL DEFAULT '',
    scan_token TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_media_name ON media_files(name);
  CREATE INDEX IF NOT EXISTS idx_media_first_letter ON media_files(first_letter);
  CREATE INDEX IF NOT EXISTS idx_media_extension ON media_files(extension);
  CREATE INDEX IF NOT EXISTS idx_media_mtime ON media_files(mtime_ms);

  CREATE TABLE IF NOT EXISTS media_variant_tags (
    media_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (media_id, tag),
    FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE
  ) WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS idx_media_variant_tags_tag_media
    ON media_variant_tags(tag, media_id);

  CREATE TABLE IF NOT EXISTS media_metadata (
    normalized_code TEXT PRIMARY KEY,
    provider TEXT NOT NULL DEFAULT '',
    provider_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    director TEXT NOT NULL DEFAULT '',
    actors_json TEXT NOT NULL DEFAULT '[]',
    genres_json TEXT NOT NULL DEFAULT '[]',
    maker TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '',
    series TEXT NOT NULL DEFAULT '',
    title_zh TEXT NOT NULL DEFAULT '',
    summary_zh TEXT NOT NULL DEFAULT '',
    director_zh TEXT NOT NULL DEFAULT '',
    actors_zh_json TEXT NOT NULL DEFAULT '[]',
    genres_zh_json TEXT NOT NULL DEFAULT '[]',
    maker_zh TEXT NOT NULL DEFAULT '',
    label_zh TEXT NOT NULL DEFAULT '',
    series_zh TEXT NOT NULL DEFAULT '',
    release_date TEXT,
    runtime_minutes INTEGER,
    score REAL,
    homepage TEXT NOT NULL DEFAULT '',
    thumb_url TEXT NOT NULL DEFAULT '',
    cover_url TEXT NOT NULL DEFAULT '',
    preview_video_url TEXT NOT NULL DEFAULT '',
    preview_video_hls_url TEXT NOT NULL DEFAULT '',
    preview_images_json TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'metatube',
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    raw_json TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    translation_status TEXT NOT NULL DEFAULT 'pending',
    translation_error TEXT,
    translation_source TEXT NOT NULL DEFAULT '',
    translation_input_hash TEXT NOT NULL DEFAULT '',
    translated_at TEXT,
    fetched_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS metadata_file_origins (
    normalized_code TEXT PRIMARY KEY,
    original_basename TEXT NOT NULL,
    original_relative_path TEXT NOT NULL,
    source_path TEXT NOT NULL DEFAULT '',
    imported_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_metadata_status ON media_metadata(status);
  CREATE INDEX IF NOT EXISTS idx_metadata_provider ON media_metadata(provider);
  CREATE INDEX IF NOT EXISTS idx_metadata_release_date ON media_metadata(release_date);
  CREATE INDEX IF NOT EXISTS idx_metadata_maker ON media_metadata(maker);
  CREATE INDEX IF NOT EXISTS idx_metadata_director ON media_metadata(director);
  CREATE INDEX IF NOT EXISTS idx_metadata_label ON media_metadata(label);
  CREATE INDEX IF NOT EXISTS idx_metadata_series ON media_metadata(series);
  CREATE INDEX IF NOT EXISTS idx_metadata_translation_status ON media_metadata(translation_status);

  CREATE TABLE IF NOT EXISTS metadata_acquisition_plans (
    plan_id TEXT PRIMARY KEY,
    plan_hash TEXT NOT NULL,
    mode TEXT NOT NULL,
    scope_json TEXT NOT NULL DEFAULT '{}',
    packages_json TEXT NOT NULL DEFAULT '[]',
    candidates_json TEXT NOT NULL DEFAULT '[]',
    candidate_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS metadata_acquisition_runs (
    run_id TEXT PRIMARY KEY,
    request_key TEXT NOT NULL UNIQUE,
    plan_id TEXT NOT NULL,
    plan_hash TEXT NOT NULL,
    mode TEXT NOT NULL,
    scope_json TEXT NOT NULL DEFAULT '{}',
    packages_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'queued',
    counts_json TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (plan_id) REFERENCES metadata_acquisition_plans(plan_id)
  );

  CREATE TABLE IF NOT EXISTS metadata_acquisition_tasks (
    task_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    subject_key TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    result_json TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (run_id, kind, subject_type, subject_key),
    FOREIGN KEY (run_id) REFERENCES metadata_acquisition_runs(run_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_metadata_acquisition_tasks_queue
    ON metadata_acquisition_tasks(run_id, status, kind, created_at);

  CREATE TABLE IF NOT EXISTS metadata_run_media_jobs (
    run_id TEXT NOT NULL,
    media_id TEXT NOT NULL,
    job_type TEXT NOT NULL,
    source_signature TEXT NOT NULL DEFAULT '',
    media_job_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    result_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, media_id, job_type, source_signature),
    FOREIGN KEY (run_id) REFERENCES metadata_acquisition_runs(run_id) ON DELETE CASCADE,
    FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS metadata_source_records (
    record_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    source_item_key TEXT NOT NULL,
    body_hash TEXT NOT NULL,
    parser_version TEXT NOT NULL,
    summary_json TEXT NOT NULL DEFAULT '{}',
    observed_at TEXT NOT NULL,
    UNIQUE (source, source_item_key, body_hash, parser_version)
  );

  CREATE INDEX IF NOT EXISTS idx_metadata_source_records_item
    ON metadata_source_records(source, source_item_key, observed_at DESC);

  CREATE TABLE IF NOT EXISTS metadata_translation_cache (
    source_text TEXT NOT NULL,
    target_lang TEXT NOT NULL,
    provider TEXT NOT NULL,
    translated_text TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (source_text, target_lang, provider)
  );

  CREATE TABLE IF NOT EXISTS media_metadata_facets (
    normalized_code TEXT NOT NULL,
    facet_type TEXT NOT NULL,
    facet_value TEXT NOT NULL,
    PRIMARY KEY (normalized_code, facet_type, facet_value)
  );

  CREATE INDEX IF NOT EXISTS idx_metadata_facets_type_value
    ON media_metadata_facets(facet_type, facet_value);
  CREATE INDEX IF NOT EXISTS idx_metadata_facets_type_value_code
    ON media_metadata_facets(facet_type, facet_value, normalized_code);
  CREATE INDEX IF NOT EXISTS idx_metadata_facets_code
    ON media_metadata_facets(normalized_code);

  CREATE TABLE IF NOT EXISTS playback_progress (
    relative_path TEXT PRIMARY KEY,
    media_id TEXT NOT NULL DEFAULT '',
    position_seconds REAL NOT NULL DEFAULT 0,
    duration_seconds REAL,
    completed INTEGER NOT NULL DEFAULT 0,
    play_count INTEGER NOT NULL DEFAULT 0,
    last_played_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_playback_media_id ON playback_progress(media_id);
  CREATE INDEX IF NOT EXISTS idx_playback_last_played ON playback_progress(last_played_at);
  CREATE INDEX IF NOT EXISTS idx_playback_completed_last_played ON playback_progress(completed, last_played_at DESC);

  CREATE TABLE IF NOT EXISTS playback_progress_quarantine (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    relative_path TEXT NOT NULL DEFAULT '',
    media_id TEXT NOT NULL DEFAULT '',
    raw_json TEXT NOT NULL,
    reason TEXT NOT NULL,
    quarantined_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_playback_quarantine_date
    ON playback_progress_quarantine(quarantined_at DESC);

  CREATE TABLE IF NOT EXISTS app_cache_state (
    cache_key TEXT PRIMARY KEY,
    source_signature TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS library_analytics_cache (
    cache_key TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_library_analytics_cache_expiry
    ON library_analytics_cache(expires_at);

  CREATE TABLE IF NOT EXISTS saved_filters (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    query_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_saved_filters_updated
    ON saved_filters(updated_at DESC);

  CREATE TABLE IF NOT EXISTS playlists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'manual',
    query_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_playlists_updated
    ON playlists(updated_at DESC);

  CREATE TABLE IF NOT EXISTS playlist_items (
    playlist_id TEXT NOT NULL,
    media_id TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    added_at TEXT NOT NULL,
    PRIMARY KEY (playlist_id, media_id),
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_playlist_items_order
    ON playlist_items(playlist_id, position, added_at);

  CREATE TABLE IF NOT EXISTS entity_favorites (
    facet_type TEXT NOT NULL,
    facet_value TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    PRIMARY KEY (facet_type, facet_value)
  );

  CREATE INDEX IF NOT EXISTS idx_entity_favorites_created
    ON entity_favorites(created_at DESC);

  CREATE TABLE IF NOT EXISTS topic_covers (
    facet_type TEXT NOT NULL,
    facet_value TEXT NOT NULL,
    media_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (facet_type, facet_value),
    FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_topic_covers_media
    ON topic_covers(media_id);

  CREATE TABLE IF NOT EXISTS entity_profiles (
    facet_type TEXT NOT NULL,
    facet_value TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    names_json TEXT NOT NULL DEFAULT '{}',
    aliases_json TEXT NOT NULL DEFAULT '[]',
    biography TEXT NOT NULL DEFAULT '',
    birth_date TEXT,
    birthplace TEXT NOT NULL DEFAULT '',
    nationality TEXT NOT NULL DEFAULT '',
    height_cm REAL,
    measurements_json TEXT NOT NULL DEFAULT '{}',
    facts_json TEXT NOT NULL DEFAULT '{}',
    occupations_json TEXT NOT NULL DEFAULT '[]',
    image_url TEXT NOT NULL DEFAULT '',
    official_website TEXT NOT NULL DEFAULT '',
    social_links_json TEXT NOT NULL DEFAULT '{}',
    external_ids_json TEXT NOT NULL DEFAULT '{}',
    wikidata_id TEXT NOT NULL DEFAULT '',
    wikipedia_url TEXT NOT NULL DEFAULT '',
    source_status TEXT NOT NULL DEFAULT 'unverified',
    confidence REAL NOT NULL DEFAULT 0,
    fetched_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (facet_type, facet_value)
  );

  CREATE INDEX IF NOT EXISTS idx_entity_profiles_wikidata
    ON entity_profiles(wikidata_id) WHERE wikidata_id != '';
  CREATE INDEX IF NOT EXISTS idx_entity_profiles_status_updated
    ON entity_profiles(source_status, updated_at DESC);

  CREATE TABLE IF NOT EXISTS entity_profile_sources (
    id TEXT PRIMARY KEY,
    facet_type TEXT NOT NULL,
    facet_value TEXT NOT NULL,
    provider TEXT NOT NULL,
    source_title TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL,
    license TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT '',
    fields_json TEXT NOT NULL DEFAULT '[]',
    payload_json TEXT NOT NULL DEFAULT '{}',
    confidence REAL NOT NULL DEFAULT 0,
    retrieved_at TEXT NOT NULL,
    UNIQUE (facet_type, facet_value, provider, source_url),
    FOREIGN KEY (facet_type, facet_value)
      REFERENCES entity_profiles(facet_type, facet_value) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_entity_profile_sources_entity
    ON entity_profile_sources(facet_type, facet_value, retrieved_at DESC);

  CREATE TABLE IF NOT EXISTS entity_profile_enrichment (
    facet_type TEXT NOT NULL,
    facet_value TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    matched_external_id TEXT NOT NULL DEFAULT '',
    confidence REAL NOT NULL DEFAULT 0,
    last_error_code TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '',
    decision_method TEXT NOT NULL DEFAULT '',
    decision_reason TEXT NOT NULL DEFAULT '',
    last_attempt_at TEXT,
    next_retry_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (facet_type, facet_value)
  );

  CREATE INDEX IF NOT EXISTS idx_entity_profile_enrichment_status
    ON entity_profile_enrichment(facet_type, status, next_retry_at, updated_at DESC);

  CREATE TABLE IF NOT EXISTS recommendation_feedback (
    anchor_media_id TEXT NOT NULL,
    media_id TEXT NOT NULL,
    feedback_type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (anchor_media_id, media_id, feedback_type),
    FOREIGN KEY (anchor_media_id) REFERENCES media_files(id) ON DELETE CASCADE,
    FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_recommendation_feedback_media
    ON recommendation_feedback(media_id, feedback_type, created_at DESC);

  CREATE TABLE IF NOT EXISTS viewing_sessions (
    id TEXT PRIMARY KEY,
    preset TEXT NOT NULL DEFAULT 'explore',
    config_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_viewing_sessions_status_updated
    ON viewing_sessions(status, updated_at DESC);

  CREATE TABLE IF NOT EXISTS viewing_session_items (
    session_id TEXT NOT NULL,
    media_id TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    lane TEXT NOT NULL DEFAULT 'core',
    reason TEXT NOT NULL DEFAULT '',
    score REAL NOT NULL DEFAULT 0,
    feedback TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (session_id, media_id),
    FOREIGN KEY (session_id) REFERENCES viewing_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_viewing_session_items_order
    ON viewing_session_items(session_id, position);

  CREATE INDEX IF NOT EXISTS idx_viewing_session_items_feedback
    ON viewing_session_items(media_id, feedback, updated_at DESC);

  CREATE TABLE IF NOT EXISTS viewing_arena_rounds (
    session_id TEXT NOT NULL,
    round_index INTEGER NOT NULL,
    left_media_id TEXT NOT NULL,
    right_media_id TEXT NOT NULL,
    winner_media_id TEXT,
    decision TEXT NOT NULL DEFAULT '',
    strategy TEXT NOT NULL DEFAULT 'anchor',
    prompt TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (session_id, round_index),
    FOREIGN KEY (session_id) REFERENCES viewing_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (left_media_id) REFERENCES media_files(id) ON DELETE CASCADE,
    FOREIGN KEY (right_media_id) REFERENCES media_files(id) ON DELETE CASCADE,
    FOREIGN KEY (winner_media_id) REFERENCES media_files(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_viewing_arena_rounds_session
    ON viewing_arena_rounds(session_id, round_index);

  CREATE TABLE IF NOT EXISTS metadata_quality_issues (
    normalized_code TEXT NOT NULL,
    issue_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'warning',
    details_json TEXT NOT NULL DEFAULT '{}',
    detected_at TEXT NOT NULL,
    PRIMARY KEY (normalized_code, issue_type)
  );

  CREATE INDEX IF NOT EXISTS idx_metadata_quality_issue_type
    ON metadata_quality_issues(issue_type, severity, detected_at DESC);

  CREATE TABLE IF NOT EXISTS topic_stats (
    facet_type TEXT NOT NULL,
    facet_value TEXT NOT NULL,
    display_label TEXT NOT NULL DEFAULT '',
    aliases_json TEXT NOT NULL DEFAULT '[]',
    media_count INTEGER NOT NULL DEFAULT 0,
    latest_release_date TEXT,
    cover_media_id TEXT,
    source_signature TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (facet_type, facet_value)
  );

  CREATE INDEX IF NOT EXISTS idx_topic_stats_type_count
    ON topic_stats(facet_type, media_count DESC, display_label);

  CREATE TABLE IF NOT EXISTS media_sidecars (
    id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    absolute_path TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '',
    format TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0,
    mtime_ms INTEGER NOT NULL DEFAULT 0,
    scan_token TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE,
    UNIQUE(media_id, absolute_path)
  );

  CREATE INDEX IF NOT EXISTS idx_media_sidecars_media_kind
    ON media_sidecars(media_id, kind);

  CREATE TABLE IF NOT EXISTS media_subtitle_cache (
    sidecar_id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL,
    path TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    bytes INTEGER NOT NULL DEFAULT 0,
    source_mtime_ms INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_accessed_at TEXT,
    FOREIGN KEY (sidecar_id) REFERENCES media_sidecars(id) ON DELETE CASCADE,
    FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_media_subtitle_cache_media_status
    ON media_subtitle_cache(media_id, status);

  CREATE TABLE IF NOT EXISTS video_subtitle_translations (
    media_id TEXT PRIMARY KEY,
    media_job_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    stage TEXT NOT NULL DEFAULT 'queued',
    progress INTEGER NOT NULL DEFAULT 0,
    stage_progress REAL NOT NULL DEFAULT 0,
    stage_started_at TEXT NOT NULL DEFAULT '',
    source_kind TEXT NOT NULL DEFAULT '',
    source_sidecar_id TEXT,
    source_language TEXT NOT NULL DEFAULT '',
    target_language TEXT NOT NULL DEFAULT 'zh-CN',
    output_path TEXT NOT NULL DEFAULT '',
    bytes INTEGER NOT NULL DEFAULT 0,
    cue_count INTEGER NOT NULL DEFAULT 0,
    translated_cue_count INTEGER NOT NULL DEFAULT 0,
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_video_subtitle_translations_status
    ON video_subtitle_translations(status, updated_at DESC);

  CREATE TABLE IF NOT EXISTS media_derivatives (
    id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    variant TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    bytes INTEGER NOT NULL DEFAULT 0,
    source_mtime_ms INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_accessed_at TEXT,
    FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE,
    UNIQUE(media_id, kind, variant)
  );

  CREATE INDEX IF NOT EXISTS idx_media_derivatives_status
    ON media_derivatives(kind, status);

  CREATE TABLE IF NOT EXISTS media_storyboards (
    media_id TEXT PRIMARY KEY,
    image_path TEXT NOT NULL DEFAULT '',
    cues_path TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    frame_count INTEGER NOT NULL DEFAULT 0,
    interval_seconds REAL NOT NULL DEFAULT 0,
    columns_count INTEGER NOT NULL DEFAULT 5,
    tile_width INTEGER NOT NULL DEFAULT 240,
    tile_height INTEGER NOT NULL DEFAULT 136,
    bytes INTEGER NOT NULL DEFAULT 0,
    source_mtime_ms INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    content_status TEXT NOT NULL DEFAULT 'missing',
    content_manifest_path TEXT NOT NULL DEFAULT '',
    content_bytes INTEGER NOT NULL DEFAULT 0,
    content_version INTEGER NOT NULL DEFAULT 0,
    content_source_signature TEXT NOT NULL DEFAULT '',
    content_error TEXT,
    content_generated_at TEXT,
    content_last_accessed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_accessed_at TEXT,
    FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_media_storyboards_status
    ON media_storyboards(status, updated_at);
  CREATE INDEX IF NOT EXISTS idx_media_derivatives_access
    ON media_derivatives(last_accessed_at);

  CREATE TABLE IF NOT EXISTS media_jobs (
    id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL DEFAULT '',
    job_type TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    payload_json TEXT NOT NULL DEFAULT '{}',
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    lease_owner TEXT NOT NULL DEFAULT '',
    lease_expires_at TEXT,
    heartbeat_at TEXT,
    retry_after TEXT,
    max_attempts INTEGER NOT NULL DEFAULT 3
  );

  CREATE INDEX IF NOT EXISTS idx_media_jobs_queue
    ON media_jobs(status, retry_after, priority DESC, created_at ASC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_media_jobs_active_unique
    ON media_jobs(media_id, job_type)
    WHERE status IN ('pending', 'running');

  CREATE TABLE IF NOT EXISTS metadata_overrides (
    normalized_code TEXT PRIMARY KEY,
    patch_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS asset_cache_index (
    cache_key TEXT PRIMARY KEY,
    asset_type TEXT NOT NULL,
    path TEXT NOT NULL,
    bytes INTEGER NOT NULL DEFAULT 0,
    source_signature TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    last_accessed_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_asset_cache_type_access
    ON asset_cache_index(asset_type, last_accessed_at);

  CREATE TABLE IF NOT EXISTS ingestion_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 0,
    schedule_time TEXT NOT NULL DEFAULT '03:00',
    timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    stable_minutes INTEGER NOT NULL DEFAULT 5,
    history_started_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ingestion_sources (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    download_root TEXT NOT NULL,
    library_root_index INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ingestion_runs (
    id TEXT PRIMARY KEY,
    trigger_type TEXT NOT NULL,
    schedule_key TEXT,
    status TEXT NOT NULL,
    phase TEXT NOT NULL,
    limit_count INTEGER,
    stats_json TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_ingestion_runs_schedule_key
    ON ingestion_runs(schedule_key) WHERE schedule_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_ingestion_runs_status
    ON ingestion_runs(status, created_at);

  CREATE TABLE IF NOT EXISTS ingestion_items (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    original_path TEXT NOT NULL,
    original_name TEXT NOT NULL,
    normalized_name TEXT NOT NULL DEFAULT '',
    normalized_code TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    target_path TEXT NOT NULL DEFAULT '',
    media_id TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    metadata_status TEXT NOT NULL DEFAULT 'pending',
    translation_status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT,
    reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES ingestion_runs(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_ingestion_items_run
    ON ingestion_items(run_id, status);
  CREATE INDEX IF NOT EXISTS idx_ingestion_items_retry
    ON ingestion_items(metadata_status, translation_status, next_retry_at);
  CREATE INDEX IF NOT EXISTS idx_ingestion_items_recent_media
    ON ingestion_items(status, media_id) WHERE media_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_ingestion_items_code_status_created
    ON ingestion_items(normalized_code, status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ingestion_items_original_path_status_created
    ON ingestion_items(original_path, status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ingestion_items_target_path_status_created
    ON ingestion_items(target_path, status, created_at DESC);

  CREATE TABLE IF NOT EXISTS ingestion_notifications (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    item_id TEXT NOT NULL UNIQUE,
    read_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES ingestion_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (item_id) REFERENCES ingestion_items(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_ingestion_notifications_unread
    ON ingestion_notifications(read_at, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ingestion_notifications_created
    ON ingestion_notifications(created_at DESC, item_id);
  CREATE INDEX IF NOT EXISTS idx_ingestion_notifications_day
    ON ingestion_notifications(date(created_at, '+8 hours'), created_at DESC, item_id);

  CREATE TABLE IF NOT EXISTS ingestion_history (
    normalized_code TEXT PRIMARY KEY,
    ingested_at TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'automatic',
    read_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_ingestion_history_date
    ON ingestion_history(ingested_at DESC, normalized_code);
  CREATE INDEX IF NOT EXISTS idx_ingestion_history_day
    ON ingestion_history(date(ingested_at, '+8 hours'), ingested_at DESC, normalized_code);

  CREATE TABLE IF NOT EXISTS download_recovery_runs (
    id TEXT PRIMARY KEY,
    trigger_type TEXT NOT NULL,
    status TEXT NOT NULL,
    scanned_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    candidate_count INTEGER NOT NULL DEFAULT 0,
    submitted_count INTEGER NOT NULL DEFAULT 0,
    deleted_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS download_recovery_tasks (
    provider_task_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL DEFAULT 'xunlei',
    task_name TEXT NOT NULL,
    normalized_code TEXT NOT NULL,
    failure_class TEXT NOT NULL,
    provider_error TEXT NOT NULL DEFAULT '',
    original_info_hash TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    selected_info_hash TEXT NOT NULL DEFAULT '',
    replacement_task_id TEXT,
    original_deleted_at TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_run_id TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (last_run_id) REFERENCES download_recovery_runs(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_download_recovery_tasks_status
    ON download_recovery_tasks(status, updated_at);
  CREATE INDEX IF NOT EXISTS idx_download_recovery_tasks_code
    ON download_recovery_tasks(normalized_code, updated_at DESC);

  CREATE TABLE IF NOT EXISTS download_recovery_attempts (
    id TEXT PRIMARY KEY,
    provider_task_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    info_hash TEXT NOT NULL,
    source_url TEXT NOT NULL,
    candidate_title TEXT NOT NULL DEFAULT '',
    result TEXT NOT NULL,
    replacement_task_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(provider_task_id, info_hash),
    FOREIGN KEY (provider_task_id) REFERENCES download_recovery_tasks(provider_task_id) ON DELETE CASCADE,
    FOREIGN KEY (run_id) REFERENCES download_recovery_runs(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_download_recovery_attempts_task
    ON download_recovery_attempts(provider_task_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS governance_action_tasks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'user-1',
    issue_key TEXT NOT NULL,
    issue_label TEXT NOT NULL,
    action_type TEXT NOT NULL,
    grain TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    target_count INTEGER NOT NULL DEFAULT 0,
    target_ids_json TEXT NOT NULL DEFAULT '[]',
    preview_json TEXT NOT NULL DEFAULT '[]',
    result_json TEXT NOT NULL DEFAULT '{}',
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    confirmed_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_governance_action_tasks_status
    ON governance_action_tasks(status, updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_governance_action_tasks_user
    ON governance_action_tasks(user_id, updated_at DESC);

  CREATE VIRTUAL TABLE IF NOT EXISTS media_search_fts USING fts5(
    media_id UNINDEXED,
    search_text,
    tokenize = 'trigram'
  );
`);

const ingestionDefaultsAt = new Date().toISOString();
db.prepare(`
  INSERT OR IGNORE INTO ingestion_settings
    (id, enabled, schedule_time, timezone, stable_minutes, updated_at)
  VALUES (1, 0, '03:00', 'Asia/Shanghai', 5, ?)
`).run(ingestionDefaultsAt);

function ensureTableColumn(table: string, name: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

function ensureMediaColumn(name: string, definition: string): void {
  ensureTableColumn("media_files", name, definition);
}

function ensureMetadataColumn(name: string, definition: string): void {
  ensureTableColumn("media_metadata", name, definition);
}

ensureTableColumn("download_recovery_runs", "deleted_count", "INTEGER NOT NULL DEFAULT 0");
ensureTableColumn("download_recovery_tasks", "original_deleted_at", "TEXT");

ensureMediaColumn("collection_bucket", "TEXT NOT NULL DEFAULT ''");
ensureMediaColumn("library_category", "TEXT NOT NULL DEFAULT 'JAV'");
ensureMediaColumn("source_name", "TEXT NOT NULL DEFAULT ''");
ensureMediaColumn("source_root", "TEXT NOT NULL DEFAULT ''");
ensureMediaColumn("code_prefix", "TEXT NOT NULL DEFAULT ''");
ensureMediaColumn("code_number", "TEXT NOT NULL DEFAULT ''");
ensureMediaColumn("normalized_code", "TEXT NOT NULL DEFAULT ''");
ensureMediaColumn("variant_tags", "TEXT NOT NULL DEFAULT '[]'");
ensureMediaColumn("random_key", "INTEGER");
ensureMediaColumn("quality_tag", "TEXT NOT NULL DEFAULT ''");
ensureMediaColumn("thumbnail_path", "TEXT");
ensureMediaColumn("thumbnail_status", "TEXT NOT NULL DEFAULT 'pending'");
ensureMediaColumn("duration_seconds", "REAL");
ensureMediaColumn("width", "INTEGER");
ensureMediaColumn("height", "INTEGER");
ensureMediaColumn("container_format", "TEXT NOT NULL DEFAULT ''");
ensureMediaColumn("video_codec", "TEXT NOT NULL DEFAULT ''");
ensureMediaColumn("audio_codec", "TEXT NOT NULL DEFAULT ''");
ensureMediaColumn("compatibility_status", "TEXT NOT NULL DEFAULT 'unknown'");
ensureMediaColumn("probe_status", "TEXT NOT NULL DEFAULT 'pending'");
ensureMediaColumn("probe_error", "TEXT");
ensureMediaColumn("probed_at", "TEXT");
ensureMediaColumn("first_seen_at", "TEXT NOT NULL DEFAULT ''");
ensureTableColumn("media_sidecars", "scan_token", "TEXT NOT NULL DEFAULT ''");
ensureTableColumn("media_jobs", "progress", "REAL NOT NULL DEFAULT 0");
ensureTableColumn("media_jobs", "phase", "TEXT NOT NULL DEFAULT ''");
ensureTableColumn("media_jobs", "lease_owner", "TEXT NOT NULL DEFAULT ''");
ensureTableColumn("media_jobs", "lease_expires_at", "TEXT");
ensureTableColumn("media_jobs", "heartbeat_at", "TEXT");
ensureTableColumn("media_jobs", "retry_after", "TEXT");
ensureTableColumn("media_jobs", "max_attempts", "INTEGER NOT NULL DEFAULT 3");
ensureTableColumn("media_storyboards", "content_status", "TEXT NOT NULL DEFAULT 'missing'");
ensureTableColumn("media_storyboards", "content_manifest_path", "TEXT NOT NULL DEFAULT ''");
ensureTableColumn("media_storyboards", "content_bytes", "INTEGER NOT NULL DEFAULT 0");
ensureTableColumn("media_storyboards", "content_version", "INTEGER NOT NULL DEFAULT 0");
ensureTableColumn("media_storyboards", "content_source_signature", "TEXT NOT NULL DEFAULT ''");
ensureTableColumn("media_storyboards", "content_error", "TEXT");
ensureTableColumn("media_storyboards", "content_generated_at", "TEXT");
ensureTableColumn("media_storyboards", "content_last_accessed_at", "TEXT");
ensureTableColumn("entity_profile_enrichment", "decision_method", "TEXT NOT NULL DEFAULT ''");
ensureTableColumn("entity_profile_enrichment", "decision_reason", "TEXT NOT NULL DEFAULT ''");
ensureTableColumn("entity_profile_enrichment", "search_names_json", "TEXT NOT NULL DEFAULT '[]'");
ensureTableColumn("entity_profiles", "facts_json", "TEXT NOT NULL DEFAULT '{}'");
ensureTableColumn("video_subtitle_translations", "stage_progress", "REAL NOT NULL DEFAULT 0");
db.prepare("UPDATE entity_profiles SET source_status = 'auto-resolved' WHERE source_status = 'needs-review'").run();
db.prepare("UPDATE entity_profile_enrichment SET status = 'auto-resolved' WHERE status = 'needs-review'").run();
ensureTableColumn("video_subtitle_translations", "stage_started_at", "TEXT NOT NULL DEFAULT ''");
ensureTableColumn("ingestion_settings", "history_started_at", "TEXT NOT NULL DEFAULT ''");
ensureTableColumn("ingestion_history", "read_at", "TEXT");
ensureTableColumn("ingestion_items", "source_mtime_ms", "REAL");
ensureTableColumn("ingestion_items", "target_mtime_ms", "REAL");
ensureTableColumn("viewing_arena_rounds", "decision", "TEXT NOT NULL DEFAULT ''");
ensureTableColumn("viewing_arena_rounds", "strategy", "TEXT NOT NULL DEFAULT 'anchor'");
ensureTableColumn("viewing_arena_rounds", "prompt", "TEXT NOT NULL DEFAULT ''");
ensureTableColumn("viewing_session_items", "lane", "TEXT NOT NULL DEFAULT 'core'");
db.exec(`UPDATE viewing_arena_rounds SET decision = 'choose' WHERE decision = '' AND winner_media_id IS NOT NULL`);
ensureMetadataColumn("preview_video_hls_url", "TEXT NOT NULL DEFAULT ''");
ensureMetadataColumn("preview_images_json", "TEXT NOT NULL DEFAULT '[]'");
ensureMetadataColumn("title_zh", "TEXT NOT NULL DEFAULT ''");
ensureMetadataColumn("summary_zh", "TEXT NOT NULL DEFAULT ''");
ensureMetadataColumn("director_zh", "TEXT NOT NULL DEFAULT ''");
ensureMetadataColumn("actors_zh_json", "TEXT NOT NULL DEFAULT '[]'");
ensureMetadataColumn("genres_zh_json", "TEXT NOT NULL DEFAULT '[]'");
ensureMetadataColumn("maker_zh", "TEXT NOT NULL DEFAULT ''");
ensureMetadataColumn("label_zh", "TEXT NOT NULL DEFAULT ''");
ensureMetadataColumn("series_zh", "TEXT NOT NULL DEFAULT ''");
ensureMetadataColumn("translation_status", "TEXT NOT NULL DEFAULT 'pending'");
ensureMetadataColumn("translation_error", "TEXT");
ensureMetadataColumn("translation_source", "TEXT NOT NULL DEFAULT ''");
ensureMetadataColumn("translation_input_hash", "TEXT NOT NULL DEFAULT ''");
ensureMetadataColumn("translated_at", "TEXT");

db.exec(`
  UPDATE media_files
  SET compatibility_status = 'transcode'
  WHERE media_type = 'video'
    AND LOWER(video_codec) IN ('hevc', 'h265')
    AND compatibility_status IN ('native', 'remux');

  UPDATE playlists
  SET kind = 'manual', query_json = '{}'
  WHERE kind = 'smart';
`);

db.prepare(`
  UPDATE ingestion_settings
  SET history_started_at = COALESCE(
    (SELECT MIN(created_at) FROM ingestion_notifications),
    ?
  )
  WHERE id = 1 AND history_started_at = ''
`).run(ingestionDefaultsAt);
db.exec(`
  UPDATE ingestion_settings
  SET history_started_at = (SELECT MIN(created_at) FROM ingestion_notifications)
  WHERE id = 1
    AND EXISTS (SELECT 1 FROM ingestion_notifications)
    AND date(history_started_at, '+8 hours') > date(
      (SELECT MIN(created_at) FROM ingestion_notifications),
      '+8 hours'
    );
`);

type IngestionHistorySeed = {
  entries?: Array<{ normalizedCode?: string; ingestedAt?: string; source?: string }>;
};

const ingestionHistorySeedPath = path.resolve("seed/ingestion-history.json");
if (fs.existsSync(ingestionHistorySeedPath)) {
  try {
    const seed = JSON.parse(fs.readFileSync(ingestionHistorySeedPath, "utf8")) as IngestionHistorySeed;
    const insertHistory = db.prepare(`
      INSERT OR IGNORE INTO ingestion_history (normalized_code, ingested_at, source)
      VALUES (@normalizedCode, @ingestedAt, @source)
    `);
    db.transaction((entries: NonNullable<IngestionHistorySeed["entries"]>) => {
      for (const entry of entries) {
        const normalizedCode = entry.normalizedCode?.trim().toUpperCase();
        if (!normalizedCode || !entry.ingestedAt) continue;
        insertHistory.run({
          normalizedCode,
          ingestedAt: entry.ingestedAt,
          source: entry.source?.trim() || "seed"
        });
      }
    })(seed.entries ?? []);
  } catch (error) {
    console.error("Ingestion history seed import failed:", error);
  }
}

db.exec(`
  INSERT OR IGNORE INTO ingestion_history (normalized_code, ingested_at, source)
  SELECT normalized_code, MIN(created_at), 'automatic'
  FROM ingestion_items
  WHERE status = 'moved' AND normalized_code != ''
  GROUP BY normalized_code;

  UPDATE ingestion_history
  SET read_at = (
    SELECT notifications.read_at
    FROM ingestion_notifications notifications
    JOIN ingestion_items items ON items.id = notifications.item_id
    WHERE items.normalized_code = ingestion_history.normalized_code
      AND notifications.read_at IS NOT NULL
    ORDER BY notifications.created_at DESC
    LIMIT 1
  )
  WHERE read_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM ingestion_notifications notifications
      JOIN ingestion_items items ON items.id = notifications.item_id
      WHERE items.normalized_code = ingestion_history.normalized_code
        AND notifications.read_at IS NOT NULL
    );
`);

db.exec(`
  DROP INDEX IF EXISTS idx_media_jobs_queue;
  CREATE INDEX IF NOT EXISTS idx_media_jobs_queue
    ON media_jobs(status, retry_after, priority DESC, created_at ASC);
  CREATE INDEX IF NOT EXISTS idx_media_storyboards_content_status
    ON media_storyboards(content_status, content_generated_at);

  UPDATE media_files
  SET first_seen_at = indexed_at
  WHERE first_seen_at = '';

  CREATE TRIGGER IF NOT EXISTS media_files_set_first_seen_at
  AFTER INSERT ON media_files
  WHEN NEW.first_seen_at = ''
  BEGIN
    UPDATE media_files SET first_seen_at = NEW.indexed_at WHERE id = NEW.id;
  END;
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_media_prefix ON media_files(code_prefix);
  CREATE INDEX IF NOT EXISTS idx_media_first_seen ON media_files(first_seen_at DESC);
  CREATE INDEX IF NOT EXISTS idx_media_code ON media_files(normalized_code);
  CREATE INDEX IF NOT EXISTS idx_media_bucket ON media_files(collection_bucket);
  CREATE INDEX IF NOT EXISTS idx_media_source ON media_files(source_name);
  CREATE INDEX IF NOT EXISTS idx_media_category ON media_files(library_category);
  CREATE INDEX IF NOT EXISTS idx_media_category_name ON media_files(library_category, name);
  CREATE INDEX IF NOT EXISTS idx_media_category_mtime ON media_files(library_category, mtime_ms);
  CREATE INDEX IF NOT EXISTS idx_media_category_size ON media_files(library_category, size);
  CREATE INDEX IF NOT EXISTS idx_media_category_letter ON media_files(library_category, first_letter);
  CREATE INDEX IF NOT EXISTS idx_media_category_bucket ON media_files(library_category, collection_bucket);
  CREATE INDEX IF NOT EXISTS idx_media_category_source ON media_files(library_category, source_name);
  CREATE INDEX IF NOT EXISTS idx_media_category_prefix ON media_files(library_category, code_prefix);
  CREATE INDEX IF NOT EXISTS idx_media_category_extension ON media_files(library_category, extension);
  CREATE INDEX IF NOT EXISTS idx_media_category_type ON media_files(library_category, media_type);
  CREATE INDEX IF NOT EXISTS idx_media_random_key ON media_files(random_key, id);
  CREATE INDEX IF NOT EXISTS idx_media_probe_status ON media_files(probe_status, media_type);
  CREATE INDEX IF NOT EXISTS idx_media_compatibility ON media_files(compatibility_status, media_type);
  CREATE INDEX IF NOT EXISTS idx_metadata_translation_status ON media_metadata(translation_status);
`);

db.exec(`
  UPDATE media_files
  SET random_key = ABS(random())
  WHERE random_key IS NULL;

  INSERT OR IGNORE INTO media_variant_tags (media_id, tag)
  SELECT media_files.id, UPPER(TRIM(tags.value))
  FROM media_files, json_each(
    CASE WHEN json_valid(media_files.variant_tags) THEN media_files.variant_tags ELSE '[]' END
  ) AS tags
  WHERE tags.type = 'text' AND TRIM(tags.value) != '';

  CREATE TRIGGER IF NOT EXISTS media_variant_tags_after_insert
  AFTER INSERT ON media_files
  BEGIN
    INSERT OR IGNORE INTO media_variant_tags (media_id, tag)
    SELECT NEW.id, UPPER(TRIM(value))
    FROM json_each(CASE WHEN json_valid(NEW.variant_tags) THEN NEW.variant_tags ELSE '[]' END)
    WHERE type = 'text' AND TRIM(value) != '';
  END;

  CREATE TRIGGER IF NOT EXISTS media_variant_tags_after_update
  AFTER UPDATE OF variant_tags ON media_files
  BEGIN
    DELETE FROM media_variant_tags WHERE media_id = NEW.id;
    INSERT OR IGNORE INTO media_variant_tags (media_id, tag)
    SELECT NEW.id, UPPER(TRIM(value))
    FROM json_each(CASE WHEN json_valid(NEW.variant_tags) THEN NEW.variant_tags ELSE '[]' END)
    WHERE type = 'text' AND TRIM(value) != '';
  END;
`);

export const dataIntegrityInitialization = initializeDataIntegrity(db);

type MetadataFacetRow = {
  normalized_code: string;
  director: string;
  actors_json: string;
  genres_json: string;
  maker: string;
  label: string;
  series: string;
};

const metadataFacetStatements = {
  countFacets: db.prepare("SELECT COUNT(*) AS count FROM media_metadata_facets"),
  countReadyMetadata: db.prepare("SELECT COUNT(*) AS count FROM media_metadata WHERE status = 'ready'"),
  selectReadyMetadata: db.prepare(`
    SELECT
      normalized_code,
      director,
      actors_json,
      genres_json,
      maker,
      label,
      series
    FROM media_metadata
    WHERE status = 'ready'
  `),
  clearAll: db.prepare("DELETE FROM media_metadata_facets"),
  clearForCode: db.prepare("DELETE FROM media_metadata_facets WHERE normalized_code = ?"),
  insertFacet: db.prepare(`
    INSERT OR IGNORE INTO media_metadata_facets (
      normalized_code,
      facet_type,
      facet_value
    )
    VALUES (
      @normalizedCode,
      @facetType,
      @facetValue
    )
  `)
};

function parseJsonStringArray(value: string | null | undefined): string[] {
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

function normalizeFacetValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function collectMetadataFacets(source: MetadataFacetSource) {
  const rows: Array<{ normalizedCode: string; facetType: MetadataFacetType; facetValue: string }> = [];
  const normalizedCode = source.normalizedCode.trim().toUpperCase();
  const seen = new Set<string>();

  function addValues(facetType: MetadataFacetType, values: Array<string | null | undefined>): void {
    for (const value of values) {
      const facetValue = normalizeFacetValue(value ?? "");
      if (!normalizedCode || !facetValue) continue;

      const key = `${facetType}:${facetValue}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ normalizedCode, facetType, facetValue });
    }
  }

  addValues("actor", source.actors ?? []);
  addValues("genre", source.genres ?? []);
  addValues("director", [source.director]);
  addValues("maker", [source.maker]);
  addValues("label", [source.label]);
  addValues("series", [source.series]);

  return rows;
}

export function clearMetadataFacetsForCode(normalizedCode: string): void {
  const code = normalizedCode.trim().toUpperCase();
  if (!code) return;
  metadataFacetStatements.clearForCode.run(code);
}

export const replaceMetadataFacetsForCode = db.transaction((source: MetadataFacetSource) => {
  const normalizedCode = source.normalizedCode.trim().toUpperCase();
  if (!normalizedCode) return;

  metadataFacetStatements.clearForCode.run(normalizedCode);

  for (const facet of collectMetadataFacets({ ...source, normalizedCode })) {
    metadataFacetStatements.insertFacet.run(facet);
  }
});

export const rebuildMetadataFacetIndex = db.transaction(() => {
  const rows = metadataFacetStatements.selectReadyMetadata.all() as MetadataFacetRow[];
  let inserted = 0;

  metadataFacetStatements.clearAll.run();

  for (const row of rows) {
    const facets = collectMetadataFacets({
      normalizedCode: row.normalized_code,
      actors: parseJsonStringArray(row.actors_json),
      genres: parseJsonStringArray(row.genres_json),
      director: row.director,
      maker: row.maker,
      label: row.label,
      series: row.series
    });

    for (const facet of facets) {
      const result = metadataFacetStatements.insertFacet.run(facet);
      inserted += result.changes;
    }
  }

  return inserted;
});

export function ensureMetadataFacetIndex(): void {
  const facetCount = metadataFacetStatements.countFacets.get() as { count: number };
  const readyCount = metadataFacetStatements.countReadyMetadata.get() as { count: number };

  if (facetCount.count === 0 && readyCount.count > 0) {
    rebuildMetadataFacetIndex();
  }
}

const compactBasenameSql = ["-", "_", " ", ".", "/", "\\", "(", ")", "[", "]"].reduce(
  (expression, token) =>
    `REPLACE(${expression}, '${token.replace("'", "''")}', '')`,
  "UPPER(media_files.basename)"
);

const MEDIA_SEARCH_CACHE_KEY = "media-search-v2";
const MEDIA_SEARCH_INDEX_VERSION = "2";

const searchDocumentSql = `
  COALESCE(media_files.name, '') || char(10) ||
  COALESCE(media_files.basename, '') || char(10) ||
  COALESCE(media_files.normalized_code, '') || char(10) ||
  COALESCE(media_files.code_prefix || media_files.code_number, '') || char(10) ||
  COALESCE(${compactBasenameSql}, '') || char(10) ||
  COALESCE(media_files.variant_tags, '') || char(10) ||
  COALESCE(media_files.quality_tag, '') || char(10) ||
  COALESCE(media_metadata.title, '') || char(10) ||
  COALESCE(media_metadata.director, '') || char(10) ||
  COALESCE(media_metadata.actors_json, '') || char(10) ||
  COALESCE(media_metadata.genres_json, '') || char(10) ||
  COALESCE(media_metadata.maker, '') || char(10) ||
  COALESCE(media_metadata.label, '') || char(10) ||
  COALESCE(media_metadata.series, '') || char(10) ||
  COALESCE(media_metadata.title_zh, '') || char(10) ||
  COALESCE(media_metadata.director_zh, '') || char(10) ||
  COALESCE(media_metadata.actors_zh_json, '') || char(10) ||
  COALESCE(media_metadata.genres_zh_json, '') || char(10) ||
  COALESCE(media_metadata.maker_zh, '') || char(10) ||
  COALESCE(media_metadata.label_zh, '') || char(10) ||
  COALESCE(media_metadata.series_zh, '') || char(10) ||
  COALESCE(json_extract(metadata_overrides.patch_json, '$.titleZh'), '') || char(10) ||
  COALESCE(json_extract(metadata_overrides.patch_json, '$.directorZh'), '') || char(10) ||
  COALESCE(json_extract(metadata_overrides.patch_json, '$.actorsZh'), '') || char(10) ||
  COALESCE(json_extract(metadata_overrides.patch_json, '$.genresZh'), '') || char(10) ||
  COALESCE(json_extract(metadata_overrides.patch_json, '$.makerZh'), '') || char(10) ||
  COALESCE(json_extract(metadata_overrides.patch_json, '$.labelZh'), '') || char(10) ||
  COALESCE(json_extract(metadata_overrides.patch_json, '$.seriesZh'), '')
`;

type MediaSearchSourceState = {
  mediaCount: number;
  maxIndexedAt: string;
  metadataCount: number;
  maxMetadataUpdatedAt: string;
  overrideCount: number;
  maxOverrideUpdatedAt: string;
};

function getMediaSearchSourceState(): MediaSearchSourceState {
  return db
    .prepare(
      `
      SELECT
        (SELECT COUNT(*) FROM media_files) AS mediaCount,
        COALESCE((SELECT MAX(indexed_at) FROM media_files), '') AS maxIndexedAt,
        (SELECT COUNT(*) FROM media_metadata) AS metadataCount,
        COALESCE((SELECT MAX(updated_at) FROM media_metadata), '') AS maxMetadataUpdatedAt,
        (SELECT COUNT(*) FROM metadata_overrides) AS overrideCount,
        COALESCE((SELECT MAX(updated_at) FROM metadata_overrides), '') AS maxOverrideUpdatedAt
    `
    )
    .get() as MediaSearchSourceState;
}

function getMediaSearchSourceSignature(state = getMediaSearchSourceState()): string {
  return [
    MEDIA_SEARCH_INDEX_VERSION,
    state.mediaCount,
    state.maxIndexedAt,
    state.metadataCount,
    state.maxMetadataUpdatedAt,
    state.overrideCount,
    state.maxOverrideUpdatedAt
  ].join(":");
}

const rebuildMediaSearchIndexTransaction = db.transaction((sourceSignature: string) => {
  db.prepare("DELETE FROM media_search_fts").run();
  const result = db
    .prepare(
      `
      INSERT INTO media_search_fts (media_id, search_text)
      SELECT
        media_files.id,
        ${searchDocumentSql}
      FROM media_files
      LEFT JOIN media_metadata
        ON media_metadata.normalized_code = media_files.normalized_code
      LEFT JOIN metadata_overrides
        ON metadata_overrides.normalized_code = media_files.normalized_code
    `
    )
    .run();

  db.prepare(
    `
    INSERT INTO app_cache_state (cache_key, source_signature, updated_at)
    VALUES (@cacheKey, @sourceSignature, @updatedAt)
    ON CONFLICT(cache_key) DO UPDATE SET
      source_signature = excluded.source_signature,
      updated_at = excluded.updated_at
  `
  ).run({ cacheKey: MEDIA_SEARCH_CACHE_KEY, sourceSignature, updatedAt: new Date().toISOString() });

  return result.changes;
});

export function rebuildMediaSearchIndex(): number {
  const inserted = rebuildMediaSearchIndexTransaction(getMediaSearchSourceSignature());
  db.pragma("optimize");
  return inserted;
}

const refreshMediaSearchIndexForCodeTransaction = db.transaction((normalizedCode: string) => {
  db.prepare(
    "DELETE FROM media_search_fts WHERE media_id IN (SELECT id FROM media_files WHERE normalized_code = ?)"
  ).run(normalizedCode);
  const inserted = db
    .prepare(
      `
      INSERT INTO media_search_fts (media_id, search_text)
      SELECT
        media_files.id,
        ${searchDocumentSql}
      FROM media_files
      LEFT JOIN media_metadata
        ON media_metadata.normalized_code = media_files.normalized_code
      LEFT JOIN metadata_overrides
        ON metadata_overrides.normalized_code = media_files.normalized_code
      WHERE media_files.normalized_code = ?
    `
    )
    .run(normalizedCode);
  db.prepare(
    `
    INSERT INTO app_cache_state (cache_key, source_signature, updated_at)
    VALUES (@cacheKey, @sourceSignature, @updatedAt)
    ON CONFLICT(cache_key) DO UPDATE SET
      source_signature = excluded.source_signature,
      updated_at = excluded.updated_at
  `
  ).run({
    cacheKey: MEDIA_SEARCH_CACHE_KEY,
    sourceSignature: getMediaSearchSourceSignature(),
    updatedAt: new Date().toISOString()
  });
  return inserted.changes;
});

export function refreshMediaSearchIndexForCode(normalizedCode: string): number {
  const code = normalizedCode.trim().toUpperCase();
  return code ? refreshMediaSearchIndexForCodeTransaction(code) : 0;
}

export function ensureMediaSearchIndex(): { rebuilt: boolean; documents: number } {
  const sourceState = getMediaSearchSourceState();
  const sourceSignature = getMediaSearchSourceSignature(sourceState);
  const savedState = db
    .prepare("SELECT source_signature AS sourceSignature FROM app_cache_state WHERE cache_key = ?")
    .get(MEDIA_SEARCH_CACHE_KEY) as { sourceSignature: string } | undefined;
  const indexed = db.prepare("SELECT COUNT(*) AS count FROM media_search_fts").get() as { count: number };
  const shouldRebuild =
    savedState?.sourceSignature !== sourceSignature || indexed.count !== sourceState.mediaCount;

  if (shouldRebuild) {
    return { rebuilt: true, documents: rebuildMediaSearchIndex() };
  }

  return { rebuilt: false, documents: indexed.count };
}

export function getMediaSearchIndexStatus(): {
  documents: number;
  sourceDocuments: number;
  current: boolean;
} {
  const sourceState = getMediaSearchSourceState();
  const sourceSignature = getMediaSearchSourceSignature(sourceState);
  const savedState = db
    .prepare("SELECT source_signature AS sourceSignature FROM app_cache_state WHERE cache_key = ?")
    .get(MEDIA_SEARCH_CACHE_KEY) as { sourceSignature: string } | undefined;
  const indexed = db.prepare("SELECT COUNT(*) AS count FROM media_search_fts").get() as { count: number };

  return {
    documents: indexed.count,
    sourceDocuments: sourceState.mediaCount,
    current: savedState?.sourceSignature === sourceSignature && indexed.count === sourceState.mediaCount
  };
}

export const statements = {
  upsertMedia: db.prepare(`
    INSERT INTO media_files (
      id,
      library_category,
      source_name,
      source_root,
      relative_path,
      absolute_path,
      name,
      basename,
      extension,
      mime_type,
      size,
      mtime_ms,
      directory,
      first_letter,
      collection_bucket,
      code_prefix,
      code_number,
      normalized_code,
      variant_tags,
      quality_tag,
      media_type,
      thumbnail_path,
      thumbnail_status,
      duration_seconds,
      width,
      height,
      container_format,
      video_codec,
      audio_codec,
      compatibility_status,
      probe_status,
      probe_error,
      probed_at,
      indexed_at,
      scan_token
    )
    VALUES (
      @id,
      @library_category,
      @source_name,
      @source_root,
      @relative_path,
      @absolute_path,
      @name,
      @basename,
      @extension,
      @mime_type,
      @size,
      @mtime_ms,
      @directory,
      @first_letter,
      @collection_bucket,
      @code_prefix,
      @code_number,
      @normalized_code,
      @variant_tags,
      @quality_tag,
      @media_type,
      @thumbnail_path,
      @thumbnail_status,
      @duration_seconds,
      @width,
      @height,
      @container_format,
      @video_codec,
      @audio_codec,
      @compatibility_status,
      @probe_status,
      @probe_error,
      @probed_at,
      @indexed_at,
      @scan_token
    )
    ON CONFLICT(relative_path) DO UPDATE SET
      library_category = excluded.library_category,
      source_name = excluded.source_name,
      source_root = excluded.source_root,
      absolute_path = excluded.absolute_path,
      name = excluded.name,
      basename = excluded.basename,
      extension = excluded.extension,
      mime_type = excluded.mime_type,
      size = excluded.size,
      mtime_ms = excluded.mtime_ms,
      directory = excluded.directory,
      first_letter = excluded.first_letter,
      collection_bucket = excluded.collection_bucket,
      code_prefix = excluded.code_prefix,
      code_number = excluded.code_number,
      normalized_code = excluded.normalized_code,
      variant_tags = excluded.variant_tags,
      quality_tag = excluded.quality_tag,
      media_type = excluded.media_type,
      thumbnail_path = CASE
        WHEN excluded.media_type = 'image' THEN excluded.thumbnail_path
        WHEN media_files.thumbnail_status = 'ready' THEN media_files.thumbnail_path
        ELSE excluded.thumbnail_path
      END,
      thumbnail_status = CASE
        WHEN excluded.media_type = 'image' THEN excluded.thumbnail_status
        WHEN media_files.thumbnail_status = 'ready' THEN media_files.thumbnail_status
        ELSE excluded.thumbnail_status
      END,
      duration_seconds = COALESCE(media_files.duration_seconds, excluded.duration_seconds),
      width = COALESCE(media_files.width, excluded.width),
      height = COALESCE(media_files.height, excluded.height),
      container_format = CASE
        WHEN media_files.size != excluded.size OR media_files.mtime_ms != excluded.mtime_ms THEN ''
        ELSE media_files.container_format
      END,
      video_codec = CASE
        WHEN media_files.size != excluded.size OR media_files.mtime_ms != excluded.mtime_ms THEN ''
        ELSE media_files.video_codec
      END,
      audio_codec = CASE
        WHEN media_files.size != excluded.size OR media_files.mtime_ms != excluded.mtime_ms THEN ''
        ELSE media_files.audio_codec
      END,
      compatibility_status = CASE
        WHEN media_files.size != excluded.size OR media_files.mtime_ms != excluded.mtime_ms THEN 'unknown'
        ELSE media_files.compatibility_status
      END,
      probe_status = CASE
        WHEN media_files.size != excluded.size OR media_files.mtime_ms != excluded.mtime_ms THEN 'pending'
        ELSE media_files.probe_status
      END,
      probe_error = CASE
        WHEN media_files.size != excluded.size OR media_files.mtime_ms != excluded.mtime_ms THEN NULL
        ELSE media_files.probe_error
      END,
      probed_at = CASE
        WHEN media_files.size != excluded.size OR media_files.mtime_ms != excluded.mtime_ms THEN NULL
        ELSE media_files.probed_at
      END,
      indexed_at = excluded.indexed_at,
      scan_token = excluded.scan_token
  `),
  updateThumbnail: db.prepare(`
    UPDATE media_files
    SET thumbnail_path = @thumbnail_path,
        thumbnail_status = @thumbnail_status
    WHERE id = @id
  `),
  updateDuration: db.prepare(`
    UPDATE media_files
    SET duration_seconds = @duration_seconds
    WHERE id = @id
  `),
  updateMediaProbe: db.prepare(`
    UPDATE media_files
    SET duration_seconds = COALESCE(@duration_seconds, duration_seconds),
        width = COALESCE(@width, width),
        height = COALESCE(@height, height),
        container_format = @container_format,
        video_codec = @video_codec,
        audio_codec = @audio_codec,
        compatibility_status = @compatibility_status,
        probe_status = @probe_status,
        probe_error = @probe_error,
        probed_at = @probed_at
    WHERE id = @id
  `),
  deleteMissingFromScan: db.prepare(`
    DELETE FROM media_files WHERE scan_token != ?
  `),
  countAll: db.prepare("SELECT COUNT(*) AS count FROM media_files")
};
