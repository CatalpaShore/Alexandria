import { getIntlLocale } from "../i18n/core";
import { t, useLocale, useLocalizedMemo } from "../i18n";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Drawer, Empty, Select, Space, Spin, Tag, Typography, message } from "antd";
import { CheckCircle2, Clapperboard, Gauge, RefreshCw, TriangleAlert, Waves } from "lucide-react";
import { useState } from "react";
import { fetchCompatibility, formatBytes, formatDuration, requestCompatibilityAction } from "../lib/api";
import { useInfiniteScroll } from "../lib/useInfiniteScroll";
import "../operations-drawer.css";
import "../compatibility-center.css";

type CompatibilityCenterDrawerProps = {
  open: boolean;
  onClose: () => void;
};

const statuses = ["ALL", "unknown", "native", "remux", "transcode", "unsupported"];
const statusMeta: Record<string, { label: string; note: string; tone: string }> = {
  unknown: { label: "待探测", note: "尚未读取编码信息", tone: "neutral" },
  native: { label: "原生播放", note: "浏览器可直接播放", tone: "success" },
  remux: { label: "建议转封装", note: "无需重新编码", tone: "info" },
  transcode: { label: "需要转码", note: "建议生成 HLS", tone: "warning" },
  unsupported: { label: "暂不支持", note: "需要人工处理", tone: "danger" }
};

