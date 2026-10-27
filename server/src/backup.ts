import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { config } from "./config.js";

export const BACKUP_FORMAT = "adult-media-wall-backup";
export const BACKUP_FORMAT_VERSION = 2;

export type BackupArtifactRole =
  | "database"
  | "library-config"
  | "media-favorites"
  | "entity-favorites-inventory"
  | "saved-filters-inventory"
  | "playlists-inventory"
  | "playlist-items-inventory"
  | "metadata-overrides-inventory";

export type BackupArtifact = {
  role: BackupArtifactRole;
  path: string;
  bytes: number;
  sha256: string;
  records?: number;
};

export type BackupManifest = {
  format: typeof BACKUP_FORMAT;
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  createdAt: string;
  databaseUserVersion: number;
  checksumAlgorithm: "sha256";
  artifacts: BackupArtifact[];
  inventory: {
    mediaFavorites: number;
    entityFavorites: number;
    savedFilters: number;
    playlists: number;
    playlistItems: number;
    metadataOverrides: number;
  };
};

export type CreateBackupOptions = {
  database: BetterSqlite3.Database;
  outputRoot?: string;
  backupId?: string;
  libraryConfigPath?: string;
  favoritesPath?: string;
};

export type BackupValidation = {
  valid: boolean;
  backupDir: string;
  manifest: BackupManifest | null;
  manifestSha256: string;
  errors: string[];
  warnings: string[];
};

export type RestorePlan = {
  generatedAt: string;
  backupDir: string;
  manifest: BackupManifest;
  manifestSha256: string;
  confirmationToken: string;
  targetDatabasePath: string;
  targetLibraryConfigPath: string;
  targetFavoritesPath: string;
  rollbackRoot: string;
  replacements: Array<{
    role: "database" | "library-config" | "media-favorites";
    sourcePath: string;
    targetPath: string;
    sha256: string;
    bytes: number;
  }>;
  warnings: string[];
};

export type PlanRestoreOptions = {
  targetDatabasePath?: string;
  targetLibraryConfigPath?: string;
  targetFavoritesPath?: string;
  rollbackRoot?: string;
};

export type ExecuteRestoreOptions = {
  confirmationToken: string;
  closeDatabase: () => void | Promise<void>;
};

export type RestoreResult = {
  restoredAt: string;
  rollbackDir: string;
  replaced: Array<"database" | "library-config" | "media-favorites">;
  restartRequired: true;
};

type JsonRecord = Record<string, unknown>;

const MANIFEST_NAME = "manifest.json";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const REQUIRED_DATABASE_TABLES = [
  "media_files",
  "metadata_overrides",
  "entity_favorites",
  "saved_filters",
  "playlists",
  "playlist_items"
] as const;

function sanitizeBackupId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) {
    throw new Error("Backup id must contain only letters, numbers, dots, underscores, and hyphens");
  }
  return value;
}

function defaultBackupId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function isSafeRelativeArtifactPath(value: string): boolean {
  if (!value || value.includes("\\") || path.posix.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== ".." && !normalized.startsWith("../");
}

function resolveArtifactPath(root: string, relativePath: string): string {
  if (!isSafeRelativeArtifactPath(relativePath)) throw new Error(`Unsafe artifact path: ${relativePath}`);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...relativePath.split("/"));
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Artifact escapes backup directory: ${relativePath}`);
  }
  return resolved;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function restoreConfirmationToken(
  manifestSha256: string,
  targetDatabasePath: string,
  targetLibraryConfigPath: string,
  targetFavoritesPath: string
): string {
  const binding = JSON.stringify({
    manifestSha256,
    targetDatabasePath,
    targetLibraryConfigPath,
    targetFavoritesPath
  });
  return `RESTORE-${sha256Text(binding).slice(0, 12).toUpperCase()}`;
}

async function writeJsonLines(
  filePath: string,
  rows: IterableIterator<JsonRecord>
): Promise<number> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const output = await fs.promises.open(filePath, "wx");
  let count = 0;
  try {
    for (const row of rows) {
      await output.write(`${JSON.stringify(row)}\n`, undefined, "utf8");
      count += 1;
    }
    return count;
  } finally {
    await output.close();
  }
}

async function copyOptionalFile(source: string, destination: string): Promise<boolean> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Backup source is not a regular file: ${source}`);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  return true;
}

