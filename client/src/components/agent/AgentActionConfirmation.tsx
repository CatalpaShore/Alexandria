import { t, useLocale } from "../../i18n";
import { Button, Tag } from "antd";
import { Check, ShieldCheck, X } from "lucide-react";
import type { AgentPresentation } from "../../features/agent/api";

type Presentation = Extract<AgentPresentation, { kind: "action-confirmation" }>;

export function AgentActionConfirmation({ presentation, onConfirm, onCancel, pending }: { presentation: Presentation; onConfirm: (id: string) => void; onCancel: (id: string) => void; pending?: boolean }) {
  useLocale();
  const waiting = presentation.status === "awaiting_confirmation" || presentation.status === "failed";
  return <section className="agent-structured-card agent-action-confirmation">
    <header><ShieldCheck size={15} /><span><strong>{presentation.title}</strong><small>仅在确认后修改馆藏</small></span><Tag>{presentation.status === "completed" ? t("已完成") : presentation.status === "cancelled" ? t("已取消") : t("待确认")}</Tag></header>
    <p>{presentation.description}</p>
    <div className="agent-action-media">{presentation.media.map((item) => <code key={item.mediaId}>{item.code}</code>)}</div>
    {waiting && <footer><Button icon={<X size={13} />} onClick={() => onCancel(presentation.actionId)}>{t("取消")}</Button><Button loading={pending} icon={<Check size={13} />} onClick={() => onConfirm(presentation.actionId)} type="primary">{presentation.confirmLabel}</Button></footer>}
  </section>;
}
