import { t, useLocale } from "../i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Drawer, Empty, Popconfirm, Spin, Tooltip, Typography, message } from "antd";
import { ChevronDown, ChevronUp, Film, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { getPosterUrl } from "../lib/api";
import { PosterImage } from "./PosterImage";
import {
  fetchPlaylistItems,
  reorderPlaylistItems,
  updatePlaylistItem,
  type PlaylistItem
} from "../lib/playlistApi";

type PlaylistDetailDrawerProps = {
  open: boolean;
  playlistId: string | null;
  onClose: () => void;
  onOpenMediaById: (id: string) => void;
};

const { Text } = Typography;

function formatDuration(seconds: number | null): string {
  if (!seconds || seconds < 1) return "--:--";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
    : `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

export function PlaylistDetailDrawer({
  open,
  playlistId,
  onClose,
  onOpenMediaById
}: PlaylistDetailDrawerProps) {
  useLocale();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const detail = useQuery({
    queryKey: ["playlist-items", playlistId],
    queryFn: () => fetchPlaylistItems(playlistId as string),
    enabled: open && Boolean(playlistId)
  });
  const items = detail.data?.items ?? [];

  const removeMutation = useMutation({
    mutationFn: (mediaId: string) => updatePlaylistItem(playlistId as string, mediaId, false),
    onSuccess: async () => {
      message.success(t("已从片单移除"));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["playlists"] }),
        queryClient.invalidateQueries({ queryKey: ["playlist-items", playlistId] })
      ]);
    },
    onError: (error: Error) => message.error(error.message)
  });
  const orderMutation = useMutation({
    mutationFn: (mediaIds: string[]) => reorderPlaylistItems(playlistId as string, mediaIds),
    onError: async (error: Error) => {
      message.error(error.message);
      await queryClient.invalidateQueries({ queryKey: ["playlist-items", playlistId] });
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["playlists"] }),
        queryClient.invalidateQueries({ queryKey: ["playlist-items", playlistId] })
      ]);
    }
  });

  useEffect(() => {
    if (!open) setEditing(false);
  }, [open]);

  function moveItem(index: number, delta: -1 | 1) {
    if (!playlistId) return;
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= items.length) return;
    const nextItems = [...items];
    [nextItems[index], nextItems[targetIndex]] = [nextItems[targetIndex], nextItems[index]];
    queryClient.setQueryData(["playlist-items", playlistId], {
      ...detail.data,
      items: nextItems.map((item, position) => ({ ...item, position }))
    });
    orderMutation.mutate(nextItems.map((item) => item.id));
  }

  return (
    <Drawer
      className="playlist-detail-drawer"
      extra={items.length > 0 ? (
        <Button
          icon={<Pencil size={15} />}
          onClick={() => setEditing((value) => !value)}
          size="small"
          type={editing ? "primary" : "default"}
        >
          {editing ? t("完成") : t("编辑")}
        </Button>
      ) : null}
      onClose={onClose}
      open={open}
      size={860}
      title={detail.data ? t("{{p0}} · {{p1}} 个视频", { p0: detail.data.playlist.name, p1: items.length }) : t("片单详情")}
    >
      {detail.isLoading ? (
        <div className="playlist-detail-loading"><Spin /></div>
      ) : detail.isError ? (
        <Empty description={t("片单加载失败")} image={Empty.PRESENTED_IMAGE_SIMPLE}>
          <Button onClick={() => detail.refetch()}>{t("重试")}</Button>
        </Empty>
      ) : items.length === 0 ? (
        <Empty description={t("片单中还没有视频")} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <div className={`playlist-detail-list${editing ? " is-editing" : ""}`} role="list">
          {items.map((item, index) => (
            <PlaylistDetailItem
              editing={editing}
              index={index}
              item={item}
              key={item.id}
              moving={orderMutation.isPending}
              onMove={moveItem}
              onOpen={() => onOpenMediaById(item.id)}
              onRemove={() => removeMutation.mutate(item.id)}
              removePending={removeMutation.isPending && removeMutation.variables === item.id}
              total={items.length}
            />
          ))}
        </div>
      )}
    </Drawer>
  );
}

function PlaylistDetailItem({
  editing,
  index,
  item,
  moving,
  onMove,
  onOpen,
  onRemove,
  removePending,
  total
}: {
  editing: boolean;
  index: number;
  item: PlaylistItem;
  moving: boolean;
  onMove: (index: number, delta: -1 | 1) => void;
  onOpen: () => void;
  onRemove: () => void;
  removePending: boolean;
  total: number;
}) {
  useLocale();
  const code = item.normalizedCode || item.basename;
  return (
    <article className="playlist-detail-item" role="listitem">
      <button aria-label={t("查看 {{p0}}", { p0: code })} className="playlist-detail-poster" onClick={onOpen} type="button">
        <PosterImage alt="" loading="lazy" src={getPosterUrl(item.id, "card")} />
        <Film size={17} />
      </button>
      <button className="playlist-detail-copy" onClick={onOpen} type="button">
        <strong>{code}</strong>
        <span>{item.title || item.basename}</span>
      </button>
      <Text className="playlist-detail-duration">{formatDuration(item.durationSeconds)}</Text>
      {editing && (
        <div className="playlist-detail-actions">
          <Tooltip title={t("上移")}>
            <Button aria-label={t("上移 {{p0}}", { p0: code })} disabled={index === 0 || moving} icon={<ChevronUp size={15} />} onClick={() => onMove(index, -1)} size="small" />
          </Tooltip>
          <Tooltip title={t("下移")}>
            <Button aria-label={t("下移 {{p0}}", { p0: code })} disabled={index === total - 1 || moving} icon={<ChevronDown size={15} />} onClick={() => onMove(index, 1)} size="small" />
          </Tooltip>
          <Popconfirm description={t("视频文件不会被删除。")} okButtonProps={{ danger: true }} okText={t("移除")} onConfirm={onRemove} title={t("从片单移除“{{p0}}”？", { p0: code })}>
            <Tooltip title={t("从片单移除")}>
              <Button aria-label={t("从片单移除 {{p0}}", { p0: code })} danger icon={<Trash2 size={15} />} loading={removePending} size="small" />
            </Tooltip>
          </Popconfirm>
        </div>
      )}
    </article>
  );
}