async function makeArtifact(
  root: string,
  role: BackupArtifactRole,
  relativePath: string,
  records?: number
): Promise<BackupArtifact> {
  const filePath = resolveArtifactPath(root, relativePath);
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Backup artifact is not a regular file: ${relativePath}`);
  return {
    role,
    path: relativePath,
    bytes: stat.size,
    sha256: await sha256File(filePath),
    ...(records === undefined ? {} : { records })
  };
}

function countFavoriteLines(value: string): number {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length;
}

function getUserVersion(database: BetterSqlite3.Database): number {
  return Number(database.pragma("user_version", { simple: true })) || 0;
}

function verifyDatabase(databasePath: string): { userVersion: number; counts: BackupManifest["inventory"] } {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const quickCheck = database.pragma("quick_check", { simple: true });
    if (quickCheck !== "ok") throw new Error(`SQLite quick_check failed: ${String(quickCheck)}`);
    const tables = new Set(
      (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name
      )
    );
    for (const table of REQUIRED_DATABASE_TABLES) {
      if (!tables.has(table)) throw new Error(`Backup database is missing required table: ${table}`);
    }
    const count = (table: string): number =>
      (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
    return {
      userVersion: getUserVersion(database),
      counts: {
        mediaFavorites: 0,
        entityFavorites: count("entity_favorites"),
        savedFilters: count("saved_filters"),
        playlists: count("playlists"),
        playlistItems: count("playlist_items"),
        metadataOverrides: count("metadata_overrides")
      }
    };
  } finally {
    database.close();
  }
}

export async function createBackup(options: CreateBackupOptions): Promise<{
  backupDir: string;
  manifest: BackupManifest;
}> {
  if (!options.database.open) throw new Error("Cannot back up a closed database connection");
  const outputRoot = path.resolve(options.outputRoot ?? path.join(config.dataDir, "backups"));
  const backupId = sanitizeBackupId(options.backupId ?? defaultBackupId());
  const finalDir = path.join(outputRoot, backupId);
  const tempDir = path.join(outputRoot, `.${backupId}.${process.pid}.tmp`);
  if (fs.existsSync(finalDir) || fs.existsSync(tempDir)) throw new Error(`Backup destination already exists: ${finalDir}`);
  await fs.promises.mkdir(outputRoot, { recursive: true });
  await fs.promises.mkdir(tempDir, { recursive: false });

  let snapshotDatabase: BetterSqlite3.Database | null = null;
  try {
    const artifacts: BackupArtifact[] = [];
    const databaseRelativePath = "database/media-wall.sqlite";
    const databasePath = resolveArtifactPath(tempDir, databaseRelativePath);
    await fs.promises.mkdir(path.dirname(databasePath), { recursive: true });
    await options.database.backup(databasePath);
    const databaseVerification = verifyDatabase(databasePath);
    snapshotDatabase = new Database(databasePath, { readonly: true, fileMustExist: true });
    artifacts.push(await makeArtifact(tempDir, "database", databaseRelativePath));

    const libraryConfigPath = options.libraryConfigPath ?? config.libraryConfigPath;
    const libraryConfigRelativePath = "config/library-config.json";
    if (await copyOptionalFile(libraryConfigPath, resolveArtifactPath(tempDir, libraryConfigRelativePath))) {
      artifacts.push(await makeArtifact(tempDir, "library-config", libraryConfigRelativePath));
    }

    const favoritesPath = options.favoritesPath ?? config.favoritesPath;
    const favoritesRelativePath = "favorites/media.txt";
    let mediaFavorites = 0;
    if (await copyOptionalFile(favoritesPath, resolveArtifactPath(tempDir, favoritesRelativePath))) {
      const copiedFavorites = await fs.promises.readFile(resolveArtifactPath(tempDir, favoritesRelativePath), "utf8");
      mediaFavorites = countFavoriteLines(copiedFavorites);
      artifacts.push(await makeArtifact(tempDir, "media-favorites", favoritesRelativePath, mediaFavorites));
    }

    const entityFavoritesPath = resolveArtifactPath(tempDir, "inventory/entity-favorites.jsonl");
    const entityFavorites = await writeJsonLines(
      entityFavoritesPath,
      snapshotDatabase
        .prepare(
          `SELECT facet_type AS type, facet_value AS value, label, created_at AS createdAt
           FROM entity_favorites ORDER BY facet_type, facet_value`
        )
        .iterate() as IterableIterator<JsonRecord>
    );
    artifacts.push(
      await makeArtifact(tempDir, "entity-favorites-inventory", "inventory/entity-favorites.jsonl", entityFavorites)
    );

    const savedFiltersPath = resolveArtifactPath(tempDir, "inventory/saved-filters.jsonl");
    const savedFilters = await writeJsonLines(
      savedFiltersPath,
      snapshotDatabase
        .prepare(
          `SELECT id, name, query_json AS queryJson, created_at AS createdAt, updated_at AS updatedAt
           FROM saved_filters ORDER BY id`
        )
        .iterate() as IterableIterator<JsonRecord>
    );
    artifacts.push(await makeArtifact(tempDir, "saved-filters-inventory", "inventory/saved-filters.jsonl", savedFilters));

    const playlistsPath = resolveArtifactPath(tempDir, "inventory/playlists.jsonl");
    const playlists = await writeJsonLines(
      playlistsPath,
      snapshotDatabase
        .prepare(
          `SELECT id, name, description, kind, query_json AS queryJson,
             created_at AS createdAt, updated_at AS updatedAt
           FROM playlists ORDER BY id`
        )
        .iterate() as IterableIterator<JsonRecord>
    );
    artifacts.push(await makeArtifact(tempDir, "playlists-inventory", "inventory/playlists.jsonl", playlists));

    const playlistItemsPath = resolveArtifactPath(tempDir, "inventory/playlist-items.jsonl");
    const playlistItems = await writeJsonLines(
      playlistItemsPath,
      snapshotDatabase
        .prepare(
          `SELECT playlist_id AS playlistId, media_id AS mediaId, position,
             added_at AS addedAt
           FROM playlist_items ORDER BY playlist_id, position, media_id`
        )
        .iterate() as IterableIterator<JsonRecord>
    );
    artifacts.push(
      await makeArtifact(tempDir, "playlist-items-inventory", "inventory/playlist-items.jsonl", playlistItems)
    );

    const overridesPath = resolveArtifactPath(tempDir, "inventory/metadata-overrides.jsonl");
    const metadataOverrides = await writeJsonLines(
      overridesPath,
      snapshotDatabase
        .prepare(
          `SELECT normalized_code AS normalizedCode, patch_json AS patchJson, updated_at AS updatedAt
           FROM metadata_overrides ORDER BY normalized_code`
        )
        .iterate() as IterableIterator<JsonRecord>
    );
    artifacts.push(
      await makeArtifact(tempDir, "metadata-overrides-inventory", "inventory/metadata-overrides.jsonl", metadataOverrides)
    );

    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      databaseUserVersion: databaseVerification.userVersion,
      checksumAlgorithm: "sha256",
      artifacts,
      inventory: {
        mediaFavorites,
        entityFavorites,
        savedFilters,
        playlists,
        playlistItems,
        metadataOverrides
      }
    };
    await fs.promises.writeFile(
      path.join(tempDir, MANIFEST_NAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" }
    );
    snapshotDatabase.close();
    snapshotDatabase = null;
    await fs.promises.rm(`${databasePath}-wal`, { force: true });
    await fs.promises.rm(`${databasePath}-shm`, { force: true });
    await fs.promises.rename(tempDir, finalDir);
    return { backupDir: finalDir, manifest };
  } catch (error) {
    if (snapshotDatabase?.open) snapshotDatabase.close();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function parseManifest(value: unknown): BackupManifest {
  if (!value || typeof value !== "object") throw new Error("Manifest is not an object");
  const candidate = value as Partial<BackupManifest>;
  if (candidate.format !== BACKUP_FORMAT) throw new Error("Unsupported backup format");
  if (candidate.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(`Unsupported backup format version: ${String(candidate.formatVersion)}`);
  }
  if (candidate.checksumAlgorithm !== "sha256") throw new Error("Unsupported checksum algorithm");
  if (typeof candidate.createdAt !== "string" || !Number.isFinite(Date.parse(candidate.createdAt))) {
    throw new Error("Manifest has an invalid creation timestamp");
  }
  if (!Number.isInteger(candidate.databaseUserVersion) || (candidate.databaseUserVersion ?? -1) < 0) {
    throw new Error("Manifest has an invalid database user version");
  }
  if (!Array.isArray(candidate.artifacts) || !candidate.inventory || typeof candidate.inventory !== "object") {
    throw new Error("Manifest is missing artifacts or inventory");
  }
  const allowedRoles = new Set<BackupArtifactRole>([
    "database",
    "library-config",
    "media-favorites",
    "entity-favorites-inventory",
    "saved-filters-inventory",
    "playlists-inventory",
    "playlist-items-inventory",
    "metadata-overrides-inventory"
  ]);
  for (const artifact of candidate.artifacts) {
    if (!artifact || typeof artifact !== "object") throw new Error("Manifest contains an invalid artifact");
    if (!allowedRoles.has(artifact.role)) throw new Error(`Unsupported artifact role: ${String(artifact.role)}`);
    if (!isSafeRelativeArtifactPath(artifact.path)) throw new Error(`Unsafe artifact path: ${artifact.path}`);
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0) throw new Error("Artifact has invalid byte size");
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error("Artifact has invalid SHA-256 checksum");
    if (artifact.records !== undefined && (!Number.isSafeInteger(artifact.records) || artifact.records < 0)) {
      throw new Error("Artifact has invalid record count");
    }
  }
  const inventory = candidate.inventory as Record<string, unknown>;
  for (const key of [
    "mediaFavorites",
    "entityFavorites",
    "savedFilters",
    "playlists",
    "playlistItems",
    "metadataOverrides"
  ]) {
    if (!Number.isSafeInteger(inventory[key]) || (inventory[key] as number) < 0) {
      throw new Error(`Manifest has invalid inventory count: ${key}`);
    }
  }
  return candidate as BackupManifest;
}

async function countJsonLines(filePath: string): Promise<number> {
  const input = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let count = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    JSON.parse(line) as unknown;
    count += 1;
  }
  return count;
}

export async function validateBackup(backupDirectory: string): Promise<BackupValidation> {
  const backupDir = path.resolve(backupDirectory);
  const errors: string[] = [];
  const warnings: string[] = [];
  let manifest: BackupManifest | null = null;
  let manifestSha256 = "";
  try {
    const rootStat = await fs.promises.lstat(backupDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Backup root is not a regular directory");
    const manifestPath = path.join(backupDir, MANIFEST_NAME);
    const manifestStat = await fs.promises.lstat(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error("Manifest is not a regular file");
    if (manifestStat.size > MAX_MANIFEST_BYTES) throw new Error("Manifest exceeds the maximum allowed size");
    const manifestText = await fs.promises.readFile(manifestPath, "utf8");
    manifestSha256 = sha256Text(manifestText);
    manifest = parseManifest(JSON.parse(manifestText) as unknown);

    const seenPaths = new Set<string>();
    const roleCounts = new Map<BackupArtifactRole, number>();
    for (const artifact of manifest.artifacts) {
      if (seenPaths.has(artifact.path)) throw new Error(`Duplicate artifact path: ${artifact.path}`);
      seenPaths.add(artifact.path);
      roleCounts.set(artifact.role, (roleCounts.get(artifact.role) ?? 0) + 1);
      if ((roleCounts.get(artifact.role) ?? 0) > 1) {
        throw new Error(`Duplicate artifact role: ${artifact.role}`);
      }
      const artifactPath = resolveArtifactPath(backupDir, artifact.path);
      const stat = await fs.promises.lstat(artifactPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Artifact is not a regular file: ${artifact.path}`);
      if (stat.size !== artifact.bytes) throw new Error(`Artifact size mismatch: ${artifact.path}`);
      if ((await sha256File(artifactPath)) !== artifact.sha256) {
        throw new Error(`Artifact checksum mismatch: ${artifact.path}`);
      }
      if (artifact.records !== undefined && artifact.role.endsWith("-inventory")) {
        const records = await countJsonLines(artifactPath);
        if (records !== artifact.records) throw new Error(`Artifact record count mismatch: ${artifact.path}`);
      }
    }
    if (roleCounts.get("database") !== 1) throw new Error("Backup must contain exactly one database artifact");
    for (const role of [
      "entity-favorites-inventory",
      "saved-filters-inventory",
      "playlists-inventory",
      "playlist-items-inventory",
      "metadata-overrides-inventory"
    ] as BackupArtifactRole[]) {
      if (roleCounts.get(role) !== 1) throw new Error(`Backup must contain exactly one ${role} artifact`);
    }

    const databaseArtifact = manifest.artifacts.find((artifact) => artifact.role === "database");
    if (!databaseArtifact) throw new Error("Database artifact is missing");
    const databaseVerification = verifyDatabase(resolveArtifactPath(backupDir, databaseArtifact.path));
    if (databaseVerification.userVersion !== manifest.databaseUserVersion) {
      throw new Error("Database user version does not match manifest");
    }
    if (databaseVerification.counts.entityFavorites !== manifest.inventory.entityFavorites) {
      throw new Error("Entity favorite inventory does not match database");
    }
    if (databaseVerification.counts.savedFilters !== manifest.inventory.savedFilters) {
      throw new Error("Saved filter inventory does not match database");
    }
    if (databaseVerification.counts.playlists !== manifest.inventory.playlists) {
      throw new Error("Playlist inventory does not match database");
    }
    if (databaseVerification.counts.playlistItems !== manifest.inventory.playlistItems) {
      throw new Error("Playlist item inventory does not match database");
    }
    if (databaseVerification.counts.metadataOverrides !== manifest.inventory.metadataOverrides) {
      throw new Error("Metadata override inventory does not match database");
    }
    const favoriteArtifact = manifest.artifacts.find((artifact) => artifact.role === "media-favorites");
    if ((favoriteArtifact?.records ?? 0) !== manifest.inventory.mediaFavorites) {
      throw new Error("Media favorite inventory does not match manifest artifact");
    }
    if (!manifest.artifacts.some((artifact) => artifact.role === "library-config")) {
      warnings.push("Backup has no persisted library configuration; current configuration will be retained on restore");
    }
    if (!favoriteArtifact) {
      warnings.push("Backup has no media favorites file; current media favorites will be retained on restore");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return {
    valid: errors.length === 0,
    backupDir,
    manifest,
    manifestSha256,
    errors,
    warnings
  };
}

