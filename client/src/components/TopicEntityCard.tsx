import { getIntlLocale } from "../i18n/core";
import { t, useLocale } from "../i18n";
import { Button } from "antd";
import { Heart, Layers3 } from "lucide-react";
import { getPosterUrl, type TopicListItem, type TopicType } from "../lib/api";
import { PosterImage } from "./PosterImage";

type TopicEntityCardProps = {
  item: TopicListItem;
  statsUnavailable?: boolean;
  type: TopicType;
  onOpenEntity: (entity: { type: TopicType; value: string; label?: string }) => void;
  onToggleFavorite: (entity: { type: TopicType; value: string; label: string }, favorite: boolean) => void;
};

export function TopicEntityCard({ item, type, onOpenEntity, onToggleFavorite, statsUnavailable }: TopicEntityCardProps) {
  useLocale();
  return (
    <article className="topic-entity-tile" data-motion-layout-id={`topic:${type}:${item.value}`}>
      <button
        className="topic-entity-open"
        onClick={() => onOpenEntity({ type, value: item.value, label: item.label })}
        type="button"
      >
        <span className="topic-entity-cover">
          {item.customCoverMediaId ? (
            <PosterImage alt="" loading="lazy" src={getPosterUrl(item.customCoverMediaId)} />
          ) : item.mediaId ? (
            <PosterImage alt="" loading="lazy" src={getPosterUrl(item.mediaId)} />
          ) : (
            <Layers3 size={28} />
          )}
        </span>
        <span className="topic-entity-copy">
          <strong title={item.label}>{item.label}</strong>
          <span aria-hidden={item.label === item.value} title={item.label !== item.value ? item.value : undefined}>
            {item.label !== item.value ? item.value : "\u00a0"}
          </span>
          <span className="topic-entity-meta">
            <small>{statsUnavailable ? "信息待加载" : item.latestReleaseDate || "发行日期待补全"}</small>
            <span className="topic-entity-count">{statsUnavailable ? "—" : t("{{p0}} 部", { p0: item.mediaCount.toLocaleString(getIntlLocale()) })}</span>
          </span>
        </span>
      </button>
      <Button
        aria-pressed={item.isFavorite}
        aria-label={item.isFavorite ? t("取消收藏{{p0}}", { p0: item.label }) : t("收藏{{p0}}", { p0: item.label })}
        className={`topic-entity-favorite${item.isFavorite ? " is-active" : ""}`}
        icon={<Heart fill={item.isFavorite ? "currentColor" : "none"} size={15} />}
        onClick={() => onToggleFavorite({ type, value: item.value, label: item.label }, !item.isFavorite)}
        size="small"
        type="text"
      />
    </article>
  );
}

