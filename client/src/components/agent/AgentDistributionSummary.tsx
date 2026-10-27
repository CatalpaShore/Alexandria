import { t, useLocale } from "../../i18n";
import { BarChart3 } from "lucide-react";
import type { AgentPresentation } from "../../features/agent/api";
import type { TopicType } from "../../lib/api";

type Presentation = Extract<AgentPresentation, { kind: "distribution-summary" }>;
const entityTypes = new Set(["actor", "genre", "series", "maker", "label", "director"]);

export function AgentDistributionSummary({ presentation, onOpenEntity }: { presentation: Presentation; onOpenEntity: (entity: { type: TopicType; value: string; label?: string }) => void }) {
  useLocale();
  const max = Math.max(1, ...presentation.rows.map((row) => row.count));
  return <section className="agent-structured-card agent-distribution">
    <header><BarChart3 size={14} /><span><strong>{presentation.title}</strong><small>统计基数 {presentation.total} {t("部")}</small></span></header>
    <div className="agent-distribution-list">{presentation.rows.map((row) => {
      const content = <><span className="agent-distribution-rank">{row.rank}</span><span className="agent-distribution-label">{row.label}</span><span className="agent-distribution-bar"><i style={{ width: `${Math.max(4, row.count / max * 100)}%` }} /></span><strong>{row.count} {presentation.metricLabel}</strong></>;
      return entityTypes.has(row.type)
        ? <button key={`${row.type}:${row.value}`} type="button" onClick={() => onOpenEntity({ type: row.type as TopicType, value: row.value, label: row.label })}>{content}</button>
        : <div key={`${row.type}:${row.value}`}>{content}</div>;
    })}</div>
  </section>;
}
