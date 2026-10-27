import { t, useLocale } from "../i18n";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Drawer, Empty, Input, Popconfirm, Skeleton, Tag, message } from "antd";
import {
  Check,
  Clock3,
  Ghost,
  Heart,
  History,
  ListVideo,
  Pencil,
  Plus,
  Trash2,
  UserRound
} from "lucide-react";
import {
  activateUser,
  createUser,
  deleteUser,
  fetchUsers,
  renameUser,
  startGuestSession,
  type UserProfile
} from "../lib/api";
import "../operations-drawer.css";
import "../user-manager.css";

type UserManagerDrawerProps = {
  open: boolean;
  onClose: () => void;
};

function UserStats({ user }: { user: UserProfile }) {
  useLocale();
  const stats = [
    { icon: <Heart size={14} />, label: t("收藏"), value: user.stats.favoriteCount + user.stats.entityFavoriteCount },
    { icon: <ListVideo size={14} />, label: t("清单"), value: user.stats.playlistCount },
    { icon: <History size={14} />, label: t("观看"), value: user.stats.watchCount },
    { icon: <Clock3 size={14} />, label: t("进行中"), value: user.stats.inProgressCount }
  ];
  return (
    <div className="user-stats">
      {stats.map((stat) => (
        <span key={stat.label}>{stat.icon}<strong>{stat.value}</strong>{stat.label}</span>
      ))}
    </div>
  );
}

