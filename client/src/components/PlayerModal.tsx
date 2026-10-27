import { t, useLocale } from "../i18n";
import { HighlightEditor } from "./HighlightEditor";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type MouseEvent, type PointerEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Repeat, ChevronLeft, ChevronRight, Scissors, Captions, CaptionsOff, ChevronDown, ChevronUp, HardDrive, Heart, Maximize2, Minimize2, Pause, Play, RotateCcw, RotateCw, Settings2, Volume2, VolumeX, X } from "lucide-react";
import {
  formatBytes,
  formatDate,
  formatDuration,
  fetchMediaDetail,
  fetchPlaybackSource,
  getStreamUrl,
  parseVariantTags,
  requestCompatibilityAction,
  type MediaSidecar,
  type MediaItem
} from "../lib/api";
import { getDisplayMetadata, type MetadataLanguage } from "../lib/metadataDisplay";
import {
  fetchStoryboard,
  prepareReadiness,
  type StoryboardCue
} from "../lib/playbackApi";
import { findActiveSubtitleText, hasNativeChineseSubtitle, parseWebVtt, type PlayerSubtitleCue } from "../lib/subtitles";

type PlayerModalProps = {
  item: MediaItem | null;
  standaloneSource?: { url: string; posterUrl?: string; loop?: boolean };
  onPrevious?: () => void;
  onNext?: () => void;
  initialPositionSeconds?: number | null;
  metadataLanguage: MetadataLanguage;
  onClose: () => void;
  onSelectVersion?: (item: MediaItem) => void;
  onProgress?: (
    item: MediaItem,
    payload: {
      positionSeconds: number;
      durationSeconds?: number | null;
      completed?: boolean;
      started?: boolean;
    }
  ) => void;
  onToggleFavorite?: (item: MediaItem, favorite: boolean) => void;
};

type FullscreenVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
};

type FrameAwareVideo = HTMLVideoElement & {
  cancelVideoFrameCallback?: (handle: number) => void;
  requestVideoFrameCallback?: (callback: () => void) => number;
};

type PlaybackMode = "source" | "remux" | "hls";
type PlaybackPreparation = "probe" | "remux" | "hls";
type PlaybackSwitchReason = "auto" | "manual";

const PLAYBACK_MODE_LABELS: Record<PlaybackMode, string> = {
  get source() { return t("原文件直放"); },
  get remux() { return t("无损转封装"); },
  get hls() { return t("转码播放"); }
};

function playbackFailureMessage(reason: "source_unavailable" | "ffmpeg_unavailable" | "preparation_failed" | null): string {
  if (reason === "source_unavailable") return t("视频源暂未连接，当前仅可浏览固态硬盘中的馆藏数据");
  if (reason === "ffmpeg_unavailable") return t("兼容播放服务不可用，请检查 FFmpeg 配置");
  return t("兼容播放准备失败，请稍后重试或检查文件");
}

function playbackRequestErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/source.*unavailable|storage volume|视频源暂未连接/i.test(message)) return t("视频源暂未连接，当前仅可浏览固态硬盘中的馆藏数据");
  if (/ffmpeg.*unavailable/i.test(message)) return t("兼容播放服务不可用，请检查 FFmpeg 配置");
  return message || t("无法准备备用播放源");
}

const GESTURE_HINT_MAX_DURATION_MS = 200;
const DOUBLE_TAP_MAX_INTERVAL_MS = 360;
const DOUBLE_TAP_MAX_DISTANCE_PX = 48;
const PLAYER_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

type TapState = {
  at: number;
  side: "left" | "right";
  x: number;
  y: number;
};

