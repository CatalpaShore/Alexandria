import { t, useLocale } from "../i18n";
import {lazy, Suspense, useState} from "react";
import {createPortal} from "react-dom";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {Alert, Button, Drawer, Empty, message, Popconfirm, Progress, Spin, Tag} from "antd";
import {Download, Play, RefreshCw, Scissors, Trash2} from "lucide-react";
import {requestJson} from "../lib/http";
import type {MediaItem} from "../lib/api";
import "./highlights.css";
export {HighlightEditor} from "./HighlightEditor";
const Player = lazy(() => import("./PlayerModal").then(module => ({default: module.PlayerModal})));
type Clip = {
  id: string; mediaId: string; title: string; sourceTitle: string; start: number; end: number;
  status: string; error: string | null; createdAt: string; posterUrl?: string;
  progress?: number; attempts?: number; retryAfter?: string | null;
};
const busy = ["pending", "processing", "waiting", "retrying"];
const labels: Record<string, string> = {ready: "已生成", failed: "需修复", pending: "排队中", processing: "生成中", waiting: "等待连接/空间", retrying: "自动重试中"};
const time = (seconds: number) => `${Math.floor(seconds / 3600) ? `${Math.floor(seconds / 3600)}:` : ""}${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const post = {method: "POST", headers: {"Content-Type": "application/json"}, body: "{}"};
function playbackItem(clip: Clip): MediaItem {
  return {
    id: `highlight-${clip.id}`, libraryCategory: t("高光"), sourceName: clip.sourceTitle,
    relativePath: `${clip.sourceTitle} · ${time(clip.start)} — ${time(clip.end)}`, name: clip.title,
    basename: clip.title, extension: ".mp4", mimeType: "video/mp4", size: 0,
    mtimeMs: Date.parse(clip.createdAt), directory: t("高光"), firstLetter: "", collectionBucket: "",
    codePrefix: "", codeNumber: "", normalizedCode: "", variantTags: "", qualityTag: "",
    mediaType: "video", durationSeconds: clip.end - clip.start, thumbnailStatus: "ready",
    indexedAt: clip.createdAt, isFavorite: false, playback: null, metadata: null,
    compatibilityStatus: "native", probeStatus: "ready"
  };
}
export function HighlightsDrawer({open, onClose}: {open: boolean; onClose: () => void}) {
  useLocale();
  const cache = useQueryClient();
  const [playing, setPlaying] = useState<Clip | null>(null);
  const clips = useQuery({
    queryKey: ["highlights"], queryFn: () => requestJson<{items: Clip[]; storageAvailable: boolean}>("/api/highlights"), enabled: open,
    refetchInterval: query => open && query.state.data?.items.some(clip => busy.includes(clip.status)) ? 2500 : false
  });
  const refresh = () => { void cache.invalidateQueries({queryKey: ["highlights"]}); };
  const remove = useMutation({mutationFn: (id: string) => requestJson(`/api/highlights/${id}`, {method: "DELETE"}), onSuccess: refresh, onError: error => message.error(error.message)});
  const retry = useMutation({mutationFn: (id: string) => requestJson(`/api/highlights/${id}/retry`, post), onSuccess: refresh, onError: error => message.error(error.message)});
  const repair = useMutation({mutationFn: () => requestJson<{repaired: number}>("/api/highlights/repair", post), onSuccess: data => {refresh(); message.success(t("已检查高光，{{p0}} 个片段加入修复队列", { p0: data.repaired }));}, onError: error => message.error(error.message)});
  const playable = clips.data?.items.filter(clip => clip.status === "ready") ?? [];
  const currentIndex = playable.findIndex(clip => clip.id === playing?.id);
  return <>
    <Drawer title={t("我的高光")} open={open} onClose={() => {setPlaying(null); onClose();}} width={1000} destroyOnHidden extra={<Button icon={<RefreshCw size={15}/>} loading={repair.isPending} onClick={() => repair.mutate()}>{t("检查并修复")}</Button>}>
      <div className="highlights-library">
        <p>{t("独立保存的精彩片段 · 默认循环播放")}</p>
        {clips.isPending && <Spin/>}
        {clips.error && <Alert type="error" title={clips.error.message} action={<Button onClick={() => void clips.refetch()}>{t("重试")}</Button>}/>}
        {clips.data && !clips.data.storageAvailable && <Alert type="warning" title={t("高光硬盘未连接，生成任务会在连接后自动恢复")} action={<Button onClick={() => void clips.refetch()}>{t("重新检测")}</Button>}/>}
        {clips.data?.items.length === 0 && <Empty description={t("还没有高光，在播放页点击剪刀图标记录第一段")}/>}
        <div className="highlight-grid">
          {clips.data?.items.map(clip => <article className="highlight-media-card" key={clip.id}>
            <button className="highlight-card-cover" type="button" aria-label={t("播放高光：{{p0}}", { p0: clip.title })} disabled={clip.status !== "ready" || !clips.data.storageAvailable} onClick={() => setPlaying(clip)}>
              <Scissors className="highlight-cover-placeholder" size={30}/>
              {clip.posterUrl && <img src={clip.posterUrl} alt="" loading="lazy" onError={event => {event.currentTarget.style.display = "none";}}/>}
              {clip.status === "ready" && <span className="highlight-cover-play"><Play size={24} fill="currentColor"/></span>}
              <span className="highlight-cover-duration">{time(clip.end - clip.start)}</span>
              <Tag color={clip.status === "ready" ? "green" : clip.status === "failed" ? "red" : "gold"}>{labels[clip.status] ?? clip.status}</Tag>
            </button>
            <div className="highlight-card-info">
              <h3 title={clip.title}>{clip.title}</h3>
              <p>{clip.sourceTitle} · {time(clip.start)} — {time(clip.end)}</p>
              <small>{new Date(clip.createdAt).toLocaleString()}</small>
              {clip.status === "processing" && <Progress size="small" percent={Math.floor(clip.progress ?? 0)}/>}
              {clip.error && <p className="highlight-card-error" role="status">{clip.error}</p>}
              {Boolean(clip.attempts) && busy.includes(clip.status) && <small>{t("已尝试")} {clip.attempts}{t("/3 次")}</small>}
              <footer>
                {clip.status === "ready" && <><Button icon={<Play size={15}/>} disabled={!clips.data.storageAvailable} onClick={() => setPlaying(clip)}>{t("播放")}</Button><Button aria-label={t("下载 {{p0}}", { p0: clip.title })} icon={<Download size={15}/>} disabled={!clips.data.storageAvailable} href={`/api/highlights/${clip.id}/file?download=1`}>{t("下载")}</Button></>}
                {["failed", "waiting", "retrying", "pending"].includes(clip.status) && <Button icon={<RefreshCw size={15}/>} loading={retry.isPending && retry.variables === clip.id} onClick={() => retry.mutate(clip.id)}>{t("修复重试")}</Button>}
                {!busy.includes(clip.status) && <Popconfirm title={t("删除这个高光片段？")} description={t("仅删除片段，原影片保持不变。")} onConfirm={() => remove.mutate(clip.id)}><Button aria-label={t("删除 {{p0}}", { p0: clip.title })} danger disabled={!clips.data.storageAvailable || remove.isPending} icon={<Trash2 size={15}/>}/></Popconfirm>}
              </footer>
            </div>
          </article>)}
        </div>
      </div>
    </Drawer>
    {open && playing && createPortal(<Suspense fallback={<div className="modal-backdrop"><Spin/></div>}><Player
      item={playbackItem(playing)} metadataLanguage="zh" onClose={() => setPlaying(null)}
      standaloneSource={{url: `/api/highlights/${playing.id}/file`, posterUrl: playing.posterUrl, loop: true}}
      onPrevious={currentIndex > 0 ? () => setPlaying(playable[currentIndex - 1]) : undefined}
      onNext={currentIndex >= 0 && currentIndex < playable.length - 1 ? () => setPlaying(playable[currentIndex + 1]) : undefined}
    /></Suspense>, document.body)}
  </>;
}
