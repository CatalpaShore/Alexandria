import { getIntlLocale } from "../i18n/core";
import { t, useLocale, useLocalizedMemo } from "../i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Drawer,
  Empty,
  Input,
  Segmented,
  Select,
  Spin,
  Table,
  Tooltip,
  Typography,
  type TableColumnsType
} from "antd";
import {
  Activity,
  ArrowLeft,
  BadgeCheck,
  BarChart3,
  BookOpenCheck,
  Boxes,
  CalendarDays,
  ChartNoAxesCombined,
  CircleGauge,
  Cpu,
  Database,
  FileSearch,
  Filter,
  Focus,
  GitBranch,
  HardDrive,
  History,
  Layers3,
  LayoutDashboard,
  ListChecks,
  Maximize2,
  MonitorPlay,
  Network,
  PackageCheck,
  PanelsTopLeft,
  RefreshCw,
  Rows3,
  ScanSearch,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TableProperties,
  Tags,
  UserRound,
  UsersRound,
  Workflow,
  type LucideIcon
} from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ActiveEntity } from "../hooks/useOverlayState";
import { fetchMedia, formatBytes, getPosterUrl, type MediaItem, type MediaQuery } from "../lib/api";
import {
  fetchLibraryAnalyticsMatrixEvidence,
  fetchLibraryAnalyticsSection,
  fetchLibraryAnalyticsSummary,
  type LibraryActorSummary,
  type LibraryAnalyticsContract,
  type LibraryAnalyticsContentMode,
  type LibraryAnalyticsData,
  type LibraryCrossMatrix,
  type LibraryCrossMatrixCell,
  type LibraryCrossMatrixMember,
  type LibraryAnalyticsDistribution,
  type LibraryAnalyticsFacetItem,
  type LibraryAnalyticsFacetType,
  type LibraryAnalyticsIngestionRun,
  type LibraryAnalyticsJobType,
  type LibraryAnalyticsPipelineStage,
  type LibraryAnalyticsSummary,
  type LibraryAnalyticsYearMetric
} from "../lib/libraryAnalyticsApi";
import {LibraryPrefixAnalytics} from "./LibraryPrefixAnalytics";
import { PosterImage } from "./PosterImage";
import { GovernanceActionDrawer } from "./GovernanceActionDrawer";
import { MotionSurface } from "./motion/MotionSurface";
import type { GovernanceIssueKey } from "../lib/governanceApi";
import "../library-analytics.css";

type LibraryAnalyticsDashboardProps = {
  onBack: () => void;
  onOpenEntity: (entity: ActiveEntity) => void;
  onOpenMedia: (item: MediaItem, queue?: MediaItem[]) => void;
};

type AnalyticsView = "overview" | "time" | "content" | "technical" | "operations" | "quality" | "details";
type AnalyticsMeasure = "works" | "files" | "bytes";
type ContentMode = "actors" | "entities" | "relations" | "prefixes";
type ActorMatrixMode = "lift" | "share" | "works";
type CrossMatrixMode = "lift" | "share" | "value";
type MatrixDisplayMode = "dots" | "table";
type GenreGroupFilter = "content" | "all" | "theme" | "persona" | "production";
type ActorActivityMode = "share" | "works";
type ActorCoverageMode = "year" | "provider";
type OverviewLens = "scale" | "quality" | "risk";
type TimeHeatMode = "works" | "share";
type TimeMixMode = "absolute" | "share";
type TechnicalMeasure = "files" | "bytes";
type JobDailyMode = "volume" | "rate";
type QualityLens = "coverage" | "freshness" | "actions";
type CoverageCohortMode = "coverage" | "gap";
type DetailDataset = "year" | "source" | "entity" | "provider" | "format" | "issues" | "jobs" | "ingestion" | "assets" | "failures" | "concentration";

type SelectedActorGenreCell = {
  actor: LibraryActorSummary;
  genre: LibraryAnalyticsData["actorAnalytics"]["genreAffinity"]["genres"][number];
  cell: LibraryAnalyticsData["actorAnalytics"]["genreAffinity"]["cells"][number];
};

type SelectedCrossCell = {
  matrix: LibraryCrossMatrix;
  row: LibraryCrossMatrixMember;
  column: LibraryCrossMatrixMember;
  cell: LibraryCrossMatrixCell;
};

type RankedItem = {
  key: string;
  label: string;
  value: number;
  displayValue?: string;
  secondary?: string;
};

type SegmentedItem = {
  key: string;
  label: string;
  value: number;
  displayValue?: string;
  secondary?: string;
};

type DiagnosticSignal = {
  key: string;
  label: string;
  displayValue: string;
  secondary: string;
  rate: number;
  tone?: "orange" | "blue" | "gold" | "pink";
};

const numberFormatter = new Intl.NumberFormat(getIntlLocale());
const compactFormatter = new Intl.NumberFormat(getIntlLocale(), { notation: "compact", maximumFractionDigits: 1 });
const chartColors = ["#ff9f1a", "#5b8ff9", "#d9b45b", "#de739f", "#64b889"];

const facetLabels: Record<LibraryAnalyticsFacetType, string> = {
  actor: "演员",
  genre: "题材",
  series: "系列",
  maker: "厂商",
  label: "厂牌",
  director: "导演"
};

const viewOptions: Array<{ key: AnalyticsView; label: string; hint: string; icon: LucideIcon }> = [
  { key: "overview", label: "驾驶舱", hint: "核心状态", icon: LayoutDashboard },
  { key: "time", label: "时间脉络", hint: "年度与入库", icon: CalendarDays },
  { key: "content", label: "内容宇宙", hint: "实体与关系", icon: Network },
  { key: "technical", label: "技术存储", hint: "规格与容量", icon: Cpu },
  { key: "operations", label: "生产资产", hint: "任务与派生", icon: Workflow },
  { key: "quality", label: "数据治理", hint: "覆盖与行动", icon: ShieldCheck },
  { key: "details", label: "明细实验室", hint: "透视与查找", icon: TableProperties }
];

const detailDatasetOptions: Array<[DetailDataset, string]> = [
  ["year", "年度基准"],
  ["source", "存储来源"],
  ["entity", "实体知识"],
  ["provider", "供应商"],
  ["format", "格式资产"],
  ["issues", "问题作品"],
  ["jobs", "任务类型"],
  ["ingestion", "采集批次"],
  ["assets", "派生资产"],
  ["failures", "失败任务"],
  ["concentration", "维度集中度"]
];

const visualizationAuditItems = [
  {
    section: "演员 × 题材偏好",
    question: "哪些组合既偏好突出，又有足够作品证据？",
    decision: "点阵图为默认，精确表格可切换",
    status: "已优化",
    reason: "二维位置用于扫关系，颜色表达偏好方向，点大小表达作品数；低样本使用空心点，避免把偶然共现当成稳定偏好。"
  },
  {
    section: "演员 × 题材高频组合",
    question: "哪些组合的共同作品最多？",
    decision: "排行条替代 8 × 8 色块表",
    status: "已优化",
    reason: "这里只比较一个主度量，排序后的长度比二维色深更容易精确比较；偏好提升仍在点阵中单独判断。"
  },
  {
    section: "内容维度集中度",
    question: "演员、题材等维度是集中还是长尾？",
    decision: "对比轨道为主，精确表格留在明细实验室",
    status: "已优化",
    reason: "维度数量少且重点是比较 Top 10 与单次出现占比；HHI 与实体数作为解释性标注保留。"
  },
  {
    section: "年度、实体与来源基准",
    question: "如何跨多个口径查询和排序精确数值？",
    decision: "保留表格，并与趋势/构成图配对",
    status: "保留",
    reason: "列多、需要排序和精确查找，图表无法替代表格；页面上方已有趋势、分布与容量图负责展示形态。"
  },
  {
    section: "活跃、覆盖与技术交叉",
    question: "时间、字段或技术规格中哪里出现结构性缺口？",
    decision: "保留热力矩阵",
    status: "保留",
    reason: "每格只有一个强度指标，行列顺序具有业务含义；色块比大小不同的圆点更适合连续扫描覆盖和缺口。"
  },
  {
    section: "采集批次、失败任务与治理清单",
    question: "具体哪一批、哪一项、什么错误需要处理？",
    decision: "保留可排序明细表",
    status: "保留",
    reason: "这是诊断与行动清单，必须保留完整字段、错误文本、时间和精确对象，不能用汇总图替代。"
  }
] as const;

function formatNumber(value: number): string {
  return numberFormatter.format(Math.round(value));
}

function formatPercent(value: number, digits = 1): string {
  return `${(Math.max(0, value) * 100).toFixed(value >= 0.995 ? 0 : digits)}%`;
}

function formatSignedPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${(value * 100).toFixed(1)}%`;
}

function formatHours(seconds: number): string {
  return t("{{p0}} 小时", { p0: formatNumber(seconds / 3600) });
}

function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "—";
  const hours = Math.floor(minutes / 60);
  const remainder = Math.round(minutes % 60);
  return hours > 0 ? `${hours}时${remainder}分` : `${remainder}分`;
}

function formatDateTime(value: string | null): string {
  if (!value) return "暂无时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(getIntlLocale(), {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function formatDurationSeconds(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value < 1) return `${Math.round(value * 1000)} 毫秒`;
  if (value < 60) return t("{{p0}} 秒", { p0: value.toFixed(value < 10 ? 1 : 0) });
  if (value < 3600) return `${Math.floor(value / 60)}分${Math.round(value % 60)}秒`;
  return `${Math.floor(value / 3600)}时${Math.round(value % 3600 / 60)}分`;
}

function latestTimestamp(...values: Array<string | null>): string | null {
  return values.reduce<string | null>((latest, value) => {
    if (!value) return latest;
    if (!latest) return value;
    const valueTime = new Date(value).getTime();
    const latestTime = new Date(latest).getTime();
    if (!Number.isFinite(valueTime)) return latest;
    return !Number.isFinite(latestTime) || valueTime > latestTime ? value : latest;
  }, null);
}

function formatMonthDay(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(getIntlLocale(), { month: "numeric", day: "numeric" }).format(date);
}

function percentageStyle(value: number): CSSProperties {
  return { "--analytics-value": `${Math.max(0, Math.min(100, value))}%` } as CSSProperties;
}

function heatStyle(value: number, maxValue: number): CSSProperties {
  const strength = maxValue > 0 ? value / maxValue : 0;
  return { "--heat-strength": Math.max(0.04, strength) } as CSSProperties;
}

function coverageHeatStyle(rate: number): CSSProperties {
  const strength = Math.max(0, Math.min(1, (rate - 0.7) / 0.3));
  return { "--heat-strength": Math.max(0.06, strength) } as CSSProperties;
}

function HeatLegend({ label, tone = "orange", low = "低", high = "高" }: {
  label: string;
  tone?: "orange" | "blue" | "pink" | "diverging";
  low?: string;
  high?: string;
}) {
  useLocale();
  return (
    <div aria-label={`${label}，从${low}到${high}`} className={`analytics-heat-legend is-${tone}`}>
      <em>{label}</em><span>{low}</span>
      <i aria-hidden="true">{[0.18, 0.38, 0.6, 0.8, 1].map((strength) => <b key={strength} style={{ "--legend-strength": strength } as CSSProperties} />)}</i>
      <span>{high}</span>
    </div>
  );
}

function matrixDotStyle({ value, maxValue, lift, confidence, mode }: {
  value: number;
  maxValue: number;
  lift: number;
  confidence: number;
  mode: "lift" | "share" | "volume";
}): CSSProperties {
  const volumeRatio = Math.sqrt(Math.max(0, value) / Math.max(1, maxValue));
  const size = value > 0 ? 7 + volumeRatio * 19 : 0;
  const liftDistance = Math.min(1, Math.abs(Math.log2(Math.max(0.25, lift))) / 2);
  const isNearBaseline = Math.abs(Math.log2(Math.max(0.25, lift))) < 0.14;
  const color = mode === "lift"
    ? isNearBaseline ? "#8b96a2" : lift >= 1 ? "#ff9f1a" : "#5b8ff9"
    : "#ff9f1a";
  const strength = mode === "lift" ? 35 + liftDistance * 65 : 32 + volumeRatio * 68;
  return {
    "--matrix-dot-size": `${size.toFixed(1)}px`,
    "--matrix-dot-color": color,
    "--matrix-dot-strength": `${strength.toFixed(0)}%`,
    "--matrix-dot-opacity": Math.max(0.42, Math.min(1, 0.5 + confidence * 0.5))
  } as CSSProperties;
}

function MatrixDotLegend({ mode, minimumValue, unit = "作品" }: {
  mode: "lift" | "share" | "volume";
  minimumValue: number;
  unit?: string;
}) {
  useLocale();
  return (
    <div className="analytics-dot-legend" aria-label={`点大小表示${unit}数，颜色表示${mode === "lift" ? "相对全库的稳健提升" : mode === "share" ? "纵轴内部占比" : `${unit}量`}`}>
      <span className="analytics-dot-color-key">
        <em>颜色</em>
        {mode === "lift" ? <><i className="is-negative" />弱于全库<i className="is-neutral" />接近基准<i className="is-positive" />强于全库</> : <><i className="is-positive" />{mode === "share" ? "占比越高越亮" : `${unit}越多越亮`}</>}
      </span>
      <span className="analytics-dot-size-key"><em>大小</em><i className="is-small" /><i className="is-medium" /><i className="is-large" />{unit}数</span>
      <span className="analytics-dot-confidence-key"><i />空心 = 低于 {minimumValue} {unit === "作品" ? t("部") : t("个")}或低置信</span>
    </div>
  );
}

function AnalyticsDisplayAuditDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  useLocale();
  return (
    <Drawer className="analytics-audit-drawer" destroyOnHidden onClose={onClose} open={open} placement="right" size={560} title="数据分析师 · 展示方式审计">
      <div className="analytics-audit-content">
        <section className="analytics-audit-principles">
          <span><ChartNoAxesCombined size={16} /></span>
          <div><strong>图表负责看形态，表格负责找精确值</strong><small>本次按分析问题、主度量数量、样本可信度与行动场景逐项判断，没有把所有表格机械地改成图。</small></div>
        </section>
        <div className="analytics-audit-list">
          {visualizationAuditItems.map((item, index) => (
            <article key={item.section}>
              <span className="analytics-audit-index">{String(index + 1).padStart(2, "0")}</span>
              <div>
                <header><strong>{item.section}</strong><em className={item.status === "已优化" ? "is-optimized" : ""}>{item.status}</em></header>
                <small>{item.question}</small>
                <b>{item.decision}</b>
                <p>{item.reason}</p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </Drawer>
  );
}

function MetricDefinitionDrawer({ contract, open, onClose }: { contract: LibraryAnalyticsContract | null; open: boolean; onClose: () => void }) {
  useLocale();
  return (
    <Drawer className="analytics-metric-definition-drawer" destroyOnHidden onClose={onClose} open={open} placement="right" size={580} title="指标口径与数据血缘">
      <div className="analytics-metric-definition-content">
        <section><BookOpenCheck size={18} /><div><strong>统一语义版本 {contract?.version ?? "—"}</strong><small>作品身份键：{contract?.workIdentity ?? "normalized_code"} · 发行日期：{contract?.releaseDateField ?? "media_metadata.release_date"}</small></div></section>
        <div>{(contract?.metrics ?? []).map((metric) => <article key={metric.key}><header><strong>{metric.label}</strong><span>{metric.grain}</span></header><p>{metric.definition}</p><small><b>分母</b>{metric.denominator}</small><small><b>{t("来源")}</b><code>{metric.source}</code></small></article>)}</div>
      </div>
    </Drawer>
  );
}

function Sparkline({ values, tone = "orange" }: { values: number[]; tone?: "orange" | "blue" | "gold" | "pink" }) {
  useLocale();
  if (values.length < 2) return <span className="analytics-sparkline-empty" />;
  const width = 112;
  const height = 30;
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = Math.max(1, maximum - minimum);
  const points = values.map((value, index) => {
    const x = 2 + index / (values.length - 1) * (width - 4);
    const y = 3 + (1 - (value - minimum) / range) * (height - 7);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg aria-hidden="true" className={`analytics-sparkline is-${tone}`} viewBox={`0 0 ${width} ${height}`}>
      <polyline points={points} />
    </svg>
  );
}

function AnalyticsCard({ title, subtitle, icon: Icon, extra, children, className = "" }: {
  title: string;
  subtitle: string;
  icon: LucideIcon;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  useLocale();
  return (
    <article className={`analytics-card ${className}`.trim()}>
      <header className="analytics-card-header">
        <div className="analytics-card-title">
          <span className="analytics-card-icon"><Icon size={16} /></span>
          <div><strong>{title}</strong><span>{subtitle}</span></div>
        </div>
        {extra && <div className="analytics-card-extra">{extra}</div>}
      </header>
      <div className="analytics-card-body">{children}</div>
    </article>
  );
}

function MetricCard({ label, value, hint, icon: Icon, trend = [], tone = "orange", badge }: {
  label: string;
  value: string;
  hint: string;
  icon: LucideIcon;
  trend?: number[];
  tone?: "orange" | "blue" | "gold" | "pink";
  badge?: string;
}) {
  useLocale();
  return (
    <article className={`analytics-metric is-${tone}`}>
      <span className="analytics-metric-icon"><Icon size={17} /></span>
      <span className="analytics-metric-label">{label}</span>
      {badge && <em>{badge}</em>}
      <strong>{value}</strong>
      <Sparkline tone={tone} values={trend} />
      <small>{hint}</small>
    </article>
  );
}

function AnalyticsSummaryPreview({ data }: { data: LibraryAnalyticsSummary }) {
  useLocale();
  return (
    <>
      <section className="analytics-scope-banner" aria-label="统计口径">
        <div><Sparkles size={15} /><strong>{data.scope.label}</strong><span>摘要已经就绪，当前分析视图正在按需载入</span></div>
        <small>作品按番号去重；技术、格式与容量按媒体文件计</small>
      </section>
      <section className="analytics-metric-grid" aria-label="馆藏核心指标">
        <MetricCard hint={`${formatNumber(data.summary.variants)} 个额外文件版本`} icon={PanelsTopLeft} label="去重作品" value={formatNumber(data.summary.works)} />
        <MetricCard hint="当前筛选范围内的视频资产" icon={MonitorPlay} label="媒体文件" tone="blue" value={formatNumber(data.summary.files)} />
        <MetricCard hint={`平均 ${formatBytes(data.summary.averageFileBytes)} / 文件`} icon={HardDrive} label="存储体量" tone="gold" value={formatBytes(data.summary.totalBytes)} />
        <MetricCard hint={`平均 ${formatMinutes(data.summary.averageDurationSeconds / 60)} / 文件`} icon={History} label="总片长" tone="pink" value={formatHours(data.summary.totalDurationSeconds)} />
        <MetricCard badge="多版本" hint="额外版本占文件总数" icon={GitBranch} label="版本复杂度" value={formatPercent(data.summary.variantRate)} />
        <MetricCard badge="元数据" hint={`${formatNumber(data.summary.readyMetadataWorks)} 部已就绪`} icon={BadgeCheck} label="数据覆盖" tone="blue" value={formatPercent(data.summary.metadataCoverage)} />
        <MetricCard badge="播放器" hint={`播放风险 ${formatPercent(data.summary.playbackRiskRate)}`} icon={CircleGauge} label={t("原生播放")} tone="gold" value={formatPercent(data.summary.nativePlaybackRate)} />
        <MetricCard badge={`n=${formatNumber(data.summary.scoredWorks)}`} hint="仅统计有效评分样本" icon={ChartNoAxesCombined} label="有效均分" tone="pink" value={data.summary.averagePositiveScore > 0 ? data.summary.averagePositiveScore.toFixed(2) : "—"} />
      </section>
      <div className="analytics-section-loading" role="status"><Spin size="small" /><span>正在载入当前分析视图，其他视图会在打开时再获取</span></div>
    </>
  );
}

function InsightCard({ label, value, note, icon: Icon }: { label: string; value: string; note: string; icon: LucideIcon }) {
  useLocale();
  return (
    <article className="analytics-insight-card">
      <Icon size={15} />
      <span><small>{label}</small><strong>{value}</strong><em>{note}</em></span>
    </article>
  );
}

function DiagnosticSignalBoard({ items }: { items: DiagnosticSignal[] }) {
  useLocale();
  if (items.length === 0) return <Empty description="当前镜头暂无诊断信号" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  return (
    <div className="analytics-diagnostic-board">
      {items.map((item, index) => (
        <div className={`is-${item.tone ?? "orange"}`} key={item.key}>
          <span className="analytics-diagnostic-index">{String(index + 1).padStart(2, "0")}</span>
          <span className="analytics-diagnostic-copy"><strong>{item.label}</strong><small>{item.secondary}</small></span>
          <b aria-hidden="true"><i style={{ width: `${Math.max(item.rate > 0 ? 2 : 0, Math.min(1, item.rate) * 100)}%` }} /></b>
          <em>{item.displayValue}</em>
        </div>
      ))}
    </div>
  );
}

function SegmentedDistribution({ items, total }: { items: SegmentedItem[]; total: number }) {
  useLocale();
  if (items.length === 0 || total <= 0) return <Empty description="当前范围暂无分布数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  const remainingItems = items.slice(5);
  const remainingValue = remainingItems.reduce((sum, item) => sum + item.value, 0);
  const visibleItems: SegmentedItem[] = items.length > 6
    ? [...items.slice(0, 5), { key: "other", label: "其他", value: remainingValue, displayValue: remainingItems.some((item) => item.displayValue) ? formatBytes(remainingValue) : undefined, secondary: t("{{p0}} 项", { p0: items.length - 5 }) }]
    : items;
  return (
    <div className="analytics-segmented">
      <div className="analytics-segmented-track" role="img" aria-label={visibleItems.map((item) => `${item.label} ${formatPercent(item.value / total)}`).join("，")}>
        {visibleItems.map((item, index) => (
          <Tooltip key={item.key} title={`${item.label} · ${item.displayValue ?? formatNumber(item.value)} · ${formatPercent(item.value / total)}`}>
            <span style={{ backgroundColor: chartColors[index % chartColors.length], flexGrow: item.value }} />
          </Tooltip>
        ))}
      </div>
      <div className="analytics-segmented-legend">
        {visibleItems.map((item, index) => (
          <div key={item.key}>
            <i style={{ backgroundColor: chartColors[index % chartColors.length] }} />
            <span><strong>{item.label}</strong><small>{item.secondary}</small></span>
            <b>{item.displayValue ?? formatNumber(item.value)}</b>
            <em>{formatPercent(item.value / total)}</em>
          </div>
        ))}
      </div>
    </div>
  );
}

function RankedBars({ items, onSelect }: { items: RankedItem[]; onSelect?: (item: RankedItem) => void }) {
  useLocale();
  const maxValue = Math.max(1, ...items.map((item) => item.value));
  if (items.length === 0) return <Empty description="当前范围暂无排行数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  return (
    <div className={`analytics-ranked-bars${onSelect ? " is-interactive" : ""}`}>
      {items.map((item, index) => {
        const content = <><span className="analytics-ranked-index">{String(index + 1).padStart(2, "0")}</span><span className="analytics-ranked-copy"><strong title={item.label}>{item.label}</strong><small>{item.secondary}</small></span><span className="analytics-ranked-track"><i style={{ width: `${Math.max(2, item.value / maxValue * 100)}%` }} /></span><b>{item.displayValue ?? formatNumber(item.value)}</b></>;
        return onSelect ? <button key={item.key} onClick={() => onSelect(item)} type="button">{content}</button> : <div key={item.key}>{content}</div>;
      })}
    </div>
  );
}

function Histogram({ items, valueKey, scale = "linear" }: {
  items: Array<{ key: string; label: string } & Record<string, number | string>>;
  valueKey: string;
  scale?: "linear" | "log";
}) {
  useLocale();
  const values = items.map((item) => Number(item[valueKey] ?? 0));
  const maxValue = Math.max(1, ...values);
  const heightFor = (value: number) => value <= 0 ? 0 : Math.max(4, (scale === "log" ? Math.log10(value + 1) / Math.log10(maxValue + 1) : value / maxValue) * 100);
  return (
    <div className="analytics-histogram" role="img" aria-label={items.map((item) => `${item.label} ${formatNumber(Number(item[valueKey] ?? 0))}`).join("，")}>
      {items.map((item) => {
        const value = Number(item[valueKey] ?? 0);
        return <div key={item.key} title={`${item.label} · ${formatNumber(value)}`}><strong>{compactFormatter.format(value)}</strong><span><i style={{ height: `${heightFor(value)}%` }} /></span><small>{item.label}</small></div>;
      })}
    </div>
  );
}

function ReleaseHistoryChart({ points, selectedYear }: { points: Array<{ year: number; works: number }>; selectedYear: number | null }) {
  useLocale();
  if (points.length < 2) return <Empty description="发行年份数据不足" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  const width = 760;
  const height = 250;
  const padding = { left: 48, right: 18, top: 22, bottom: 34 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(1, ...points.map((point) => point.works));
  const coords = points.map((point, index) => ({ ...point, x: padding.left + index / (points.length - 1) * plotWidth, y: padding.top + (1 - point.works / maxValue) * plotHeight }));
  const linePath = coords.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${coords.at(-1)?.x.toFixed(1)},${padding.top + plotHeight} L${coords[0].x.toFixed(1)},${padding.top + plotHeight} Z`;
  const labelStep = Math.max(1, Math.ceil(points.length / 8));
  const peakPoint = coords.reduce((peak, point) => point.works > peak.works ? point : peak, coords[0]);
  const focusYear = selectedYear ?? peakPoint.year;
  return (
    <svg className="analytics-release-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`发行年份分布，从 ${points[0].year} 年到 ${points.at(-1)?.year} 年`}>
      {[0, 0.25, 0.5, 0.75, 1].map((fraction) => { const y = padding.top + plotHeight * fraction; return <g key={fraction}><line x1={padding.left} x2={width - padding.right} y1={y} y2={y} /><text x={padding.left - 10} y={y + 4} textAnchor="end">{compactFormatter.format(Math.round(maxValue * (1 - fraction)))}</text></g>; })}
      <path className="analytics-release-area" d={areaPath} /><path className="analytics-release-line" d={linePath} />
      {coords.map((point, index) => <g key={point.year}>{(index % labelStep === 0 || index === coords.length - 1) && <text x={point.x} y={height - 10} textAnchor="middle">{point.year}</text>}<circle className={point.year === focusYear ? "is-focus" : ""} cx={point.x} cy={point.y} r={point.year === focusYear ? 5 : 2.4}><title>{point.year} 年 · {formatNumber(point.works)} {t("部")}</title></circle></g>)}
    </svg>
  );
}

function MonthlyBars({ points }: { points: Array<{ month: number; works: number }> }) {
  useLocale();
  const maxValue = Math.max(1, ...points.map((point) => point.works));
  return <div className="analytics-month-bars" role="img" aria-label={points.map((point) => `${point.month} 月 ${formatNumber(point.works)} 部`).join("，")}>{points.map((point) => <div key={point.month} title={`${point.month} 月 · ${formatNumber(point.works)} 部`}><strong>{compactFormatter.format(point.works)}</strong><span><i style={{ height: `${point.works > 0 ? Math.max(3, point.works / maxValue * 100) : 0}%` }} /></span><small>{point.month}{t("月")}</small></div>)}</div>;
}