type GestureState = {
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  baseVolume: number;
  baseBrightness: number;
  baseTime: number;
  previousRate: number;
  wasPlaying: boolean;
  region: "brightness" | "volume";
  mode: null | "brightness" | "volume" | "seek";
  holdTimer: number | null;
  holdActive: boolean;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function compactList(values: string[], max = 6): string {
  if (values.length <= max) return values.join(" / ");
  return `${values.slice(0, max).join(" / ")} +${values.length - max}`;
}

function formatPlaybackTime(value: number | null): string {
  if (!value || !Number.isFinite(value) || value <= 0) return "0:00";
  return formatDuration(value);
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || Boolean(target.closest(
    "a, button, input, textarea, select, [contenteditable='true'], [role='button'], [role='slider'], [role='textbox'], [role='combobox']"
  ));
}

function ownsHorizontalArrowKeys(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || Boolean(target.closest(
    "input, textarea, select, [contenteditable='true'], [role='slider'], [role='spinbutton'], [role='combobox'], [role='listbox']"
  ));
}

function subtitleTrackUrl(sidecar: MediaSidecar): string {
  const url = sidecar.trackUrl ?? `/api/sidecars/${sidecar.id}/track.vtt`;
  return `${url}${url.includes("?") ? "&" : "?"}v=${sidecar.mtimeMs}`;
}

export function PlayerModal({
  item: inputItem,
  standaloneSource,
  onPrevious,
  onNext,
  initialPositionSeconds = null,
  metadataLanguage,
  onClose,
  onSelectVersion,
  onProgress,
  onToggleFavorite
}: PlayerModalProps) {
  useLocale();
  const fallbackPositionRef = useRef(0);
  const fallbackRequestRef = useRef<PlaybackPreparation | null>(null);
  const fallbackTargetRef = useRef<PlaybackPreparation | null>(null);
  const fallbackReasonRef = useRef<PlaybackSwitchReason>("auto");
  const playbackSwitchReasonRef = useRef<PlaybackSwitchReason>("auto");
  const playbackModeRef = useRef<PlaybackMode>("source");
  const playbackSucceededRef = useRef(false);
  const sourceRetryRef = useRef(false);
  const detail = useQuery({
    queryKey: ["media-detail", inputItem?.id],
    queryFn: () => fetchMediaDetail(inputItem?.id ?? ""),
    enabled: Boolean(inputItem?.id && !standaloneSource),
    staleTime: 5 * 60 * 1000
  });
  const item = standaloneSource ? inputItem : detail.data?.item ?? inputItem;
  const playbackSource = useQuery({
    queryKey: ["playback-source", item?.id],
    queryFn: () => fetchPlaybackSource(item?.id ?? ""),
    enabled: Boolean(item?.id && item.mediaType === "video" && !standaloneSource)
  });
  const embeddedSubtitles = useQuery({
    queryKey: ["embedded-subtitles", item?.id],
    queryFn: async () => { const response = await fetch(`/api/media/${item?.id}/subtitles/embedded`); if (!response.ok) throw new Error(t("无法探测嵌入字幕")); return response.json() as Promise<{items:Array<{index:number;codec:string;language:string;title:string;supported:boolean}>}>; },
    enabled: Boolean(item?.id && item.mediaType === "video" && !standaloneSource),
    retry: false, staleTime: 5 * 60 * 1000
  });
  const refetchPlaybackSource = playbackSource.refetch;
  const storyboard = useQuery({
    queryKey: ["storyboard", item?.id],
    queryFn: () => fetchStoryboard(item?.id ?? ""),
    enabled: Boolean(item?.id && item.mediaType === "video" && !standaloneSource),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "pending" || status === "missing" ? 4_000 : false;
    },
    staleTime: 10 * 60 * 1000
  });
  const shellRef = useRef<HTMLDivElement | null>(null);
  const firstControlRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const gestureRef = useRef<GestureState | null>(null);
  const lastTapRef = useRef<TapState | null>(null);
  const lastDoubleTapSeekAtRef = useRef(0);
  const hintTimerRef = useRef<number | null>(null);
  const playbackErrorTimerRef = useRef<number | null>(null);
  const videoFrameCallbackRef = useRef<number | null>(null);
  const videoFrameMonitorRef = useRef<number | null>(null);
  const progressRef = useRef({ itemId: "", lastSentAt: 0, lastPosition: 0, started: false, resumed: false });
  const [isLooping, setIsLooping] = useState(standaloneSource?.loop ?? false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [brightness, setBrightness] = useState(1);
  const [gestureHint, setGestureHint] = useState<string | null>(null);
  const [timelinePreview, setTimelinePreview] = useState<{ cue: StoryboardCue; time: number; left: number } | null>(null);
  const [playbackPosition, setPlaybackPosition] = useState(0);
  const [highlightOpen, setHighlightOpen] = useState(false);
  const [playbackDuration, setPlaybackDuration] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [selectedSubtitle, setSelectedSubtitle] = useState("auto");
  const [subtitleEncoding, setSubtitleEncoding] = useState("auto");
  const [subtitleCues, setSubtitleCues] = useState<PlayerSubtitleCue[]>([]);
  const [aiSubtitleOverride, setAiSubtitleOverride] = useState<boolean | null>(null);
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>("source");
  const [playbackPreparation, setPlaybackPreparation] = useState<PlaybackPreparation | null>(null);
  const [playbackStatus, setPlaybackStatus] = useState<{ message: string; error: boolean } | null>(null);
  const focusPlayerDialog = useCallback(() => {
    const shell = shellRef.current;
    if (!shell || shell.contains(document.activeElement)) return;
    shell.focus({ preventScroll: true });
  }, []);
  const activeItemId = item?.id;
  const activeMediaType = item?.mediaType;
  const subtitleSidecars = detail.data?.sidecars.filter((sidecar) => sidecar.kind === "subtitle") ?? [];
  const aiSubtitle = subtitleSidecars.find((sidecar) => sidecar.isTranslated) ?? null;
  const nativeSubtitleSidecars: MediaSidecar[] = [
    ...subtitleSidecars.filter((sidecar) => !sidecar.isTranslated),
    ...(embeddedSubtitles.data?.items.filter(track => track.supported).map(track => ({id:`embedded-${track.index}`,kind:"subtitle" as const,relativePath:"",language:track.language,label:t("嵌入 · {{p0}} ({{p1}})", { p0: track.title || track.language, p1: track.codec }),format:"vtt",size:0,mtimeMs:item?.mtimeMs ?? 0,trackUrl:`/api/media/${item?.id}/subtitles/embedded/${track.index}.vtt`})) ?? [])
  ];
  const activeNativeSubtitleId = selectedSubtitle === "auto" ? nativeSubtitleSidecars[0]?.id : selectedSubtitle;
  useEffect(() => { setSelectedSubtitle("auto"); setSubtitleEncoding("auto"); }, [item?.id]);
  const nativeChineseSubtitlePresent = hasNativeChineseSubtitle(
    nativeSubtitleSidecars,
    detail.data?.translation?.sourceKind
  );
  const aiSubtitlesEnabled = aiSubtitleOverride ?? !nativeChineseSubtitlePresent;
  const aiSubtitleUrl = aiSubtitle ? subtitleTrackUrl(aiSubtitle) : "";
  const nativeSelectedIndex = nativeSubtitleSidecars.findIndex(track => track.id === activeNativeSubtitleId);
  const nativeSubtitleSignature = nativeSubtitleSidecars.map((sidecar) => `${sidecar.id}:${sidecar.mtimeMs}`).join("|");
  const activeSubtitleText = findActiveSubtitleText(subtitleCues, playbackPosition);
  const streamUrl = standaloneSource?.url ?? (item
    ? playbackMode === "hls"
      ? `/api/media/${item.id}/hls/master.m3u8`
      : playbackMode === "remux"
        ? `/api/media/${item.id}/derivatives/remux`
        : getStreamUrl(item.id)
    : "");
  const isHlsStream = streamUrl.endsWith(".m3u8");
  const canPlayNativeHls = typeof document !== "undefined"
    && document.createElement("video").canPlayType("application/vnd.apple.mpegurl") !== "";
  const useHlsEngine = isHlsStream && !canPlayNativeHls;
  const isVideoSourceUnavailable = item?.mediaType === "video" && playbackSource.data?.sourceAvailable === false;

  playbackModeRef.current = playbackMode;

  useEffect(() => {
    const activeElement = document.activeElement;
    previouslyFocusedRef.current = activeElement instanceof HTMLElement ? activeElement : null;
    focusPlayerDialog();
    const focusTimer = window.setTimeout(() => {
      (firstControlRef.current ?? shellRef.current)?.focus({ preventScroll: true });
    }, 300);

    return () => {
      window.clearTimeout(focusTimer);
      const previous = previouslyFocusedRef.current;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      previouslyFocusedRef.current = null;
    };
  }, [focusPlayerDialog]);

  useEffect(() => {
    const controller = new AbortController();
    setSubtitleCues([]);
    if (!aiSubtitleUrl || activeMediaType !== "video") return () => controller.abort();
    void fetch(aiSubtitleUrl, { cache: "no-store", signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(t("字幕请求失败：{{p0}}", { p0: response.status }));
        return response.text();
      })
      .then((content) => setSubtitleCues(parseWebVtt(content)))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setSubtitleCues([]);
      });
    return () => controller.abort();
  }, [activeMediaType, aiSubtitleUrl]);

  useEffect(() => {
    const tracks = videoRef.current?.textTracks;
    if (!tracks) return;
    const showNativeTrack = !aiSubtitle || !aiSubtitlesEnabled;
    for (let index = 0; index < tracks.length; index += 1) {
      tracks[index].mode = showNativeTrack && index === nativeSelectedIndex ? "showing" : "disabled";
    }
  }, [activeItemId, aiSubtitle, aiSubtitlesEnabled, nativeSubtitleSignature, nativeSelectedIndex]);

  const requestFallback = useCallback(async (target: PlaybackPreparation, reason: PlaybackSwitchReason = "auto") => {
    if (standaloneSource || !item?.id || fallbackRequestRef.current === target) return;
    fallbackRequestRef.current = target;
    fallbackTargetRef.current = target;
    fallbackReasonRef.current = reason;
    setPlaybackPreparation(target);
    const label = target === "probe" ? t("正在检测视频格式") : target === "remux" ? t("正在准备兼容播放") : t("正在准备流媒体播放");
    setPlaybackStatus({ message: label, error: false });
    try {
      await requestCompatibilityAction(item.id, target);
      void refetchPlaybackSource();
    } catch (error) {
      fallbackTargetRef.current = null;
      setPlaybackPreparation(null);
      setPlaybackStatus({
        message: playbackRequestErrorMessage(error),
        error: true
      });
    } finally {
      fallbackRequestRef.current = null;
    }
  }, [item?.id, refetchPlaybackSource, standaloneSource]);

  const switchPlaybackMode = useCallback((mode: PlaybackMode, reason: PlaybackSwitchReason = "auto") => {
    const video = videoRef.current;
    fallbackPositionRef.current = Math.max(video?.currentTime ?? 0, progressRef.current.lastPosition);
    progressRef.current.resumed = false;
    fallbackTargetRef.current = null;
    playbackSwitchReasonRef.current = reason;
    playbackSucceededRef.current = false;
    setPlaybackPreparation(null);
    setPlaybackStatus({
      message: mode === "source"
        ? t("正在切换原始播放")
        : mode === "remux"
          ? t("正在切换兼容播放")
          : t("正在切换流媒体播放"),
      error: false
    });
    setPlaybackMode(mode);
  }, []);

  const handlePlaybackFailure = useCallback((failedMode: PlaybackMode) => {
    if (standaloneSource) {
      setPlaybackStatus({ message: t("高光无法播放，请检查硬盘连接，或返回列表点击修复重试"), error: true });
      return;
    }
    if (!item?.id || failedMode !== playbackModeRef.current || fallbackTargetRef.current) return;
    fallbackPositionRef.current = Math.max(videoRef.current?.currentTime ?? 0, progressRef.current.lastPosition);
    const source = playbackSource.data;

    if (failedMode === "source") {
      if (!source || source.probeStatus !== "ready") {
        void requestFallback("probe");
      } else if (source.compatibilityStatus === "remux") {
        if (source.remuxReady) switchPlaybackMode("remux");
        else void requestFallback("remux");
      } else {
        if (source.hlsReady) switchPlaybackMode("hls");
        else void requestFallback("hls");
      }
      return;
    }

    if (failedMode === "remux") {
      if (source?.hlsReady) switchPlaybackMode("hls");
      else void requestFallback("hls");
      return;
    }

    setPlaybackStatus({ message: t("所有播放方案均失败，请检查源文件或服务状态"), error: true });
  }, [item?.id, playbackSource.data, requestFallback, switchPlaybackMode, standaloneSource]);

  function clearHintTimer() {
    if (hintTimerRef.current != null) {
      window.clearTimeout(hintTimerRef.current);
      hintTimerRef.current = null;
    }
  }

  function clearPlaybackErrorTimer() {
    if (playbackErrorTimerRef.current != null) {
      window.clearTimeout(playbackErrorTimerRef.current);
      playbackErrorTimerRef.current = null;
    }
  }

  function clearVideoFrameMonitor() {
    const video = videoRef.current as FrameAwareVideo | null;
    if (videoFrameCallbackRef.current != null) {
      video?.cancelVideoFrameCallback?.(videoFrameCallbackRef.current);
      videoFrameCallbackRef.current = null;
    }
    if (videoFrameMonitorRef.current != null) {
      window.clearInterval(videoFrameMonitorRef.current);
      videoFrameMonitorRef.current = null;
    }
  }

  function confirmVisualPlayback(mode: PlaybackMode) {
    if (mode !== playbackModeRef.current) return;
    playbackSucceededRef.current = true;
    fallbackTargetRef.current = null;
    setPlaybackStatus(null);
  }

  function monitorVideoFrames(video: HTMLVideoElement, mode: PlaybackMode) {
    clearVideoFrameMonitor();
    const frameVideo = video as FrameAwareVideo;

    if (!frameVideo.requestVideoFrameCallback) {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0) {
        confirmVisualPlayback(mode);
      }
      return;
    }

    let hasPresentedFrame = false;
    let lastFrameAt = window.performance.now();
    let lastMediaTime = video.currentTime;
    const observeNextFrame = () => {
      if (videoRef.current !== video || mode !== playbackModeRef.current || !frameVideo.requestVideoFrameCallback) return;
      videoFrameCallbackRef.current = frameVideo.requestVideoFrameCallback(() => {
        videoFrameCallbackRef.current = null;
        lastFrameAt = window.performance.now();
        if (!hasPresentedFrame) {
          hasPresentedFrame = true;
          confirmVisualPlayback(mode);
        }
        observeNextFrame();
      });
    };

    observeNextFrame();
    videoFrameMonitorRef.current = window.setInterval(() => {
      if (videoRef.current !== video || mode !== playbackModeRef.current || video.paused || video.ended) return;
      const currentTime = video.currentTime;
      const mediaAdvanced = currentTime - lastMediaTime;
      lastMediaTime = currentTime;
      if (mediaAdvanced < 0.35 || window.performance.now() - lastFrameAt < 4_500) return;

      clearVideoFrameMonitor();
      playbackSucceededRef.current = false;
      handlePlaybackFailure(mode);
    }, 1_500);
  }

  function confirmPlaybackFailure(video: HTMLVideoElement, mode: PlaybackMode) {
    clearPlaybackErrorTimer();
    const confirmationDelay = video.readyState > HTMLMediaElement.HAVE_NOTHING ? 2_000 : 600;
    playbackErrorTimerRef.current = window.setTimeout(() => {
      playbackErrorTimerRef.current = null;
      if (!video.error) return;
      if (mode === "source" && !sourceRetryRef.current && video.videoWidth > 0) {
        sourceRetryRef.current = true;
        fallbackPositionRef.current = Math.max(video.currentTime, progressRef.current.lastPosition);
        progressRef.current.resumed = false;
        video.load();
        void video.play().catch(() => undefined);
        return;
      }
      handlePlaybackFailure(mode);
    }, confirmationDelay);
  }

  function showGestureHint(label: string, timeout = GESTURE_HINT_MAX_DURATION_MS) {
    setGestureHint(label);
    clearHintTimer();
    hintTimerRef.current = window.setTimeout(
      () => setGestureHint(null),
      Math.min(timeout, GESTURE_HINT_MAX_DURATION_MS)
    );
  }

  function revealProgressControls() {
    // The transport controls intentionally stay visible while the player is open.
  }

  function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => undefined);
    else video.pause();
  }

  function toggleMuted() {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
  }

  function syncPlaybackClock(video: HTMLVideoElement) {
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : item?.durationSeconds ?? null;
    setPlaybackPosition(video.currentTime);
    setPlaybackDuration(duration);
  }

  function seekBy(delta: number) {
    const video = videoRef.current;
    if (!video || item?.mediaType !== "video") return;
    const duration = Number.isFinite(video.duration) ? video.duration : item.durationSeconds ?? 0;
    video.currentTime = clamp(video.currentTime + delta, 0, Math.max(0, duration));
    syncPlaybackClock(video);
    revealProgressControls();
    showGestureHint(`${delta > 0 ? "+" : ""}${delta}s`);
  }

  function changePlaybackRate(rate: number) {
    setPlaybackRate(rate);
    if (videoRef.current) videoRef.current.playbackRate = rate;
    showGestureHint(`${rate}x`);
  }

  function clearHoldTimer(state: GestureState) {
    if (state.holdTimer != null) {
      window.clearTimeout(state.holdTimer);
      state.holdTimer = null;
    }
  }

  const enterFullscreenPlayback = useCallback(async () => {
    if (!activeMediaType) return;

    const video = videoRef.current as FullscreenVideo | null;
    const shell = shellRef.current;

    if (document.fullscreenElement || !shell) {
      return;
    }

    if (activeMediaType === "video" && video?.webkitEnterFullscreen) {
      try {
        video.webkitEnterFullscreen();
        return;
      } catch {
        // Fall through to the standards-based fullscreen API.
      }
    }

    await shell.requestFullscreen().catch(() => undefined);
  }, [activeMediaType]);

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }

    await enterFullscreenPlayback();
  }

  function finishGesture(target: EventTarget & HTMLDivElement) {
    const state = gestureRef.current;
    const video = videoRef.current;
    if (!state) return;

    clearHoldTimer(state);

    if (state.holdActive && video) {
      video.playbackRate = state.previousRate || 1;
      showGestureHint(`${video.playbackRate.toFixed(0)}x`);
    }

    if (state.mode === "seek" && state.wasPlaying && video?.paused) {
      video.play().catch(() => undefined);
    }

    try {
      if (target.hasPointerCapture(state.pointerId)) {
        target.releasePointerCapture(state.pointerId);
      }
    } catch {
      // The browser can release capture automatically when native media controls are involved.
    }

    gestureRef.current = null;
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (item?.mediaType !== "video") return;
    if (event.pointerType === "mouse" && event.button !== 0) return;

    const video = videoRef.current;
    if (!video) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const startX = event.clientX - rect.left;
    const startY = event.clientY - rect.top;
    const state: GestureState = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startX,
      startY,
      baseVolume: video.volume,
      baseBrightness: brightness,
      baseTime: video.currentTime,
      previousRate: video.playbackRate || 1,
      wasPlaying: !video.paused,
      region: startX < rect.width / 2 ? "brightness" : "volume",
      mode: null,
      holdTimer: null,
      holdActive: false
    };

    if (event.pointerType !== "mouse") {
      state.holdTimer = window.setTimeout(() => {
        const activeVideo = videoRef.current;
        if (!activeVideo || gestureRef.current !== state || state.mode) return;

        state.holdActive = true;
        state.previousRate = activeVideo.playbackRate || 1;
        activeVideo.playbackRate = 3;
        showGestureHint(t("3x 快进中"), 1200);
      }, 260);
    }

    gestureRef.current = state;
    event.currentTarget.setPointerCapture(event.pointerId);
    revealProgressControls();
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const state = gestureRef.current;
    const video = videoRef.current;
    if (!state || !video || event.pointerId !== state.pointerId) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const deltaX = event.clientX - rect.left - state.startX;
    const deltaY = event.clientY - rect.top - state.startY;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);

    if (!state.mode && (absX > 18 || absY > 18)) {
      clearHoldTimer(state);
      state.mode = absX > absY + 8 ? "seek" : state.region;
    }

    if (!state.mode) return;

    event.preventDefault();

    if (state.mode === "volume") {
      const nextVolume = clamp(state.baseVolume - deltaY / rect.height, 0, 1);
      video.volume = nextVolume;
      video.muted = nextVolume === 0;
      showGestureHint(t("音量 {{p0}}%", { p0: Math.round(nextVolume * 100) }));
      return;
    }

    if (state.mode === "brightness") {
      const nextBrightness = clamp(state.baseBrightness - (deltaY / rect.height) * 1.35, 0.35, 1.65);
      setBrightness(nextBrightness);
      showGestureHint(t("亮度 {{p0}}%", { p0: Math.round(nextBrightness * 100) }));
      return;
    }

    if (Number.isFinite(video.duration) && video.duration > 0) {
      const nextTime = clamp(state.baseTime + (deltaX / rect.width) * 120, 0, video.duration);
      video.currentTime = nextTime;
      setPlaybackPosition(nextTime);
      revealProgressControls();
      showGestureHint(formatDuration(nextTime));
    }
  }

  function handlePointerEnd(event: PointerEvent<HTMLDivElement>) {
    const state = gestureRef.current;
    const rect = event.currentTarget.getBoundingClientRect();
    const endX = event.clientX - rect.left;
    const endY = event.clientY - rect.top;
    const isTap = Boolean(
      state
      && state.pointerId === event.pointerId
      && !state.mode
      && !state.holdActive
      && Math.hypot(endX - state.startX, endY - state.startY) <= 18
    );
    finishGesture(event.currentTarget);

    if (!isTap) {
      lastTapRef.current = null;
      return;
    }

    const now = Date.now();
    const side = endX < rect.width / 2 ? "left" : "right";
    const previous = lastTapRef.current;
    const isDoubleTap = Boolean(
      previous
      && previous.side === side
      && now - previous.at <= DOUBLE_TAP_MAX_INTERVAL_MS
      && Math.hypot(endX - previous.x, endY - previous.y) <= DOUBLE_TAP_MAX_DISTANCE_PX
    );

    if (isDoubleTap) {
      lastTapRef.current = null;
      lastDoubleTapSeekAtRef.current = now;
      seekBy(side === "left" ? -15 : 15);
      return;
    }

    lastTapRef.current = { at: now, side, x: endX, y: endY };
  }

  function handlePointerCancel(event: PointerEvent<HTMLDivElement>) {
    lastTapRef.current = null;
    finishGesture(event.currentTarget);
  }

  function handleGestureDoubleClick(event: MouseEvent<HTMLDivElement>) {
    if (item?.mediaType !== "video") return;
    const now = Date.now();
    if (now - lastDoubleTapSeekAtRef.current < 250) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const side = event.clientX - rect.left < rect.width / 2 ? "left" : "right";
    lastDoubleTapSeekAtRef.current = now;
    lastTapRef.current = null;
    seekBy(side === "left" ? -15 : 15);
  }

  useEffect(() => {
    function handleFullscreenChange() {
      setIsFullscreen(Boolean(document.fullscreenElement));
    }

    function handleKeyDown(event: KeyboardEvent) {
      const shell = shellRef.current;
      if (!shell) return;
      const activeElement = document.activeElement;
      const targetInsidePlayer = event.target instanceof Node && shell.contains(event.target);
      const focusInsidePlayer = activeElement instanceof Node && shell.contains(activeElement);

      if (event.key === "Tab") {
        const focusable = [...shell.querySelectorAll<HTMLElement>(PLAYER_FOCUSABLE_SELECTOR)]
          .filter((element) => element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true");
        if (focusable.length === 0) {
          event.preventDefault();
          shell.focus({ preventScroll: true });
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (activeElement === shell) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (!targetInsidePlayer || !focusInsidePlayer) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && activeElement === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }

      if (highlightOpen && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setHighlightOpen(false);
        return;
      }
      if (event.target instanceof Element && event.target.closest(".highlight-editor") && event.key !== "Tab") return;

      if (event.key === "Escape" && !document.fullscreenElement) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        if (event.defaultPrevented || !item || item.mediaType !== "video" || !videoRef.current) return;
        if (targetInsidePlayer && ownsHorizontalArrowKeys(event.target)) return;
        event.preventDefault();
        seekBy(event.key === "ArrowRight" ? 15 : -15);
        return;
      }

      if (!targetInsidePlayer) return;
      if (!item || isInteractiveTarget(event.target)) return;
      if (item.mediaType === "video") revealProgressControls();

      const video = videoRef.current;
      const key = event.key.toLowerCase();

      if (key === "f") {
        event.preventDefault();
        void toggleFullscreen();
        return;
      }

      if (key === "l") {
        event.preventDefault();
        onToggleFavorite?.(item, !item.isFavorite);
        return;
      }

      if (!video || item.mediaType !== "video") return;

      if (event.key === " ") {
        event.preventDefault();
        if (video.paused) {
          video.play().catch(() => undefined);
        } else {
          video.pause();
        }
        return;
      }

      if (key === "m") {
        event.preventDefault();
        video.muted = !video.muted;
        showGestureHint(video.muted ? t("静音") : t("音量 {{p0}}%", { p0: Math.round(video.volume * 100) }));
      }
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  });

  useEffect(() => () => clearHintTimer(), []);

  useEffect(() => {
    setBrightness(1);
    setGestureHint(null);
    lastTapRef.current = null;
    lastDoubleTapSeekAtRef.current = 0;
    setTimelinePreview(null);
    setDetailsExpanded(false);
    setPlaybackRate(1);
    setPlaybackPosition(initialPositionSeconds ?? item?.playback?.positionSeconds ?? 0);
    setPlaybackDuration(item?.playback?.durationSeconds ?? item?.durationSeconds ?? null);
    setIsPlaying(false);
    setIsMuted(false);
    setIsLooping(standaloneSource?.loop ?? false);
    setAiSubtitleOverride(null);
    setPlaybackMode("source");
    setPlaybackPreparation(null);
    setPlaybackStatus(null);
    fallbackPositionRef.current = 0;
    fallbackRequestRef.current = null;
    fallbackTargetRef.current = null;
    fallbackReasonRef.current = "auto";
    playbackSwitchReasonRef.current = "auto";
    playbackSucceededRef.current = false;
    sourceRetryRef.current = false;
    clearVideoFrameMonitor();
    progressRef.current = {
      itemId: item?.id ?? "",
      lastSentAt: 0,
      lastPosition: 0,
      started: false,
      resumed: false
    };

    if (videoRef.current) {
      videoRef.current.playbackRate = 1;
    }
    // Reset only when changing files; progress cache updates must not restart active playback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPositionSeconds, item?.id]);

  useEffect(() => {
    const source = playbackSource.data;
    if (!item || item.mediaType !== "video" || !source || playbackSucceededRef.current) return;

    if (!source.sourceAvailable) {
      fallbackTargetRef.current = null;
      setPlaybackPreparation(null);
      setPlaybackStatus({ message: t("视频源暂未连接，当前仅可浏览固态硬盘中的馆藏数据"), error: true });
      return;
    }

    const pending = fallbackTargetRef.current;
    // The browser's actual media events are more reliable than canPlayType() and
    // stored probe metadata. Keep the original source until it really fails.
    if (!pending) return;
    if (pending === "probe") {
      if (source.probeStatus !== "ready") return;
      fallbackTargetRef.current = null;
      if (source.compatibilityStatus === "remux") void requestFallback("remux");
      else void requestFallback("hls");
      return;
    }
    if (pending === "remux") {
      if (source.derivatives.remux.status === "failed") {
        fallbackTargetRef.current = null;
        setPlaybackPreparation(null);
        setPlaybackStatus({ message: playbackFailureMessage(source.derivatives.remux.failureReason), error: true });
        return;
      }
      if (source.remuxReady) switchPlaybackMode("remux", fallbackReasonRef.current);
      return;
    }
    if (pending === "hls") {
      if (source.derivatives.hls.status === "failed") {
        fallbackTargetRef.current = null;
        setPlaybackPreparation(null);
        setPlaybackStatus({ message: playbackFailureMessage(source.derivatives.hls.failureReason), error: true });
        return;
      }
      if (source.hlsReady) switchPlaybackMode("hls", fallbackReasonRef.current);
    }
  }, [item, playbackSource.data, requestFallback, switchPlaybackMode]);

  useEffect(() => {
    if (!activeItemId || activeMediaType !== "video") return;
    const timer = window.setInterval(() => {
      if (fallbackTargetRef.current) void refetchPlaybackSource();
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [activeItemId, activeMediaType, refetchPlaybackSource]);

  useEffect(() => () => clearPlaybackErrorTimer(), []);

  useEffect(() => () => clearVideoFrameMonitor(), []);

  useEffect(() => {
    if (standaloneSource || !activeItemId || activeMediaType !== "video" || playbackSource.data?.sourceAvailable !== true) return;
    // Let the actual device try the original before creating a full compatibility copy.
    void prepareReadiness(activeItemId, { playback: false, storyboard: true }).catch(() => undefined);
  }, [activeItemId, activeMediaType, playbackSource.data?.sourceAvailable, standaloneSource]);



  useEffect(() => {
    if (!activeItemId || activeMediaType !== "video") return;

    const orientationQuery = window.matchMedia("(orientation: landscape)");
    const touchQuery = window.matchMedia("(pointer: coarse)");
    const requestLandscapeFullscreen = () => {
      if (orientationQuery.matches && touchQuery.matches) {
        void enterFullscreenPlayback();
      }
    };

    requestLandscapeFullscreen();
    if (orientationQuery.addEventListener) {
      orientationQuery.addEventListener("change", requestLandscapeFullscreen);
      return () => orientationQuery.removeEventListener("change", requestLandscapeFullscreen);
    }

    orientationQuery.addListener(requestLandscapeFullscreen);
    return () => orientationQuery.removeListener(requestLandscapeFullscreen);
  }, [activeItemId, activeMediaType, enterFullscreenPlayback]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !streamUrl || !useHlsEngine) return;

    let disposed = false;
    let destroy: (() => void) | undefined;
    void import("hls.js").then(({ default: Hls }) => {
      if (disposed || !Hls.isSupported()) return;
      const hls = new Hls({
        backBufferLength: 60,
        maxBufferLength: 30,
        maxMaxBufferLength: 90
      });
      destroy = () => hls.destroy();
      hls.loadSource(streamUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => undefined);
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) handlePlaybackFailure("hls");
      });
    });

    return () => {
      disposed = true;
      destroy?.();
    };
  }, [activeItemId, handlePlaybackFailure, streamUrl, useHlsEngine]);

  if (!item) return null;
  const currentItemDuration = item.durationSeconds;

  const tags = parseVariantTags(item.variantTags);
  const metadata = item.metadata?.status === "ready" ? item.metadata : null;
  const displayMetadata = metadata ? getDisplayMetadata(metadata, metadataLanguage) : null;
  const displayTitle = displayMetadata?.title
    ? `${item.normalizedCode ? `${item.normalizedCode} ` : ""}${displayMetadata.title}`
    : item.normalizedCode || item.basename;
  const metadataFacts = metadata
    ? [
        displayMetadata && displayMetadata.actors.length > 0 ? { label: t("演员"), value: compactList(displayMetadata.actors, 4) } : null,
        displayMetadata?.director ? { label: t("导演"), value: displayMetadata.director } : null,
        metadata.releaseDate ? { label: t("发行"), value: metadata.releaseDate } : null,
        metadata.runtimeMinutes ? { label: t("片长"), value: `${metadata.runtimeMinutes} 分钟` } : null,
        displayMetadata?.maker ? { label: t("厂商"), value: displayMetadata.maker } : null,
        displayMetadata?.label ? { label: t("厂牌"), value: displayMetadata.label } : null,
        displayMetadata?.series ? { label: t("系列"), value: displayMetadata.series } : null,
        metadata.score ? { label: t("评分"), value: String(metadata.score) } : null
      ].filter(Boolean) as Array<{ label: string; value: string }>
    : [];
  const playbackModeOptions = ([
    {
      key: "source",
      title: t("原文件直放（无需处理）"),
      description: playbackSource.data?.sourceAvailable === false ? t("存储盘未连接，暂不可用") : t("使用当前设备解码，不生成兼容文件"),
      ready: playbackSource.data?.sourceAvailable !== false
    },
    {
      key: "remux",
      title: t("无损转封装 MP4"),
      description: playbackSource.data?.remuxReady
        ? playbackSource.data?.sourceAvailable === false
          ? t("视频源连接后可用")
          : t("已准备，可立即切换")
        : playbackSource.data?.sourceAvailable === false
          ? t("连接存储盘后可准备")
          : t("只更换封装，不修复不支持的编码；需等待生成"),
      ready: playbackSource.data?.sourceAvailable !== false && Boolean(playbackSource.data?.remuxReady)
    },
    {
      key: "hls",
      title: t("转码播放 H.264 / AAC"),
      description: playbackSource.data?.hlsReady
        ? playbackSource.data?.sourceAvailable === false
          ? t("视频源连接后可用")
          : t("已准备，适合兼容性较弱的设备")
        : playbackSource.data?.sourceAvailable === false
          ? t("连接存储盘后可准备")
          : t("重新编码以提高兼容性；需等待生成"),
      ready: playbackSource.data?.sourceAvailable !== false && Boolean(playbackSource.data?.hlsReady)
    }
  ] as const).map((option) => ({
    ...option,
    disabled: (playbackMode === option.key && playbackPreparation == null)
      || (playbackSource.data?.sourceAvailable === false && !option.ready)
  }));
  const progressDuration = playbackDuration ?? currentItemDuration ?? 0;
  const hasKnownProgressDuration = Number.isFinite(progressDuration) && progressDuration > 0;
  const progressValue = hasKnownProgressDuration ? clamp(playbackPosition, 0, progressDuration) : 0;
  const progressPercent = hasKnownProgressDuration ? (progressValue / progressDuration) * 100 : 0;

  function handleManualPlaybackMode(mode: PlaybackMode) {
    if (isVideoSourceUnavailable) {
      setPlaybackStatus({ message: t("视频源暂未连接，当前仅可浏览固态硬盘中的馆藏数据"), error: true });
      return;
    }
    if (mode === "source") {
      switchPlaybackMode("source", "manual");
      return;
    }

    const ready = mode === "remux"
      ? playbackSource.data?.remuxReady
      : playbackSource.data?.hlsReady;
    if (ready) {
      switchPlaybackMode(mode, "manual");
      return;
    }
    void requestFallback(mode, "manual");
  }

  function updateTimelinePreview(target: HTMLDivElement, clientX: number, seek = false) {
    const video = videoRef.current;
    const data = storyboard.data;
    if (!video || !data || data.status !== "ready" || data.cues.length === 0) return;
    const rect = target.getBoundingClientRect();
    const ratio = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    const duration = Number.isFinite(video.duration) && video.duration > 0
      ? video.duration
      : data.duration ?? currentItemDuration ?? 0;
    const time = duration * ratio;
    const cue = data.cues.find((entry) => time >= entry.start && time < entry.end) ?? data.cues.at(-1);
    if (!cue) return;
    setTimelinePreview({ cue, time, left: ratio * 100 });
    revealProgressControls();
    if (seek) {
      video.currentTime = time;
      setPlaybackPosition(time);
    }
  }

  function handleProgressChange(event: ChangeEvent<HTMLInputElement>) {
    const video = videoRef.current;
    const nextTime = Number(event.currentTarget.value);
    if (!video || !Number.isFinite(nextTime)) return;
    const duration = Number.isFinite(video.duration) && video.duration > 0
      ? video.duration
      : playbackDuration ?? currentItemDuration ?? 0;
    video.currentTime = clamp(nextTime, 0, Math.max(0, duration));
    syncPlaybackClock(video);
    revealProgressControls();
  }

  function reportProgress(video: HTMLVideoElement, reason: "start" | "tick" | "pause" | "ended") {
    if (!item || item.mediaType !== "video" || !onProgress) return;

    const now = Date.now();
    const duration = Number.isFinite(video.duration) ? video.duration : item.durationSeconds;
    const completed = reason === "ended" || Boolean(duration && duration - video.currentTime <= 20);
    const shouldStart = reason === "start" && !progressRef.current.started;

    if (reason === "tick") {
      const timeDelta = now - progressRef.current.lastSentAt;
      const positionDelta = Math.abs(video.currentTime - progressRef.current.lastPosition);
      if (timeDelta < 10_000 && positionDelta < 12) return;
    }

    progressRef.current.started = progressRef.current.started || shouldStart;
    progressRef.current.lastSentAt = now;
    progressRef.current.lastPosition = video.currentTime;

    onProgress(item, {
      positionSeconds: video.currentTime,
      durationSeconds: duration,
      completed,
      started: shouldStart
    });
  }

  function resumePlaybackPosition(video: HTMLVideoElement) {
    if (!item || progressRef.current.resumed) return;

    const fallbackPosition = fallbackPositionRef.current;
    const requestedPosition = initialPositionSeconds == null
      ? null
      : Math.max(0, initialPositionSeconds);
    const savedPosition = requestedPosition ?? Math.max(item.playback?.positionSeconds ?? 0, fallbackPosition);
    const duration = Number.isFinite(video.duration) ? video.duration : item.durationSeconds;
    if (savedPosition <= 15 || (duration && savedPosition >= duration - 30)) {
      progressRef.current.resumed = true;
      return;
    }

    try {
      video.currentTime = savedPosition;
      showGestureHint(
        fallbackPosition > 0
          ? playbackSwitchReasonRef.current === "manual" ? t("已手动切换播放方式") : t("已自动切换播放方案")
          : requestedPosition != null
            ? requestedPosition > 0 ? t("从 {{p0}} 开始", { p0: formatDuration(requestedPosition) }) : t("已从头播放")
            : t("从 {{p0}} 继续", { p0: formatDuration(savedPosition) }),
        500
      );
      fallbackPositionRef.current = 0;
    } catch {
      // Browsers can reject early seeks before metadata is fully available.
    } finally {
      progressRef.current.resumed = true;
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        aria-labelledby="player-dialog-title"
        aria-modal="true"
        className={`player-shell${detailsExpanded ? " is-details-expanded" : ""}`}
        ref={shellRef}
        role="dialog"
        tabIndex={-1}
        onAnimationEnd={focusPlayerDialog}
        onTransitionEnd={focusPlayerDialog}
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={revealProgressControls}
        onPointerMove={revealProgressControls}
      >
        <div className="player-topbar">
          <div>
            <strong id="player-dialog-title" title={displayTitle}>{displayTitle}</strong>
            <span>{item.relativePath}</span>
          </div>
          <div className="player-actions">
            {!standaloneSource && item.mediaType === "video" && <button type="button" aria-label={t("截取高光")} title={t("截取高光")} disabled={!hasKnownProgressDuration} onClick={() => setHighlightOpen(value => !value)}><Scissors size={18}/></button>}
            {(detail.data?.versions.length ?? 0) > 1 && (
              <select
                aria-label={t("选择文件版本")}
                className="player-version-select"
                title={t("选择文件版本")}
                onChange={(event) => {
                  const version = detail.data?.versions.find((candidate) => candidate.id === event.target.value);
                  if (version) onSelectVersion?.(version);
                }}
                value={item.id}
              >
                {detail.data?.versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    {version.sourceName} · {version.extension.toUpperCase()} · {formatBytes(version.size)}
                  </option>
                ))}
              </select>
            )}
            {item.mediaType === "video" && !isVideoSourceUnavailable && (
              <>
                <button ref={firstControlRef} aria-label={t("后退 15 秒")} onClick={() => seekBy(-15)} title={t("后退 15 秒")} type="button">
                  <RotateCcw size={18} />
                </button>
                <select
                  aria-label={t("播放速度")}
                  className="player-rate-select"
                  onChange={(event) => changePlaybackRate(Number(event.target.value))}
                  title={t("播放速度")}
                  value={playbackRate}
                >
                  {[0.5, 0.75, 1, 1.25, 1.5, 2, 3].map((rate) => (
                    <option key={rate} value={rate}>{rate}x</option>
                  ))}
                </select>
                <button aria-label={t("前进 15 秒")} onClick={() => seekBy(15)} title={t("前进 15 秒")} type="button">
                  <RotateCw size={18} />
                </button>
                {nativeSubtitleSidecars.length > 0 && <select aria-label={t("字幕轨道")} className="player-rate-select" value={selectedSubtitle} onChange={event => {setSelectedSubtitle(event.target.value);setAiSubtitleOverride(false)}}>
                  <option value="auto">{t("字幕：自动")}</option><option value="off">{t("关闭字幕")}</option>
                  {nativeSubtitleSidecars.map(track => <option key={track.id} value={track.id}>{track.label || track.language || track.format.toUpperCase()}</option>)}
                </select>}
                {embeddedSubtitles.data?.items.some(track => !track.supported) && <span title={t("图像字幕需 OCR，目前仅支持文本字幕")}>{t("含图像字幕")}</span>}
                {nativeSubtitleSidecars.length > 0 && (
                  <select aria-label={t("字幕编码")} className="player-rate-select" title={t("乱码时选择字幕编码")} value={subtitleEncoding} onChange={event => setSubtitleEncoding(event.target.value)}>
                    {[["auto", t("字幕编码：自动")], ["utf-8", "UTF-8"], ["utf-16le", "UTF-16 LE"], ["utf-16be", "UTF-16 BE"], ["gb18030", t("简体中文 GB18030")], ["big5", t("繁体中文 Big5")], ["shift_jis", t("日文 Shift JIS")], ["windows-1252", "Windows-1252"]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                )}
                {aiSubtitle && (
                  <button
                    aria-label={aiSubtitlesEnabled ? t("关闭 AI 字幕") : t("开启 AI 字幕")}
                    aria-pressed={aiSubtitlesEnabled}
                    className={`player-subtitle-toggle${aiSubtitlesEnabled ? " is-active" : ""}`}
                    onClick={() => setAiSubtitleOverride(!aiSubtitlesEnabled)}
                    title={aiSubtitlesEnabled
                      ? t("关闭 AI 生成的中文字幕")
                      : nativeChineseSubtitlePresent && aiSubtitleOverride === null
                        ? t("检测到视频自带中文字幕，AI 字幕已默认关闭；点击可重新开启")
                        : t("开启 AI 生成的中文字幕")}
                    type="button"
                  >
                    {aiSubtitlesEnabled ? <Captions size={18} /> : <CaptionsOff size={18} />}
                    <span>{t("AI 字幕")}</span>
                  </button>
                )}
              </>
            )}
            {!standaloneSource && <>
            <button
              aria-pressed={item.isFavorite}
              className={`player-favorite-button${item.isFavorite ? " is-active" : ""}`}
              type="button"
              onClick={() => onToggleFavorite?.(item, !item.isFavorite)}
              aria-label={item.isFavorite ? t("取消收藏") : t("收藏")}
              title={item.isFavorite ? t("取消收藏") : t("收藏")}
            >
              <Heart size={19} fill={item.isFavorite ? "currentColor" : "none"} />
            </button>
            </>}
            <button type="button" onClick={toggleFullscreen} aria-label={isFullscreen ? t("退出全屏") : t("全屏播放")} title={isFullscreen ? t("退出全屏") : t("全屏播放")}>
              {isFullscreen ? <Minimize2 size={19} /> : <Maximize2 size={19} />}
            </button>
            <button
              aria-controls="player-details-panel"
              aria-expanded={detailsExpanded}
              aria-label={detailsExpanded ? t("收起详情") : t("展开详情")}
              className="player-detail-toggle"
              onClick={() => setDetailsExpanded((current) => !current)}
              title={detailsExpanded ? t("收起详情") : t("展开详情")}
              type="button"
            >
              {detailsExpanded ? <ChevronUp size={19} /> : <ChevronDown size={19} />}
            </button>
            <button type="button" onClick={onClose} aria-label={t("关闭")} title={t("关闭播放器")}>
              <X size={20} />
            </button>
          </div>
        </div>
        <div className="player-viewport">
          <div
            className="player-stage"
            style={{ "--player-brightness": brightness } as CSSProperties}
          >
          {item.mediaType === "image" ? (
            <img src={streamUrl} alt={item.name} />
          ) : isVideoSourceUnavailable ? (
            <div className="player-source-offline" role="status">
              <HardDrive aria-hidden="true" size={34} />
              <strong>{t("视频源暂未连接")}</strong>
              <span>{t("当前仅展示固态硬盘中的馆藏索引、元数据和缓存图片")}</span>
            </div>
          ) : (
            <video
              key={`${item.id}:${streamUrl}`}
              ref={videoRef}
              src={useHlsEngine ? undefined : streamUrl}
              autoPlay
              loop={isLooping}
              poster={standaloneSource?.posterUrl}
              playsInline
              preload="auto"
              controlsList="nodownload"
              onEnded={(event) => reportProgress(event.currentTarget, "ended")}
              onError={(event) => {
                if (event.target === event.currentTarget) {
                  confirmPlaybackFailure(event.currentTarget, playbackMode);
                }
              }}
              onLoadedMetadata={(event) => {
                clearPlaybackErrorTimer();
                event.currentTarget.playbackRate = playbackRate;
                resumePlaybackPosition(event.currentTarget);
                syncPlaybackClock(event.currentTarget);
              }}
              onPause={(event) => {
                clearVideoFrameMonitor();
                setIsPlaying(false);
                reportProgress(event.currentTarget, "pause");
                syncPlaybackClock(event.currentTarget);
                revealProgressControls();
              }}
              onPlay={(event) => {
                clearPlaybackErrorTimer();
                setIsPlaying(true);
                reportProgress(event.currentTarget, "start");
                syncPlaybackClock(event.currentTarget);
                revealProgressControls();
              }}
              onPlaying={(event) => {
                setIsPlaying(true);
                monitorVideoFrames(event.currentTarget, playbackMode);
              }}
              onTimeUpdate={(event) => {
                reportProgress(event.currentTarget, "tick");
                syncPlaybackClock(event.currentTarget);
              }}
            >
              {nativeSubtitleSidecars.map((sidecar) => (
                  <track
                    default={(!aiSubtitle || !aiSubtitlesEnabled) && sidecar.id === activeNativeSubtitleId}
                    key={`${sidecar.id}:${sidecar.mtimeMs}:${subtitleEncoding}`}
                    kind="subtitles"
                    label={sidecar.label || sidecar.language || sidecar.format.toUpperCase()}
                    onLoad={() => {
                      const tracks = videoRef.current?.textTracks;
                      if (!tracks) return;
                      for (let index = 0; index < tracks.length; index += 1) {
                        tracks[index].mode = (!aiSubtitle || !aiSubtitlesEnabled) && index === nativeSelectedIndex ? "showing" : "disabled";
                      }
                    }}
                    src={`${subtitleTrackUrl(sidecar)}&encoding=${encodeURIComponent(subtitleEncoding)}`}
                    srcLang={sidecar.language || "und"}
                  />
                ))}
            </video>
          )}
          {item.mediaType === "video" && !isVideoSourceUnavailable && aiSubtitlesEnabled && activeSubtitleText && (
            <div className="player-subtitle-overlay" aria-live="off">
              {activeSubtitleText}
            </div>
          )}
          {item.mediaType === "video" && !isVideoSourceUnavailable && playbackStatus && (
            <div
              className={`player-playback-status${playbackStatus.error ? " is-error" : ""}`}
              role={playbackStatus.error ? "alert" : "status"}
            >
              {!playbackStatus.error && <span className="spin" />}
              {playbackStatus.message}
            </div>
          )}
          {item.mediaType === "video" && !isVideoSourceUnavailable && (
            <div
              className="player-gesture-layer"
              aria-label={t("播放器手势区域")}
              onDoubleClick={handleGestureDoubleClick}
              onPointerCancel={handlePointerCancel}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerEnd}
              role="presentation"
            />
          )}
          {item.mediaType === "video" && storyboard.data?.status === "ready" && storyboard.data.cues.length > 0 && (
            <div
              aria-label={t("视频时间轴预览")}
              className="player-storyboard-track"
              onClick={(event) => updateTimelinePreview(event.currentTarget, event.clientX, true)}
              onKeyDown={(event) => {
                const video = videoRef.current;
                if (!video || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
                event.preventDefault();
                video.currentTime = clamp(video.currentTime + (event.key === "ArrowRight" ? 15 : -15), 0, video.duration || 0);
                syncPlaybackClock(video);
              }}
              onPointerLeave={() => setTimelinePreview(null)}
              onPointerMove={(event) => updateTimelinePreview(event.currentTarget, event.clientX)}
              onPointerDown={(event) => event.stopPropagation()}
              role="slider"
              aria-valuemin={0}
              aria-valuemax={Math.round(storyboard.data.duration ?? item.durationSeconds ?? 0)}
              aria-valuenow={Math.round(playbackPosition)}
              aria-valuetext={formatPlaybackTime(playbackPosition)}
              tabIndex={0}
            >
              {timelinePreview && (
                <div
                  className="player-storyboard-preview"
                  style={{ left: `${clamp(timelinePreview.left, 15, 85)}%` }}
                >
                  <span
                    style={{
                      backgroundImage: `url(${storyboard.data.imageUrl})`,
                      backgroundPosition: `-${timelinePreview.cue.x}px -${timelinePreview.cue.y}px`,
                      height: storyboard.data.tileHeight,
                      width: storyboard.data.tileWidth
                    }}
                  />
                  <strong>{formatDuration(timelinePreview.time)}</strong>
                </div>
              )}
            </div>
          )}
            {gestureHint && <div className="gesture-hint">{gestureHint}</div>}
          </div>
          {item.mediaType === "video" && (
            <div
              aria-label={t("播放器操作栏")}
              className="player-control-dock"
              onPointerDown={(event) => {
                event.stopPropagation();
                revealProgressControls();
              }}
              onPointerMove={revealProgressControls}
            >
            <button
              aria-label={isPlaying ? t("暂停") : t("播放")}
              className="player-transport-button"
              onClick={togglePlayback}
              title={isPlaying ? t("暂停") : t("播放")}
              type="button"
            >
              {isPlaying ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <div className="player-control-timeline">
              <span>{formatPlaybackTime(progressValue)}</span>
              <input
                aria-label={t("播放进度")}
                aria-valuetext={`${formatPlaybackTime(progressValue)} / ${hasKnownProgressDuration ? formatDuration(progressDuration) : t("时长未知")}`}
                className="player-progress-range"
                disabled={!hasKnownProgressDuration}
                max={hasKnownProgressDuration ? progressDuration : 0}
                min={0}
                onChange={handleProgressChange}
                onFocus={revealProgressControls}
                onKeyDown={revealProgressControls}
                step={0.1}
                style={{ "--player-progress-percent": `${progressPercent}%` } as CSSProperties}
                type="range"
                value={progressValue}
              />
              <span>{hasKnownProgressDuration ? formatDuration(progressDuration) : t("时长未知")}</span>
            </div>
            <button
              aria-label={isMuted ? t("取消静音") : t("静音")}
              className="player-transport-button"
              onClick={toggleMuted}
              title={isMuted ? t("取消静音") : t("静音")}
              type="button"
            >
              {isMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>
            {!standaloneSource && <>
            <div
              className={`player-playback-mode-control${playbackPreparation ? " is-preparing" : ""}`}
              title={t("播放方式：{{p0}}", { p0: t(PLAYBACK_MODE_LABELS[playbackMode]) })}
            >
              {playbackPreparation ? <span aria-hidden="true" className="spin" /> : <Settings2 aria-hidden="true" size={17} />}
              <span className="player-playback-mode-label">
                {playbackPreparation ? t("准备中") : t(PLAYBACK_MODE_LABELS[playbackMode])}
              </span>
              <ChevronDown aria-hidden="true" className="player-playback-mode-chevron" size={13} />
              <select
                aria-label={t("切换播放方式，当前为{{p0}}", { p0: t(PLAYBACK_MODE_LABELS[playbackMode]) })}
                onChange={(event) => handleManualPlaybackMode(event.target.value as PlaybackMode)}
                value={playbackMode}
              >
                {playbackModeOptions.map((option) => (
                  <option disabled={option.disabled} key={option.key} value={option.key}>
                    {option.title} · {option.description}
                  </option>
                ))}
              </select>
            </div>
            </>}
            {standaloneSource && <nav className="highlight-playback-navigation" aria-label={t("高光切换")}>
              <button className="player-transport-button" type="button" aria-label={t("上一段高光")} disabled={!onPrevious} onClick={onPrevious}><ChevronLeft size={19}/></button>
              <button className="player-transport-button" type="button" aria-label={isLooping ? t("关闭循环播放") : t("开启循环播放")} aria-pressed={isLooping} title={isLooping ? t("循环播放已开启") : t("循环播放已关闭")} onClick={() => setIsLooping(value => !value)}><Repeat size={19}/></button>
              <button className="player-transport-button" type="button" aria-label={t("下一段高光")} disabled={!onNext} onClick={onNext}><ChevronRight size={19}/></button>
            </nav>}
            </div>
          )}
        </div>
        {highlightOpen && <HighlightEditor key={item.id} mediaId={item.id} sourceTitle={item.normalizedCode || item.basename} position={playbackPosition} duration={progressDuration} onClose={() => setHighlightOpen(false)} onSeek={time => { const video = videoRef.current; if (video) { video.currentTime = time; syncPlaybackClock(video); } }}/>}
        {detailsExpanded && <div className="player-details" id="player-details-panel">
          <div className="player-basic-tags">
            <span>{item.libraryCategory}</span>
            <span>{item.sourceName}</span>
            <span>{item.extension.toUpperCase()}</span>
            {!standaloneSource && <span>{formatBytes(item.size)}</span>}
            <span>{formatDate(item.mtimeMs)}</span>
            {item.codePrefix && <span>{item.codePrefix}</span>}
            {tags.map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>
          {metadata ? (
            <div className="player-metadata">
              {metadataFacts.length > 0 && (
                <dl className="player-metadata-facts">
                  {metadataFacts.map((fact) => (
                    <div key={fact.label}>
                      <dt>{fact.label}</dt>
                      <dd>{fact.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {displayMetadata && displayMetadata.genres.length > 0 && (
                <div className="player-genre-row">
                  {displayMetadata.genres.slice(0, 10).map((genre) => (
                    <span key={genre}>{genre}</span>
                  ))}
                </div>
              )}
              {displayMetadata?.summary && <p className="player-summary">{displayMetadata.summary}</p>}
              {metadata.homepage && (
                <a className="player-homepage" href={metadata.homepage} target="_blank" rel="noreferrer">
                  {t("查看资料来源")} </a>
              )}
            </div>
          ) : (
            <div className="player-metadata player-metadata-empty">
              {standaloneSource ? t("独立高光片段 · {{p0}}", { p0: formatDuration(item.durationSeconds ?? 0) }) : item.metadata?.status === "fetching" ? t("正在补全元数据") : t("元数据待补全")}
            </div>
          )}
        </div>}
      </div>
    </div>
  );
}
