import { jsonRequest, requestJson as requestHttpJson } from "./http";

export type AssetIntegrityKind = "thumbnail" | "cover" | "derivative";

export type AssetIntegrityBucket = {
  indexed: number;
  indexedBytes: number;
  present: number;
  missing: number;
  unsafePaths: number;
  scannedFiles: number;
  scannedBytes: number;
  orphanFiles: number;
  orphanBytes: number;
  orphanIndexEntries: number;
};

export type AssetIntegrityIssue = {
  kind: AssetIntegrityKind | "database";
  code: string;
  path?: string;
  reference?: string;
  detail: string;
};

export type AssetIntegrityReport = {
  generatedAt: string;
  durationMs: number;
  readOnly: true;
  sampleLimit: number;
  truncatedIssueSamples: number;
  assets: Record<AssetIntegrityKind, AssetIntegrityBucket>;
  database: {
    orphanDerivatives: number;
    orphanSidecars: number;
    unlinkedMetadata: number;
    invalidThumbnailStates: number;
    duplicateAssetPaths: number;
  };
  traversal: {
    skippedSymlinks: number;
    unreadableEntries: number;
  };
  issues: AssetIntegrityIssue[];
};

export type IntegrityResponse = {
  running: boolean;
  report: AssetIntegrityReport | null;
};

export type BackupInventory = {
  mediaFavorites?: number;
  entityFavorites?: number;
  savedFilters?: number;
  metadataOverrides?: number;
  [key: string]: number | undefined;
};

export type BackupListItem = {
  id: string;
  createdAt: string;
  bytes: number;
  inventory?: BackupInventory;
  invalid?: boolean;
};

export type BackupArtifact = {
  role: string;
  path: string;
  bytes: number;
  sha256: string;
  records?: number;
};

export type BackupManifest = {
  format: string;
  formatVersion: number;
  createdAt: string;
  databaseUserVersion: number;
  checksumAlgorithm: string;
  artifacts: BackupArtifact[];
  inventory: BackupInventory;
};

export type BackupListResponse = {
  items: BackupListItem[];
  backupRoot: string;
};

export type CreateBackupResponse = {
  id: string;
  backupDir: string;
  manifest: BackupManifest;
};

export type BackupValidation = {
  valid: boolean;
  backupDir: string;
  manifest: BackupManifest | null;
  manifestSha256: string;
  errors: string[];
  warnings: string[];
};

export type RestoreReplacement = {
  role: "database" | "library-config" | "media-favorites";
  sourcePath: string;
  targetPath: string;
  sha256: string;
  bytes: number;
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
  replacements: RestoreReplacement[];
  warnings: string[];
};

export type RestoreResult = {
  restoredAt: string;
  rollbackDir: string;
  replaced: Array<"database" | "library-config" | "media-favorites">;
  restartRequired: true;
};

function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  return requestHttpJson(url, init, (status) => `请求失败：${status}`);
}

export function fetchIntegrityReport(): Promise<IntegrityResponse> {
  return requestJson<IntegrityResponse>("/api/maintenance/integrity", { cache: "no-store" });
}

export function startIntegrityScan(): Promise<IntegrityResponse> {
  return requestJson<IntegrityResponse>("/api/maintenance/integrity", jsonRequest("POST"));
}

export function fetchBackups(): Promise<BackupListResponse> {
  return requestJson<BackupListResponse>("/api/maintenance/backups", { cache: "no-store" });
}

export function createBackup(id?: string): Promise<CreateBackupResponse> {
  return requestJson<CreateBackupResponse>(
    "/api/maintenance/backups",
    jsonRequest("POST", id ? { id } : {})
  );
}

export function validateBackup(id: string): Promise<BackupValidation> {
  return requestJson<BackupValidation>(
    `/api/maintenance/backups/${encodeURIComponent(id)}/validate`,
    { cache: "no-store" }
  );
}

export function createRestorePlan(id: string): Promise<RestorePlan> {
  return requestJson<RestorePlan>(
    `/api/maintenance/backups/${encodeURIComponent(id)}/restore-plan`,
    jsonRequest("POST")
  );
}

export function restoreBackup(id: string, confirmationToken: string): Promise<RestoreResult> {
  return requestJson<RestoreResult>(
    `/api/maintenance/backups/${encodeURIComponent(id)}/restore`,
    jsonRequest("POST", { confirmationToken })
  );
}
