import { getIntlLocale } from "../../i18n/core";
import { t, useLocale, useLocalizedMemo } from "../../i18n";
import { useEffect, useRef, useState } from "react";
import { CalendarDays, Hash, ImageIcon, Tags, UserRound, Video } from "lucide-react";
import type { AgentMention, AgentMentionType } from "../../features/agent/api";
import { getPosterUrl } from "../../lib/api";

const labels: Record<AgentMentionType, string> = {
  code: "番号", actor: "演员", genre: "标签", series: "系列", maker: "厂商", label: "厂牌", director: "导演", prefix: "番号前缀"
};

function MentionIcon({ type }: { type: AgentMentionType }) {
  useLocale();
  if (type === "actor" || type === "director") return <UserRound size={13} />;
  if (type === "code") return <Video size={13} />;
  if (type === "genre") return <Tags size={13} />;
  return <Hash size={13} />;
}

function MentionArtwork({ item, large = false }: { item: AgentMention; large?: boolean }) {
  useLocale();
  const posterUrl = item.mediaId ? getPosterUrl(item.mediaId, large ? "detail" : "card") : "";
  const sources = useLocalizedMemo(() => [...new Set([item.imageUrl, posterUrl].filter(Boolean))] as string[], [item.imageUrl, posterUrl]);
  const [sourceIndex, setSourceIndex] = useState(0);

  useEffect(() => setSourceIndex(0), [item.type, item.value, sources.length]);

  const source = sources[sourceIndex];
  return <span className={`agent-mention-artwork${large ? " is-large" : ""}`}>
    {source
      ? <img
          alt=""
          loading="lazy"
          onError={() => setSourceIndex((current) => current + 1)}
          referrerPolicy="no-referrer"
          src={source}
        />
      : <MentionIcon type={item.type} />}
  </span>;
}

function releaseLabel(value?: string) {
  const year = value?.match(/^\d{4}/u)?.[0];
  return year ? `${year} 最近收录` : "馆藏实体";
}

export function AgentMentionPicker({ activeIndex, items, loading, query, onActiveIndexChange, onSelect }: {
  activeIndex: number;
  items: AgentMention[];
  loading: boolean;
  query: string;
  onActiveIndexChange: (index: number) => void;
  onSelect: (mention: AgentMention) => void;
}) {
  useLocale();
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeItem = items[activeIndex] ?? null;

  useEffect(() => {
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return <div className="agent-mention-picker" aria-label="选择馆藏实体">
    <header>
      <span><strong>{query ? `匹配“${query}”` : "选择馆藏实体"}</strong><small>继续输入可缩小范围</small></span>
      <small>↑↓ 选择 · Enter 确认 · Esc 关闭</small>
    </header>
    <div className="agent-mention-picker-body">
      <div
        aria-activedescendant={activeItem ? `agent-mention-${activeIndex}` : undefined}
        aria-label="馆藏实体候选"
        className="agent-mention-results"
        id="agent-mention-options"
        role="listbox"
      >
      {items.map((item, index) => <button
        aria-selected={index === activeIndex}
        className={index === activeIndex ? "is-active" : ""}
        id={`agent-mention-${index}`}
        key={`${item.type}:${item.value}`}
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={() => onActiveIndexChange(index)}
        onClick={() => onSelect(item)}
        ref={(node) => { optionRefs.current[index] = node; }}
        role="option"
        type="button"
      >
        <MentionArtwork item={item} />
        <div className="agent-mention-copy">
          <strong>{item.label}</strong>
          <small><b>{labels[item.type]}</b>{item.originalName ? ` · ${item.originalName}` : ` · ${releaseLabel(item.latestReleaseDate)}`}</small>
        </div>
        <em>{item.count != null ? t("{{p0}} 部", { p0: item.count.toLocaleString(getIntlLocale()) }) : "选择"}</em>
      </button>)}
      {!loading && items.length === 0 && <div className="agent-mention-empty">没有匹配的演员、标签或其他馆藏实体</div>}
      {loading && items.length === 0 && <div className="agent-mention-empty">正在匹配馆藏…</div>}
      </div>
      {activeItem && <aside className="agent-mention-preview" aria-live="polite">
        <MentionArtwork item={activeItem} large />
        <div>
          <small>{labels[activeItem.type]}</small>
          <strong>{activeItem.label}</strong>
          {activeItem.originalName && <span>{activeItem.originalName}</span>}
        </div>
        <dl>
          <div><dt>馆藏</dt><dd>{activeItem.count != null ? t("{{p0}} 部", { p0: activeItem.count.toLocaleString(getIntlLocale()) }) : "—"}</dd></div>
          <div><dt><CalendarDays size={10} />最近</dt><dd>{activeItem.latestReleaseDate?.slice(0, 10) || "暂无日期"}</dd></div>
        </dl>
        <p><ImageIcon size={11} /> Enter 添加到当前问题</p>
      </aside>}
    </div>
  </div>;
}