export function CompatibilityCenterDrawer({ open, onClose }: CompatibilityCenterDrawerProps) {
  useLocale();
  const [status, setStatus] = useState("ALL");
  const queryClient = useQueryClient();
  const compatibility = useInfiniteQuery({
    queryKey: ["compatibility", status],
    queryFn: ({ pageParam }) => fetchCompatibility({ status, page: pageParam, pageSize: 60 }),
    enabled: open,
    initialPageParam: 1,
    getNextPageParam: (lastPage) =>
      lastPage.page * lastPage.pageSize < lastPage.total ? lastPage.page + 1 : undefined,
    refetchInterval: (query) => {
      const pages = query.state.data?.pages ?? [];
      if (pages.length > 1) return false;
      return pages.some((page) => page.jobs.running) ? 2500 : 10_000;
    }
  });
  const action = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "probe" | "remux" | "hls" }) =>
      requestCompatibilityAction(id, action),
    onSuccess: async () => {
      message.success("已加入后台处理队列");
      await queryClient.invalidateQueries({ queryKey: ["compatibility"] });
    },
    onError: (error) => message.error(error instanceof Error ? error.message : "任务创建失败")
  });
  const firstPage = compatibility.data?.pages[0];
  const items = useLocalizedMemo(
    () => compatibility.data?.pages.flatMap((page) => page.items) ?? [],
    [compatibility.data?.pages]
  );
  const counts = new Map((firstPage?.counts ?? []).map((item) => [item.status, item.count]));
  const selectedMeta = status === "ALL" ? null : statusMeta[status];
  const sentinelRef = useInfiniteScroll({
    enabled: open,
    hasNextPage: Boolean(compatibility.hasNextPage),
    isFetchingNextPage: compatibility.isFetchingNextPage,
    onLoadMore: compatibility.fetchNextPage
  });

  return (
    <Drawer
      className="compatibility-drawer"
      onClose={onClose}
      open={open}
      size={820}
      title={<div className="operations-drawer-title"><span className="operations-title-icon"><Gauge size={18} /></span><span><strong>{t("播放兼容中心")}</strong><small>检查格式并准备浏览器可播放版本</small></span></div>}
    >
      <div className="compatibility-overview">
        <div>
          <strong>{firstPage?.total.toLocaleString(getIntlLocale()) ?? "—"} <small>个媒体文件</small></strong>
          <span>按兼容状态筛选，再对单个文件执行探测或转换。</span>
        </div>
        <Space size={6} wrap>
          <Tag icon={firstPage?.jobs.probeToolAvailable === false ? <TriangleAlert size={12} /> : <CheckCircle2 size={12} />} color={firstPage?.jobs.probeToolAvailable === false ? "warning" : "success"}>媒体探测</Tag>
          <Tag icon={firstPage?.jobs.ffmpegToolAvailable === false ? <TriangleAlert size={12} /> : <CheckCircle2 size={12} />} color={firstPage?.jobs.ffmpegToolAvailable === false ? "warning" : "success"}>转换工具</Tag>
          {firstPage?.jobs.running && <Tag color="processing">后台处理中</Tag>}
        </Space>
      </div>
      <div className="compatibility-stats">
        {statuses.slice(1).map((value) => (
          <button className={`compatibility-stat is-${statusMeta[value].tone}${status === value ? " is-selected" : ""}`} key={value} onClick={() => setStatus(value)} type="button">
            <span>{statusMeta[value].label}</span>
            <strong>{counts.get(value) ?? 0}</strong>
            <small>{statusMeta[value].note}</small>
          </button>
        ))}
      </div>
      <div className="operations-filter-bar">
        <div><strong>{selectedMeta?.label ?? t("全部媒体")}</strong><span>{selectedMeta?.note ?? "显示所有兼容状态"} · 已加载 {items.length.toLocaleString(getIntlLocale())} {t("条")}</span></div>
        <Select className="compatibility-filter" onChange={setStatus} options={statuses.map((value) => ({ value, label: value === "ALL" ? "全部状态" : statusMeta[value].label }))} value={status} />
      </div>
      <div className="drawer-list">
        {compatibility.isLoading ? (
          <div className="drawer-list-loading"><Spin /></div>
        ) : items.length === 0 ? (
          <Empty description="没有匹配的媒体" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : items.map((item) => (
          <div className="drawer-list-row" key={item.id}>
            <div className="drawer-list-copy">
              <Space size={6} wrap>
                <Typography.Text strong>{item.normalizedCode || item.name}</Typography.Text>
                <Tag color={item.compatibilityStatus === "native" ? "success" : item.compatibilityStatus === "unsupported" ? "error" : "warning"}>{statusMeta[item.compatibilityStatus]?.label ?? item.compatibilityStatus}</Tag>
                <Tag>{item.probeStatus === "ready" ? "已探测" : item.probeStatus === "pending" ? "探测中" : t("待探测")}</Tag>
              </Space>
              <Space size={[6, 4]} wrap>
                <Tag>{item.extension.toUpperCase()}</Tag>
                <Tag>{item.containerFormat || t("待探测")}</Tag>
                <Tag>{item.videoCodec || "video ?"}</Tag>
                <Tag>{item.audioCodec || "audio ?"}</Tag>
                <Typography.Text type="secondary">{formatDuration(item.durationSeconds)}</Typography.Text>
                <Typography.Text type="secondary">{formatBytes(item.size)}</Typography.Text>
              </Space>
            </div>
            <Space className="drawer-list-actions" size={6} wrap>
              <Button
                disabled={firstPage?.jobs.probeToolAvailable === false}
                icon={<RefreshCw size={14} />}
                onClick={() => action.mutate({ id: item.id, action: "probe" })}
                size="small"
              >
                探测
              </Button>
              <Button
                disabled={
                  item.compatibilityStatus === "native" ||
                  firstPage?.jobs.ffmpegToolAvailable === false
                }
                icon={<Clapperboard size={14} />}
                onClick={() => action.mutate({ id: item.id, action: "remux" })}
                size="small"
              >
                转封装
              </Button>
              <Button
                disabled={firstPage?.jobs.ffmpegToolAvailable === false}
                icon={<Waves size={14} />}
                onClick={() => action.mutate({ id: item.id, action: "hls" })}
                size="small"
              >
                HLS
              </Button>
            </Space>
          </div>
        ))}
      </div>
      <div className="drawer-load-sentinel" ref={sentinelRef}>
        {compatibility.isFetchingNextPage ? (
          <span><Spin size="small" /> {t("正在加载更多")}</span>
        ) : compatibility.hasNextPage ? (
          <Typography.Text type="secondary">{t("继续滚动加载更多")}</Typography.Text>
        ) : items.length > 0 ? (
          <Typography.Text type="secondary">{t("已显示全部")} {firstPage?.total.toLocaleString(getIntlLocale())} {t("条")}</Typography.Text>
        ) : null}
      </div>
    </Drawer>
  );
}
