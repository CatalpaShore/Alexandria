import { getIntlLocale } from "../i18n/core";
import { t, useLocale } from "../i18n";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Drawer, Empty, Skeleton, Tag, Tooltip, Typography } from "antd";
import {
  Activity,
  Bot,
  CheckCheck,
  CheckCircle2,
  CircleAlert,
  Clock3,
  DatabaseBackup,
  Film,
  FolderInput,
  HardDrive,
  RefreshCw,
  ShieldCheck
} from "lucide-react";
import {
  getPosterUrl,
  markAllNotificationsRead,
  markNotificationRead
} from "../lib/api";
import {
  fetchTaskCenter,
  type GovernanceTask,
  type TaskCenterIngestionRun,
  type TaskCenterMediaJob,
  type TaskCenterResponse
} from "../lib/taskCenterApi";
import { PosterImage } from "./PosterImage";
import "../ingestion-operations.css";

const { Text } = Typography;

type Props = {
  open: boolean;
  onClose: () => void;
  onOpenMedia: (id: string) => void;
};

type StageStatus = "ready" | "processing" | "attention";

type CompletionStage = {
  status: StageStatus;
  label: string;
  detail: string;
};

type NotificationItem = {
  id: string;
  readAt: string | null;
  createdAt: string;
  ingestionDay: string;
  mediaId: string | null;
  normalizedCode: string;
  category: string;
  sourceId: string;
  itemReason: string | null;
  runId: string | null;
  runStatus: string;
  title: string;
  actors: string[];
  completion: {
    overallStatus: StageStatus;
    reason: string;
    stages: Record<"file" | "metadata" | "translation" | "cover", CompletionStage>;
  };
};

type NotificationGroup = {
  key: string;
  ingestionDay: string;
  runId: string | null;
  triggerType: string | null;
  runStatus: string;
  createdAt: string;
  runStats: {
    eligible: number;
    moved: number;
    unstable: number;
    conflicts: number;
    failed: number;
  } | null;
  counts: Record<"ready" | "processing" | "attention" | "unread", number>;
  items: NotificationItem[];
};

type NotificationsResponse = {
  items: NotificationItem[];
  groups: NotificationGroup[];
  hasMore: boolean;
};

const NOTIFICATION_PAGE_SIZE = 120;

async function fetchNotificationGroups(limit: number): Promise<NotificationsResponse> {
  const response = await fetch(`/api/notifications?limit=${limit}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`通知加载失败 (${response.status})`);
  return response.json() as Promise<NotificationsResponse>;
}

function dayLabel(value: string): string {
  const date = new Date(`${value}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(now);
  const yesterday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(now.getTime() - 86_400_000));
  const prefix = value === today ? t("今天") : value === yesterday ? t("昨天") : "";
  const formatted = new Intl.DateTimeFormat(getIntlLocale(), {
    month: "long", day: "numeric", weekday: "short", timeZone: "Asia/Shanghai"
  }).format(date);
  return prefix ? `${prefix} · ${formatted}` : formatted;
}

function completionLabel(status: StageStatus): string {
  if (status === "ready") return "处理完成";
  if (status === "attention") return "需要处理";
  return "处理中";
}

function NotificationStageStrip({ item }: { item: NotificationItem }) {
  useLocale();
  return (
    <div className="notification-stage-strip" aria-label={item.completion.reason}>
      {Object.entries(item.completion.stages).map(([key, stage]) => (
        <Tooltip key={key} title={stage.detail}>
          <span className={`notification-stage is-${stage.status}`}>
            <i />
            {stage.label}
          </span>
        </Tooltip>
      ))}
    </div>
  );
}

type TaskVisualState = "attention" | "active" | "ready" | "idle";

const governanceStatusLabels: Record<string, string> = {
  draft: "待确认",
  queued: "排队中",
  running: "执行中",
  completed: "已完成",
  failed: "执行失败",
  cancelled: "已取消"
};

const mediaJobLabels: Record<string, string> = {
  probe: "技术探测",
  thumbnail: "缩略图生成",
  "poster-card": "列表海报",
  "poster-detail": "详情海报",
  remux: "封装转换",
  hls: "流媒体切片",
  storyboard: "故事板生成",
  "content-preview": "内容预览",
  subtitle: "字幕处理",
  "subtitle-translate": "字幕翻译"
};

