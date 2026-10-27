import { getIntlLocale } from "../i18n/core";
import { t, useLocale } from "../i18n";
import { CalendarRange, Clock3, Film, Star } from "lucide-react";
import type { EntityResponse } from "../lib/api";

type Insights = EntityResponse["entity"]["insights"];

function compactMinutes(minutes: number): string {
  if (minutes < 60) return t("{{p0}} 分钟", { p0: minutes });
  const hours = Math.round(minutes / 6) / 10;
  return t("{{p0}} 小时", { p0: hours.toLocaleString(getIntlLocale()) });
}

export function EntityInsightsPanel({ insights }: { insights: Insights }) {
  useLocale();
  const maxYearCount = Math.max(1, ...insights.yearDistribution.map((item) => item.mediaCount));
  const facts = [
    { icon: <CalendarRange size={14} />, label: "首次发行", value: insights.firstReleaseDate ?? "资料缺失" },
    { icon: <Film size={14} />, label: "活跃年份", value: insights.releaseYearCount ? `${insights.releaseYearCount} 年` : "资料缺失" },
    { icon: <Clock3 size={14} />, label: "累计时长", value: compactMinutes(insights.totalRuntimeMinutes) },
    { icon: <Clock3 size={14} />, label: "平均时长", value: insights.averageRuntimeMinutes ? t("{{p0}} 分钟", { p0: insights.averageRuntimeMinutes }) : "资料缺失" },
    ...(insights.averageScore != null
      ? [{ icon: <Star size={14} />, label: "馆藏评分", value: `${insights.averageScore} · ${insights.scoredMediaCount} 部` }]
      : [])
  ];
  return <section className="entity-insights" aria-label="馆藏画像">
    <header><strong>馆藏画像</strong><span>由本地元数据确定计算</span></header>
    <div className="entity-insight-facts">
      {facts.map((fact) => <div key={fact.label}>{fact.icon}<span>{fact.label}</span><strong>{fact.value}</strong></div>)}
    </div>
    {insights.yearDistribution.length > 1 && <div className="entity-year-chart" aria-label="年度作品分布">
      {insights.yearDistribution.map((item) => <div key={item.year} title={`${item.year} · ${item.mediaCount} 部`}>
        <span style={{ height: `${Math.max(8, item.mediaCount / maxYearCount * 100)}%` }} />
        <small>{item.year.slice(2)}</small>
      </div>)}
    </div>}
  </section>;
}
