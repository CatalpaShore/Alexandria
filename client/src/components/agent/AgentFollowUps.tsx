import { ArrowUpRight, Sparkles } from "lucide-react";

export function AgentFollowUps({ items, onSelect }: { items: string[]; onSelect: (value: string) => void }) {
  if (!items.length) return null;
  return <section className="agent-follow-ups" aria-label="猜你想问">
    <header><Sparkles size={12} /><strong>猜你想问</strong></header>
    <div>{items.map((item) => <button key={item} onClick={() => onSelect(item)} type="button"><span>{item}</span><ArrowUpRight size={12} /></button>)}</div>
  </section>;
}
