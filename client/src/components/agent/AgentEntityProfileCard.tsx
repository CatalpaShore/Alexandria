import { ChevronRight, Database, ShieldCheck } from "lucide-react";
import type { AgentPresentation } from "../../features/agent/api";
import type { TopicType } from "../../lib/api";

type ProfilePresentation = Extract<AgentPresentation, { kind: "entity-profile-card" }>;

const TYPE_LABELS: Record<ProfilePresentation["type"], string> = {
  actor: "演员", maker: "厂商", label: "厂牌", series: "系列", director: "导演"
};

const STATUS_LABELS: Record<ProfilePresentation["status"], string> = {
  verified: "来源一致",
  "auto-matched": "自动匹配",
  "auto-resolved": "AI 已择优",
  unverified: "待补充"
};

export function AgentEntityProfileCard({
  presentation,
  onOpenEntity
}: {
  presentation: ProfilePresentation;
  onOpenEntity: (entity: { type: TopicType; value: string; label?: string }) => void;
}) {
  return <button
    aria-label={`查看${presentation.label}详情`}
    className="agent-entity-profile-card"
    onClick={() => onOpenEntity({ type: presentation.type, value: presentation.value, label: presentation.label })}
    type="button"
  >
    {presentation.imageUrl && <img alt="" loading="lazy" referrerPolicy="no-referrer" src={presentation.imageUrl} />}
    <span className="agent-entity-profile-main">
      <span className="agent-entity-profile-kicker">{TYPE_LABELS[presentation.type]}公开资料</span>
      <strong>{presentation.label}</strong>
      {presentation.originalName && presentation.originalName !== presentation.label &&
        <small className="agent-entity-profile-original-name">日文原名：{presentation.originalName}</small>}
      {presentation.facts.length > 0 && <span className="agent-entity-profile-facts">
        {presentation.facts.map((fact) => <span key={`${fact.label}:${fact.value}`}><small>{fact.label}</small>{fact.value}</span>)}
      </span>}
      {presentation.aliases.length > 0 && <small className="agent-entity-profile-aliases">别名：{presentation.aliases.join("、")}</small>}
      {presentation.description && <span className="agent-entity-profile-description">{presentation.description}</span>}
      <span className="agent-entity-profile-meta">
        <span><ShieldCheck size={12} />{STATUS_LABELS[presentation.status]} · {Math.round(presentation.confidence * 100)}%</span>
        <span><Database size={12} />{presentation.sourceCount} 个来源</span>
      </span>
    </span>
    <ChevronRight className="agent-entity-profile-arrow" size={17} />
  </button>;
}
