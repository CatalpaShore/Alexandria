import { t, useLocale } from "../../i18n";
import { Button, message as toast, Tooltip } from "antd";
import {
  Bot, Check, ChevronRight, Copy, Database, Heart, LoaderCircle, RotateCcw, Square
} from "lucide-react";
import type { AgentCitation, AgentMessage as AgentMessageType } from "../../features/agent/api";
import type { TopicType } from "../../lib/api";
import { AgentEntityRanking } from "./AgentEntityRanking";
import { AgentEntityCards } from "./AgentEntityCards";
import { AgentEntityProfileCard } from "./AgentEntityProfileCard";
import { AgentActionConfirmation } from "./AgentActionConfirmation";
import { AgentComparisonMatrix } from "./AgentComparisonMatrix";
import { AgentDistributionSummary } from "./AgentDistributionSummary";
import { AgentMarkdown } from "./AgentMarkdown";
import { AgentProcessTrace } from "./AgentProcessTrace";
import { AgentRecommendationCards } from "./AgentRecommendationCards";
import { AgentFollowUps } from "./AgentFollowUps";
import { AgentClarificationQuestion } from "./AgentClarificationQuestion";

function usedCitationIndexes(content: string, citations: AgentCitation[]): number[] {
  const matches = [...content.matchAll(/\[(\d+)]/g)]
    .map((match) => Number(match[1]) - 1)
    .filter((index) => index >= 0 && index < citations.length);
  return matches.length > 0 ? [...new Set(matches)] : citations.map((_, index) => index).slice(0, 4);
}

function EvidencePanel({
  citations,
  content,
  excludedCitationNumbers = [],
  onOpenMedia
}: {
  citations: AgentCitation[];
  content: string;
  excludedCitationNumbers?: number[];
  onOpenMedia: (id: string) => void;
}) {
  useLocale();
  const excluded = new Set(excludedCitationNumbers);
  const indexes = usedCitationIndexes(content, citations).filter((index) => !excluded.has(index + 1));
  if (indexes.length === 0) return null;
  return (
    <details className="agent-evidence">
      <summary><Database size={14} /><span>馆藏依据</span><small>{indexes.length} {t("条")}</small></summary>
      <div className="agent-evidence-list">
        {indexes.map((sourceIndex) => {
          const citation = citations[sourceIndex];
          return (
            <button key={citation.mediaId} onClick={() => onOpenMedia(citation.mediaId)} type="button">
              <span className="agent-evidence-number">[{sourceIndex + 1}]</span>
              <span className="agent-evidence-copy">
                <strong>{citation.code || citation.title}</strong>
                <small>{citation.actors.slice(0, 3).join(" · ") || citation.series || citation.title}</small>
              </span>
              <span className="agent-evidence-state">
                {citation.favorite && <Heart aria-label={t("已收藏")} fill="currentColor" size={11} />}
                {!citation.completed && !citation.lastPlayedAt && <span>未观看</span>}
              </span>
              <ChevronRight size={14} />
            </button>
          );
        })}
      </div>
    </details>
  );
}

