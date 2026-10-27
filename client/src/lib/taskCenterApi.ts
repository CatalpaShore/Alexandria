import type { BackupJob } from "./backupApi";
import { requestJson } from "./http";

export type TaskCenterSummary = {
  attention: number;
  active: number;
  unread: number;
  completedToday: number;
};

export type GovernanceTask = {
  id: string;
  issueKey: string;
  issueLabel: string;
  actionType: string;
  grain: "works" | "files" | string;
  status: "draft" | "queued" | "running" | "completed" | "failed" | "cancelled" | string;
  targetCount: number;
  targetIds: string[];
  preview: Array<{
    targetId: string;
    code: string;
    mediaId: string | null;
    title: string;
    releaseDate: string | null;
    detail: string;
  }>;
  result: Record<string, unknown>;
  error: string;
  createdAt: string;
  confirmedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
};

export type TaskCenterMediaJob = {
  key: string;
  status: "pending" | "running" | "failed" | string;
  count: number;
  updatedAt: string;
  error: string | null;
};

export type TaskCenterIngestionRun = {
  id: string;
  status: string;
  phase: string;
  triggerType: string;
  error: string | null;
  updatedAt: string;
};

export type TaskCenterRuntime = {
  available: boolean;
  storageReady: boolean;
  reason: string | null;
};

export type TaskCenterResponse = {
  generatedAt: string;
  summary: TaskCenterSummary;
  governance: GovernanceTask[];
  mediaJobs: TaskCenterMediaJob[];
  ingestionRuns: TaskCenterIngestionRun[];
  backups: BackupJob[];
  runtimes: {
    agent: (TaskCenterRuntime & { loadedModels: string[] }) | null;
  };
};

export function fetchTaskCenter(): Promise<TaskCenterResponse> {
  return requestJson<TaskCenterResponse>("/api/task-center", { cache: "no-store" });
}
