import { t, useLocale } from "../i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Drawer, Empty, Popconfirm, Progress, Select, Space, Spin, Statistic, Switch, Tag, Typography, message } from "antd";
import { Captions, Clock3, Eye, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  fetchSubtitleTranslations,
  formatDuration,
  getPosterUrl,
  removeSubtitleTranslation,
  retranslateSubtitleTranslation,
  retrySubtitleTranslation,
  updateSubtitleTranslationSettings,
  type SubtitleTranslationListItem,
  type SubtitleTranslationStatus
} from "../lib/api";

type TranslationManagerDrawerProps = {
  open: boolean;
  onClose: () => void;
  onOpenMedia?: (mediaId: string) => void;
};

type StatusFilter = "ALL" | SubtitleTranslationStatus;

const statusOptions: Array<{ value: StatusFilter; label: string }> = [
  { value: "ALL", label: "全部状态" },
  { value: "running", label: "翻译中" },
  { value: "pending", label: "等待中" },
  { value: "ready", label: "已完成" },
  { value: "failed", label: "失败" },
  { value: "cancelled", label: "已取消" }
];

const statusLabels: Record<SubtitleTranslationStatus, string> = {
  pending: "等待中",
  running: "翻译中",
  ready: "已完成",
  failed: "失败",
  cancelled: "已取消"
};

const stageLabels = {
  queued: "等待可用设备资源",
  source: "检查侧车与内嵌字幕",
  extracting: "FFmpeg 提取单声道音频",
  transcribing: "Whisper 语音识别",
  translating: "翻译中文字幕",
  writing: "写入 WebVTT",
  ready: "汉化字幕已就绪",
  failed: "处理失败",
  cancelled: "任务已取消"
} as const;

function formatTimeSpan(seconds: number): string {
  const safeSeconds = Math.max(0, Math.round(seconds));
  if (safeSeconds < 60) return t("{{p0}} 秒", { p0: safeSeconds });
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainingSeconds = safeSeconds % 60;
  if (hours > 0) return t("{{p0}} 小时 {{p1}} 分", { p0: hours, p1: minutes });
  return remainingSeconds > 0 ? t("{{p0}} 分 {{p1}} 秒", { p0: minutes, p1: remainingSeconds }) : t("{{p0}} 分", { p0: minutes });
}

function timingText(item: SubtitleTranslationListItem, waitingExternalStorage: boolean): string {
  if (item.status === "ready") return `完成用时 ${formatTimeSpan(item.elapsedSeconds)}`;
  if (item.status === "failed") return `失败前已运行 ${formatTimeSpan(item.elapsedSeconds)}`;
  if (item.status === "cancelled") return `取消前已运行 ${formatTimeSpan(item.elapsedSeconds)}`;
  if (item.status === "pending") return waitingExternalStorage ? "等待外置 AI 存储重新连接" : "等待前序任务或播放结束";
  if (item.estimatedRemainingSeconds === null) return "正在采集速度，稍后给出剩余时间";
  return t("预计剩余 {{p0}}", { p0: formatTimeSpan(item.estimatedRemainingSeconds) });
}

function stageProgressText(item: SubtitleTranslationListItem): string {
  if (item.stage === "translating" && item.cueCount > 0) {
    return `${item.translatedCueCount}/${item.cueCount} 条 · 本阶段 ${Math.round(item.stageProgress)}%`;
  }
  if (item.status === "running") return `本阶段 ${Math.round(item.stageProgress)}%`;
  return `${item.progress}%`;
}

function statusColor(status: SubtitleTranslationStatus): string {
  if (status === "ready") return "success";
  if (status === "failed") return "error";
  if (status === "running") return "processing";
  if (status === "pending") return "warning";
  return "default";
}