export async function planBackupRestore(
  backupDirectory: string,
  options: PlanRestoreOptions = {}
): Promise<RestorePlan> {
  const validation = await validateBackup(backupDirectory);
  if (!validation.valid || !validation.manifest) {
    throw new Error(`Backup validation failed: ${validation.errors.join("; ")}`);
  }
  const targetDatabasePath = path.resolve(options.targetDatabasePath ?? config.databasePath);
  const targetLibraryConfigPath = path.resolve(options.targetLibraryConfigPath ?? config.libraryConfigPath);
  const targetFavoritesPath = path.resolve(options.targetFavoritesPath ?? config.favoritesPath);
  const rollbackRoot = path.resolve(options.rollbackRoot ?? path.join(config.dataDir, "restore-rollbacks"));
  if (new Set([targetDatabasePath, targetLibraryConfigPath, targetFavoritesPath]).size !== 3) {
    throw new Error("Restore database, configuration, and favorites targets must be different paths");
  }
  const targetByRole: Partial<Record<BackupArtifactRole, string>> = {
    database: targetDatabasePath,
    "library-config": targetLibraryConfigPath,
    "media-favorites": targetFavoritesPath
  };
  const replacements = (["database", "library-config", "media-favorites"] as const).flatMap((role) => {
    const artifact = validation.manifest?.artifacts.find((candidate) => candidate.role === role);
    const targetPath = targetByRole[role];
    if (!artifact || !targetPath) return [];
    return [{
      role,
      sourcePath: resolveArtifactPath(validation.backupDir, artifact.path),
      targetPath,
      sha256: artifact.sha256,
      bytes: artifact.bytes
    }];
  });
  const warnings = [...validation.warnings];
  if (!fs.existsSync(targetDatabasePath)) warnings.push("Target database does not exist, so no database rollback can be created");
  return {
    generatedAt: new Date().toISOString(),
    backupDir: validation.backupDir,
    manifest: validation.manifest,
    manifestSha256: validation.manifestSha256,
    confirmationToken: restoreConfirmationToken(
      validation.manifestSha256,
      targetDatabasePath,
      targetLibraryConfigPath,
      targetFavoritesPath
    ),
    targetDatabasePath,
    targetLibraryConfigPath,
    targetFavoritesPath,
    rollbackRoot,
    replacements,
    warnings
  };
}

