import { getIntlLocale } from "../i18n/core";
import { t, useLocale, useLocalizedMemo } from "../i18n";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Checkbox,
  Drawer,
  Input,
  Progress,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
  message
} from "antd";
import { Check, CircleStop, Clock3, DatabaseBackup, FolderCheck, HardDrive, Pause, Play, RefreshCw, ShieldCheck, VideoOff } from "lucide-react";
import {
  controlBackupJob,
  createBackupJob,
  fetchBackupCenter,
  inspectBackupTarget,
  updateBackupSettings,
  type BackupJob,
  type BackupScope,
  type BackupSettings
} from "../lib/backupApi";
import "../backup-center.css";

const { Paragraph, Text, Title } = Typography;
const scopeOptions: Array<{ value: BackupScope; label: string; description: string }> = [
  { value: "app-data", label: "应用数据", description: "数据库、收藏、片单、筛选和资源路径配置" },
  { value: "project-code", label: "完整项目环境", description: "包含源码、依赖、Git、构建产物、环境配置和 Android 工具链，并自动包含其他两项" },
  { value: "generated-assets", label: "生成资源", description: "封面、缩略图、字幕、转码与导出文件" }
];
const statusLabels: Record<BackupJob["status"], string> = {
  queued: "排队中", scanning: "正在盘点", running: "备份中", paused: "已暂停", completed: "已完成", failed: "失败", cancelled: "已取消"
};

