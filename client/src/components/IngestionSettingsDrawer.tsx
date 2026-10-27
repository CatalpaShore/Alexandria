import { getIntlLocale } from "../i18n/core";
import { t, useLocale, useLocalizedMemo } from "../i18n";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Drawer,
  Empty,
  Input,
  Modal,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
  message
} from "antd";
import { ChevronDown, ChevronUp, Download, FolderInput, Play, RefreshCw, RotateCcw, ShieldCheck } from "lucide-react";
import {
  fetchIngestionRuns,
  fetchIngestionSettings,
  formatBytes,
  triggerIngestionRun,
  updateIngestionSettings
} from "../lib/api";
import "../ingestion-operations.css";
import "../operations-drawer.css";
import "../admin-management.css";

const { Text } = Typography;

type Props = { open: boolean; onClose: () => void };

type StageStatus = "ready" | "processing" | "attention";

type CompletionStage = {
  status: StageStatus;
  label: string;
  detail: string;
};

type IngestionCompletion = {
  overallStatus: StageStatus;
  reason: string;
  stages: Record<"file" | "metadata" | "translation" | "cover", CompletionStage>;
};

type AuditItem = {
  id: string;
  runId: string;
  sourceId: string;
  originalPath: string;
  originalName: string;
  normalizedName: string;
  normalizedCode: string;
  category: string;
  targetPath: string;
  mediaId: string | null;
  size: number;
  status: string;
  metadataStatus: string;
  translationStatus: string;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  completion: IngestionCompletion;
  rollback: {
    status: string;
    reason: string | null;
    createdAt: string | null;
    completedAt: string | null;
  } | null;
};

type AuditResponse = {
  items: AuditItem[];
  rollbackSummary: Record<string, number>;
};

type RollbackResponse = {
  status?: string;
  reason?: string;
  summary?: Record<string, number>;
  scanTriggered?: boolean;
};

const phaseLabels: Record<string, string> = {
  queued: "等待执行",
  scanning_downloads: "扫描下载目录",
  moving: "移动文件",
  indexing: "更新媒体库",
  fetching_metadata: "抓取元数据",
  translating: "翻译",
  scheduling_content_previews: "排队生成内容预览",
  enriching_actor_profiles: "补充演员资料",
  exporting: "更新 Excel",
  warming_cache: "预热缓存",
  completed: "已完成"
};

const itemStatusLabels: Record<string, string> = {
  moved: "已移动",
  waiting: "等待稳定",
  conflict: "路径冲突",
  rejected: "安全拦截",
  failed: "移动失败",
  rolled_back: "已回滚"
};

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({})) as { error?: string; reason?: string };
  if (!response.ok) throw new Error(body.error || body.reason || `请求失败 (${response.status})`);
  return body as T;
}

function refreshIngestionViews(queryClient: ReturnType<typeof useQueryClient>, runId?: string): Promise<unknown[]> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ["ingestion-runs"] }),
    ...(runId ? [queryClient.invalidateQueries({ queryKey: ["ingestion-run-audit", runId] })] : []),
    queryClient.invalidateQueries({ queryKey: ["ingestion-notifications"] }),
    queryClient.invalidateQueries({ queryKey: ["notification-unread-count"] }),
    queryClient.invalidateQueries({ queryKey: ["home-dashboard", "recent-ingestion"] })
  ]);
}

function CompletionStrip({ completion }: { completion: IngestionCompletion }) {
  useLocale();
  return (
    <div className="ingestion-completion-strip" aria-label={completion.reason}>
      {Object.entries(completion.stages).map(([key, stage]) => (
        <Tooltip key={key} title={stage.detail}>
          <span className={`ingestion-stage is-${stage.status}`}>
            <i />
            {stage.label}
          </span>
        </Tooltip>
      ))}
    </div>
  );
}

