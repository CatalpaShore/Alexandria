import { getIntlLocale } from "../i18n/core";
import { t, useLocale, useLocalizedMemo } from "../i18n";
import { useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Drawer, Input, Modal, Select, Space, Spin, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Database, FolderOutput, Pencil, Play, RefreshCw, Search, Sparkles } from "lucide-react";
import {
  fetchMetadataItems,
  removeMetadataMedia,
  renameMetadataMedia,
  requestMetadataEnrich,
  type MetadataItem
} from "../lib/api";
import { useInfiniteScroll } from "../lib/useInfiniteScroll";
import "../operations-drawer.css";
import "../admin-management.css";

type MetadataManagerDrawerProps = {
  open: boolean;
  onClose: () => void;
  onPlay: (id: string) => void;
};

const { Text } = Typography;
const PAGE_SIZE = 50;
const statusMeta = {
  ready: { label: "已匹配", tone: "success" },
  not_found: { label: "未匹配", tone: "warning" },
  failed: { label: "抓取失败", tone: "error" },
  pending: { label: "待处理", tone: "default" },
  fetching: { label: "抓取中", tone: "processing" }
} as const;
type MetadataStatusKey = keyof typeof statusMeta;
const statusOptions = [
  { value: "ALL", label: "全部" },
  { value: "ready", label: "已匹配" },
  { value: "not_found", label: "未匹配" },
  { value: "failed", label: "失败" },
  { value: "pending", label: "待处理" },
  { value: "fetching", label: "抓取中" }
];

function statusColor(status: string) {
  if (status === "ready") return "success";
  if (status === "not_found") return "warning";
  if (status === "failed") return "error";
  if (status === "fetching") return "processing";
  return "default";
}

function statusLabel(status: string) {
  return statusMeta[status as MetadataStatusKey]?.label ?? status;
}

