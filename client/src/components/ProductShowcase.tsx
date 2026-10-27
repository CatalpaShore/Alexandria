import { useEffect, useRef, useState } from "react";
import { ExternalLink, Film } from "lucide-react";
import { t, useLocale } from "../i18n";
import { useDemoStatus } from "./DemoNotice";
import { productTours } from "../lib/productTour";
import "../product-showcase.css";

const screens = [
  { id: "topics", title: "专题浏览", description: "按人物、主题和标签组织馆藏，从关联内容继续探索。" },
  { id: "media-detail", title: "作品详情", description: "把本地资料、文件信息与播放入口放在一起。" },
  { id: "viewing-desk", title: "观影台", description: "从当前馆藏、收藏和观看记录出发，挑选下一部。" },
  { id: "knowledge-graph", title: "知识图谱", description: "沿人物、标签与作品之间的关系逐层查看。" },
  { id: "personal-library", title: "个人媒体手记", description: "集中查看收藏、片单与观看轨迹。" },
  { id: "mobile-wall", title: "移动端媒体墙", description: "窄屏下继续搜索、筛选与浏览馆藏。" }
] as const;

export function ProductShowcase() {
  const locale = useLocale();
  const tour = productTours[locale];
  const demo = useDemoStatus();
  const [selected, setSelected] = useState(0);
  const screen = screens[selected];
  // The recorded tour contains blurred adult-library backgrounds. The public
  // non-adult demo shows only screenshots of its non-adult film mock collection.
  const showTour = demo.data?.demo === false;
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastVideoRef = useRef<HTMLVideoElement | null>(null);
  const lastSourceRef = useRef(tour.video);
  const pendingPlayback = useRef<{ time: number; playing: boolean; muted: boolean; volume: number; rate: number } | null>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (lastVideoRef.current !== video) {
      lastVideoRef.current = video;
      lastSourceRef.current = tour.video;
      return; // Preserve preload="none" on the initial mount.
    }
    if (lastSourceRef.current === tour.video) return;
    pendingPlayback.current = video.readyState > 0 ? {
      time: video.currentTime, playing: !video.paused && !video.ended,
      muted: video.muted, volume: video.volume, rate: video.playbackRate
    } : pendingPlayback.current;
    lastSourceRef.current = tour.video;
    video.pause();
    video.load(); // Updating a child <source> alone does not reload the media.
  }, [showTour, tour.video]);

  const restorePlayback = () => {
    const video = videoRef.current, saved = pendingPlayback.current;
    if (!video || !saved) return;
    pendingPlayback.current = null;
    video.currentTime = Math.min(saved.time, Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.05) : saved.time);
    video.muted = saved.muted;
    video.volume = saved.volume;
    video.playbackRate = saved.rate;
    if (saved.playing) void video.play().catch(() => undefined);
  };
  return <section className="intro-showcase" data-intro-scroll-section id="intro-preview" aria-labelledby="intro-preview-title">
    <header className="intro-showcase-heading">
      <span>Alexandria 18+ / {t("效果预览")}</span>
      <h2 id="intro-preview-title">{t("先看看平台的实际效果")}</h2>
      <p>{t("从浏览、选片到整理，了解你的个人影库可以怎样使用。")}</p>
    </header>
    <div className={`intro-showcase-layout${showTour ? "" : " is-demo"}`}>
      {showTour && <article className="intro-tour-card">
        <div className="intro-showcase-card-heading"><Film size={18} /><strong>{t("脱敏操作演示")}</strong><span>02:18</span></div>
        <video aria-label={t("Alexandria 18+ 脱敏产品演示视频")} controls playsInline preload="none" poster={tour.poster} ref={videoRef} onLoadedMetadata={restorePlayback} data-tour-language={locale}>
          <source src={tour.video} type="video/mp4" />
          <track kind="captions" src={tour.captions} srcLang={tour.captionLanguage} label={tour.captionLabel} />
          <a href={tour.video}>{t("下载演示视频")}</a>
        </video>
        <div className="intro-showcase-card-copy"><p>{t("配音、字幕与章节说明随界面语言切换，实录界面保留中文。封面、播放画面、私人标题与路径经过模糊处理；人物及作品索引文字可能保留。")}</p>
          <p>{t("录像中的馆长与自动处理功能依赖自行配置的服务，移动端为响应式布局演示。")}</p>
          <a href={tour.video} download>{t("下载演示视频")} <ExternalLink size={13} /></a>
        </div>
      </article>}
      <article className="intro-screens-card">
        <div className="intro-showcase-card-heading"><strong>{t("Demo 界面截图")}</strong><span>{selected + 1} / {screens.length}</span></div>
        <div role="tabpanel" id="showcase-screen" aria-labelledby={`showcase-tab-${screen.id}`}>
          <a className="intro-showcase-image" href={`/showcase/${screen.id}.png`} target="_blank" rel="noreferrer" aria-label={t("查看{{name}}原图", { name: t(screen.title) })}>
            <img src={`/showcase/${screen.id}.png`} alt={t(screen.title)} width={screen.id === "mobile-wall" ? 1082 : 1440} height={screen.id === "mobile-wall" ? 2202 : 1000} loading="lazy" />
          </a>
          <div className="intro-showcase-card-copy"><strong>{t(screen.title)}</strong><p>{t(screen.description)}</p><small>{t("全部截图来自独立 Demo，使用真实开放电影资料与模拟观看记录。点击图片可查看原图。")}</small></div>
        </div>
        <div className="intro-showcase-tabs" role="tablist" aria-label={t("选择效果截图")}>
          {screens.map((item, index) => <button id={`showcase-tab-${item.id}`} key={item.id} role="tab" aria-selected={selected === index} aria-controls="showcase-screen" tabIndex={selected === index ? 0 : -1} type="button" onClick={() => setSelected(index)} onKeyDown={event => {
            const next = event.key === "ArrowRight" ? (index + 1) % screens.length : event.key === "ArrowLeft" ? (index + screens.length - 1) % screens.length : event.key === "Home" ? 0 : event.key === "End" ? screens.length - 1 : null;
            if (next === null) return;
            event.preventDefault(); setSelected(next);
            document.getElementById(`showcase-tab-${screens[next].id}`)?.focus();
          }}>
            <img src={`/showcase/${item.id}.png`} alt="" loading="lazy" width="144" height="100" /><span>{t(item.title)}</span>
          </button>)}
        </div>
      </article>
    </div>
  </section>;
}
