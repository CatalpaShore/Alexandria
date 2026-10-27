import type { AgentComposerContext } from "../../features/agent/api";

export type AgentComposerSuggestion = {
  id: string;
  token: string;
  label: string;
  description: string;
  kind: "intent" | "constraint";
};

export type AgentComposerChip = {
  id: string;
  raw: string;
  label: string;
  kind: "intent" | "include" | "exclude";
};

export const agentIntentSuggestions: AgentComposerSuggestion[] = [
  { id: "search", token: "/找片", label: "找片", description: "按明确条件检索馆藏", kind: "intent" },
  { id: "recommend", token: "/推荐", label: "推荐", description: "结合条件与偏好给出候选", kind: "intent" },
  { id: "compare", token: "/比较", label: "比较", description: "比较多个作品或实体", kind: "intent" },
  { id: "aggregate", token: "/统计", label: "统计", description: "汇总数量、分布或排行", kind: "intent" },
  { id: "playlist", token: "/整理片单", label: "整理片单", description: "从结果中组织片单并确认", kind: "intent" }
];

export const agentConstraintSuggestions: AgentComposerSuggestion[] = [
  { id: "unwatched", token: "#未观看", label: "未观看", description: "只看尚未开始的作品", kind: "constraint" },
  { id: "favorite", token: "#已收藏", label: "已收藏", description: "限定在我的收藏中", kind: "constraint" },
  { id: "four-k", token: "#4K", label: "4K", description: "限定 4K 内容", kind: "constraint" },
  { id: "recent", token: "#最近入库", label: "最近入库", description: "优先展示最近收录", kind: "constraint" },
  { id: "completed", token: "#已观看", label: "已观看", description: "限定已完成观看", kind: "constraint" },
  { id: "single", token: "#单体作品", label: "单体作品", description: "限定单体作品标签", kind: "constraint" }
];

const intentByLabel = new Map(agentIntentSuggestions.map((item) => [item.label, item]));
const TRIGGER_PATTERN = /(?:^|[\s，。！？、；：,.!?;:（(])(\/[^\s/]*|-?#[^\s#]*)$/u;
const INTENT_PATTERN = /(?:^|\s)\/([^\s/]+)/gu;
const CONSTRAINT_PATTERN = /(?:^|\s)(-?)#([^\s#]+)/gu;

export function matchComposerTrigger(value: string): { raw: string; type: "intent" | "constraint"; query: string; excluded: boolean } | null {
  const match = value.match(TRIGGER_PATTERN);
  const raw = match?.[1];
  if (!raw) return null;
  if (raw.startsWith("/")) return { raw, type: "intent", query: raw.slice(1), excluded: false };
  const excluded = raw.startsWith("-#");
  return { raw, type: "constraint", query: raw.slice(excluded ? 2 : 1), excluded };
}

export function getComposerSuggestions(value: string): AgentComposerSuggestion[] {
  const trigger = matchComposerTrigger(value);
  if (!trigger) return [];
  const source = trigger.type === "intent" ? agentIntentSuggestions : agentConstraintSuggestions;
  const normalized = trigger.query.normalize("NFKC").toLocaleLowerCase("zh-CN");
  return source
    .filter((item) => !normalized || `${item.label}${item.description}`.normalize("NFKC").toLocaleLowerCase("zh-CN").includes(normalized))
    .map((item) => trigger.excluded ? { ...item, token: `-#${item.label}` } : item);
}

export function applyComposerSuggestion(value: string, token: string): string {
  const trigger = matchComposerTrigger(value);
  if (!trigger) return `${value}${value && !/\s$/u.test(value) ? " " : ""}${token} `;
  return `${value.slice(0, value.length - trigger.raw.length)}${token} `;
}

export function parseAgentComposer(value: string): { chips: AgentComposerChip[]; context: AgentComposerContext } {
  const chips: AgentComposerChip[] = [];
  let intent: AgentComposerContext["intent"];
  for (const match of value.matchAll(INTENT_PATTERN)) {
    const label = match[1];
    const suggestion = intentByLabel.get(label);
    if (!suggestion || intent) continue;
    intent = { id: suggestion.id, label: suggestion.label };
    chips.push({ id: `intent:${suggestion.id}`, raw: `/${label}`, label: suggestion.label, kind: "intent" });
  }
  const constraints: AgentComposerContext["constraints"] = [];
  for (const match of value.matchAll(CONSTRAINT_PATTERN)) {
    const label = match[2].replace(/[，。！？、；：,.!?;:）)]$/u, "");
    if (!label) continue;
    const excluded = match[1] === "-";
    const raw = `${excluded ? "-" : ""}#${label}`;
    if (constraints.some((item) => item.label === label && item.excluded === excluded)) continue;
    constraints.push({ label, excluded });
    chips.push({ id: `${excluded ? "exclude" : "include"}:${label}`, raw, label, kind: excluded ? "exclude" : "include" });
  }
  return { chips, context: { ...(intent ? { intent } : {}), constraints } };
}

export function removeComposerToken(value: string, raw: string): string {
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value.replace(new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`, "u"), " ").replace(/\s{2,}/gu, " ").trimStart();
}
