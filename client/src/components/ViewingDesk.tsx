import { getIntlLocale } from "../i18n/core";
import { t, useLocale, useLocalizedMemo } from "../i18n";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Empty, Popconfirm, Skeleton, Tag, Typography, message } from "antd";
import {
  ArrowLeft,
  ArrowRight,
  Ban,
  Check,
  Compass,
  Equal,
  GitBranch,
  Heart,
  History,
  Layers3,
  ListPlus,
  Play,
  Radar,
  Route,
  RefreshCw,
  Shuffle,
  Sparkles,
  Swords,
  Tags,
  Target,
  Trash2,
  TrendingUp,
  Trophy,
  UsersRound,
  Zap
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  branchViewingDeskSession,
  deleteViewingDeskSession,
  fetchTopicItems,
  fetchViewingDeskSession,
  fetchViewingDeskSessionById,
  fetchViewingDeskSessions,
  generateViewingDeskSession,
  getPosterUrl,
  getThumbnailUrl,
  submitViewingDeskFeedback,
  submitViewingDeskArenaChoice,
  type MediaItem,
  type ViewingDeskConfig,
  type ViewingDeskLaneId,
  type ViewingDeskPresetId,
  type ViewingDeskResponse,
  type ViewingDeskSignal,
  type ViewingDeskSession,
  type ViewingDeskSessionSummary,
  type TopicListItem
} from "../lib/api";
import {
  fetchContentPreview,
  requestContentPreview,
  type ContentPreviewResponse
} from "../lib/contentPreviewApi";
import { getDisplayMetadata, type MetadataLanguage } from "../lib/metadataDisplay";
import { createPlaylist } from "../lib/playlistApi";
import { PosterImage } from "./PosterImage";
import "../viewing-desk.css";

type ViewingDeskProps = {
  metadataLanguage: MetadataLanguage;
  onOpenMedia: (item: MediaItem, queue: MediaItem[]) => void;
  onPlay: (item: MediaItem, queue: MediaItem[]) => void;
};

type DiscoveryStyle = "familiar" | "balanced" | "fresh";
type ViewMode = "landing" | "custom" | "session";
type ArenaAction = "choose" | "both" | "reject" | "reroll";
type WizardTransitionPhase = "idle" | "confirming" | "exiting" | "entering";
type ArenaTransitionPhase = "idle" | "exiting" | "entering";
type FlexibleFacet = "genre" | "actor" | "series" | "director" | "maker" | "label";

type WizardOption = {
  value: string;
  title: string;
  description: string;
  icon: typeof Tags;
  coverMediaId?: string | null;
  selected: boolean;
  onClick: () => void;
};

type WizardView = {
  eyebrow: string;
  title: string;
  description: string;
  options: WizardOption[];
  onShuffle?: () => void;
  shuffleLoading?: boolean;
};

type DiscoveryProposal = {
  id: "familiar" | "fresh" | "revisit";
  eyebrow: string;
  title: string;
  description: string;
  anchor: string;
  dimension: string;
  dimensionDetail: string;
  candidateCount: number;
  whyNow: string;
  config: ViewingDeskConfig;
};

