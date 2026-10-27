import type { TopicType } from "./api";
import { requestJson } from "./http";

export type PersonalDashboardData = {
  stats: {
    played: number;
    inProgress: number;
    completed: number;
    watchSeconds: number;
    favoriteCount: number;
    playlistCount: number;
  };
  month: {
    played: number;
    completed: number;
    watchSeconds: number;
    topEntities: Array<{ type: TopicType; value: string; label: string; count: number }>;
  };
  trend: Array<{ month: string; played: number; completed: number; watchSeconds: number }>;
  favoriteUpdates: Array<{
    type: TopicType;
    value: string;
    label: string;
    followedAt: string;
    newCount: number;
  }>;
  recommendationAnchor: string | null;
};

export async function fetchPersonalDashboard(): Promise<PersonalDashboardData> {
  return requestJson<PersonalDashboardData>("/api/personal-dashboard", { cache: "no-store" });
}

export function getPersonalDataExportUrl(): string {
  return "/api/personal-data/export";
}

export async function importPersonalData(text: string): Promise<{ imported: Record<string, number>; skippedMedia: number }> {
  return requestJson<{ imported: Record<string, number>; skippedMedia: number }>("/api/personal-data/import", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text })
  }, (status) => `导入失败：${status}`);
}