function GrowthComboChart({ points }: { points: LibraryAnalyticsData["catalogGrowth"] }) {
  useLocale();
  if (points.length < 2) return <Empty description="当前范围暂无连续入库记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  const width = 900;
  const height = 250;
  const padding = { left: 42, right: 22, top: 18, bottom: 38 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxDaily = Math.max(1, ...points.map((point) => point.files));
  const maxCumulative = Math.max(1, ...points.map((point) => point.cumulativeFiles));
  const step = plotWidth / Math.max(1, points.length);
  const line = points.map((point, index) => { const x = padding.left + step * index + step / 2; const y = padding.top + (1 - point.cumulativeFiles / maxCumulative) * plotHeight; return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`; }).join(" ");
  const labelStep = Math.max(1, Math.ceil(points.length / 6));
  return (
    <svg className="analytics-growth-combo" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="每日新增文件柱状图和累计文件折线图">
      {[0, 0.5, 1].map((fraction) => { const y = padding.top + plotHeight * fraction; return <line key={fraction} x1={padding.left} x2={width - padding.right} y1={y} y2={y} />; })}
      {points.map((point, index) => { const barHeight = Math.max(3, Math.log10(point.files + 1) / Math.log10(maxDaily + 1) * plotHeight); const x = padding.left + step * index + step * 0.16; return <g key={point.day}><rect height={barHeight} width={Math.max(3, step * 0.68)} x={x} y={padding.top + plotHeight - barHeight}><title>{formatMonthDay(point.day)} · 新增 {formatNumber(point.files)} 文件 · 累计 {formatNumber(point.cumulativeFiles)}</title></rect>{(index % labelStep === 0 || index === points.length - 1) && <text x={x + step * 0.34} y={height - 13} textAnchor="middle">{formatMonthDay(point.day)}</text>}</g>; })}
      <path d={line} /><text className="analytics-growth-axis" x={padding.left} y={13}>每日新增 · 对数柱</text><text className="analytics-growth-axis is-right" x={width - padding.right} y={13} textAnchor="end">累计 {formatNumber(maxCumulative)} {t("文件")}</text>
    </svg>
  );
}

function YearMonthHeatmap({ points, onSelectYear, mode }: { points: LibraryAnalyticsData["releaseHeatmap"]; onSelectYear: (year: number) => void; mode: TimeHeatMode }) {
  useLocale();
  const years = [...new Set(points.map((point) => point.year))].sort((a, b) => b - a);
  const valueMap = new Map(points.map((point) => [`${point.year}-${point.month}`, point.works]));
  const yearTotals = new Map(years.map((year) => [year, Array.from({ length: 12 }, (_, index) => valueMap.get(`${year}-${index + 1}`) ?? 0).reduce((sum, value) => sum + value, 0)]));
  const visualValues = points.map((point) => mode === "share" ? point.works / Math.max(1, yearTotals.get(point.year) ?? 0) : point.works);
  const maxValue = Math.max(mode === "share" ? 0.01 : 1, ...visualValues);
  if (years.length === 0) return <Empty description="暂无年×月数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  return (
    <div className="analytics-year-month-wrap">
      <HeatLegend high={mode === "share" ? "年内高占比" : "高作品量"} label={mode === "share" ? "按单年归一" : "按全局峰值"} />
      <div className="analytics-year-month-head"><span>年份</span>{Array.from({ length: 12 }, (_, index) => <span key={index}>{index + 1}{t("月")}</span>)}</div>
      <div className="analytics-year-month-body">
        {years.map((year) => <div className="analytics-year-month-row" key={year}><button onClick={() => onSelectYear(year)} type="button">{year}</button>{Array.from({ length: 12 }, (_, index) => { const month = index + 1; const value = valueMap.get(`${year}-${month}`) ?? 0; const share = value / Math.max(1, yearTotals.get(year) ?? 0); const visualValue = mode === "share" ? share : value; return <button aria-label={`${year} 年 ${month} 月 ${value} 部，占该年 ${formatPercent(share)}`} key={month} onClick={() => onSelectYear(year)} style={heatStyle(visualValue, maxValue)} title={`${year} 年 ${month} 月 · ${formatNumber(value)} 部 · 年内占比 ${formatPercent(share)}`} type="button"><span>{value > 0 ? mode === "share" ? formatPercent(share, 0) : compactFormatter.format(value) : ""}</span></button>; })}</div>)}
      </div>
    </div>
  );
}

function CategoryStackedChart({ points, mode }: { points: LibraryAnalyticsData["categoryYearTrend"]; mode: TimeMixMode }) {
  useLocale();
  const years = [...new Set(points.map((point) => point.year))].sort((a, b) => a - b).slice(-14);
  const categories = [...new Set(points.map((point) => point.category))];
  const values = new Map(points.map((point) => [`${point.year}-${point.category}`, point.works]));
  const totals = new Map(years.map((year) => [year, categories.reduce((sum, category) => sum + (values.get(`${year}-${category}`) ?? 0), 0)]));
  const maxValue = Math.max(1, ...totals.values());
  return (
    <div className="analytics-stacked-chart">
      <div className="analytics-stacked-legend">{categories.map((category, index) => <span key={category}><i style={{ backgroundColor: chartColors[index % chartColors.length] }} />{category}</span>)}</div>
      <div className={`analytics-stacked-bars${mode === "share" ? " is-share" : ""}`} role="img" aria-label={`近十四个发行年份按馆藏类别${mode === "share" ? "百分比" : "绝对规模"}堆叠分布`}>
        {years.map((year) => { const total = totals.get(year) ?? 0; return <div key={year} title={`${year} · ${formatNumber(total)} 部`}><strong>{compactFormatter.format(total)}</strong><span style={{ height: `${mode === "share" ? total > 0 ? 100 : 0 : Math.max(4, total / maxValue * 100)}%` }}>{categories.map((category, index) => { const value = values.get(`${year}-${category}`) ?? 0; return value > 0 ? <i key={category} style={{ backgroundColor: chartColors[index % chartColors.length], flexGrow: value }} title={`${category} · ${formatNumber(value)} 部 · ${formatPercent(value / Math.max(1, total))}`} /> : null; })}</span><small>{year}</small></div>; })}
      </div>
    </div>
  );
}

function YearGrowthBars({ items }: { items: LibraryAnalyticsYearMetric[] }) {
  useLocale();
  const visible = items
    .filter((item) => item.workGrowthRate !== null)
    .sort((a, b) => a.year - b.year)
    .slice(-14);
  if (visible.length < 3) return <Empty description="同比年份不足" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  const width = 860;
  const height = 292;
  const padding = { left: 34, right: 18, top: 24, bottom: 40 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const zeroY = padding.top + plotHeight / 2;
  const maxAbsolute = Math.max(0.05, ...visible.map((item) => Math.abs(item.workGrowthRate ?? 0)));
  const step = plotWidth / visible.length;
  return (
    <svg className="analytics-yoy-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="近十四个发行年份作品数量同比变化">
      <line className="analytics-yoy-zero" x1={padding.left} x2={width - padding.right} y1={zeroY} y2={zeroY} />
      {[0.5, 1].map((fraction) => <g key={fraction}><line x1={padding.left} x2={width - padding.right} y1={zeroY - plotHeight / 2 * fraction} y2={zeroY - plotHeight / 2 * fraction} /><line x1={padding.left} x2={width - padding.right} y1={zeroY + plotHeight / 2 * fraction} y2={zeroY + plotHeight / 2 * fraction} /></g>)}
      {visible.map((item, index) => {
        const value = item.workGrowthRate ?? 0;
        const barHeight = Math.max(2, Math.abs(value) / maxAbsolute * (plotHeight / 2 - 8));
        const x = padding.left + index * step + step * 0.18;
        const y = value >= 0 ? zeroY - barHeight : zeroY;
        return <g className={value < 0 ? "is-negative" : "is-positive"} key={item.year}><rect height={barHeight} width={Math.max(5, step * 0.64)} x={x} y={y}><title>{item.year} 年 · {formatSignedPercent(value)} · {formatNumber(item.works)} {t("部")}</title></rect><text className="analytics-yoy-value" x={x + step * 0.32} y={value >= 0 ? y - 5 : y + barHeight + 11} textAnchor="middle">{formatSignedPercent(value)}</text><text x={x + step * 0.32} y={height - 12} textAnchor="middle">{item.year}</text></g>;
      })}
    </svg>
  );
}

function StorageTreemap({ items }: { items: LibraryAnalyticsData["sourceProfiles"] }) {
  useLocale();
  const total = items.reduce((sum, item) => sum + item.bytes, 0);
  if (total <= 0) return <Empty description="暂无来源存储数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  return (
    <div className="analytics-treemap" role="img" aria-label={items.map((item) => `${item.label} ${formatBytes(item.bytes)}`).join("，")}>
      {items.map((item, index) => <div key={item.key} style={{ flexGrow: item.bytes, "--treemap-color": chartColors[index % chartColors.length] } as CSSProperties} title={`${item.label} · ${formatBytes(item.bytes)} · ${formatNumber(item.files)} 文件`}><strong>{item.label}</strong><b>{formatBytes(item.bytes)}</b><small>{formatPercent(item.bytes / total)} · {formatNumber(item.files)} {t("文件")}</small><em>风险 {formatPercent(item.riskFiles / Math.max(1, item.files))}</em></div>)}
    </div>
  );
}

function ParetoChart({ items, totalAssignments }: { items: LibraryAnalyticsFacetItem[]; totalAssignments: number }) {
  useLocale();
  const visible = items.slice(0, 16);
  if (visible.length < 2) return <Empty description="当前维度不足以生成集中度图" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  const width = 900;
  const height = 280;
  const padding = { left: 42, right: 32, top: 20, bottom: 62 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(1, ...visible.map((item) => item.works));
  const step = plotWidth / visible.length;
  let running = 0;
  const cumulative = visible.map((item, index) => { running += item.works; return { x: padding.left + step * index + step / 2, y: padding.top + (1 - Math.min(1, running / Math.max(1, totalAssignments))) * plotHeight }; });
  const line = cumulative.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const eightyY = padding.top + plotHeight * 0.2;
  return (
    <svg className="analytics-pareto" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="实体作品数排行与累计关系占比">
      <line className="analytics-pareto-benchmark" x1={padding.left} x2={width - padding.right} y1={eightyY} y2={eightyY} /><text className="analytics-pareto-benchmark-label" x={width - padding.right} y={eightyY - 5} textAnchor="end">80% 关系基准</text>
      {visible.map((item, index) => { const barHeight = item.works / maxValue * plotHeight; const x = padding.left + step * index + step * 0.16; return <g key={item.value}><rect height={barHeight} width={Math.max(4, step * 0.68)} x={x} y={padding.top + plotHeight - barHeight}><title>{item.label} · {formatNumber(item.works)} {t("部")}</title></rect><text className="analytics-pareto-label" transform={`translate(${x + step * 0.34},${height - 48}) rotate(-38)`} textAnchor="end">{item.label}</text></g>; })}
      <path className="analytics-pareto-line" d={line} />{cumulative.map((point, index) => <circle cx={point.x} cy={point.y} key={visible[index].value} r="2.8" />)}
    </svg>
  );
}

function ConcentrationProfile({ items }: { items: LibraryAnalyticsData["dataQuality"]["facetConcentration"] }) {
  useLocale();
  if (items.length === 0) return <Empty description="暂无内容集中度数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  return (
    <div className="analytics-concentration-profile">
      <header><span><i className="is-top" />Top 10 关系占比</span><span><i className="is-singleton" />单次出现实体占比</span></header>
      {[...items].sort((left, right) => right.topTenShare - left.topTenShare).map((item) => {
        const singletonShare = item.singletonEntities / Math.max(1, item.entities);
        const interpretation = item.hhi < 0.01 ? "高度分散" : item.hhi < 0.05 ? "轻度集中" : "集中";
        return (
          <div key={item.type}>
            <span><strong>{item.label}</strong><small>{formatNumber(item.entities)} 个实体 · {formatNumber(item.assignments)} 条关系</small></span>
            <b className="is-top"><i style={{ width: `${Math.max(item.topTenShare > 0 ? 2 : 0, item.topTenShare * 100)}%` }} /></b>
            <em>{formatPercent(item.topTenShare)}</em>
            <b className="is-singleton"><i style={{ width: `${Math.max(singletonShare > 0 ? 2 : 0, singletonShare * 100)}%` }} /></b>
            <em>{formatPercent(singletonShare)}</em>
            <span className="analytics-concentration-note"><strong>{interpretation}</strong><small>HHI {item.hhi.toFixed(4)}</small></span>
          </div>
        );
      })}
    </div>
  );
}

function ContentPairRanking({ matrix }: { matrix: LibraryAnalyticsData["contentMatrix"] }) {
  useLocale();
  const rowLabels = new Map(matrix.rows.map((row) => [row.key, row.label]));
  const columnLabels = new Map(matrix.columns.map((column) => [column.key, column.label]));
  const items: RankedItem[] = [...matrix.cells]
    .sort((left, right) => right.works - left.works)
    .slice(0, 12)
    .map((cell) => ({
      key: `${cell.rowKey}::${cell.columnKey}`,
      label: `${rowLabels.get(cell.rowKey) ?? cell.rowKey} × ${columnLabels.get(cell.columnKey) ?? cell.columnKey}`,
      value: cell.works,
      displayValue: t("{{p0}} 部", { p0: formatNumber(cell.works) }),
      secondary: "共同作品数，不代表相对偏好提升"
    }));
  return <RankedBars items={items} />;
}

function BubbleScatter({ items }: { items: LibraryAnalyticsFacetItem[] }) {
  useLocale();
  const points = items.filter((item) => item.scoredWorks >= 5 && item.averageScore > 0 && item.averageRuntimeMinutes > 0).slice(0, 24);
  if (points.length < 5) return <Empty description="评分样本不足，无法形成可靠散点" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  const width = 760;
  const height = 300;
  const padding = { left: 54, right: 24, top: 26, bottom: 44 };
  const minX = Math.min(...points.map((item) => item.averageRuntimeMinutes));
  const maxX = Math.max(...points.map((item) => item.averageRuntimeMinutes));
  const minY = Math.min(...points.map((item) => item.averageScore));
  const maxY = Math.max(...points.map((item) => item.averageScore));
  const maxWorks = Math.max(1, ...points.map((item) => item.works));
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  return (
    <svg className="analytics-scatter" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="厂商平均片长与评分关系散点图">
      {[0, 0.5, 1].map((fraction) => <line key={`h-${fraction}`} x1={padding.left} x2={width - padding.right} y1={padding.top + plotHeight * fraction} y2={padding.top + plotHeight * fraction} />)}{[0, 0.5, 1].map((fraction) => <line key={`v-${fraction}`} x1={padding.left + plotWidth * fraction} x2={padding.left + plotWidth * fraction} y1={padding.top} y2={padding.top + plotHeight} />)}
      {points.map((item, index) => { const x = padding.left + (item.averageRuntimeMinutes - minX) / Math.max(1, maxX - minX) * plotWidth; const y = padding.top + (1 - (item.averageScore - minY) / Math.max(0.01, maxY - minY)) * plotHeight; const radius = 4 + Math.sqrt(item.works / maxWorks) * 12; return <g key={item.value}><circle cx={x} cy={y} r={radius}><title>{item.label} · {formatNumber(item.works)} 部 · 均分 {item.averageScore.toFixed(2)}（{formatNumber(item.scoredWorks)} 个评分）· 均长 {formatMinutes(item.averageRuntimeMinutes)}</title></circle>{index < 6 && <text x={x + radius + 4} y={y + 3}>{item.label}</text>}</g>; })}
      <text className="analytics-axis-title" x={padding.left + plotWidth / 2} y={height - 9} textAnchor="middle">平均片长（分钟）</text><text className="analytics-axis-title" transform={`translate(13,${padding.top + plotHeight / 2}) rotate(-90)`} textAnchor="middle">有效均分</text>
    </svg>
  );
}

function ActorLongTailChart({ items }: { items: LibraryAnalyticsData["actorAnalytics"]["workBands"] }) {
  useLocale();
  if (items.length === 0) return <Empty description="暂无演员作品分布" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  return (
    <div className="analytics-actor-tail" role="img" aria-label="演员作品数长尾分布，蓝色为演员数量占比，橙色为关系数量占比">
      <header><span><i className="is-actors" />演员数量占比</span><span><i className="is-assignments" />作品关系占比</span></header>
      {items.map((item) => (
        <div key={item.key} title={`${item.label} · ${formatNumber(item.actors)} 位演员 · ${formatNumber(item.assignments)} 条作品关系`}>
          <strong>{item.label}</strong>
          <span className="analytics-actor-tail-bars">
            <b><i className="is-actors" style={{ width: `${Math.max(item.actors > 0 ? 2 : 0, item.actorShare * 100)}%` }} /></b>
            <b><i className="is-assignments" style={{ width: `${Math.max(item.assignments > 0 ? 2 : 0, item.assignmentShare * 100)}%` }} /></b>
          </span>
          <em><b>{formatNumber(item.actors)}</b><small>{formatPercent(item.actorShare)}</small></em>
          <em><b>{formatNumber(item.assignments)}</b><small>{formatPercent(item.assignmentShare)}</small></em>
        </div>
      ))}
    </div>
  );
}

function ActorGenreAffinityMatrix({ data, mode, selectedActor, onSelectActor, onSelectCell }: {
  data: LibraryAnalyticsData["actorAnalytics"]["genreAffinity"];
  mode: ActorMatrixMode;
  selectedActor: string;
  onSelectActor: (value: string) => void;
  onSelectCell: (
    actor: LibraryActorSummary,
    genre: LibraryAnalyticsData["actorAnalytics"]["genreAffinity"]["genres"][number],
    cell: LibraryAnalyticsData["actorAnalytics"]["genreAffinity"]["cells"][number]
  ) => void;
}) {
  useLocale();
  const [actorLimit, setActorLimit] = useState(24);
  const [genreLimit, setGenreLimit] = useState(18);
  const [genreGroup, setGenreGroup] = useState<GenreGroupFilter>("content");
  const [actorSearch, setActorSearch] = useState("");
  const [genreSearch, setGenreSearch] = useState("");
  const [minimumWorks, setMinimumWorks] = useState(3);
  const [displayMode, setDisplayMode] = useState<MatrixDisplayMode>("dots");
  const [expanded, setExpanded] = useState(false);
  const [hoveredActor, setHoveredActor] = useState("");
  const [hoveredGenre, setHoveredGenre] = useState("");
  if (data.actors.length === 0 || data.genres.length === 0) return <Empty description="暂无演员与题材交叉数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  const cellMap = new Map(data.cells.map((cell) => [`${cell.actorValue}::${cell.genreValue}`, cell]));
  const normalizedActorSearch = actorSearch.trim().toLocaleLowerCase();
  const normalizedGenreSearch = genreSearch.trim().toLocaleLowerCase();
  const actors = data.actors
    .filter((actor) => !normalizedActorSearch || `${actor.label} ${actor.value} ${(actor.aliases ?? []).join(" ")}`.toLocaleLowerCase().includes(normalizedActorSearch))
    .slice(0, actorLimit);
  const genres = data.genres
    .filter((genre) => {
      const groupMatch = genreGroup === "all"
        || (genreGroup === "content" && ["theme", "persona"].includes(genre.group))
        || genreGroup === genre.group
        || (genreGroup === "production" && ["format", "distribution"].includes(genre.group));
      const searchMatch = !normalizedGenreSearch || `${genre.label} ${genre.value} ${genre.aliases.join(" ")}`.toLocaleLowerCase().includes(normalizedGenreSearch);
      return groupMatch && searchMatch;
    })
    .slice(0, genreLimit);
  const visibleCells = data.cells.filter((cell) => actors.some((actor) => actor.value === cell.actorValue) && genres.some((genre) => genre.value === cell.genreValue));
  const maxValue = Math.max(1, ...visibleCells.map((cell) => mode === "works" ? cell.works : mode === "share" ? cell.actorShare : Math.max(cell.smoothedLift, 1 / Math.max(0.01, cell.smoothedLift))));
  const maxWorks = Math.max(1, ...visibleCells.map((cell) => cell.works));
  const displayValue = (works: number, share: number, smoothedLift: number) => {
    if (works === 0) return "—";
    if (mode === "works") return formatNumber(works);
    if (mode === "share") return formatPercent(share, 0);
    return smoothedLift > 0 && smoothedLift < 0.05 ? "<0.1×" : `${smoothedLift.toFixed(1)}×`;
  };
  const cellStyle = (works: number, share: number, smoothedLift: number): CSSProperties => {
    if (works === 0) return {};
    if (mode === "lift") {
      const distance = Math.min(1, Math.abs(Math.log2(Math.max(0.25, smoothedLift))) / 2);
      return { backgroundColor: smoothedLift >= 1 ? `rgb(255 153 0 / ${0.1 + distance * 0.5})` : `rgb(79 140 255 / ${0.1 + distance * 0.5})` };
    }
    const raw = mode === "works" ? works : share;
    const strength = Math.max(0.06, raw / maxValue);
    return { backgroundColor: `rgb(255 153 0 / ${0.06 + Math.min(1, strength) * 0.54})` };
  };
  return (
    <div className={`analytics-matrix-workbench ${expanded ? "is-expanded" : ""}`}>
      <div className="analytics-matrix-controls">
        <Input allowClear onChange={(event) => setActorSearch(event.target.value)} placeholder="搜索演员" prefix={<Search size={12} />} value={actorSearch} />
        <Input allowClear onChange={(event) => setGenreSearch(event.target.value)} placeholder="搜索题材" prefix={<Tags size={12} />} value={genreSearch} />
        <Select onChange={(value) => setGenreGroup(value as GenreGroupFilter)} options={[
          { label: "内容题材", value: "content" }, { label: "全部题材", value: "all" }, { label: "情境主题", value: "theme" },
          { label: "人物属性", value: "persona" }, { label: "制作/发行", value: "production" }
        ]} value={genreGroup} />
        <Select onChange={(value) => setMinimumWorks(Number(value))} options={[{ label: "空心阈值 1 部", value: 1 }, { label: "空心阈值 3 部", value: 3 }, { label: "空心阈值 5 部", value: 5 }]} value={minimumWorks} />
        <div className="analytics-matrix-density"><span>{t("演员")}</span><Segmented onChange={(value) => setActorLimit(Number(value))} options={[24, 36, 48]} size="small" value={actorLimit} /></div>
        <div className="analytics-matrix-density"><span>{t("题材")}</span><Segmented onChange={(value) => setGenreLimit(Number(value))} options={[18, 24, 30, 36]} size="small" value={genreLimit} /></div>
        <Button aria-label={expanded ? "退出矩阵全屏" : "全屏查看矩阵"} icon={<Maximize2 size={14} />} onClick={() => setExpanded((value) => !value)} />
      </div>
      <div className="analytics-matrix-meta">
        <span><Rows3 size={12} />当前展示 {actors.length} 位演员 × {genres.length} 个题材</span>
        <div className="analytics-matrix-meta-actions"><span>规范化实体 · 去重作品 · 低样本保留但使用空心标识</span><Segmented<MatrixDisplayMode> onChange={setDisplayMode} options={[{ label: "点阵图", value: "dots" }, { label: "精确表", value: "table" }]} size="small" value={displayMode} /></div>
      </div>
      <div className="analytics-matrix-scroll analytics-actor-matrix-scroll">
        {displayMode === "dots" ? <MatrixDotLegend minimumValue={minimumWorks} mode={mode === "works" ? "volume" : mode} /> : <HeatLegend high={mode === "lift" ? "稳定正向" : mode === "share" ? "高占比" : "高作品量"} label={mode === "lift" ? "蓝：弱于全局 · 橙：强于全局 · 已进行小样本收缩" : mode === "share" ? "演员内题材占比" : "演员题材共现"} low={mode === "lift" ? "稳定负向" : "低"} tone={mode === "lift" ? "diverging" : "orange"} />}
        <table className={`analytics-matrix-table analytics-actor-matrix ${displayMode === "dots" ? "analytics-dot-matrix" : ""}`} style={{ minWidth: `${150 + genres.length * (displayMode === "dots" ? 60 : 82)}px` }}>
          <thead><tr><th>演员 \ 题材</th>{genres.map((genre) => <th className={hoveredGenre === genre.value ? "is-hovered" : ""} key={genre.value} title={`${genre.label} · 全局 ${formatPercent(genre.globalShare)} · ${genre.works} 部`}><span>{genre.label}</span></th>)}</tr></thead>
          <tbody>{actors.map((actor) => (
          <tr className={`${actor.value === selectedActor ? "is-selected" : ""} ${hoveredActor === actor.value ? "is-hovered" : ""}`} key={actor.value}>
            <th><button onClick={() => onSelectActor(actor.value)} title={`${actor.label} · ${formatNumber(actor.works)} 部`} type="button">{actor.label}</button></th>
            {genres.map((genre) => {
              const cell = cellMap.get(`${actor.value}::${genre.value}`);
              const works = cell?.works ?? 0;
              const share = cell?.actorShare ?? 0;
              const lift = cell?.lift ?? 0;
              const smoothedLift = cell?.smoothedLift ?? 0;
              const lowConfidence = works > 0 && (works < minimumWorks || !cell?.stable);
              const description = `${actor.label} × ${genre.label} · ${formatNumber(works)} 部 · 演员内占比 ${formatPercent(share)} · 原始提升 ${lift.toFixed(2)}× · 稳健提升 ${smoothedLift.toFixed(2)}× · 可信度 ${formatPercent(cell?.confidence ?? 0)}${lowConfidence ? " · 低样本或低置信" : ""}`;
              const interaction = {
                onClick: () => { if (!cell) return; onSelectActor(actor.value); onSelectCell(actor, genre, cell); },
                disabled: !cell
              };
              return displayMode === "dots" ? (
                <td className={`${hoveredGenre === genre.value ? "is-hovered" : ""} ${lowConfidence ? "is-low-confidence" : ""}`} key={genre.value} onMouseEnter={() => { setHoveredActor(actor.value); setHoveredGenre(genre.value); }} onMouseLeave={() => { setHoveredActor(""); setHoveredGenre(""); }} title={description}>
                  <button aria-label={description} {...interaction} type="button">{cell ? <span aria-hidden="true" className="analytics-matrix-dot" style={matrixDotStyle({ value: works, maxValue: maxWorks, lift: smoothedLift, confidence: cell.confidence, mode: mode === "works" ? "volume" : mode })} /> : <span aria-hidden="true" className="analytics-dot-empty">·</span>}<span className="analytics-sr-only">{description}</span></button>
                </td>
              ) : (
                <td className={`${hoveredGenre === genre.value ? "is-hovered" : ""} ${lowConfidence ? "is-muted" : ""}`} key={genre.value} onMouseEnter={() => { setHoveredActor(actor.value); setHoveredGenre(genre.value); }} onMouseLeave={() => { setHoveredActor(""); setHoveredGenre(""); }} style={lowConfidence ? {} : cellStyle(works, share, smoothedLift)} title={description}><button aria-label={description} {...interaction} type="button">{displayValue(works, share, smoothedLift)}</button></td>
              );
            })}
          </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

function MatrixEvidenceDrawer({ selection, data, year, onClose, onOpenEntity, onOpenMedia }: {
  selection: SelectedActorGenreCell | null;
  data: LibraryAnalyticsData["actorAnalytics"]["genreAffinity"];
  year: number | null;
  onClose: () => void;
  onOpenEntity: (entity: ActiveEntity) => void;
  onOpenMedia: (item: MediaItem, queue?: MediaItem[]) => void;
}) {
  useLocale();
  const [comparisonActors, setComparisonActors] = useState<string[]>([]);
  useEffect(() => setComparisonActors([]), [selection?.actor.value, selection?.genre.value]);
  const evidenceQuery = useQuery({
    queryKey: ["library-analytics-cell-evidence", selection?.actor.value ?? "", selection?.genre.value ?? "", year ?? "all"],
    enabled: Boolean(selection),
    queryFn: () => {
      if (!selection) throw new Error("未选择矩阵单元格");
      const query: MediaQuery = {
        q: "", letter: "ALL", extension: "ALL", prefix: "ALL", category: "ALL", bucket: "ALL", source: "ALL", tag: "ALL",
        actor: selection.actor.aliases?.length ? selection.actor.aliases : [selection.actor.value],
        genre: selection.genre.aliases.length ? selection.genre.aliases : [selection.genre.value],
        director: [], maker: [], label: [], metadataSeries: [], mediaType: "video", favoriteOnly: false,
        groupVersions: true, page: 1, pageSize: 12, sort: "name", direction: "asc"
      };
      return fetchMedia(query);
    },
    staleTime: 10 * 60_000
  });
  const lineageQuery = useQuery({
    queryKey: ["library-analytics-cell-lineage", selection?.actor.value ?? "", selection?.genre.value ?? "", year ?? "all"],
    enabled: Boolean(selection),
    queryFn: ({ signal }) => {
      if (!selection) throw new Error("未选择矩阵单元格");
      return fetchLibraryAnalyticsMatrixEvidence({ actor: selection.actor.value, genre: selection.genre.value, year, limit: 100 }, signal);
    },
    staleTime: 10 * 60_000
  });
  const evidenceDates = useLocalizedMemo(() => new Map((lineageQuery.data?.items ?? []).map((item) => [item.normalizedCode, item.releaseDate])), [lineageQuery.data?.items]);
  const visibleEvidenceItems = useLocalizedMemo(() => {
    const items = evidenceQuery.data?.items ?? [];
    if (year === null || !lineageQuery.data) return items;
    const matchingCodes = new Set(lineageQuery.data.items.map((item) => item.normalizedCode));
    return items.filter((item) => matchingCodes.has(item.normalizedCode));
  }, [evidenceQuery.data?.items, lineageQuery.data, year]);
  const comparisonRows = useLocalizedMemo(() => {
    if (!selection) return [];
    const actorValues = [selection.actor.value, ...comparisonActors];
    return actorValues.map((actorValue) => {
      const actor = data.actors.find((item) => item.value === actorValue);
      const cell = data.cells.find((item) => item.actorValue === actorValue && item.genreValue === selection.genre.value);
      return actor ? { actor, cell } : null;
    }).filter((item): item is { actor: LibraryActorSummary; cell: LibraryAnalyticsData["actorAnalytics"]["genreAffinity"]["cells"][number] | undefined } => Boolean(item));
  }, [comparisonActors, data.actors, data.cells, selection]);
  const maxComparisonShare = Math.max(0.01, ...comparisonRows.map((item) => item.cell?.actorShare ?? 0));

  return (
    <Drawer className="analytics-evidence-drawer" destroyOnHidden onClose={onClose} open={Boolean(selection)} placement="right" size={520} title={selection ? `${selection.actor.label} × ${selection.genre.label}` : "矩阵证据"}>
      {selection && (
        <div className="analytics-evidence-content">
          <section className="analytics-evidence-summary">
            <div><small>共同作品</small><strong>{formatNumber(selection.cell.works)}</strong><span>按唯一番号去重</span></div>
            <div><small>演员内占比</small><strong>{formatPercent(selection.cell.actorShare)}</strong><span>全库基准 {formatPercent(selection.cell.globalShare)}</span></div>
            <div><small>稳健提升</small><strong>{selection.cell.smoothedLift.toFixed(2)}×</strong><span>原始 {selection.cell.lift.toFixed(2)}×</span></div>
            <div><small>可信度</small><strong>{formatPercent(selection.cell.confidence)}</strong><span>期望 {selection.cell.expectedWorks.toFixed(1)} {t("部")}</span></div>
          </section>
          <section className="analytics-evidence-actions">
            <Button icon={<UserRound size={14} />} onClick={() => onOpenEntity({ type: "actor", value: selection.actor.value, label: selection.actor.label })}>{t("演员专题")}</Button>
            <Button icon={<Tags size={14} />} onClick={() => onOpenEntity({ type: "genre", value: selection.genre.value, label: selection.genre.label })}>{t("题材专题")}</Button>
          </section>
          <section className="analytics-evidence-periods">
            <header><strong>时间变化</strong><small>{lineageQuery.data?.previousWindow ?? "上一三年"} 对比 {lineageQuery.data?.recentWindow ?? "最近三年"}</small></header>
            <div><span>上一周期</span><b><i style={{ width: `${Math.min(100, (lineageQuery.data?.previousWorks ?? selection.cell.previousWorks) / Math.max(1, lineageQuery.data?.recentWorks ?? selection.cell.recentWorks, lineageQuery.data?.previousWorks ?? selection.cell.previousWorks) * 100)}%` }} /></b><em>{lineageQuery.data?.previousWorks ?? selection.cell.previousWorks} {t("部")}</em></div>
            <div><span>最近周期</span><b><i className="is-recent" style={{ width: `${Math.min(100, (lineageQuery.data?.recentWorks ?? selection.cell.recentWorks) / Math.max(1, lineageQuery.data?.recentWorks ?? selection.cell.recentWorks, lineageQuery.data?.previousWorks ?? selection.cell.previousWorks) * 100)}%` }} /></b><em>{lineageQuery.data?.recentWorks ?? selection.cell.recentWorks} {t("部")}</em></div>
            {lineageQuery.data && <small className="analytics-evidence-lineage">发行日期覆盖 {formatNumber(lineageQuery.data.datedWorks)} / {formatNumber(lineageQuery.data.total)} 部；{formatNumber(lineageQuery.data.undatedWorks)} 部不进入时间窗口</small>}
          </section>
          <section className="analytics-evidence-comparison">
            <header><div><strong>同题材演员对比</strong><small>最多加入 4 位演员</small></div><Select allowClear mode="multiple" onChange={(values) => setComparisonActors(values.slice(0, 4))} options={data.actors.filter((actor) => actor.value !== selection.actor.value).map((actor) => ({ label: actor.label, value: actor.value }))} placeholder="加入对比演员" showSearch value={comparisonActors} /></header>
            {comparisonRows.map(({ actor, cell }) => <div key={actor.value}><span>{actor.label}</span><b><i style={{ width: `${(cell?.actorShare ?? 0) / maxComparisonShare * 100}%` }} /></b><em>{cell ? `${formatPercent(cell.actorShare)} · ${cell.smoothedLift.toFixed(1)}×` : "无样本"}</em></div>)}
          </section>
          <section className="analytics-evidence-media">
            <header><div><strong>真实作品证据</strong><small>{lineageQuery.data ? `${formatNumber(lineageQuery.data.total)} 部同口径匹配作品` : evidenceQuery.data ? `${formatNumber(evidenceQuery.data.total)} 部匹配作品` : "正在查询馆藏"}</small></div></header>
            {evidenceQuery.isLoading ? <div className="analytics-evidence-loading">正在载入作品证据…</div> : evidenceQuery.isError ? <Empty description="作品证据载入失败" image={Empty.PRESENTED_IMAGE_SIMPLE} /> : (
              <div className="analytics-evidence-media-grid">{visibleEvidenceItems.map((item) => <button key={item.id} onClick={() => onOpenMedia(item, visibleEvidenceItems)} type="button"><PosterImage alt="" loading="lazy" src={getPosterUrl(item.id)} /><span><strong>{item.normalizedCode || item.basename}</strong><small>{item.metadata?.titleZh || item.metadata?.title || item.basename}</small><em>{evidenceDates.get(item.normalizedCode) ?? item.metadata?.releaseDate ?? "发行日期未知"}</em></span></button>)}</div>
            )}
          </section>
        </div>
      )}
    </Drawer>
  );
}

function CrossAnalysisMatrixExplorer({ matrix, mode, selection, onSelect }: {
  matrix: LibraryCrossMatrix;
  mode: CrossMatrixMode;
  selection: SelectedCrossCell | null;
  onSelect: (selection: SelectedCrossCell) => void;
}) {
  useLocale();
  const [rowLimit, setRowLimit] = useState(24);
  const [columnLimit, setColumnLimit] = useState(18);
  const [rowSearch, setRowSearch] = useState("");
  const [columnSearch, setColumnSearch] = useState("");
  const [minimumValue, setMinimumValue] = useState(3);
  const [displayMode, setDisplayMode] = useState<MatrixDisplayMode>("dots");
  const rows = matrix.rows.filter((item) => !rowSearch.trim() || `${item.label} ${item.key}`.toLocaleLowerCase().includes(rowSearch.trim().toLocaleLowerCase())).slice(0, rowLimit);
  const columns = matrix.columns.filter((item) => !columnSearch.trim() || `${item.label} ${item.key}`.toLocaleLowerCase().includes(columnSearch.trim().toLocaleLowerCase())).slice(0, columnLimit);
  const cellMap = new Map(matrix.cells.map((cell) => [`${cell.rowKey}::${cell.columnKey}`, cell]));
  const visibleCells = matrix.cells.filter((cell) => rows.some((row) => row.key === cell.rowKey) && columns.some((column) => column.key === cell.columnKey));
  const maxValue = Math.max(1, ...visibleCells.map((cell) => mode === "value" ? cell.value : mode === "share" ? cell.rowShare : Math.max(cell.smoothedLift, 1 / Math.max(.01, cell.smoothedLift))));
  const maxVolume = Math.max(1, ...visibleCells.map((cell) => cell.value));
  const styleFor = (cell: LibraryCrossMatrixCell): CSSProperties => {
    if (mode === "lift") {
      const distance = Math.min(1, Math.abs(Math.log2(Math.max(.25, cell.smoothedLift))) / 2);
      return { backgroundColor: cell.smoothedLift >= 1 ? `rgb(255 153 0 / ${.1 + distance * .5})` : `rgb(79 140 255 / ${.1 + distance * .5})` };
    }
    const value = mode === "value" ? cell.value : cell.rowShare;
    return { backgroundColor: `rgb(255 153 0 / ${.08 + Math.min(1, value / maxValue) * .52})` };
  };
  const displayFor = (cell: LibraryCrossMatrixCell) => mode === "value" ? formatNumber(cell.value) : mode === "share" ? formatPercent(cell.rowShare, 0) : `${cell.smoothedLift.toFixed(1)}×`;
  return (
    <div className="analytics-cross-workbench">
      <div className="analytics-matrix-controls is-cross">
        <Input allowClear onChange={(event) => setRowSearch(event.target.value)} placeholder="搜索纵轴" prefix={<Rows3 size={12} />} value={rowSearch} />
        <Input allowClear onChange={(event) => setColumnSearch(event.target.value)} placeholder="搜索横轴" prefix={<Focus size={12} />} value={columnSearch} />
        <Select onChange={(value) => setMinimumValue(Number(value))} options={[{ label: "空心阈值 1", value: 1 }, { label: "空心阈值 3", value: 3 }, { label: "空心阈值 5", value: 5 }, { label: "空心阈值 10", value: 10 }]} value={minimumValue} />
        <div className="analytics-matrix-density"><span>纵轴</span><Segmented onChange={(value) => setRowLimit(Number(value))} options={[12, 24, 30]} size="small" value={rowLimit} /></div>
        <div className="analytics-matrix-density"><span>横轴</span><Segmented onChange={(value) => setColumnLimit(Number(value))} options={[12, 18, 30]} size="small" value={columnLimit} /></div>
        <div className="analytics-matrix-density analytics-matrix-view-mode"><span>展示</span><Segmented<MatrixDisplayMode> onChange={setDisplayMode} options={[{ label: "点阵", value: "dots" }, { label: "表格", value: "table" }]} size="small" value={displayMode} /></div>
      </div>
      <div className="analytics-matrix-scroll analytics-cross-matrix-scroll">
        {displayMode === "dots" ? <MatrixDotLegend minimumValue={minimumValue} mode={mode === "value" ? "volume" : mode} unit={matrix.grain === "files" ? t("文件") : "作品"} /> : <HeatLegend high={mode === "lift" ? "稳定正向" : "高"} label={mode === "lift" ? "已按样本量收缩的相对全库提升" : mode === "share" ? "纵轴实体内部占比" : matrix.grain === "files" ? "文件数" : "作品数"} low={mode === "lift" ? "稳定负向" : "低"} tone={mode === "lift" ? "diverging" : "orange"} />}
        <table className={`analytics-matrix-table analytics-cross-matrix ${displayMode === "dots" ? "analytics-dot-matrix" : ""}`} style={{ minWidth: `${160 + columns.length * (displayMode === "dots" ? 60 : 82)}px` }}><thead><tr><th>实体 \ 维度</th>{columns.map((column) => <th key={column.key} title={`${column.label} · ${formatNumber(column.value)} ${matrix.grain === "files" ? t("文件") : "作品"}`}><span>{column.label}</span></th>)}</tr></thead><tbody>{rows.map((row) => <tr className={selection?.matrix.id === matrix.id && selection.row.key === row.key ? "is-selected" : ""} key={row.key}><th title={`${row.label} · ${formatNumber(row.value)}`}>{row.label}</th>{columns.map((column) => {
          const cell = cellMap.get(`${row.key}::${column.key}`);
          const lowConfidence = Boolean(cell && (cell.value < minimumValue || !cell.stable));
          const focused = selection?.matrix.id === matrix.id && selection.row.key === row.key && selection.column.key === column.key;
          const description = cell ? `${row.label} × ${column.label} · ${cell.value} · 纵轴占比 ${formatPercent(cell.rowShare)} · 稳健提升 ${cell.smoothedLift.toFixed(2)}× · 可信度 ${formatPercent(cell.confidence)}${lowConfidence ? " · 低样本或低置信" : ""}` : `${row.label} × ${column.label} · 无共现`;
          return displayMode === "dots" ? <td className={`${lowConfidence ? "is-low-confidence" : ""} ${focused ? "is-focused" : ""}`} key={column.key} title={description}><button aria-label={description} disabled={!cell} onClick={() => cell && onSelect({ matrix, row, column, cell })} type="button">{cell ? <span aria-hidden="true" className="analytics-matrix-dot" style={matrixDotStyle({ value: cell.value, maxValue: maxVolume, lift: cell.smoothedLift, confidence: cell.confidence, mode: mode === "value" ? "volume" : mode })} /> : <span aria-hidden="true" className="analytics-dot-empty">·</span>}<span className="analytics-sr-only">{description}</span></button></td> : <td className={`${lowConfidence ? "is-muted" : ""} ${focused ? "is-focused" : ""}`} key={column.key} style={cell && !lowConfidence ? styleFor(cell) : {}} title={description}>{cell ? <button aria-label={description} onClick={() => onSelect({ matrix, row, column, cell })} type="button">{displayFor(cell)}</button> : "—"}</td>;
        })}</tr>)}</tbody></table>
      </div>
      {selection?.matrix.id === matrix.id && <div className="analytics-cross-focus"><span><Focus size={15} /></span><div><small>当前焦点</small><strong>{selection.row.label} × {selection.column.label}</strong><em>{formatNumber(selection.cell.value)} {matrix.grain === "files" ? t("个文件") : "部作品"} · 纵轴占比 {formatPercent(selection.cell.rowShare)} · 稳健提升 {selection.cell.smoothedLift.toFixed(2)}× · 可信度 {formatPercent(selection.cell.confidence)}</em></div></div>}
    </div>
  );
}

function ActorActivityMatrix({ data, mode, selectedActor, onSelectActor }: {
  data: LibraryAnalyticsData["actorAnalytics"]["activity"];
  mode: ActorActivityMode;
  selectedActor: string;
  onSelectActor: (value: string) => void;
}) {
  useLocale();
  if (data.actors.length === 0 || data.years.length === 0) return <Empty description="暂无可用的演员年度活跃数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  const cellMap = new Map(data.cells.map((cell) => [`${cell.actorValue}::${cell.year}`, cell]));
  const maxValue = Math.max(1, ...data.cells.map((cell) => mode === "works" ? cell.works : cell.share));
  return (
    <div className="analytics-matrix-scroll">
      <HeatLegend high={mode === "works" ? "高作品量" : "高占比"} label={mode === "works" ? "演员年度作品量" : "演员内年度占比"} tone="blue" />
      <table className="analytics-matrix-table analytics-actor-matrix analytics-actor-activity-matrix">
        <thead><tr><th>演员 \ 发行年</th>{data.years.map((year) => <th key={year}>{year}</th>)}</tr></thead>
        <tbody>{data.actors.map((actor) => (
          <tr className={actor.value === selectedActor ? "is-selected" : ""} key={actor.value}>
            <th><button onClick={() => onSelectActor(actor.value)} title={`${actor.label} · 活跃 ${formatNumber(actor.activeYears)} 个发行年`} type="button">{actor.label}</button></th>
            {data.years.map((year) => {
              const cell = cellMap.get(`${actor.value}::${year}`);
              const works = cell?.works ?? 0;
              const share = cell?.share ?? 0;
              const value = mode === "works" ? works : share;
              const strength = value > 0 ? Math.max(0.06, value / maxValue) : 0;
              return <td key={year} style={value > 0 ? { backgroundColor: `rgb(79 140 255 / ${0.07 + Math.min(1, strength) * 0.54})` } : {}} title={`${actor.label} · ${year} 年 ${formatNumber(works)} 部 · 占该演员馆藏 ${formatPercent(share)}`}><button onClick={() => onSelectActor(actor.value)} type="button">{works === 0 ? "—" : mode === "works" ? formatNumber(works) : formatPercent(share, 0)}</button></td>;
            })}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function ActorScoreScatter({ data, selectedActor, onSelectActor }: {
  data: LibraryAnalyticsData["actorAnalytics"]["score"];
  selectedActor: string;
  onSelectActor: (value: string) => void;
}) {
  useLocale();
  const points = data.points;
  if (points.length < 5) return <Empty description="至少 10 个评分样本的演员不足" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  const width = 820;
  const height = 330;
  const padding = { left: 52, right: 24, top: 26, bottom: 45 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const xValues = points.map((item) => Math.log10(Math.max(1, item.works)));
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minY = Math.floor((Math.min(data.globalAverage, ...points.map((item) => item.adjustedScore)) - 0.05) * 10) / 10;
  const maxY = Math.ceil((Math.max(data.globalAverage, ...points.map((item) => item.adjustedScore)) + 0.05) * 10) / 10;
  const maxSamples = Math.max(1, ...points.map((item) => item.scoredWorks));
  const xFor = (works: number) => padding.left + (Math.log10(Math.max(1, works)) - minX) / Math.max(0.01, maxX - minX) * plotWidth;
  const yFor = (score: number) => padding.top + (1 - (score - minY) / Math.max(0.01, maxY - minY)) * plotHeight;
  const globalY = yFor(data.globalAverage);
  return (
    <svg className="analytics-actor-score-scatter" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="演员作品规模与样本校正评分散点图">
      {[0, 0.5, 1].map((fraction) => <g key={`score-${fraction}`}><line x1={padding.left} x2={width - padding.right} y1={padding.top + plotHeight * fraction} y2={padding.top + plotHeight * fraction} /><text x={padding.left - 8} y={padding.top + plotHeight * fraction + 3} textAnchor="end">{(maxY - (maxY - minY) * fraction).toFixed(1)}</text></g>)}
      <line className="analytics-score-benchmark" x1={padding.left} x2={width - padding.right} y1={globalY} y2={globalY} /><text className="analytics-score-benchmark-label" x={width - padding.right} y={globalY - 5} textAnchor="end">JAV 全局 {data.globalAverage.toFixed(2)}</text>
      {points.map((item, index) => {
        const x = xFor(item.works);
        const y = yFor(item.adjustedScore);
        const radius = 3.5 + Math.sqrt(item.scoredWorks / maxSamples) * 9;
        const isSelected = item.value === selectedActor;
        return <g aria-label={`${item.label}，${formatNumber(item.works)} 部，校正评分 ${item.adjustedScore.toFixed(2)}`} className={isSelected ? "is-selected" : ""} key={item.value} onClick={() => onSelectActor(item.value)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelectActor(item.value); }} role="button" tabIndex={0}><circle cx={x} cy={y} r={isSelected ? radius + 2 : radius}><title>{item.label} · {formatNumber(item.works)} 部 · 原始均分 {item.averageScore.toFixed(2)} · 校正 {item.adjustedScore.toFixed(2)} · 评分 n={formatNumber(item.scoredWorks)}</title></circle>{(isSelected || index < 7) && <text x={x + radius + 4} y={y + 3}>{item.label}</text>}</g>;
      })}
      <text className="analytics-axis-title" x={padding.left + plotWidth / 2} y={height - 9} textAnchor="middle">演员作品数（对数尺度）</text><text className="analytics-axis-title" transform={`translate(13,${padding.top + plotHeight / 2}) rotate(-90)`} textAnchor="middle">样本校正评分</text>
    </svg>
  );
}

function ActorCollaborationGraph({ selectedActor, pairs, onSelectActor }: {
  selectedActor: LibraryActorSummary | undefined;
  pairs: LibraryAnalyticsData["actorAnalytics"]["collaboration"]["pairs"];
  onSelectActor: (value: string) => void;
}) {
  useLocale();
  if (!selectedActor) return <Empty description="暂无可选演员" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  const connections = pairs.filter((pair) => pair.source === selectedActor.value || pair.target === selectedActor.value).map((pair) => pair.source === selectedActor.value
    ? { value: pair.target, label: pair.targetLabel, works: pair.works }
    : { value: pair.source, label: pair.sourceLabel, works: pair.works }).sort((left, right) => right.works - left.works).slice(0, 10);
  if (connections.length === 0) return <Empty description={`${selectedActor.label} 暂无 3 部以上的稳定共演关系`} image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  const width = 820;
  const height = 350;
  const center = { x: width / 2, y: height / 2 - 5 };
  const maxWorks = Math.max(1, ...connections.map((item) => item.works));
  const nodes = connections.map((item, index) => {
    const angle = -Math.PI / 2 + index / connections.length * Math.PI * 2;
    return { ...item, x: center.x + Math.cos(angle) * 285, y: center.y + Math.sin(angle) * 125 };
  });
  return (
    <div className="analytics-actor-network">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${selectedActor.label} 的稳定共演关系网络`}>
        {nodes.map((node) => <line key={`edge-${node.value}`} style={{ strokeWidth: 1 + node.works / maxWorks * 5 }} x1={center.x} x2={node.x} y1={center.y} y2={node.y}><title>{selectedActor.label} × ${node.label} · 共演 ${formatNumber(node.works)} {t("部")}</title></line>)}
        <g className="is-center"><circle cx={center.x} cy={center.y} r="28" /><text x={center.x} y={center.y + 4} textAnchor="middle">{selectedActor.label.slice(0, 8)}</text></g>
        {nodes.map((node) => <g className="is-node" key={node.value} onClick={() => onSelectActor(node.value)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelectActor(node.value); }} role="button" tabIndex={0}><circle cx={node.x} cy={node.y} r={9 + node.works / maxWorks * 9} /><text x={node.x} y={node.y + (node.y < center.y ? -18 : 25)} textAnchor="middle">{node.label.slice(0, 9)}</text><title>{node.label} · 共演 {formatNumber(node.works)} {t("部")}</title></g>)}
      </svg>
      <div className="analytics-actor-network-rank">{connections.slice(0, 6).map((item, index) => <button key={item.value} onClick={() => onSelectActor(item.value)} type="button"><span>{String(index + 1).padStart(2, "0")}</span><strong>{item.label}</strong><em>{formatNumber(item.works)} {t("部")}</em></button>)}</div>
    </div>
  );
}

