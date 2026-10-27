import { getIntlLocale } from "../i18n/core";
import { t, useLocale, useLocalizedMemo } from "../i18n";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Drawer, Empty, Input, Modal, Select, Space, Spin, Tag, Typography, message } from "antd";
import { DatabaseZap, Pencil, RefreshCw, Save, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { fetchMetadataQuality, requestMetadataEnrich, updateMetadataOverride } from "../lib/api";
import { useInfiniteScroll } from "../lib/useInfiniteScroll";
import "../operations-drawer.css";
import "../metadata-quality.css";

type MetadataQualityDrawerProps = {
  open: boolean;
  onClose: () => void;
};

const issueOptions = [
  { value: "all", label: "全部记录" },
  { value: "unmatched", label: "未匹配/失败" },
  { value: "missing-cover", label: "缺少封面" },
  { value: "translation", label: "翻译待处理" },
  { value: "missing-title-zh", label: "缺中文标题" },
  { value: "missing-actor-zh", label: "缺中文演员" },
  { value: "missing-genre-zh", label: "缺中文标签" },
  { value: "duration-conflict", label: "时长冲突" },
  { value: "future-release-date", label: "发行日期异常" },
  { value: "low-completeness", label: "元数据过少" },
  { value: "duplicate", label: "重复番号" },
  { value: "missing-probe", label: "媒体信息待探测" },
  { value: "compatibility", label: "播放兼容问题" }
];
const headlineIssues = [
  { key: "unmatched", label: "未匹配", issue: "unmatched", tone: "danger" },
  { key: "missingCover", label: "缺少封面", issue: "missing-cover", tone: "warning" },
  { key: "translation", label: "翻译待处理", issue: "translation", tone: "info" },
  { key: "duplicate", label: "重复番号", issue: "duplicate", tone: "warning" },
  { key: "missingProbe", label: "媒体待探测", issue: "missing-probe", tone: "neutral" },
  { key: "compatibility", label: "兼容问题", issue: "compatibility", tone: "danger" }
] as const;

export function MetadataQualityDrawer({ open, onClose }: MetadataQualityDrawerProps) {
  useLocale();
  const [issue, setIssue] = useState("all");
  const [editing, setEditing] = useState<{ code: string; titleZh: string } | null>(null);
  const queryClient = useQueryClient();
  const quality = useInfiniteQuery({
    queryKey: ["metadata-quality", issue],
    queryFn: ({ pageParam }) => fetchMetadataQuality({ issue, page: pageParam, pageSize: 60 }),
    enabled: open,
    initialPageParam: 1,
    getNextPageParam: (lastPage) =>
      lastPage.page < lastPage.totalPages ? lastPage.page + 1 : undefined,
    refetchInterval: (query) =>
      (query.state.data?.pages.length ?? 0) <= 1 ? 15_000 : false
  });
  const retry = useMutation({
    mutationFn: (code: string) => requestMetadataEnrich({ codes: [code], force: true, limit: 1, async: true }),
    onSuccess: () => message.success("已加入元数据重抓队列")
  });
  const saveOverride = useMutation({
    mutationFn: () => updateMetadataOverride(editing?.code ?? "", { titleZh: editing?.titleZh ?? "" }),
    onSuccess: async () => {
      setEditing(null);
      message.success("人工修订已保存");
      await queryClient.invalidateQueries({ queryKey: ["metadata-quality"] });
    }
  });
  const firstPage = quality.data?.pages[0];
  const counts = firstPage?.counts;
  const indexedIssueCounts = firstPage?.indexedIssues ?? [];
  const indexedCount = (type: string) => indexedIssueCounts
    .filter((entry) => entry.type === type)
    .reduce((sum, entry) => sum + entry.count, 0);
  const items = useLocalizedMemo(
    () => quality.data?.pages.flatMap((page) => page.items) ?? [],
    [quality.data?.pages]
  );
  const sentinelRef = useInfiniteScroll({
    enabled: open,
    hasNextPage: Boolean(quality.hasNextPage),
    isFetchingNextPage: quality.isFetchingNextPage,
    onLoadMore: quality.fetchNextPage
  });

  return (
    <Drawer className="metadata-quality-drawer" onClose={onClose} open={open} size={760} title={<div className="operations-drawer-title"><span className="operations-title-icon"><ShieldCheck size={18} /></span><span><strong>{t("元数据质量中心")}</strong><small>集中发现、筛选并修复馆藏资料问题</small></span></div>}>
      <div className="quality-overview">
        <span className="operations-title-icon"><DatabaseZap size={20} /></span>
        <div><strong>{firstPage?.total.toLocaleString(getIntlLocale()) ?? "—"} <small>条待处理记录</small></strong><span>优先处理阻碍识别、检索和播放的问题。</span></div>
      </div>
      <div className="quality-stats">
        {headlineIssues.map((entry) => (
          <button className={`quality-stat is-${entry.tone}${issue === entry.issue ? " is-selected" : ""}`} key={entry.key} onClick={() => setIssue(entry.issue)} type="button">
            <span>{entry.label}</span><strong>{counts?.[entry.key] ?? 0}</strong>
          </button>
        ))}
      </div>
      <Space className="quality-indexed-stats" size={[6, 6]} wrap>
        <Tag>缺中文标题 {indexedCount("missing_title_zh")}</Tag>
        <Tag>缺中文演员 {indexedCount("missing_actor_zh")}</Tag>
        <Tag>缺中文标签 {indexedCount("missing_genre_zh")}</Tag>
        <Tag color="warning">时长冲突 {indexedCount("duration_conflict")}</Tag>
        <Tag color="error">日期异常 {indexedCount("future_release_date")}</Tag>
        <Tag color="orange">字段过少 {indexedCount("low_completeness")}</Tag>
      </Space>
      <div className="operations-filter-bar">
        <div><strong>{issueOptions.find((option) => option.value === issue)?.label}</strong><span>{t("已加载")} {items.length.toLocaleString(getIntlLocale())} / {firstPage?.total.toLocaleString(getIntlLocale()) ?? "—"} {t("条")}</span></div>
        <Select className="quality-filter" onChange={setIssue} options={issueOptions} value={issue} />
      </div>
      <div className="drawer-list">
        {quality.isLoading ? (
          <div className="drawer-list-loading"><Spin /></div>
        ) : items.length === 0 ? (
          <Empty description="没有匹配的质量问题" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : items.map((item) => (
          <div className="drawer-list-row" key={`${item.normalizedCode}:${item.mediaId ?? "metadata"}`}>
            <div className="drawer-list-copy">
              <Space size={6} wrap>
                <Typography.Text strong>{item.normalizedCode}</Typography.Text>
                <Tag>{item.status}</Tag>
                {item.qualityIssue && (
                  <Tag color={item.qualitySeverity === "error" ? "error" : item.qualitySeverity === "warning" ? "warning" : "default"}>
                    {issueOptions.find((option) => option.value.replace(/-/g, "_") === item.qualityIssue)?.label ?? item.qualityIssue}
                  </Tag>
                )}
                {item.mediaCount > 1 && <Tag color="orange">{item.mediaCount} {t("个版本")}</Tag>}
              </Space>
              <Typography.Text type="secondary" ellipsis={{ tooltip: item.titleZh || item.title || item.error || "暂无标题" }}>
                {item.titleZh || item.title || item.error || "暂无标题"}
              </Typography.Text>
            </div>
            <Space className="drawer-list-actions" size={6}>
              <Button icon={<Pencil size={14} />} key="edit" onClick={() => setEditing({ code: item.normalizedCode, titleZh: item.titleZh || item.title })} size="small">
                修订
              </Button>
              <Button
                icon={<RefreshCw size={14} />}
                key="retry"
                loading={retry.isPending}
                onClick={() => retry.mutate(item.normalizedCode)}
                size="small"
              >
                重抓
              </Button>
            </Space>
          </div>
        ))}
      </div>
      <div className="drawer-load-sentinel" ref={sentinelRef}>
        {quality.isFetchingNextPage ? (
          <span><Spin size="small" /> {t("正在加载更多")}</span>
        ) : quality.hasNextPage ? (
          <Typography.Text type="secondary">{t("继续滚动加载更多")}</Typography.Text>
        ) : items.length > 0 ? (
          <Typography.Text type="secondary">{t("已显示全部")} {firstPage?.total.toLocaleString(getIntlLocale())} {t("条")}</Typography.Text>
        ) : null}
      </div>
      <Modal
        okButtonProps={{ icon: <Save size={15} />, loading: saveOverride.isPending }}
        okText="保存修订"
        onCancel={() => setEditing(null)}
        onOk={() => saveOverride.mutate()}
        open={Boolean(editing)}
        title={`修订 ${editing?.code ?? ""}`}
      >
        <Input.TextArea
          autoSize={{ minRows: 3, maxRows: 8 }}
          onChange={(event) => setEditing((current) => current ? { ...current, titleZh: event.target.value } : null)}
          value={editing?.titleZh ?? ""}
        />
      </Modal>
    </Drawer>
  );
}
