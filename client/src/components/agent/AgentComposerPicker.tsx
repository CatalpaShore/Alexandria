import { BarChart3, Film, ListPlus, Search, SlidersHorizontal, Sparkles } from "lucide-react";
import type { AgentComposerSuggestion } from "./agentComposer";

function SuggestionIcon({ id }: { id: string }) {
  if (id === "search") return <Search size={14} />;
  if (id === "recommend") return <Sparkles size={14} />;
  if (id === "compare") return <Film size={14} />;
  if (id === "aggregate") return <BarChart3 size={14} />;
  if (id === "playlist") return <ListPlus size={14} />;
  return <SlidersHorizontal size={14} />;
}
export function AgentComposerPicker({ activeIndex, items, onActiveIndexChange, onSelect, type }: {
  activeIndex: number;
  items: AgentComposerSuggestion[];
  onActiveIndexChange: (index: number) => void;
  onSelect: (item: AgentComposerSuggestion) => void;
  type: "intent" | "constraint";
}) {
  return <div className="agent-composer-picker" aria-label={type === "intent" ? "选择操作" : "选择筛选条件"}>
    <header><strong>{type === "intent" ? "你想让智能馆长做什么？" : "添加检索条件"}</strong><small>↑↓ 选择 · Enter 确认 · Esc 关闭</small></header>
    <div id="agent-composer-options" role="listbox">
      {items.map((item, index) => <button
        aria-selected={activeIndex === index}
        className={activeIndex === index ? "is-active" : ""}
        key={item.token}
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={() => onActiveIndexChange(index)}
        onClick={() => onSelect(item)}
        role="option"
        type="button"
      >
        <span><SuggestionIcon id={item.id} /></span>
        <div><strong>{item.token}</strong><small>{item.description}</small></div>
      </button>)}
      {items.length === 0 && <p>没有匹配的条件</p>}
    </div>
  </div>;
}