const ACTIVE_SESSION_KEY = ["viewing-desk", "active-session"] as const;
const HISTORY_KEY = ["viewing-desk", "session-history"] as const;
const WIZARD_FACET_COUNT = 4;
const WIZARD_STEP_COUNT = 2 + WIZARD_FACET_COUNT;
const DEFAULT_DURATION_MINUTES = 90;
const requestedArenaPreviewIds = new Set<string>();

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function formatPreviewTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.round(seconds));
  return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, "0")}`;
}

const presetOptions: Array<{
  value: ViewingDeskPresetId;
  title: string;
  description: string;
  icon: typeof Tags;
}> = [
  { value: "quick", get title() { return t("快速选片"); }, get description() { return t("回答几道题，马上得到一组片单"); }, icon: Zap },
  { value: "explore", get title() { return t("熟悉中找新意"); }, get description() { return t("保留喜欢的元素，再换一点新鲜感"); }, icon: Compass },
  { value: "favorites", get title() { return t("从收藏继续"); }, get description() { return t("从收藏过的演员、系列和题材开始"); }, icon: Heart },
  { value: "unwatched", get title() { return t("看看没播过的"); }, get description() { return t("优先挑选从未播放的影片"); }, icon: Sparkles }
];

const facetCopy: Record<FlexibleFacet, { title: string; question: string; description: string; any: string; icon: typeof Tags }> = {
  genre: { get title() { return t("题材"); }, get question() { return t("这次更想看哪类题材？"); }, get description() { return t("从馆藏中随机挑选，也可以换一批再选"); }, get any() { return t("题材不限"); }, icon: Tags },
  actor: { get title() { return t("演员"); }, get question() { return t("想先从哪位演员开始？"); }, get description() { return t("每次会随机换一批演员，不只显示常见人选"); }, get any() { return t("演员不限"); }, icon: UsersRound },
  series: { get title() { return t("系列"); }, get question() { return t("有没有想继续看的系列？"); }, get description() { return t("选择后会优先推荐相关影片，不会只剩这个系列"); }, get any() { return t("系列不限"); }, icon: Layers3 },
  director: { get title() { return t("导演"); }, get question() { return t("今天想看哪位导演的作品？"); }, get description() { return t("选择后会优先推荐这位导演及风格相近的影片"); }, get any() { return t("导演不限"); }, icon: Route },
  maker: { get title() { return t("厂商"); }, get question() { return t("有没有偏好的制作厂商？"); }, get description() { return t("选择后会优先从该厂商及相近作品中挑选"); }, get any() { return t("厂商不限"); }, icon: Compass },
  label: { get title() { return t("厂牌"); }, get question() { return t("有没有偏好的发行厂牌？"); }, get description() { return t("选择后会轻微提高相关影片的推荐顺序"); }, get any() { return t("厂牌不限"); }, icon: Sparkles }
};

function shuffleWithSeed<T>(items: T[], seed: number): T[] {
  const result = [...items];
  let state = seed || 1;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = Math.imul(state ^ (state >>> 15), 2_246_822_519);
    const target = Math.abs(state) % (index + 1);
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

const discoveryOptions: Array<{
  value: DiscoveryStyle;
  title: string;
  description: string;
  favoriteBias: boolean;
  excludeRecentlyWatched: boolean;
}> = [
  { value: "familiar", get title() { return t("以熟悉为主"); }, get description() { return t("多推荐你已经喜欢的，也可以包含最近看过的"); }, favoriteBias: true, excludeRecentlyWatched: false },
  { value: "balanced", get title() { return t("熟悉里带点新意"); }, get description() { return t("保留主要偏好，优先挑选最近没看过的"); }, favoriteBias: true, excludeRecentlyWatched: true },
  { value: "fresh", get title() { return t("多来点新鲜的"); }, get description() { return t("减少收藏影响，优先挑选平时较少出现的影片"); }, favoriteBias: false, excludeRecentlyWatched: true }
];

const lanePresentation: Record<ViewingDeskLaneId, {
  label: string;
  eyebrow: string;
  description: string;
  icon: typeof Target;
}> = {
  core: { get label() { return t("最合口味"); }, get eyebrow() { return t("优先推荐"); }, get description() { return t("最贴近你刚才选中的演员、系列和题材"); }, icon: Target },
  adjacent: { get label() { return t("换点新意"); }, get eyebrow() { return t("熟悉中有变化"); }, get description() { return t("保留一部分熟悉感，再换演员、系列或风格"); }, icon: GitBranch },
  wildcard: { get label() { return t("大胆试试"); }, get eyebrow() { return t("更多可能"); }, get description() { return t("和常看内容差别更大，但会避开明确不喜欢的方向"); }, icon: Sparkles }
};

const signalTypeLabels: Record<ViewingDeskSignal["type"], string> = {
  get actor() { return t("演员"); },
  get series() { return t("系列"); },
  get genre() { return t("题材"); },
  get director() { return t("导演"); },
  get maker() { return t("厂商"); },
  get label() { return t("厂牌"); }
};

function signalLabel(signal: ViewingDeskSignal): string {
  return `${signalTypeLabels[signal.type]} · ${signal.value}`;
}

function formatSessionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t("历史记录");
  return new Intl.DateTimeFormat(getIntlLocale(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function unwrapSession(value: unknown): ViewingDeskSession | null {
  if (value && typeof value === "object" && "session" in value) {
    return (value as { session: ViewingDeskSession | null }).session;
  }
  return value as ViewingDeskSession | null;
}

function getMediaCopy(item: MediaItem, language: MetadataLanguage) {
  const metadata = item.metadata?.status === "ready" ? getDisplayMetadata(item.metadata, language) : null;
  return {
    code: item.normalizedCode || item.basename,
    title: metadata?.title || item.basename,
    actors: metadata?.actors.slice(0, 3).join(" / ") || t("信息整理中"),
    genres: metadata?.genres.filter((genre) => genre !== "样片").slice(0, 3) ?? []
  };
}

function getDiscoveryStyle(config: ViewingDeskConfig): DiscoveryStyle {
  if (!config.favoriteBias && config.excludeRecentlyWatched) return "fresh";
  if (config.favoriteBias && !config.excludeRecentlyWatched) return "familiar";
  return "balanced";
}

function routeLabel(config: ViewingDeskConfig): string {
  const labels: Record<ViewingDeskPresetId, string> = {
    quick: t("快速选片"),
    explore: t("熟悉中找新意"),
    favorites: t("从收藏继续"),
    unwatched: t("看看没播过的")
  };
  const anchors = [
    config.preferredActorLabel ?? config.preferredActor,
    config.preferredGenreLabel ?? config.preferredGenre,
    config.preferredSeriesLabel ?? config.preferredSeries,
    config.preferredDirectorLabel ?? config.preferredDirector,
    config.preferredMakerLabel ?? config.preferredMaker,
    config.preferredLabelLabel ?? config.preferredLabel
  ].filter(Boolean).slice(0, 2);
  return anchors.length ? `${labels[config.preset]} · ${anchors.join(" / ")}` : labels[config.preset];
}

function MediaPoster({ item }: { item: MediaItem }) {
  useLocale();
  return (
    <PosterImage
      alt=""
      onError={(event) => {
        const thumbnail = getThumbnailUrl(item.id);
        if (!event.currentTarget.src.endsWith(thumbnail)) event.currentTarget.src = thumbnail;
      }}
      src={getPosterUrl(item.id)}
    />
  );
}

function FacetOptionCover({ icon: Icon, mediaId, title }: { icon: typeof Tags; mediaId?: string | null; title: string }) {
  useLocale();
  const [failed, setFailed] = useState(false);
  if (!mediaId || failed) return <span className="viewing-desk-answer-icon"><Icon size={20} /></span>;
  return (
    <span className="viewing-desk-answer-cover">
      <img
        alt={t("{{p0}}的关联作品封面", { p0: title })}
        loading="lazy"
        onError={(event) => {
          const thumbnail = getThumbnailUrl(mediaId);
          if (!event.currentTarget.src.endsWith(thumbnail)) {
            event.currentTarget.src = thumbnail;
            return;
          }
          setFailed(true);
        }}
        src={getPosterUrl(mediaId)}
      />
    </span>
  );
}

function PosterMosaic({ items }: { items: MediaItem[] }) {
  useLocale();
  return (
    <div aria-hidden="true" className="viewing-discovery-mosaic">
      {items.slice(0, 7).map((item) => <MediaPoster item={item} key={item.id} />)}
    </div>
  );
}

function PreferenceHistory({
  activeId,
  deletingId,
  loadingId,
  onDelete,
  onSelect,
  sessions
}: {
  activeId?: string;
  deletingId?: string | null;
  loadingId?: string | null;
  onDelete: (session: ViewingDeskSessionSummary) => void;
  onSelect: (session: ViewingDeskSessionSummary) => void;
  sessions: ViewingDeskSessionSummary[];
}) {
  useLocale();
  return (
    <section className="viewing-desk-history" aria-label={t("最近的选片记录")}>
      <div className="viewing-desk-history-heading">
        <span><History size={15} />{t("最近的选片记录")}</span>
      </div>
      <div className="viewing-desk-history-list">
        {sessions.map((session) => {
          const label = routeLabel(session.config);
          return (
            <div className={`viewing-desk-history-item${activeId === session.id ? " is-active" : ""}`} key={session.id}>
              <button
                aria-label={t("打开选片记录：{{p0}}", { p0: label })}
                aria-pressed={activeId === session.id}
                className="viewing-desk-history-select"
                disabled={deletingId === session.id}
                onClick={() => onSelect(session)}
                type="button"
              >
                <span>{label}</span>
                <small>{formatSessionTime(session.createdAt)} · {session.summary.total} {t("部")}</small>
                {loadingId === session.id ? <span className="viewing-desk-history-loading" /> : null}
              </button>
              <Popconfirm
                cancelText={t("取消")}
                description={t("之前的选择和这次生成的片单会一并移除。")}
                okButtonProps={{ danger: true, loading: deletingId === session.id }}
                okText={t("删除")}
                onConfirm={() => onDelete(session)}
                title={t("删除这次选片记录？")}
              >
                <button
                  aria-label={t("删除选片记录：{{p0}}", { p0: label })}
                  className="viewing-desk-history-delete"
                  disabled={Boolean(deletingId || loadingId === session.id)}
                  type="button"
                >
                  <Trash2 size={13} />
                </button>
              </Popconfirm>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ArenaGifPreview({ item }: { item: MediaItem }) {
  useLocale();
  const queryClient = useQueryClient();
  const previewQuery = useQuery<ContentPreviewResponse>({
    queryKey: ["content-preview", item.id],
    queryFn: () => fetchContentPreview(item.id),
    refetchInterval: (query) => query.state.data?.status === "pending" ? 4_000 : false,
    retry: 1,
    staleTime: 60_000
  });
  const preview = previewQuery.data;

  useEffect(() => {
    if (!preview?.storageAvailable || (preview.status !== "missing" && preview.status !== "stale")) return;
    if (requestedArenaPreviewIds.has(item.id)) return;
    requestedArenaPreviewIds.add(item.id);
    void requestContentPreview(item.id)
      .then((result) => {
        queryClient.setQueryData(["content-preview", item.id], result.preview);
        if (result.preview.status === "pending") {
          void queryClient.invalidateQueries({ queryKey: ["content-preview", item.id] });
        }
      })
      .catch(() => requestedArenaPreviewIds.delete(item.id));
  }, [item.id, preview?.status, preview?.storageAvailable, queryClient]);

  if (!preview?.storageAvailable || preview.status === "failed" || preview.status === "unavailable") return null;

  const reduceMotion = prefersReducedMotion();
  const assets = preview.status === "ready"
    ? (reduceMotion ? preview.photos : preview.gifs).slice(0, 3)
    : [];
  const isPreparing = preview.status === "missing" || preview.status === "pending" || preview.status === "stale";

  return (
    <span aria-hidden="true" className={`viewing-arena-preview${isPreparing ? " is-preparing" : ""}`}>
      <span className="viewing-arena-preview-heading">
        <strong>{reduceMotion ? t("3 张画面预览") : t("3 段动态预览")}</strong>
        <small>{isPreparing ? t("正在准备预览") : t("从第 5 分钟开始均匀截取")}</small>
      </span>
      <span className="viewing-arena-preview-grid">
        {Array.from({ length: 3 }, (_, index) => {
          const asset = assets[index];
          return asset ? (
            <span className="viewing-arena-preview-clip" key={asset.key}>
              <img alt="" decoding="async" draggable={false} loading="eager" src={asset.url} />
              <small>{formatPreviewTime(asset.timeSeconds)}</small>
            </span>
          ) : (
            <span className="viewing-arena-preview-clip is-loading" key={`preview-loading-${index}`}>
              <i />
            </span>
          );
        })}
      </span>
    </span>
  );
}

function ArenaChoiceCard({ disabled, item, language, motion, onChoose, side }: {
  disabled: boolean;
  item: MediaItem;
  language: MetadataLanguage;
  motion: "idle" | "picked" | "muted" | "both" | "rejected" | "rerolling";
  onChoose: () => void;
  side: "A" | "B";
}) {
  useLocale();
  const copy = getMediaCopy(item, language);
  return (
    <button aria-label={t("更想看 {{p0}}", { p0: copy.code })} className={`viewing-arena-choice motion-pressable is-${motion}`} disabled={disabled} onClick={onChoose} type="button">
      <span className="viewing-arena-choice-side">{t("选项")} {side}</span>
      <span className="viewing-arena-poster"><MediaPoster item={item} /></span>
      <ArenaGifPreview item={item} />
      <span className="viewing-arena-copy">
        <strong>{copy.code}</strong>
        <small>{copy.actors}</small>
        <span className="viewing-arena-tags">
          {copy.genres.length ? copy.genres.map((genre) => <Tag key={genre}>{genre}</Tag>) : <Tag>{t("题材整理中")}</Tag>}
        </span>
      </span>
      <span className="viewing-arena-pick"><Target size={15} />{t("更想看这部")}</span>
    </button>
  );
}

function ArenaProfilePanel({ profile, strategyLabel }: {
  profile: ViewingDeskSession["arena"]["profile"];
  strategyLabel: string;
}) {
  useLocale();
  const impactCopy = profile.lastImpact?.action === "choose" ? t("下一轮会更接近你选中的这部")
    : profile.lastImpact?.action === "both" || profile.lastImpact?.action === "neutral" ? t("下一轮会保留两部共有的特点")
      : profile.lastImpact?.action === "reject" ? t("下一轮会避开这两部共有的特点") : null;
  return (
    <aside aria-label={t("本次偏好变化")} className="viewing-arena-profile">
      <header>
        <span><Radar size={16} />{t("正在了解你的口味")}</span>
        <strong>{strategyLabel}</strong>
      </header>
      {impactCopy ? (
        <div className="viewing-arena-impact" role="status">
          <TrendingUp size={15} />
          <span><strong>{t("刚才的选择已记住")}</strong><small>{impactCopy}</small></span>
        </div>
      ) : (
        <p>{t("每次选择都会改变下一组对比，也会影响最后的三组片单。")}</p>
      )}
      <div className="viewing-arena-signal-block">
        <span>{t("你可能更喜欢")}</span>
        <div>
          {profile.positiveSignals.length
            ? profile.positiveSignals.slice(0, 5).map((signal) => <Tag key={`${signal.type}:${signal.value}`}>{signalLabel(signal)}</Tag>)
            : <small>{t("选完第一轮后显示")}</small>}
        </div>
      </div>
      {profile.negativeSignals.length ? (
        <div className="viewing-arena-signal-block is-negative">
          <span>{t("本次先少推荐")}</span>
          <div>{profile.negativeSignals.slice(0, 3).map((signal) => <Tag key={`${signal.type}:${signal.value}`}>{signalLabel(signal)}</Tag>)}</div>
        </div>
      ) : null}
      <div className="viewing-arena-metrics">
        <span><small>{t("偏好明确度")}</small><i><b style={{ width: `${profile.confidence}%` }} /></i><strong>{profile.confidence}%</strong></span>
        <span><small>{t("新鲜度")}</small><i><b style={{ width: `${profile.diversity}%` }} /></i><strong>{profile.diversity}%</strong></span>
      </div>
    </aside>
  );
}

function RecommendationCard({
  disabled,
  feedback,
  item,
  language,
  onLike,
  onOpen,
  onPlay,
  onReplace,
  pendingFeedback,
  reason,
  selected
}: {
  disabled: boolean;
  feedback: "" | "like" | "dislike" | "skip";
  item: MediaItem;
  language: MetadataLanguage;
  onLike: () => void;
  onOpen: () => void;
  onPlay: () => void;
  onReplace: () => void;
  pendingFeedback?: "like" | "dislike" | "skip" | "clear";
  reason: string;
  selected: boolean;
}) {
  useLocale();
  const copy = getMediaCopy(item, language);
  return (
    <article className="viewing-recommendation-card motion-list-item">
      <div className="viewing-recommendation-poster">
        <button aria-label={t("查看 {{p0}}", { p0: copy.code })} className="viewing-recommendation-image" onClick={onOpen} type="button">
          <MediaPoster item={item} />
        </button>
        {selected ? <span className="viewing-recommendation-winner"><Trophy size={13} />{t("你选过这部")}</span> : null}
        <button aria-label={t("播放 {{p0}}", { p0: copy.code })} className="viewing-recommendation-play" onClick={onPlay} type="button">
          <Play fill="currentColor" size={18} />
        </button>
      </div>
      <button className="viewing-recommendation-copy" onClick={onOpen} type="button">
        <span><strong>{copy.code}</strong><small>{copy.actors}</small></span>
        <p>{copy.title}</p>
        <small className="viewing-recommendation-reason">{reason}</small>
        <span className="viewing-recommendation-tags">
          {copy.genres.length ? copy.genres.map((genre) => <Tag key={genre}>{genre}</Tag>) : <Tag>{t("为你挑选")}</Tag>}
        </span>
      </button>
      <div className="viewing-recommendation-actions">
        <button
          aria-pressed={feedback === "like"}
          className={feedback === "like" ? "is-active" : ""}
          disabled={disabled}
          onClick={onLike}
          type="button"
        >
          <Heart fill={feedback === "like" ? "currentColor" : "none"} size={14} />
          {pendingFeedback === "like" || pendingFeedback === "clear" ? t("正在更新") : feedback === "like" ? t("已记住") : t("多推荐这类")}
        </button>
        <button disabled={disabled} onClick={onReplace} type="button">
          <RefreshCw className={pendingFeedback === "dislike" ? "is-spinning" : ""} size={14} />
          {pendingFeedback === "dislike" ? t("正在更换") : t("换一部")}
        </button>
      </div>
    </article>
  );
}

export function ViewingDesk({ metadataLanguage, onOpenMedia, onPlay }: ViewingDeskProps) {
  useLocale();
  const queryClient = useQueryClient();
  const [messageApi, messageContextHolder] = message.useMessage();
  const forceStarterPreview = new URLSearchParams(window.location.search).get("coldStart") === "1";
  const [viewMode, setViewMode] = useState<ViewMode>("landing");
  const [preset, setPreset] = useState<ViewingDeskPresetId>("explore");
  const [discoveryStyle, setDiscoveryStyle] = useState<DiscoveryStyle>("balanced");
  const [preferredFacets, setPreferredFacets] = useState<Partial<Record<FlexibleFacet, string>>>({});
  const [questionSeed, setQuestionSeed] = useState(() => Date.now() % 2_147_483_647);
  const [facetRefresh, setFacetRefresh] = useState(0);
  const [wizardStep, setWizardStep] = useState(0);
  const [wizardTransitionPhase, setWizardTransitionPhase] = useState<WizardTransitionPhase>("idle");
  const [wizardConfirmedValue, setWizardConfirmedValue] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<ViewingDeskSession | null>(null);
  const [activeLane, setActiveLane] = useState<ViewingDeskLaneId>("core");
  const [starterOffset, setStarterOffset] = useState(0);
  const [arenaTransitionPhase, setArenaTransitionPhase] = useState<ArenaTransitionPhase>("idle");
  const [arenaActionCue, setArenaActionCue] = useState<{
    action: ArenaAction;
    winnerMediaId?: string;
  } | null>(null);
  const wizardTransitionTimersRef = useRef<number[]>([]);
  const arenaTransitionTimersRef = useRef<number[]>([]);

  useEffect(() => () => {
    wizardTransitionTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    arenaTransitionTimersRef.current.forEach((timer) => window.clearTimeout(timer));
  }, []);

  const activeSessionQuery = useQuery({
    queryKey: ACTIVE_SESSION_KEY,
    queryFn: fetchViewingDeskSession,
    staleTime: 30_000,
    retry: 1
  });
  const historyQuery = useQuery({
    queryKey: HISTORY_KEY,
    queryFn: () => fetchViewingDeskSessions(8),
    staleTime: 30_000,
    retry: 1
  });
  const facetTypes = Object.keys(facetCopy) as FlexibleFacet[];
  const facetQueries = useQueries({
    queries: facetTypes.map((type, index) => ({
      queryKey: ["viewing-desk", "preferred-facets", type, questionSeed, facetRefresh],
      queryFn: () => fetchTopicItems({
        type,
        sort: "random",
        randomSeed: questionSeed + facetRefresh * 997 + index * 131,
        pageSize: 24
      }),
      enabled: viewMode === "custom",
      staleTime: 10 * 60 * 1000
    }))
  });
  const facetQueryByType = Object.fromEntries(facetTypes.map((type, index) => [type, facetQueries[index]])) as Record<FlexibleFacet, (typeof facetQueries)[number]>;
  const questionFacets = useLocalizedMemo<FlexibleFacet[]>(() => [
    ...shuffleWithSeed<FlexibleFacet>(["actor", "genre"], questionSeed),
    ...shuffleWithSeed<FlexibleFacet>(["series", "director", "maker", "label"], questionSeed + 17).slice(0, 2)
  ], [questionSeed]);

  const restoreSession = useMutation({
    mutationFn: (id: string) => fetchViewingDeskSessionById(id),
    onSuccess: (result) => {
      setActiveSession(result.session);
      setActiveLane("core");
      setViewMode("session");
      beginArenaEntrance();
    },
    onError: (error) => messageApi.error(error instanceof Error ? error.message : t("无法打开这次选片记录"))
  });

  const deleteSession = useMutation({
    mutationFn: (id: string) => deleteViewingDeskSession(id),
    onSuccess: (result) => {
      const displayedId = activeSession?.id ?? activeSessionQuery.data?.session?.id;
      queryClient.setQueryData<ViewingDeskResponse>(ACTIVE_SESSION_KEY, (current) => (
        current ? { ...current, session: result.session } : current
      ));
      queryClient.setQueryData<{ sessions: ViewingDeskSessionSummary[] }>(HISTORY_KEY, (current) => ({
        sessions: current?.sessions.filter((item) => item.id !== result.deletedId) ?? []
      }));
      if (displayedId === result.deletedId) {
        setActiveSession(result.session);
        setViewMode("landing");
        setWizardStep(0);
        setActiveLane("core");
      }
      void queryClient.invalidateQueries({ queryKey: HISTORY_KEY });
      messageApi.success(t("选片记录已删除"));
    },
    onError: (error) => messageApi.error(error instanceof Error ? error.message : t("选片记录删除失败"))
  });

  const selectedDiscovery = discoveryOptions.find((item) => item.value === discoveryStyle) ?? discoveryOptions[1];
  const preferredLabels = Object.fromEntries(facetTypes.map((type) => {
    const value = preferredFacets[type];
    const label = facetQueryByType[type].data?.items.find((item) => item.value === value)?.label ?? value;
    return [type, label];
  })) as Partial<Record<FlexibleFacet, string>>;
  const customConfig: ViewingDeskConfig = {
    preset,
    durationMinutes: DEFAULT_DURATION_MINUTES,
    category: "ALL",
    favoriteBias: selectedDiscovery.favoriteBias,
    excludeRecentlyWatched: selectedDiscovery.excludeRecentlyWatched,
    limit: 24,
    preferredGenre: preferredFacets.genre,
    preferredActor: preferredFacets.actor,
    preferredSeries: preferredFacets.series,
    preferredDirector: preferredFacets.director,
    preferredMaker: preferredFacets.maker,
    preferredLabel: preferredFacets.label,
    preferredGenreLabel: preferredLabels.genre,
    preferredActorLabel: preferredLabels.actor,
    preferredSeriesLabel: preferredLabels.series,
    preferredDirectorLabel: preferredLabels.director,
    preferredMakerLabel: preferredLabels.maker,
    preferredLabelLabel: preferredLabels.label
  };

  function clearArenaTransitionTimers() {
    arenaTransitionTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    arenaTransitionTimersRef.current = [];
  }

  function beginArenaEntrance() {
    clearArenaTransitionTimers();
    setArenaActionCue(null);
    if (prefersReducedMotion()) {
      setArenaTransitionPhase("idle");
      return;
    }
    setArenaTransitionPhase("entering");
    arenaTransitionTimersRef.current.push(window.setTimeout(() => {
      setArenaTransitionPhase("idle");
    }, 380));
  }

  const generateSession = useMutation({
    mutationFn: async (nextConfig: ViewingDeskConfig) => {
      const session = unwrapSession(await generateViewingDeskSession(nextConfig));
      if (!session) throw new Error(t("暂时没有生成可用的片单"));
      return session;
    },
    onSuccess: (session) => {
      setActiveSession(session);
      setViewMode("session");
      setActiveLane("core");
      queryClient.setQueryData<ViewingDeskResponse>(ACTIVE_SESSION_KEY, (current) => (
        current ? { ...current, session } : current
      ));
      beginArenaEntrance();
      void queryClient.invalidateQueries({ queryKey: HISTORY_KEY });
    },
    onError: (error) => messageApi.error(error instanceof Error ? error.message : t("片单生成失败"))
  });

  const arenaChoice = useMutation({
    mutationFn: ({ action, sessionId, roundIndex, winnerMediaId }: {
      action: ArenaAction;
      sessionId: string;
      roundIndex: number;
      winnerMediaId?: string;
    }) => submitViewingDeskArenaChoice({ action, sessionId, roundIndex, winnerMediaId }),
    onSuccess: (result, variables) => {
      const commitResult = () => {
        setActiveSession(result.session);
        queryClient.setQueryData<ViewingDeskResponse>(ACTIVE_SESSION_KEY, (current) => (
          current ? { ...current, session: result.session } : current
        ));
        setArenaActionCue(null);
        if (variables.action === "reroll") {
          messageApi.success(t("已换一组影片，这一轮可以重新选择"));
        } else if (result.session.arena.completed) {
          setActiveLane("core");
          messageApi.success(t("已完成 {{p0}} 轮选择，三组片单准备好了", { p0: result.session.arena.total }));
        }
        if (prefersReducedMotion()) {
          setArenaTransitionPhase("idle");
        } else {
          setArenaTransitionPhase("entering");
          arenaTransitionTimersRef.current.push(window.setTimeout(() => {
            setArenaTransitionPhase("idle");
          }, 380));
        }
      };

      clearArenaTransitionTimers();
      if (prefersReducedMotion()) {
        commitResult();
      } else {
        setArenaTransitionPhase("exiting");
        arenaTransitionTimersRef.current.push(window.setTimeout(commitResult, 180));
      }
      void queryClient.invalidateQueries({ queryKey: HISTORY_KEY });
    },
    onError: (error) => {
      clearArenaTransitionTimers();
      setArenaActionCue(null);
      setArenaTransitionPhase("idle");
      messageApi.error(error instanceof Error ? error.message : t("这次选择没有保存成功"));
    }
  });

  function submitArenaAction(variables: {
    action: ArenaAction;
    sessionId: string;
    roundIndex: number;
    winnerMediaId?: string;
  }) {
    if (arenaChoice.isPending || arenaTransitionPhase !== "idle" || arenaActionCue) return;
    setArenaActionCue({ action: variables.action, winnerMediaId: variables.winnerMediaId });
    arenaChoice.mutate(variables);
  }

  const branchSession = useMutation({
    mutationFn: ({ lane, sessionId }: { lane: ViewingDeskLaneId; sessionId: string }) => branchViewingDeskSession({ lane, sessionId }),
    onSuccess: (result) => {
      setActiveSession(result.session);
      queryClient.setQueryData<ViewingDeskResponse>(ACTIVE_SESSION_KEY, (current) => (
        current ? { ...current, session: result.session } : current
      ));
      beginArenaEntrance();
      messageApi.success(t("已根据这组片单准备新的对比"));
      void queryClient.invalidateQueries({ queryKey: HISTORY_KEY });
    },
    onError: (error) => messageApi.error(error instanceof Error ? error.message : t("暂时无法继续选择"))
  });

  const resultFeedback = useMutation({
    mutationFn: ({ feedback, mediaId, sessionId }: {
      feedback: "like" | "dislike" | "skip" | "clear";
      mediaId: string;
      sessionId: string;
    }) => submitViewingDeskFeedback({ feedback, mediaId, sessionId }),
    onSuccess: (result, variables) => {
      setActiveSession(result.session);
      queryClient.setQueryData<ViewingDeskResponse>(ACTIVE_SESSION_KEY, (current) => (
        current ? { ...current, session: result.session } : current
      ));
      void queryClient.invalidateQueries({ queryKey: HISTORY_KEY });
      if (variables.feedback === "dislike") {
        messageApi.success(t("已换一部，并减少相似影片的推荐"));
      } else if (variables.feedback === "clear") {
        messageApi.success(t("已取消偏好，三组片单已更新"));
      } else {
        messageApi.success(t("已记住这类偏好，三组片单已更新"));
      }
    },
    onError: (error) => messageApi.error(error instanceof Error ? error.message : t("这次反馈没有保存成功"))
  });

  const saveLanePlaylist = useMutation({
    mutationFn: ({ description, mediaIds, name }: { description: string; mediaIds: string[]; name: string }) => createPlaylist({
      name,
      description,
      kind: "manual",
      mediaIds
    }),
    onSuccess: (playlist) => {
      void queryClient.invalidateQueries({ queryKey: ["playlists"] });
      messageApi.success(t("“{{p0}}”已保存，共 {{p1}} 部", { p0: playlist.name, p1: playlist.itemCount }));
    },
    onError: (error) => messageApi.error(error instanceof Error ? error.message : t("片单保存失败"))
  });

  const session = forceStarterPreview && !activeSession
    ? null
    : activeSession ?? activeSessionQuery.data?.session ?? null;
  const bootstrap = activeSessionQuery.data?.bootstrap ?? null;
  const queue = useLocalizedMemo(() => session?.items.map((entry) => entry.media) ?? [], [session]);
  const previewQueue = useLocalizedMemo(() => {
    if (queue.length || !bootstrap?.items.length) return queue;
    const offset = starterOffset % bootstrap.items.length;
    return [...bootstrap.items.slice(offset), ...bootstrap.items.slice(0, offset)];
  }, [bootstrap, queue, starterOffset]);
  const currentArenaRound = session?.arena.rounds.find((round) => !round.decision) ?? null;
  const arenaInteractionLocked = arenaChoice.isPending || arenaTransitionPhase !== "idle" || Boolean(arenaActionCue);
  const arenaCardMotion = (mediaId: string): "idle" | "picked" | "muted" | "both" | "rejected" | "rerolling" => {
    if (!arenaActionCue) return "idle";
    if (arenaActionCue.action === "choose") return arenaActionCue.winnerMediaId === mediaId ? "picked" : "muted";
    if (arenaActionCue.action === "both") return "both";
    if (arenaActionCue.action === "reject") return "rejected";
    return "rerolling";
  };
  const winners = useLocalizedMemo(() => new Set(session?.arena.rounds.flatMap((round) => (
    round.winnerMediaId ? [round.winnerMediaId] : []
  )) ?? []), [session]);
  const availableLane = session?.items.some((entry) => entry.lane === activeLane)
    ? activeLane
    : session?.lanes.find((lane) => lane.count > 0)?.id ?? "core";
  const visibleEntries = session?.items.filter((entry) => entry.lane === availableLane) ?? [];
  const visibleQueue = visibleEntries.map((entry) => entry.media);
  const history = forceStarterPreview ? [] : historyQuery.data?.sessions ?? [];

  const anchorName = useLocalizedMemo(() => {
    for (const item of previewQueue) {
      if (item.metadata?.status !== "ready") continue;
      const display = getDisplayMetadata(item.metadata, metadataLanguage);
      const actor = [...item.metadata.actors, ...display.actors]
        .find((value) => value.length <= 18 && !/[?？!！]/.test(value));
      if (actor) return actor;
    }
    return t("最近收藏的演员");
  }, [metadataLanguage, previewQueue]);

  const starterMode = Boolean(!session && (bootstrap?.coldStart || forceStarterPreview));
  const starterGenre = useLocalizedMemo(() => {
    for (const item of previewQueue) {
      if (item.metadata?.status !== "ready") continue;
      const display = getDisplayMetadata(item.metadata, metadataLanguage);
      const genre = display.genres.find((value) => value !== "样片");
      if (genre) return genre;
    }
    return t("资料较完整的影片");
  }, [metadataLanguage, previewQueue]);

  const proposals = useLocalizedMemo<DiscoveryProposal[]>(() => {
    const baseCount = session?.summary.total || bootstrap?.summary.total || 24;
    const freshCount = session?.summary.unwatched || bootstrap?.summary.unwatched || Math.min(14, baseCount);
    const favoriteCount = session?.summary.favoriteMatches || bootstrap?.summary.favoriteMatches || Math.min(8, baseCount);
    const base = { durationMinutes: DEFAULT_DURATION_MINUTES, category: "ALL" as const, limit: 24 };
    return [
      {
        id: "familiar",
        eyebrow: starterMode ? t("先试试看 · 随选随调") : t("最贴近你的收藏"),
        title: t("从 {{p0}} 开始，看看还没播过的影片", { p0: anchorName }),
        description: t("保留熟悉的演员，再换个厂牌或导演，既好选也有一点新意。"),
        anchor: anchorName,
        dimension: t("厂牌 / 导演"),
        dimensionDetail: t("保留演员，换种风格"),
        candidateCount: Math.max(favoriteCount, 6),
        whyNow: starterMode
          ? t("现在还没有足够的收藏和观看记录，先从近期入库、资料较完整的影片开始选。")
          : t("最近的收藏和浏览已经能看出一些偏好，适合在熟悉的内容里加入一点变化。"),
        config: { ...base, preset: "favorites", favoriteBias: true, excludeRecentlyWatched: true }
      },
      {
        id: "fresh",
        eyebrow: starterMode ? t("先看新入库") : t("最近加入 · 还没播过"),
        title: starterMode ? t("从最近加入的 {{p0}} 部影片开始", { p0: freshCount }) : t("最近加入的 {{p0}} 部里，有这些可能适合你", { p0: freshCount }),
        description: starterMode ? t("优先挑选资料较完整、还没播过的影片，等你选过几轮后再逐步贴近口味。") : t("从最近加入且还没播过的影片中，挑出与你收藏相近的内容。"),
        anchor: starterMode ? t("最近加入") : t("你的收藏"),
        dimension: t("新片"),
        dimensionDetail: t("优先没播过的"),
        candidateCount: Math.max(freshCount, 6),
        whyNow: t("最近加入的影片最容易被忽略，现在正好快速过一遍。"),
        config: { ...base, preset: "unwatched", favoriteBias: false, excludeRecentlyWatched: true }
      },
      {
        id: "revisit",
        eyebrow: starterMode ? t("快速了解口味") : t("收藏里还没看的"),
        title: starterMode ? t("选几轮，马上得到第一组片单") : t("把收藏很久却没播放的影片找回来"),
        description: starterMode ? t("不需要先收藏或播放，只要在几组影片里选出更想看的那部。") : t("从已经收藏却一直没看的影片开始，重新挑一组今晚能看的。"),
        anchor: starterMode ? t("现场选择") : t("你的收藏"),
        dimension: starterMode ? t("两两选择") : t("收藏时间"),
        dimensionDetail: starterMode ? t("4 轮就能开始") : t("找回被搁置的影片"),
        candidateCount: Math.max(baseCount, 6),
        whyNow: t("它们曾经让你想收藏，却一直没真正开始看，值得再选一次。"),
        config: { ...base, preset: "favorites", favoriteBias: true, excludeRecentlyWatched: false }
      }
    ];
  }, [anchorName, bootstrap, session, starterMode]);

  function clearWizardTransitionTimers() {
    wizardTransitionTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    wizardTransitionTimersRef.current = [];
  }

  function beginWizardEntrance() {
    clearWizardTransitionTimers();
    setWizardConfirmedValue(null);
    if (prefersReducedMotion()) {
      setWizardTransitionPhase("idle");
      return;
    }
    setWizardTransitionPhase("entering");
    wizardTransitionTimersRef.current.push(window.setTimeout(() => {
      setWizardTransitionPhase("idle");
    }, 380));
  }

  function advanceWizard(selectionValue: string, applySelection: () => void, nextStep: number) {
    if (wizardTransitionPhase !== "idle") return;
    clearWizardTransitionTimers();
    applySelection();
    setWizardConfirmedValue(selectionValue);

    if (prefersReducedMotion()) {
      setWizardStep(nextStep);
      setWizardConfirmedValue(null);
      return;
    }

    setWizardTransitionPhase("confirming");
    wizardTransitionTimersRef.current.push(
      window.setTimeout(() => setWizardTransitionPhase("exiting"), 120),
      window.setTimeout(() => {
        setWizardStep(nextStep);
        setWizardConfirmedValue(null);
        setWizardTransitionPhase("entering");
      }, 300),
      window.setTimeout(() => setWizardTransitionPhase("idle"), 650)
    );
  }

  function startCustomSession() {
    if (generateSession.isPending || wizardTransitionPhase !== "idle") return;
    clearWizardTransitionTimers();
    if (prefersReducedMotion()) {
      generateSession.mutate(customConfig);
      return;
    }
    setWizardTransitionPhase("exiting");
    wizardTransitionTimersRef.current.push(
      window.setTimeout(() => {
        setWizardTransitionPhase("entering");
        generateSession.mutate(customConfig);
      }, 180),
      window.setTimeout(() => setWizardTransitionPhase("idle"), 560)
    );
  }

  function beginCustom(configToReuse?: ViewingDeskConfig) {
    if (configToReuse) {
      setPreset(configToReuse.preset);
      setDiscoveryStyle(getDiscoveryStyle(configToReuse));
      setPreferredFacets({
        genre: configToReuse.preferredGenre,
        actor: configToReuse.preferredActor,
        series: configToReuse.preferredSeries,
        director: configToReuse.preferredDirector,
        maker: configToReuse.preferredMaker,
        label: configToReuse.preferredLabel
      });
      setWizardStep(WIZARD_STEP_COUNT);
    } else {
      setPreferredFacets({});
      setQuestionSeed((Date.now() + Math.floor(Math.random() * 1_000_000)) % 2_147_483_647);
      setFacetRefresh(0);
      setWizardStep(0);
    }
    setViewMode("custom");
    setActiveLane("core");
    beginWizardEntrance();
  }

  function choosePreset(value: ViewingDeskPresetId) {
    advanceWizard(value, () => setPreset(value), 1);
  }

  function renderWizardStep(): WizardView | null {
    if (wizardStep === 0) return {
      eyebrow: t("选择 1 / {{p0}}", { p0: WIZARD_STEP_COUNT }),
      title: t("这次从哪里出发？"),
      description: t("只影响这次片单，不会永久修改你的偏好"),
      options: presetOptions.map((item) => ({ ...item, selected: preset === item.value, onClick: () => choosePreset(item.value) }))
    };
    if (wizardStep === 1) return {
      eyebrow: t("选择 2 / {{p0}}", { p0: WIZARD_STEP_COUNT }),
      title: t("这次想看多新鲜？"),
      description: t("选择更贴近收藏，还是多试一些平时少看的内容"),
      options: discoveryOptions.map((item) => ({
        ...item,
        icon: item.value === "familiar" ? Heart : item.value === "fresh" ? Sparkles : Compass,
        selected: discoveryStyle === item.value,
        onClick: () => advanceWizard(item.value, () => setDiscoveryStyle(item.value), 2)
      }))
    };
    const facetOptions = (
      items: TopicListItem[] | undefined,
      type: FlexibleFacet,
      Icon: typeof Tags,
      selected: string | undefined,
      nextStep: number,
      emptyTitle: string
    ) => {
      const showCover = type === "actor" || type === "genre" || type === "maker" || type === "label";
      return [
      ...(items ?? []).filter((item) => item.label.length <= 36 && !/[?？]/.test(item.label)).slice(0, 8).map((item) => ({
        value: item.value,
        title: item.label,
        description: t("馆藏中有 {{p0}} 部相关影片", { p0: item.mediaCount }),
        icon: Icon,
        coverMediaId: showCover ? item.mediaId : null,
        selected: selected === item.value,
        onClick: () => advanceWizard(item.value, () => {
          setPreferredFacets((current) => ({ ...current, [type]: item.value }));
        }, nextStep)
      })),
      {
        value: "__any__",
        title: emptyTitle,
        description: t("结合前面的答案自动挑选"),
        icon: Compass,
        selected: !selected,
        onClick: () => advanceWizard("__any__", () => {
          setPreferredFacets((current) => ({ ...current, [type]: undefined }));
        }, nextStep)
      }
      ];
    };
    const facetType = questionFacets[wizardStep - 2];
    if (facetType) {
      const copy = facetCopy[facetType];
      const query = facetQueryByType[facetType];
      return {
        eyebrow: t("选择 {{p0}} / {{p1}} · {{p2}}", { p0: wizardStep + 1, p1: WIZARD_STEP_COUNT, p2: copy.title }),
        title: copy.question,
        description: copy.description,
        options: facetOptions(query.data?.items, facetType, copy.icon, preferredFacets[facetType], wizardStep + 1, copy.any),
        onShuffle: () => {
          setPreferredFacets((current) => ({ ...current, [facetType]: undefined }));
          setFacetRefresh((value) => value + 1);
        },
        shuffleLoading: query.isFetching
      };
    }
    return null;
  }

  const wizard = renderWizardStep();
  const showArena = Boolean(session && session.arena.total > 0 && !session.arena.completed && currentArenaRound);

  if (viewMode === "landing") {
    const [hero, fresh, revisit] = proposals;
    return (
      <main className={`viewing-desk viewing-discovery-home${starterMode ? " is-starter" : ""}`}>
        {messageContextHolder}
        <header className="viewing-discovery-header">
          <div>
            <span className="viewing-desk-eyebrow">PERSONAL DISCOVERY</span>
            <Typography.Title level={1}>{t("今晚想看什么？从一组片单开始")}</Typography.Title>
            <Typography.Text type="secondary">{starterMode ? t("先从馆藏示例开始选；选过几轮后，推荐会逐步贴近你的口味") : t("从收藏、观看记录和最近入库中，挑一组适合今晚的影片")}</Typography.Text>
          </div>
          <div className="viewing-discovery-header-actions">
            <Button
              className="viewing-custom-route-button"
              icon={<Route size={16} />}
              onClick={() => beginCustom()}
              size="large"
              type="primary"
            >
              {t("自己选条件")} </Button>
          </div>
        </header>

        {activeSessionQuery.isPending ? (
          <div className="viewing-desk-centered"><Skeleton active paragraph={{ rows: 7 }} /></div>
        ) : (
          <>
            {starterMode ? (
              <section className="viewing-discovery-starter" aria-label={t("初始推荐说明")}>
                <div className="viewing-discovery-starter-copy">
                  <span className="viewing-discovery-kicker">COLD START · TEMPORARY SIGNALS</span>
                  <strong>{t("还没有足够记录，先用馆藏内容生成一组示例")}</strong>
                  <small>{t("这些内容只用于本次预览，不会写入收藏、播放记录或统计；完成")} {bootstrap?.exitThreshold ?? 4} {t("次真实选择后会自动换成个性化推荐。")}</small>
                </div>
                <div className="viewing-discovery-starter-signals">
                  <span><small>{t("参考演员")}</small><strong>{anchorName}</strong></span>
                  <span><small>{t("参考题材")}</small><strong>{starterGenre}</strong></span>
                  <span><small>{t("还会询问")}</small><strong>{questionFacets.map((type) => facetCopy[type].title).join(" / ")}</strong></span>
                </div>
                <Button icon={<RefreshCw size={14} />} onClick={() => setStarterOffset((value) => value + 3)} type="text">{t("换一组示例")}</Button>
              </section>
            ) : null}
            <section className="viewing-discovery-grid" aria-label={t("今晚的选片建议")}>
              <article className="viewing-discovery-hero">
                <PosterMosaic items={previewQueue} />
                <div className="viewing-discovery-hero-copy">
                  <span className="viewing-discovery-kicker">{hero.eyebrow}</span>
                  <Typography.Title level={2}>{hero.title}</Typography.Title>
                  <Typography.Paragraph>{hero.description}</Typography.Paragraph>
                  <div className="viewing-discovery-facts">
                    <span><small>{t("从这里开始")}</small><strong>{hero.anchor}</strong></span>
                    <span><small>{t("这次会变化")}</small><strong>{hero.dimension}</strong><em>{hero.dimensionDetail}</em></span>
                    <span><small>{t("可选影片")}</small><strong>{hero.candidateCount} {t("部")}</strong><em>{t("优先没播过的")}</em></span>
                  </div>
                  <div className="viewing-discovery-duration"><RefreshCw size={15} />{t("每次开始都会重新组合问题和影片")}</div>
                  <div className="viewing-discovery-why"><Sparkles size={16} /><span><strong>{t("为什么推荐这组")}</strong>{hero.whyNow}</span></div>
                  <div className="viewing-discovery-actions">
                    <Button icon={<Play fill="currentColor" size={15} />} loading={generateSession.isPending && generateSession.variables?.preset === hero.config.preset} onClick={() => generateSession.mutate(hero.config)} size="large" type="primary">{t("从这组开始")}</Button>
                    <Button icon={<Route size={15} />} onClick={() => beginCustom(hero.config)} size="large" type="text">{t("调整条件")}</Button>
                  </div>
                </div>
              </article>

              <div className="viewing-discovery-side">
                {[fresh, revisit].map((proposal, index) => (
                  <article className="viewing-discovery-side-card" key={proposal.id}>
                    {previewQueue[index + 1] ? <div aria-hidden="true" className="viewing-discovery-side-visual"><MediaPoster item={previewQueue[index + 1]} /></div> : null}
                    <span className="viewing-discovery-kicker">{proposal.eyebrow}</span>
                    <Typography.Title level={3}>{proposal.title}</Typography.Title>
                    <Typography.Paragraph>{proposal.description}</Typography.Paragraph>
                    <div className="viewing-discovery-side-facts">
                      <span><small>{t("从这里开始")}</small><strong>{proposal.anchor}</strong></span>
                      <span><small>{t("推荐方式")}</small><strong>{proposal.dimensionDetail}</strong></span>
                      <span><small>{t("可选影片")}</small><strong>{proposal.candidateCount} {t("部")}</strong></span>
                    </div>
                    <div className="viewing-discovery-side-footer">
                      <span><RefreshCw size={14} />{t("每次都会换一批")}</span>
                      <Button loading={generateSession.isPending && generateSession.variables?.preset === proposal.config.preset} onClick={() => generateSession.mutate(proposal.config)} type="link">{t("开始选片")} <ArrowRight size={14} /></Button>
                    </div>
                  </article>
                ))}
              </div>
            </section>

            {session ? (
              <section className="viewing-discovery-continue" aria-label={t("继续上次选片")}>
                <div className="viewing-discovery-continue-poster">{queue[0] ? <MediaPoster item={queue[0]} /> : <Route size={20} />}</div>
                <div>
                  <span className="viewing-discovery-kicker">{t("继续上次选片")}</span>
                  <strong>{t("从")} {anchorName} {t("继续挑选相关影片")}</strong>
                  <small>{routeLabel(session.config)} {t("· 已完成")} {session.arena.answered}/{session.arena.total} {t("轮选择")}</small>
                </div>
                <span className="viewing-discovery-progress"><i style={{ width: `${Math.round((session.arena.answered / Math.max(1, session.arena.total)) * 100)}%` }} /></span>
                <Button icon={<Play fill="currentColor" size={14} />} onClick={() => { setViewMode("session"); beginArenaEntrance(); }} type="primary">{t("继续选片")}</Button>
              </section>
            ) : null}

            {history.length ? (
              <PreferenceHistory
                activeId={session?.id}
                deletingId={deleteSession.isPending ? deleteSession.variables : null}
                loadingId={restoreSession.isPending ? restoreSession.variables : null}
                onDelete={(item) => deleteSession.mutate(item.id)}
                onSelect={(item) => restoreSession.mutate(item.id)}
                sessions={history}
              />
            ) : null}
          </>
        )}
      </main>
    );
  }

  return (
    <main className={`viewing-desk${viewMode === "session" && session ? (showArena ? " is-arena-mode" : " is-results-mode") : ""}`}>
      {messageContextHolder}
      <header className="viewing-desk-header">
        <div>
          <span className="viewing-desk-eyebrow">PERSONAL DISCOVERY</span>
          <Typography.Title level={2}>{viewMode === "custom" ? t("设置这次的选片条件") : t("为今晚挑一组影片")}</Typography.Title>
          <Typography.Text type="secondary">{viewMode === "custom" ? t("回答几个简单问题，让推荐更贴近现在的心情") : t("在几组影片中选出更想看的，片单会随你的选择变化")}</Typography.Text>
        </div>
        <Button icon={<ArrowLeft size={15} />} onClick={() => setViewMode("landing")}>{t("返回选片首页")}</Button>
      </header>

      {viewMode === "session" && activeSessionQuery.isPending && !session ? (
        <div className="viewing-desk-centered"><Skeleton active paragraph={{ rows: 5 }} /></div>
      ) : viewMode === "session" && showArena && session && currentArenaRound ? (
        <section className={`viewing-arena is-${arenaTransitionPhase}`} aria-busy={arenaInteractionLocked} aria-live="polite">
          <div className="viewing-arena-heading">
            <div>
              <span className="viewing-desk-guide-eyebrow">{currentArenaRound.strategyLabel} {t("· 随选随调")}</span>
              <Typography.Title level={2}>{currentArenaRound.prompt || t("这两部里，你现在更想看哪一部？")}</Typography.Title>
              <Typography.Text type="secondary">{t("选完会马上换一组；如果都喜欢或都不喜欢，也可以直接告诉我们")}</Typography.Text>
            </div>
            <span><small>{t("当前轮次")}</small>{session.arena.answered + 1} / {session.arena.total}</span>
          </div>
          <div aria-label={t("已完成 {{p0}} / {{p1}} 轮", { p0: session.arena.answered, p1: session.arena.total })} className="viewing-arena-progress" style={{ gridTemplateColumns: `repeat(${session.arena.total}, minmax(0, 1fr))` }}>
            {session.arena.rounds.map((round) => (
              <span className={round.decision ? "is-complete" : round.roundIndex === currentArenaRound.roundIndex ? "is-current" : ""} key={round.roundIndex} title={round.strategyLabel} />
            ))}
          </div>
          <div className="viewing-arena-layout">
            <div className="viewing-arena-comparison">
              <div className="viewing-arena-match">
                <ArenaChoiceCard
                  disabled={arenaInteractionLocked}
                  item={currentArenaRound.left}
                  language={metadataLanguage}
                  motion={arenaCardMotion(currentArenaRound.leftMediaId)}
                  onChoose={() => submitArenaAction({ action: "choose", sessionId: session.id, roundIndex: currentArenaRound.roundIndex, winnerMediaId: currentArenaRound.leftMediaId })}
                  side="A"
                />
                <div className="viewing-arena-versus"><Swords size={22} /><strong>VS</strong></div>
                <ArenaChoiceCard
                  disabled={arenaInteractionLocked}
                  item={currentArenaRound.right}
                  language={metadataLanguage}
                  motion={arenaCardMotion(currentArenaRound.rightMediaId)}
                  onChoose={() => submitArenaAction({ action: "choose", sessionId: session.id, roundIndex: currentArenaRound.roundIndex, winnerMediaId: currentArenaRound.rightMediaId })}
                  side="B"
                />
              </div>
              <div className="viewing-arena-neutral-actions" aria-label={t("其他选择")}>
                <Button disabled={arenaInteractionLocked} icon={<Shuffle size={15} />} onClick={() => submitArenaAction({ action: "reroll", sessionId: session.id, roundIndex: currentArenaRound.roundIndex })}>{t("换一组影片")}</Button>
                <Button disabled={arenaInteractionLocked} icon={<Equal size={15} />} onClick={() => submitArenaAction({ action: "both", sessionId: session.id, roundIndex: currentArenaRound.roundIndex })}>{t("两部都想看")}</Button>
                <Button danger disabled={arenaInteractionLocked} icon={<Ban size={15} />} onClick={() => submitArenaAction({ action: "reject", sessionId: session.id, roundIndex: currentArenaRound.roundIndex })}>{t("都不想看")}</Button>
              </div>
            </div>
            <ArenaProfilePanel profile={session.arena.profile} strategyLabel={currentArenaRound.strategyLabel} />
          </div>
        </section>
      ) : viewMode === "session" && session ? (
        <section className={`viewing-results is-${arenaTransitionPhase}`} aria-live="polite">
          <div className="viewing-results-overview">
            <div>
              <span className="viewing-desk-guide-eyebrow">{t("三组片单")}</span>
              <Typography.Title level={2}>{t("根据刚才的选择，我们准备了三组片单")}</Typography.Title>
              <Typography.Text type="secondary">{t("第一组最贴近口味，第二组保留熟悉感但更有变化，第三组用来试试平时较少看的方向。")}</Typography.Text>
            </div>
            <div className="viewing-desk-preference-tags">
              <Tag>{presetOptions.find((item) => item.value === session.config.preset)?.title}</Tag>
              <Tag>{discoveryOptions.find((item) => item.value === getDiscoveryStyle(session.config))?.title}</Tag>
              {session.arena.profile.positiveSignals.slice(0, 4).map((signal) => <Tag key={`${signal.type}:${signal.value}`}>{signalLabel(signal)}</Tag>)}
            </div>
          </div>
          <div aria-label={t("推荐片单分组")} className="viewing-result-lanes" role="tablist">
            {session.lanes.map((lane) => {
              const presentation = lanePresentation[lane.id];
              const Icon = presentation.icon;
              return (
                <button
                  aria-controls="viewing-lane-panel"
                  aria-selected={availableLane === lane.id}
                  className={availableLane === lane.id ? "is-active" : ""}
                  disabled={lane.count === 0}
                  key={lane.id}
                  onClick={() => setActiveLane(lane.id)}
                  role="tab"
                  type="button"
                >
                  <Icon size={18} />
                  <span><small>{presentation.eyebrow}</small><strong>{presentation.label}</strong><em>{presentation.description}</em></span>
                  <b>{lane.count}<small>{t("部")}</small></b>
                </button>
              );
            })}
          </div>
          <div className="viewing-results-toolbar">
            <div className="viewing-results-toolbar-copy">
              <span><Layers3 size={16} />{lanePresentation[availableLane].label}</span>
              <small>{lanePresentation[availableLane].description}</small>
            </div>
            <div className="viewing-results-toolbar-actions">
              <Button
                disabled={!visibleQueue.length}
                icon={<Play fill="currentColor" size={14} />}
                onClick={() => visibleQueue[0] && onPlay(visibleQueue[0], visibleQueue)}
                type="primary"
              >
                {t("播放这一组")} </Button>
              <Button
                disabled={!visibleQueue.length}
                icon={<ListPlus size={15} />}
                loading={saveLanePlaylist.isPending}
                onClick={() => saveLanePlaylist.mutate({
                  description: t("根据“{{p0}}”中的“{{p1}}”推荐生成。", { p0: routeLabel(session.config), p1: lanePresentation[availableLane].label }),
                  mediaIds: visibleQueue.map((item) => item.id),
                  name: `竞技场 · ${lanePresentation[availableLane].label} · ${new Intl.DateTimeFormat(getIntlLocale(), { month: "numeric", day: "numeric" }).format(new Date())}`
                })}
              >
                {t("保存为片单")} </Button>
              {session.arena.canBranch ? (
                <Button
                  icon={<GitBranch size={15} />}
                  loading={branchSession.isPending}
                  onClick={() => branchSession.mutate({ lane: availableLane, sessionId: session.id })}
                >
                  {t("再选几轮")} </Button>
              ) : <span className="viewing-results-complete"><Check size={14} />{t("本次选择已完成")}</span>}
            </div>
          </div>
          {visibleEntries.length ? (
            <div className="viewing-recommendation-grid" id="viewing-lane-panel" role="tabpanel">
              {visibleEntries.map((entry) => (
                <RecommendationCard
                  disabled={resultFeedback.isPending}
                  feedback={entry.feedback}
                  item={entry.media}
                  key={entry.media.id}
                  language={metadataLanguage}
                  onLike={() => resultFeedback.mutate({
                    feedback: entry.feedback === "like" ? "clear" : "like",
                    mediaId: entry.media.id,
                    sessionId: session.id
                  })}
                  onOpen={() => onOpenMedia(entry.media, visibleQueue)}
                  onPlay={() => onPlay(entry.media, visibleQueue)}
                  onReplace={() => resultFeedback.mutate({
                    feedback: "dislike",
                    mediaId: entry.media.id,
                    sessionId: session.id
                  })}
                  pendingFeedback={resultFeedback.variables?.mediaId === entry.media.id
                    ? resultFeedback.variables.feedback
                    : undefined}
                  reason={entry.reason}
                  selected={winners.has(entry.media.id)}
                />
              ))}
            </div>
          ) : <Empty description={t("这一组暂时没有可推荐的影片")} />}
        </section>
      ) : (
        <section className="viewing-desk-guide" aria-live="polite">
          {generateSession.isPending ? (
            <div className={`viewing-desk-guide-card is-${wizardTransitionPhase}`}><Skeleton active paragraph={{ rows: 6 }} /></div>
          ) : generateSession.isError ? (
            <Alert
              action={<Button onClick={() => generateSession.mutate(customConfig)} size="small">{t("重试")}</Button>}
              description={generateSession.error instanceof Error ? generateSession.error.message : t("暂时无法生成片单")}
              message={t("片单生成失败")}
              showIcon
              type="error"
            />
          ) : wizard ? (
            <div className={`viewing-desk-guide-card is-${wizardTransitionPhase}`}>
              <div className="viewing-desk-guide-progress">
                {Array.from({ length: WIZARD_STEP_COUNT }, (_, index) => <span className={index <= wizardStep ? "is-active" : ""} key={index} />)}
              </div>
              <span className="viewing-desk-guide-eyebrow">{wizard.eyebrow}</span>
              <Typography.Title level={2}>{wizard.title}</Typography.Title>
              <Typography.Text type="secondary">{wizard.description}</Typography.Text>
              <div className={`viewing-desk-answer-grid${wizard.options.some((option) => option.coverMediaId !== undefined) ? " has-covers" : ""}`}>
                {wizard.options.map((option) => {
                  const Icon = option.icon;
                  return (
                    <button
                      className={`${option.selected ? "is-selected" : ""}${wizardConfirmedValue === String(option.value) ? " is-confirmed" : ""}`}
                      disabled={wizardTransitionPhase !== "idle"}
                      key={String(option.value)}
                      onClick={option.onClick}
                      type="button"
                    >
                      <FacetOptionCover icon={Icon} mediaId={option.coverMediaId} title={option.title} />
                      <span><strong>{option.title}</strong><small>{option.description}</small></span>
                      {option.selected ? <Check className="viewing-desk-answer-check" size={16} /> : null}
                    </button>
                  );
                })}
              </div>
              <div className="viewing-desk-guide-navigation">
                {wizardStep > 0 ? <Button disabled={wizardTransitionPhase !== "idle"} icon={<ArrowLeft size={14} />} onClick={() => setWizardStep((value) => Math.max(0, value - 1))} type="text">{t("上一步")}</Button> : <span />}
                {wizard.onShuffle ? <Button disabled={wizardTransitionPhase !== "idle"} icon={<RefreshCw size={14} />} loading={wizard.shuffleLoading} onClick={wizard.onShuffle}>{t("换一组选项")}</Button> : null}
              </div>
            </div>
          ) : (
            <div className={`viewing-desk-guide-card viewing-desk-review-card is-${wizardTransitionPhase}`}>
              <div className="viewing-desk-guide-progress">{Array.from({ length: WIZARD_STEP_COUNT }, (_, index) => <span className="is-active" key={index} />)}</div>
              <span className="viewing-desk-guide-eyebrow">{t("确认本次选择")}</span>
              <Typography.Title level={2}>{t("接下来，从几组封面中选出更想看的")}</Typography.Title>
              <Typography.Text type="secondary">{t("通常需要 4–6 轮；遇到都不合适的影片，可以直接换一组")}</Typography.Text>
              <div className="viewing-desk-review-grid">
                <span><small>{t("选片方式")}</small><strong>{presetOptions.find((item) => item.value === preset)?.title}</strong></span>
                <span><small>{t("想看多新")}</small><strong>{selectedDiscovery.title}</strong></span>
                {questionFacets.map((type) => <span key={type}><small>{facetCopy[type].title}</small><strong>{preferredLabels[type] ?? t("{{p0}}不限", { p0: facetCopy[type].title })}</strong></span>)}
              </div>
              <div className="viewing-desk-review-actions">
                <Button disabled={wizardTransitionPhase !== "idle"} icon={<ArrowLeft size={15} />} onClick={() => setWizardStep(WIZARD_STEP_COUNT - 1)}>{t("返回修改")}</Button>
                <Button disabled={wizardTransitionPhase !== "idle"} icon={<Swords size={16} />} loading={generateSession.isPending} onClick={startCustomSession} size="large" type="primary">{t("开始选片")}</Button>
              </div>
            </div>
          )}
        </section>
      )}
    </main>
  );
}

export type { ViewingDeskProps };