function ActorProfileCompleteness({ items }: { items: LibraryAnalyticsData["actorAnalytics"]["profileCompleteness"] }) {
  useLocale();
  if (items.length === 0) return <Empty description="暂无演员档案覆盖数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  return <div className="analytics-actor-profile-bars">{items.map((item) => <div key={item.key}><span><strong>{item.label}</strong><small>{formatNumber(item.value)} / {formatNumber(item.total)}</small></span><b><i style={{ width: `${Math.max(item.value > 0 ? 2 : 0, item.rate * 100)}%` }} /></b><em>{formatPercent(item.rate)}</em></div>)}</div>;
}

function ActorCoverageBars({ data, mode }: {
  data: LibraryAnalyticsData["actorAnalytics"];
  mode: ActorCoverageMode;
}) {
  useLocale();
  const items = mode === "year"
    ? data.coverageByYear.slice(-14).reverse().map((item) => ({ key: item.year, label: item.year === "undated" ? "发行日缺失" : `${item.year} 年`, ...item }))
    : data.coverageByProvider.map((item) => ({ ...item }));
  if (items.length === 0) return <Empty description="暂无覆盖诊断数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  return (
    <div className="analytics-actor-coverage-bars">
      <header><span>0</span><span>演员覆盖率</span><span>100%</span></header>
      {items.map((item) => <div key={item.key}><span><strong>{item.label}</strong><small>{formatNumber(item.actorWorks)} / {formatNumber(item.works)} {t("部")}</small></span><b><i style={{ width: `${item.rate * 100}%` }} /><em /></b><strong>{formatPercent(item.rate)}</strong></div>)}
    </div>
  );
}

function DurationBoxPlot({ items }: { items: LibraryAnalyticsData["technical"]["durationBoxPlots"] }) {
  useLocale();
  if (items.length === 0) return <Empty description="暂无厂商片长分位数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  const width = 820;
  const rowHeight = 40;
  const height = items.length * rowHeight + 50;
  const padding = { left: 120, right: 45, top: 16, bottom: 32 };
  const plotWidth = width - padding.left - padding.right;
  const domainMax = Math.max(1, ...items.map((item) => Math.min(item.maximum, item.q3 + Math.max(15, (item.q3 - item.q1) * 1.5))));
  const x = (value: number) => padding.left + Math.min(domainMax, Math.max(0, value)) / domainMax * plotWidth;
  return (
    <svg className="analytics-boxplot" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="头部厂商片长箱线图">
      {[0, 0.25, 0.5, 0.75, 1].map((fraction) => <g key={fraction}><line x1={padding.left + plotWidth * fraction} x2={padding.left + plotWidth * fraction} y1={padding.top} y2={height - padding.bottom} /><text x={padding.left + plotWidth * fraction} y={height - 9} textAnchor="middle">{Math.round(domainMax * fraction)}分</text></g>)}
      {items.map((item, index) => { const y = padding.top + index * rowHeight + rowHeight / 2; const whiskerMaximum = Math.min(item.maximum, item.q3 + Math.max(15, (item.q3 - item.q1) * 1.5)); return <g key={item.key}><text className="analytics-boxplot-label" x={padding.left - 12} y={y + 4} textAnchor="end">{item.label}</text><line className="analytics-boxplot-whisker" x1={x(item.minimum)} x2={x(whiskerMaximum)} y1={y} y2={y} /><line className="analytics-boxplot-cap" x1={x(item.minimum)} x2={x(item.minimum)} y1={y - 6} y2={y + 6} /><line className="analytics-boxplot-cap" x1={x(whiskerMaximum)} x2={x(whiskerMaximum)} y1={y - 6} y2={y + 6} /><rect className="analytics-boxplot-box" height="18" width={Math.max(2, x(item.q3) - x(item.q1))} x={x(item.q1)} y={y - 9}><title>{item.label} · P25 {Math.round(item.q1)} 分 · 中位 {Math.round(item.median)} 分 · P75 {Math.round(item.q3)} 分 · 样本 {item.sampleSize}</title></rect><line className="analytics-boxplot-median" x1={x(item.median)} x2={x(item.median)} y1={y - 9} y2={y + 9} /><text className="analytics-boxplot-value" x={x(item.q3) + 5} y={y + 4}>{Math.round(item.median)}</text></g>; })}
    </svg>
  );
}

