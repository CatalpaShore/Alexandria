import { getIntlLocale } from "../i18n/core";
import { t, useLocale, useLocalizedMemo } from "../i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Checkbox, Empty, Popover, Spin, Tag, Typography, message } from "antd";
import { ListPlus } from "lucide-react";
import { useEffect, useState } from "react";
import type { MediaItem } from "../lib/api";
import {
  fetchMediaPlaylistAssignments,
  updateMediaPlaylistAssignments
} from "../lib/playlistApi";
import "../playlist-picker.css";

type AddToPlaylistPopoverProps = {
  item: MediaItem;
};

const { Text } = Typography;

export function AddToPlaylistPopover({ item }: AddToPlaylistPopoverProps) {
  useLocale();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selectionReady, setSelectionReady] = useState(false);
  const [selectedPlaylistIds, setSelectedPlaylistIds] = useState<string[]>([]);
  const [initialPlaylistIds, setInitialPlaylistIds] = useState<string[]>([]);
  const assignments = useQuery({
    queryKey: ["media-playlists", item.id],
    queryFn: () => fetchMediaPlaylistAssignments(item.id),
    enabled: open,
    refetchOnMount: "always",
    staleTime: 0
  });
  const saveMutation = useMutation({
    mutationFn: () => updateMediaPlaylistAssignments(item.id, selectedPlaylistIds),
    onSuccess: async (result) => {
      message.success(selectedPlaylistIds.length > 0 ? t("片单已更新") : t("已从所有片单移除"));
      setInitialPlaylistIds(selectedPlaylistIds);
      queryClient.setQueryData(["media-playlists", item.id], result);
      setOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["playlists"] }),
        queryClient.invalidateQueries({ queryKey: ["media-playlists", item.id] }),
        queryClient.invalidateQueries({ queryKey: ["playlist-items"] })
      ]);
    },
    onError: (error: Error) => message.error(error.message)
  });

  useEffect(() => {
    if (!open) {
      setSelectionReady(false);
      return;
    }
    if (!assignments.data || selectionReady) return;
    const selected = assignments.data.items.filter((playlist) => playlist.containsMedia).map((playlist) => playlist.id);
    setSelectedPlaylistIds(selected);
    setInitialPlaylistIds(selected);
    setSelectionReady(true);
  }, [assignments.data, open, selectionReady]);

  useEffect(() => {
    setOpen(false);
    setSelectionReady(false);
  }, [item.id]);

  const hasChanges = useLocalizedMemo(() => {
    const current = [...selectedPlaylistIds].sort();
    const initial = [...initialPlaylistIds].sort();
    return current.length !== initial.length || current.some((id, index) => id !== initial[index]);
  }, [initialPlaylistIds, selectedPlaylistIds]);

  const content = (
    <div className="playlist-picker" aria-label={t("将 {{p0}} 加入片单", { p0: item.normalizedCode || item.basename })}>
      <header>
        <div>
          <strong>{t("加入片单")}</strong>
          <Text ellipsis title={item.normalizedCode || item.basename}>{item.normalizedCode || item.basename}</Text>
        </div>
        <Tag>{selectedPlaylistIds.length} {t("个")}</Tag>
      </header>
      {assignments.isLoading ? (
        <div className="playlist-picker-state"><Spin size="small" /></div>
      ) : assignments.isError ? (
        <div className="playlist-picker-state">
          <Text type="secondary">{t("片单加载失败")}</Text>
          <Button onClick={() => assignments.refetch()} size="small">{t("重试")}</Button>
        </div>
      ) : (assignments.data?.items.length ?? 0) === 0 ? (
        <Empty description={t("暂无手工片单，请在“我的片单”中创建")} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <div className="playlist-picker-list">
          {assignments.data?.items.map((playlist) => (
            <Checkbox
              checked={selectedPlaylistIds.includes(playlist.id)}
              key={playlist.id}
              onChange={(event) => setSelectedPlaylistIds((current) => event.target.checked
                ? [...new Set([...current, playlist.id])]
                : current.filter((id) => id !== playlist.id))}
            >
              <span className="playlist-picker-option">
                <span>
                  <strong>{playlist.name}</strong>
                  <small>{playlist.itemCount.toLocaleString(getIntlLocale())} {t("个视频")}</small>
                </span>
                {playlist.containsMedia && <Tag color="success">{t("已加入")}</Tag>}
              </span>
            </Checkbox>
          ))}
        </div>
      )}
      <footer>
        <Button onClick={() => setOpen(false)} size="small">{t("取消")}</Button>
        <Button
          disabled={!selectionReady || !hasChanges}
          loading={saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
          size="small"
          type="primary"
        >
          {t("保存")} </Button>
      </footer>
    </div>
  );

  return (
    <Popover
      classNames={{ root: "playlist-picker-popover" }}
      content={content}
      destroyOnHidden
      onOpenChange={setOpen}
      open={open}
      placement="bottomLeft"
      trigger="click"
      zIndex={1400}
    >
      <Button icon={<ListPlus size={16} />}>{t("加入片单")}</Button>
    </Popover>
  );
}