async function copyAndVerify(source: string, destination: string, expectedSha256: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  if ((await sha256File(destination)) !== expectedSha256) throw new Error(`Staged restore checksum mismatch: ${source}`);
}

export async function executeBackupRestore(
  plan: RestorePlan,
  options: ExecuteRestoreOptions
): Promise<RestoreResult> {
  if (options.confirmationToken !== plan.confirmationToken) {
    throw new Error("Restore confirmation token does not match the validated plan");
  }
  if (typeof options.closeDatabase !== "function") throw new Error("Restore requires an explicit database close callback");
  const validation = await validateBackup(plan.backupDir);
  if (!validation.valid || !validation.manifest || validation.manifestSha256 !== plan.manifestSha256) {
    throw new Error(`Backup changed after planning: ${validation.errors.join("; ") || "manifest checksum mismatch"}`);
  }
  const expectedToken = restoreConfirmationToken(
    validation.manifestSha256,
    plan.targetDatabasePath,
    plan.targetLibraryConfigPath,
    plan.targetFavoritesPath
  );
  if (plan.confirmationToken !== expectedToken) throw new Error("Restore plan target binding is invalid");
  const expectedTargets = {
    database: path.resolve(plan.targetDatabasePath),
    "library-config": path.resolve(plan.targetLibraryConfigPath),
    "media-favorites": path.resolve(plan.targetFavoritesPath)
  } as const;
  if (new Set(Object.values(expectedTargets)).size !== 3) throw new Error("Restore plan contains overlapping targets");
  for (const replacement of plan.replacements) {
    const artifact = validation.manifest.artifacts.find((candidate) => candidate.role === replacement.role);
    if (
      !artifact ||
      replacement.sourcePath !== resolveArtifactPath(validation.backupDir, artifact.path) ||
      path.resolve(replacement.targetPath) !== expectedTargets[replacement.role] ||
      replacement.sha256 !== artifact.sha256 ||
      replacement.bytes !== artifact.bytes
    ) {
      throw new Error(`Restore plan replacement was modified after validation: ${replacement.role}`);
    }
  }
  if (!plan.replacements.some((replacement) => replacement.role === "database")) {
    throw new Error("Restore plan has no database replacement");
  }

  const operationId = new Date().toISOString().replace(/[:.]/g, "-");
  const rollbackDir = path.join(plan.rollbackRoot, operationId);
  const staged = plan.replacements.map((replacement) => ({
    ...replacement,
    stagedPath: path.join(path.dirname(replacement.targetPath), `.${path.basename(replacement.targetPath)}.${operationId}.restore.tmp`)
  }));
  for (const replacement of staged) {
    if (fs.existsSync(replacement.stagedPath)) throw new Error(`Restore staging file already exists: ${replacement.stagedPath}`);
  }

  try {
    for (const replacement of staged) {
      await copyAndVerify(replacement.sourcePath, replacement.stagedPath, replacement.sha256);
    }
    await options.closeDatabase();
    await fs.promises.mkdir(plan.rollbackRoot, { recursive: true });
    await fs.promises.mkdir(rollbackDir, { recursive: false });

    const rollbackArtifacts: Array<{ role: string; path: string; bytes: number; sha256: string }> = [];
    const databaseReplacement = staged.find((replacement) => replacement.role === "database");
    if (!databaseReplacement) throw new Error("Restore plan has no database replacement");
    if (fs.existsSync(databaseReplacement.targetPath)) {
      const rollbackDatabasePath = path.join(rollbackDir, "media-wall.sqlite");
      const currentDatabase = new Database(databaseReplacement.targetPath, { fileMustExist: true });
      try {
        await currentDatabase.backup(rollbackDatabasePath);
      } finally {
        currentDatabase.close();
      }
      const stat = await fs.promises.stat(rollbackDatabasePath);
      rollbackArtifacts.push({
        role: "database",
        path: "media-wall.sqlite",
        bytes: stat.size,
        sha256: await sha256File(rollbackDatabasePath)
      });
    }

    for (const replacement of staged) {
      if (replacement.role === "database" || !fs.existsSync(replacement.targetPath)) continue;
      const rollbackName = replacement.role === "library-config" ? "library-config.json" : "favorites.txt";
      const rollbackPath = path.join(rollbackDir, rollbackName);
      await fs.promises.copyFile(replacement.targetPath, rollbackPath, fs.constants.COPYFILE_EXCL);
      const stat = await fs.promises.stat(rollbackPath);
      rollbackArtifacts.push({
        role: replacement.role,
        path: rollbackName,
        bytes: stat.size,
        sha256: await sha256File(rollbackPath)
      });
    }
    await fs.promises.writeFile(
      path.join(rollbackDir, "rollback-manifest.json"),
      `${JSON.stringify({ createdAt: new Date().toISOString(), sourceBackup: plan.backupDir, artifacts: rollbackArtifacts }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" }
    );

    const replaced: RestoreResult["replaced"] = [];
    try {
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        await fs.promises.rm(`${databaseReplacement.targetPath}${suffix}`, { force: true });
      }
      for (const replacement of staged) {
        await fs.promises.rename(replacement.stagedPath, replacement.targetPath);
        replaced.push(replacement.role);
      }
    } catch (error) {
      for (const role of [...replaced].reverse()) {
        const replacement = staged.find((entry) => entry.role === role);
        const rollback = rollbackArtifacts.find((entry) => entry.role === role);
        if (!replacement) continue;
        if (role === "database") {
          for (const suffix of ["-wal", "-shm", "-journal"]) {
            await fs.promises.rm(`${replacement.targetPath}${suffix}`, { force: true });
          }
        }
        if (rollback) await fs.promises.copyFile(path.join(rollbackDir, rollback.path), replacement.targetPath);
        else await fs.promises.rm(replacement.targetPath, { force: true });
      }
      throw error;
    }

    return {
      restoredAt: new Date().toISOString(),
      rollbackDir,
      replaced,
      restartRequired: true
    };
  } finally {
    for (const replacement of staged) {
      await fs.promises.rm(replacement.stagedPath, { force: true });
    }
  }
}
