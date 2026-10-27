import { LanguageSwitcher } from "./LanguageSwitcher";
import { t, useLocale } from "../i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input, Spin, Typography } from "antd";
import { KeyRound, LockKeyhole, ShieldCheck } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { fetchUsers } from "../lib/api";
import { jsonRequest, requestJson } from "../lib/http";

type AccessStatus = {
  mode: "local-only" | "lan-open" | "lan-protected";
  requiresAuthentication: boolean;
  authenticated: boolean;
};

function fetchAccessStatus(): Promise<AccessStatus> {
  return requestJson("/api/access/status", { cache: "no-store" });
}

export function AccessGate({ children }: { children: ReactNode }) {
  useLocale();
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const status = useQuery({ queryKey: ["access-status"], queryFn: fetchAccessStatus, retry: 1, staleTime: 30_000 });
  const pair = useMutation({
    mutationFn: (pairingCode: string) => requestJson<AccessStatus>("/api/access/pair", jsonRequest("POST", { code: pairingCode })),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["access-status"] });
      await queryClient.prefetchQuery({ queryKey: ["users"], queryFn: fetchUsers, staleTime: 30_000 });
    }
  });

  useEffect(() => {
    if (!status.data?.authenticated) return;
    void queryClient.prefetchQuery({ queryKey: ["users"], queryFn: fetchUsers, staleTime: 30_000 });
  }, [queryClient, status.data?.authenticated]);

  if (status.isLoading) return <div className="access-gate-loading"><Spin /><span>{t("正在确认本机访问状态")}</span></div>;
  if (status.isError) return (
    <main className="access-gate">
      <LanguageSwitcher />
      <section><span className="access-gate-icon"><LockKeyhole size={24} /></span><Typography.Title level={2}>{t("暂时无法连接馆藏服务")}</Typography.Title><Typography.Text>{status.error instanceof Error ? status.error.message : t("请确认后端服务已启动")}</Typography.Text><Button onClick={() => void status.refetch()}>{t("重新连接")}</Button></section>
    </main>
  );
  if (status.data?.authenticated) return children;

  return (
    <main className="access-gate">
      <LanguageSwitcher />
      <section>
        <span className="access-gate-icon"><ShieldCheck size={26} /></span>
        <span className="access-gate-kicker">LOCAL LIBRARY ACCESS</span>
        <Typography.Title level={2}>{t("连接受保护的 Alexandria 18+")}</Typography.Title>
        <Typography.Text>{t("这台设备正在通过局域网访问私人馆藏。请输入服务启动终端显示的六位配对码。")}</Typography.Text>
        <form onSubmit={(event) => { event.preventDefault(); if (code.length === 6) pair.mutate(code); }}>
          <Input aria-label={t("六位局域网配对码")} autoComplete="one-time-code" inputMode="numeric" maxLength={6} onChange={(event) => setCode(event.target.value.replace(/\D/gu, ""))} placeholder="000000" prefix={<KeyRound size={16} />} size="large" value={code} />
          <Button block disabled={code.length !== 6} htmlType="submit" loading={pair.isPending} size="large" type="primary">{t("验证并进入馆藏")}</Button>
        </form>
        {pair.isError && <Typography.Text className="access-gate-error" role="alert" type="danger">{pair.error instanceof Error ? pair.error.message : t("配对失败")}</Typography.Text>}
        <small>{t("配对信息只保存在当前浏览器；服务重启或退出登录后可重新配对。")}</small>
      </section>
    </main>
  );
}