export function UserManagerDrawer({ open, onClose }: UserManagerDrawerProps) {
  useLocale();
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const users = useQuery({
    queryKey: ["users"],
    queryFn: fetchUsers,
    enabled: open,
    staleTime: 0
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["users"] });
  const finishSwitch = () => {
    message.success(t("已切换用户"));
    document.documentElement.classList.add("is-switching-user");
    window.setTimeout(() => window.location.reload(), 180);
  };
  const createMutation = useMutation({
    mutationFn: createUser,
    onSuccess: () => {
      setNewName("");
      void refresh();
      message.success(t("用户已创建"));
    },
    onError: (error) => message.error(error.message)
  });
  const activateMutation = useMutation({
    mutationFn: activateUser,
    onSuccess: finishSwitch,
    onError: (error) => message.error(error.message)
  });
  const guestMutation = useMutation({
    mutationFn: startGuestSession,
    onSuccess: finishSwitch,
    onError: (error) => message.error(error.message)
  });
  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => renameUser(id, name),
    onSuccess: () => {
      setEditingId(null);
      void refresh();
      message.success(t("用户名称已更新"));
    },
    onError: (error) => message.error(error.message)
  });
  const deleteMutation = useMutation({
    mutationFn: deleteUser,
    onSuccess: () => {
      void refresh();
      message.success(t("用户及其个人数据已删除"));
    },
    onError: (error) => message.error(error.message)
  });

  const activeUser = users.data?.activeUser;
  const persistentUsers = users.data?.users.filter((user) => user.kind === "persistent") ?? [];

  return (
    <Drawer className="user-manager-drawer" open={open} onClose={onClose} title={<div className="operations-drawer-title"><span className="operations-title-icon"><UserRound size={18} /></span><span><strong>{t("用户管理")}</strong><small>{t("隔离收藏、清单与观看记录")}</small></span></div>} size={520}>
      {users.isLoading ? <Skeleton active paragraph={{ rows: 8 }} /> : !activeUser ? (
        <Empty description={t("用户信息暂不可用")} />
      ) : (
        <div className="user-manager-content">
          <section className={`active-user-card motion-status-card motion-tab-panel${activeUser.kind === "guest" ? " is-guest" : ""}`}>
            <div className="user-avatar">{activeUser.kind === "guest" ? <Ghost /> : <UserRound />}</div>
            <div className="active-user-copy">
              <div className="user-name-row">
                <strong>{activeUser.name}</strong>
                <Tag color={activeUser.kind === "guest" ? "orange" : "gold"}>
                  {activeUser.kind === "guest" ? t("临时会话") : t("当前用户")}
                </Tag>
              </div>
              <span>{activeUser.kind === "guest" ? t("离开访客后，本次个人记录会自动清除") : t("收藏、清单与观看记录均保存在此用户下")}</span>
            </div>
            <UserStats user={activeUser} />
          </section>

          {activeUser.kind === "guest" && (
            <Alert showIcon type="warning" message={t("访客数据不会保留")} description={t("切换到任意正式用户或重启服务后，当前访客的收藏、清单和观看记录都会被丢弃。")} />
          )}

          <section className="user-manager-section">
            <div className="user-section-heading">
              <div><strong>{t("本机用户")}</strong><span>{persistentUsers.length} {t("个长期保留的个人空间")}</span></div><Tag bordered={false}>{t("独立数据")}</Tag>
            </div>
            <div className="user-list">
              {persistentUsers.map((user) => (
                <article className={`user-list-item motion-list-item motion-status-card${user.isActive ? " is-active" : ""}`} key={user.id}>
                  <div className="user-list-main">
                    <div className="user-avatar is-small"><UserRound size={18} /></div>
                    <div className="user-list-copy">
                      {editingId === user.id ? (
                        <Input
                          className="motion-tab-panel"
                          autoFocus
                          maxLength={32}
                          value={editingName}
                          onChange={(event) => setEditingName(event.target.value)}
                          onPressEnter={() => editingName.trim() && renameMutation.mutate({ id: user.id, name: editingName.trim() })}
                        />
                      ) : (
                        <div className="user-name-row"><strong>{user.name}</strong>{user.isDefault && <Tag>{t("初始数据")}</Tag>}{user.isActive && <Check size={15} />}</div>
                      )}
                      <UserStats user={user} />
                    </div>
                  </div>
                  <div className="user-list-actions">
                    {editingId === user.id ? (
                      <Button type="primary" disabled={!editingName.trim()} loading={renameMutation.isPending} onClick={() => renameMutation.mutate({ id: user.id, name: editingName.trim() })}>{t("保存")}</Button>
                    ) : (
                      <Button aria-label={t("重命名{{p0}}", { p0: user.name })} icon={<Pencil size={15} />} onClick={() => { setEditingId(user.id); setEditingName(user.name); }} />
                    )}
                    {!user.isActive && <Button loading={activateMutation.isPending} onClick={() => activateMutation.mutate(user.id)}>{t("切换")}</Button>}
                    {!user.isDefault && !user.isActive && (
                      <Popconfirm title={t("删除这个用户？")} description={t("其收藏、清单与观看记录也会一并删除。")} okText={t("删除")} cancelText={t("取消")} onConfirm={() => deleteMutation.mutate(user.id)}>
                        <Button aria-label={t("删除{{p0}}", { p0: user.name })} danger icon={<Trash2 size={15} />} />
                      </Popconfirm>
                    )}
                  </div>
                </article>
              ))}
            </div>
            <div className="create-user-row">
              <Input maxLength={32} placeholder={t("新用户名称")} value={newName} onChange={(event) => setNewName(event.target.value)} onPressEnter={() => newName.trim() && createMutation.mutate(newName.trim())} />
              <Button type="primary" icon={<Plus size={16} />} disabled={!newName.trim()} loading={createMutation.isPending} onClick={() => createMutation.mutate(newName.trim())}>{t("新建用户")}</Button>
            </div>
          </section>

          <section className="guest-entry-card motion-status-card">
            <div><Ghost size={20} /><span><strong>{t("临时访客")}</strong><small>{t("使用完整功能，离开时不留下个人记录")}</small></span></div>
            <Button disabled={activeUser.kind === "guest"} loading={guestMutation.isPending} onClick={() => guestMutation.mutate()}>{activeUser.kind === "guest" ? t("正在使用") : t("进入访客")}</Button>
          </section>
        </div>
      )}
    </Drawer>
  );
}
