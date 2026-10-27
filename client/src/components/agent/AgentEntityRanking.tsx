import { BarChart3, ChevronRight, Trophy } from "lucide-react";
import type { AgentPresentation } from "../../features/agent/api";
import type { TopicType } from "../../lib/api";

type RankingPresentation = Extract<AgentPresentation, { kind: "entity-ranking" }>;

export function AgentEntityRanking({
  onOpenEntity,
  presentation
}: {
  onOpenEntity: (entity: { type: TopicType; value: string; label?: string }) => void;
  presentation: RankingPresentation;
}) {
  return (
    <section aria-label={presentation.title} className="agent-entity-ranking">
      <header>
        <span><BarChart3 size={13} /></span>
        <div><strong>{presentation.title}</strong><small>{presentation.scopeLabel ?? "全库聚合"} · 点击专题查看详情</small></div>
      </header>
      <div className="agent-entity-ranking-grid">
        {presentation.rows.map((row) => (
          <button
            key={`${row.type}:${row.value}`}
            onClick={() => onOpenEntity({ type: row.type, value: row.value, label: row.label })}
            type="button"
          >
            <span className={`agent-entity-rank is-${row.rank}`}>
              {row.rank <= 3 ? <Trophy size={11} /> : row.rank}
            </span>
            <strong>{row.label}</strong>
            <span>{row.detail ? `${row.detail} · 馆藏 ${row.count} 部` : `${row.count} ${presentation.metricLabel}`}</span>
            <ChevronRight size={13} />
          </button>
        ))}
      </div>
    </section>
  );
}
