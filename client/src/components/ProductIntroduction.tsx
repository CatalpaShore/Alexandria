import { getIntlLocale } from "../i18n/core";
import { t, useLocale, useLocalizedMemo } from "../i18n";
import { Button } from "antd";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import {
  Activity,
  ArrowDown,
  ArrowRight,
  BrainCircuit,
  Clock3,
  Database,
  Film,
  HardDrive,
  LibraryBig,
  Network,
  PanelsTopLeft,
  Play,
  RadioTower,
  ShieldCheck,
  Sparkles,
  Tag,
  UserRound,
  UsersRound
} from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type SyntheticEvent } from "react";
import { useReducedMotion } from "../hooks/useReducedMotion";
import {
  formatBytes,
  type MediaItem
} from "../lib/api";
import productIntroductionSnapshotJson from "../generated/productIntroductionSnapshot.json";
import "../product-introduction.css";
import { ProductShowcase } from "./ProductShowcase";

// Catalog mockups use licensed non-adult film artwork and mock records; the separately
// redacted recording and its content boundaries are described in ProductShowcase.

type ProductIntroductionProps = {
  onEnterLibrary: () => void;
  onOpenCurator: () => void;
  onOpenEntity: (entity: { type: "actor"; value: string; label?: string }) => void;
  onOpenMedia: (item: MediaItem, queue?: MediaItem[]) => void;
  onOpenMine: () => void;
  onOpenTopics: () => void;
  onOpenViewingDesk: () => void;
};

type IntroSection = {
  id: string;
  label: string;
};

type IntroActorAsset = {
  value: string;
  label: string;
  count: number;
  imageUrl: string;
};

type IntroMediaItem = MediaItem & {
  introPosterUrl: string;
};

type ProductIntroductionSnapshot = {
  version: 1;
  generatedAt: string;
  source: "pre-generated-local-library";
  seed: number;
  total: number;
  totalSize: number;
  actorAssetCount: number;
  favoriteMediaIds: string[];
  actorAssets: IntroActorAsset[];
  mediaItems: IntroMediaItem[];
};

type IntroFlowSignal = {
  domain: string;
  label: string;
  value: string;
  detail: string;
  meta: string;
  imageUrl?: string;
  imageAlt?: string;
  mediaId?: string;
  kind: "media" | "actor" | "index" | "storage";
};

const INTRO_SECTIONS: IntroSection[] = [
  { id: "intro-preview", get label() { return t("效果预览"); } },
  { id: "intro-hero", get label() { return t("概览"); } },
  { id: "intro-wall", get label() { return t("媒体墙"); } },
  { id: "intro-topics", get label() { return t("专题"); } },
  { id: "intro-viewing", get label() { return t("观影台"); } },
  { id: "intro-curator", get label() { return t("馆长"); } },
  { id: "intro-mine", get label() { return t("我的"); } }
];

const productIntroductionSnapshot = productIntroductionSnapshotJson as ProductIntroductionSnapshot;

gsap.registerPlugin(ScrollTrigger);

function getMediaTitle(item: MediaItem): string {
  const metadata = item.metadata;
  return metadata?.titleZh
    || metadata?.title
    || item.normalizedCode
    || item.basename.replace(/\.[^.]+$/, "")
    || t("馆藏作品");
}

function handleMediaImageError(event: SyntheticEvent<HTMLImageElement>) {
  const image = event.currentTarget;
  if (image.dataset.fallback === "brand") return;
  image.dataset.fallback = "brand";
  image.src = "/brand-icon.png";
}

function getIntroPosterUrl(item: MediaItem): string {
  return "introPosterUrl" in item && typeof item.introPosterUrl === "string"
    ? item.introPosterUrl
    : "/brand-icon.png";
}

function getMediaActorLabel(item: MediaItem): string {
  const metadata = item.metadata;
  return metadata?.actorsZh?.[0]
    || metadata?.actors?.[0]
    || t("演员资料整理中");
}

function getMediaTopicLabel(item: MediaItem): string {
  const metadata = item.metadata;
  return metadata?.seriesZh
    || metadata?.series
    || metadata?.genresZh?.[0]
    || metadata?.genres?.[0]
    || item.sourceName
    || t("本地馆藏");
}

function IntroHeroCover({
  item,
  index,
  queue,
  fromFavoriteTopic,
  onOpen
}: {
  item: MediaItem;
  index: number;
  queue: MediaItem[];
  fromFavoriteTopic: boolean;
  onOpen: ProductIntroductionProps["onOpenMedia"];
}) {
  useLocale();
  return (
    <button
      className={`intro-hero-cover${index === 0 ? " is-featured" : ""}`}
      data-intro-cover-card
      onClick={() => onOpen(item, queue)}
      style={{ "--intro-item-index": index } as CSSProperties}
      title={t("打开 {{p0}}", { p0: getMediaTitle(item) })}
      type="button"
    >
      <span className="intro-hero-cover-image">
        <img
          alt=""
          aria-hidden="true"
          className="intro-hero-cover-backdrop"
          data-media-id={item.id}
          loading={index < 3 ? "eager" : "lazy"}
          onError={handleMediaImageError}
          src={getIntroPosterUrl(item)}
        />
        <img
          alt=""
          className="intro-hero-cover-poster"
          data-cover-source={fromFavoriteTopic ? "favorite-topic" : "library"}
          data-media-id={item.id}
          loading={index < 3 ? "eager" : "lazy"}
          onError={handleMediaImageError}
          src={getIntroPosterUrl(item)}
        />
        <span className="intro-hero-cover-source">{fromFavoriteTopic ? t("收藏专题") : t("本地馆藏")}</span>
      </span>
      <span className="intro-hero-cover-meta">
        <strong>{item.normalizedCode || item.basename.replace(/\.[^.]+$/, "")}</strong>
        <span>{getMediaActorLabel(item)}</span>
        <small>{getMediaTopicLabel(item)}</small>
      </span>
    </button>
  );
}

function IntroCoverBackdrop({
  items,
  variant
}: {
  items: MediaItem[];
  variant: "hero" | "transition" | "story" | "finale";
}) {
  useLocale();
  return (
    <div aria-hidden="true" className={`intro-cover-backdrop is-${variant}`} data-intro-cover-backdrop>
      <div className="intro-cover-backdrop-track">
        {items.slice(0, 8).map((item, index) => (
          <figure key={item.id} style={{ "--intro-backdrop-index": index } as CSSProperties}>
            <img
              alt=""
              data-media-id={item.id}
              loading={variant === "hero" && index < 4 ? "eager" : "lazy"}
              onError={handleMediaImageError}
              src={getIntroPosterUrl(item)}
            />
            <figcaption>{item.normalizedCode || getMediaTitle(item)}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

function IntroModuleDemo({
  alt,
  caption,
  label,
  onOpen,
  poster,
  reducedMotion,
  video
}: {
  alt: string;
  caption: string;
  label: string;
  onOpen: () => void;
  poster: string;
  reducedMotion: boolean;
  video: string;
}) {
  useLocale();
  const demoRef = useRef<HTMLButtonElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const demo = demoRef.current;
    const preview = videoRef.current;
    if (!demo || !preview || reducedMotion) return undefined;

    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting && entry.intersectionRatio >= 0.28) {
        void preview.play().catch(() => undefined);
      } else {
        preview.pause();
      }
    }, {
      rootMargin: "120px 0px",
      threshold: [0, 0.28, 0.65]
    });

    observer.observe(demo);
    return () => {
      observer.disconnect();
      preview.pause();
    };
  }, [reducedMotion]);

  return (
    <button
      className="intro-module-demo motion-pressable"
      data-intro-module-demo
      data-intro-reveal
      onClick={onOpen}
      ref={demoRef}
      title={t("打开{{p0}}", { p0: label })}
      type="button"
    >
      <span className="intro-module-demo-bar">
        <span><i aria-hidden="true" /><Activity size={14} /> {label}</span>
        <small>LOCAL LIBRARY · OPEN SOURCE</small>
      </span>
      <span className="intro-module-demo-viewport">
        {reducedMotion || !video ? (
          <img alt={alt} decoding="async" loading="lazy" src={poster} />
        ) : (
          <video
            aria-label={alt}
            loop
            muted
            playsInline
            poster={poster}
            preload="none"
            ref={videoRef}
          >
            <source src={video} type="video/mp4" />
          </video>
        )}
      </span>
      <span className="intro-module-demo-footer">
        <span><strong>{caption}</strong><small>{t("演示图示 · 点击进入完整模块")}</small></span>
        <span>{t("打开模块")} <ArrowRight size={15} /></span>
      </span>
    </button>
  );
}

