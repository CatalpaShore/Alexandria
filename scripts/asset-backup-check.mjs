import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adult-media-wall-assets-"));
const dataDir = path.join(testRoot, "data");
const thumbnailDir = path.join(dataDir, "thumbnails");
const coverDir = path.join(dataDir, "covers");
const derivativeDir = path.join(dataDir, "derivatives");
const configPath = path.join(dataDir, "library-config.json");
const favoritesPath = path.join(dataDir, "favorites.txt");

process.env.DATA_DIR = dataDir;
process.env.THUMBNAIL_DIR = thumbnailDir;
process.env.COVER_CACHE_DIR = coverDir;
process.env.DERIVATIVE_DIR = derivativeDir;
process.env.SCAN_ON_START = "false";

let restoredDatabase;
let rollbackDatabase;
let liveDatabase;

try {
  const [{ db }, { generateAssetIntegrityReport }, backupService] = await Promise.all([
    import("../server/src/db.ts"),
    import("../server/src/assetIntegrity.ts"),
    import("../server/src/backup.ts")
  ]);
  const {
    createBackup,
    validateBackup,
    planBackupRestore,
    executeBackupRestore
  } = backupService;
  liveDatabase = db;

  fs.mkdirSync(thumbnailDir, { recursive: true });
  fs.mkdirSync(coverDir, { recursive: true });
  fs.mkdirSync(derivativeDir, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({ roots: ["/media/one", "/media/two"] })}\n`);
  fs.writeFileSync(favoritesPath, "JAV/ABC-001.mp4\n");

  const now = new Date().toISOString();
  const mediaInsert = db.prepare(`
    INSERT INTO media_files (
      id, source_name, source_root, relative_path, absolute_path, name, basename,
      extension, mime_type, size, mtime_ms, directory, first_letter, media_type,
      thumbnail_path, thumbnail_status, indexed_at, scan_token, normalized_code
    ) VALUES (
      @id, 'Test', '/media', @relativePath, @absolutePath, @name, @basename,
      'mp4', 'video/mp4', 1000, 1000, 'A', 'A', 'video',
      @thumbnailPath, 'ready', @now, 'test-scan', @normalizedCode
    )
  `);
  const thumbnailOne = path.join(thumbnailDir, "media-1-m10.jpg");
  const thumbnailMissing = path.join(thumbnailDir, "media-2-m10.jpg");
  fs.writeFileSync(thumbnailOne, "thumbnail");
  fs.writeFileSync(path.join(thumbnailDir, "orphan.jpg"), "orphan");
  mediaInsert.run({
    id: "media-1",
    relativePath: "JAV/ABC-001.mp4",
    absolutePath: "/media/JAV/ABC-001.mp4",
    name: "ABC-001.mp4",
    basename: "ABC-001",
    thumbnailPath: thumbnailOne,
    normalizedCode: "ABC-001",
    now
  });
  mediaInsert.run({
    id: "media-2",
    relativePath: "JAV/ABC-002.mp4",
    absolutePath: "/media/JAV/ABC-002.mp4",
    name: "ABC-002.mp4",
    basename: "ABC-002",
    thumbnailPath: thumbnailMissing,
    normalizedCode: "ABC-002",
    now
  });

  const coverOne = path.join(coverDir, "cover-one.jpg");
  const coverMissing = path.join(coverDir, "cover-missing.jpg");
  fs.writeFileSync(coverOne, "cover");
  fs.writeFileSync(path.join(coverDir, "orphan.jpg"), "orphan-cover");
  db.prepare(`
    INSERT INTO media_metadata (
      normalized_code, cover_url, thumb_url, updated_at
    ) VALUES ('ABC-001', 'https://example.test/cover-one.jpg', '', @now)
  `).run({ now });
  const cacheInsert = db.prepare(`
    INSERT INTO asset_cache_index (
      cache_key, asset_type, path, bytes, source_signature, created_at, last_accessed_at
    ) VALUES (@key, @type, @path, @bytes, @source, @now, @now)
  `);
  cacheInsert.run({
    key: "cover:one",
    type: "cover",
    path: coverOne,
    bytes: 5,
    source: "https://example.test/cover-one.jpg",
    now
  });
  cacheInsert.run({
    key: "cover:missing",
    type: "cover",
    path: coverMissing,
    bytes: 5,
    source: "https://example.test/unused.jpg",
    now
  });

  const derivativeOne = path.join(derivativeDir, "media-1-card.webp");
  const derivativeMissing = path.join(derivativeDir, "media-2-card.webp");
  fs.writeFileSync(derivativeOne, "poster");
  fs.writeFileSync(path.join(derivativeDir, "orphan.webp"), "orphan-poster");
  const derivativeInsert = db.prepare(`
    INSERT INTO media_derivatives (
      id, media_id, kind, variant, path, mime_type, status, bytes,
      source_mtime_ms, created_at, updated_at
    ) VALUES (@id, @mediaId, 'poster', 'card', @path, 'image/webp', 'ready', 6, 1000, @now, @now)
  `);
  derivativeInsert.run({ id: "derivative-1", mediaId: "media-1", path: derivativeOne, now });
  derivativeInsert.run({ id: "derivative-2", mediaId: "media-2", path: derivativeMissing, now });
  cacheInsert.run({
    key: "derivative-1",
    type: "derivative:poster",
    path: derivativeOne,
    bytes: 6,
    source: "1000:1000",
    now
  });

  const subtitleSource = path.join(testRoot, "ABC-001.zh-CN.srt");
  const subtitleCache = path.join(derivativeDir, "subtitles", "sidecar-1.vtt");
  fs.mkdirSync(path.dirname(subtitleCache), { recursive: true });
  fs.writeFileSync(subtitleSource, "1\n00:00:01,000 --> 00:00:02,000\nTest\n");
  fs.writeFileSync(subtitleCache, "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nTest\n");
  db.prepare(`
    INSERT INTO media_sidecars (
      id, media_id, kind, absolute_path, relative_path, language, label,
      format, size, mtime_ms, scan_token, created_at, updated_at
    ) VALUES ('sidecar-1', 'media-1', 'subtitle', ?, 'JAV/Test/ABC-001.zh-CN.srt',
      'zh-CN', '简体中文', 'srt', 42, 1000, 'test-scan', ?, ?)
  `).run(subtitleSource, now, now);
  db.prepare(`
    INSERT INTO media_subtitle_cache (
      sidecar_id, media_id, path, status, bytes, source_mtime_ms,
      created_at, updated_at, last_accessed_at
    ) VALUES ('sidecar-1', 'media-1', ?, 'ready', ?, 1000, ?, ?, ?)
  `).run(subtitleCache, fs.statSync(subtitleCache).size, now, now, now);

  const storyboardDir = path.join(derivativeDir, "storyboards");
  const storyboardImage = path.join(storyboardDir, "media-1.webp");
  const storyboardCues = path.join(storyboardDir, "media-1.json");
  fs.mkdirSync(storyboardDir, { recursive: true });
  fs.writeFileSync(storyboardImage, "storyboard");
  fs.writeFileSync(storyboardCues, '{"duration":10,"cues":[]}\n');
  const storyboardBytes = fs.statSync(storyboardImage).size + fs.statSync(storyboardCues).size;
  db.prepare(`
    INSERT INTO media_storyboards (
      media_id, image_path, cues_path, status, frame_count, interval_seconds,
      columns_count, tile_width, tile_height, bytes, source_mtime_ms,
      created_at, updated_at, last_accessed_at
    ) VALUES ('media-1', ?, ?, 'ready', 12, 1, 5, 240, 136, ?, 1000, ?, ?, ?)
  `).run(storyboardImage, storyboardCues, storyboardBytes, now, now, now);
  cacheInsert.run({
    key: "storyboard:media-1",
    type: "derivative:storyboard",
    path: storyboardImage,
    bytes: storyboardBytes,
    source: "1000:1000",
    now
  });

  db.prepare(
    "INSERT INTO metadata_overrides (normalized_code, patch_json, updated_at) VALUES ('ABC-001', ?, ?)"
  ).run('{"title":"Original"}', now);
  db.prepare(
    "INSERT INTO entity_favorites (facet_type, facet_value, label, created_at) VALUES ('actor', 'Actor A', 'Actor A', ?)"
  ).run(now);
  db.prepare(
    "INSERT INTO saved_filters (id, name, query_json, created_at, updated_at) VALUES ('filter-1', 'Filter', '{}', ?, ?)"
  ).run(now, now);
  db.prepare(
    "INSERT INTO playlists (id, name, description, kind, query_json, created_at, updated_at) VALUES ('playlist-1', 'Queue', '', 'manual', '{}', ?, ?)"
  ).run(now, now);
  db.prepare(
    "INSERT INTO playlist_items (playlist_id, media_id, position, added_at) VALUES ('playlist-1', 'media-1', 0, ?)"
  ).run(now);

  const report = await generateAssetIntegrityReport({
    database: db,
    thumbnailDir,
    coverCacheDir: coverDir,
    derivativeDir,
    sampleLimit: 20
  });
  assert.equal(report.readOnly, true);
  assert.equal(report.assets.thumbnail.present, 1);
  assert.equal(report.assets.thumbnail.missing, 1);
  assert.equal(report.assets.thumbnail.orphanFiles, 1);
  assert.equal(report.assets.cover.present, 1);
  assert.equal(report.assets.cover.missing, 1);
  assert.equal(report.assets.cover.orphanFiles, 1);
  assert.equal(report.assets.cover.orphanIndexEntries, 1);
  assert.equal(report.assets.derivative.present, 4);
  assert.equal(report.assets.derivative.missing, 1);
  assert.equal(report.assets.derivative.orphanFiles, 1);
  assert.equal(report.assets.derivative.orphanIndexEntries, 0);
  assert.equal(
    db.prepare("SELECT patch_json AS patch FROM metadata_overrides WHERE normalized_code = 'ABC-001'").get().patch,
    '{"title":"Original"}'
  );

  const backup = await createBackup({
    database: db,
    outputRoot: path.join(testRoot, "backups"),
    backupId: "self-test",
    libraryConfigPath: configPath,
    favoritesPath
  });
  const validBackup = await validateBackup(backup.backupDir);
  assert.equal(validBackup.valid, true, validBackup.errors.join("; "));
  assert.equal(backup.manifest.inventory.mediaFavorites, 1);
  assert.equal(backup.manifest.inventory.entityFavorites, 1);
  assert.equal(backup.manifest.inventory.savedFilters, 1);
  assert.equal(backup.manifest.inventory.playlists, 1);
  assert.equal(backup.manifest.inventory.playlistItems, 1);
  assert.equal(backup.manifest.inventory.metadataOverrides, 1);

  const tamperedBackup = path.join(testRoot, "tampered-backup");
  fs.cpSync(backup.backupDir, tamperedBackup, { recursive: true });
  fs.appendFileSync(path.join(tamperedBackup, "inventory", "metadata-overrides.jsonl"), "{}\n");
  const tamperedValidation = await validateBackup(tamperedBackup);
  assert.equal(tamperedValidation.valid, false);
  assert.match(tamperedValidation.errors.join("; "), /size mismatch|checksum mismatch/i);

  db.prepare("UPDATE metadata_overrides SET patch_json = ? WHERE normalized_code = 'ABC-001'").run(
    '{"title":"Modified"}'
  );
  fs.writeFileSync(configPath, `${JSON.stringify({ roots: ["/changed/one", "/changed/two"] })}\n`);
  fs.writeFileSync(favoritesPath, "JAV/CHANGED-001.mp4\n");

  const plan = await planBackupRestore(backup.backupDir, {
    targetDatabasePath: path.join(dataDir, "media-wall.sqlite"),
    targetLibraryConfigPath: configPath,
    targetFavoritesPath: favoritesPath,
    rollbackRoot: path.join(dataDir, "restore-rollbacks")
  });
  assert.equal(
    db.prepare("SELECT patch_json AS patch FROM metadata_overrides WHERE normalized_code = 'ABC-001'").get().patch,
    '{"title":"Modified"}',
    "Planning a restore must not modify the live database"
  );

  let closeCalls = 0;
  await assert.rejects(
    executeBackupRestore(plan, {
      confirmationToken: "RESTORE-WRONG",
      closeDatabase: () => {
        closeCalls += 1;
      }
    }),
    /confirmation token/i
  );
  assert.equal(closeCalls, 0, "An invalid confirmation token must not close or replace the database");

  const modifiedPlan = structuredClone(plan);
  modifiedPlan.replacements[0].targetPath = path.join(testRoot, "unexpected.sqlite");
  await assert.rejects(
    executeBackupRestore(modifiedPlan, {
      confirmationToken: modifiedPlan.confirmationToken,
      closeDatabase: () => {
        closeCalls += 1;
      }
    }),
    /modified after validation/i
  );
  assert.equal(closeCalls, 0, "A modified restore plan must not close or replace the database");

  const restored = await executeBackupRestore(plan, {
    confirmationToken: plan.confirmationToken,
    closeDatabase: () => {
      closeCalls += 1;
      db.close();
      liveDatabase = undefined;
    }
  });
  assert.equal(closeCalls, 1);
  assert.deepEqual(restored.replaced, ["database", "library-config", "media-favorites"]);
  assert.equal(restored.restartRequired, true);

  restoredDatabase = new Database(path.join(dataDir, "media-wall.sqlite"), { readonly: true });
  assert.equal(
    restoredDatabase
      .prepare("SELECT patch_json AS patch FROM metadata_overrides WHERE normalized_code = 'ABC-001'")
      .get().patch,
    '{"title":"Original"}'
  );
  assert.match(fs.readFileSync(configPath, "utf8"), /\/media\/one/);
  assert.equal(fs.readFileSync(favoritesPath, "utf8"), "JAV/ABC-001.mp4\n");

  rollbackDatabase = new Database(path.join(restored.rollbackDir, "media-wall.sqlite"), { readonly: true });
  assert.equal(
    rollbackDatabase
      .prepare("SELECT patch_json AS patch FROM metadata_overrides WHERE normalized_code = 'ABC-001'")
      .get().patch,
    '{"title":"Modified"}',
    "Rollback database must preserve the state from immediately before restore"
  );
  assert.equal(fs.existsSync(path.join(restored.rollbackDir, "rollback-manifest.json")), true);

  console.log("Asset integrity and backup/restore self-test passed");
  console.log(JSON.stringify({
    integrityIssues: report.issues.length,
    backupArtifacts: backup.manifest.artifacts.length,
    rollbackDir: restored.rollbackDir
  }, null, 2));
} finally {
  if (liveDatabase?.open) liveDatabase.close();
  rollbackDatabase?.close();
  restoredDatabase?.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
}