function CoverageRadar({ items }: { items: LibraryAnalyticsData["dataQuality"]["coverage"] }) {
  useLocale();
  const visible = items.slice(0, 10);
  if (visible.length < 3) return <Empty description="覆盖维度不足" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  const size = 340;
  const center = size / 2;
  const radius = 108;
  const pointAt = (index: number, ratio: number) => { const angle = -Math.PI / 2 + index / visible.length * Math.PI * 2; return [center + Math.cos(angle) * radius * ratio, center + Math.sin(angle) * radius * ratio] as const; };
  const grid = [0.25, 0.5, 0.75, 1].map((ratio) => visible.map((_, index) => pointAt(index, ratio).join(",")).join(" "));
  const shape = visible.map((item, index) => pointAt(index, item.rate).join(",")).join(" ");
  return (
    <svg className="analytics-radar" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="关键字段覆盖雷达图">
      {grid.map((points, index) => <polygon className="analytics-radar-grid" key={index} points={points} />)}
      {visible.map((item, index) => { const [x, y] = pointAt(index, 1); const [labelX, labelY] = pointAt(index, 1.24); return <g key={item.key}><line x1={center} x2={x} y1={center} y2={y} /><text x={labelX} y={labelY + 4} textAnchor={labelX < center - 4 ? "end" : labelX > center + 4 ? "start" : "middle"}>{item.label}</text></g>; })}
      <polygon className="analytics-radar-shape" points={shape} />{visible.map((item, index) => { const [x, y] = pointAt(index, item.rate); return <circle cx={x} cy={y} key={item.key} r="3"><title>{item.label} · {formatPercent(item.rate)}</title></circle>; })}
    </svg>
  );
}

function PipelineFunnel({ items }: { items: LibraryAnalyticsData["dataQuality"]["metadataPipeline"] }) {
  useLocale();
  const total = Math.max(1, items[0]?.value ?? 0);
  return <div className="analytics-funnel">{items.map((item, index) => <div key={item.key}><span><i>{String(index + 1).padStart(2, "0")}</i><strong>{item.label}</strong><small>{formatPercent(item.value / total)}</small></span><b style={{ width: `${Math.max(8, item.value / total * 100)}%` }}>{formatNumber(item.value)}</b></div>)}</div>;
}

function CoverageCohortMatrix({ items, mode }: { items: LibraryAnalyticsData["dataQuality"]["coverageByReleaseYear"]; mode: CoverageCohortMode }) {
  useLocale();
  const visible = items.slice(-16).reverse();
  const dimensions = [{ key: "readyWorks", label: "就绪" }, { key: "titleWorks", label: "中文标题" }, { key: "actorWorks", label: t("演员") }, { key: "genreWorks", label: t("题材") }, { key: "artworkWorks", label: "封面" }] as const;
  return <div className="analytics-matrix-scroll"><HeatLegend high={mode === "coverage" ? "高覆盖" : "高缺口"} label={mode === "coverage" ? "色深放大 70–100% 覆盖差异" : "色深表示字段缺口"} tone={mode === "coverage" ? "blue" : "pink"} /><table className={`analytics-matrix-table analytics-coverage-cohort is-${mode}`}><thead><tr><th>发行年</th><th>作品</th>{dimensions.map((item) => <th key={item.key}>{item.label}</th>)}</tr></thead><tbody>{visible.map((row) => <tr key={row.year}><th>{row.year === "undated" ? "日期缺失" : row.year}</th><td>{formatNumber(row.works)}</td>{dimensions.map((item) => { const rate = row.works > 0 ? row[item.key] / row.works : 0; const gap = Math.max(0, row.works - row[item.key]); const visualValue = mode === "coverage" ? rate : 1 - rate; const description = `${item.label} · 覆盖 ${formatPercent(rate)} · 缺口 ${formatNumber(gap)} / ${formatNumber(row.works)}`; return <td aria-label={description} key={item.key} style={mode === "coverage" ? coverageHeatStyle(rate) : heatStyle(visualValue, 1)} tabIndex={0} title={description}><span>{mode === "coverage" ? formatPercent(rate, 0) : gap > 0 ? formatNumber(gap) : "—"}</span></td>; })}</tr>)}</tbody></table></div>;
}

function CodecResolutionMatrix({ items, measure }: { items: LibraryAnalyticsData["technical"]["resolutionCodecMatrix"]; measure: TechnicalMeasure }) {
  useLocale();
  const rows = [...new Map(items.map((item) => [item.rowKey, item.rowLabel])).entries()];
  const columns = [...new Map(items.map((item) => [item.columnKey, item.columnLabel])).entries()].slice(0, 8);
  const valueMap = new Map(items.map((item) => [`${item.rowKey}::${item.columnKey}`, item]));
  const maxValue = Math.max(1, ...items.map((item) => item[measure]));
  return <div className="analytics-matrix-scroll"><HeatLegend high={measure === "bytes" ? "高容量" : "高文件量"} label={measure === "bytes" ? "清晰度 × 编码容量" : "清晰度 × 编码文件量"} tone="pink" /><table className="analytics-matrix-table analytics-codec-matrix"><thead><tr><th>清晰度 \ 编码</th>{columns.map(([key, label]) => <th key={key}>{label}</th>)}</tr></thead><tbody>{rows.map(([rowKey, rowLabel]) => <tr key={rowKey}><th>{rowLabel}</th>{columns.map(([columnKey, columnLabel]) => { const item = valueMap.get(`${rowKey}::${columnKey}`); const value = item?.[measure] ?? 0; const description = `${rowLabel} × ${columnLabel} · ${formatNumber(item?.files ?? 0)} 文件 · ${formatBytes(item?.bytes ?? 0)}`; return <td aria-label={description} key={columnKey} style={heatStyle(value, maxValue)} tabIndex={0} title={description}><span>{value > 0 ? measure === "bytes" ? formatBytes(value) : formatNumber(value) : "—"}</span></td>; })}</tr>)}</tbody></table></div>;
}

function SourceHealthScorecard({ items }: { items: LibraryAnalyticsData["sourceProfiles"] }) {
  useLocale();
  const totalBytes = items.reduce((sum, item) => sum + item.bytes, 0);
  if (items.length === 0) return <Empty description="暂无来源健康数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  const metrics = [
    { key: "fullHd", label: "1080p+", value: (item: LibraryAnalyticsData["sourceProfiles"][number]) => item.fullHdFiles / Math.max(1, item.files), tone: "blue" },
    { key: "native", label: t("原生播放"), value: (item: LibraryAnalyticsData["sourceProfiles"][number]) => item.nativeFiles / Math.max(1, item.files), tone: "orange" },
    { key: "probe", label: "技术参数", value: (item: LibraryAnalyticsData["sourceProfiles"][number]) => item.probedFiles / Math.max(1, item.files), tone: "gold" },
    { key: "risk", label: "播放风险", value: (item: LibraryAnalyticsData["sourceProfiles"][number]) => item.riskFiles / Math.max(1, item.files), tone: "pink" }
  ] as const;
  return (
    <div className="analytics-source-health">
      <header><span>{t("存储来源")}</span><span>容量份额</span>{metrics.map((metric) => <span key={metric.key}>{metric.label}</span>)}</header>
      {items.map((item) => (
        <div key={item.key}>
          <span><strong>{item.label}</strong><small>{formatNumber(item.files)} 文件 · 均件 {formatBytes(item.averageFileBytes)}</small></span>
          <span className="analytics-source-share"><b><i style={{ width: `${item.bytes / Math.max(1, totalBytes) * 100}%` }} /></b><em>{formatPercent(item.bytes / Math.max(1, totalBytes))}</em></span>
          {metrics.map((metric) => { const value = metric.value(item); return <span className={`analytics-source-metric is-${metric.tone}`} key={metric.key} title={`${item.label} · ${metric.label} ${formatPercent(value)}`}><b><i style={{ width: `${value * 100}%` }} /></b><em>{formatPercent(value)}</em></span>; })}
        </div>
      ))}
    </div>
  );
}

function TechnicalFormatBoard({ data, measure }: { data: LibraryAnalyticsData["technical"]; measure: TechnicalMeasure }) {
  useLocale();
  const groups = [
    { key: "video", label: t("视频编码"), items: data.codecs },
    { key: "audio", label: "音频编码", items: data.audioCodecs },
    { key: "container", label: "封装格式", items: data.containers },
    { key: "extension", label: "文件扩展名", items: data.extensions }
  ];
  return (
    <div className="analytics-format-board">
      {groups.map((group) => {
        const visible = group.items.slice(0, 6);
        const total = group.items.reduce((sum, item) => sum + item[measure], 0);
        const maximum = Math.max(1, ...visible.map((item) => item[measure]));
        return (
          <section key={group.key}>
            <header><strong>{group.label}</strong><small>{formatNumber(group.items.length)} 类 · {measure === "bytes" ? formatBytes(total) : `${formatNumber(total)} 文件`}</small></header>
            <div>{visible.map((item) => { const value = item[measure]; return <span key={item.key} title={`${item.label} · ${measure === "bytes" ? formatBytes(value) : `${formatNumber(value)} 文件`} · ${formatPercent(value / Math.max(1, total))}`}><strong>{item.label}</strong><b><i style={{ width: `${Math.max(value > 0 ? 2 : 0, value / maximum * 100)}%` }} /></b><em>{measure === "bytes" ? formatBytes(value) : formatNumber(value)}</em><small>{formatPercent(value / Math.max(1, total))}</small></span>; })}</div>
          </section>
        );
      })}
    </div>
  );
}

function CoverageGrid({ items }: { items: LibraryAnalyticsData["dataQuality"]["coverage"] }) {
  useLocale();
  return <div className="analytics-coverage-grid">{items.map((item) => <div key={item.key}><span><strong>{item.label}</strong><small>{formatNumber(item.value)} / {formatNumber(item.total)} {item.unit === "files" ? t("文件") : "作品"}</small></span><b>{formatPercent(item.rate)}</b><i style={percentageStyle(item.rate * 100)}><span /></i></div>)}</div>;
}

function JobStatusBars({ items, selectedKey, onSelect }: { items: LibraryAnalyticsJobType[]; selectedKey: string; onSelect: (key: string) => void }) {
  useLocale();
  if (items.length === 0) return <Empty description="暂无生产任务记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  return (
    <div className="analytics-status-bars" role="img" aria-label="各任务类型历史成功、失败和等待状态构成">
      {items.map((item) => (
        <button aria-pressed={item.key === selectedKey} className={item.key === selectedKey ? "is-selected" : ""} key={item.key} onClick={() => onSelect(item.key)} type="button">
          <span><strong>{item.label}</strong><small>{formatNumber(item.total)} 次尝试</small></span>
          <b aria-hidden="true">
            {item.ready > 0 && <i className="is-ready" style={{ flexGrow: item.ready }} title={`成功 ${formatNumber(item.ready)}`} />}
            {item.failed > 0 && <i className="is-failed" style={{ flexGrow: item.failed }} title={`失败 ${formatNumber(item.failed)}`} />}
            {item.pending > 0 && <i className="is-pending" style={{ flexGrow: item.pending }} title={`等待 ${formatNumber(item.pending)}`} />}
            {item.running > 0 && <i className="is-running" style={{ flexGrow: item.running }} title={`运行中 ${formatNumber(item.running)}`} />}
            {item.cancelled > 0 && <i className="is-cancelled" style={{ flexGrow: item.cancelled }} title={`取消 ${formatNumber(item.cancelled)}`} />}
          </b>
          <em>{formatPercent(item.successRate)}</em>
        </button>
      ))}
      <footer><span><i className="is-ready" />成功</span><span><i className="is-failed" />失败</span><span><i className="is-pending" />等待</span><span><i className="is-running" />运行中</span></footer>
    </div>
  );
}