export function AgentMessage({
  animate = false,
  item,
  onOpenEntity,
  onOpenMedia,
  onFeedback,
  onReplace,
  onConfirmAction,
  onCancelAction,
  onRetry,
  onStop,
  followUps = [],
  onFollowUp,
  clarificationAnswered = false,
  onClarificationAnswer
}: {
  animate?: boolean;
  item: AgentMessageType;
  onOpenEntity: (entity: { type: TopicType; value: string; label?: string }) => void;
  onOpenMedia: (id: string) => void;
  onFeedback?: (messageId: string, mediaId: string, slot: number, type: "like" | "not_interested" | "more_like_this") => void;
  onReplace?: (messageId: string, slot: number) => void;
  onConfirmAction?: (id: string) => void;
  onCancelAction?: (id: string) => void;
  onRetry?: () => void;
  onStop?: () => void;
  followUps?: string[];
  onFollowUp?: (value: string) => void;
  clarificationAnswered?: boolean;
  onClarificationAnswer?: (question: string, answer: string) => void;
}) {
  useLocale();
  const isAssistant = item.role === "assistant";
  const isGenerating = item.status === "generating";
  const presentations = item.presentations?.length ? item.presentations : item.presentation ? [item.presentation] : [];
  const mediaPresentations = presentations.filter((value): value is Extract<typeof value, { kind: "media-cards" }> => value.kind === "media-cards");
  return (
    <article className={`agent-message is-${item.role} is-${item.status}${animate ? " is-entering" : ""}`}>
      <div className="agent-message-role">{isAssistant ? <Bot size={16} /> : t("你")}</div>
      <div className="agent-message-column">
        <div className="agent-message-body">
          {isAssistant && <AgentProcessTrace status={item.status} trace={item.trace} />}
          {isAssistant && item.status === "completed" && presentations.map((presentation, index) => {
            if (presentation.kind === "media-cards") return <AgentRecommendationCards key={`${presentation.kind}:${index}`} citations={item.citations} onOpenMedia={onOpenMedia} presentation={presentation} onFeedback={(mediaId, slot, type) => onFeedback?.(item.id, mediaId, slot, type)} onReplace={item.state?.intent === "recommend" ? (slot) => onReplace?.(item.id, slot) : undefined} />;
            if (presentation.kind === "entity-cards") return <AgentEntityCards key={`${presentation.kind}:${index}`} onOpenEntity={onOpenEntity} presentation={presentation} />;
            if (presentation.kind === "entity-profile-card") return <AgentEntityProfileCard key={`${presentation.kind}:${index}`} onOpenEntity={onOpenEntity} presentation={presentation} />;
            if (presentation.kind === "entity-ranking") return <AgentEntityRanking key={`${presentation.kind}:${index}`} onOpenEntity={onOpenEntity} presentation={presentation} />;
            if (presentation.kind === "comparison-matrix") return <AgentComparisonMatrix key={`${presentation.kind}:${index}`} onOpenMedia={onOpenMedia} presentation={presentation} />;
            if (presentation.kind === "distribution-summary") return <AgentDistributionSummary key={`${presentation.kind}:${index}`} onOpenEntity={onOpenEntity} presentation={presentation} />;
            if (presentation.kind === "clarification-question") return <AgentClarificationQuestion answered={clarificationAnswered} key={`${presentation.kind}:${index}`} onAnswer={(answer) => onClarificationAnswer?.(presentation.question, answer)} presentation={presentation} />;
            if (presentation.kind === "action-confirmation") return <AgentActionConfirmation key={`${presentation.kind}:${index}`} presentation={presentation} onConfirm={(id) => onConfirmAction?.(id)} onCancel={(id) => onCancelAction?.(id)} />;
            return null;
          })}
          {isAssistant ? (
            item.content
              ? <AgentMarkdown citations={item.citations} content={item.content} />
              : isGenerating && (
                <div className="agent-answer-placeholder" role="status">
                  <span /><span /><span />
                </div>
              )
          ) : <p className="agent-user-content">{item.content}</p>}
          {isAssistant && (
            <EvidencePanel
              citations={item.citations}
              content={item.content}
              excludedCitationNumbers={mediaPresentations.flatMap((presentation) => presentation.citationNumbers)}
              onOpenMedia={onOpenMedia}
            />
          )}
          {isAssistant && item.error && (
            <div className="agent-message-error" role="alert">
              <span>{item.error}</span>
              {onRetry && <Button icon={<RotateCcw size={13} />} onClick={onRetry} size="small">{t("重试")}</Button>}
            </div>
          )}
        </div>
        {isAssistant && item.status === "completed" && <AgentFollowUps items={followUps} onSelect={(value) => onFollowUp?.(value)} />}
        {isAssistant && (item.content || isGenerating) && (
          <div className="agent-message-actions">
            {isGenerating ? (
              onStop
                ? <Button danger icon={<Square fill="currentColor" size={11} />} onClick={onStop} size="small" type="text">{t("停止")}</Button>
                : <span><LoaderCircle className="is-spinning" size={12} />{t("后台生成中")}</span>
            ) : (
              <>
                <Tooltip title="复制回答">
                  <Button
                    aria-label="复制回答"
                    icon={<Copy size={13} />}
                    onClick={() => void navigator.clipboard.writeText(item.content).then(() => toast.success("回答已复制"))}
                    size="small"
                    type="text"
                  />
                </Tooltip>
                {onRetry && <Button icon={<RotateCcw size={13} />} onClick={onRetry} size="small" type="text">{t("重新生成")}</Button>}
                {item.status === "completed" && <span><Check size={12} />本地生成</span>}
              </>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
