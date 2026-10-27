import { t, useLocale } from "../../i18n";
import { Button, Tooltip } from "antd";
import { ChevronRight, Heart, RefreshCw, Sparkles, ThumbsDown, ThumbsUp } from "lucide-react";
import { useState, type FocusEvent } from "react";
import type { AgentCitation, AgentPresentation } from "../../features/agent/api";
import { AgentMediaArtwork } from "./AgentMediaArtwork";

type MediaCardsPresentation = Extract<AgentPresentation, { kind: "media-cards" }>;

function watchState(item: AgentCitation): string {
  if (item.completed) return t("已看完");
  if (item.lastPlayedAt) return "看过";
  return "未观看";
}

function resolvedLayout(presentation: MediaCardsPresentation, count: number): "spotlight" | "gallery" | "compact" {
  if (presentation.layout && presentation.layout !== "auto") return presentation.layout;
  if (count === 1) return "spotlight";
  if (count >= 5) return "compact";
  return "gallery";
}

function RecommendationCard({
  citation,
  number,
  onFeedback,
  onOpenMedia,
  onReplace,
  showMotionPreview,
  slotIndex
}: {
  citation: AgentCitation;
  number: number;
  onFeedback?: (mediaId: string, slot: number, type: "like" | "not_interested" | "more_like_this") => void;
  onOpenMedia: (id: string) => void;
  onReplace?: (slot: number) => void;
  showMotionPreview?: boolean;
  slotIndex: number;
}) {
  useLocale();
  const [previewActive, setPreviewActive] = useState(false);
  const onBlur = (event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPreviewActive(false);
  };

  return (
    <article
      className="agent-recommendation-card"
      onBlur={onBlur}
      onFocus={() => setPreviewActive(true)}
      onMouseEnter={() => setPreviewActive(true)}
      onMouseLeave={() => setPreviewActive(false)}
    >
      <button className="agent-recommendation-main" onClick={() => onOpenMedia(citation.mediaId)} type="button" aria-label={`查看 ${citation.code || citation.title}：${citation.title}`}>
        <AgentMediaArtwork active={previewActive} citation={citation} citationNumber={number} showMotionPreview={showMotionPreview} />
        <span className="agent-recommendation-copy">
          <span className="agent-recommendation-topline">
            <strong>{citation.code || citation.title}</strong>
            <span className="agent-recommendation-states">
              {citation.favorite && <span><Heart fill="currentColor" size={10} />{t("收藏")}</span>}
              <span>{watchState(citation)}</span>
            </span>
          </span>
          <span className="agent-recommendation-title">{citation.title}</span>
          <small>{citation.actors.slice(0, 3).join(" · ") || citation.series || "演员信息待补全"}</small>
          {citation.summary && <span className="agent-recommendation-summary">{citation.summary}</span>}
          <span className="agent-recommendation-tags">
            {citation.genres.slice(0, 3).map((genre) => <span key={genre}>{genre}</span>)}
          </span>
        </span>
        <ChevronRight className="agent-recommendation-open" size={15} />
      </button>
      {(onFeedback || onReplace) && <div className="agent-recommendation-actions">
        <Tooltip title="喜欢"><Button aria-label="喜欢" icon={<ThumbsUp size={11} />} onClick={() => onFeedback?.(citation.mediaId, slotIndex + 1, "like")} size="small" type="text" /></Tooltip>
        <Tooltip title="更多类似"><Button aria-label="更多类似" icon={<Sparkles size={11} />} onClick={() => onFeedback?.(citation.mediaId, slotIndex + 1, "more_like_this")} size="small" type="text" /></Tooltip>
        <Tooltip title={t("不感兴趣")}><Button aria-label={t("不感兴趣")} icon={<ThumbsDown size={11} />} onClick={() => onFeedback?.(citation.mediaId, slotIndex + 1, "not_interested")} size="small" type="text" /></Tooltip>
        {onReplace && <Button icon={<RefreshCw size={11} />} onClick={() => onReplace(slotIndex + 1)} size="small" type="text">{t("换一部")}</Button>}
      </div>}
    </article>
  );
}

export function AgentRecommendationCards({
  citations,
  onOpenMedia,
  onFeedback,
  onReplace,
  presentation
}: {
  citations: AgentCitation[];
  onOpenMedia: (id: string) => void;
  onFeedback?: (mediaId: string, slot: number, type: "like" | "not_interested" | "more_like_this") => void;
  onReplace?: (slot: number) => void;
  presentation: MediaCardsPresentation;
}) {
  useLocale();
  const cards = presentation.citationNumbers
    .map((number) => ({ citation: citations[number - 1], number }))
    .filter((item): item is { citation: AgentCitation; number: number } => Boolean(item.citation));
  if (cards.length === 0) return null;
  const layout = resolvedLayout(presentation, cards.length);

  return (
    <section aria-label={`${presentation.title}，共 ${cards.length} 部`} className="agent-recommendations">
      <header>
        <span><Sparkles size={13} /></span>
        <div><strong>{presentation.title}</strong><small>{cards.length} 部 · 点击卡片查看影片详情</small></div>
      </header>
      <div className={`agent-recommendation-grid is-${layout}`}>
        {cards.map(({ citation, number }, slotIndex) => (
          <RecommendationCard
            citation={citation}
            key={`${citation.mediaId}:${number}`}
            number={number}
            onFeedback={onFeedback}
            onOpenMedia={onOpenMedia}
            onReplace={onReplace}
            showMotionPreview={presentation.showMotionPreview}
            slotIndex={slotIndex}
          />
        ))}
      </div>
    </section>
  );
}
