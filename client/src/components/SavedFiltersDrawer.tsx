import { t, useLocale } from "../i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Drawer, Empty, Input, Popconfirm, Space, Spin, Typography, message } from "antd";
import { Bookmark, BookmarkPlus, Play, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  createSavedFilter,
  deleteSavedFilter,
  fetchSavedFilters,
  type MediaQuery
} from "../lib/api";
import "../operations-drawer.css";
import "../admin-management.css";

type SavedFiltersDrawerProps = {
  open: boolean;
  query: MediaQuery;
  onApply: (query: Partial<MediaQuery>) => void;
  onClose: () => void;
};

const { Text } = Typography;

function describeQuery(query: Partial<MediaQuery>): string {
  const labels = [
    query.category && query.category !== "ALL" ? query.category : "",
    query.q ? t("搜索 {{p0}}", { p0: query.q }) : "",
    query.actor?.length ? t("{{p0}} 位演员", { p0: query.actor.length }) : "",
    query.genre?.length ? t("{{p0}} 个标签", { p0: query.genre.length }) : "",
    query.metadataSeries?.length ? t("{{p0}} 个系列", { p0: query.metadataSeries.length }) : "",
    query.favoriteOnly ? t("仅收藏") : ""
  ].filter(Boolean);
  return labels.join(" · ") || t("全部媒体");
}

export function SavedFiltersDrawer({ open, query, onApply, onClose }: SavedFiltersDrawerProps) {
  useLocale();
  const [name, setName] = useState("");
  const queryClient = useQueryClient();
  const saved = useQuery({
    queryKey: ["saved-filters"],
    queryFn: fetchSavedFilters,
    enabled: open
  });
  const createFilter = useMutation({
    mutationFn: () => createSavedFilter(name.trim(), query),
    onSuccess: async () => {
      setName("");
      message.success(t("筛选方案已保存"));
      await queryClient.invalidateQueries({ queryKey: ["saved-filters"] });
    }
  });
  const removeFilter = useMutation({
    mutationFn: deleteSavedFilter,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["saved-filters"] });
    }
  });

  return (
    <Drawer className="saved-filter-drawer" onClose={onClose} open={open} size={480} title={<div className="operations-drawer-title"><span className="operations-title-icon"><Bookmark size={18} /></span><span><strong>{t("保存的筛选")}</strong><small>{t("把常用馆藏条件保存为一键入口")}</small></span></div>}>
      <div className="saved-filter-create">
        <div className="saved-filter-current"><span>{t("当前条件")}</span><strong>{describeQuery(query)}</strong></div>
        <Space.Compact block>
          <Input
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            onPressEnter={() => name.trim() && createFilter.mutate()}
            placeholder={t("例如：无码中文 · 最近添加")}
            value={name}
          />
          <Button
            disabled={!name.trim()}
            icon={<BookmarkPlus size={16} />}
            loading={createFilter.isPending}
            onClick={() => createFilter.mutate()}
            type="primary"
          >
            {t("保存")} </Button>
        </Space.Compact>
      </div>

      <div className="drawer-list">
        {saved.isLoading ? (
          <div className="drawer-list-loading"><Spin /></div>
        ) : (saved.data?.items.length ?? 0) === 0 ? (
          <Empty description={<span>{t("还没有保存筛选方案")}<br /><small>{t("为当前条件命名，之后即可一键恢复")}</small></span>} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : saved.data?.items.map((item) => (
          <div className="drawer-list-row" key={item.id}>
            <div className="drawer-list-copy">
              <Text strong>{item.name}</Text>
              <Text type="secondary">{describeQuery(item.query)}</Text>
            </div>
            <Space className="drawer-list-actions" size={6}>
              <Button
                aria-label={t("应用 {{p0}}", { p0: item.name })}
                icon={<Play size={15} />}
                onClick={() => {
                  onApply(item.query);
                  onClose();
                }}
                size="small"
                type="primary"
              >
                {t("应用")} </Button>
              <Popconfirm
                okText={t("删除")}
                onConfirm={() => removeFilter.mutate(item.id)}
                title={t("删除这个筛选方案？")}
              >
                <Button aria-label={t("删除筛选方案")} danger icon={<Trash2 size={15} />} size="small" />
              </Popconfirm>
            </Space>
          </div>
        ))}
      </div>
    </Drawer>
  );
}