const ingestionPhaseLabels: Record<string, string> = {
  queued: "等待开始",
  scanning: "扫描文件",
  moving: "移动文件",
  indexing: "更新索引",
  enriching: "补齐元数据",
  completed: "处理完成"
};

const backupStatusLabels: Record<string, string> = {
  queued: "等待开始",
  scanning: "扫描文件",
  running: "备份中",
  paused: "已暂停",
  completed: "已完成",
  failed: "备份失败",
  cancelled: "已取消"
};

function formatTaskTime(value?: string | null): string {
  if (!value) return "时间未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(getIntlLocale(), {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function governanceState(task: GovernanceTask): TaskVisualState {
  if (task.status === "failed" || task.status === "draft") return "attention";
  if (task.status === "queued" || task.status === "running") return "active";
  if (task.status === "completed") return "ready";
  return "idle";
}

function mediaJobState(job: TaskCenterMediaJob): TaskVisualState {
  if (job.status === "failed") return "attention";
  if (job.status === "pending" || job.status === "running") return "active";
  return "idle";
}

function ingestionState(run: TaskCenterIngestionRun): TaskVisualState {
  if (run.status === "failed" || run.status === "partial") return "attention";
  if (["queued", "running", "processing", "awaiting_scan"].includes(run.status)) return "active";
  if (run.status === "completed") return "ready";
  return "idle";
}

function stateTag(state: TaskVisualState, label: string) {
  return (
    <Tag color={state === "attention" ? "warning" : state === "active" ? "processing" : state === "ready" ? "success" : "default"}>
      {label}
    </Tag>
  );
}