function formatBytes(bytes: number | null): string {
  if (!bytes || bytes <= 0) return bytes === 0 ? "0 B" : "-";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function progress(job: BackupJob): number {
  if (job.status === "completed") return 100;
  if (job.filesTotal <= 0) return 0;
  return Math.min(99, Math.round(((job.filesCopied + job.filesSkipped) / job.filesTotal) * 100));
}

function formatJobTime(value: string): string {
  return new Date(value).toLocaleString(getIntlLocale(), {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

export function BackupCenterDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  useLocale();
  const queryClient = useQueryClient();
  const center = useQuery({
    queryKey: ["backup-center"],
    queryFn: fetchBackupCenter,
    enabled: open,
    refetchInterval: (query) => query.state.data?.jobs.some((job) => ["queued", "scanning", "running"].includes(job.status)) ? 1_000 : 5_000
  });
  const [draft, setDraft] = useState<Omit<BackupSettings, "updatedAt"> | null>(null);
  useEffect(() => {
    if (center.data && !draft) {
      const { updatedAt: _updatedAt, ...settings } = center.data.settings;
      setDraft(settings);
    }
  }, [center.data, draft]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["backup-center"] });
  const save = useMutation({
    mutationFn: () => updateBackupSettings(draft!),
    onSuccess: async () => { message.success("自动备份设置已保存"); await refresh(); },
    onError: (error) => message.error(error instanceof Error ? error.message : "设置保存失败")
  });
  const inspect = useMutation({
    mutationFn: (targetRoot: string) => inspectBackupTarget(targetRoot),
    onSuccess: (target) => target.available ? message.success(`目标可用，剩余 ${formatBytes(target.freeBytes)}`) : message.error(target.error ?? "目标不可用"),
    onError: (error) => message.error(error instanceof Error ? error.message : "目标检查失败")
  });
  const create = useMutation({
    mutationFn: () => createBackupJob({ targetRoot: draft!.targetRoot, scopes: draft!.scopes }),
    onSuccess: async () => { message.success("备份任务已启动"); await refresh(); },
    onError: (error) => message.error(error instanceof Error ? error.message : "备份启动失败")
  });
  const control = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "pause" | "resume" | "cancel" }) => controlBackupJob(id, action),
    onSuccess: refresh,
    onError: (error) => message.error(error instanceof Error ? error.message : "任务操作失败")
  });

  const active = center.data?.jobs.find((job) => ["queued", "scanning", "running", "paused"].includes(job.status));
  const currentTarget = inspect.data && inspect.data.targetRoot === draft?.targetRoot ? inspect.data : center.data?.target;
  const weekdayOptions = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"].map((label, value) => ({ label, value }));
  const latestJobs = useLocalizedMemo(() => center.data?.jobs.slice(0, 6) ?? [], [center.data?.jobs]);
  const scheduleLabel = draft
    ? `${draft.frequency === "weekly" ? weekdayOptions[draft.weekday]?.label ?? "每周" : "每天"} ${String(draft.hour).padStart(2, "0")}:00`
    : "-";
  const changeScopes = (values: BackupScope[]) => {
    const selectedProject = values.includes("project-code");
    const previouslySelectedProject = draft?.scopes.includes("project-code") ?? false;
    if (selectedProject) {
      setDraft({ ...draft!, scopes: ["app-data", "project-code", "generated-assets"] });
    } else if (previouslySelectedProject) {
      setDraft({ ...draft!, scopes: values.filter((scope) => scope !== "project-code") });
    } else {
      setDraft({ ...draft!, scopes: values });
    }
  };

  return (
    <Drawer
      className="backup-center-drawer"
      destroyOnClose={false}
      open={open}
      onClose={onClose}
      title={(
        <div className="backup-drawer-title">
          <span className="backup-drawer-title-icon"><DatabaseBackup size={19} /></span>
          <span><strong>{t("备份中心")}</strong><small>保护应用数据与完整运行环境</small></span>
        </div>
      )}
      width={680}
    >
      {center.isLoading || !draft ? <div className="backup-loading">正在读取备份状态…</div> : center.error ? (
        <Alert showIcon type="error" message={center.error instanceof Error ? center.error.message : "备份状态读取失败"} />
      ) : (
        <div className="backup-center-body">
          <section className={`backup-readiness motion-status-card${inspect.isPending ? " is-checking" : currentTarget?.available ? " is-ready" : " is-unavailable"}`}>
            <div className="backup-readiness-topline">
              <div className="backup-readiness-state">
                <span className="backup-readiness-icon">{currentTarget?.available ? <ShieldCheck size={21} /> : <HardDrive size={21} />}</span>
                <div>
                  <Title level={5}>{currentTarget?.available ? "备份目标已就绪" : "备份目标不可用"}</Title>
                  <Text type="secondary">{currentTarget?.available ? "可以执行增量备份，未变化的文件会自动跳过。" : "连接磁盘或选择服务端可写目录后再开始备份。"}</Text>
                </div>
              </div>
              <div className="backup-capacity">
                <span>剩余空间</span>
                <strong>{currentTarget?.available ? formatBytes(currentTarget.freeBytes) : "-"}</strong>
              </div>
            </div>
            <div className="backup-guardrails" aria-label="备份保护规则">
              <span><VideoOff size={14} />源视频不复制</span>
              <span><FolderCheck size={14} />辅助存储 现有来源跳过</span>
              <span><Check size={14} />支持暂停续传</span>
            </div>
            <div className="backup-target-control">
              <Text strong>备份位置</Text>
              <Text type="secondary">默认写入 辅助存储，也可以指定服务端可访问的其他文件夹。</Text>
            </div>
            <Space.Compact block>
              <Input aria-label="备份目标路径" value={draft.targetRoot} onChange={(event) => setDraft({ ...draft, targetRoot: event.target.value })} />
              <Button icon={<RefreshCw size={15} />} loading={inspect.isPending} onClick={() => inspect.mutate(draft.targetRoot)}>检查</Button>
            </Space.Compact>
            {draft.targetRoot !== center.data?.defaultTargetRoot && <Button type="link" onClick={() => setDraft({ ...draft, targetRoot: center.data!.defaultTargetRoot })}>恢复 辅助存储 默认位置</Button>}
          </section>

          <section className="backup-scope-section">
            <div className="backup-section-heading"><div><Title level={5}>备份范围</Title><Text type="secondary">选择需要保护的数据；完整项目环境会自动包含全部范围。</Text></div><Tag>{draft.scopes.length}/3 已选择</Tag></div>
            <Checkbox.Group className="backup-scope-grid" value={draft.scopes} onChange={(values) => changeScopes(values as BackupScope[])}>
              {scopeOptions.map((item) => <Checkbox className={draft.scopes.includes(item.value) ? "is-selected" : ""} key={item.value} value={item.value}><span><strong>{item.label}</strong><small>{item.description}</small></span></Checkbox>)}
            </Checkbox.Group>
          </section>

          <section className="backup-manual-row">
            <div><Title level={5}>{active ? "已有备份任务进行中" : "手动备份"}</Title><Text type="secondary">{active ? `${statusLabels[active.status]} · ${progress(active)}% 已完成` : "立即为当前所选范围创建一份增量备份。"}</Text></div>
            <Button type="primary" icon={<DatabaseBackup size={16} />} loading={create.isPending} disabled={draft.scopes.length === 0 || Boolean(active && active.status !== "paused")} onClick={() => create.mutate()}>立即备份</Button>
          </section>

          <section className="backup-auto-card">
            <div className="backup-section-heading">
              <div><Title level={5}>自动备份</Title><Text type="secondary">{draft.enabled ? `当前计划：${scheduleLabel}` : "开启后，服务会在目标可用时按计划执行。"}</Text></div>
              <Switch checked={draft.enabled} checkedChildren="开启" unCheckedChildren={t("关闭")} onChange={(enabled) => setDraft({ ...draft, enabled })} />
            </div>
            <Space className={`backup-schedule-controls${draft.enabled ? " is-visible" : ""}`} wrap>
              <Select value={draft.frequency} options={[{ label: "每天", value: "daily" }, { label: "每周", value: "weekly" }]} onChange={(frequency) => setDraft({ ...draft, frequency })} />
              {draft.frequency === "weekly" && <Select value={draft.weekday} options={weekdayOptions} onChange={(weekday) => setDraft({ ...draft, weekday })} />}
              <Select value={draft.hour} options={Array.from({ length: 24 }, (_, hour) => ({ label: `${String(hour).padStart(2, "0")}:00`, value: hour }))} onChange={(hour) => setDraft({ ...draft, hour })} />
              <Button type="primary" loading={save.isPending} disabled={draft.scopes.length === 0} onClick={() => save.mutate()}>保存设置</Button>
            </Space>
          </section>

          <section>
            <div className="backup-section-heading"><div><Title level={5}>任务记录</Title><Text type="secondary">每条记录包含各部分的数据条数和大小。</Text></div><Text type="secondary">最近 {latestJobs.length} {t("条")}</Text></div>
            {latestJobs.length === 0 ? <Alert type="info" showIcon message="还没有备份记录" /> : latestJobs.map((job) => (
              <div className={`backup-job motion-list-item motion-status-card is-${job.status}`} key={job.id}>
                <div className="backup-job-title"><Space><Tag color={job.status === "completed" ? "success" : job.status === "failed" ? "error" : job.status === "paused" ? "warning" : "processing"}>{statusLabels[job.status]}</Tag><Text strong>{job.trigger === "automatic" ? "自动" : "手动"}备份</Text></Space><Text className="backup-job-time" type="secondary"><Clock3 size={13} />{formatJobTime(job.createdAt)}</Text></div>
                <Progress percent={progress(job)} status={job.status === "failed" ? "exception" : job.status === "completed" ? "success" : "active"} size="small" />
                <Paragraph className="backup-job-meta" ellipsis={{ rows: 1, tooltip: job.currentFile || job.targetRoot }}>
                  {job.status === "scanning" ? "正在盘点文件与容量" : job.currentFile || job.targetRoot}
                </Paragraph>
                <div className="backup-job-stats" aria-label="任务备份统计">
                  <span><small>已复制</small><strong>{job.filesCopied.toLocaleString(getIntlLocale())} {t("个")}</strong></span>
                  <span><small>未变化</small><strong>{job.filesSkipped.toLocaleString(getIntlLocale())} {t("个")}</strong></span>
                  <span><small>写入大小</small><strong>{formatBytes(job.bytesCopied)}</strong></span>
                </div>
                <details className="backup-job-details">
                  <summary><FolderCheck size={14} />查看各部分数据条数和大小</summary>
                  {job.parts && job.parts.length > 0 ? (
                    <div className="backup-part-list motion-expand-region">
                      <div className="backup-part-row is-header">
                        <span>备份部分</span><span>总计</span><span>已复制</span><span>未变化</span>
                      </div>
                      {job.parts.map((part) => (
                        <div className="backup-part-row" key={part.id}>
                          <strong>{part.label}</strong>
                          <span data-label="总计">{part.filesTotal.toLocaleString(getIntlLocale())} {t("个")}<br /><small>{formatBytes(part.bytesTotal)}</small></span>
                          <span data-label="已复制">{part.filesCopied.toLocaleString(getIntlLocale())} {t("个")}<br /><small>{formatBytes(part.bytesCopied)}</small></span>
                          <span data-label="未变化">{part.filesSkipped.toLocaleString(getIntlLocale())} {t("个")}<br /><small>{formatBytes(part.bytesSkipped)}</small></span>
                        </div>
                      ))}
                    </div>
                  ) : <Text type="secondary">此旧日志创建时尚未采集分部统计。</Text>}
                </details>
                {job.excludedSources.length > 0 && <Text type="secondary"><FolderCheck size={13} /> 已排除 {job.excludedSources.length} 个 辅助存储 来源</Text>}
                {job.error && <Alert className="backup-job-error" type="error" showIcon message={job.error} />}
                {(["queued", "scanning", "running"].includes(job.status) || job.status === "paused") && <Space className="backup-job-actions">
                  {job.status === "paused" ? <Button size="small" icon={<Play size={14} />} onClick={() => control.mutate({ id: job.id, action: "resume" })}>继续</Button> : <Button size="small" icon={<Pause size={14} />} onClick={() => control.mutate({ id: job.id, action: "pause" })}>{t("暂停")}</Button>}
                  <Tooltip title="保留已完成文件，下次仍可增量跳过"><Button danger size="small" icon={<CircleStop size={14} />} onClick={() => control.mutate({ id: job.id, action: "cancel" })}>{t("停止")}</Button></Tooltip>
                </Space>}
              </div>
            ))}
          </section>
        </div>
      )}
    </Drawer>
  );
}
