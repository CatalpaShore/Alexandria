import { jsonRequest, requestJson } from "./http";

export type GovernanceIssueKey = "metadata" | "artwork" | "issues" | "stale" | "probeFailed" | "playbackRisk";

export type GovernanceCandidate = {
  targetId: string;
  code: string;
  mediaId: string | null;
  title: string;
  releaseDate: string | null;
  detail: string;
};

export type GovernancePreview = {
  issueKey: GovernanceIssueKey;
  issueLabel: string;
  actionType: "metadata-refresh" | "probe-refresh";
  actionLabel: string;
  grain: "works" | "files";
  total: number;
  selectedCount: number;
  truncated: boolean;
  samples: GovernanceCandidate[];
};

export type GovernanceTask = {
  id: string;
  issueKey: GovernanceIssueKey;
  issueLabel: string;
  actionType: "metadata-refresh" | "probe-refresh";
  grain: "works" | "files";
  status: "draft" | "running" | "queued" | "completed" | "failed" | "cancelled";
  targetCount: number;
  targetIds: string[];
  preview: GovernanceCandidate[];
  result: Record<string, unknown>;
  error: string;
  createdAt: string;
  confirmedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
};

export function previewGovernanceAction(issueKey: GovernanceIssueKey, limit: number): Promise<GovernancePreview> {
  return requestJson(
    "/api/governance/actions/preview",
    jsonRequest("POST", { issueKey, limit }),
    () => "无法生成治理行动预览"
  );
}

export function createGovernanceAction(issueKey: GovernanceIssueKey, limit: number): Promise<GovernanceTask> {
  return requestJson(
    "/api/governance/actions",
    jsonRequest("POST", { issueKey, limit }),
    () => "无法创建治理任务"
  );
}

export function executeGovernanceAction(id: string): Promise<GovernanceTask> {
  return requestJson(
    `/api/governance/actions/${encodeURIComponent(id)}/execute`,
    jsonRequest("POST", { confirm: true }),
    () => "无法执行治理任务"
  );
}

export function cancelGovernanceAction(id: string): Promise<GovernanceTask> {
  return requestJson(
    `/api/governance/actions/${encodeURIComponent(id)}/cancel`,
    jsonRequest("POST"),
    () => "无法取消治理任务"
  );
}