function DailyJobBars({ points, mode }: { points: LibraryAnalyticsData["operations"]["jobDaily"]; mode: JobDailyMode }) {
  useLocale();
  const maxValue = Math.max(1, ...points.map((point) => point.total));
  if (points.length < 2) return <Empty description="近期任务时间点不足" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  return (
    <div className={`analytics-daily-jobs is-${mode}`} role="img" aria-label={`最近三十五个任务活跃日的${mode === "rate" ? "成功失败率" : "成功失败产出"}`}>
      <div className="analytics-daily-jobs-legend"><span><i className="is-ready" />成功</span><span><i className="is-failed" />失败</span><small>{mode === "rate" ? "每日 100% 状态构成" : "柱高使用对数尺度"}</small></div>
      <div className="analytics-daily-jobs-bars">
        {points.map((point, index) => {
          const resolved = point.ready + point.failed;
          const successRate = point.ready / Math.max(1, resolved);
          const height = point.total > 0 ? mode === "rate" ? 100 : Math.max(3, Math.log10(point.total + 1) / Math.log10(maxValue + 1) * 100) : 0;
          return (
            <div key={point.day} title={`${point.day} · 成功 ${formatNumber(point.ready)} · 失败 ${formatNumber(point.failed)}`}>
              <strong>{point.total > 0 ? mode === "rate" ? formatPercent(successRate, 0) : compactFormatter.format(point.total) : ""}</strong>
              <span style={{ height: `${height}%` }}>
                {point.ready > 0 && <i className="is-ready" style={{ flexGrow: point.ready }} />}
                {point.failed > 0 && <i className="is-failed" style={{ flexGrow: point.failed }} />}
              </span>
              <small>{index % 7 === 0 || index === points.length - 1 ? formatMonthDay(point.day) : ""}</small>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function JobReliabilityMatrix({ items, selectedKey, onSelect }: { items: LibraryAnalyticsJobType[]; selectedKey: string; onSelect: (key: string) => void }) {
  useLocale();
  const points = items.filter((item) => item.total > 0);
  if (points.length < 5) return <Empty description="任务类型不足以形成可靠性矩阵" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  const width = 820;
  const height = 330;
  const padding = { left: 54, right: 26, top: 30, bottom: 48 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const xValues = points.map((item) => Math.log10(Math.max(1, item.total)));
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minY = Math.max(0, Math.floor((Math.min(...points.map((item) => item.successRate)) - 0.05) * 10) / 10);
  const maxY = 1;
  const medianRate = [...points].sort((a, b) => a.successRate - b.successRate)[Math.floor(points.length / 2)]?.successRate ?? 0;
  const medianVolume = [...xValues].sort((a, b) => a - b)[Math.floor(xValues.length / 2)] ?? 0;
  const xFor = (total: number) => padding.left + (Math.log10(Math.max(1, total)) - minX) / Math.max(0.01, maxX - minX) * plotWidth;
  const yFor = (rate: number) => padding.top + (1 - (rate - minY) / Math.max(0.01, maxY - minY)) * plotHeight;
  return (
    <svg className="analytics-job-matrix" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="任务尝试规模与成功率关系矩阵">
      {[0, 0.5, 1].map((fraction) => <g key={fraction}><line x1={padding.left} x2={width - padding.right} y1={padding.top + plotHeight * fraction} y2={padding.top + plotHeight * fraction} /><text x={padding.left - 8} y={padding.top + plotHeight * fraction + 3} textAnchor="end">{formatPercent(maxY - (maxY - minY) * fraction, 0)}</text></g>)}
      <line className="analytics-job-benchmark" x1={xFor(10 ** medianVolume)} x2={xFor(10 ** medianVolume)} y1={padding.top} y2={padding.top + plotHeight} /><line className="analytics-job-benchmark" x1={padding.left} x2={width - padding.right} y1={yFor(medianRate)} y2={yFor(medianRate)} />
      {points.map((item) => { const x = xFor(item.total); const y = yFor(item.successRate); const selected = item.key === selectedKey; return <g className={selected ? "is-selected" : ""} key={item.key} onClick={() => onSelect(item.key)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelect(item.key); }} role="button" tabIndex={0}><circle cx={x} cy={y} r={selected ? 8 : 6}><title>{item.label} · {formatNumber(item.total)} 次 · 成功率 {formatPercent(item.successRate)} · 平均耗时 {formatDurationSeconds(item.averageDurationSeconds)}</title></circle><text x={x + 9} y={y + 3}>{item.label}</text></g>; })}
      <text className="analytics-axis-title" x={padding.left + plotWidth / 2} y={height - 10} textAnchor="middle">历史尝试次数（对数尺度）</text><text className="analytics-axis-title" transform={`translate(14,${padding.top + plotHeight / 2}) rotate(-90)`} textAnchor="middle">任务成功率</text>
    </svg>
  );
}

function PipelinePriorityBars({ items }: { items: LibraryAnalyticsPipelineStage[] }) {
  useLocale();
  const ranked = [...items].map((item) => ({ ...item, attention: item.failed + item.cancelled + item.pending + item.running, rate: (item.failed + item.cancelled + item.pending + item.running) / Math.max(1, item.total) })).sort((a, b) => b.rate - a.rate || b.attention - a.attention);
  return (
    <div className="analytics-pipeline-priority">
      {ranked.map((item, index) => (
        <div key={item.key}>
          <span>{String(index + 1).padStart(2, "0")}</span>
          <span><strong>{item.label}</strong><small>{item.grain} · 分母 {formatNumber(item.total)}</small></span>
          <b><i className="is-failed" style={{ width: `${(item.failed + item.cancelled) / Math.max(1, item.total) * 100}%` }} /><i className="is-pending" style={{ width: `${(item.pending + item.running) / Math.max(1, item.total) * 100}%` }} /></b>
          <em>{formatNumber(item.attention)} · {formatPercent(item.rate)}</em>
        </div>
      ))}
      <footer><span><i className="is-failed" />失败/取消</span><span><i className="is-pending" />等待/运行</span></footer>
    </div>
  );
}

function PipelineStageBars({ items }: { items: LibraryAnalyticsPipelineStage[] }) {
  useLocale();
  if (items.length === 0) return <Empty description="暂无当前资产状态" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  return (
    <div className="analytics-pipeline-bars">
      {items.map((item) => (
        <div key={item.key}>
          <span><strong>{item.label}</strong><small>{item.grain} · {formatNumber(item.total)} {t("条")}</small></span>
          <b>
            {item.ready > 0 && <i className="is-ready" style={{ flexGrow: item.ready }} title={`就绪 ${formatNumber(item.ready)}`} />}
            {item.failed + item.cancelled > 0 && <i className="is-failed" style={{ flexGrow: item.failed + item.cancelled }} title={`失败/取消 ${formatNumber(item.failed + item.cancelled)}`} />}
            {item.pending + item.running > 0 && <i className="is-pending" style={{ flexGrow: item.pending + item.running }} title={`等待/运行 ${formatNumber(item.pending + item.running)}`} />}
          </b>
          <em>{formatPercent(item.ready / Math.max(1, item.total))}</em>
        </div>
      ))}
    </div>
  );
}

function IngestionRunBars({ items }: { items: LibraryAnalyticsIngestionRun[] }) {
  useLocale();
  const visible = items.filter((item) => item.eligible > 0).slice(0, 10);
  const maxValue = Math.max(1, ...visible.map((item) => item.eligible));
  if (visible.length === 0) return <Empty description="近期批次没有可移动文件" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  return (
    <div className="analytics-ingestion-bars">
      {visible.map((item) => (
        <div key={item.id}>
          <span><strong>{new Date(item.createdAt).toLocaleDateString(getIntlLocale(), { month: "numeric", day: "numeric" })}</strong><small>{item.triggerType === "scheduled" ? "定时" : "手动"} · {item.status}</small></span>
          <b style={{ width: `${Math.max(6, item.eligible / maxValue * 100)}%` }}>
            <i style={{ flexGrow: item.moved }} title={`已移动 ${formatNumber(item.moved)}`} />
            <em style={{ flexGrow: Math.max(0, item.eligible - item.moved) }} title={`未移动 ${formatNumber(Math.max(0, item.eligible - item.moved))}`} />
          </b>
          <strong>{formatNumber(item.moved)} / {formatNumber(item.eligible)}</strong>
        </div>
      ))}
      <footer><span><i />已移动</span><span><em />冲突、未稳定或其他未移动</span></footer>
    </div>
  );
}

const actionableGovernanceKeys = new Set<GovernanceIssueKey>(["metadata", "artwork", "issues", "stale", "probeFailed", "playbackRisk"]);

function GovernanceBacklog({ items, onAction }: {
  items: LibraryAnalyticsData["dataQuality"]["backlog"];
  onAction: (issueKey: GovernanceIssueKey) => void;
}) {
  useLocale();
  return (
    <div className="analytics-governance-backlog">
      {[...items].sort((a, b) => b.rate - a.rate).map((item) => (
        <div className={`is-${item.severity}`} key={item.key} title={item.note}>
          <span><strong>{item.label}</strong><small>{item.note}</small></span>
          <b><i style={{ width: `${Math.max(item.value > 0 ? 2 : 0, item.rate * 100)}%` }} /></b>
          <em>{formatNumber(item.value)} · {formatPercent(item.rate)}</em>
          {actionableGovernanceKeys.has(item.key as GovernanceIssueKey) && (
            <button disabled={item.value === 0} onClick={() => onAction(item.key as GovernanceIssueKey)} type="button">
              <ListChecks size={12} />预览行动
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function ProviderCoverageMatrix({ items }: { items: LibraryAnalyticsData["dataQuality"]["metadataProviders"] }) {
  useLocale();
  const visible = items.slice(0, 12);
  const dimensions = [
    { key: "ready", label: "就绪", value: (item: LibraryAnalyticsData["dataQuality"]["metadataProviders"][number]) => item.readyWorks },
    { key: "title", label: "中文标题", value: (item: LibraryAnalyticsData["dataQuality"]["metadataProviders"][number]) => item.titleWorks },
    { key: "actor", label: t("演员"), value: (item: LibraryAnalyticsData["dataQuality"]["metadataProviders"][number]) => item.actorWorks },
    { key: "translation", label: t("翻译"), value: (item: LibraryAnalyticsData["dataQuality"]["metadataProviders"][number]) => item.translatedWorks },
    { key: "artwork", label: "封面", value: (item: LibraryAnalyticsData["dataQuality"]["metadataProviders"][number]) => item.artworkWorks },
    { key: "fresh", label: "90天内更新", value: (item: LibraryAnalyticsData["dataQuality"]["metadataProviders"][number]) => Math.max(0, item.works - item.staleWorks) }
  ];
  if (visible.length === 0) return <Empty description="暂无供应商覆盖数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  return (
    <div className="analytics-matrix-scroll">
      <HeatLegend high="100%" label="色深放大 70–100% 覆盖差异" low="≤70%" tone="blue" />
      <table className="analytics-matrix-table analytics-provider-matrix">
        <thead><tr><th>供应商</th><th>作品</th>{dimensions.map((dimension) => <th key={dimension.key}>{dimension.label}</th>)}</tr></thead>
        <tbody>{visible.map((item) => <tr key={item.key}><th>{item.provider}</th><td>{formatNumber(item.works)}</td>{dimensions.map((dimension) => { const value = dimension.value(item); const rate = value / Math.max(1, item.works); const description = `${item.provider} · ${dimension.label} ${formatNumber(value)} / ${formatNumber(item.works)} · ${formatPercent(rate)}`; return <td aria-label={description} key={dimension.key} style={coverageHeatStyle(rate)} tabIndex={0} title={description}><span>{formatPercent(rate, 0)}</span></td>; })}</tr>)}</tbody>
      </table>
    </div>
  );
}

function distributionToSegments(items: LibraryAnalyticsDistribution[], measure: AnalyticsMeasure): SegmentedItem[] {
  return items.map((item) => ({ key: item.key, label: item.label, value: item[measure], displayValue: measure === "bytes" ? formatBytes(item.bytes) : undefined, secondary: measure === "bytes" ? `${formatNumber(item.files)} 个文件` : formatBytes(item.bytes) }));
}

function measureLabel(measure: AnalyticsMeasure): string {
  return measure === "works" ? "作品" : measure === "files" ? t("文件") : "存储";
}

function DetailDatasetPreview({ dataset, data, formatRows }: { dataset: DetailDataset; data: LibraryAnalyticsData; formatRows: Array<LibraryAnalyticsDistribution & { group: string }> }) {
  useLocale();
  let title = "数据集概览";
  let note = "图表用于快速定位，再进入下方精确明细";
  let items: RankedItem[] = [];
  if (dataset === "year") {
    title = "发行年份规模 Top 8";
    note = "按去重作品排序；精确同比与技术覆盖见表格";
    items = [...data.yearlyMetrics].sort((a, b) => b.works - a.works).slice(0, 8).map((item) => ({ key: String(item.year), label: `${item.year} 年`, value: item.works, secondary: `同比 ${formatSignedPercent(item.workGrowthRate)} · ${formatBytes(item.bytes)}` }));
  } else if (dataset === "source") {
    title = "存储来源容量排序";
    note = "容量与播放风险并列，避免只按文件数判断";
    items = [...data.sourceProfiles].sort((a, b) => b.bytes - a.bytes).map((item) => ({ key: item.key, label: item.label, value: item.bytes, displayValue: formatBytes(item.bytes), secondary: `风险 ${formatPercent(item.riskFiles / Math.max(1, item.files))} · ${formatNumber(item.files)} 文件` }));
  } else if (dataset === "entity") {
    title = "实体档案覆盖排序";
    note = "轨道按已发现实体规模，右侧显示档案覆盖率";
    items = [...data.entityKnowledge.profiles].sort((a, b) => b.entities - a.entities).map((item) => ({ key: item.type, label: item.label, value: item.entities, displayValue: formatPercent(item.profiles / Math.max(1, item.entities)), secondary: `${formatNumber(item.profiles)} / ${formatNumber(item.entities)} 个档案` }));
  } else if (dataset === "provider") {
    title = "供应商作品覆盖排序";
    note = "右侧为 ready 覆盖率，错误和新鲜度留在明细核查";
    items = data.dataQuality.metadataProviders.slice(0, 8).map((item) => ({ key: item.key, label: item.provider, value: item.works, displayValue: formatPercent(item.readyWorks / Math.max(1, item.works)), secondary: `${formatNumber(item.works)} 部 · 错误 ${formatNumber(item.errorWorks)}` }));
  } else if (dataset === "format") {
    title = "影音格式文件 Top 8";
    note = "不同格式组统一按文件数排序，容量可在表中切换排序";
    items = [...formatRows].sort((a, b) => b.files - a.files).slice(0, 8).map((item) => ({ key: `${item.group}:${item.key}`, label: item.label, value: item.files, secondary: `${item.group} · ${formatBytes(item.bytes)}` }));
  } else if (dataset === "issues") {
    title = "问题类型影响 Top 8";
    note = "从作品级异常清单聚合；同一作品可以命中多个问题";
    const counts = new Map<string, { label: string; value: number }>();
    data.dataQuality.exceptionWorks.forEach((work) => work.issueTypes.forEach((issue) => { const current = counts.get(issue.key); counts.set(issue.key, { label: issue.label, value: (current?.value ?? 0) + 1 }); }));
    items = [...counts.entries()].sort((left, right) => right[1].value - left[1].value).slice(0, 8).map(([key, item]) => ({ key, label: item.label, value: item.value, secondary: "命中作品样本" }));
  } else if (dataset === "jobs") {
    title = "任务历史尝试规模";
    note = "右侧为成功率；耗时与最近活动见表格";
    items = [...data.operations.jobTypes].sort((a, b) => b.total - a.total).map((item) => ({ key: item.key, label: item.label, value: item.total, displayValue: formatPercent(item.successRate), secondary: `平均 ${formatDurationSeconds(item.averageDurationSeconds)}` }));
  } else if (dataset === "ingestion") {
    title = "近期采集批次符合规模";
    note = "按单批 eligible 排序；扫描量不作为库存累计";
    items = [...data.operations.recentIngestionRuns].sort((a, b) => b.eligible - a.eligible).slice(0, 8).map((item) => ({ key: item.id, label: new Date(item.createdAt).toLocaleDateString(getIntlLocale()), value: item.eligible, displayValue: `${formatNumber(item.moved)} / ${formatNumber(item.eligible)}`, secondary: `${item.triggerType === "scheduled" ? "定时" : "手动"} · ${item.status}` }));
  } else if (dataset === "assets") {
    title = "当前派生资产对象规模";
    note = "各阶段分母不同，右侧为各自就绪率";
    items = [...data.operations.pipelineStages].sort((a, b) => b.total - a.total).map((item) => ({ key: item.key, label: item.label, value: item.total, displayValue: formatPercent(item.ready / Math.max(1, item.total)), secondary: item.grain }));
  } else if (dataset === "failures") {
    title = "历史失败任务构成";
    note = "最近 80 条失败尝试聚合，不等同当前资产故障";
    const counts = new Map<string, number>();
    data.operations.failedJobDetails.forEach((item) => counts.set(item.jobLabel, (counts.get(item.jobLabel) ?? 0) + 1));
    items = [...counts.entries()].sort((left, right) => right[1] - left[1]).map(([key, value]) => ({ key, label: key, value, secondary: "历史失败尝试" }));
  } else {
    title = "内容维度集中度";
    note = "轨道为 Top 10 关系占比，右侧保留 HHI";
    items = [...data.dataQuality.facetConcentration].sort((a, b) => b.topTenShare - a.topTenShare).map((item) => ({ key: item.type, label: item.label, value: item.topTenShare * 100, displayValue: formatPercent(item.topTenShare), secondary: `HHI ${item.hhi.toFixed(4)} · ${formatNumber(item.entities)} 实体` }));
  }
  return <section className="analytics-detail-preview"><header><span><small>SELECTED DATASET PREVIEW</small><strong>{title}</strong></span><em>{note}</em></header><RankedBars items={items} /></section>;
}

function AnalyticsDashboardSkeleton() {
  useLocale();
  const metricTones = ["orange", "blue", "gold", "pink", "orange", "blue", "gold", "pink"];

  return (
    <div aria-busy="true" aria-label="正在生成馆藏分析" className="analytics-loading" role="status">
      <div className="analytics-loading-status">
        <span><i /><strong>正在聚合馆藏数据</strong></span>
        <small>计算年度、内容、技术、生产与治理指标</small>
      </div>

      <div aria-hidden="true" className="analytics-loading-shell">
        <div className="analytics-loading-scope">
          <span className="analytics-loading-glyph"><Sparkles size={14} /></span>
          <span className="analytics-loading-scope-copy">
            <i className="analytics-skeleton-shape is-title" />
            <i className="analytics-skeleton-shape is-copy" />
          </span>
          <i className="analytics-skeleton-shape is-note" />
        </div>

        <div className="analytics-loading-nav">
          {viewOptions.map(({ key, label, icon: Icon }, index) => (
            <div className={index === 0 ? "is-active" : ""} key={key}>
              <Icon size={15} />
              <span><strong>{label}</strong><i className="analytics-skeleton-shape" /></span>
            </div>
          ))}
        </div>

        <div className="analytics-loading-metrics">
          {metricTones.map((tone, index) => (
            <div className={`analytics-loading-metric is-${tone}`} key={`${tone}-${index}`}>
              <header><span className="analytics-loading-glyph" /><i className="analytics-skeleton-shape is-label" /></header>
              <div><i className="analytics-skeleton-shape is-value" /><span className="analytics-loading-spark">{[42, 68, 51, 82, 64].map((height, sparkIndex) => <i className="analytics-skeleton-shape" key={sparkIndex} style={{ "--skeleton-height": `${height}%` } as CSSProperties} />)}</span></div>
              <i className="analytics-skeleton-shape is-meta" />
            </div>
          ))}
        </div>

        <div className="analytics-loading-insights">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index}><span className="analytics-loading-glyph" /><span><i className="analytics-skeleton-shape is-label" /><i className="analytics-skeleton-shape is-copy" /></span></div>
          ))}
        </div>

        <div className="analytics-loading-section-heading">
          <span className="analytics-loading-glyph" />
          <span><i className="analytics-skeleton-shape is-title" /><i className="analytics-skeleton-shape is-copy" /></span>
        </div>

        <div className="analytics-loading-charts">
          <article className="analytics-loading-chart is-wide">
            <header><span className="analytics-loading-glyph" /><span><i className="analytics-skeleton-shape is-title" /><i className="analytics-skeleton-shape is-copy" /></span><i className="analytics-skeleton-shape is-chip" /></header>
            <div className="analytics-loading-diagnostics">
              {Array.from({ length: 4 }, (_, index) => <div key={index}><i className="analytics-skeleton-shape is-label" /><b><i className="analytics-skeleton-shape" style={{ "--skeleton-width": `${76 - index * 9}%` } as CSSProperties} /></b><i className="analytics-skeleton-shape is-number" /></div>)}
            </div>
          </article>

          <article className="analytics-loading-chart is-major">
            <header><span className="analytics-loading-glyph" /><span><i className="analytics-skeleton-shape is-title" /><i className="analytics-skeleton-shape is-copy" /></span></header>
            <div className="analytics-loading-plot">{[44, 58, 37, 69, 51, 76, 63, 88, 72, 81, 66, 92].map((height, index) => <i className="analytics-skeleton-shape" key={index} style={{ "--skeleton-height": `${height}%` } as CSSProperties} />)}</div>
          </article>

          <article className="analytics-loading-chart">
            <header><span className="analytics-loading-glyph" /><span><i className="analytics-skeleton-shape is-title" /><i className="analytics-skeleton-shape is-copy" /></span></header>
            <div className="analytics-loading-ranks">{Array.from({ length: 5 }, (_, index) => <div key={index}><i className="analytics-skeleton-shape is-label" /><b><i className="analytics-skeleton-shape" style={{ "--skeleton-width": `${88 - index * 12}%` } as CSSProperties} /></b><i className="analytics-skeleton-shape is-number" /></div>)}</div>
          </article>
        </div>
      </div>
    </div>
  );
}

export function LibraryAnalyticsDashboard({ onBack, onOpenEntity, onOpenMedia }: LibraryAnalyticsDashboardProps) {
  useLocale();
  const queryClient = useQueryClient();
  const viewNavRef = useRef<HTMLElement | null>(null);
  const viewContentRef = useRef<HTMLDivElement | null>(null);
  const [isMobileLayout, setIsMobileLayout] = useState(() =>
    typeof window !== "undefined" && (typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 760px)").matches
      : window.innerWidth <= 760)
  );
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [activeView, setActiveView] = useState<AnalyticsView>("overview");
  const [contentMode, setContentMode] = useState<ContentMode>("actors");
  const [activeFacet, setActiveFacet] = useState<LibraryAnalyticsFacetType>("actor");
  const [facetSearch, setFacetSearch] = useState("");
  const [measure, setMeasure] = useState<AnalyticsMeasure>("works");
  const [actorMatrixMode, setActorMatrixMode] = useState<ActorMatrixMode>("lift");
  const [actorActivityMode, setActorActivityMode] = useState<ActorActivityMode>("share");
  const [actorCoverageMode, setActorCoverageMode] = useState<ActorCoverageMode>("year");
  const [selectedActorValue, setSelectedActorValue] = useState("");
  const [selectedAffinityCell, setSelectedAffinityCell] = useState<SelectedActorGenreCell | null>(null);
  const [selectedCrossMatrixId, setSelectedCrossMatrixId] = useState("actor-genre");
  const [crossMatrixMode, setCrossMatrixMode] = useState<CrossMatrixMode>("lift");
  const [selectedCrossCell, setSelectedCrossCell] = useState<SelectedCrossCell | null>(null);
  const [overviewLens, setOverviewLens] = useState<OverviewLens>("scale");
  const [timeHeatMode, setTimeHeatMode] = useState<TimeHeatMode>("works");
  const [timeMixMode, setTimeMixMode] = useState<TimeMixMode>("absolute");
  const [technicalMeasure, setTechnicalMeasure] = useState<TechnicalMeasure>("files");
  const [jobDailyMode, setJobDailyMode] = useState<JobDailyMode>("volume");
  const [selectedJobTypeKey, setSelectedJobTypeKey] = useState("probe");
  const [qualityLens, setQualityLens] = useState<QualityLens>("coverage");
  const [coverageCohortMode, setCoverageCohortMode] = useState<CoverageCohortMode>("coverage");
  const [detailDataset, setDetailDataset] = useState<DetailDataset>("year");
  const [visualAuditOpen, setVisualAuditOpen] = useState(false);
  const [metricDefinitionsOpen, setMetricDefinitionsOpen] = useState(false);
  const [governanceIssueKey, setGovernanceIssueKey] = useState<GovernanceIssueKey | null>(null);
  const analyticsSummary = useQuery({
    queryKey: ["library-analytics-summary", selectedYear ?? "all"],
    queryFn: ({ signal }) => fetchLibraryAnalyticsSummary(selectedYear, signal),
    staleTime: 5 * 60_000,
    gcTime: 2 * 60 * 60_000,
    refetchOnMount: false
  });
  const analytics = useQuery({
    queryKey: ["library-analytics-section", activeView, activeView === "content" ? contentMode : "default", activeView === "content" && contentMode === "relations" ? selectedCrossMatrixId : "all-matrices", selectedYear ?? "all"],
    queryFn: ({ signal }) => fetchLibraryAnalyticsSection(activeView, selectedYear, signal, false, activeView === "content" ? contentMode as LibraryAnalyticsContentMode : undefined, activeView === "content" && contentMode === "relations" ? selectedCrossMatrixId : undefined),
    enabled: analyticsSummary.isSuccess,
    staleTime: 30 * 60_000,
    gcTime: 2 * 60 * 60_000,
    refetchOnMount: false
  });
  const refreshAnalytics = useMutation({
    mutationFn: async ({ year, section, mode, matrixId }: { year: number | null; section: AnalyticsView; mode?: LibraryAnalyticsContentMode; matrixId?: string }) => {
      const freshSummary = await fetchLibraryAnalyticsSummary(year, undefined, true);
      const freshData = await fetchLibraryAnalyticsSection(section, year, undefined, true, mode, matrixId);
      return { freshSummary, freshData, year, section, mode, matrixId };
    },
    onSuccess: ({ freshSummary, freshData, year, section, mode, matrixId }) => {
      queryClient.setQueryData(["library-analytics-summary", year ?? "all"], freshSummary);
      queryClient.setQueryData(["library-analytics-section", section, section === "content" ? mode ?? "actors" : "default", section === "content" && mode === "relations" ? matrixId ?? "actor-genre" : "all-matrices", year ?? "all"], freshData);
    }
  });
  const data = analytics.data as LibraryAnalyticsData | undefined;
  const summaryData = analyticsSummary.data;

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (typeof window.matchMedia !== "function") {
      const updateLayout = () => setIsMobileLayout(window.innerWidth <= 760);
      window.addEventListener("resize", updateLayout);
      return () => window.removeEventListener("resize", updateLayout);
    }

    const mediaQuery = window.matchMedia("(max-width: 760px)");
    const updateLayout = () => setIsMobileLayout(mediaQuery.matches);
    updateLayout();
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", updateLayout);
      return () => mediaQuery.removeEventListener("change", updateLayout);
    }

    mediaQuery.addListener(updateLayout);
    return () => mediaQuery.removeListener(updateLayout);
  }, []);

  useEffect(() => {
    const nav = viewNavRef.current;
    if (!nav || !isMobileLayout || typeof window === "undefined") return;
    const activeButton = nav.querySelector<HTMLButtonElement>('button[aria-current="page"]');
    if (!activeButton) return;
    const targetLeft = activeButton.offsetLeft + activeButton.offsetWidth / 2 - nav.clientWidth / 2;
    const reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    nav.scrollTo({ left: Math.max(0, targetLeft), behavior: reducedMotion ? "auto" : "smooth" });
  }, [activeView, isMobileLayout]);

  const handleViewChange = (nextView: AnalyticsView) => {
    setActiveView(nextView);
    if (!isMobileLayout || typeof window === "undefined") return;

    window.requestAnimationFrame(() => {
      const target = viewContentRef.current;
      if (!target) return;
      const reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const top = window.scrollY + target.getBoundingClientRect().top - 12;
      window.scrollTo({ top: Math.max(0, top), behavior: reducedMotion ? "auto" : "smooth" });
    });
  };

  const peakYear = useLocalizedMemo(() => data?.releaseHistory.reduce<{ year: number; works: number } | null>((peak, item) => !peak || item.works > peak.works ? item : peak, null) ?? null, [data?.releaseHistory]);
  const peakMonth = useLocalizedMemo(() => data?.releaseByMonth.reduce<{ month: number; works: number } | null>((peak, item) => !peak || item.works > peak.works ? item : peak, null) ?? null, [data?.releaseByMonth]);
  const releaseDateCoverage = data?.dataQuality.coverage.find((item) => item.key === "release");
  const activeFacetData = data?.facets[activeFacet];
  const filteredFacetItems = useLocalizedMemo(() => {
    const normalized = facetSearch.trim().toLocaleLowerCase();
    const items = activeFacetData?.items ?? [];
    return normalized ? items.filter((item) => `${item.label} ${item.value}`.toLocaleLowerCase().includes(normalized)) : items;
  }, [activeFacetData?.items, facetSearch]);
  const selectedActor = useLocalizedMemo<LibraryActorSummary | undefined>(() => {
    const actorData = data?.actorAnalytics;
    if (!actorData) return undefined;
    const value = selectedActorValue || actorData.genreAffinity.actors[0]?.value || actorData.collaboration.actors[0]?.value || "";
    const affinitySummary = actorData.genreAffinity.actors.find((item) => item.value === value);
    if (affinitySummary) return affinitySummary;
    const summary = actorData.collaboration.actors.find((item) => item.value === value);
    if (summary) return summary;
    const scorePoint = actorData.score.points.find((item) => item.value === value);
    if (scorePoint) return {
      value,
      label: scorePoint.label,
      works: scorePoint.works,
      firstReleaseDate: null,
      lastReleaseDate: scorePoint.latestReleaseDate,
      activeYears: 0,
      scoredWorks: scorePoint.scoredWorks,
      averageScore: scorePoint.averageScore
    };
    const pair = actorData.collaboration.pairs.find((item) => item.source === value || item.target === value);
    if (pair) return {
      value,
      label: pair.source === value ? pair.sourceLabel : pair.targetLabel,
      works: 0,
      firstReleaseDate: null,
      lastReleaseDate: null,
      activeYears: 0,
      scoredWorks: 0,
      averageScore: 0
    };
    return actorData.collaboration.actors[0];
  }, [data?.actorAnalytics, selectedActorValue]);
  const actorSelectOptions = useLocalizedMemo(() => {
    const actors = [...(data?.actorAnalytics.genreAffinity.actors ?? []), ...(data?.actorAnalytics.collaboration.actors ?? [])];
    const items = [...new Map(actors.map((item) => [item.value, item])).values()];
    if (selectedActor && !items.some((item) => item.value === selectedActor.value)) items.unshift(selectedActor);
    return items.map((item) => ({ value: item.value, label: `${item.label} · ${formatNumber(item.works)} 部` }));
  }, [data?.actorAnalytics.collaboration.actors, data?.actorAnalytics.genreAffinity.actors, selectedActor]);
  const selectedCrossMatrix = data?.crossAnalysis.matrices.find((matrix) => matrix.id === selectedCrossMatrixId) ?? data?.crossAnalysis.matrices[0];
  const selectedActorScore = data?.actorAnalytics.score.points.find((item) => item.value === selectedActor?.value);
  const selectedActorPairCount = data?.actorAnalytics.collaboration.pairs.filter((item) => item.source === selectedActor?.value || item.target === selectedActor?.value).length ?? 0;
  const actorSingletonBand = data?.actorAnalytics.workBands.find((item) => item.key === "one");
  const selectedJobType = data?.operations.jobTypes.find((item) => item.key === selectedJobTypeKey) ?? data?.operations.jobTypes[0];
  const strongestGrowthYear = useLocalizedMemo(() => data?.yearlyMetrics
    .filter((item) => item.workGrowthRate !== null)
    .sort((a, b) => a.year - b.year)
    .slice(-14)
    .reduce<LibraryAnalyticsYearMetric | null>((best, item) => !best || (item.workGrowthRate ?? -Infinity) > (best.workGrowthRate ?? -Infinity) ? item : best, null) ?? null, [data?.yearlyMetrics]);
  const medianReleaseYear = useLocalizedMemo(() => {
    const points = data?.releaseHistory ?? [];
    const total = points.reduce((sum, item) => sum + item.works, 0);
    let running = 0;
    for (const point of points) {
      running += point.works;
      if (running >= total / 2) return point.year;
    }
    return null;
  }, [data?.releaseHistory]);
  const largestSourceRisk = useLocalizedMemo(() => data?.sourceProfiles.reduce<LibraryAnalyticsData["sourceProfiles"][number] | null>((largest, item) => !largest || item.riskFiles / Math.max(1, item.files) > largest.riskFiles / Math.max(1, largest.files) ? item : largest, null) ?? null, [data?.sourceProfiles]);
  const largestCoverageGap = useLocalizedMemo(() => data?.dataQuality.coverage.reduce<LibraryAnalyticsData["dataQuality"]["coverage"][number] | null>((largest, item) => !largest || 1 - item.rate > 1 - largest.rate ? item : largest, null) ?? null, [data?.dataQuality.coverage]);
  const latestGrowthPoint = data?.catalogGrowth.at(-1);

  const overviewSignals = useLocalizedMemo<DiagnosticSignal[]>(() => {
    if (!data) return [];
    const coverage = new Map(data.dataQuality.coverage.map((item) => [item.key, item]));
    if (overviewLens === "scale") {
      const jav = data.libraryMix.find((item) => item.key === "JAV");
      const topSource = data.sourceProfiles[0];
      return [
        { key: "jav", label: "JAV 作品构成", displayValue: formatPercent((jav?.works ?? 0) / Math.max(1, data.summary.works)), secondary: `${formatNumber(jav?.works ?? 0)} / ${formatNumber(data.summary.works)} 部`, rate: (jav?.works ?? 0) / Math.max(1, data.summary.works), tone: "orange" },
        { key: "source", label: "最大来源容量份额", displayValue: formatPercent((topSource?.bytes ?? 0) / Math.max(1, data.summary.totalBytes)), secondary: `${topSource?.label ?? "—"} · ${formatBytes(topSource?.bytes ?? 0)}`, rate: (topSource?.bytes ?? 0) / Math.max(1, data.summary.totalBytes), tone: "gold" },
        { key: "fullHd", label: "1080p+ 文件", displayValue: formatPercent(data.summary.fullHdShare), secondary: `${formatNumber(Math.round(data.summary.fullHdShare * data.summary.files))} / ${formatNumber(data.summary.files)} 文件`, rate: data.summary.fullHdShare, tone: "blue" },
        { key: "variants", label: "额外版本占比", displayValue: formatPercent(data.summary.variantRate), secondary: `${formatNumber(data.summary.variants)} 个额外文件版本`, rate: data.summary.variantRate, tone: "pink" },
        { key: "scores", label: "有效评分样本", displayValue: formatPercent(data.summary.scoredWorks / Math.max(1, data.summary.works)), secondary: `${formatNumber(data.summary.scoredWorks)} 部 · 均分 ${data.summary.averagePositiveScore.toFixed(2)}`, rate: data.summary.scoredWorks / Math.max(1, data.summary.works), tone: "blue" }
      ];
    }
    if (overviewLens === "quality") {
      return ["metadata", "titleZh", "actor", "series", "probe"].map((key, index) => {
        const item = coverage.get(key);
        return { key, label: item?.label ?? key, displayValue: formatPercent(item?.rate ?? 0), secondary: `${formatNumber(item?.value ?? 0)} / ${formatNumber(item?.total ?? 0)} ${item?.unit === "files" ? t("文件") : "作品"}`, rate: item?.rate ?? 0, tone: (["orange", "blue", "gold", "pink", "blue"] as const)[index] };
      });
    }
    return [...data.dataQuality.backlog].sort((left, right) => right.rate - left.rate).slice(0, 5).map((item) => ({ key: item.key, label: item.label, displayValue: `${formatNumber(item.value)} · ${formatPercent(item.rate)}`, secondary: item.note, rate: item.rate, tone: item.severity === "error" ? "pink" : item.severity === "warning" ? "gold" : "blue" }));
  }, [data, overviewLens]);

  const qualitySignals = useLocalizedMemo<DiagnosticSignal[]>(() => {
    if (!data) return [];
    if (qualityLens === "coverage") {
      return [...data.dataQuality.coverage].sort((left, right) => left.rate - right.rate).slice(0, 6).map((item) => ({ key: item.key, label: `${item.label}缺口`, displayValue: formatNumber(Math.max(0, item.total - item.value)), secondary: `当前覆盖 ${formatPercent(item.rate)} · 分母 ${formatNumber(item.total)}`, rate: 1 - item.rate, tone: item.rate < 0.75 ? "pink" : item.rate < 0.95 ? "gold" : "blue" }));
    }
    if (qualityLens === "freshness") {
      return [...data.dataQuality.metadataProviders].sort((left, right) => right.staleWorks / Math.max(1, right.works) - left.staleWorks / Math.max(1, left.works) || right.errorWorks - left.errorWorks).slice(0, 6).map((item) => ({ key: item.key, label: item.provider, displayValue: `${formatNumber(item.staleWorks)} 陈旧`, secondary: `错误 ${formatNumber(item.errorWorks)} · 最近 ${formatDateTime(item.latestUpdatedAt)}`, rate: item.staleWorks / Math.max(1, item.works), tone: item.staleWorks > 0 || item.errorWorks > 0 ? "pink" : "blue" }));
    }
    return [...data.dataQuality.backlog].sort((left, right) => right.rate - left.rate).map((item) => ({ key: item.key, label: item.label, displayValue: `${formatNumber(item.value)} · ${formatPercent(item.rate)}`, secondary: item.note, rate: item.rate, tone: item.severity === "error" ? "pink" : item.severity === "warning" ? "gold" : "blue" }));
  }, [data, qualityLens]);

  const yearOptions = [
    { value: "all", label: "全部馆藏" },
    ...((data?.availableYears ?? summaryData?.availableYears ?? []).map((item) => ({ value: String(item.year), label: `${item.year} 年 · ${formatNumber(item.works)} 部` })))
  ];

  const yearlyColumns: TableColumnsType<LibraryAnalyticsYearMetric> = [
    { title: "发行年", dataIndex: "year", fixed: "left", width: 82, sorter: (a, b) => a.year - b.year },
    { title: "作品", dataIndex: "works", width: 94, sorter: (a, b) => a.works - b.works, render: (value: number) => formatNumber(value) },
    { title: "同比", dataIndex: "workGrowthRate", width: 82, sorter: (a, b) => (a.workGrowthRate ?? -999) - (b.workGrowthRate ?? -999), render: (value: number | null) => <span className={value !== null && value < 0 ? "analytics-negative" : "analytics-positive"}>{formatSignedPercent(value)}</span> },
    { title: t("文件"), dataIndex: "files", width: 94, sorter: (a, b) => a.files - b.files, render: (value: number) => formatNumber(value) },
    { title: "存储", dataIndex: "bytes", width: 98, sorter: (a, b) => a.bytes - b.bytes, render: (value: number) => formatBytes(value) },
    { title: "总片长", dataIndex: "durationSeconds", width: 112, sorter: (a, b) => a.durationSeconds - b.durationSeconds, render: (value: number) => formatHours(value) },
    { title: "平均文件", dataIndex: "averageFileBytes", width: 104, sorter: (a, b) => a.averageFileBytes - b.averageFileBytes, render: (value: number) => formatBytes(value) },
    { title: "有效均分", dataIndex: "averageScore", width: 96, sorter: (a, b) => a.averageScore - b.averageScore, render: (value: number, row) => value > 0 ? <span>{value.toFixed(2)} <small>n={formatNumber(row.scoredWorks)}</small></span> : "—" },
    { title: "4K", dataIndex: "fourKShare", width: 82, sorter: (a, b) => a.fourKShare - b.fourKShare, render: (value: number) => formatPercent(value) },
    { title: "1080p+", dataIndex: "fullHdShare", width: 92, sorter: (a, b) => a.fullHdShare - b.fullHdShare, render: (value: number) => formatPercent(value) },
    { title: "元数据", dataIndex: "metadataCoverage", width: 92, sorter: (a, b) => a.metadataCoverage - b.metadataCoverage, render: (value: number) => formatPercent(value) },
    { title: "技术参数", dataIndex: "probeCoverage", width: 96, sorter: (a, b) => a.probeCoverage - b.probeCoverage, render: (value: number) => formatPercent(value) }
  ];

  const sourceColumns: TableColumnsType<LibraryAnalyticsData["sourceProfiles"][number]> = [
    { title: t("来源"), dataIndex: "label", fixed: "left", width: 126, sorter: (a, b) => a.label.localeCompare(b.label) },
    { title: "作品", dataIndex: "works", width: 90, sorter: (a, b) => a.works - b.works, render: (value: number) => formatNumber(value) },
    { title: t("文件"), dataIndex: "files", width: 90, sorter: (a, b) => a.files - b.files, render: (value: number) => formatNumber(value) },
    { title: "存储", dataIndex: "bytes", width: 100, sorter: (a, b) => a.bytes - b.bytes, render: (value: number) => formatBytes(value) },
    { title: "平均文件", dataIndex: "averageFileBytes", width: 105, sorter: (a, b) => a.averageFileBytes - b.averageFileBytes, render: (value: number) => formatBytes(value) },
    { title: "总片长", dataIndex: "durationSeconds", width: 112, sorter: (a, b) => a.durationSeconds - b.durationSeconds, render: (value: number) => formatHours(value) },
    { title: "1080p+", key: "fullHd", width: 92, sorter: (a, b) => a.fullHdFiles / a.files - b.fullHdFiles / b.files, render: (_, row) => formatPercent(row.fullHdFiles / Math.max(1, row.files)) },
    { title: "4K", key: "fourK", width: 82, sorter: (a, b) => a.fourKFiles / a.files - b.fourKFiles / b.files, render: (_, row) => formatPercent(row.fourKFiles / Math.max(1, row.files)) },
    { title: t("原生播放"), key: "native", width: 98, sorter: (a, b) => a.nativeFiles / a.files - b.nativeFiles / b.files, render: (_, row) => formatPercent(row.nativeFiles / Math.max(1, row.files)) },
    { title: "转码风险", key: "risk", width: 96, sorter: (a, b) => a.riskFiles / a.files - b.riskFiles / b.files, render: (_, row) => <span className={row.riskFiles > 0 ? "analytics-warning" : ""}>{formatPercent(row.riskFiles / Math.max(1, row.files))}</span> },
    { title: "技术参数", key: "probe", width: 96, sorter: (a, b) => a.probedFiles / a.files - b.probedFiles / b.files, render: (_, row) => formatPercent(row.probedFiles / Math.max(1, row.files)) },
    { title: "版本率", dataIndex: "variantRate", width: 90, sorter: (a, b) => a.variantRate - b.variantRate, render: (value: number) => formatPercent(value) }
  ];

  const facetColumns: TableColumnsType<LibraryAnalyticsFacetItem> = [
    { title: t("实体"), dataIndex: "label", fixed: "left", width: 190, render: (value: string, row) => <button className="analytics-table-link" onClick={() => onOpenEntity({ type: activeFacet, value: row.value, label: row.label })} type="button">{value}</button> },
    { title: "作品", dataIndex: "works", width: 90, sorter: (a, b) => a.works - b.works, render: (value: number) => formatNumber(value) },
    { title: "关系占比", dataIndex: "works", width: 96, sorter: (a, b) => a.works - b.works, render: (value: number) => formatPercent(value / Math.max(1, activeFacetData?.totalAssignments ?? 0)) },
    { title: t("文件"), dataIndex: "files", width: 88, sorter: (a, b) => a.files - b.files, render: (value: number) => formatNumber(value) },
    { title: "存储", dataIndex: "bytes", width: 100, sorter: (a, b) => a.bytes - b.bytes, render: (value: number) => formatBytes(value) },
    { title: "有效均分", dataIndex: "averageScore", width: 116, sorter: (a, b) => a.averageScore - b.averageScore, render: (value: number, row) => value > 0 ? <span>{value.toFixed(2)} <small>n={formatNumber(row.scoredWorks)}</small></span> : "—" },
    { title: "平均片长", dataIndex: "averageRuntimeMinutes", width: 110, sorter: (a, b) => a.averageRuntimeMinutes - b.averageRuntimeMinutes, render: (value: number) => formatMinutes(value) },
    { title: t("最近发行"), dataIndex: "latestReleaseDate", width: 112, sorter: (a, b) => String(a.latestReleaseDate ?? "").localeCompare(String(b.latestReleaseDate ?? "")), render: (value: string | null) => value ?? "—" }
  ];

  const providerColumns: TableColumnsType<LibraryAnalyticsData["dataQuality"]["metadataProviders"][number]> = [
    { title: "供应商", dataIndex: "provider", fixed: "left", width: 120, sorter: (a, b) => a.provider.localeCompare(b.provider) },
    { title: "作品", dataIndex: "works", width: 88, sorter: (a, b) => a.works - b.works, render: (value: number) => formatNumber(value) },
    { title: "就绪", key: "ready", width: 88, sorter: (a, b) => a.readyWorks / a.works - b.readyWorks / b.works, render: (_, row) => formatPercent(row.readyWorks / Math.max(1, row.works)) },
    { title: "中文标题", key: "title", width: 96, sorter: (a, b) => a.titleWorks / a.works - b.titleWorks / b.works, render: (_, row) => formatPercent(row.titleWorks / Math.max(1, row.works)) },
    { title: t("演员"), key: "actor", width: 88, sorter: (a, b) => a.actorWorks / a.works - b.actorWorks / b.works, render: (_, row) => formatPercent(row.actorWorks / Math.max(1, row.works)) },
    { title: t("翻译"), key: "translation", width: 88, sorter: (a, b) => a.translatedWorks / a.works - b.translatedWorks / b.works, render: (_, row) => formatPercent(row.translatedWorks / Math.max(1, row.works)) },
    { title: "封面", key: "artwork", width: 88, sorter: (a, b) => a.artworkWorks / a.works - b.artworkWorks / b.works, render: (_, row) => formatPercent(row.artworkWorks / Math.max(1, row.works)) },
    { title: "评分样本", dataIndex: "scoredWorks", width: 98, sorter: (a, b) => a.scoredWorks - b.scoredWorks, render: (value: number, row) => `${formatNumber(value)} / ${formatNumber(row.works)}` },
    { title: "均分", dataIndex: "averageScore", width: 78, sorter: (a, b) => a.averageScore - b.averageScore, render: (value: number) => value > 0 ? value.toFixed(2) : "—" },
    { title: "未找到", dataIndex: "notFoundWorks", width: 88, sorter: (a, b) => a.notFoundWorks - b.notFoundWorks, render: (value: number) => <span className={value > 0 ? "analytics-warning" : ""}>{formatNumber(value)}</span> },
    { title: "错误记录", dataIndex: "errorWorks", width: 92, sorter: (a, b) => a.errorWorks - b.errorWorks, render: (value: number) => <span className={value > 0 ? "analytics-negative" : ""}>{formatNumber(value)}</span> },
    { title: "90天未刷新", dataIndex: "staleWorks", width: 106, sorter: (a, b) => a.staleWorks - b.staleWorks, render: (value: number, row) => `${formatNumber(value)} · ${formatPercent(value / Math.max(1, row.works))}` },
    { title: "平均尝试", dataIndex: "averageAttempts", width: 92, sorter: (a, b) => a.averageAttempts - b.averageAttempts, render: (value: number) => value.toFixed(2) },
    { title: "最近更新", dataIndex: "latestUpdatedAt", width: 142, sorter: (a, b) => String(a.latestUpdatedAt ?? "").localeCompare(String(b.latestUpdatedAt ?? "")), render: (value: string | null) => formatDateTime(value) }
  ];

  const entityColumns: TableColumnsType<LibraryAnalyticsData["entityKnowledge"]["profiles"][number]> = [
    { title: "实体维度", dataIndex: "label", fixed: "left", width: 110 },
    { title: "已发现", dataIndex: "entities", width: 92, sorter: (a, b) => a.entities - b.entities, render: (value: number) => formatNumber(value) },
    { title: "档案覆盖", key: "profiles", width: 108, sorter: (a, b) => a.profiles / a.entities - b.profiles / b.entities, render: (_, row) => `${formatNumber(row.profiles)} · ${formatPercent(row.profiles / Math.max(1, row.entities))}` },
    { title: "简介", key: "bios", width: 98, sorter: (a, b) => a.biographies / a.entities - b.biographies / b.entities, render: (_, row) => formatPercent(row.biographies / Math.max(1, row.entities)) },
    { title: "图像", dataIndex: "images", width: 88, sorter: (a, b) => a.images - b.images, render: (value: number) => formatNumber(value) },
    { title: "出生日期", dataIndex: "birthDates", width: 96, sorter: (a, b) => a.birthDates - b.birthDates, render: (value: number) => formatNumber(value) },
    { title: "官网", dataIndex: "officialWebsites", width: 78, sorter: (a, b) => a.officialWebsites - b.officialWebsites, render: (value: number) => formatNumber(value) },
    { title: "平均置信度", dataIndex: "averageConfidence", width: 110, sorter: (a, b) => a.averageConfidence - b.averageConfidence, render: (value: number) => formatPercent(value) },
    { title: "来源记录", dataIndex: "sources", width: 94, sorter: (a, b) => a.sources - b.sources, render: (value: number) => formatNumber(value) },
    { title: "来源类型", dataIndex: "sourceProviders", width: 90, sorter: (a, b) => a.sourceProviders - b.sourceProviders, render: (value: number) => formatNumber(value) },
    { title: "来源置信度", dataIndex: "averageSourceConfidence", width: 108, sorter: (a, b) => a.averageSourceConfidence - b.averageSourceConfidence, render: (value: number) => formatPercent(value) },
    { title: "已匹配", key: "matched", width: 90, render: (_, row) => formatNumber((row.enrichment.matched ?? 0) + (row.enrichment["auto-resolved"] ?? 0)) },
    { title: "未找到", key: "notFound", width: 88, render: (_, row) => <span className={(row.enrichment["not-found"] ?? 0) > 0 ? "analytics-warning" : ""}>{formatNumber(row.enrichment["not-found"] ?? 0)}</span> }
  ];

  const exceptionColumns: TableColumnsType<LibraryAnalyticsData["dataQuality"]["exceptionWorks"][number]> = [
    { title: t("番号"), dataIndex: "code", fixed: "left", width: 132, sorter: (a, b) => a.code.localeCompare(b.code), render: (value: string) => <code className="analytics-code">{value}</code> },
    { title: "作品", dataIndex: "title", width: 280, ellipsis: true },
    { title: "供应商", dataIndex: "provider", width: 104, filters: [...new Set((data?.dataQuality.exceptionWorks ?? []).map((item) => item.provider))].map((value) => ({ text: value, value })), onFilter: (value, row) => row.provider === value },
    { title: "状态", dataIndex: "status", width: 92, filters: [...new Set((data?.dataQuality.exceptionWorks ?? []).map((item) => item.status))].map((value) => ({ text: value, value })), onFilter: (value, row) => row.status === value, render: (value: string) => <span className={`analytics-status is-${value}`}>{value}</span> },
    { title: "问题", dataIndex: "issueCount", width: 78, sorter: (a, b) => a.issueCount - b.issueCount, render: (value: number, row) => <span className={row.severity === "error" ? "analytics-negative" : "analytics-warning"}>{formatNumber(value)}</span> },
    { title: "缺失字段", dataIndex: "missingFieldCount", width: 92, sorter: (a, b) => a.missingFieldCount - b.missingFieldCount },
    { title: "问题类型", dataIndex: "issueTypes", width: 220, render: (items: Array<{ key: string; label: string }>) => <div className="analytics-table-tags">{items.length > 0 ? items.slice(0, 2).map((item) => <span key={item.key}>{item.label}</span>) : <em>字段缺失</em>}</div> },
    { title: t("文件"), dataIndex: "files", width: 76, sorter: (a, b) => a.files - b.files },
    { title: "占用", dataIndex: "bytes", width: 96, sorter: (a, b) => a.bytes - b.bytes, render: (value: number) => formatBytes(value) },
    { title: "发行日", dataIndex: "releaseDate", width: 110, sorter: (a, b) => String(a.releaseDate ?? "").localeCompare(String(b.releaseDate ?? "")), render: (value: string | null) => value ?? "—" }
  ];

  const formatRows = data ? [
    ...data.technical.codecs.map((item) => ({ ...item, group: t("视频编码") })),
    ...data.technical.audioCodecs.map((item) => ({ ...item, group: "音频编码" })),
    ...data.technical.containers.map((item) => ({ ...item, group: "封装格式" })),
    ...data.technical.extensions.map((item) => ({ ...item, group: "文件扩展名" }))
  ] : [];
  const formatColumns: TableColumnsType<(typeof formatRows)[number]> = [
    { title: "类型", dataIndex: "group", fixed: "left", width: 116, filters: [t("视频编码"), "音频编码", "封装格式", "文件扩展名"].map((value) => ({ text: value, value })), onFilter: (value, row) => row.group === value },
    { title: t("格式"), dataIndex: "label", width: 150, sorter: (a, b) => a.label.localeCompare(b.label) },
    { title: t("文件"), dataIndex: "files", width: 94, sorter: (a, b) => a.files - b.files, render: (value: number) => formatNumber(value) },
    { title: "作品", dataIndex: "works", width: 94, sorter: (a, b) => a.works - b.works, render: (value: number) => formatNumber(value) },
    { title: "存储", dataIndex: "bytes", width: 108, sorter: (a, b) => a.bytes - b.bytes, render: (value: number) => formatBytes(value) },
    { title: "文件占比", dataIndex: "files", width: 100, sorter: (a, b) => a.files - b.files, render: (value: number) => formatPercent(value / Math.max(1, data?.summary.files ?? 0)) },
    { title: "存储占比", dataIndex: "bytes", width: 100, sorter: (a, b) => a.bytes - b.bytes, render: (value: number) => formatPercent(value / Math.max(1, data?.summary.totalBytes ?? 0)) }
  ];

  const jobTypeColumns: TableColumnsType<LibraryAnalyticsJobType> = [
    { title: "任务类型", dataIndex: "label", fixed: "left", width: 132, sorter: (a, b) => a.label.localeCompare(b.label) },
    { title: "总尝试", dataIndex: "total", width: 92, sorter: (a, b) => a.total - b.total, render: (value: number) => formatNumber(value) },
    { title: "成功", dataIndex: "ready", width: 88, sorter: (a, b) => a.ready - b.ready, render: (value: number) => <span className="analytics-positive">{formatNumber(value)}</span> },
    { title: "失败", dataIndex: "failed", width: 88, sorter: (a, b) => a.failed - b.failed, render: (value: number) => <span className={value > 0 ? "analytics-negative" : ""}>{formatNumber(value)}</span> },
    { title: "成功率", dataIndex: "successRate", width: 94, sorter: (a, b) => a.successRate - b.successRate, render: (value: number) => formatPercent(value) },
    { title: "等待", dataIndex: "pending", width: 76, sorter: (a, b) => a.pending - b.pending, render: (value: number) => formatNumber(value) },
    { title: "运行中", dataIndex: "running", width: 80, sorter: (a, b) => a.running - b.running, render: (value: number) => formatNumber(value) },
    { title: "平均耗时", dataIndex: "averageDurationSeconds", width: 110, sorter: (a, b) => a.averageDurationSeconds - b.averageDurationSeconds, render: (value: number) => formatDurationSeconds(value) },
    { title: "最近活动", dataIndex: "latestUpdatedAt", width: 146, sorter: (a, b) => String(a.latestUpdatedAt ?? "").localeCompare(String(b.latestUpdatedAt ?? "")), render: (value: string | null) => formatDateTime(value) }
  ];

  const ingestionColumns: TableColumnsType<LibraryAnalyticsIngestionRun> = [
    { title: "批次时间", dataIndex: "createdAt", fixed: "left", width: 150, sorter: (a, b) => a.createdAt.localeCompare(b.createdAt), render: (value: string) => formatDateTime(value) },
    { title: "触发", dataIndex: "triggerType", width: 76, filters: [{ text: "手动", value: "manual" }, { text: "定时", value: "scheduled" }], onFilter: (value, row) => row.triggerType === value, render: (value: string) => value === "scheduled" ? "定时" : value === "manual" ? "手动" : value },
    { title: "状态", dataIndex: "status", width: 88, filters: [...new Set((data?.operations.recentIngestionRuns ?? []).map((item) => item.status))].map((value) => ({ text: value, value })), onFilter: (value, row) => row.status === value, render: (value: string) => <span className={`analytics-status is-${value}`}>{value}</span> },
    { title: "阶段", dataIndex: "phase", width: 92, ellipsis: true },
    { title: "扫描", dataIndex: "scanned", width: 92, sorter: (a, b) => a.scanned - b.scanned, render: (value: number) => formatNumber(value) },
    { title: "符合", dataIndex: "eligible", width: 82, sorter: (a, b) => a.eligible - b.eligible, render: (value: number) => formatNumber(value) },
    { title: "已移动", dataIndex: "moved", width: 88, sorter: (a, b) => a.moved - b.moved, render: (value: number) => formatNumber(value) },
    { title: "转化率", key: "conversion", width: 88, sorter: (a, b) => a.moved / Math.max(1, a.eligible) - b.moved / Math.max(1, b.eligible), render: (_, row) => formatPercent(row.moved / Math.max(1, row.eligible)) },
    { title: "冲突", dataIndex: "conflicts", width: 76, sorter: (a, b) => a.conflicts - b.conflicts, render: (value: number) => <span className={value > 0 ? "analytics-warning" : ""}>{formatNumber(value)}</span> },
    { title: "未稳定", dataIndex: "unstable", width: 82, sorter: (a, b) => a.unstable - b.unstable, render: (value: number) => formatNumber(value) },
    { title: "拒绝", dataIndex: "rejected", width: 88, sorter: (a, b) => a.rejected - b.rejected, render: (value: number) => formatNumber(value) },
    { title: "预览排队", dataIndex: "previewsQueued", width: 92, sorter: (a, b) => a.previewsQueued - b.previewsQueued, render: (value: number) => formatNumber(value) },
    { title: "演员发现", dataIndex: "actorsDiscovered", width: 92, sorter: (a, b) => a.actorsDiscovered - b.actorsDiscovered, render: (value: number) => formatNumber(value) },
    { title: "耗时", dataIndex: "durationSeconds", width: 102, sorter: (a, b) => a.durationSeconds - b.durationSeconds, render: (value: number) => formatDurationSeconds(value) },
    { title: "错误", dataIndex: "error", width: 300, ellipsis: true, render: (value: string) => value || "—" }
  ];

  const assetColumns: TableColumnsType<LibraryAnalyticsPipelineStage> = [
    { title: "资产阶段", dataIndex: "label", fixed: "left", width: 126 },
    { title: "统计对象", dataIndex: "grain", width: 174 },
    { title: "总记录", dataIndex: "total", width: 92, sorter: (a, b) => a.total - b.total, render: (value: number) => formatNumber(value) },
    { title: "就绪", dataIndex: "ready", width: 92, sorter: (a, b) => a.ready - b.ready, render: (value: number, row) => `${formatNumber(value)} · ${formatPercent(value / Math.max(1, row.total))}` },
    { title: "失败", key: "failed", width: 88, sorter: (a, b) => a.failed + a.cancelled - b.failed - b.cancelled, render: (_, row) => <span className={row.failed + row.cancelled > 0 ? "analytics-negative" : ""}>{formatNumber(row.failed + row.cancelled)}</span> },
    { title: "等待/运行", key: "pending", width: 102, sorter: (a, b) => a.pending + a.running - b.pending - b.running, render: (_, row) => formatNumber(row.pending + row.running) },
    { title: "产物体积", dataIndex: "bytes", width: 108, sorter: (a, b) => a.bytes - b.bytes, render: (value: number) => value > 0 ? formatBytes(value) : "—" },
    { title: "最近活动", dataIndex: "latestUpdatedAt", width: 148, sorter: (a, b) => String(a.latestUpdatedAt ?? "").localeCompare(String(b.latestUpdatedAt ?? "")), render: (value: string | null) => formatDateTime(value) }
  ];

  const failureColumns: TableColumnsType<LibraryAnalyticsData["operations"]["failedJobDetails"][number]> = [
    { title: "任务", dataIndex: "jobLabel", fixed: "left", width: 126, filters: [...new Set((data?.operations.failedJobDetails ?? []).map((item) => item.jobLabel))].map((value) => ({ text: value, value })), onFilter: (value, row) => row.jobLabel === value },
    { title: "番号 / 文件", dataIndex: "code", width: 164, ellipsis: true, render: (value: string) => <code className="analytics-code">{value}</code> },
    { title: "尝试", key: "attempts", width: 84, sorter: (a, b) => a.attempts - b.attempts, render: (_, row) => `${row.attempts} / ${row.maxAttempts}` },
    { title: "耗时", dataIndex: "durationSeconds", width: 104, sorter: (a, b) => a.durationSeconds - b.durationSeconds, render: (value: number) => formatDurationSeconds(value) },
    { title: "错误摘要", dataIndex: "error", width: 520, ellipsis: true, render: (value: string) => value || "未记录错误摘要" },
    { title: t("更新时间"), dataIndex: "updatedAt", width: 150, sorter: (a, b) => a.updatedAt.localeCompare(b.updatedAt), render: (value: string) => formatDateTime(value) }
  ];

  const concentrationColumns: TableColumnsType<LibraryAnalyticsData["dataQuality"]["facetConcentration"][number]> = [
    { title: "内容维度", dataIndex: "label", fixed: "left", width: 110 },
    { title: "实体数", dataIndex: "entities", width: 96, sorter: (a, b) => a.entities - b.entities, render: (value: number) => formatNumber(value) },
    { title: "单次出现", dataIndex: "singletonEntities", width: 100, sorter: (a, b) => a.singletonEntities - b.singletonEntities, render: (value: number, row) => `${formatNumber(value)} · ${formatPercent(value / Math.max(1, row.entities))}` },
    { title: "关系数", dataIndex: "assignments", width: 104, sorter: (a, b) => a.assignments - b.assignments, render: (value: number) => formatNumber(value) },
    { title: "Top 10 占比", dataIndex: "topTenShare", width: 106, sorter: (a, b) => a.topTenShare - b.topTenShare, render: (value: number) => formatPercent(value) },
    { title: "HHI", dataIndex: "hhi", width: 92, sorter: (a, b) => a.hhi - b.hhi, render: (value: number) => value.toFixed(4) },
    { title: "结构判断", key: "interpretation", width: 120, sorter: (a, b) => a.hhi - b.hhi, render: (_, row) => row.hhi < 0.01 ? "高度分散" : row.hhi < 0.05 ? "轻度集中" : "集中" }
  ];

  const detailMeta: Record<DetailDataset, { title: string; subtitle: string; count: number }> = {
    year: { title: "年度基准表", subtitle: "发行年口径的规模、技术与覆盖率横向比较", count: data?.yearlyMetrics.length ?? 0 },
    source: { title: "来源运营表", subtitle: "来源级容量、清晰度、播放风险与版本复杂度", count: data?.sourceProfiles.length ?? 0 },
    entity: { title: "实体知识表", subtitle: "档案、图像、来源证据、置信度与增强状态", count: data?.entityKnowledge.profiles.length ?? 0 },
    provider: { title: "供应商记分卡", subtitle: "覆盖、错误、尝试次数与 90 天新鲜度", count: data?.dataQuality.metadataProviders.length ?? 0 },
    format: { title: "影音格式资产表", subtitle: "视频、音频、封装与扩展名的文件和容量占比", count: formatRows.length },
    issues: { title: "问题作品清单", subtitle: "结构化问题、字段缺失和异常状态的作品级明细", count: data?.dataQuality.exceptionWorks.length ?? 0 },
    jobs: { title: "生产任务类型表", subtitle: "历史任务尝试的成功率、耗时与最近活动", count: data?.operations.jobTypes.length ?? 0 },
    ingestion: { title: "自动采集批次表", subtitle: "批次扫描、筛选、移动、冲突、预览与耗时", count: data?.operations.recentIngestionRuns.length ?? 0 },
    assets: { title: "当前派生资产表", subtitle: "当前状态快照；不同阶段按各自适用对象计算", count: data?.operations.pipelineStages.length ?? 0 },
    failures: { title: "历史失败任务表", subtitle: "最近 80 条失败尝试，保留错误摘要与重试次数", count: data?.operations.failedJobDetails.length ?? 0 },
    concentration: { title: "内容维度集中度表", subtitle: "实体长尾、Top 10 占比与 HHI 的统一结构判断", count: data?.dataQuality.facetConcentration.length ?? 0 }
  };

  const renderViewNavigation = () => (
    <nav aria-label="馆藏分析视图" className="analytics-view-nav" ref={viewNavRef}>
      {viewOptions.map(({ key, label, hint, icon: Icon }) => (
        <button aria-current={activeView === key ? "page" : undefined} className={activeView === key ? "is-active" : ""} key={key} onClick={() => handleViewChange(key)} type="button">
          <Icon size={16} /><span><strong>{label}</strong><small>{hint}</small></span>
        </button>
      ))}
    </nav>
  );

  return (
    <main className="library-analytics-dashboard">
      <header className="analytics-page-header">
        <div className="analytics-heading-row">
          <Button className="analytics-back-button" icon={<ArrowLeft size={15} />} onClick={onBack} type="text">返回我的</Button>
          <span className="analytics-header-rule" />
          <div className="analytics-heading-copy">
            <span className="analytics-kicker">COLLECTION INTELLIGENCE LAB</span>
            <Typography.Title level={1}>馆藏分析中枢</Typography.Title>
            <Typography.Text>从全年时间、内容关系、技术存储、生产资产与数据治理，多维拆解整个媒体馆藏</Typography.Text>
          </div>
        </div>
        <div className="analytics-header-controls">
          <label><span>发行年份</span><Select aria-label="按发行年份筛选馆藏分析" onChange={(value) => setSelectedYear(value === "all" ? null : Number(value))} options={yearOptions} popupMatchSelectWidth={false} value={selectedYear === null ? "all" : String(selectedYear)} /></label>
          <label><span>主度量</span><Segmented<AnalyticsMeasure> onChange={setMeasure} options={[{ label: "作品", value: "works" }, { label: t("文件"), value: "files" }, { label: t("容量"), value: "bytes" }]} size="small" value={measure} /></label>
          <Tooltip title="查看统一指标定义、分母与数据来源"><Button className="analytics-display-audit-button" icon={<BookOpenCheck size={16} />} onClick={() => setMetricDefinitionsOpen(true)}>统计口径</Button></Tooltip>
          <Tooltip title="查看数据分析师对图表与表格的展示审计"><Button className="analytics-display-audit-button" icon={<ChartNoAxesCombined size={16} />} onClick={() => setVisualAuditOpen(true)}>展示审计</Button></Tooltip>
          <Tooltip title="忽略缓存并重新计算馆藏数据"><Button aria-label="刷新馆藏分析" disabled={refreshAnalytics.isPending} icon={<RefreshCw className={analytics.isFetching || analyticsSummary.isFetching || refreshAnalytics.isPending ? "spin" : ""} size={16} />} onClick={() => refreshAnalytics.mutate({ year: selectedYear, section: activeView, mode: activeView === "content" ? contentMode : undefined, matrixId: activeView === "content" && contentMode === "relations" ? selectedCrossMatrixId : undefined })} /></Tooltip>
          {(data ?? summaryData) && <span className="analytics-freshness"><i />数据更新至 {formatDateTime(latestTimestamp((data ?? summaryData)!.freshness.indexedAt, (data ?? summaryData)!.freshness.metadataUpdatedAt))}</span>}
        </div>
      </header>

      {analyticsSummary.isError ? (
        <section className="analytics-error" role="alert">
          <Database size={24} />
          <div><strong>暂时无法读取馆藏摘要</strong><span>{analyticsSummary.error instanceof Error ? analyticsSummary.error.message : "请稍后重试"}</span></div>
          <Button onClick={() => void analyticsSummary.refetch()}>{t("重新加载")}</Button>
        </section>
      ) : analytics.isPending && summaryData ? (
        <AnalyticsSummaryPreview data={summaryData} />
      ) : analytics.isPending ? (
        <AnalyticsDashboardSkeleton />
      ) : analytics.isError || !data ? (
        <section className="analytics-error" role="alert">
          <Database size={24} />
          <div><strong>暂时无法读取馆藏分析</strong><span>{analytics.error instanceof Error ? analytics.error.message : "请稍后重试"}</span></div>
          <Button onClick={() => void analytics.refetch()}>{t("重新加载")}</Button>
        </section>
      ) : (
        <>
          <section className="analytics-scope-banner" aria-label="统计口径">
            <div><Sparkles size={15} /><strong>{data.scope.label}</strong><span>作品按番号去重；内容与实体按作品计；技术、格式与容量按媒体文件计</span></div>
            <small>{activeView === "operations" ? "生产指标按任务更新时间统计，不受发行年份筛选影响" : selectedYear === null ? "包含发行日期缺失作品；入库历史以首次索引时间为准" : "年份筛选来自爬取发行日期；日期缺失作品只计入全部馆藏"}</small>
          </section>

          {!isMobileLayout && renderViewNavigation()}

          {activeView === "operations" ? (
            <section className="analytics-metric-grid analytics-operation-metrics" aria-label="生产资产核心指标">
              <MetricCard badge="历史尝试" hint={`${formatNumber(data.operations.summary.readyJobs)} 成功 · ${formatNumber(data.operations.summary.failedJobs)} 失败`} icon={CircleGauge} label="任务成功率" trend={data.operations.jobDaily.map((item) => item.total)} value={formatPercent(data.operations.summary.successRate)} />
              <MetricCard badge="当前状态" hint="失败与取消合计；不等同历史失败尝试" icon={ShieldAlert} label="当前资产异常" tone="pink" value={formatNumber(data.operations.summary.currentAssetFailures)} />
              <MetricCard badge="当前状态" hint={`${formatNumber(data.operations.summary.runningJobs)} 个任务正在运行`} icon={Workflow} label="等待与运行" tone="gold" value={formatNumber(data.operations.summary.currentAssetPending)} />
              <MetricCard badge={`${formatNumber(data.operations.summary.ingestionRuns)} 批`} hint={`最近活动 ${formatDateTime(data.operations.summary.latestActivityAt)}`} icon={PackageCheck} label="累计自动入库" tone="blue" value={formatNumber(data.operations.summary.ingestionMoved)} />
            </section>
          ) : activeView === "content" && contentMode === "prefixes" ? null : (
            <section className="analytics-metric-grid" aria-label="馆藏核心指标">
              <MetricCard hint={`${formatNumber(data.summary.variants)} 个额外文件版本`} icon={PanelsTopLeft} label="去重作品" trend={data.yearlyMetrics.map((item) => item.works)} value={formatNumber(data.summary.works)} />
              <MetricCard hint="当前筛选范围内的视频资产" icon={MonitorPlay} label="媒体文件" tone="blue" trend={data.yearlyMetrics.map((item) => item.files)} value={formatNumber(data.summary.files)} />
              <MetricCard hint={`平均 ${formatBytes(data.summary.averageFileBytes)} / 文件`} icon={HardDrive} label="存储体量" tone="gold" trend={data.yearlyMetrics.map((item) => item.bytes)} value={formatBytes(data.summary.totalBytes)} />
              <MetricCard hint={`平均 ${formatMinutes(data.summary.averageDurationSeconds / 60)} / 文件`} icon={History} label="总片长" tone="pink" trend={data.yearlyMetrics.map((item) => item.durationSeconds)} value={formatHours(data.summary.totalDurationSeconds)} />
              <MetricCard badge="多版本" hint="额外版本占文件总数，不等同可回收空间" icon={GitBranch} label="版本复杂度" trend={data.yearlyMetrics.map((item) => item.variantRate)} value={formatPercent(data.summary.variantRate)} />
              <MetricCard badge="元数据" hint={`${formatNumber(data.summary.readyMetadataWorks)} 部已就绪`} icon={BadgeCheck} label="数据覆盖" tone="blue" trend={data.yearlyMetrics.map((item) => item.metadataCoverage)} value={formatPercent(data.summary.metadataCoverage)} />
              <MetricCard badge="播放器" hint={`转码或不支持风险 ${formatPercent(data.summary.playbackRiskRate)}`} icon={CircleGauge} label={t("原生播放")} tone="gold" value={formatPercent(data.summary.nativePlaybackRate)} />
              <MetricCard badge={`n=${formatNumber(data.summary.scoredWorks)}`} hint={`评分覆盖 ${formatPercent(data.summary.scoredWorks / Math.max(1, data.summary.works))}`} icon={ChartNoAxesCombined} label="有效均分" tone="pink" trend={data.yearlyMetrics.map((item) => item.averageScore)} value={data.summary.averagePositiveScore > 0 ? data.summary.averagePositiveScore.toFixed(2) : "—"} />
            </section>
          )}

          {isMobileLayout && (
            <div className="analytics-mobile-view-switcher">
              <div className="analytics-mobile-view-switcher-heading">
                <span><strong>选择分析视图</strong><small>馆藏概览保持在上方，切换后直接查看对应数据</small></span>
                <em>{viewOptions.find((item) => item.key === activeView)?.label}</em>
              </div>
              {renderViewNavigation()}
            </div>
          )}

          <div className="analytics-view-content-anchor" ref={viewContentRef}>
            <MotionSurface className="analytics-view-motion" label="正在切换分析视图" motionKey={activeView}>
              <>

          {activeView === "overview" && (
            <>
              <section className="analytics-insight-grid" aria-label="快速洞察">
                <InsightCard icon={CalendarDays} label="发行峰值年" note="按去重作品计" value={peakYear ? `${peakYear.year} · ${formatNumber(peakYear.works)} 部` : "—"} />
                <InsightCard icon={Activity} label="全年峰值月" note="跨年份月份汇总" value={peakMonth ? `${peakMonth.month} 月 · ${formatNumber(peakMonth.works)} 部` : "—"} />
                <InsightCard icon={HardDrive} label="最大存储来源" note={`${formatPercent((data.sourceProfiles[0]?.bytes ?? 0) / Math.max(1, data.summary.totalBytes))} 的容量`} value={data.sourceProfiles[0]?.label ?? "—"} />
                <InsightCard icon={UserRound} label="高频演员" note={`${formatPercent((data.facets.actor.items[0]?.works ?? 0) / Math.max(1, data.summary.works))} 的馆藏作品`} value={data.facets.actor.items[0]?.label ?? "—"} />
                <InsightCard icon={ShieldAlert} label="结构化质量问题" note={`${data.dataQuality.exceptionWorks.length} 部高优先级样本`} value={`${formatNumber(data.dataQuality.issues.reduce((sum, item) => sum + item.works, 0))} 次影响`} />
              </section>

              <section className="analytics-section">
                <header className="analytics-section-heading"><div><LayoutDashboard size={18} /><span><strong>馆藏驾驶舱</strong><small>默认视图同时回答规模、变化、构成、存储与数据可信度</small></span></div></header>
                <div className="analytics-grid analytics-overview-grid">
                  <AnalyticsCard className="analytics-card-wide analytics-decision-card" extra={<span className="analytics-card-toggle"><Segmented onChange={(value) => setOverviewLens(value as OverviewLens)} options={[{ label: "规模结构", value: "scale" }, { label: "数据可信", value: "quality" }, { label: "风险行动", value: "risk" }]} size="small" value={overviewLens} /></span>} icon={CircleGauge} subtitle="同一组真实指标按管理问题重排；轨道均保留各自明确分母" title="驾驶舱决策镜头">
                    <MotionSurface className="analytics-subview-motion" label="正在切换驾驶舱决策镜头" motionKey={overviewLens}><DiagnosticSignalBoard items={overviewSignals} /></MotionSurface>
                  </AnalyticsCard>
                  <AnalyticsCard className="analytics-card-release-history" extra={peakYear && <span className="analytics-stat-chip">峰值 {peakYear.year} · {formatNumber(peakYear.works)} {t("部")}</span>} icon={ChartNoAxesCombined} subtitle={`${formatNumber(releaseDateCoverage?.value ?? 0)} 部具有可靠发行日期 · 年度连续走势`} title="发行年份曲线">
                    <ReleaseHistoryChart points={data.releaseHistory} selectedYear={selectedYear} />
                  </AnalyticsCard>
                  <AnalyticsCard icon={HardDrive} subtitle="面积按字节 · 同时标注来源播放风险" title="存储来源 Treemap"><StorageTreemap items={data.sourceProfiles} /></AnalyticsCard>
                  <AnalyticsCard icon={Boxes} subtitle={`当前主度量：${measureLabel(measure)} · 可在页首切换`} title="馆藏结构"><SegmentedDistribution items={distributionToSegments(data.libraryMix, measure)} total={measure === "works" ? data.summary.works : measure === "files" ? data.summary.files : data.summary.totalBytes} /></AnalyticsCard>
                  <AnalyticsCard className="analytics-card-growth" extra={<span className="analytics-stat-chip">索引历史始于 {data.freshness.firstSeenAt?.slice(0, 10) ?? "未知"}</span>} icon={Activity} subtitle="蓝柱为每日新增（对数尺度），橙线为累计文件" title="入库增长组合图"><GrowthComboChart points={data.catalogGrowth} /></AnalyticsCard>
                  <AnalyticsCard icon={ShieldCheck} subtitle="十个关键字段使用同一作品或文件分母" title="数据覆盖雷达"><CoverageRadar items={data.dataQuality.coverage} /></AnalyticsCard>
                  <AnalyticsCard icon={Database} subtitle="按作品数排序 · 就绪率与评分样本可在资产页查看" title="元数据供应商"><RankedBars items={data.dataQuality.metadataProviders.slice(0, 8).map((item) => ({ key: item.provider, label: item.provider, value: item.works, secondary: `就绪 ${formatPercent(item.readyWorks / Math.max(1, item.works))} · 评分 n=${formatNumber(item.scoredWorks)}` }))} /></AnalyticsCard>
                </div>
              </section>
            </>
          )}

          {activeView === "time" && (
            <section className="analytics-section">
              <header className="analytics-section-heading"><div><CalendarDays size={18} /><span><strong>时间脉络</strong><small>发行年×月、类别结构、全年季节性、首次入库和年度基准互相校验</small></span></div></header>
              <div className="analytics-insight-grid analytics-view-insights" aria-label="时间分析摘要">
                <InsightCard icon={CalendarDays} label="馆藏中位发行年" note="按去重作品加权" value={medianReleaseYear ? `${medianReleaseYear} 年` : "—"} />
                <InsightCard icon={ChartNoAxesCombined} label="发行峰值年" note="按可靠发行日期" value={peakYear ? `${peakYear.year} · ${formatNumber(peakYear.works)} 部` : "—"} />
                <InsightCard icon={Activity} label="最大年度同比" note="完整与未完整年份均原样保留" value={strongestGrowthYear ? `${strongestGrowthYear.year} · ${formatSignedPercent(strongestGrowthYear.workGrowthRate)}` : "—"} />
                <InsightCard icon={CalendarDays} label="全年峰值月" note="跨有效发行年份汇总" value={peakMonth ? `${peakMonth.month} 月 · ${formatNumber(peakMonth.works)} 部` : "—"} />
                <InsightCard icon={Database} label="最近索引日新增" note={latestGrowthPoint?.day ?? "暂无索引日"} value={latestGrowthPoint ? `${formatNumber(latestGrowthPoint.files)} 文件` : "—"} />
              </div>
              <div className="analytics-grid analytics-time-grid">
                <AnalyticsCard className="analytics-card-wide" extra={<span className="analytics-card-toggle"><Segmented onChange={(value) => setTimeHeatMode(value as TimeHeatMode)} options={[{ label: "作品数", value: "works" }, { label: "年内占比", value: "share" }]} size="small" value={timeHeatMode} /></span>} icon={ScanSearch} subtitle={`${formatNumber(data.releaseHeatmap.length)} 个有效年月份 · ${timeHeatMode === "share" ? "按各发行年内部归一化，突出季节性" : "按去重作品绝对规模着色"} · 点击筛选年份`} title="发行年 × 月热力矩阵"><MotionSurface className="analytics-subview-motion" label="正在切换时间热力矩阵口径" motionKey={timeHeatMode}><YearMonthHeatmap mode={timeHeatMode} onSelectYear={setSelectedYear} points={data.releaseHeatmap} /></MotionSurface></AnalyticsCard>
                <AnalyticsCard icon={ChartNoAxesCombined} subtitle="全部发行年份连续走势" title="发行年份曲线"><ReleaseHistoryChart points={data.releaseHistory} selectedYear={selectedYear} /></AnalyticsCard>
                <AnalyticsCard extra={<span className="analytics-card-toggle"><Segmented onChange={(value) => setTimeMixMode(value as TimeMixMode)} options={[{ label: "绝对规模", value: "absolute" }, { label: "100% 构成", value: "share" }]} size="small" value={timeMixMode} /></span>} icon={Boxes} subtitle={`最近十四个有效发行年 · ${timeMixMode === "share" ? "比较 JAV / FC2 年度结构" : "同时比较总量与类别"}`} title="年度类别构成"><MotionSurface className="analytics-subview-motion" label="正在切换年度类别构成" motionKey={timeMixMode}><CategoryStackedChart mode={timeMixMode} points={data.categoryYearTrend} /></MotionSurface></AnalyticsCard>
                <AnalyticsCard className="analytics-time-month-card" icon={CalendarDays} subtitle={selectedYear === null ? "所有年份按发行月份汇总" : `${selectedYear} 年完整月份视图`} title="全年月份节奏"><MonthlyBars points={data.releaseByMonth} /></AnalyticsCard>
                <AnalyticsCard className="analytics-card-span-2 analytics-time-yoy-card" extra={<span className="analytics-stat-chip">零线以上增长 · 以下收缩</span>} icon={BarChart3} subtitle="近十四个可比较发行年；当年数据未结束时同比仅作馆藏快照" title="发行年份同比变化"><YearGrowthBars items={data.yearlyMetrics} /></AnalyticsCard>
                <AnalyticsCard className="analytics-card-span-2 analytics-time-growth-card" icon={Activity} subtitle="实际有索引记录的日期；日报使用对数柱，累计使用线性折线" title="首次入库与累计增长"><GrowthComboChart points={data.catalogGrowth} /></AnalyticsCard>
                <AnalyticsCard className="analytics-card-wide analytics-table-card" extra={<span className="analytics-stat-chip">支持排序 · 横向滚动</span>} icon={TableProperties} subtitle="统一口径对照作品、文件、容量、片长、评分、清晰度与覆盖率" title="年度基准透视表"><Table columns={yearlyColumns} dataSource={data.yearlyMetrics} pagination={{ defaultPageSize: 10, pageSizeOptions: [10, 20, 30], showSizeChanger: true }} rowKey="year" scroll={{ x: 1150 }} size="small" /></AnalyticsCard>
              </div>
            </section>
          )}

          {activeView === "content" && (
            <section className="analytics-section">
              <header className="analytics-section-heading analytics-content-heading"><div><Network size={18} /><span><strong>内容宇宙</strong><small>演员、题材、厂商、导演、系列、年份与技术维度使用同一作品口径交叉分析</small></span></div><Segmented onChange={(value) => setContentMode(value as ContentMode)} options={[{ label: "演员洞察", value: "actors" }, { label: "全维实体", value: "entities" }, { label: "番号收录", value: "prefixes" }, { label: "交叉分析", value: "relations" }]} size="small" value={contentMode} /></header>
              {contentMode!=="prefixes"&&<section className="analytics-content-analyst" aria-label="馆藏分析师发现">
                <header><span><Sparkles size={16} /><strong>馆藏分析师发现</strong></span><small>点击信号直接进入对应矩阵与证据焦点</small></header>
                <div className="analytics-insight-grid analytics-cross-signals">
                  {data.crossAnalysis.signals.map((signal) => <button className={`is-${signal.tone}`} key={signal.key} onClick={() => { setContentMode("relations"); setSelectedCrossMatrixId(signal.matrixId); const matrix = data.crossAnalysis.matrices.find((item) => item.id === signal.matrixId); const row = matrix?.rows.find((item) => item.key === signal.rowKey); const column = matrix?.columns.find((item) => item.key === signal.columnKey); const cell = matrix?.cells.find((item) => item.rowKey === signal.rowKey && item.columnKey === signal.columnKey); if (matrix && row && column && cell) setSelectedCrossCell({ matrix, row, column, cell }); }} type="button"><span><Sparkles size={15} /></span><span><small>{signal.title}</small><strong>{signal.description}</strong></span></button>)}
                </div>
              </section>}
              <MotionSurface className="analytics-facet-motion" label="正在切换内容分析模式" motionKey={contentMode}>
                {contentMode === "prefixes" ? <LibraryPrefixAnalytics key={selectedYear??"all"} data={data.prefixAnalytics} year={selectedYear} onOpenEntity={onOpenEntity} onShowAllYears={()=>setSelectedYear(null)}/> : contentMode === "actors" ? (
                  <>
                    <div className="analytics-actor-toolbar">
                      <div><span className="analytics-card-icon"><UserRound size={16} /></span><span><small>联动焦点演员</small><strong>{selectedActor?.label ?? "暂无演员"}</strong><em>{selectedActor ? `${formatNumber(selectedActor.works)} 部 · ${formatNumber(selectedActor.activeYears)} 个活跃发行年${selectedActorScore ? ` · 校正评分 ${selectedActorScore.adjustedScore.toFixed(2)}` : ""}` : "选择演员后联动图表"}</em></span></div>
                      <div><Select filterOption={(input, option) => String(option?.label ?? "").toLocaleLowerCase().includes(input.toLocaleLowerCase())} onChange={setSelectedActorValue} options={actorSelectOptions} placeholder={t("选择演员")} showSearch value={selectedActor?.value} /><Button disabled={!selectedActor} icon={<UserRound size={14} />} onClick={() => selectedActor && onOpenEntity({ type: "actor", value: selectedActor.value, label: selectedActor.label })}>打开专题</Button></div>
                    </div>
                    <section className="analytics-insight-grid analytics-actor-insights" aria-label="演员分析摘要">
                      <InsightCard icon={UserRound} label="有效演员实体" note={`${formatNumber(data.actorAnalytics.scope.assignments)} 条作品关系`} value={formatNumber(data.actorAnalytics.scope.validActors)} />
                      <InsightCard icon={ShieldCheck} label="JAV 演员覆盖" note={`${formatNumber(data.actorAnalytics.scope.actorCoveredWorks)} / ${formatNumber(data.actorAnalytics.scope.totalWorks)} 部`} value={formatPercent(data.actorAnalytics.scope.actorCoverage)} />
                      <InsightCard icon={BarChart3} label="一次性长尾" note={`${formatNumber(actorSingletonBand?.assignments ?? 0)} 条作品关系`} value={formatPercent(actorSingletonBand?.actorShare ?? 0)} />
                      <InsightCard icon={Network} label="稳定共演关系" note={`当前演员连接 ${formatNumber(selectedActorPairCount)} 组`} value={`${formatNumber(data.actorAnalytics.collaboration.pairs.length)} 对`} />
                      <InsightCard icon={Database} label="演员档案覆盖" note={`出生日期 ${formatPercent(data.actorAnalytics.profileCompleteness.find((item) => item.key === "birthDates")?.rate ?? 0)}`} value={formatPercent(data.actorAnalytics.profileCompleteness.find((item) => item.key === "profiles")?.rate ?? 0)} />
                    </section>
                    <div className="analytics-grid analytics-content-grid analytics-actor-grid">
                      <AnalyticsCard className="analytics-card-span-2 analytics-actor-tail-card" extra={<span className="analytics-stat-chip">{formatNumber(data.actorAnalytics.scope.invalidActors)} 个解析残片已从分析层过滤</span>} icon={BarChart3} subtitle="对照演员实体占比与作品关系占比，识别单作长尾和高频核心" title="演员作品数长尾分布"><ActorLongTailChart items={data.actorAnalytics.workBands} /></AnalyticsCard>
                      <AnalyticsCard extra={<span className="analytics-stat-chip">仅 JAV · FC2 不适用</span>} icon={UsersRound} subtitle={`${formatNumber(data.actorAnalytics.scope.excludedFc2Works)} 部 FC2 从分母中排除`} title="单部作品演员规模"><SegmentedDistribution items={data.actorAnalytics.castSizeBands.map((item) => ({ key: item.key, label: item.label, value: item.works, secondary: item.key === "missing" ? "待补齐演员" : "按去重作品" }))} total={data.actorAnalytics.scope.totalWorks} /></AnalyticsCard>
                      <AnalyticsCard className="analytics-card-wide analytics-affinity-card" extra={<Segmented onChange={(value) => setActorMatrixMode(value as ActorMatrixMode)} options={[{ label: "稳健提升", value: "lift" }, { label: "演员内占比", value: "share" }, { label: "作品数", value: "works" }]} size="small" value={actorMatrixMode} />} icon={Tags} subtitle="规范化演员身份和题材同义词；点击单元格打开作品证据、时间变化与演员对比" title="演员 × 题材偏好矩阵"><ActorGenreAffinityMatrix data={data.actorAnalytics.genreAffinity} mode={actorMatrixMode} onSelectActor={setSelectedActorValue} onSelectCell={(actor, genre, cell) => setSelectedAffinityCell({ actor, genre, cell })} selectedActor={selectedActor?.value ?? ""} /></AnalyticsCard>
                      <AnalyticsCard className="analytics-card-wide" extra={<Segmented onChange={(value) => setActorActivityMode(value as ActorActivityMode)} options={[{ label: "演员内占比", value: "share" }, { label: "作品数", value: "works" }]} size="small" value={actorActivityMode} />} icon={CalendarDays} subtitle="Top 18 演员 × 最近十四个有效发行年；占比模式更容易比较不同馆藏规模" title="演员年度活跃矩阵"><ActorActivityMatrix data={data.actorAnalytics.activity} mode={actorActivityMode} onSelectActor={setSelectedActorValue} selectedActor={selectedActor?.value ?? ""} /></AnalyticsCard>
                      <AnalyticsCard className="analytics-card-span-2" extra={<span className="analytics-stat-chip">每位演员至少 10 个有效评分样本</span>} icon={ChartNoAxesCombined} subtitle="X=作品数（对数），Y=向 JAV 全局均分收缩后的评分，气泡=评分样本" title="演员规模 × 样本校正评分"><ActorScoreScatter data={data.actorAnalytics.score} onSelectActor={setSelectedActorValue} selectedActor={selectedActor?.value ?? ""} /></AnalyticsCard>
                      <AnalyticsCard icon={BadgeCheck} subtitle={`统一分母 ${formatNumber(data.actorAnalytics.scope.validActors)} 位有效演员；出生年代不再充当主图`} title="演员资料完整度"><ActorProfileCompleteness items={data.actorAnalytics.profileCompleteness} /></AnalyticsCard>
                      <AnalyticsCard className="analytics-card-span-2" extra={<span className="analytics-stat-chip">边阈值 ≥ 3 部共同作品</span>} icon={Network} subtitle="只展示当前焦点演员的一跳网络，避免全局毛线团；点击节点继续漫游" title={`${selectedActor?.label ?? t("演员")} · 稳定共演网络`}><ActorCollaborationGraph onSelectActor={setSelectedActorValue} pairs={data.actorAnalytics.collaboration.pairs} selectedActor={selectedActor} /></AnalyticsCard>
                      <AnalyticsCard extra={<Segmented onChange={(value) => setActorCoverageMode(value as ActorCoverageMode)} options={[{ label: "发行年", value: "year" }, { label: "供应商", value: "provider" }]} size="small" value={actorCoverageMode} />} icon={ShieldAlert} subtitle="仅 JAV 分母；轨道标记 80% 参考线，用于定位补数优先级" title="演员字段覆盖诊断"><ActorCoverageBars data={data.actorAnalytics} mode={actorCoverageMode} /></AnalyticsCard>
                      <AnalyticsCard className="analytics-card-span-2" icon={Activity} subtitle="按覆盖的发行年份数排序；结合首末发行日期判断馆藏时间跨度" title="头部演员发行跨度"><RankedBars items={[...data.actorAnalytics.activity.actors].sort((left, right) => right.activeYears - left.activeYears || right.works - left.works).slice(0, 14).map((item) => ({ key: item.value, label: item.label, value: item.activeYears, displayValue: `${formatNumber(item.activeYears)} 年`, secondary: `${item.firstReleaseDate?.slice(0, 4) ?? "—"} → ${item.lastReleaseDate?.slice(0, 4) ?? "—"} · ${formatNumber(item.works)} 部` }))} onSelect={(item) => setSelectedActorValue(item.key)} /></AnalyticsCard>
                      <AnalyticsCard icon={History} subtitle={`具有有效出生日期 ${formatNumber(data.entityKnowledge.actorBirthDecades.reduce((sum, item) => sum + item.actors, 0))} / ${formatNumber(data.actorAnalytics.scope.validActors)} 位；仅作资料结构观察`} title="演员出生年代（次级）"><Histogram items={data.entityKnowledge.actorBirthDecades.map((item) => ({ key: String(item.decade), label: `${item.decade}s`, actors: item.actors }))} valueKey="actors" /></AnalyticsCard>
                    </div>
                  </>
                ) : contentMode === "entities" ? (
                  <>
                    <div className="analytics-facet-toolbar" role="tablist" aria-label="内容实体维度">
                      {(Object.keys(facetLabels) as LibraryAnalyticsFacetType[]).map((type) => <button aria-selected={activeFacet === type} className={activeFacet === type ? "is-active" : ""} key={type} onClick={() => { setActiveFacet(type); setFacetSearch(""); }} role="tab" type="button"><span>{facetLabels[type]}</span><small>{formatNumber(data.facets[type].distinctValues)}</small></button>)}
                    </div>
                    <MotionSurface className="analytics-facet-motion" label="正在切换内容维度" motionKey={activeFacet}>
                      <div className="analytics-grid analytics-content-grid">
                        <AnalyticsCard className="analytics-card-span-2" extra={<span className="analytics-stat-chip">{formatNumber(activeFacetData?.totalAssignments ?? 0)} 条关系 · 覆盖 {formatPercent((activeFacetData?.coveredWorks ?? 0) / Math.max(1, data.summary.works))}</span>} icon={BarChart3} subtitle={`Top 16 柱形 + 累计关系占比线 · 当前维度 ${facetLabels[activeFacet]}`} title="实体 Pareto 集中度"><ParetoChart items={activeFacetData?.items ?? []} totalAssignments={activeFacetData?.totalAssignments ?? 0} /></AnalyticsCard>
                        <AnalyticsCard className="analytics-content-bubble-card" icon={ChartNoAxesCombined} subtitle="X=平均片长，Y=有效均分，气泡=作品数；至少 5 个评分样本" title="厂商评分 × 片长气泡散点"><BubbleScatter items={data.facets.maker.items} /></AnalyticsCard>
                        <AnalyticsCard className="analytics-card-wide" extra={<span className="analytics-stat-chip">Top 12 · 按共同作品排序</span>} icon={Network} subtitle="单一主度量改用排行条，直接比较高频组合；相对偏好请在演员点阵中查看" title="演员 × 题材高频组合"><ContentPairRanking matrix={data.contentMatrix} /></AnalyticsCard>
                        <AnalyticsCard className="analytics-card-wide analytics-table-card" extra={<Input allowClear onChange={(event) => setFacetSearch(event.target.value)} placeholder={`搜索${facetLabels[activeFacet]}名称或原值`} prefix={<Search size={13} />} value={facetSearch} />} icon={TableProperties} subtitle="可搜索、排序、分页并打开专题；评分同时显示样本量" title={`${facetLabels[activeFacet]}分析明细表`}><Table columns={facetColumns} dataSource={filteredFacetItems} pagination={{ defaultPageSize: 12, pageSizeOptions: [12, 24], showSizeChanger: true }} rowKey="value" scroll={{ x: 980 }} size="small" /></AnalyticsCard>
                        <AnalyticsCard className="analytics-card-span-2 analytics-table-card" icon={UserRound} subtitle="只统计当前范围已发现的实体；档案和增强均复用现有实体资料表" title="实体知识资产覆盖"><Table columns={entityColumns} dataSource={data.entityKnowledge.profiles} pagination={false} rowKey="type" scroll={{ x: 1240 }} size="small" /></AnalyticsCard>
                        <AnalyticsCard className="analytics-content-birth-card" icon={History} subtitle="已匹配演员档案中的出生年代；仅作资料覆盖观察" title="演员出生年代"><Histogram items={data.entityKnowledge.actorBirthDecades.map((item) => ({ key: String(item.decade), label: `${item.decade}s`, actors: item.actors }))} valueKey="actors" /></AnalyticsCard>
                      </div>
                    </MotionSurface>
                  </>
                ) : (
                  <>
                    <div className="analytics-cross-toolbar">
                      <div><span className="analytics-card-icon"><Network size={16} /></span><span><small>交叉关系工作台</small><strong>{selectedCrossMatrix?.title ?? "暂无矩阵"}</strong><em>{selectedCrossMatrix?.subtitle ?? "选择两个维度开始分析"}</em></span></div>
                      <div><Select onChange={(value) => { setSelectedCrossMatrixId(value); setSelectedCrossCell(null); }} options={(data.crossAnalysis.catalog ?? data.crossAnalysis.matrices).map((matrix) => ({ label: matrix.title, value: matrix.id }))} value={selectedCrossMatrixId} /><Segmented onChange={(value) => setCrossMatrixMode(value as CrossMatrixMode)} options={[{ label: "稳健提升", value: "lift" }, { label: "纵轴占比", value: "share" }, { label: selectedCrossMatrix?.grain === "files" ? "文件数" : "作品数", value: "value" }]} size="small" value={crossMatrixMode} /></div>
                    </div>
                    <section className="analytics-cross-scope">
                      <span><strong>{formatNumber(data.crossAnalysis.scope.canonicalActors)}</strong><small>规范化演员</small><em>原始 {formatNumber(data.crossAnalysis.scope.rawActors)}</em></span>
                      <span><strong>{formatNumber(data.crossAnalysis.scope.canonicalGenres)}</strong><small>规范化题材</small><em>原始 {formatNumber(data.crossAnalysis.scope.rawGenres)}</em></span>
                      <span><strong>{(data.crossAnalysis.catalog ?? data.crossAnalysis.matrices).length}</strong><small>可切换矩阵</small><em>作品/文件口径分离</em></span>
                      <span><strong>{data.crossAnalysis.scope.recentWindow ?? "—"}</strong><small>最近变化窗口</small><em>对照 {data.crossAnalysis.scope.previousWindow ?? "—"}</em></span>
                    </section>
                    {selectedCrossMatrix ? <AnalyticsCard className="analytics-card-wide analytics-cross-card" extra={<span className="analytics-stat-chip">{formatNumber(selectedCrossMatrix.total)} {selectedCrossMatrix.grain === "files" ? t("文件") : "作品"} · 支持筛选与下钻焦点</span>} icon={Network} subtitle={selectedCrossMatrix.subtitle} title={selectedCrossMatrix.title}><CrossAnalysisMatrixExplorer matrix={selectedCrossMatrix} mode={crossMatrixMode} onSelect={setSelectedCrossCell} selection={selectedCrossCell} /></AnalyticsCard> : <Empty description="暂无交叉矩阵" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
                  </>
                )}
              </MotionSurface>
            </section>
          )}

          {activeView === "technical" && (
            <section className="analytics-section">
              <header className="analytics-section-heading analytics-mode-heading"><div><Cpu size={18} /><span><strong>技术与存储</strong><small>把清晰度、编码、容量、片长离散度、版本复杂度和来源风险交叉分析</small></span></div><Segmented onChange={(value) => setTechnicalMeasure(value as TechnicalMeasure)} options={[{ label: "按文件", value: "files" }, { label: "按容量", value: "bytes" }]} size="small" value={technicalMeasure} /></header>
              <div className="analytics-insight-grid analytics-view-insights" aria-label="技术存储分析摘要">
                <InsightCard icon={MonitorPlay} label="1080p+ 文件" note={`${formatNumber(Math.round(data.summary.fullHdShare * data.summary.files))} / ${formatNumber(data.summary.files)} 文件`} value={formatPercent(data.summary.fullHdShare)} />
                <InsightCard icon={Cpu} label="主导视频编码" note={`${formatPercent((data.technical.codecs[0]?.files ?? 0) / Math.max(1, data.summary.files))} 的文件`} value={data.technical.codecs[0]?.label ?? "—"} />
                <InsightCard icon={HardDrive} label="平均单文件体积" note={`${formatBytes(data.summary.totalBytes)} 总容量`} value={formatBytes(data.summary.averageFileBytes)} />
                <InsightCard icon={ShieldAlert} label="最高风险来源" note={largestSourceRisk ? `${formatNumber(largestSourceRisk.riskFiles)} / ${formatNumber(largestSourceRisk.files)} 文件` : "暂无来源"} value={largestSourceRisk ? `${largestSourceRisk.label} · ${formatPercent(largestSourceRisk.riskFiles / Math.max(1, largestSourceRisk.files))}` : "—"} />
                <InsightCard icon={BadgeCheck} label="技术参数覆盖" note={`${formatNumber(data.dataQuality.coverage.find((item) => item.key === "probe")?.value ?? 0)} 个文件`} value={formatPercent(data.dataQuality.coverage.find((item) => item.key === "probe")?.rate ?? 0)} />
              </div>
              <div className="analytics-grid analytics-technical-grid-v2">
                <AnalyticsCard icon={MonitorPlay} subtitle={`清晰度构成 · 当前按${technicalMeasure === "bytes" ? t("容量") : "文件数"}计`} title="画面规格"><MotionSurface className="analytics-subview-motion" label="正在切换画面规格度量" motionKey={technicalMeasure}><SegmentedDistribution items={distributionToSegments(data.technical.resolutions, technicalMeasure)} total={data.technical.resolutions.reduce((sum, item) => sum + item[technicalMeasure], 0)} /></MotionSurface></AnalyticsCard>
                <AnalyticsCard icon={PackageCheck} subtitle={`播放器处理路径 · 当前按${technicalMeasure === "bytes" ? t("容量") : "文件数"}计`} title={t("播放兼容")}><MotionSurface className="analytics-subview-motion" label="正在切换播放兼容度量" motionKey={technicalMeasure}><SegmentedDistribution items={distributionToSegments(data.technical.compatibility, technicalMeasure)} total={data.technical.compatibility.reduce((sum, item) => sum + item[technicalMeasure], 0)} /></MotionSurface></AnalyticsCard>
                <AnalyticsCard className="analytics-technical-version-card" icon={GitBranch} subtitle="按番号统计文件版本数量；额外占用仅作分析提示" title="版本复杂度"><SegmentedDistribution items={data.technical.variantBands.map((item) => ({ key: item.key, label: item.label, value: item.works, secondary: item.extraBytes > 0 ? `额外约 ${formatBytes(item.extraBytes)}` : `${item.files} 文件` }))} total={data.summary.works} /></AnalyticsCard>
                <AnalyticsCard className="analytics-card-wide" extra={<span className="analytics-stat-chip">来源分母独立 · 风险越低越好</span>} icon={CircleGauge} subtitle="容量集中、高清、原生播放、技术参数和播放风险在同一来源行核对" title="存储来源健康记分卡"><SourceHealthScorecard items={data.sourceProfiles} /></AnalyticsCard>
                <AnalyticsCard className="analytics-card-wide" extra={<span className="analytics-stat-chip">Top 6 / 组 · 当前按{technicalMeasure === "bytes" ? t("容量") : t("文件")}</span>} icon={Boxes} subtitle="视频编码、音频编码、封装格式和扩展名使用同一度量并排比较" title="影音格式资产构成"><MotionSurface className="analytics-subview-motion" label="正在切换格式资产度量" motionKey={technicalMeasure}><TechnicalFormatBoard data={data.technical} measure={technicalMeasure} /></MotionSurface></AnalyticsCard>
                <AnalyticsCard icon={HardDrive} subtitle="实际文件大小区间 · 文件数分布" title="文件体积直方图"><Histogram items={data.technical.fileSizeBands} valueKey="files" /></AnalyticsCard>
                <AnalyticsCard icon={History} subtitle="实际视频片长区间 · 文件数分布" title="片长直方图"><Histogram items={data.technical.durationBands} valueKey="files" /></AnalyticsCard>
                <AnalyticsCard className="analytics-technical-score-card" icon={BarChart3} subtitle={`5 分制 · ${formatNumber(data.summary.scoredWorks)} 部有效评分 · 均值 ${data.summary.averagePositiveScore.toFixed(2)}`} title="评分分布"><Histogram items={data.technical.scoreBands} valueKey="works" /></AnalyticsCard>
                <AnalyticsCard className="analytics-card-span-2" icon={Cpu} subtitle={`热度按${technicalMeasure === "bytes" ? "占用容量" : "文件数"}；悬停同时查看另一口径`} title="清晰度 × 视频编码矩阵"><MotionSurface className="analytics-subview-motion" label="正在切换编码矩阵度量" motionKey={technicalMeasure}><CodecResolutionMatrix items={data.technical.resolutionCodecMatrix} measure={technicalMeasure} /></MotionSurface></AnalyticsCard>
                <AnalyticsCard className="analytics-technical-tags-card" icon={Tags} subtitle="文件名解析出的版本、字幕与来源标记" title="版本标记词云"><div className="analytics-tag-cloud">{data.technical.variantTags.map((item, index) => <span className={index < 4 ? "is-prominent" : ""} key={item.tag}><strong>{item.tag}</strong><small>{formatNumber(item.files)}</small></span>)}</div></AnalyticsCard>
                <AnalyticsCard className="analytics-card-wide" extra={<span className="analytics-stat-chip">P25 / 中位 / P75 · 异常上界截断</span>} icon={ChartNoAxesCombined} subtitle="头部厂商作品片长的离散度；每一行使用独立作品样本" title="厂商片长箱线图"><DurationBoxPlot items={data.technical.durationBoxPlots} /></AnalyticsCard>
                <AnalyticsCard className="analytics-card-wide analytics-table-card" icon={HardDrive} subtitle="来源级作品、文件、容量、清晰度、播放风险、探测覆盖与版本率" title="存储来源运营表"><Table columns={sourceColumns} dataSource={data.sourceProfiles} pagination={false} rowKey="key" scroll={{ x: 1180 }} size="small" /></AnalyticsCard>
              </div>
            </section>
          )}

          {activeView === "operations" && (
            <section className="analytics-section analytics-operations-section">
              <header className="analytics-section-heading"><div><Workflow size={18} /><span><strong>生产与派生资产</strong><small>把采集批次、历史任务尝试、当前资产状态、处理时长和失败原因放进同一运营面</small></span></div><span className="analytics-stat-chip">全局任务时间 · 不跟随发行年</span></header>
              <div className="analytics-insight-grid analytics-operation-insights" aria-label="生产运营摘要">
                <InsightCard icon={ListChecks} label="采集批次状态" note={`${formatNumber(data.operations.ingestionSummary.failed)} 失败批次`} value={`${formatNumber(data.operations.ingestionSummary.completed)} 完成 · ${formatNumber(data.operations.ingestionSummary.partial)} 部分`} />
                <InsightCard icon={ScanSearch} label="最近扫描规模" note={formatDateTime(data.operations.ingestionSummary.latestRunAt)} value={`${formatNumber(data.operations.ingestionSummary.latestScanned)} 个候选文件`} />
                <InsightCard icon={PackageCheck} label="符合到移动" note={`${formatNumber(data.operations.ingestionSummary.conflicts)} 冲突 · ${formatNumber(data.operations.ingestionSummary.unstable)} 未稳定`} value={formatPercent(data.operations.ingestionSummary.moved / Math.max(1, data.operations.ingestionSummary.eligible))} />
                <InsightCard icon={CalendarDays} label="触发构成" note="全部历史批次" value={`${formatNumber(data.operations.ingestionSummary.manual)} 手动 · ${formatNumber(data.operations.ingestionSummary.scheduled)} 定时`} />
                <InsightCard icon={MonitorPlay} label="预览任务派发" note="来自采集批次统计快照" value={`${formatNumber(data.operations.ingestionSummary.previewsQueued)} 条排队记录`} />
              </div>
              {selectedJobType && <div className="analytics-operation-focus" aria-live="polite"><span><small>联动焦点任务</small><strong>{selectedJobType.label}</strong></span><span><small>历史尝试</small><strong>{formatNumber(selectedJobType.total)}</strong></span><span><small>成功率</small><strong>{formatPercent(selectedJobType.successRate)}</strong></span><span><small>平均耗时</small><strong>{formatDurationSeconds(selectedJobType.averageDurationSeconds)}</strong></span><span><small>历史失败</small><strong>{formatNumber(selectedJobType.failed)}</strong></span><span><small>最近活动</small><strong>{formatDateTime(selectedJobType.latestUpdatedAt)}</strong></span></div>}
              <div className="analytics-grid analytics-operations-grid">
                <AnalyticsCard className="analytics-card-span-2" extra={<span className="analytics-stat-chip">点击任务联动焦点 · 成功率分母仅含已决状态</span>} icon={Workflow} subtitle="横条保留成功、失败、等待与运行状态；精确次数见下方表格" title="任务类型状态构成"><JobStatusBars items={data.operations.jobTypes} onSelect={setSelectedJobTypeKey} selectedKey={selectedJobType?.key ?? ""} /></AnalyticsCard>
                <AnalyticsCard extra={<span className="analytics-card-toggle"><Segmented onChange={(value) => setJobDailyMode(value as JobDailyMode)} options={[{ label: "产出量", value: "volume" }, { label: "成功率", value: "rate" }]} size="small" value={jobDailyMode} /></span>} icon={Activity} subtitle={`以最近任务活动日为锚点展示 35 天 · ${jobDailyMode === "rate" ? "每日 100% 构成" : "产出量使用对数尺度"}`} title="近期生产产出"><MotionSurface className="analytics-subview-motion" label="正在切换生产产出度量" motionKey={jobDailyMode}><DailyJobBars mode={jobDailyMode} points={data.operations.jobDaily} /></MotionSurface></AnalyticsCard>
                <AnalyticsCard className="analytics-card-span-2" extra={<span className="analytics-stat-chip">9 类任务 · 虚线为中位基准</span>} icon={ChartNoAxesCombined} subtitle="X=历史尝试次数（对数），Y=成功率；点击点联动上方焦点任务" title="任务吞吐 × 可靠性矩阵"><JobReliabilityMatrix items={data.operations.jobTypes} onSelect={setSelectedJobTypeKey} selectedKey={selectedJobType?.key ?? ""} /></AnalyticsCard>
                <AnalyticsCard icon={PackageCheck} subtitle="最近十个存在符合文件的批次；亮色为已移动，灰色为其余符合项" title="采集批次转化"><IngestionRunBars items={data.operations.recentIngestionRuns} /></AnalyticsCard>
                <AnalyticsCard className="analytics-card-span-2" extra={<span className="analytics-stat-chip">当前状态快照 · 各阶段分母不同</span>} icon={Layers3} subtitle="技术探测和内容预览覆盖全库；字幕、海报、HLS 与 Remux 仅统计已请求对象" title="当前派生资产状态"><PipelineStageBars items={data.operations.pipelineStages} /></AnalyticsCard>
                <AnalyticsCard icon={ShieldAlert} subtitle="按各阶段自身异常影响率排序；粉色为失败，金色为等待" title="当前资产关注队列"><PipelinePriorityBars items={data.operations.pipelineStages} /></AnalyticsCard>
                <AnalyticsCard className="analytics-card-wide analytics-table-card" extra={<span className="analytics-stat-chip">历史任务尝试 · 支持排序</span>} icon={TableProperties} subtitle="对比每类任务的吞吐、成功率、平均耗时和最近活动" title="生产任务记分卡"><Table columns={jobTypeColumns} dataSource={data.operations.jobTypes} pagination={false} rowKey="key" scroll={{ x: 980 }} size="small" /></AnalyticsCard>
                <AnalyticsCard className="analytics-card-wide analytics-table-card" extra={<span className="analytics-stat-chip">最近 24 批 · 精确批次口径</span>} icon={Database} subtitle="扫描量不可跨批相加作为库存；移动、冲突、未稳定和处理耗时可逐批核对" title="自动采集批次"><Table columns={ingestionColumns} dataSource={data.operations.recentIngestionRuns} pagination={{ defaultPageSize: 8, pageSizeOptions: [8, 16, 24], showSizeChanger: true }} rowKey="id" scroll={{ x: 1600 }} size="small" /></AnalyticsCard>
                <AnalyticsCard className="analytics-card-wide analytics-table-card" extra={<span className="analytics-stat-chip">最近 80 条历史失败尝试</span>} icon={ShieldAlert} subtitle="历史失败会包含已经重试成功的旧尝试；当前故障请以上方资产状态为准" title="失败任务诊断"><Table columns={failureColumns} dataSource={data.operations.failedJobDetails} pagination={{ defaultPageSize: 10, pageSizeOptions: [10, 20, 40], showSizeChanger: true }} rowKey="id" scroll={{ x: 1200 }} size="small" /></AnalyticsCard>
              </div>
            </section>
          )}

          {activeView === "quality" && (
            <section className="analytics-section">
              <header className="analytics-section-heading"><div><ShieldCheck size={18} /><span><strong>数据治理与行动</strong><small>从覆盖率描述升级到积压、供应商新鲜度、实体证据深度、内容集中度和可执行问题明细</small></span></div></header>
              <div className="analytics-insight-grid analytics-view-insights" aria-label="数据治理分析摘要">
                <InsightCard icon={ShieldAlert} label="最大字段缺口" note={largestCoverageGap ? `${formatNumber(largestCoverageGap.total - largestCoverageGap.value)} / ${formatNumber(largestCoverageGap.total)} ${largestCoverageGap.unit === "files" ? t("文件") : "作品"}` : "暂无维度"} value={largestCoverageGap ? `${largestCoverageGap.label} · ${formatPercent(1 - largestCoverageGap.rate)} 缺口` : "—"} />
                <InsightCard icon={Database} label="未识别供应商作品" note="元数据供应商唯一键" value={formatNumber(data.dataQuality.metadataProviders.find((item) => item.key === "__unrecognized__")?.works ?? 0)} />
                <InsightCard icon={History} label="90 天未刷新" note="按元数据更新时间" value={formatNumber(data.dataQuality.backlog.find((item) => item.key === "stale")?.value ?? 0)} />
                <InsightCard icon={FileSearch} label="高优先级问题样本" note="明细表最多保留 Top 80" value={t("{{p0}} 部", { p0: formatNumber(data.dataQuality.exceptionWorks.length) })} />
                <InsightCard icon={UserRound} label="实体增强未找到" note="演员、系列、厂商、厂牌与导演" value={formatNumber(data.dataQuality.backlog.find((item) => item.key === "entityNotFound")?.value ?? 0)} />
              </div>
              <div className="analytics-grid analytics-quality-grid-v2">
                <AnalyticsCard className="analytics-card-wide analytics-decision-card" extra={<span className="analytics-card-toggle"><Segmented onChange={(value) => setQualityLens(value as QualityLens)} options={[{ label: "字段缺口", value: "coverage" }, { label: "供应商新鲜度", value: "freshness" }, { label: "行动积压", value: "actions" }]} size="small" value={qualityLens} /></span>} icon={ListChecks} subtitle="以缺口、新鲜度或行动影响率重排真实数据；不合成不可解释的总分" title="治理决策镜头"><MotionSurface className="analytics-subview-motion" label="正在切换治理决策镜头" motionKey={qualityLens}><DiagnosticSignalBoard items={qualitySignals} /></MotionSurface></AnalyticsCard>
                <AnalyticsCard icon={ShieldCheck} subtitle="十个字段与流程覆盖维度，共用明确分母" title="覆盖雷达"><CoverageRadar items={data.dataQuality.coverage} /></AnalyticsCard>
                <AnalyticsCard icon={Filter} subtitle="同一馆藏作品从记录建立到封面可用的逐层收敛" title="元数据资产漏斗"><PipelineFunnel items={data.dataQuality.metadataPipeline} /></AnalyticsCard>
                <AnalyticsCard className="analytics-quality-backlog-card" icon={ShieldAlert} subtitle="不同对象保留各自分母；按影响率排序，支持先预览再确认执行" title="治理积压优先级"><GovernanceBacklog items={data.dataQuality.backlog} onAction={setGovernanceIssueKey} /></AnalyticsCard>
                <AnalyticsCard className="analytics-card-wide" extra={<span className="analytics-stat-chip">Top 12 供应商 · 每格按供应商自身作品归一</span>} icon={Database} subtitle="ready、中文标题、演员、翻译、封面与 90 天内更新在同一行比较" title="供应商 × 元数据能力矩阵"><ProviderCoverageMatrix items={data.dataQuality.metadataProviders} /></AnalyticsCard>
                <AnalyticsCard className="analytics-card-wide analytics-table-card" extra={<span className="analytics-stat-chip">90 天新鲜度 · 唯一供应商键</span>} icon={Database} subtitle="核对覆盖、错误、未找到、平均尝试次数、陈旧记录与最近更新时间" title="元数据供应商记分卡"><Table columns={providerColumns} dataSource={data.dataQuality.metadataProviders} pagination={{ defaultPageSize: 10, showSizeChanger: false }} rowKey="key" scroll={{ x: 1420 }} size="small" /></AnalyticsCard>
                <AnalyticsCard className="analytics-card-span-2" extra={<span className="analytics-card-toggle"><Segmented onChange={(value) => setCoverageCohortMode(value as CoverageCohortMode)} options={[{ label: "覆盖率", value: "coverage" }, { label: "缺口数", value: "gap" }]} size="small" value={coverageCohortMode} /></span>} icon={CalendarDays} subtitle={`最近发行年按字段交叉 · ${coverageCohortMode === "coverage" ? "深色代表更完整" : "深色代表待补齐比例更高"} · 日期缺失单列`} title="发行年代 × 字段覆盖矩阵"><MotionSurface className="analytics-subview-motion" label="正在切换发行年代覆盖口径" motionKey={coverageCohortMode}><CoverageCohortMatrix items={data.dataQuality.coverageByReleaseYear} mode={coverageCohortMode} /></MotionSurface></AnalyticsCard>
                <AnalyticsCard icon={History} subtitle="发行日到系统首次索引日；这是索引延迟，不代表购买或获取日期" title="发行到首次索引时差"><Histogram items={data.dataQuality.indexLagBands} valueKey="works" /></AnalyticsCard>
                <AnalyticsCard icon={Database} subtitle="当前作品对应的元数据处理状态" title="处理状态"><SegmentedDistribution items={data.dataQuality.metadataStatuses.map((item) => ({ key: item.key, label: item.label, value: item.works }))} total={data.summary.works} /></AnalyticsCard>
                <AnalyticsCard className="analytics-quality-coverage-card" icon={BadgeCheck} subtitle="作品与文件口径分别标注分母" title="关键字段明细"><CoverageGrid items={data.dataQuality.coverage} /></AnalyticsCard>
                <AnalyticsCard className="analytics-card-wide" extra={<span className="analytics-stat-chip">精确值保留在明细实验室</span>} icon={Network} subtitle="橙色比较 Top 10 关系占比，蓝色比较单次出现实体占比；HHI 用于结构判断" title="内容维度集中度对比"><ConcentrationProfile items={data.dataQuality.facetConcentration} /></AnalyticsCard>
                <AnalyticsCard className="analytics-card-wide analytics-table-card" extra={<span className="analytics-stat-chip">档案 + 证据来源 + 增强结果</span>} icon={UserRound} subtitle="实体资料不仅看是否有档案，也核对来源记录、来源类型和来源置信度" title="实体知识证据深度"><Table columns={entityColumns} dataSource={data.entityKnowledge.profiles} pagination={false} rowKey="type" scroll={{ x: 1240 }} size="small" /></AnalyticsCard>
                <AnalyticsCard className="analytics-quality-issues-card" icon={ShieldAlert} subtitle="现有质量索引按影响作品数排序" title="质量问题 Pareto 清单">
                  {data.dataQuality.issues.length === 0 ? <div className="analytics-clean-state"><BadgeCheck size={22} /><strong>未发现结构化质量问题</strong><span>当前筛选范围的数据质量索引为空</span></div> : <div className="analytics-issue-list">{data.dataQuality.issues.map((item) => <div className={item.severity === "error" ? "is-error" : ""} key={`${item.key}:${item.severity}`}><span><i /><strong>{item.label}</strong><small>{item.severity === "error" ? t("需要检查") : "建议复核"}</small></span><b>{formatNumber(item.works)} {t("部")}</b></div>)}</div>}
                </AnalyticsCard>
                <AnalyticsCard className="analytics-card-wide analytics-table-card" extra={<span className="analytics-stat-chip">Top 80 · 可排序与筛选</span>} icon={FileSearch} subtitle="将质量索引、状态异常和关键字段缺失合并为可执行作品清单" title="待治理作品明细"><Table columns={exceptionColumns} dataSource={data.dataQuality.exceptionWorks} pagination={{ defaultPageSize: 12, pageSizeOptions: [12, 24, 48], showSizeChanger: true }} rowKey="code" scroll={{ x: 1300 }} size="small" /></AnalyticsCard>
              </div>
            </section>
          )}

          {activeView === "details" && (
            <section className="analytics-section analytics-detail-lab">
              <header className="analytics-section-heading"><div><TableProperties size={18} /><span><strong>明细探索实验室</strong><small>在同一页面切换十一类可排序、筛选、分页和横向比较的数据表</small></span></div><span className="analytics-stat-chip">馆藏、治理与生产三类口径</span></header>
              <div className="analytics-detail-switcher" role="tablist" aria-label="明细数据集">{detailDatasetOptions.map(([key, label]) => <button aria-selected={detailDataset === key} className={detailDataset === key ? "is-active" : ""} key={key} onClick={() => setDetailDataset(key)} role="tab" type="button">{label}</button>)}</div>
              <MotionSurface className="analytics-table-motion" label="正在切换明细表格" motionKey={detailDataset}>
                <>
                <DetailDatasetPreview data={data} dataset={detailDataset} formatRows={formatRows} />
                <AnalyticsCard className="analytics-table-card analytics-detail-table-card" extra={<span className="analytics-stat-chip">{formatNumber(detailMeta[detailDataset].count)} 行 · 切换带过渡</span>} icon={TableProperties} subtitle={`${detailMeta[detailDataset].subtitle}；移动端可横向滚动`} title={detailMeta[detailDataset].title}>
                  {detailDataset === "year" && <Table columns={yearlyColumns} dataSource={data.yearlyMetrics} pagination={{ defaultPageSize: 12, showSizeChanger: false }} rowKey="year" scroll={{ x: 1150 }} size="small" />}
                  {detailDataset === "source" && <Table columns={sourceColumns} dataSource={data.sourceProfiles} pagination={false} rowKey="key" scroll={{ x: 1180 }} size="small" />}
                  {detailDataset === "entity" && <Table columns={entityColumns} dataSource={data.entityKnowledge.profiles} pagination={false} rowKey="type" scroll={{ x: 1240 }} size="small" />}
                  {detailDataset === "provider" && <Table columns={providerColumns} dataSource={data.dataQuality.metadataProviders} pagination={{ defaultPageSize: 12, showSizeChanger: false }} rowKey="key" scroll={{ x: 1420 }} size="small" />}
                  {detailDataset === "format" && <Table columns={formatColumns} dataSource={formatRows} pagination={{ defaultPageSize: 16, pageSizeOptions: [16, 32], showSizeChanger: true }} rowKey={(row) => `${row.group}:${row.key}`} scroll={{ x: 760 }} size="small" />}
                  {detailDataset === "issues" && <Table columns={exceptionColumns} dataSource={data.dataQuality.exceptionWorks} pagination={{ defaultPageSize: 16, pageSizeOptions: [16, 32, 64], showSizeChanger: true }} rowKey="code" scroll={{ x: 1300 }} size="small" />}
                  {detailDataset === "jobs" && <Table columns={jobTypeColumns} dataSource={data.operations.jobTypes} pagination={false} rowKey="key" scroll={{ x: 980 }} size="small" />}
                  {detailDataset === "ingestion" && <Table columns={ingestionColumns} dataSource={data.operations.recentIngestionRuns} pagination={{ defaultPageSize: 12, pageSizeOptions: [12, 24], showSizeChanger: true }} rowKey="id" scroll={{ x: 1600 }} size="small" />}
                  {detailDataset === "assets" && <Table columns={assetColumns} dataSource={data.operations.pipelineStages} pagination={false} rowKey="key" scroll={{ x: 930 }} size="small" />}
                  {detailDataset === "failures" && <Table columns={failureColumns} dataSource={data.operations.failedJobDetails} pagination={{ defaultPageSize: 16, pageSizeOptions: [16, 32, 64], showSizeChanger: true }} rowKey="id" scroll={{ x: 1200 }} size="small" />}
                  {detailDataset === "concentration" && <Table columns={concentrationColumns} dataSource={data.dataQuality.facetConcentration} pagination={false} rowKey="type" scroll={{ x: 760 }} size="small" />}
                </AnalyticsCard>
                </>
              </MotionSurface>
            </section>
          )}

              </>
            </MotionSurface>
          </div>

          <footer className="analytics-source-note">
            <Database size={14} />
            <span>数据复用现有馆藏、元数据、实体、质量、<code>ingestion_runs</code>、<code>media_jobs</code>、<code>media_storyboards</code>、<code>media_derivatives</code> 与 <code>video_subtitle_translations</code>；未把观看或个人收藏作为核心统计口径。</span>
            <small>生成于 {formatDateTime(data.scope.generatedAt)}</small>
          </footer>
        </>
      )}
      {data && <MatrixEvidenceDrawer data={data.actorAnalytics.genreAffinity} onClose={() => setSelectedAffinityCell(null)} onOpenEntity={onOpenEntity} onOpenMedia={onOpenMedia} selection={selectedAffinityCell} year={selectedYear} />}
      <GovernanceActionDrawer issueKey={governanceIssueKey} onClose={() => setGovernanceIssueKey(null)} />
      <MetricDefinitionDrawer contract={(data ?? summaryData)?.contract ?? null} onClose={() => setMetricDefinitionsOpen(false)} open={metricDefinitionsOpen} />
      <AnalyticsDisplayAuditDrawer onClose={() => setVisualAuditOpen(false)} open={visualAuditOpen} />
    </main>
  );
}