function IntroFlowTransition({
  from,
  to,
  title,
  detail,
  signals,
  backgroundMedia,
  reverse = false
}: {
  from: string;
  to: string;
  title: string;
  detail: string;
  signals: IntroFlowSignal[];
  backgroundMedia: MediaItem[];
  reverse?: boolean;
}) {
  useLocale();
  return (
    <section
      className={`intro-flow-transition${reverse ? " is-reverse" : ""}`}
      data-intro-transition
    >
      <div className="intro-flow-pin">
        <IntroCoverBackdrop items={backgroundMedia} variant="transition" />
        <div className="intro-flow-stage">
          <div className="intro-flow-copy">
            <span className="intro-flow-kicker">{from}<i />{to}</span>
            <strong aria-label={title}>
              <span className="intro-motion-line"><span>{title}</span></span>
            </strong>
            <small data-intro-copy-step>{detail}</small>
          </div>
          <div className="intro-flow-data" aria-label={t("{{p0}} 到 {{p1}} 的本地数据演进", { p0: from, p1: to })}>
            <div className="intro-flow-data-head">
              <span>DEMO SNAPSHOT INSTANCES</span>
              <span>{String(Math.min(signals.length, 4)).padStart(2, "0")} DATA CARDS</span>
            </div>
            <div className="intro-flow-card-grid">
              {signals.slice(0, 4).map((signal, index) => (
                <article className={`intro-flow-signal is-${signal.kind}`} data-intro-flow-signal key={`${signal.label}-${signal.value}-${index}`}>
                  <header className="intro-flow-signal-head">
                    <span className="intro-flow-signal-index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                    <span>{signal.domain}</span>
                    <small>{signal.label}</small>
                  </header>
                  <div className="intro-flow-signal-body">
                    <span className="intro-flow-signal-visual">
                      {signal.imageUrl ? (
                        <>
                          <img
                            alt=""
                            aria-hidden="true"
                            className="intro-flow-signal-backdrop"
                            loading="lazy"
                            onError={handleMediaImageError}
                            src={signal.imageUrl}
                          />
                          <img
                            alt={signal.imageAlt || ""}
                            className="intro-flow-signal-poster"
                            data-media-id={signal.mediaId}
                            loading="lazy"
                            onError={handleMediaImageError}
                            src={signal.imageUrl}
                          />
                        </>
                      ) : signal.kind === "storage" ? (
                        <HardDrive aria-hidden="true" size={24} />
                      ) : signal.kind === "actor" ? (
                        <UsersRound aria-hidden="true" size={24} />
                      ) : signal.kind === "media" ? (
                        <Film aria-hidden="true" size={24} />
                      ) : (
                        <Network aria-hidden="true" size={24} />
                      )}
                    </span>
                    <span className="intro-flow-signal-copy">
                      <strong title={signal.value}>{signal.value}</strong>
                      <span>{signal.detail}</span>
                    </span>
                  </div>
                  <footer className="intro-flow-signal-meta">
                    <span>{signal.meta}</span>
                    <ArrowRight aria-hidden="true" className="intro-flow-signal-arrow" size={14} />
                  </footer>
                </article>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function ProductIntroduction({
  onEnterLibrary,
  onOpenCurator,
  onOpenEntity,
  onOpenMine,
  onOpenTopics,
  onOpenViewingDesk
}: ProductIntroductionProps) {
  useLocale();
  const rootRef = useRef<HTMLElement | null>(null);
  const reducedMotion = useReducedMotion();
  const [activeSection, setActiveSection] = useState(INTRO_SECTIONS[0].id);
  const showcaseMedia = productIntroductionSnapshot.mediaItems;
  const introTotal = productIntroductionSnapshot.total;
  const introTotalSize = productIntroductionSnapshot.totalSize;
  const actorAssets = productIntroductionSnapshot.actorAssets;
  const actorAssetCount = productIntroductionSnapshot.actorAssetCount;
  const heroBackgroundMedia = showcaseMedia.slice(0, 6);
  const heroMedia = showcaseMedia.slice(6, 11);
  const wallTransitionBackgroundMedia = showcaseMedia.slice(11, 16);
  const wallTransitionSignalMedia = showcaseMedia.slice(16, 19);
  const topicsTransitionBackgroundMedia = showcaseMedia.slice(29, 34);
  const topicsTransitionSignalMedia = showcaseMedia.slice(34, 37);
  const viewingTransitionBackgroundMedia = showcaseMedia.slice(46, 51);
  const viewingTransitionSignalMedia = showcaseMedia.slice(51, 54);
  const curatorTransitionBackgroundMedia = showcaseMedia.slice(63, 68);
  const mineTransitionBackgroundMedia = showcaseMedia.slice(73, 78);
  const mineTransitionSignalMedia = showcaseMedia.slice(78, 80);
  const finaleBackgroundMedia = showcaseMedia.slice(83, 88);
  const finaleMedia = showcaseMedia.slice(88, 91);
  const favoriteTopicMediaIds = useLocalizedMemo(
    () => new Set(productIntroductionSnapshot.favoriteMediaIds),
    []
  );
  const featuredFavoriteTopicCount = heroMedia.filter((item) => favoriteTopicMediaIds.has(item.id)).length;
  const sourceSignals = useLocalizedMemo(
    () => Array.from(new Set(showcaseMedia.map((item) => item.sourceName).filter(Boolean))).slice(0, 3),
    [showcaseMedia]
  );
  const isMotionDataReady = true;
  const transitionSignals = useLocalizedMemo(() => {
    const wallFirstMedia = wallTransitionSignalMedia[0];
    const wallSecondMedia = wallTransitionSignalMedia[1] || wallFirstMedia;
    const wallThirdMedia = wallTransitionSignalMedia[2] || wallSecondMedia;
    const topicsFirstMedia = topicsTransitionSignalMedia[0];
    const topicsSecondMedia = topicsTransitionSignalMedia[1] || topicsFirstMedia;
    const topicsThirdMedia = topicsTransitionSignalMedia[2] || topicsSecondMedia;
    const viewingFirstMedia = viewingTransitionSignalMedia[0];
    const viewingSecondMedia = viewingTransitionSignalMedia[1] || viewingFirstMedia;
    const viewingThirdMedia = viewingTransitionSignalMedia[2] || viewingSecondMedia;
    const mineFirstMedia = mineTransitionSignalMedia[0];
    const mineSecondMedia = mineTransitionSignalMedia[1] || mineFirstMedia;
    const firstActor = actorAssets[0];
    const secondActor = actorAssets[1];
    const thirdActor = actorAssets[2];
    const firstSource = sourceSignals[0];
    const secondSource = sourceSignals[1];
    const thirdSource = sourceSignals[2];

    return {
      wall: [
        {
          domain: t("影片实例"),
          label: t("全库浏览"),
          value: wallFirstMedia?.normalizedCode || t("正在读取媒体墙"),
          detail: wallFirstMedia
            ? `${wallFirstMedia.sourceName || t("本地设备")} · ${formatBytes(wallFirstMedia.size)}`
            : t("正在连接馆藏"),
          imageUrl: wallFirstMedia ? getIntroPosterUrl(wallFirstMedia) : undefined,
          imageAlt: "",
          mediaId: wallFirstMedia?.id,
          meta: wallFirstMedia ? formatBytes(wallFirstMedia.size) : t("本地快照"),
          kind: "media"
        },
        {
          domain: t("演员维度"),
          label: t("组合筛选"),
          value: wallSecondMedia ? getMediaActorLabel(wallSecondMedia) : t("演员、系列与标签"),
          detail: wallSecondMedia ? getMediaTitle(wallSecondMedia) : t("快速缩小到想看的作品"),
          imageUrl: wallSecondMedia ? getIntroPosterUrl(wallSecondMedia) : undefined,
          imageAlt: "",
          mediaId: wallSecondMedia?.id,
          meta: wallSecondMedia?.sourceName || t("本地设备"),
          kind: "media"
        },
        {
          domain: t("题材维度"),
          label: t("实例发现"),
          value: wallThirdMedia?.normalizedCode || t("示例馆藏实例"),
          detail: wallThirdMedia ? `${getMediaActorLabel(wallThirdMedia)} · ${getMediaTopicLabel(wallThirdMedia)}` : t("从预生成快照直接呈现"),
          imageUrl: wallThirdMedia ? getIntroPosterUrl(wallThirdMedia) : undefined,
          imageAlt: "",
          mediaId: wallThirdMedia?.id,
          meta: wallThirdMedia ? formatBytes(wallThirdMedia.size) : t("静态数据"),
          kind: "media"
        },
        {
          domain: t("馆藏索引"),
          label: t("统一馆藏"),
          value: introTotal > 0 ? t("{{p0}} 部影片", { p0: introTotal.toLocaleString(getIntlLocale()) }) : t("正在整理馆藏"),
          detail: t("网格、长列表与移动端浏览保持同步"),
          meta: t("预生成本地快照"),
          kind: "index"
        }
      ],
      topics: [
        {
          domain: t("系列专题"),
          label: t("专题入口"),
          value: topicsFirstMedia ? getMediaTopicLabel(topicsFirstMedia) : t("正在生成专题"),
          detail: topicsFirstMedia ? getMediaTitle(topicsFirstMedia) : t("按系列、演员与题材聚合"),
          imageUrl: topicsFirstMedia ? getIntroPosterUrl(topicsFirstMedia) : undefined,
          imageAlt: "",
          mediaId: topicsFirstMedia?.id,
          meta: topicsFirstMedia?.normalizedCode || t("示例实例"),
          kind: "media"
        },
        {
          domain: t("演员专题"),
          label: t("收藏策展"),
          value: topicsSecondMedia ? getMediaActorLabel(topicsSecondMedia) : t("保存常看主题"),
          detail: t("收藏专题、维护封面并持续补充作品"),
          imageUrl: topicsSecondMedia ? getIntroPosterUrl(topicsSecondMedia) : undefined,
          imageAlt: "",
          mediaId: topicsSecondMedia?.id,
          meta: topicsSecondMedia?.sourceName || t("本地专题"),
          kind: "media"
        },
        {
          domain: t("题材专题"),
          label: t("自动聚合"),
          value: topicsThirdMedia ? getMediaTopicLabel(topicsThirdMedia) : t("题材专题"),
          detail: topicsThirdMedia ? `${getMediaActorLabel(topicsThirdMedia)} · ${getMediaTitle(topicsThirdMedia)}` : t("按示例元数据持续补充作品"),
          imageUrl: topicsThirdMedia ? getIntroPosterUrl(topicsThirdMedia) : undefined,
          imageAlt: "",
          mediaId: topicsThirdMedia?.id,
          meta: topicsThirdMedia?.normalizedCode || t("本地元数据"),
          kind: "media"
        },
        {
          domain: t("关系数据"),
          label: t("关系探索"),
          value: "演员 · 系列 · 导演 · 题材",
          detail: t("沿任意维度继续发现相关作品"),
          meta: t("{{p0}} 份演员档案", { p0: actorAssetCount.toLocaleString(getIntlLocale()) }),
          kind: "index"
        }
      ],
      viewing: [
        {
          domain: t("贴近口味"),
          label: t("今晚片单"),
          value: viewingFirstMedia?.normalizedCode || t("正在生成片单"),
          detail: viewingFirstMedia ? getMediaTitle(viewingFirstMedia) : t("根据收藏与观看记录选片"),
          imageUrl: viewingFirstMedia ? getIntroPosterUrl(viewingFirstMedia) : undefined,
          imageAlt: "",
          mediaId: viewingFirstMedia?.id,
          meta: viewingFirstMedia ? getMediaTopicLabel(viewingFirstMedia) : t("推荐实例"),
          kind: "media"
        },
        {
          domain: t("相邻探索"),
          label: t("相邻探索"),
          value: viewingSecondMedia ? getMediaActorLabel(viewingSecondMedia) : t("拓展相近口味"),
          detail: t("每部推荐都保留可理解的理由"),
          imageUrl: viewingSecondMedia ? getIntroPosterUrl(viewingSecondMedia) : undefined,
          imageAlt: "",
          mediaId: viewingSecondMedia?.id,
          meta: viewingSecondMedia?.normalizedCode || t("推荐实例"),
          kind: "media"
        },
        {
          domain: t("大胆尝试"),
          label: t("拓展口味"),
          value: viewingThirdMedia?.normalizedCode || t("新的观看方向"),
          detail: viewingThirdMedia ? `${getMediaActorLabel(viewingThirdMedia)} · ${getMediaTitle(viewingThirdMedia)}` : t("从未看内容中补充候选"),
          imageUrl: viewingThirdMedia ? getIntroPosterUrl(viewingThirdMedia) : undefined,
          imageAlt: "",
          mediaId: viewingThirdMedia?.id,
          meta: viewingThirdMedia?.sourceName || t("本地推荐"),
          kind: "media"
        },
        {
          domain: t("播放动作"),
          label: t("连续观看"),
          value: "多组候选影片",
          detail: t("直接播放、加入片单或稍后观看"),
          meta: t("播放 · 收藏 · 稍后观看"),
          kind: "index"
        }
      ],
      curator: [
        {
          domain: t("演员关系"),
          label: t("理解馆藏"),
          value: firstActor?.label || t("本地智能馆长"),
          detail: firstActor ? t("{{p0}} 部作品已建立关系", { p0: firstActor.count.toLocaleString(getIntlLocale()) }) : t("理解演员、系列与题材关系"),
          imageUrl: firstActor?.imageUrl,
          imageAlt: firstActor?.label,
          meta: firstActor ? t("{{p0}} 部关联作品", { p0: firstActor.count.toLocaleString(getIntlLocale()) }) : t("本地关系"),
          kind: "actor"
        },
        {
          domain: t("实体关系"),
          label: t("对话检索"),
          value: secondActor?.label || t("直接描述想看什么"),
          detail: secondActor ? t("可从 {{p0}} 部作品继续推理", { p0: secondActor.count.toLocaleString(getIntlLocale()) }) : t("用自然语言检索私人馆藏"),
          imageUrl: secondActor?.imageUrl,
          imageAlt: secondActor?.label,
          meta: secondActor ? t("{{p0}} 部关联作品", { p0: secondActor.count.toLocaleString(getIntlLocale()) }) : t("本地检索"),
          kind: "actor"
        },
        {
          domain: t("知识关系"),
          label: t("关系推理"),
          value: thirdActor?.label || t("跨维度理解"),
          detail: thirdActor ? t("{{p0}} 部作品已建立关系", { p0: thirdActor.count.toLocaleString(getIntlLocale()) }) : t("连接演员、系列、题材和影片"),
          imageUrl: thirdActor?.imageUrl,
          imageAlt: thirdActor?.label,
          meta: thirdActor ? t("{{p0}} 部关联作品", { p0: thirdActor.count.toLocaleString(getIntlLocale()) }) : t("本地知识图谱"),
          kind: "actor"
        },
        {
          domain: t("任务执行"),
          label: t("执行任务"),
          value: "检索 · 整理 · 推荐 · 解释",
          detail: t("从回答直接跳转影片、专题或观影台"),
          meta: t("基于预生成馆藏索引"),
          kind: "index"
        }
      ],
      mine: [
        {
          domain: t("继续观看"),
          label: t("个人首页"),
          value: mineFirstMedia?.normalizedCode || t("收藏、片单与继续观看"),
          detail: mineFirstMedia ? getMediaTitle(mineFirstMedia) : t("把个人内容汇总成一个入口"),
          imageUrl: mineFirstMedia ? getIntroPosterUrl(mineFirstMedia) : undefined,
          imageAlt: "",
          mediaId: mineFirstMedia?.id,
          meta: mineFirstMedia ? formatBytes(mineFirstMedia.size) : t("个人数据"),
          kind: "media"
        },
        {
          domain: t("收藏专题"),
          label: t("偏好沉淀"),
          value: mineSecondMedia ? getMediaActorLabel(mineSecondMedia) : t("收藏与观看偏好"),
          detail: mineSecondMedia ? `${getMediaTopicLabel(mineSecondMedia)} · ${getMediaTitle(mineSecondMedia)}` : t("长期记录持续完善个人主页"),
          imageUrl: mineSecondMedia ? getIntroPosterUrl(mineSecondMedia) : undefined,
          imageAlt: "",
          mediaId: mineSecondMedia?.id,
          meta: mineSecondMedia?.normalizedCode || t("个人内容"),
          kind: "media"
        },
        {
          domain: t("存储来源"),
          label: t("馆藏洞察"),
          value: firstSource || secondSource || thirdSource || t("本地馆藏统计"),
          detail: t("查看容量、来源、偏好与整理进度"),
          meta: [firstSource, secondSource, thirdSource].filter(Boolean).join(" · ") || t("本地设备"),
          kind: "storage"
        },
        {
          domain: t("隐私数据"),
          label: t("本地隐私"),
          value: introTotalSize > 0 ? formatBytes(introTotalSize) : t("本地存储"),
          detail: t("用户偏好、播放记录和影片都留在设备内"),
          meta: t("数据不出设备"),
          kind: "storage"
        }
      ]
    } satisfies Record<string, IntroFlowSignal[]>;
  }, [actorAssetCount, actorAssets, introTotal, introTotalSize, mineTransitionSignalMedia, sourceSignals, topicsTransitionSignalMedia, viewingTransitionSignalMedia, wallTransitionSignalMedia]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const sections = Array.from(root.querySelectorAll<HTMLElement>("[data-intro-scroll-section]"));
    const transitions = Array.from(root.querySelectorAll<HTMLElement>("[data-intro-transition]"));
    const revealTargets = Array.from(root.querySelectorAll<HTMLElement>("[data-intro-reveal]"));
    const progressFill = root.querySelector<HTMLElement>(".intro-progress-track i");

    for (const target of revealTargets) target.classList.add("is-revealed");

    if (!isMotionDataReady && !reducedMotion) {
      return () => undefined;
    }

    if (reducedMotion) {
      if (progressFill) progressFill.style.transform = "scaleY(1)";
      const activeObserver = new IntersectionObserver((entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
        if (visible?.target.id) setActiveSection(visible.target.id);
      }, { rootMargin: "-32% 0px -50%", threshold: [0.05, 0.25, 0.5] });
      for (const section of sections) activeObserver.observe(section);
      return () => activeObserver.disconnect();
    }

    root.classList.add("is-gsap-motion");

    const mediaMatch = gsap.matchMedia();
    const context = gsap.context(() => {
      const setPageProgress = progressFill ? gsap.quickSetter(progressFill, "scaleY") : null;
      const updatePageProgress = (progress: number) => {
        setPageProgress?.(progress);
      };

      ScrollTrigger.create({
        id: "product-intro-progress",
        trigger: root,
        start: "top top",
        end: "bottom bottom",
        onRefresh: (self) => updatePageProgress(self.progress),
        onUpdate: (self) => updatePageProgress(self.progress)
      });

      for (const section of sections) {
        ScrollTrigger.create({
          id: `product-intro-active-${section.id}`,
          trigger: section,
          start: "top 48%",
          end: "bottom 48%",
          onToggle: (self) => {
            if (self.isActive && section.id) setActiveSection(section.id);
          }
        });
      }

      const ambientOrbit = root.querySelector<HTMLElement>(".intro-continuum-orbit");
      const ambientRibbon = root.querySelector<HTMLElement>(".intro-continuum-ribbon");
      if (ambientOrbit && ambientRibbon) {
        gsap.timeline({
          scrollTrigger: {
            trigger: root,
            start: "top top",
            end: "bottom bottom",
            scrub: 1.2
          }
        })
          .fromTo(ambientOrbit, {
            opacity: 0.06,
            rotation: -3,
            scale: 0.96,
            xPercent: -4,
            yPercent: -2
          }, {
            ease: "none",
            opacity: 0.18,
            rotation: 5,
            scale: 1.12,
            xPercent: 5,
            yPercent: -9
          }, 0)
          .fromTo(ambientRibbon, {
            opacity: 0.08,
            scale: 0.88,
            xPercent: -18,
            yPercent: 12
          }, {
            ease: "none",
            opacity: 0.26,
            scale: 1.14,
            xPercent: 18,
            yPercent: -14
          }, 0);
      }

      mediaMatch.add({ desktop: "(min-width: 901px)", mobile: "(max-width: 900px)" }, (matchContext) => {
        const desktop = Boolean(matchContext.conditions?.desktop);
        const stageTop = desktop ? 116 : 102;
        const scrub = desktop ? 0.42 : 0.26;
        const enterEase = "power2.out";
        const travelEase = "sine.inOut";
        const exitEase = "power2.in";

        const hero = root.querySelector<HTMLElement>(".intro-hero");
        const heroCopy = hero?.querySelector<HTMLElement>(".intro-hero-copy");
        const heroArt = hero?.querySelector<HTMLElement>(".intro-hero-art");
        const heroPlate = hero?.querySelector<HTMLElement>(".intro-hero-plate");
        const heroTitleLines = hero
          ? Array.from(hero.querySelectorAll<HTMLElement>("h1 .intro-motion-line > span"))
          : [];
        const heroSupport = hero
          ? Array.from(hero.querySelectorAll<HTMLElement>(".intro-hero-copy [data-intro-copy-step]"))
          : [];
        const heroActorVisuals = hero
          ? Array.from(hero.querySelectorAll<HTMLElement>("[data-intro-cover-card], .intro-hero-actor-strip button"))
          : [];
        const heroTelemetry = hero
          ? Array.from(hero.querySelectorAll<HTMLElement>(".intro-hero-telemetry, .intro-hero-art figcaption"))
          : [];

        if (hero && heroCopy && heroArt && heroPlate) {
          const heroTimeline = gsap.timeline({
            scrollTrigger: {
              trigger: hero,
              start: `top top+=${stageTop}`,
              end: desktop ? "bottom bottom" : "bottom top+=102",
              scrub,
              invalidateOnRefresh: true
            }
          });

          heroTimeline
            .to(heroPlate, {
              duration: 1,
              ease: "none",
              rotation: desktop ? 0.65 : 0.3,
              scale: desktop ? 1.14 : 1.07,
              xPercent: desktop ? -3.5 : -1.5,
              yPercent: desktop ? -2.5 : -1
            }, 0)
            .to(heroArt, {
              duration: 0.3,
              ease: exitEase,
              opacity: 0.46,
              scale: desktop ? 1.025 : 1.01,
              xPercent: desktop ? 2 : 0
            }, 0.7)
            .to(heroCopy, {
              duration: 0.66,
              ease: "none",
              xPercent: desktop ? -2.4 : 0,
              y: desktop ? -16 : -10
            }, 0.08);

          heroTitleLines.forEach((line, index) => {
            heroTimeline.to(line, {
              duration: 0.22,
              ease: exitEase,
              rotationZ: index === 0 ? -1.2 : 0.8,
              xPercent: index === 0 ? -2.5 : 2,
              yPercent: -118
            }, 0.56 + index * 0.055);
          });

          if (heroSupport.length > 0) {
            heroTimeline.to(heroSupport, {
              duration: 0.18,
              ease: exitEase,
              opacity: 0.08,
              stagger: { each: 0.035, from: "end" },
              x: desktop ? -20 : 0,
              y: -34
            }, 0.45);
          }

          if (heroActorVisuals.length > 0) {
            heroTimeline.to(heroActorVisuals, {
              duration: 1,
              ease: "none",
              rotationZ: (index) => (index % 2 === 0 ? 2.4 : -2),
              scale: (index) => 0.94 + (index % 3) * 0.045,
              stagger: { each: 0.018, from: "center" },
              x: (index) => (index % 2 === 0 ? 11 : -9),
              y: (index) => -10 - (index % 3) * 7
            }, 0);
          }

          if (heroTelemetry.length > 0) {
            heroTimeline.to(heroTelemetry, {
              duration: 0.18,
              ease: exitEase,
              opacity: 0.12,
              stagger: 0.04,
              y: -22
            }, 0.74);
          }
        }

        transitions.forEach((transition) => {
          const reverse = transition.classList.contains("is-reverse");
          const copy = transition.querySelector<HTMLElement>(".intro-flow-copy");
          const backdropTrack = transition.querySelector<HTMLElement>(".intro-cover-backdrop-track");
          const signalCards = Array.from(transition.querySelectorAll<HTMLElement>("[data-intro-flow-signal]"));
          if (!backdropTrack || !copy) return;
          const label = copy.querySelector<HTMLElement>(".intro-flow-kicker");
          const labelRule = label?.querySelector<HTMLElement>("i");
          const headingLine = copy.querySelector<HTMLElement>(".intro-motion-line > span");
          const detail = copy.querySelector<HTMLElement>("[data-intro-copy-step]");
          const entryDirection = reverse ? -1 : 1;

          const timeline = gsap.timeline({
            scrollTrigger: {
              trigger: transition,
              start: desktop ? "top 94%" : "top 92%",
              end: "bottom bottom",
              scrub,
              invalidateOnRefresh: true
            }
          });

          timeline
            .fromTo(backdropTrack, {
              opacity: 0.32,
              scale: 1.055,
              xPercent: -3.5 * entryDirection,
              yPercent: 4
            }, {
              duration: 0.58,
              ease: "none",
              opacity: 0.76,
              scale: 1,
              xPercent: 0,
              yPercent: 0
            }, 0)
            .to(backdropTrack, {
              duration: 0.42,
              ease: "none",
              opacity: 0.34,
              scale: 0.98,
              xPercent: 3 * entryDirection,
              yPercent: -3
            }, 0.58);

          if (label) {
            timeline.fromTo(label, {
              opacity: 0.28,
              x: -24 * entryDirection
            }, {
              duration: 0.18,
              ease: enterEase,
              opacity: 1,
              x: 0
            }, 0.04);
          }
          if (labelRule) {
            timeline.fromTo(labelRule, {
              scaleX: 0,
              transformOrigin: reverse ? "right center" : "left center"
            }, {
              duration: 0.22,
              ease: enterEase,
              scaleX: 1
            }, 0.09);
          }
          if (headingLine) {
            timeline
              .fromTo(headingLine, {
                rotationZ: -1.5 * entryDirection,
                xPercent: -4 * entryDirection,
                yPercent: 118
              }, {
                duration: 0.24,
                ease: enterEase,
                rotationZ: 0,
                xPercent: 0,
                yPercent: 0
              }, 0.12)
              .to(headingLine, {
                duration: 0.19,
                ease: exitEase,
                rotationZ: 1.1 * entryDirection,
                xPercent: 4 * entryDirection,
                yPercent: -118
              }, 0.76);
          }
          if (detail) {
            timeline
              .fromTo(detail, {
                opacity: 0.18,
                y: 24
              }, {
                duration: 0.19,
                ease: enterEase,
                opacity: 1,
                y: 0
              }, 0.26)
              .to(detail, {
                duration: 0.16,
                ease: exitEase,
                opacity: 0.1,
                y: -22
              }, 0.77);
          }

          timeline.fromTo(signalCards, {
            opacity: 0.22,
            x: (index) => (58 + index * 14) * entryDirection,
            y: (index) => 22 + index * 10
          }, {
            duration: 0.28,
            ease: enterEase,
            opacity: 1,
            stagger: { each: 0.065, from: reverse ? "end" : "start" },
            x: 0,
            y: 0
          }, 0.3);

          timeline.to(signalCards, {
            duration: 0.2,
            ease: exitEase,
            opacity: 0.12,
            stagger: { each: 0.03, from: reverse ? "start" : "end" },
            x: -72 * entryDirection,
            y: (index) => -14 - index * 6
          }, 0.77);
        });

        const storySections = Array.from(root.querySelectorAll<HTMLElement>(".intro-story-section"));
        storySections.forEach((section, index) => {
          const copy = section.querySelector<HTMLElement>(".intro-section-copy");
          const stage = section.querySelector<HTMLElement>(
            ".intro-ingest-stage, .intro-route-stage, .intro-graph-stage, .intro-storage-stage"
          );
          if (!copy || !stage) return;
          const direction = index % 2 === 0 ? 1 : -1;
          const carryover = section.querySelector<HTMLElement>(".intro-story-carryover");
          const sectionNumber = copy.querySelector<HTMLElement>(".intro-section-number");
          const eyebrow = copy.querySelector<HTMLElement>(".intro-eyebrow");
          const titleLines = Array.from(copy.querySelectorAll<HTMLElement>("h2 .intro-motion-line > span"));
          const copySteps = Array.from(copy.querySelectorAll<HTMLElement>("[data-intro-copy-step]"));
          const stageChrome = Array.from(stage.querySelectorAll<HTMLElement>(":scope > header, :scope > footer, :scope > figcaption"));
          const rebuildItems = Array.from(section.querySelectorAll<HTMLElement>(
            ".intro-source-queue article, .intro-ingest-output button, .intro-poster-card, .intro-storage-stage figcaption small"
          ));
          const rebuildVisuals = Array.from(section.querySelectorAll<HTMLElement>(
            ".intro-ingest-output button > img, .intro-poster-image-shell > img, .intro-storage-stage > img"
          ));
          const actorVisuals = Array.from(section.querySelectorAll<HTMLElement>(
            ".intro-actor-node-portrait, .intro-actor-node-label"
          ));
          const stageCore = stage.querySelector<HTMLElement>(
            ".intro-ingest-core, .intro-poster-route, .intro-graph-plate, :scope > img"
          );

          const timeline = gsap.timeline({
            scrollTrigger: {
              trigger: section,
              start: desktop ? "top 94%" : "top 90%",
              end: desktop ? "bottom bottom" : "bottom 18%",
              scrub,
              invalidateOnRefresh: true
            }
          });

          if (carryover) {
            timeline.fromTo(carryover, {
              opacity: 0.28,
              rotationZ: -1.4 * direction,
              scale: 0.94,
              xPercent: -10 * direction,
              yPercent: 0
            }, {
              duration: 0.72,
              ease: "none",
              opacity: 0.035,
              rotationZ: 1.2 * direction,
              scale: 1.12,
              xPercent: 10 * direction,
              yPercent: -22
            }, 0);
          }

          timeline.fromTo(stage, {
            opacity: 0.18,
            rotationY: 4.5 * direction,
            scale: 0.88,
            transformPerspective: 1200,
            x: 92 * direction,
            y: 58
          }, {
            duration: 0.34,
            ease: enterEase,
            opacity: 1,
            rotationY: 0,
            scale: 1,
            x: 0,
            y: 0
          }, 0.015);

          if (sectionNumber) {
            timeline.fromTo(sectionNumber, {
              opacity: 0.12,
              rotationZ: -2.5 * direction,
              scale: 0.76,
              x: -38 * direction,
              y: 38
            }, {
              duration: 0.16,
              ease: enterEase,
              opacity: 1,
              rotationZ: 0,
              scale: 1,
              x: 0,
              y: 0
            }, 0.025);
          }

          if (eyebrow) {
            timeline.fromTo(eyebrow, {
              opacity: 0.28,
              scaleX: 0.9,
              transformOrigin: direction > 0 ? "left center" : "right center",
              x: -26 * direction
            }, {
              duration: 0.15,
              ease: enterEase,
              opacity: 1,
              scaleX: 1,
              x: 0
            }, 0.07);
          }

          titleLines.forEach((line, lineIndex) => {
            timeline
              .fromTo(line, {
                rotationZ: (lineIndex === 0 ? -1.5 : 1.15) * direction,
                xPercent: (lineIndex === 0 ? -4 : 3) * direction,
                yPercent: 118
              }, {
                duration: 0.2,
                ease: enterEase,
                rotationZ: 0,
                xPercent: 0,
                yPercent: 0
              }, 0.095 + lineIndex * 0.055)
              .to(line, {
                duration: 0.18,
                ease: exitEase,
                rotationZ: (lineIndex === 0 ? 1.2 : -0.9) * direction,
                xPercent: (lineIndex === 0 ? 3 : -2) * direction,
                yPercent: -118
              }, 0.745 + lineIndex * 0.04);
          });

          if (copySteps.length > 0) {
            timeline
              .fromTo(copySteps, {
                opacity: 0.16,
                scale: 0.985,
                x: -22 * direction,
                y: 28
              }, {
                duration: 0.18,
                ease: enterEase,
                opacity: 1,
                scale: 1,
                stagger: 0.045,
                x: 0,
                y: 0
              }, 0.225)
              .to(copySteps, {
                duration: 0.16,
                ease: exitEase,
                opacity: 0.08,
                scale: 0.985,
                stagger: { each: 0.035, from: "end" },
                x: 18 * direction,
                y: -28
              }, 0.76);
          }

          if (stageChrome.length > 0) {
            timeline.fromTo(stageChrome, {
              opacity: 0.2,
              x: 28 * direction
            }, {
              duration: 0.19,
              ease: enterEase,
              opacity: 1,
              stagger: 0.055,
              x: 0
            }, 0.12);
          }

          if (rebuildItems.length > 0) {
            timeline.fromTo(rebuildItems, {
              opacity: 0.18,
              scale: 0.96,
              y: 18
            }, {
              duration: 0.2,
              ease: enterEase,
              opacity: 1,
              scale: 1,
              stagger: { each: 0.035, from: direction > 0 ? "start" : "end" },
              y: 0
            }, 0.18);
          }

          if (rebuildVisuals.length > 0) {
            timeline.fromTo(rebuildVisuals, {
              rotationZ: (visualIndex) => (visualIndex % 2 === 0 ? -2 : 2) * direction,
              scale: 1.12
            }, {
              duration: 0.32,
              ease: travelEase,
              rotationZ: 0,
              scale: 1,
              stagger: { each: 0.035, from: "center" }
            }, 0.2);
          }

          if (actorVisuals.length > 0) {
            timeline.fromTo(actorVisuals, {
              opacity: 0.18,
              scale: 0.72,
              y: 18
            }, {
              duration: 0.21,
              ease: enterEase,
              opacity: 1,
              scale: 1,
              stagger: { each: 0.035, from: "center" },
              y: 0
            }, 0.22);
          }

          if (stageCore) {
            timeline.to(stageCore, {
              duration: 0.48,
              ease: "sine.inOut",
              rotationZ: 0.7 * direction,
              scale: desktop ? 1.045 : 1.025,
              x: -10 * direction,
              y: -12
            }, 0.3);
          }

          timeline
            .to(copy, {
              duration: 0.22,
              ease: exitEase,
              x: 24 * direction,
              y: -26
            }, 0.76)
            .to(stage, {
              duration: 0.25,
              ease: exitEase,
              opacity: 0.34,
              rotationY: -3.6 * direction,
              scale: 0.91,
              x: -78 * direction,
              y: -42
            }, 0.765);
        });

        const finale = root.querySelector<HTMLElement>(".intro-finale");
        const finaleDeck = finale?.querySelector<HTMLElement>(".intro-finale-deck");
        const finaleCopy = finale?.querySelector<HTMLElement>(".intro-finale-copy");
        const finaleTitleLines = finale
          ? Array.from(finale.querySelectorAll<HTMLElement>(".intro-finale-copy h2 .intro-motion-line > span"))
          : [];
        const finaleCopySteps = finale
          ? Array.from(finale.querySelectorAll<HTMLElement>(".intro-finale-copy [data-intro-copy-step]"))
          : [];
        const finaleVisuals = finale
          ? Array.from(finale.querySelectorAll<HTMLElement>(".intro-finale-poster > img, .intro-finale-actor-strip button > img"))
          : [];
        if (finale && finaleDeck && finaleCopy) {
          const finaleTimeline = gsap.timeline({
            scrollTrigger: {
              trigger: finale,
              start: "top 94%",
              end: desktop ? "center 44%" : "top 24%",
              scrub
            }
          });
          finaleTimeline
            .fromTo(finaleDeck, {
              opacity: 0.18,
              rotationY: -5,
              scale: 0.86,
              transformPerspective: 1200,
              x: -92,
              y: 66
            }, {
              duration: 0.56,
              ease: enterEase,
              opacity: 1,
              rotationY: 0,
              scale: 1,
              x: 0,
              y: 0
            }, 0);

          finaleTitleLines.forEach((line, lineIndex) => {
            finaleTimeline.fromTo(line, {
              rotationZ: lineIndex === 0 ? -1.4 : 1,
              xPercent: lineIndex === 0 ? -4 : 3,
              yPercent: 118
            }, {
              duration: 0.25,
              ease: enterEase,
              rotationZ: 0,
              xPercent: 0,
              yPercent: 0
            }, 0.16 + lineIndex * 0.075);
          });

          if (finaleCopySteps.length > 0) {
            finaleTimeline.fromTo(finaleCopySteps, {
              opacity: 0.16,
              x: 24,
              y: 28
            }, {
              duration: 0.22,
              ease: enterEase,
              opacity: 1,
              stagger: 0.055,
              x: 0,
              y: 0
            }, 0.34);
          }

          if (finaleVisuals.length > 0) {
            finaleTimeline.fromTo(finaleVisuals, {
              opacity: 0.18,
              scale: 1.15,
              y: 22
            }, {
              duration: 0.3,
              ease: enterEase,
              opacity: 1,
              scale: 1,
              stagger: { each: 0.045, from: "center" },
              y: 0
            }, 0.2);
          }
        }
      });
    }, root);

    const refreshFrame = window.requestAnimationFrame(() => ScrollTrigger.refresh());
    return () => {
      window.cancelAnimationFrame(refreshFrame);
      mediaMatch.revert();
      context.revert();
      root.classList.remove("is-gsap-motion");
    };
  }, [isMotionDataReady, reducedMotion]);

  const scrollToSection = (id: string) => {
    document.getElementById(id)?.scrollIntoView({
      behavior: reducedMotion ? "auto" : "smooth",
      block: "start"
    });
  };

  return (
    <main className={`product-introduction${reducedMotion ? " is-reduced-motion" : ""}`} ref={rootRef}>
      <div className="intro-continuum" aria-hidden="true">
        <img className="intro-continuum-orbit intro-continuum-cinema" src="/demo/stage.svg" />
        <img className="intro-continuum-ribbon" src="/demo/stage.svg" />
      </div>
      <nav className="intro-chapter-nav" aria-label={t("产品介绍章节")}>
        <button className="intro-chapter-brand" onClick={() => scrollToSection("intro-preview")} type="button">
          <span><strong>00 / 06</strong><small>{t("能力导览")}</small></span>
        </button>
        <div className="intro-chapter-links">
          {INTRO_SECTIONS.slice(1).map((section) => (
            <button
              aria-current={activeSection === section.id ? "page" : undefined}
              className={activeSection === section.id ? "is-active" : ""}
              key={section.id}
              onClick={() => scrollToSection(section.id)}
              type="button"
            >
              {section.label}
            </button>
          ))}
        </div>
        <Button className="intro-nav-enter motion-pressable" onClick={onEnterLibrary} type="primary">
          {t("进入馆藏")} <ArrowRight size={15} />
        </Button>
      </nav>

      <aside className="intro-progress" aria-label={t("浏览进度")}>
        <span className="intro-progress-track"><i /></span>
        {INTRO_SECTIONS.map((section, index) => (
          <button
            aria-label={t("前往{{p0}}", { p0: section.label })}
            className={activeSection === section.id ? "is-active" : ""}
            key={section.id}
            onClick={() => scrollToSection(section.id)}
            type="button"
          >
            <span>{String(index).padStart(2, "0")}</span>
          </button>
        ))}
      </aside>

      <ProductShowcase />

      <section className="intro-hero" data-intro-scroll-section id="intro-hero">
        <div className="intro-hero-pin">
          <figure className="intro-hero-art" data-intro-reveal>
            <img
              alt={t("酒红丝绒、投影光束与示例馆藏封面组成的私人放映厅")}
              className="intro-hero-plate"
              src="/demo/stage.svg"
            />
            <IntroCoverBackdrop items={heroBackgroundMedia} variant="hero" />
            <div className="intro-hero-cover-stage" aria-label={t("原创几何封面的界面示例")}>
              <div className="intro-hero-stage-heading">
                <span><Film size={14} /> {t("本地示例精选")}</span>
                <small>{heroMedia.length > 0 ? t("{{p0}} 部快照封面已就绪", { p0: heroMedia.length }) : t("首页快照待生成")}</small>
              </div>
              <div className="intro-hero-cover-deck">
                {heroMedia.map((item, index) => (
                  <IntroHeroCover
                    fromFavoriteTopic={favoriteTopicMediaIds.has(item.id)}
                    index={index}
                    item={item}
                    key={item.id}
                    onOpen={() => onEnterLibrary()}
                    queue={heroMedia}
                  />
                ))}
              </div>
              <div className="intro-hero-actor-strip" aria-label={t("已关联的本地演员资料")}>
                {actorAssets.slice(0, 5).map((asset) => (
                  <button
                    key={asset.value}
                    onClick={() => onOpenEntity({ type: "actor", value: asset.value, label: asset.label })}
                    title={t("打开演员档案：{{p0}}", { p0: asset.label })}
                    type="button"
                  >
                    <img alt={asset.label} src={asset.imageUrl} />
                    <span><strong>{asset.label}</strong><small>{asset.count.toLocaleString(getIntlLocale())} {t("部")}</small></span>
                  </button>
                ))}
              </div>
            </div>
            <div className="intro-hero-telemetry">
              <span title={t("预生成于 {{p0}}", { p0: productIntroductionSnapshot.generatedAt })}><Activity size={13} /> PREBUILT LOCAL SNAPSHOT</span>
              <strong>{featuredFavoriteTopicCount > 0 ? featuredFavoriteTopicCount : heroMedia.length}</strong>
              <small>{t("多主题、多演员预生成组合")}</small>
            </div>
            <figcaption>{t("此页使用原创几何封面和虚构元数据展示界面。")}</figcaption>
          </figure>

          <div className="intro-hero-copy" data-intro-reveal>
            <span className="intro-eyebrow" data-intro-copy-step><RadioTower size={13} /> {t("五大模块 · 一套本地媒体平台")}</span>
            <h1 aria-label={t("管理、发现、观看和理解你的全部馆藏。")}>
              <span className="intro-motion-line"><span>{t("管理、发现、观看，")}</span></span>
              <span className="intro-motion-line"><span>{t("理解你的全部馆藏。")}</span></span>
            </h1>
            <p data-intro-copy-step>
              {t("Alexandria 18+ 把媒体墙、专题、观影台、智能馆长和个人中心连接起来。 从万部本地影片中快速浏览、策展、选片、提问，并持续积累个人偏好。")} </p>
            <div className="intro-hero-actions" data-intro-copy-step>
              <Button className="intro-primary-action motion-pressable" onClick={onEnterLibrary} size="large" type="primary">
                {t("进入馆藏")} <ArrowRight size={17} />
              </Button>
              <button className="intro-text-action" onClick={() => scrollToSection("intro-wall")} type="button">
                {t("查看五大模块")} <ArrowDown size={16} />
              </button>
            </div>
            <div className="intro-hero-capabilities" data-intro-copy-step>
              <span><LibraryBig size={15} /> {t("媒体墙")}</span>
              <span><PanelsTopLeft size={15} /> {t("专题")}</span>
              <span><Sparkles size={15} /> {t("观影台")}</span>
              <span><BrainCircuit size={15} /> {t("智能馆长")}</span>
              <span><UserRound size={15} /> {t("我的")}</span>
            </div>
            <div className="intro-hero-facts" aria-label={t("产品能力概览")} data-intro-copy-step>
              <span><strong>{introTotal > 0 ? introTotal.toLocaleString(getIntlLocale()) : t("万级")}</strong><small>{t("馆藏影片")}</small></span>
              <span><strong>{introTotalSize > 0 ? formatBytes(introTotalSize) : t("多存储")}</strong><small>{t("统一管理")}</small></span>
              <span><strong>{actorAssetCount > 0 ? actorAssetCount.toLocaleString(getIntlLocale()) : t("本地")}</strong><small>{t("演员档案")}</small></span>
              <span><strong>{t("本地")}</strong><small>{t("数据不出设备")}</small></span>
            </div>
          </div>
        </div>
      </section>

      <IntroFlowTransition
        backgroundMedia={wallTransitionBackgroundMedia}
        detail={t("把多个存储来源汇入同一套浏览、搜索与筛选体验")}
        from={t("平台")}
        signals={transitionSignals.wall}
        title={t("一面媒体墙，浏览全部馆藏。")}
        to={t("媒体墙")}
      />

      <section className="intro-story-section intro-organize intro-wall" data-intro-scroll-section id="intro-wall">
        <div className="intro-sticky-frame">
          <div className="intro-section-copy" data-intro-reveal>
            <span className="intro-section-number">01</span>
            <span className="intro-eyebrow">MEDIA WALL</span>
            <h2 aria-label={t("全部影片，在一面墙里快速找到。")}>
              <span className="intro-motion-line"><span>{t("全部影片，")}</span></span>
              <span className="intro-motion-line"><span>{t("在一面墙里快速找到。")}</span></span>
            </h2>
            <p data-intro-copy-step>{t("媒体墙统一呈现 NAS 与移动硬盘里的影片。支持关键词搜索、演员与标签组合筛选、随机发现、瀑布加载和多版本合并。")}</p>
            <ul className="intro-feature-list" data-intro-copy-step>
              <li><Film size={17} /><span>{t("海报网格、长列表与移动端沉浸浏览")}</span></li>
              <li><Tag size={17} /><span>{t("番号、演员、系列、厂商和题材组合筛选")}</span></li>
              <li><Database size={17} /><span>{t("播放进度、收藏状态和影片版本集中管理")}</span></li>
            </ul>
            <Button className="intro-outline-action motion-pressable" data-intro-copy-step onClick={onEnterLibrary}>
              {t("打开媒体墙")} <ArrowRight size={15} />
            </Button>
          </div>

          <IntroModuleDemo
            alt={t("媒体墙示例界面：本地分类筛选、搜索与横向影片卡片滚动")}
            caption={t("搜索、筛选、发现和播放都在同一面墙完成")}
            label={t("媒体墙")}
            onOpen={onEnterLibrary}
            poster="/demo/stage.svg"
            reducedMotion={reducedMotion}
            video=""
          />
        </div>
      </section>

      <IntroFlowTransition
        backgroundMedia={topicsTransitionBackgroundMedia}
        detail={t("把分散作品按演员、系列、导演、厂商与题材自动聚合")}
        from={t("媒体墙")}
        reverse
        signals={transitionSignals.topics}
        title={t("把相关作品，组织成可持续维护的专题。")}
        to={t("专题")}
      />

      <section className="intro-story-section intro-discovery intro-topics" data-intro-scroll-section id="intro-topics">
        <div className="intro-sticky-frame intro-discovery-frame">
          <IntroModuleDemo
            alt={t("专题示例界面：演员、主题、标签、番号、导演与厂商专题浏览")}
            caption={t("演员、系列和题材被组织成持续更新的专题墙")}
            label={t("专题")}
            onOpen={onOpenTopics}
            poster="/demo/stage.svg"
            reducedMotion={reducedMotion}
            video=""
          />
          <div className="intro-section-copy" data-intro-reveal>
            <span className="intro-section-number">02</span>
            <span className="intro-eyebrow">CURATED TOPICS</span>
            <h2 aria-label={t("把喜欢的演员、系列和题材，变成持续更新的专题。")}>
              <span className="intro-motion-line"><span>{t("把喜欢的演员、系列和题材，")}</span></span>
              <span className="intro-motion-line"><span>{t("变成持续更新的专题。")}</span></span>
            </h2>
            <p data-intro-copy-step>{t("专题自动汇总演员、系列、导演、厂商和题材。你可以收藏常看的主题、指定专题封面，并沿关系图继续发现相关作品。")}</p>
            <Button className="intro-outline-action motion-pressable" data-intro-copy-step onClick={onOpenTopics}>
              {t("浏览专题")} <ArrowRight size={15} />
            </Button>
          </div>
        </div>
      </section>

      <IntroFlowTransition
        backgroundMedia={viewingTransitionBackgroundMedia}
        detail={t("读取本地收藏、播放进度和偏好，生成有理由的候选片单")}
        from={t("专题")}
        signals={transitionSignals.viewing}
        title={t("不用翻完整个库，直接决定今晚看什么。")}
        to={t("观影台")}
      />

      <section className="intro-story-section intro-discovery intro-viewing" data-intro-scroll-section id="intro-viewing">
        <div className="intro-sticky-frame intro-discovery-frame">
          <div className="intro-section-copy" data-intro-reveal>
            <span className="intro-section-number">03</span>
            <span className="intro-eyebrow">VIEWING DESK</span>
            <h2 aria-label={t("三种推荐方向，把选择变成一次轻松决策。")}>
              <span className="intro-motion-line"><span>{t("三种推荐方向，")}</span></span>
              <span className="intro-motion-line"><span>{t("把选择变成轻松决策。")}</span></span>
            </h2>
            <p data-intro-copy-step>{t("观影台提供“贴近口味、相邻探索、大胆尝试”三组结果，结合观看时长、播放进度与收藏偏好，并解释每一部为什么被推荐。")}</p>
            <ul className="intro-feature-list" data-intro-copy-step>
              <li><Sparkles size={17} /><span>{t("三种探索强度，随时切换推荐方向")}</span></li>
              <li><Clock3 size={17} /><span>{t("结合可用时长和未看内容快速选片")}</span></li>
              <li><Play size={17} /><span>{t("直接播放、加入片单或继续上次进度")}</span></li>
            </ul>
            <Button className="intro-outline-action motion-pressable" data-intro-copy-step onClick={onOpenViewingDesk}>
              {t("打开观影台")} <ArrowRight size={15} />
            </Button>
          </div>
          <IntroModuleDemo
            alt={t("观影台示例界面：基于收藏和观看记录生成今晚的候选片单")}
            caption={t("从推荐入口直接进入一组有理由的候选片单")}
            label={t("观影台")}
            onOpen={onOpenViewingDesk}
            poster="/demo/stage.svg"
            reducedMotion={reducedMotion}
            video=""
          />
        </div>
      </section>

      <IntroFlowTransition
        backgroundMedia={curatorTransitionBackgroundMedia}
        detail={t("把影片、演员、系列和个人偏好变成可对话、可执行的馆藏知识")}
        from={t("观影台")}
        reverse
        signals={transitionSignals.curator}
        title={t("不只推荐，馆长还能理解并操作你的馆藏。")}
        to={t("馆长")}
      />

      <section className="intro-story-section intro-relationships intro-curator" data-intro-scroll-section id="intro-curator">
        <div className="intro-sticky-frame">
          <div className="intro-section-copy" data-intro-reveal>
            <span className="intro-section-number">04</span>
            <span className="intro-eyebrow">INTELLIGENT CURATOR</span>
            <h2 aria-label={t("直接向馆长提问，让平台替你检索、解释和执行。")}>
              <span className="intro-motion-line"><span>{t("直接向馆长提问，")}</span></span>
              <span className="intro-motion-line"><span>{t("让平台替你检索和执行。")}</span></span>
            </h2>
            <p data-intro-copy-step>{t("智能馆长理解本地影片、演员、系列、题材和观看历史。你可以用自然语言提出复杂需求，获取解释充分的结果并继续执行下一步。")}</p>
            <div className="intro-dimension-row" aria-label={t("馆长能力")} data-intro-copy-step>
              <span><UsersRound size={15} /> {t("对话检索")}</span>
              <span><Film size={15} /> {t("影片解释")}</span>
              <span><Network size={15} /> {t("关系推理")}</span>
              <span><Tag size={15} /> {t("任务执行")}</span>
            </div>
            <Button className="intro-outline-action motion-pressable" data-intro-copy-step onClick={onOpenCurator}>
              {t("咨询智能馆长")} <ArrowRight size={15} />
            </Button>
          </div>

          <IntroModuleDemo
            alt={t("智能馆长示例界面：对话检索本地馆藏并解释影片推荐理由")}
            caption={t("自然语言问题被转成可解释、可继续执行的馆藏结果")}
            label={t("智能馆长")}
            onOpen={onOpenCurator}
            poster="/demo/stage.svg"
            reducedMotion={reducedMotion}
            video=""
          />
        </div>
      </section>

      <IntroFlowTransition
        backgroundMedia={mineTransitionBackgroundMedia}
        detail={t("把收藏、片单、继续观看、馆藏统计与隐私设置汇总成个人入口")}
        from={t("馆长")}
        reverse
        signals={transitionSignals.mine}
        title={t("你的收藏、进度和偏好，沉淀为个人媒体主页。")}
        to={t("我的")}
      />

      <section className="intro-story-section intro-private intro-mine" data-intro-scroll-section id="intro-mine">
        <div className="intro-sticky-frame intro-private-frame">
          <IntroModuleDemo
            alt={t("我的示例界面：媒体手记、观看进度、收藏、片单和馆藏分析")}
            caption={t("个人媒体手记与全年馆藏分析集中在同一个入口")}
            label={t("我的")}
            onOpen={onOpenMine}
            poster="/demo/stage.svg"
            reducedMotion={reducedMotion}
            video=""
          />
          <div className="intro-section-copy" data-intro-reveal>
            <span className="intro-section-number">05</span>
            <span className="intro-eyebrow">MY ALEXANDRIA 18+</span>
            <h2 aria-label={t("收藏、片单、进度和洞察，都汇总到我的。")}>
              <span className="intro-motion-line"><span>{t("收藏、片单、进度和洞察，")}</span></span>
              <span className="intro-motion-line"><span>{t("都汇总到“我的”。")}</span></span>
            </h2>
            <p data-intro-copy-step>{t("个人主页集中呈现收藏专题、稍后观看、播放历史、继续观看和馆藏统计。每位本地用户拥有独立偏好，影片与记录仍保存在自己的设备中。")}</p>
            <ul className="intro-feature-list" data-intro-copy-step>
              <li><UserRound size={17} /><span>{t("多用户偏好、历史和收藏相互独立")}</span></li>
              <li><Activity size={17} /><span>{t("容量、来源、题材和观看趋势一目了然")}</span></li>
              <li><ShieldCheck size={17} /><span>{t("影片、索引和个人记录全部留在本地")}</span></li>
            </ul>
            <Button className="intro-outline-action motion-pressable" data-intro-copy-step onClick={onOpenMine}>
              {t("打开“我的”")} <ArrowRight size={15} />
            </Button>
          </div>
        </div>
      </section>

      <section className="intro-finale" data-intro-reveal>
        <IntroCoverBackdrop items={finaleBackgroundMedia} variant="finale" />
        <div className="intro-finale-deck" aria-label={t("示例馆藏预览")}>
          <img alt="" aria-hidden="true" className="intro-finale-mark" src="/brand-icon.png" />
          {finaleMedia.map((item, index) => (
            <button
              className="intro-finale-poster"
              key={item.id}
              onClick={onEnterLibrary}
              style={{ "--intro-item-index": index } as CSSProperties}
              title={getMediaTitle(item)}
              type="button"
            >
              <img
                alt=""
                data-cover-source={favoriteTopicMediaIds.has(item.id) ? "favorite-topic" : "library"}
                data-media-id={item.id}
                loading="lazy"
                onError={handleMediaImageError}
                src={getIntroPosterUrl(item)}
              />
            </button>
          ))}
          <span className="intro-finale-play"><Play fill="currentColor" size={18} /></span>
          <div className="intro-finale-actor-strip">
            {actorAssets.slice(0, 4).map((asset) => (
              <button
                key={asset.value}
                onClick={() => onOpenEntity({ type: "actor", value: asset.value, label: asset.label })}
                title={t("打开演员档案：{{p0}}", { p0: asset.label })}
                type="button"
              >
                <img alt={asset.label} src={asset.imageUrl} />
              </button>
            ))}
            <span>PREBUILT LOCAL SNAPSHOT</span>
          </div>
        </div>
        <div className="intro-finale-copy">
          <span className="intro-eyebrow" data-intro-copy-step>ALEXANDRIA 18+ · PRIVATE</span>
          <h2 aria-label={t("五大模块协同，让私人馆藏成为完整媒体平台。")}>
            <span className="intro-motion-line"><span>{t("五大模块协同，")}</span></span>
            <span className="intro-motion-line"><span>{t("让私人馆藏成为完整媒体平台。")}</span></span>
          </h2>
          <p data-intro-copy-step>{t("媒体墙负责浏览，专题负责组织，观影台负责决策，馆长负责理解与执行，“我的”负责沉淀长期偏好。")}</p>
          <Button className="intro-primary-action motion-pressable" data-intro-copy-step onClick={onEnterLibrary} size="large" type="primary">
            {t("进入馆藏")} <ArrowRight size={17} />
          </Button>
        </div>
      </section>
    </main>
  );
}
