import { t, useLocale } from "../i18n";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Drawer, Empty, Popconfirm, Select, Tag } from "antd";
import { CheckCircle2, CircleAlert, FileSearch, PlayCircle, ShieldCheck, XCircle } from "lucide-react";
import {
  cancelGovernanceAction,
  createGovernanceAction,
  executeGovernanceAction,
  previewGovernanceAction,
  type GovernanceIssueKey,
  type GovernanceTask
} from "../lib/governanceApi";
import "../library-analytics.css";

type Props = {
  issueKey: GovernanceIssueKey | null;
  onClose: () => void;
};

const batchOptions = [10, 25, 50, 100].map((value) => ({ value, label: `本批最多 ${value} 条` }));

function statusLabel(status: GovernanceTask["status"]): string {
  if (status === "draft") return "等待确认";
  if (status === "running" || status === "queued") return "执行中";
  if (status === "completed") return t("已完成");
  if (status === "cancelled") return t("已取消");
  return "执行失败";
}

function statusColor(status: GovernanceTask["status"]): string {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "running" || status === "queued") return "processing";
  if (status === "draft") return "warning";
  return "default";
}

export function GovernanceActionDrawer({ issueKey, onClose }: Props) {
  useLocale();
  const queryClient = useQueryClient();
  const [limit, setLimit] = useState(50);
  const [task, setTask] = useState<GovernanceTask | null>(null);

  useEffect(() => {
    setTask(null);
    setLimit(50);
  }, [issueKey]);

  const preview = useQuery({
    queryKey: ["governance-action-preview", issueKey, limit],
    queryFn: () => previewGovernanceAction(issueKey as GovernanceIssueKey, limit),
    enabled: Boolean(issueKey),
    staleTime: 10_000,
    refetchOnWindowFocus: false
  });
  const refreshAfterChange = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["task-center"] }),
      queryClient.invalidateQueries({ queryKey: ["governance-actions"] }),
      queryClient.invalidateQueries({ queryKey: ["library-analytics-summary"] }),
      queryClient.invalidateQueries({ queryKey: ["library-analytics-section"] })
    ]);
  };
  const createTask = useMutation({
    mutationFn: () => createGovernanceAction(issueKey as GovernanceIssueKey, limit),
    onSuccess: (created) => {
      setTask(created);
      void refreshAfterChange();
    }
  });
  const executeTask = useMutation({
    mutationFn: (id: string) => executeGovernanceAction(id),
    onSuccess: (updated) => {
      setTask(updated);
      void refreshAfterChange();
    }
  });
  const cancelTask = useMutation({
    mutationFn: (id: string) => cancelGovernanceAction(id),
    onSuccess: (updated) => {
      setTask(updated);
      void refreshAfterChange();
    }
  });

  const result = preview.data;
  const error = preview.error ?? createTask.error ?? executeTask.error ?? cancelTask.error;
  const busy = preview.isFetching || createTask.isPending || executeTask.isPending || cancelTask.isPending;

  return (
    <Drawer
      className="governance-action-drawer"
      destroyOnClose
      extra={task ? <Tag color={statusColor(task.status)}>{statusLabel(task.status)}</Tag> : null}
      onClose={onClose}
      open={Boolean(issueKey)}
      size={620}
      title={<span className="governance-action-title"><ShieldCheck size={17} />治理行动预览</span>}
    >
      {error && <Alert description={error instanceof Error ? error.message : "治理操作失败"} showIcon type="error" />}
      {preview.isLoading ? <div className="governance-action-loading"><FileSearch size={20} /><span>正在核对受影响对象…</span></div> : !result ? (
        <Empty description="请选择一项治理问题" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <div className="governance-action-content">
          <section className="governance-action-summary">
            <span><small>问题类型</small><strong>{result.issueLabel}</strong></span>
            <span><small>建议动作</small><strong>{result.actionLabel}</strong></span>
            <span><small>当前命中</small><strong>{result.total} {result.grain === "files" ? t("个文件") : "部作品"}</strong></span>
            <span><small>本批处理</small><strong>{result.selectedCount} {t("条")}</strong></span>
          </section>

          <Alert
            description={result.truncated
              ? `当前只选择前 ${result.selectedCount} 条进入本批任务，其余对象不会被执行。可分批复核，降低误操作风险。`
              : "预览只读，不会修改馆藏。创建草稿后仍需再次确认才会执行。"}
            icon={<CircleAlert size={15} />}
            showIcon
            type={result.truncated ? "warning" : "info"}
          />

          <div className="governance-action-batch">
            <span><small>执行批量</small><strong>先预览，再创建待确认任务</strong></span>
            <Select disabled={Boolean(task)} onChange={setLimit} options={batchOptions} value={limit} />
          </div>

          <section className="governance-action-samples">
            <header><span><FileSearch size={15} /><strong>受影响对象</strong></span><small>{t("显示")} {result.samples.length} / {result.total}</small></header>
            <div>
              {result.samples.slice(0, 12).map((item) => (
                <article key={item.targetId}>
                  <span><code>{item.code}</code><strong>{item.title}</strong></span>
                  <small>{item.releaseDate ?? "发行日未知"} · {item.detail || "待复核"}</small>
                </article>
              ))}
            </div>
            {result.samples.length > 12 && <footer>{t("另有")} {result.samples.length - 12} 条已纳入本批任务</footer>}
          </section>

          {task && (
            <section className={`governance-action-task is-${task.status}`}>
              {task.status === "completed" ? <CheckCircle2 size={18} /> : task.status === "failed" ? <XCircle size={18} /> : <ShieldCheck size={18} />}
              <span><small>任务 {task.id.slice(0, 8)}</small><strong>{statusLabel(task.status)} · {task.targetCount} {t("条")}</strong><em>{task.error || (task.status === "draft" ? "对象清单已冻结，确认后才会进入执行队列。" : "可在任务与告警中心持续查看结果。")}</em></span>
            </section>
          )}

          <footer className="governance-action-footer">
            {!task && (
              <Button disabled={result.selectedCount === 0} loading={createTask.isPending} onClick={() => createTask.mutate()} type="primary">
                创建待确认任务
              </Button>
            )}
            {task?.status === "draft" && (
              <>
                <Button danger disabled={busy} onClick={() => cancelTask.mutate(task.id)}>取消草稿</Button>
                <Popconfirm
                  cancelText="返回复核"
                  description={`将对已冻结的 ${task.targetCount} 条对象执行“${result.actionLabel}”。`}
                  okText="确认执行"
                  onConfirm={() => executeTask.mutate(task.id)}
                  title="确认执行这项治理任务？"
                >
                  <Button icon={<PlayCircle size={15} />} loading={executeTask.isPending} type="primary">确认并执行</Button>
                </Popconfirm>
              </>
            )}
            {task && task.status !== "draft" && <Button onClick={onClose}>关闭并前往任务中心追踪</Button>}
          </footer>
        </div>
      )}
    </Drawer>
  );
}