function RunAuditPanel({ runId, canManage }: { runId: string; canManage: boolean }) {
  useLocale();
  const queryClient = useQueryClient();
  const [modal, modalContext] = Modal.useModal();
  const [visibleCount, setVisibleCount] = useState(60);
  const audit = useQuery({
    queryKey: ["ingestion-run-audit", runId],
    queryFn: () => requestJson<AuditResponse>(`/api/ingestion/runs/${encodeURIComponent(runId)}/items`, { cache: "no-store" }),
    refetchInterval: 5_000
  });
  const itemRollback = useMutation({
    mutationFn: (itemId: string) => requestJson<RollbackResponse>(
      `/api/ingestion/items/${encodeURIComponent(itemId)}/rollback`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true })
      }
    ),
    onSuccess: async (result) => {
      message.success(result.scanTriggered ? "文件已回滚，媒体库正在重新扫描" : "文件已回滚");
      await refreshIngestionViews(queryClient, runId);
    },
    onError: (error) => message.error(error instanceof Error ? error.message : "回滚失败")
  });
  const runRollback = useMutation({
    mutationFn: () => requestJson<RollbackResponse>(`/api/ingestion/runs/${encodeURIComponent(runId)}/rollback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: runId })
    }),
    onSuccess: async (result) => {
      const succeeded = result.summary?.succeeded ?? 0;
      const refused = result.summary?.refused ?? 0;
      message.success(`批次回滚完成：成功 ${succeeded} 条${refused ? `，拒绝 ${refused} 条` : ""}`);
      await refreshIngestionViews(queryClient, runId);
    },
    onError: (error) => message.error(error instanceof Error ? error.message : "批次回滚失败")
  });

  const items = useLocalizedMemo(() => audit.data?.items ?? [], [audit.data?.items]);
  const visibleItems = items.slice(0, visibleCount);
  const movedCount = items.filter((item) => item.status === "moved").length;
  const statusCounts = useLocalizedMemo(() => items.reduce<Record<StageStatus, number>>((counts, item) => {
    counts[item.completion.overallStatus] += 1;
    return counts;
  }, { ready: 0, processing: 0, attention: 0 }), [items]);

  const confirmItemRollback = (item: AuditItem) => {
    modal.confirm({
      title: `回滚 ${item.normalizedCode || item.originalName}`,
      content: "文件将移回记录中的原下载路径。若原路径已有文件，系统会拒绝操作，绝不会覆盖。",
      okText: "确认回滚",
      cancelText: t("取消"),
      okButtonProps: { danger: true },
      onOk: () => itemRollback.mutateAsync(item.id)
    });
  };

  const confirmRunRollback = () => {
    modal.confirm({
      title: `回滚本批次的 ${movedCount} 个文件`,
      content: "系统将逐条安全移回原下载目录。存在冲突的文件会单独拒绝，不会覆盖，也不会影响其他文件。",
      okText: "回滚整批",
      cancelText: t("取消"),
      okButtonProps: { danger: true },
      onOk: () => runRollback.mutateAsync()
    });
  };

  if (audit.isLoading) return <div className="ingestion-audit-loading">正在读取批次审计记录...</div>;
  if (audit.isError) {
    return <Alert type="error" showIcon message={audit.error instanceof Error ? audit.error.message : "批次明细加载失败"} />;
  }

  return (
    <div className="ingestion-audit-panel">
      {modalContext}
      <header className="ingestion-audit-summary">
        <div>
          <Tag color="success">就绪 {statusCounts.ready}</Tag>
          <Tag color="processing">处理中 {statusCounts.processing}</Tag>
          <Tag color="warning">{t("待处理")} {statusCounts.attention}</Tag>
          {(audit.data?.rollbackSummary.succeeded ?? 0) > 0 && (
            <Tag color="default">已回滚 {audit.data?.rollbackSummary.succeeded}</Tag>
          )}
        </div>
        <Tooltip title={canManage ? "将本批次仍在媒体库中的文件安全移回原下载路径" : "仅本地 PC 版可执行回滚"}>
          <Button
            danger
            disabled={!canManage || movedCount === 0}
            icon={<RotateCcw size={14} />}
            loading={runRollback.isPending}
            onClick={confirmRunRollback}
            size="small"
          >
            回滚整批
          </Button>
        </Tooltip>
      </header>

      {items.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该批次没有文件记录" /> : (
        <div className="ingestion-audit-list">
          {visibleItems.map((item) => (
            <article className={`ingestion-audit-item is-${item.completion.overallStatus}`} key={item.id}>
              <header>
                <div className="ingestion-audit-code">
                  <strong>{item.normalizedCode || item.originalName}</strong>
                  <Tag>{item.category || "未识别"}</Tag>
                  <Tag color={item.status === "moved" ? "success" : item.status === "rolled_back" ? "default" : "warning"}>
                    {itemStatusLabels[item.status] ?? item.status}
                  </Tag>
                </div>
                <Text type="secondary">{formatBytes(item.size)}</Text>
              </header>
              <CompletionStrip completion={item.completion} />
              <Text className="ingestion-completion-reason" type={item.completion.overallStatus === "attention" ? "warning" : "secondary"}>
                {item.completion.reason}
              </Text>
              <dl className="ingestion-audit-paths">
                <div>
                  <dt>识别</dt>
                  <dd title={`${item.category} · ${item.normalizedCode} => ${item.normalizedName}`}>
                    {item.category || "未识别"} · {item.normalizedCode || "未命中"} =&gt; {item.normalizedName || "未生成"}
                  </dd>
                </div>
                <div>
                  <dt>原路径</dt>
                  <dd title={item.originalPath}>{item.originalPath}</dd>
                </div>
                <div>
                  <dt>目标路径</dt>
                  <dd title={item.targetPath}>{item.targetPath}</dd>
                </div>
              </dl>
              {(item.reason || item.rollback?.reason) && (
                <div className="ingestion-audit-note">
                  {item.rollback?.status === "succeeded" && <ShieldCheck size={14} />}
                  <span>{item.rollback?.reason || item.reason}</span>
                </div>
              )}
              <footer>
                <Text type="secondary">{item.sourceId === "primary" ? "SATA" : "eSATA"} · {new Date(item.createdAt).toLocaleString(getIntlLocale())}</Text>
                <Tooltip title={canManage ? "移回原下载路径，不会删除文件" : "仅本地 PC 版可执行回滚"}>
                  <Button
                    disabled={!canManage || item.status !== "moved"}
                    icon={<FolderInput size={14} />}
                    loading={itemRollback.isPending && itemRollback.variables === item.id}
                    onClick={() => confirmItemRollback(item)}
                    size="small"
                  >
                    回滚
                  </Button>
                </Tooltip>
              </footer>
            </article>
          ))}
          {visibleCount < items.length && (
            <Button className="ingestion-audit-more" onClick={() => setVisibleCount((count) => count + 60)}>
              加载更多（已显示 {visibleItems.length} / {items.length}）
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function IngestionSettingsDrawer({ open, onClose }: Props) {
  useLocale();
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ["ingestion-settings"],
    queryFn: fetchIngestionSettings,
    enabled: open
  });
  const runs = useQuery({
    queryKey: ["ingestion-runs"],
    queryFn: fetchIngestionRuns,
    enabled: open,
    refetchInterval: open ? 3_000 : false
  });
  const [enabled, setEnabled] = useState(false);
  const [scheduleTime, setScheduleTime] = useState("03:00");
  const [paths, setPaths] = useState<[string, string]>(["", ""]);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const canManage = settings.data?.canManageIngestion ?? false;

  useEffect(() => {
    if (!settings.data) return;
    setEnabled(settings.data.enabled);
    setScheduleTime(settings.data.scheduleTime);
    setPaths([
      settings.data.sources.find((source) => source.id === "primary")?.downloadRoot ?? "",
      settings.data.sources.find((source) => source.id === "secondary")?.downloadRoot ?? ""
    ]);
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () => updateIngestionSettings({
      enabled,
      scheduleTime,
      sources: [
        { id: "primary", downloadRoot: paths[0], enabled: true },
        { id: "secondary", downloadRoot: paths[1], enabled: true }
      ]
    }),
    onSuccess: async () => {
      message.success(enabled ? "自动入库已启用" : "自动入库设置已保存");
      await queryClient.invalidateQueries({ queryKey: ["ingestion-settings"] });
    },
    onError: (error) => message.error(error instanceof Error ? error.message : t("保存失败"))
  });
  const runNow = useMutation({
    mutationFn: () => triggerIngestionRun(),
    onSuccess: async () => {
      message.success("已创建自动入库任务");
      await queryClient.invalidateQueries({ queryKey: ["ingestion-runs"] });
    },
    onError: (error) => message.error(error instanceof Error ? error.message : "任务创建失败")
  });

  return (
    <Drawer className="ingestion-settings-drawer" open={open} onClose={onClose} size={760} title={<div className="operations-drawer-title"><span className="operations-title-icon"><Download size={18} /></span><span><strong>自动入库与批次审计</strong><small>定时归档下载文件并追踪每次处理结果</small></span></div>}>
      <div className="ingestion-settings-summary">
        <span className="ingestion-summary-icon"><Download size={18} /></span>
        <div className="ingestion-summary-copy">
          <strong>每日自动更新</strong>
          <Text type="secondary">{enabled ? `每天 ${scheduleTime} 执行；文件稳定 5 分钟后直接入库` : "自动任务当前关闭，仍可手动执行"}</Text>
        </div>
        {canManage && (
          <Tag color={settings.data?.workerRunning ? "success" : "error"}>
            {settings.data?.workerRunning ? "执行器运行中" : "执行器未启动"}
          </Tag>
        )}
        <Switch checked={enabled} disabled={!canManage} onChange={setEnabled} />
      </div>

      {!canManage && settings.data?.disabledReason && (
        <Alert className="ingestion-runtime-notice" message={settings.data.disabledReason} showIcon type="warning" />
      )}

      <div className="ingestion-settings-form">
        <label>
          <span>执行时间 <Tag>{settings.data?.timezone ?? "Asia/Shanghai"}</Tag></span>
          <Input disabled={!canManage} type="time" value={scheduleTime} onChange={(event) => setScheduleTime(event.target.value)} />
        </label>
        {(["SATA 迅雷下载", "eSATA 迅雷下载"] as const).map((label, index) => (
          <label key={label}>
            <span>{label}</span>
            <Input
              disabled={!canManage}
              value={paths[index]}
              onChange={(event) => setPaths((current) => {
                const next = [...current] as [string, string];
                next[index] = event.target.value;
                return next;
              })}
            />
          </label>
        ))}
      </div>

      <Space className="ingestion-settings-actions">
        <Button disabled={!canManage} loading={save.isPending} onClick={() => save.mutate()} type="primary">保存设置</Button>
        <Button disabled={!canManage} icon={<Play size={15} />} loading={runNow.isPending} onClick={() => runNow.mutate()}>立即执行</Button>
        <Button icon={<RefreshCw size={15} />} onClick={() => runs.refetch()} aria-label="刷新任务" />
      </Space>

      <section className="ingestion-run-section">
        <header><div><strong>最近任务与审计</strong><Text type="secondary">展开任一批次可核对文件路径与回滚状态</Text></div><Tag bordered={false}>{runs.data?.items.length ?? 0} 个批次</Tag></header>
        <div className="ingestion-run-list">
          {(runs.data?.items ?? []).map((run) => {
            let stats: Record<string, unknown> = {};
            try { stats = JSON.parse(run.statsJson) as Record<string, unknown>; } catch { stats = {}; }
            const moved = typeof stats.moved === "number" ? stats.moved : null;
            const failed = typeof stats.failed === "number" ? stats.failed : 0;
            const conflicts = typeof stats.conflicts === "number" ? stats.conflicts : 0;
            const unstable = typeof stats.unstable === "number" ? stats.unstable : 0;
            const rejected = typeof stats.rejected === "number" ? stats.rejected : 0;
            const rejectionReasons = stats.rejectionReasons && typeof stats.rejectionReasons === "object"
              ? stats.rejectionReasons as Record<string, number>
              : {};
            const rejectionSummary = [
              ["blocked-platform-keyword", "平台关键词"],
              ["descriptive-english-title", "英文长标题"],
              ["opaque-random-name", "随机文件名"],
              ["invalid-code-boundary", "番号边界异常"]
            ].flatMap(([key, label]) => rejectionReasons[key] ? [`${label} ${rejectionReasons[key]}`] : []).join("，");
            const expanded = expandedRunId === run.id;
            return (
              <div className={`ingestion-run-entry motion-list-item motion-status-card${expanded ? " is-expanded" : ""}`} key={run.id}>
                <div className="ingestion-run-row">
                  <div>
                    <strong>{run.triggerType === "scheduled" ? "定时任务" : "手动任务"}</strong>
                    <Text type="secondary">{new Date(run.createdAt).toLocaleString(getIntlLocale())}</Text>
                  </div>
                  <div className="ingestion-run-state">
                    <Tag color={run.status === "completed" ? "success" : run.status === "failed" ? "error" : run.status === "partial" ? "warning" : "processing"}>
                      {phaseLabels[run.phase] ?? run.phase}
                    </Tag>
                    {moved !== null && <Text>{t("入库")} {moved}</Text>}
                    {failed > 0 && <Tag color="error">失败 {failed}</Tag>}
                    {conflicts > 0 && <Tag color="warning">冲突 {conflicts}</Tag>}
                    {unstable > 0 && <Tag>待稳定 {unstable}</Tag>}
                    {rejected > 0 && <Tag color="warning" title={rejectionSummary}>安全拦截 {rejected}</Tag>}
                    <Button
                      aria-label={expanded ? "收起批次审计" : "查看批次审计"}
                      icon={expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                      onClick={() => setExpandedRunId(expanded ? null : run.id)}
                      size="small"
                      type="text"
                    >
                      {expanded ? t("收起") : "审计"}
                    </Button>
                  </div>
                  {run.error && <Text type="danger" ellipsis={{ tooltip: run.error }}>{run.error}</Text>}
                </div>
                {expanded && <div className="motion-expand-region"><RunAuditPanel canManage={canManage} runId={run.id} /></div>}
              </div>
            );
          })}
        </div>
      </section>
    </Drawer>
  );
}
