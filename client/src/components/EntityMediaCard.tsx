import { t, useLocale } from "../i18n";
import { Play } from "lucide-react";
import type { ReactNode } from "react";
import { getPosterUrl } from "../lib/api";
import { PosterImage } from "./PosterImage";
import "../entity-virtual-grid.css";

type EntityMediaCardProps = {
  item: { id: string; normalizedCode: string; basename: string };
  title: string;
  onOpen: () => void;
  onPlay: () => void;
  coverAction?: ReactNode;
  busy?: boolean;
};

export function EntityMediaCard({ item, title, onOpen, onPlay, coverAction, busy }: EntityMediaCardProps) {
  useLocale();
  const name = item.normalizedCode || item.basename;
  return (
    <article className="entity-virtual-card" role="listitem" aria-busy={busy || undefined}>
      <div className="entity-virtual-cover">
        <button aria-label={t("查看 {{p0}}", { p0: name })} className="entity-virtual-cover-open" disabled={busy} onClick={onOpen} type="button">
          <PosterImage alt="" loading="lazy" src={getPosterUrl(item.id)} />
        </button>
        {coverAction}
        <button aria-label={t("播放 {{p0}}", { p0: name })} className="entity-virtual-play" disabled={busy} onClick={onPlay} title={t("播放")} type="button">
          <Play size={15} fill="currentColor" />
        </button>
      </div>
      <button className="entity-virtual-open" disabled={busy} onClick={onOpen} type="button">
        <span className="entity-virtual-copy">
          <strong title={name}>{name}</strong>
          <span title={title}>{title}</span>
        </span>
      </button>
    </article>
  );
}