export function TranslationManagerDrawer({ open, onClose, onOpenMedia }: TranslationManagerDrawerProps) {
  useLocale();
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const queryClient = useQueryClient();
  const translations = useQuery({
    queryKey: ["subtitle-translations", status],
    queryFn: () => fetchSubtitleTranslations({ status, pageSize: 100 }),
    enabled: open,
    refetchInterval: (queryState) => {
      const items = queryState.state.data?.items ?? [];
      return items.some((item) => item.status === "pending" || item.status === "running") ? 2_000 : 10_000;
    },
    refetchOnWindowFocus: "always"
  });
  const retry = useMutation({
    mutationFn: retrySubtitleTranslation,
    onSuccess: async () => {
      message.success("已重新加入汉化队列");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["subtitle-translations"] }),
        queryClient.invalidateQueries({ queryKey: ["media-detail"] })
      ]);
    },
    onError: (error) => message.error(error instanceof Error ? error.message : "重新翻译失败")
  });
  const retranslate = useMutation({
    mutationFn: retranslateSubtitleTranslation,
    onSuccess: async () => {
      message.success("已使用最新翻译模型重新生成中文字幕");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["subtitle-translations"] }),
        queryClient.invalidateQueries({ queryKey: ["media-detail"] })
      ]);
    },
    onError: (error) => message.error(error instanceof Error ? error.message : "再次翻译失败")
  });
  const remove = useMutation({
    mutationFn: removeSubtitleTranslation,
    onSuccess: async (result) => {
      message.success(result.action === "removed" ? "翻译任务与字幕已移除" : result.action === "cancelling" ? "正在停止当前翻译步骤" : "翻译任务已取消");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["subtitle-translations"] }),
        queryClient.invalidateQueries({ queryKey: ["media-detail"] })
      ]);
    },
    onError: (error) => message.error(error instanceof Error ? error.message : "移除翻译任务失败")
  });
  const updateSettings = useMutation({
    mutationFn: updateSubtitleTranslationSettings,
    onSuccess: async ({ capabilities }) => {
      message.success(capabilities.autoTranslateFavorites ? "翻译优先队列已开启" : "翻译优先队列已关闭");
      await queryClient.invalidateQueries({ queryKey: ["subtitle-translations"] });
    },
    onError: (error) => message.error(error instanceof Error ? error.message : "更新自动翻译设置失败")
  });
  const data = translations.data;
  const counts = data?.counts ?? {};

  return (
    <Drawer className="translation-manager-drawer" onClose={onClose} open={open} size={820} title={t("翻译管理")}>
      <div className="translation-manager-summary">
        <div>
          <Captions size={22} />
          <div>
            <Typography.Title level={4}>视频汉化翻译管线</Typography.Title>
            <Typography.Text type="secondary">一次只处理一个视频，播放期间暂停启动新的识别任务。</Typography.Text>
          </div>
        </div>
        <div className="translation-manager-stats">
          <Statistic title="等待" value={counts.pending ?? 0} />
          <Statistic title="处理中" value={counts.running ?? 0} />
          <Statistic title={t("已完成")} value={counts.ready ?? 0} />
          <Statistic title="失败" value={counts.failed ?? 0} />
        </div>
      </div>

      {data && !data.capabilities.whisperAvailable && (
        <Alert
          className="translation-manager-alert"
          description={`现有字幕或内嵌字幕仍可直接汉化；没有字幕的视频需要先安装本地 Whisper，或配置 ${data.capabilities.whisperCommand} 命令。`}
          title="当前设备未检测到 Whisper"
          showIcon
          type="warning"
        />
      )}

      {data?.capabilities.externalStorageRequired && !data.capabilities.externalStorageReady && (
        <Alert
          className="translation-manager-alert"
          description="新翻译任务会保留在等待队列；已有中文字幕、播放器、扫描和其他媒体任务不受影响。"
          title={data.capabilities.externalStorageMessage ?? "等待外置 AI 存储"}
          showIcon
          type="warning"
        />
      )}

      {data && (
        <Alert
          action={(
            <Switch
              aria-label="翻译优先队列自动补充"
              checked={data.capabilities.autoTranslateFavorites}
              loading={updateSettings.isPending}
              onChange={(checked) => updateSettings.mutate({ autoTranslateFavorites: checked })}
            />
          )}
          className="translation-manager-alert"
          description={data.capabilities.autoTranslateFavorites
            ? data.capabilities.priorityBacklogCount > 0
              ? `当前优先顺序为“收藏影片 → 收藏专题 → 收藏演员 → 其他馆藏”；还有 ${data.capabilities.priorityBacklogCount} 部未进入翻译管线，当前任务完成且未播放视频时会自动补入下一部。`
              : "收藏影片、专题、演员及其他馆藏均已完成、进入过翻译管线，或没有可处理的视频。"
            : `优先队列自动补充已暂停；仍有 ${data.capabilities.priorityBacklogCount} 部影片可按“收藏影片 → 收藏专题 → 收藏演员 → 其他馆藏”的顺序手动发起，正在运行的单个任务不会被强制中断。`}
          title={`翻译优先队列自动汉化${data.capabilities.autoTranslateFavorites ? "已开启" : "已关闭"}`}
          showIcon
          type={data.capabilities.autoTranslateFavorites ? "info" : "warning"}
        />
      )}

      <div className="translation-manager-toolbar">
        <Select<StatusFilter>
          aria-label="筛选翻译状态"
          onChange={setStatus}
          options={statusOptions}
          value={status}
        />
        {data && (
            <Typography.Text type="secondary">
              单并发 · {
              data.capabilities.whisperBackend === "whisper-cpp"
                ? `${data.capabilities.whisperCppMetal ? "Metal" : `CPU ${data.capabilities.whisperThreads} 线程`}${data.capabilities.whisperCppVadAvailable ? " + VAD" : ""}`
                : data.capabilities.whisperBackend === "openai"
                  ? `CPU ${data.capabilities.whisperThreads} 线程`
                  : "语音识别不可用"
            } · {
              data.capabilities.dedicatedTranslation
                ? `ASR 纠错 ${data.capabilities.asrCorrectionModel} → 专用翻译 ${data.capabilities.dedicatedTranslationModel}`
                : data.capabilities.contextualTranslation
                  ? `本地上下文翻译 ${data.capabilities.contextualTranslationModel}`
                : data.capabilities.provider === "libretranslate" ? "LibreTranslate" : "Google 翻译"
            } · 目标 {data.capabilities.targetLanguage}
          </Typography.Text>
        )}
      </div>

      <div className="translation-task-list">
        {translations.isLoading ? (
          <div className="drawer-list-loading"><Spin /></div>
        ) : !data?.items.length ? (
          <Empty description="还没有视频进入汉化翻译管线" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : data.items.map((item) => (
          <article className={`translation-task-card motion-list-item motion-status-card is-${item.status}`} key={item.mediaId}>
            <img alt="" loading="lazy" src={getPosterUrl(item.mediaId)} />
            <div className="translation-task-main">
              <div className="translation-task-heading">
                <div>
                  <Typography.Text strong>{item.normalizedCode || item.basename}</Typography.Text>
                  <Typography.Text type="secondary">{item.sourceName} · {formatDuration(item.durationSeconds)}</Typography.Text>
                </div>
                <Tag color={statusColor(item.status)}>{statusLabels[item.status]}</Tag>
              </div>
              <div className="translation-task-stage">
                <div>
                  <Typography.Text>{stageLabels[item.stage]}</Typography.Text>
                  <Typography.Text type="secondary">{stageProgressText(item)}</Typography.Text>
                </div>
                <div className="translation-task-timing">
                  <Clock3 size={13} />
                  <Typography.Text type="secondary">{timingText(item, Boolean(data?.capabilities.externalStorageRequired && !data.capabilities.externalStorageReady))}</Typography.Text>
                </div>
              </div>
              <Progress
                percent={item.progress}
                railColor="#303030"
                showInfo={false}
                status={item.status === "failed" ? "exception" : item.status === "ready" ? "success" : "active"}
                strokeColor="#ff9900"
              />
              <div aria-label={t("翻译处理流程")} className="translation-pipeline">
                {item.pipelineSteps.map((step) => (
                  <div className={`translation-pipeline-step is-${step.status}`} key={step.key}>
                    <span aria-hidden="true" className="translation-pipeline-dot" />
                    <span>{step.label}</span>
                  </div>
                ))}
              </div>
              {(item.status === "running" || item.status === "pending") && (
                <div className="translation-task-progress-meta">
                  <Typography.Text type="secondary">总进度 {item.progress}%</Typography.Text>
                  <Typography.Text type="secondary">
                    已耗时 {formatTimeSpan(item.elapsedSeconds)}
                    {item.estimateConfidence === "low" ? " · 初步估算" : item.estimateConfidence === "high" ? " · 动态估算" : ""}
                  </Typography.Text>
                </div>
              )}
              {item.error ? (
                <Typography.Text className="translation-task-error" type="danger">{item.error}</Typography.Text>
              ) : (
                <Space className="translation-task-tags" size={[4, 4]} wrap>
                  {item.sourceKind && <Tag>{item.sourceKind === "speech" ? "语音识别" : item.sourceKind === "existing-chinese" ? "已有中文字幕" : "字幕源"}</Tag>}
                  {item.cueCount > 0 && item.stage !== "translating" && <Tag>{item.translatedCueCount}/{item.cueCount} {t("条")}</Tag>}
                  {item.model && <Tag>Whisper {item.model}</Tag>}
                </Space>
              )}
            </div>
            <Space className="translation-task-actions" orientation="vertical" size={6}>
              {onOpenMedia && (
                <Button icon={<Eye size={14} />} onClick={() => onOpenMedia(item.mediaId)} size="small">{t("详情")}</Button>
              )}
              {(item.status === "failed" || item.status === "cancelled") && (
                <Button icon={<RefreshCw size={14} />} loading={retry.isPending && retry.variables === item.mediaId} onClick={() => retry.mutate(item.mediaId)} size="small">
                  {t("重试")} </Button>
              )}
              {item.status === "ready" && item.sourceKind === "speech" && (
                <Popconfirm
                  description="将复用已保存的日语识别字幕，只重新生成中文字幕，不会重复提取音频或运行 Whisper。"
                  okText="重新翻译"
                  onConfirm={() => retranslate.mutate(item.mediaId)}
                  title="重新翻译这条字幕？"
                >
                  <Button
                    icon={<RefreshCw size={14} />}
                    loading={retranslate.isPending && retranslate.variables === item.mediaId}
                    size="small"
                  >
                    重新翻译
                  </Button>
                </Popconfirm>
              )}
              <Popconfirm
                description={item.status === "pending" || item.status === "running"
                  ? "运行中的任务会立即停止当前 FFmpeg/Whisper 步骤。"
                  : item.status === "ready"
                    ? "生成的中文字幕也会一起删除。"
                    : "这条任务记录会从翻译管理中删除。"}
                okText={item.status === "pending" || item.status === "running" ? "取消任务" : t("删除")}
                onConfirm={() => remove.mutate(item.mediaId)}
                title={item.status === "pending" || item.status === "running" ? "取消翻译任务？" : item.status === "ready" ? "删除汉化字幕？" : "删除任务记录？"}
              >
                <Button danger icon={<Trash2 size={14} />} loading={remove.isPending && remove.variables === item.mediaId} size="small">
                  {item.status === "pending" || item.status === "running" ? t("取消") : t("删除")}
                </Button>
              </Popconfirm>
            </Space>
          </article>
        ))}
      </div>
      {data && data.total > data.items.length && (
        <Typography.Text className="translation-manager-limit" type="secondary">
          当前筛选共 {data.total} 条，已显示最近 {data.items.length} 条。
        </Typography.Text>
      )}
    </Drawer>
  );
}