function TaskCenterOverview({
  data,
  fetching,
  onRefresh
}: {
  data: TaskCenterResponse;
  fetching: boolean;
  onRefresh: () => void;
}) {
  useLocale();
  const latestIngestionRuns = data.ingestionRuns.slice(0, 5);
  const latestBackups = data.backups.slice(0, 4);
  const governanceTasks = data.governance.slice(0, 6);
  const agent = data.runtimes.agent;

  return (
    <div className="task-center-overview">
      <header className="task-center-overview-header">
        <div>
          <strong>任务总览</strong>
          <span>更新于 {formatTaskTime(data.generatedAt)}</span>
        </div>
        <Tooltip title="刷新全部任务状态">
          <Button
            aria-label="刷新任务状态"
            className={fetching ? "is-spinning" : ""}
            icon={<RefreshCw size={15} />}
            onClick={onRefresh}
            size="small"
            type="text"
          />
        </Tooltip>
      </header>

      <div className="task-center-summary-grid">
        <article className={data.summary.attention > 0 ? "is-attention" : "is-ready"}>
          <CircleAlert size={17} />
          <span>需关注</span>
          <strong>{data.summary.attention}</strong>
        </article>
        <article className={data.summary.active > 0 ? "is-active" : "is-idle"}>
          <Activity size={17} />
          <span>{t("进行中")}</span>
          <strong>{data.summary.active}</strong>
        </article>
        <article className={data.summary.unread > 0 ? "is-attention" : "is-idle"}>
          <FolderInput size={17} />
          <span>未读通知</span>
          <strong>{data.summary.unread}</strong>
        </article>
        <article className="is-ready">
          <CheckCircle2 size={17} />
          <span>今日完成</span>
          <strong>{data.summary.completedToday}</strong>
        </article>
      </div>

      <section className="task-center-section">
        <header>
          <div><ShieldCheck size={16} /><strong>治理任务</strong></div>
          <span>{data.governance.length > 0 ? `最近 ${data.governance.length} 条` : "暂无任务"}</span>
        </header>
        {governanceTasks.length === 0 ? (
          <div className="task-center-calm-state"><CheckCircle2 size={16} />尚未创建治理任务</div>
        ) : (
          <div className="task-center-row-list">
            {governanceTasks.map((task) => {
              const state = governanceState(task);
              return (
                <article className={`task-center-row is-${state}`} key={task.id}>
                  <div className="task-center-row-main">
                    <div>
                      <strong>{task.issueLabel}</strong>
                      {stateTag(state, governanceStatusLabels[task.status] ?? task.status)}
                    </div>
                    <span>{task.grain === "files" ? t("文件") : "作品"} {task.targetCount} 项 · {formatTaskTime(task.updatedAt)}</span>
                    {task.error && <small className="task-center-error">{task.error}</small>}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="task-center-section">
        <header>
          <div><Film size={16} /><strong>媒体任务</strong></div>
          <span>{data.mediaJobs.reduce((sum, job) => sum + Number(job.count), 0)} {t("项")}</span>
        </header>
        {data.mediaJobs.length === 0 ? (
          <div className="task-center-calm-state"><CheckCircle2 size={16} />没有排队、运行或近期失败任务</div>
        ) : (
          <div className="task-center-compact-grid">
            {data.mediaJobs.map((job) => {
              const state = mediaJobState(job);
              return (
                <article className={`task-center-compact-card is-${state}`} key={`${job.key}-${job.status}`}>
                  <div>
                    <strong>{mediaJobLabels[job.key] ?? job.key}</strong>
                    <span>{formatTaskTime(job.updatedAt)}</span>
                    {job.error && <small className="task-center-error">{job.error}</small>}
                  </div>
                  <div>
                    <b>{job.count}</b>
                    {stateTag(state, job.status === "failed" ? "失败" : job.status === "running" ? "运行中" : "排队")}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <div className="task-center-operation-grid">
        <section className="task-center-section">
          <header>
            <div><FolderInput size={16} /><strong>采集任务</strong></div>
            <span>最近状态</span>
          </header>
          {latestIngestionRuns.length === 0 ? (
            <div className="task-center-calm-state">暂无采集记录</div>
          ) : (
            <div className="task-center-row-list">
              {latestIngestionRuns.map((run) => {
                const state = ingestionState(run);
                return (
                  <article className={`task-center-row is-${state}`} key={run.id}>
                    <div className="task-center-row-main">
                      <div>
                        <strong>{run.triggerType === "scheduled" ? "定时采集" : "手动采集"}</strong>
                        {stateTag(state, run.status === "partial" ? "部分完成" : run.status === "failed" ? "失败" : ingestionPhaseLabels[run.phase] ?? run.status)}
                      </div>
                      <span>{formatTaskTime(run.updatedAt)}</span>
                      {run.error && <small className="task-center-error">{run.error}</small>}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <section className="task-center-section">
          <header>
            <div><DatabaseBackup size={16} /><strong>备份任务</strong></div>
            <span>最近状态</span>
          </header>
          {latestBackups.length === 0 ? (
            <div className="task-center-calm-state">暂无备份记录</div>
          ) : (
            <div className="task-center-row-list">
              {latestBackups.map((job) => {
                const state: TaskVisualState = job.status === "failed" || job.status === "paused"
                  ? "attention"
                  : ["queued", "scanning", "running"].includes(job.status)
                    ? "active"
                    : job.status === "completed" ? "ready" : "idle";
                return (
                  <article className={`task-center-row is-${state}`} key={job.id}>
                    <div className="task-center-row-main">
                      <div>
                        <strong>{job.trigger === "automatic" ? "自动备份" : "手动备份"}</strong>
                        {stateTag(state, backupStatusLabels[job.status] ?? job.status)}
                      </div>
                      <span>{job.filesCopied}/{job.filesTotal || 0} 文件 · {formatTaskTime(job.completedAt ?? job.startedAt ?? job.createdAt)}</span>
                      {job.error && <small className="task-center-error">{job.error}</small>}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <section className="task-center-section">
        <header>
          <div><HardDrive size={16} /><strong>AI 运行时</strong></div>
          <span>仅显示资源状态</span>
        </header>
        <div className="task-center-runtime-grid">
          <article className={`task-runtime-card is-${!agent?.storageReady ? "attention" : agent.available ? (agent.loadedModels.length > 0 ? "ready" : "idle") : "idle"}`}>
            <Bot size={18} />
            <div>
              <strong>馆藏 Agent</strong>
              <span>{!agent ? "状态暂不可用" : !agent.storageReady ? "外置存储未就绪" : agent.available ? (agent.loadedModels.length > 0 ? `已加载 ${agent.loadedModels.length} 个模型` : "运行时就绪，模型按需加载") : "运行时按需启动"}</span>
              {agent?.reason && <small>{agent.reason}</small>}
            </div>
          </article>
        </div>
      </section>
    </div>
  );
}

export function NotificationCenterDrawer({ open, onClose, onOpenMedia }: Props) {
  useLocale();
  const queryClient = useQueryClient();
  const [notificationLimit, setNotificationLimit] = useState(NOTIFICATION_PAGE_SIZE);
  const [visibleByGroup, setVisibleByGroup] = useState<Record<string, number>>({});
  const notifications = useQuery({
    queryKey: ["ingestion-notifications", notificationLimit],
    queryFn: () => fetchNotificationGroups(notificationLimit),
    enabled: open,
    placeholderData: (previous) => previous,
    staleTime: 15_000,
    refetchInterval: open ? 15_000 : false,
    refetchOnMount: false,
    refetchOnWindowFocus: false
  });
  const taskCenter = useQuery({
    queryKey: ["task-center"],
    queryFn: fetchTaskCenter,
    enabled: open,
    staleTime: 5_000,
    refetchInterval: open ? 10_000 : false,
    refetchOnMount: "always",
    refetchOnWindowFocus: false
  });
  const refreshCounts = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["ingestion-notifications"] }),
      queryClient.invalidateQueries({ queryKey: ["notification-unread-count"] }),
      queryClient.invalidateQueries({ queryKey: ["task-center"] })
    ]);
  };
  const readOne = useMutation({
    mutationFn: markNotificationRead,
    onSuccess: refreshCounts
  });
  const readAll = useMutation({
    mutationFn: markAllNotificationsRead,
    onSuccess: refreshCounts
  });

  const items = notifications.data?.items ?? [];
  const groups = notifications.data?.groups ?? [];
  const attentionCount = groups.reduce((sum, group) => sum + group.counts.attention, 0);
  const processingCount = groups.reduce((sum, group) => sum + group.counts.processing, 0);
  const taskSummary = taskCenter.data?.summary;

  return (
    <Drawer
      className="notification-center-drawer"
      open={open}
      onClose={onClose}
      size="min(760px, 100vw)"
      title={(
        <div className="notification-drawer-title">
          <span>任务与告警中心</span>
          {(taskSummary?.attention ?? attentionCount) > 0 && <Tag color="warning">需关注 {taskSummary?.attention ?? attentionCount}</Tag>}
          {(taskSummary?.active ?? processingCount) > 0 && <Tag color="processing">{t("进行中")} {taskSummary?.active ?? processingCount}</Tag>}
        </div>
      )}
      extra={<Button disabled={!items.some((item) => !item.readAt)} icon={<CheckCheck size={15} />} onClick={() => readAll.mutate()}>全部已读</Button>}
    >
      {taskCenter.isPending ? (
        <div className="task-center-loading"><Skeleton active paragraph={{ rows: 5 }} /></div>
      ) : taskCenter.isError ? (
        <div className="task-center-error-state">
          <CircleAlert size={17} />
          <span>{taskCenter.error instanceof Error ? taskCenter.error.message : "任务状态加载失败"}</span>
          <Button onClick={() => void taskCenter.refetch()} size="small">{t("重试")}</Button>
        </div>
      ) : taskCenter.data ? (
        <TaskCenterOverview
          data={taskCenter.data}
          fetching={taskCenter.isFetching}
          onRefresh={() => void taskCenter.refetch()}
        />
      ) : null}

      <section className="notification-feed-section">
        <header className="notification-feed-heading">
          <div>
            <FolderInput size={17} />
            <strong>入库通知</strong>
          </div>
          <div>
            {attentionCount > 0 && <Tag color="warning">{t("待处理")} {attentionCount}</Tag>}
            {processingCount > 0 && <Tag color="processing">处理中 {processingCount}</Tag>}
            <Tag>{items.filter((item) => !item.readAt).length} 未读</Tag>
          </div>
        </header>
        {notifications.isError ? (
          <Empty description={notifications.error instanceof Error ? notifications.error.message : "通知加载失败"} />
        ) : groups.length === 0 ? <Empty description="还没有新的入库通知" /> : (
          <div className="notification-batch-list">
            {groups.map((group) => (
            <section className={`notification-batch motion-list-item motion-status-card is-${group.counts.attention > 0 ? "attention" : group.counts.processing > 0 ? "processing" : "ready"}`} key={group.key}>
              <header className="notification-batch-header">
                <div>
                  <strong>{dayLabel(group.ingestionDay)}</strong>
                  <span>{group.runId ? `${group.triggerType === "scheduled" ? "定时" : "手动"}批次` : "历史入库"}</span>
                </div>
                <div>
                  {group.runStats && group.runStats.moved > 0 && (
                    <Badge status="success" text={`入库 ${group.runStats.moved}`} />
                  )}
                  {group.runStats && group.runStats.failed + group.runStats.conflicts > 0 && (
                    <Badge color="#ff9f0a" text={`异常 ${group.runStats.failed + group.runStats.conflicts}`} />
                  )}
                  {!group.runStats && group.counts.attention > 0 && (
                    <Badge color="#ff9f0a" text={`待处理 ${group.counts.attention}`} />
                  )}
                  {group.runStats && group.runStats.unstable > 0 && (
                    <Badge status="default" text={`待稳定 ${group.runStats.unstable}`} />
                  )}
                  {group.counts.processing > 0 && (
                    <Badge status="processing" text={`处理中 ${group.counts.processing}`} />
                  )}
                  <Tag>{group.runStats ? `通知 ${group.items.length}` : t("{{p0}} 部", { p0: group.items.length })}</Tag>
                </div>
              </header>
              <div className="notification-media-list">
                {group.items.slice(0, visibleByGroup[group.key] ?? 40).map((item) => (
                  <button
                    className={`notification-media-row motion-status-card is-${item.completion.overallStatus}${item.readAt ? " is-read" : ""}`}
                    key={item.id}
                    onClick={() => {
                      if (!item.readAt) readOne.mutate(item.id);
                      if (item.mediaId) onOpenMedia(item.mediaId);
                    }}
                    type="button"
                  >
                    <div className="notification-poster">
                      {item.mediaId && (
                        <PosterImage
                          alt=""
                          decoding="async"
                          loading="lazy"
                          src={`${getPosterUrl(item.mediaId, "card")}&state=${item.completion.overallStatus}`}
                        />
                      )}
                    </div>
                    <div className="notification-media-copy">
                      <header>
                        <strong>{item.normalizedCode}</strong>
                        <Tag color={item.completion.overallStatus === "ready" ? "success" : item.completion.overallStatus === "attention" ? "warning" : "processing"}>
                          {completionLabel(item.completion.overallStatus)}
                        </Tag>
                      </header>
                      <Text ellipsis={{ tooltip: item.title }}>{item.title || "元数据处理中"}</Text>
                      <small>{item.actors.slice(0, 3).join(" · ") || `${item.category} · ${item.sourceId === "primary" ? "SATA" : item.sourceId === "secondary" ? "eSATA" : t("自动入库")}`}</small>
                      <NotificationStageStrip item={item} />
                      <div className={`notification-completion-reason is-${item.completion.overallStatus}`}>
                        {item.completion.overallStatus === "attention" ? <CircleAlert size={13} /> : <Clock3 size={13} />}
                        <span>{item.completion.reason}</span>
                      </div>
                      <time>{new Date(item.createdAt).toLocaleString(getIntlLocale())}</time>
                    </div>
                  </button>
                ))}
                {(visibleByGroup[group.key] ?? 40) < group.items.length && (
                  <Button
                    className="notification-group-more"
                    onClick={() => setVisibleByGroup((current) => ({
                      ...current,
                      [group.key]: (current[group.key] ?? 40) + 40
                    }))}
                  >
                    显示更多（已显示 {Math.min(visibleByGroup[group.key] ?? 40, group.items.length)} / {group.items.length}）
                  </Button>
                )}
              </div>
            </section>
            ))}
            {notificationLimit < 500 && notifications.data?.hasMore && (
              <Button
                block
                className="notification-feed-more"
                loading={notifications.isFetching}
                onClick={() => setNotificationLimit((current) => Math.min(500, current + NOTIFICATION_PAGE_SIZE))}
              >
                加载更早的入库通知
              </Button>
            )}
          </div>
        )}
      </section>
    </Drawer>
  );
}