export function MetadataManagerDrawer({ open, onClose, onPlay }: MetadataManagerDrawerProps) {
  useLocale();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("not_found");
  const [selectedCodes, setSelectedCodes] = useState<string[]>([]);
  const [repairItem, setRepairItem] = useState<MetadataItem | null>(null);
  const [newBasename, setNewBasename] = useState("");
  const [retryingCodes, setRetryingCodes] = useState<string[]>([]);
  const queryClient = useQueryClient();
  const metadataItems = useInfiniteQuery({
    enabled: open,
    queryKey: ["metadata-items", { q, status }],
    queryFn: ({ pageParam }) => fetchMetadataItems({ q, status, page: pageParam, pageSize: PAGE_SIZE }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) =>
      lastPage.page < lastPage.totalPages ? lastPage.page + 1 : undefined
  });
  const retryMetadata = useMutation({
    mutationFn: (codes: string[]) =>
      requestMetadataEnrich({
        codes,
        force: true,
        limit: Math.max(1, Math.min(codes.length, 50))
      }),
    onMutate: (codes) => {
      setRetryingCodes((current) => [...new Set([...current, ...codes])]);
    },
    onSuccess: async (data) => {
      const failures = data.results?.filter((result) => result.status === "failed" || result.status === "not_found") ?? [];
      const ready = data.results?.filter((result) => result.status === "ready") ?? [];
      if (!data.summary.configured) {
        message.error(data.summary.message || "元数据服务尚未配置，本次未执行抓取");
      } else if (failures.length > 0) {
        Modal.warning({
          title: `元数据抓取未完成（${failures.length} 条）`,
          content: (
            <Space orientation="vertical" size={8} style={{ width: "100%" }}>
              {failures.map((result) => (
                <Alert
                  description={result.error || "数据源未返回详细错误"}
                  key={result.normalizedCode}
                  message={`${result.normalizedCode} · ${statusLabel(result.status)}`}
                  showIcon
                  type={result.status === "failed" ? "error" : "warning"}
                />
              ))}
            </Space>
          )
        });
      } else if (ready.length > 0) {
        message.success(`元数据处理完成：成功 ${ready.length}`);
      } else {
        message.warning(data.summary.message || "本次没有记录成功匹配，请查看任务状态");
      }
      setSelectedCodes([]);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["metadata-items"] }),
        queryClient.invalidateQueries({ queryKey: ["metadata-status"] }),
        queryClient.invalidateQueries({ queryKey: ["media"] }),
        queryClient.invalidateQueries({ queryKey: ["facets"] })
      ]);
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : "元数据重试失败");
    },
    onSettled: (_data, _error, codes) => {
      setRetryingCodes((current) => current.filter((code) => !codes.includes(code)));
    }
  });
  const repairMedia = useMutation({
    mutationFn: ({ id, basename }: { id: string; basename: string }) => renameMetadataMedia(id, basename),
    onSuccess: async (data) => {
      message.success(`${data.newName} 已归档，正在重新抓取 ${data.normalizedCode} 元数据`);
      setRepairItem(null);
      setNewBasename("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["metadata-items"] }),
        queryClient.invalidateQueries({ queryKey: ["metadata-status"] }),
        queryClient.invalidateQueries({ queryKey: ["media"] }),
        queryClient.invalidateQueries({ queryKey: ["media-detail"] }),
        queryClient.invalidateQueries({ queryKey: ["facets"] }),
        queryClient.invalidateQueries({ queryKey: ["home-dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["topic-overview"] })
      ]);
    },
    onError: (error) => message.error(error instanceof Error ? error.message : "文件修正失败")
  });
  const removeMedia = useMutation({
    mutationFn: (id: string) => removeMetadataMedia(id),
    onSuccess: async (data) => {
      message.success(`${data.name} 已移回 Download 目录`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["metadata-items"] }),
        queryClient.invalidateQueries({ queryKey: ["metadata-status"] }),
        queryClient.invalidateQueries({ queryKey: ["media"] }),
        queryClient.invalidateQueries({ queryKey: ["media-detail"] }),
        queryClient.invalidateQueries({ queryKey: ["facets"] }),
        queryClient.invalidateQueries({ queryKey: ["home-dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["topic-overview"] })
      ]);
    },
    onError: (error) => message.error(error instanceof Error ? error.message : "移除文件失败")
  });
  const firstPage = metadataItems.data?.pages[0];
  const items = useLocalizedMemo(
    () => metadataItems.data?.pages.flatMap((page) => page.items) ?? [],
    [metadataItems.data?.pages]
  );
  const stats = firstPage?.stats ?? {};
  const sentinelRef = useInfiniteScroll({
    enabled: open,
    hasNextPage: Boolean(metadataItems.hasNextPage),
    isFetchingNextPage: metadataItems.isFetchingNextPage,
    onLoadMore: metadataItems.fetchNextPage
  });
  const columns = useLocalizedMemo<ColumnsType<MetadataItem>>(
    () => [
      {
        title: "封面",
        dataIndex: "coverUrl",
        width: 76,
        render: (_value, record) =>
          record.coverUrl || record.thumbUrl ? (
            <img className="metadata-thumb" src={record.coverUrl || record.thumbUrl} alt="" loading="lazy" />
          ) : (
            <div className="metadata-thumb metadata-thumb-empty">{record.normalizedCode.slice(0, 2)}</div>
          )
      },
      {
        title: t("番号"),
        dataIndex: "normalizedCode",
        width: 130,
        render: (value, record) => (
          <Space orientation="vertical" size={2}>
            <Text strong>{value}</Text>
            <Tag color={statusColor(record.status)}>{statusLabel(record.status)}</Tag>
          </Space>
        )
      },
      {
        title: "信息",
        dataIndex: "title",
        width: 360,
        render: (_value, record) => (
          <Space orientation="vertical" size={4}>
            <Text className="metadata-title-cell" title={record.titleZh || record.title || ""}>
              {record.titleZh || record.title || "暂无标题"}
            </Text>
            <Text type="secondary">
              {[(record.actorsZh.length > 0 ? record.actorsZh : record.actors).slice(0, 3).join(" / "), record.makerZh || record.maker, record.releaseDate]
                .filter(Boolean)
                .join(" · ") || "元数据不完整"}
            </Text>
            {(record.genresZh.length > 0 || record.genres.length > 0) && (
              <Space size={[4, 4]} wrap>
                {(record.genresZh.length > 0 ? record.genresZh : record.genres).slice(0, 5).map((genre) => (
                  <Tag key={genre}>{genre}</Tag>
                ))}
                <Tag color={record.translationStatus === "ready" ? "success" : "default"}>
                  {t("翻译")} {record.translationStatus}
                </Tag>
              </Space>
            )}
            {record.error && (
              <Text className="metadata-error-detail" type={record.status === "failed" ? "danger" : "warning"}>
                {record.error}
              </Text>
            )}
          </Space>
        )
      },
      {
        title: "原始文件名",
        dataIndex: "originalBasename",
        width: 190,
        render: (_value, record) => (
          <Text className="metadata-original-filename" copyable={Boolean(record.originalBasename)} title={record.originalRelativePath || record.originalBasename || ""}>
            {record.originalBasename || "无历史记录"}
          </Text>
        )
      },
      {
        title: "操作",
        dataIndex: "action",
        width: 148,
        render: (_value, record) => (
          <Space className="metadata-row-actions" size={4}>
            <Button
              aria-label={t("播放 {{p0}}", { p0: record.normalizedCode })}
              className="metadata-action-button"
              disabled={!record.mediaId}
              icon={<Play size={14} />}
              onClick={() => record.mediaId && onPlay(record.mediaId)}
              size="small"
              title={t("播放")}
            />
            <Button
              aria-label={`修正 ${record.normalizedCode}`}
              className="metadata-action-button"
              disabled={!record.mediaId}
              icon={<Pencil size={14} />}
              onClick={() => {
                setRepairItem(record);
                setNewBasename(record.mediaBasename || record.normalizedCode);
              }}
              size="small"
              title="修正番号与文件名"
            />
            <Button
              aria-label={t("移除 {{p0}}", { p0: record.normalizedCode })}
              className="metadata-remove-button"
              danger
              disabled={!record.mediaId}
              icon={<FolderOutput size={14} />}
              loading={removeMedia.isPending && removeMedia.variables === record.mediaId}
              onClick={() => {
                if (!record.mediaId) return;
                Modal.confirm({
                  cancelText: t("取消"),
                  content: (
                    <Space orientation="vertical" size={6}>
                      <Text>文件不会被删除，而是移回所在磁盘的 Download 目录，并从媒体墙索引中移除。</Text>
                      <Text type="secondary">{record.mediaRelativePath}</Text>
                      {record.mediaCount > 1 && <Text type="warning">该番号还有 {record.mediaCount - 1} 个其他文件，本次只移动当前文件。</Text>}
                    </Space>
                  ),
                  okButtonProps: { danger: true },
                  okText: "移回 Download",
                  onOk: () => removeMedia.mutateAsync(record.mediaId as string),
                  title: `移除 ${record.mediaBasename || record.normalizedCode}？`
                });
              }}
              size="small"
              title="移回 Download"
            />
            <Button
              aria-label={`重新抓取 ${record.normalizedCode}`}
              className="metadata-action-button"
              icon={<Sparkles size={14} />}
              loading={retryingCodes.includes(record.normalizedCode)}
              onClick={() => retryMetadata.mutate([record.normalizedCode])}
              size="small"
              title="重新抓取元数据"
            />
          </Space>
        )
      }
    ],
    [onPlay, removeMedia, retryMetadata, retryingCodes]
  );

  return (
    <Drawer
      className="metadata-manager-drawer"
      onClose={onClose}
      open={open}
      placement="right"
      title={<div className="operations-drawer-title"><span className="operations-title-icon"><Database size={18} /></span><span><strong>{t("元数据管理")}</strong><small>定位异常记录并安全修订文件与资料</small></span></div>}
      size={1100}
    >
      <div className="metadata-manager-shell">
        <div className="metadata-manager-toolbar">
          <Input
            allowClear
            className="metadata-search"
            onChange={(event) => setQ(event.target.value)}
            placeholder="搜索番号、演员、厂商、错误信息"
            prefix={<Search size={15} />}
            value={q}
          />
          <Select
            className="metadata-status-select"
            onChange={setStatus}
            options={statusOptions}
            value={status}
          />
          <Button
            icon={<RefreshCw size={15} />}
            onClick={() => metadataItems.refetch()}
          >
            刷新
          </Button>
        </div>

        <div className="metadata-status-row">
          {(Object.keys(statusMeta) as MetadataStatusKey[]).map((key) => (
            <button
              aria-pressed={status === key}
              className={`metadata-status-chip metadata-status-${statusMeta[key].tone}${status === key ? " is-active" : ""}`}
              key={key}
              onClick={() => setStatus(key)}
              type="button"
            >
              <span className="metadata-status-dot" />
              <span>{statusMeta[key].label}</span>
              <strong>{(stats[key] ?? 0).toLocaleString(getIntlLocale())}</strong>
            </button>
          ))}
        </div>

        <div
          aria-live="polite"
          className={`metadata-bulk-row motion-status-card${selectedCodes.length > 0 ? " has-selection" : ""}`}
        >
          <div><Text strong>{statusOptions.find((option) => option.value === status)?.label ?? t("全部")}工作集</Text><Text type="secondary">{t("已加载")} {items.length.toLocaleString(getIntlLocale())} / {firstPage?.total.toLocaleString(getIntlLocale()) ?? "—"} 条 · 已选 {selectedCodes.length.toLocaleString(getIntlLocale())} {t("条")}</Text></div>
          <Button
            disabled={selectedCodes.length === 0}
            icon={<Sparkles size={15} />}
            loading={selectedCodes.length > 0 && selectedCodes.every((code) => retryingCodes.includes(code))}
            onClick={() => retryMetadata.mutate(selectedCodes)}
            type="primary"
          >
            批量重抓
          </Button>
        </div>

        <Table
          columns={columns}
          dataSource={items}
          loading={metadataItems.isLoading}
          pagination={false}
          rowKey="normalizedCode"
          scroll={{ x: 980 }}
          rowSelection={{
            selectedRowKeys: selectedCodes,
            onChange: (keys) => setSelectedCodes(keys.map(String))
          }}
          size="small"
        />
        <div className="drawer-load-sentinel" ref={sentinelRef}>
          {metadataItems.isFetchingNextPage ? (
            <span><Spin size="small" /> {t("正在加载更多")}</span>
          ) : metadataItems.hasNextPage ? (
            <Text type="secondary">{t("继续滚动加载更多")}</Text>
          ) : items.length > 0 ? (
            <Text type="secondary">{t("已显示全部")} {firstPage?.total.toLocaleString(getIntlLocale())} {t("条")}</Text>
          ) : null}
        </div>
      </div>
      <Modal
        className="metadata-repair-modal"
        confirmLoading={repairMedia.isPending}
        destroyOnHidden
        okButtonProps={{ disabled: !repairItem?.mediaId || !newBasename.trim() }}
        okText="保存并重新抓取"
        onCancel={() => setRepairItem(null)}
        onOk={() => {
          if (repairItem?.mediaId) repairMedia.mutate({ id: repairItem.mediaId, basename: newBasename });
        }}
        open={Boolean(repairItem)}
        title="修正番号与文件位置"
      >
        <div className="metadata-repair-form">
          <Alert
            description="保存后会在当前数据源内移动并重命名视频，同时同步数据库、播放记录和收藏路径，然后异步重新抓取该番号的元数据。"
            showIcon
            type="warning"
          />
          <div>
            <Text type="secondary">{t("当前文件")}</Text>
            <Text className="metadata-repair-path" copyable>{repairItem?.mediaRelativePath || "未知路径"}</Text>
          </div>
          <label htmlFor="metadata-repair-basename">新文件名或番号</label>
          <Input
            autoFocus
            id="metadata-repair-basename"
            maxLength={240}
            onChange={(event) => setNewBasename(event.target.value)}
            onPressEnter={() => {
              if (repairItem?.mediaId && newBasename.trim()) repairMedia.mutate({ id: repairItem.mediaId, basename: newBasename });
            }}
            placeholder="例如 START-585-C"
            value={newBasename}
          />
          <Text type="secondary">可省略原扩展名；系统会按新番号自动归入正确的字母或数字目录。</Text>
        </div>
      </Modal>
    </Drawer>
  );
}
