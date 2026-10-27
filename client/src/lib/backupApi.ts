import { jsonRequest, requestJson } from "./http";

export type BackupScope = "app-data" | "project-code" | "generated-assets";
export type BackupJobStatus = "queued" | "scanning" | "running" | "paused" | "completed" | "failed" | "cancelled";

export type BackupSettings = {
  enabled: boolean;
  targetRoot: string;
  frequency: "daily" | "weekly";
  hour: number;
  weekday: number;
  scopes: BackupScope[];
  updatedAt: string;
};

export type BackupTarget = {
  targetRoot: string;
  available: boolean;
  writable: boolean;
  freeBytes: number | null;
  isDefaultT7: boolean;
  error?: string;
};

export type BackupJobPart = {
  id: string;
  label: string;
  filesTotal: number;
  filesCopied: number;
  filesSkipped: number;
  bytesTotal: number;
  bytesCopied: number;
  bytesSkipped: number;
};

export type BackupJob = {
  id: string;
  trigger: "manual" | "automatic";
  status: BackupJobStatus;
  targetRoot: string;
  scopes: BackupScope[];
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  currentFile?: string;
  filesTotal: number;
  filesCopied: number;
  filesSkipped: number;
  bytesTotal: number;
  bytesCopied: number;
  bytesSkipped: number;
  parts?: BackupJobPart[];
  excludedSources: string[];
  error?: string;
};

export type BackupCenterResponse = {
  settings: BackupSettings;
  target: BackupTarget;
  jobs: BackupJob[];
  defaultTargetRoot: string;
  scopes: BackupScope[];
};

export function fetchBackupCenter(): Promise<BackupCenterResponse> {
  return requestJson<BackupCenterResponse>("/api/backup-center", { cache: "no-store" });
}

export function inspectBackupTarget(targetRoot: string): Promise<BackupTarget> {
  return requestJson<BackupTarget>("/api/backup-center/inspect-target", jsonRequest("POST", { targetRoot }));
}

export function updateBackupSettings(settings: Omit<BackupSettings, "updatedAt">): Promise<{ settings: BackupSettings; target: BackupTarget }> {
  return requestJson("/api/backup-center/settings", jsonRequest("PUT", settings));
}

export function createBackupJob(input: { targetRoot: string; scopes: BackupScope[] }): Promise<BackupJob> {
  return requestJson("/api/backup-center/jobs", jsonRequest("POST", input));
}

export function controlBackupJob(id: string, action: "pause" | "resume" | "cancel"): Promise<BackupJob> {
  return requestJson(`/api/backup-center/jobs/${encodeURIComponent(id)}/control`, jsonRequest("POST", { action }));
}
