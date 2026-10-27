import { getIntlLocale } from "../i18n/core";
import { t, useLocale } from "../i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Drawer,
  Empty,
  Input,
  Popconfirm,
  Space,
  Spin,
  Tooltip,
  Typography,
  message
} from "antd";
import { ChevronRight, ListVideo, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  createPlaylist,
  deletePlaylist,
  fetchPlaylists
} from "../lib/playlistApi";
import { PlaylistDetailDrawer } from "./PlaylistDetailDrawer";
import "../playlist-drawer.css";

type PlaylistDrawerProps = {
  open: boolean;
  onOpenMediaById: (id: string) => void;
  onClose: () => void;
  initialPlaylistId?: string | null;
};

const { Text, Title } = Typography;

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat(getIntlLocale(), { month: "numeric", day: "numeric" }).format(date);
}

export function PlaylistDrawer({
  open,
  onOpenMediaById,
  onClose,
  initialPlaylistId = null
}: PlaylistDrawerProps) {
  useLocale();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [detailPlaylistId, setDetailPlaylistId] = useState<string | null>(null);

  const playlists = useQuery({
    queryKey: ["playlists"],
    queryFn: fetchPlaylists,
    enabled: open
  });
  const createMutation = useMutation({
    mutationFn: createPlaylist,
    onSuccess: async () => {
      setName("");
      setDescription("");
      setCreating(false);
      message.success(t("片单已创建"));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["playlists"] }),
        queryClient.invalidateQueries({ queryKey: ["media-playlists"] })
      ]);
    },
    onError: (error: Error) => message.error(error.message)
  });
  const deleteMutation = useMutation({
    mutationFn: deletePlaylist,
    onSuccess: async (_result, id) => {
      if (detailPlaylistId === id) setDetailPlaylistId(null);
      message.success(t("片单已删除"));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["playlists"] }),
        queryClient.invalidateQueries({ queryKey: ["media-playlists"] })
      ]);
    },
    onError: (error: Error) => message.error(error.message)
  });
  useEffect(() => {
    if (!open) {
      setCreating(false);
      setDetailPlaylistId(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setDetailPlaylistId(null);
  }, [initialPlaylistId, open]);

  useEffect(() => {
    if (!open || !initialPlaylistId || !playlists.data) return;
    const playlist = playlists.data.items.find((item) => item.id === initialPlaylistId);
    if (!playlist) return;
    setDetailPlaylistId(playlist.id);
  }, [initialPlaylistId, open, playlists.data]);

  function submitPlaylist() {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    createMutation.mutate({
      name: trimmedName,
      description: description.trim(),
      kind: "manual",
      query: {}
    });
  }

  return (
    <>
    <Drawer
      className="playlist-drawer"
      extra={(
        <Button
          icon={creating ? undefined : <Plus size={15} />}
          onClick={() => setCreating((value) => !value)}
          size="small"
          type={creating ? "default" : "primary"}
        >
          {creating ? t("取消") : t("新建")}
        </Button>
      )}
      onClose={onClose}
      open={open}
      size={640}
      title={(
        <span className="playlist-drawer-title">
          <ListVideo size={18} />
          {t("我的片单")} </span>
      )}
    >
      {creating && (
        <section className="playlist-create-panel motion-expand-region">
          <Input
            autoFocus
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            onPressEnter={submitPlaylist}
            placeholder={t("片单名称")}
            value={name}
          />
          <Input.TextArea
            autoSize={{ minRows: 1, maxRows: 3 }}
            maxLength={500}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t("备注（可选）")}
            value={description}
          />
          <Button
            block
            disabled={!name.trim()}
            loading={createMutation.isPending}
            onClick={submitPlaylist}
            type="primary"
          >
            {t("创建片单")} </Button>
        </section>
      )}

      <div className="playlist-list-heading">
        <Text type="secondary">{(playlists.data?.items.length ?? 0).toLocaleString(getIntlLocale())} {t("个片单")}</Text>
      </div>

      {playlists.isLoading ? (
        <div className="playlist-loading"><Spin /></div>
      ) : playlists.isError ? (
        <Empty
          description={(
            <Space direction="vertical" size={8}>
              <Text type="secondary">{t("片单加载失败")}</Text>
              <Button onClick={() => playlists.refetch()} size="small">{t("重试")}</Button>
            </Space>
          )}
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      ) : (playlists.data?.items.length ?? 0) === 0 ? (
        <Empty description={t("还没有片单")} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <div className="playlist-list">
          {playlists.data?.items.map((playlist) => {
            return (
              <article className="playlist-row motion-list-item motion-status-card" key={playlist.id}>
                <div className="playlist-row-main">
                  <div className={`playlist-kind-icon is-${playlist.kind}`}>
                    <ListVideo size={17} />
                  </div>
                  <div className="playlist-row-copy">
                    <div className="playlist-name-line">
                      <Title ellipsis={{ tooltip: playlist.name }} level={5}>{playlist.name}</Title>
                    </div>
                    {playlist.description && (
                      <Text ellipsis={{ tooltip: playlist.description }} type="secondary">{playlist.description}</Text>
                    )}
                    <div className="playlist-row-meta">
                      <span>
                        {playlist.itemCount.toLocaleString(getIntlLocale())} {t("个视频")} </span>
                      <span>{formatUpdatedAt(playlist.updatedAt)}</span>
                    </div>
                  </div>
                  <Space className="playlist-row-actions" size={4}>
                    <Tooltip title={t("查看完整片单")}>
                      <Button
                        aria-label={t("查看完整片单 {{p0}}", { p0: playlist.name })}
                        icon={<ChevronRight size={16} />}
                        onClick={() => setDetailPlaylistId(playlist.id)}
                        size="small"
                        type="primary"
                      />
                    </Tooltip>
                    <Popconfirm
                      description={t("片单中的项目关联也会一并移除。")}
                      okButtonProps={{ danger: true }}
                      okText={t("删除")}
                      onConfirm={() => deleteMutation.mutate(playlist.id)}
                      title={t("删除“{{p0}}”？", { p0: playlist.name })}
                    >
                      <Tooltip title={t("删除片单")}>
                        <Button
                          aria-label={t("删除片单 {{p0}}", { p0: playlist.name })}
                          danger
                          icon={<Trash2 size={15} />}
                          loading={deleteMutation.isPending && deleteMutation.variables === playlist.id}
                          size="small"
                          type="text"
                        />
                      </Tooltip>
                    </Popconfirm>
                  </Space>
                </div>

              </article>
            );
          })}
        </div>
      )}
    </Drawer>
    <PlaylistDetailDrawer
      onClose={() => setDetailPlaylistId(null)}
      onOpenMediaById={onOpenMediaById}
      open={open && Boolean(detailPlaylistId)}
      playlistId={detailPlaylistId}
    />
    </>
  );
}
