import {
  Building2, ChevronRight, Clapperboard, Hash, Layers3, Library, Tags, Ticket, UserRound
} from "lucide-react";
import type { AgentPresentation } from "../../features/agent/api";
import { getPosterUrl, getThumbnailUrl, type TopicType } from "../../lib/api";

type EntityCardsPresentation = Extract<AgentPresentation, { kind: "entity-cards" }>;
type EntityCard = EntityCardsPresentation["items"][number];

const TYPE_LABELS: Record<EntityCard["type"], string> = {
  actor: "演员", genre: "标签", series: "主题", maker: "厂商", label: "厂牌", director: "导演", prefix: "番号系列"
};

function EntityIcon({ type }: { type: EntityCard["type"] }) {
  if (type === "actor") return <UserRound size={13} />;
  if (type === "genre") return <Tags size={13} />;
  if (type === "series") return <Layers3 size={13} />;
  if (type === "maker") return <Building2 size={13} />;
  if (type === "label") return <Ticket size={13} />;
  if (type === "director") return <Clapperboard size={13} />;
  return <Hash size={13} />;
}

export function AgentEntityCards({
  presentation,
  onOpenEntity
}: {
  presentation: EntityCardsPresentation;
  onOpenEntity: (entity: { type: TopicType; value: string; label?: string }) => void;
}) {
  if (!presentation.items.length) return null;
  return (
    <section aria-label={`${presentation.title}，共 ${presentation.items.length} 项`} className="agent-entity-cards">
      <header>
        <span><Layers3 size={13} /></span>
        <div><strong>{presentation.title}</strong><small>{presentation.subtitle} · 点击卡片打开子分类</small></div>
      </header>
      <div className="agent-entity-card-grid">
        {presentation.items.map((item) => {
          const artwork = item.imageUrl ?? (item.coverMediaId ? getPosterUrl(item.coverMediaId) : "");
          const hasProfileImage = Boolean(item.imageUrl);
          return (
            <button
              className={`agent-entity-card is-${item.type}${hasProfileImage ? " has-profile-image" : ""}`}
              key={`${item.type}:${item.value}`}
              onClick={() => onOpenEntity({ type: item.type, value: item.value, label: item.label })}
              type="button"
            >
              <span className="agent-entity-card-artwork">
                {artwork ? <>
                  {hasProfileImage && <img
                    alt=""
                    aria-hidden="true"
                    className="agent-entity-card-backdrop"
                    loading="lazy"
                    onError={(event) => { event.currentTarget.hidden = true; }}
                    referrerPolicy="no-referrer"
                    src={artwork}
                  />}
                  <img
                    alt=""
                    className="agent-entity-card-image"
                    loading="lazy"
                    onError={(event) => {
                      if (!item.coverMediaId) return;
                      const fallback = getThumbnailUrl(item.coverMediaId);
                      if (event.currentTarget.src.endsWith(fallback)) return;
                      event.currentTarget.src = fallback;
                    }}
                    referrerPolicy="no-referrer"
                    src={artwork}
                  />
                </> : <span className="agent-entity-card-placeholder"><EntityIcon type={item.type} /></span>}
                <span className="agent-entity-card-type"><EntityIcon type={item.type} />{TYPE_LABELS[item.type]}</span>
              </span>
              <span className="agent-entity-card-copy">
                <strong>{item.label}</strong>
                {item.originalName && item.originalName !== item.label && <small>{item.originalName}</small>}
                <span className="agent-entity-card-count"><Library size={11} />{item.mediaCount} 部馆藏</span>
                <span className="agent-entity-card-reason">{item.reason}</span>
                {item.highlights.length > 0 && <span className="agent-entity-card-highlights">
                  {item.highlights.map((highlight) => <span key={highlight}>{highlight}</span>)}
                </span>}
              </span>
              <ChevronRight className="agent-entity-card-open" size={14} />
            </button>
          );
        })}
      </div>
    </section>
  );
}
