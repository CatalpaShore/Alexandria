import { getIntlLocale } from "../i18n/core";
import { t, useLocale } from "../i18n";
import { Spin, Tag, Typography } from "antd";
import { Heart, Image, LayoutGrid, MonitorPlay, Play } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import {
  formatBytes,
  formatDuration,
  getPosterUrl,
  getStreamUrl,
  type MediaItem
} from "../lib/api";
import { getMediaDisplayTitle, type MetadataLanguage } from "../lib/metadataDisplay";

type MobileReelProps = {
  items: MediaItem[];
  total: number;
  loaded: number;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  metadataLanguage: MetadataLanguage;
  onOpen: (item: MediaItem) => void;
  onExitReel?: () => void;
  onToggleFavorite?: (item: MediaItem, favorite: boolean) => void;
  onLoadMore: () => void;
};

const REEL_START_SECONDS = 600;
const REEL_SEEK_RANGE_SECONDS = 300;
const DOUBLE_TAP_WINDOW_MS = 320;
const DOUBLE_TAP_DISTANCE_PX = 42;
const MAX_REEL_PLAY_ATTEMPTS = 5;

type DragState = {
  pointerId: number;
  itemId: string;
  startX: number;
  startY: number;
  baseTime: number;
  width: number;
  isSeeking: boolean;
};

type TapState = {
  itemId: string;
  at: number;
  x: number;
  y: number;
};

type FastSeekVideo = HTMLVideoElement & {
  fastSeek?: (time: number) => void;
};

type FrameAwareVideo = HTMLVideoElement & {
  cancelVideoFrameCallback?: (handle: number) => void;
  requestVideoFrameCallback?: (callback: () => void) => number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getReelStartTime(duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) return REEL_START_SECONDS;
  if (duration > REEL_START_SECONDS + 30) return REEL_START_SECONDS;
  return Math.max(0, duration * 0.35);
}

function seekVideo(video: HTMLVideoElement, time: number) {
  const fastSeekVideo = video as FastSeekVideo;
  if (typeof fastSeekVideo.fastSeek === "function") {
    fastSeekVideo.fastSeek(time);
    return;
  }

  video.currentTime = time;
}

export function MobileReel({
  items,
  total,
  loaded,
  isFetchingNextPage,
  hasNextPage,
  metadataLanguage,
  onOpen,
  onExitReel,
  onToggleFavorite,
  onLoadMore
}: MobileReelProps) {
  useLocale();
  const reelRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const videoRefs = useRef(new Map<string, HTMLVideoElement>());
  const preparedVideosRef = useRef(new Set<string>());
  const playRetryTimersRef = useRef(new Map<string, number>());
  const frameCallbackRefs = useRef(new Map<string, number>());
  const frameFailureTimersRef = useRef(new Map<string, number>());
  const dragRef = useRef<DragState | null>(null);
  const lastTapRef = useRef<TapState | null>(null);
  const hintTimerRef = useRef<number | null>(null);
  const visibilityRatiosRef = useRef(new Map<string, number>());
  const preloadPairRef = useRef("");
  const [activeId, setActiveId] = useState(items[0]?.id ?? "");
  const activeIdRef = useRef(activeId);
  const [gestureHint, setGestureHint] = useState<string | null>(null);
  const [frameReadyIds, setFrameReadyIds] = useState(() => new Set<string>());
  const [visualFailureIds, setVisualFailureIds] = useState(() => new Set<string>());
  const activeIndex = items.findIndex((item) => item.id === activeId);

  function showGestureHint(message: string) {
    setGestureHint(message);
    if (hintTimerRef.current) {
      window.clearTimeout(hintTimerRef.current);
    }
    hintTimerRef.current = window.setTimeout(() => setGestureHint(null), 760);
  }

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const clearPlayRetry = useCallback((itemId: string) => {
    const timer = playRetryTimersRef.current.get(itemId);
    if (timer == null) return;
    window.clearTimeout(timer);
    playRetryTimersRef.current.delete(itemId);
  }, []);

  const clearFrameWatch = useCallback((itemId: string) => {
    const video = videoRefs.current.get(itemId) as FrameAwareVideo | undefined;
    const callbackHandle = frameCallbackRefs.current.get(itemId);
    if (callbackHandle != null) video?.cancelVideoFrameCallback?.(callbackHandle);
    frameCallbackRefs.current.delete(itemId);
    const failureTimer = frameFailureTimersRef.current.get(itemId);
    if (failureTimer != null) window.clearInterval(failureTimer);
    frameFailureTimersRef.current.delete(itemId);
  }, []);

  const monitorReelVideoFrame = useCallback((item: MediaItem, video: HTMLVideoElement) => {
    clearFrameWatch(item.id);
    const frameVideo = video as FrameAwareVideo;
    const markReady = () => {
      clearFrameWatch(item.id);
      video.removeAttribute("poster");
      setFrameReadyIds((current) => {
        if (current.has(item.id)) return current;
        const next = new Set(current);
        next.add(item.id);
        return next;
      });
      setVisualFailureIds((current) => {
        if (!current.has(item.id)) return current;
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
    };

    if (!frameVideo.requestVideoFrameCallback) {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0) {
        markReady();
      }
      return;
    }

    const startTime = video.currentTime;
    const startedAt = window.performance.now();
    const callbackHandle = frameVideo.requestVideoFrameCallback(markReady);
    frameCallbackRefs.current.set(item.id, callbackHandle);
    const failureTimer = window.setInterval(() => {
      if (activeIdRef.current !== item.id || video.ended) {
        clearFrameWatch(item.id);
        return;
      }
      if (
        video.paused
        || video.currentTime - startTime < 1.5
        || window.performance.now() - startedAt < 6_000
      ) return;
      clearFrameWatch(item.id);
      video.pause();
      setVisualFailureIds((current) => new Set(current).add(item.id));
      showGestureHint("当前视频需要兼容播放");
    }, 1_500);
    frameFailureTimersRef.current.set(item.id, failureTimer);
  }, [clearFrameWatch]);

  const preloadNextVideo = useCallback((activeItemId: string) => {
    const itemIndex = items.findIndex((item) => item.id === activeItemId);
    const nextItem = itemIndex >= 0 ? items[itemIndex + 1] : undefined;
    if (!nextItem || nextItem.mediaType !== "video") return;

    const pairKey = `${activeItemId}:${nextItem.id}`;
    if (preloadPairRef.current === pairKey) return;

    const nextVideo = videoRefs.current.get(nextItem.id);
    if (!nextVideo || !nextVideo.getAttribute("src")) return;

    preloadPairRef.current = pairKey;
    nextVideo.muted = true;
    nextVideo.playsInline = true;
    nextVideo.preload = "auto";
    nextVideo.load();
  }, [items]);

  const prepareVideo = useCallback((item: MediaItem, video: HTMLVideoElement, force = false) => {
    if ((!force && preparedVideosRef.current.has(item.id)) || video.readyState < 1) return false;

    const startTime = getReelStartTime(video.duration);
    try {
      if (Math.abs(video.currentTime - startTime) > 1.5) {
        seekVideo(video, startTime);
      }
      preparedVideosRef.current.add(item.id);
      return true;
    } catch {
      return false;
    }
  }, []);

  const requestActivePlayback = useCallback(
    (item: MediaItem, video: HTMLVideoElement, attempt = 0) => {
      clearPlayRetry(item.id);
      if (activeIdRef.current !== item.id) return;

      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";

      const run = () => {
        if (activeIdRef.current !== item.id) return;
        video
          .play()
          .then(() => preloadNextVideo(item.id))
          .catch(() => {
            if (attempt >= MAX_REEL_PLAY_ATTEMPTS) return;
            const timer = window.setTimeout(
              () => requestActivePlayback(item, video, attempt + 1),
              360 + attempt * 260
            );
            playRetryTimersRef.current.set(item.id, timer);
          });
      };

      if (video.readyState >= 2) {
        run();
        return;
      }

      const timer = window.setTimeout(run, 220);
      playRetryTimersRef.current.set(item.id, timer);
    },
    [clearPlayRetry, preloadNextVideo]
  );

  const playActiveVideo = useCallback((item: MediaItem, video: HTMLVideoElement) => {
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";

    if (video.readyState >= 1) {
      prepareVideo(item, video);
    } else {
      video.load();
    }

    requestActivePlayback(item, video);
  }, [prepareVideo, requestActivePlayback]);

  function favoriteFromGesture(item: MediaItem) {
    if (!item.isFavorite) {
      onToggleFavorite?.(item, true);
    }
    showGestureHint(t("已收藏"));
  }

  function getVideo(item: MediaItem) {
    return videoRefs.current.get(item.id) ?? null;
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>, item: MediaItem) {
    const video = getVideo(item);
    if (!video || video.readyState < 1) return;

    dragRef.current = {
      pointerId: event.pointerId,
      itemId: item.id,
      startX: event.clientX,
      startY: event.clientY,
      baseTime: video.currentTime,
      width: Math.max(1, event.currentTarget.clientWidth),
      isSeeking: false
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>, item: MediaItem) {
    const drag = dragRef.current;
    const video = getVideo(item);

    if (!drag || drag.pointerId !== event.pointerId || drag.itemId !== item.id || !video) return;

    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    const horizontal = Math.abs(deltaX) > 18 && Math.abs(deltaX) > Math.abs(deltaY) + 8;

    if (!drag.isSeeking && horizontal) {
      drag.isSeeking = true;
    }

    if (!drag.isSeeking) return;

    event.preventDefault();
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const nextTime = clamp(
      drag.baseTime + (deltaX / drag.width) * REEL_SEEK_RANGE_SECONDS,
      0,
      Math.max(0, duration)
    );

    try {
      video.currentTime = nextTime;
      showGestureHint(formatDuration(nextTime));
    } catch {
      // Ignore transient seek errors while the browser is still buffering metadata.
    }
  }

  function handlePointerEnd(event: ReactPointerEvent<HTMLDivElement>, item: MediaItem) {
    const drag = dragRef.current;

    if (drag && drag.pointerId === event.pointerId) {
      const didSeek = drag.isSeeking;
      dragRef.current = null;

      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // The pointer may already have been released by the browser.
      }

      if (didSeek) {
        const video = getVideo(item);
        if (video) {
          video.play().catch(() => undefined);
        }
        return;
      }
    }

    const now = window.performance.now();
    const lastTap = lastTapRef.current;

    if (
      lastTap &&
      lastTap.itemId === item.id &&
      now - lastTap.at <= DOUBLE_TAP_WINDOW_MS &&
      Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) <= DOUBLE_TAP_DISTANCE_PX
    ) {
      lastTapRef.current = null;
      favoriteFromGesture(item);
      return;
    }

    lastTapRef.current = {
      itemId: item.id,
      at: now,
      x: event.clientX,
      y: event.clientY
    };
  }

  function handlePointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
    }

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The pointer may already have been released by the browser.
    }
  }

  function handleDoubleClick(event: ReactMouseEvent<HTMLDivElement>, item: MediaItem) {
    event.preventDefault();
    favoriteFromGesture(item);
  }

  useEffect(() => {
    if (!items.some((item) => item.id === activeId)) {
      setActiveId(items[0]?.id ?? "");
    }
  }, [activeId, items]);

  useEffect(() => {
    const reelRoot = reelRef.current;
    if (!reelRoot) return;
    const activeRoot = reelRoot;

    const visibilityRatios = visibilityRatiosRef.current;
    let scrollFrame = 0;

    function activateItem(id: string) {
      if (!id || activeIdRef.current === id) return;
      activeIdRef.current = id;
      setActiveId(id);
    }

    function activateMostVisibleItem() {
      let bestId = "";
      let bestRatio = 0;

      for (const [id, ratio] of visibilityRatios.entries()) {
        if (ratio <= bestRatio) continue;
        bestId = id;
        bestRatio = ratio;
      }

      if (bestId && bestRatio >= 0.42) {
        activateItem(bestId);
      }
    }

    function activateClosestItem() {
      const rootRect = activeRoot.getBoundingClientRect();
      const rootCenter = rootRect.top + rootRect.height / 2;
      let bestId = "";
      let bestDistance = Number.POSITIVE_INFINITY;

      activeRoot.querySelectorAll<HTMLElement>(".reel-item").forEach((node) => {
        const rect = node.getBoundingClientRect();
        const overlap = Math.min(rect.bottom, rootRect.bottom) - Math.max(rect.top, rootRect.top);
        if (overlap <= 0) return;

        const distance = Math.abs(rect.top + rect.height / 2 - rootCenter);
        if (distance >= bestDistance) return;
        bestDistance = distance;
        bestId = node.dataset.id ?? "";
      });

      activateItem(bestId);
    }

    function handleScroll() {
      window.cancelAnimationFrame(scrollFrame);
      scrollFrame = window.requestAnimationFrame(activateClosestItem);
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.getAttribute("data-id");
          if (id) {
            visibilityRatios.set(id, entry.isIntersecting ? entry.intersectionRatio : 0);
          }
        }

        activateMostVisibleItem();
      },
      { root: activeRoot, threshold: [0, 0.25, 0.42, 0.58, 0.74, 0.9, 1] }
    );

    activeRoot.querySelectorAll<HTMLElement>(".reel-item").forEach((node) => observer.observe(node));
    activeRoot.addEventListener("scroll", handleScroll, { passive: true });
    activateClosestItem();

    return () => {
      observer.disconnect();
      activeRoot.removeEventListener("scroll", handleScroll);
      window.cancelAnimationFrame(scrollFrame);
      visibilityRatios.clear();
    };
  }, [items]);

  useEffect(() => {
    for (const [id, video] of videoRefs.current.entries()) {
      if (id === activeId) {
        const item = items.find((candidate) => candidate.id === id);
        if (item) {
          playActiveVideo(item, video);
        }
      } else {
        clearPlayRetry(id);
        clearFrameWatch(id);
        video.pause();
      }
    }
  }, [activeId, clearFrameWatch, clearPlayRetry, items, playActiveVideo]);

  useEffect(() => {
    const playRetryTimers = playRetryTimersRef.current;
    return () => {
      if (hintTimerRef.current) {
        window.clearTimeout(hintTimerRef.current);
      }
      for (const timer of playRetryTimers.values()) {
        window.clearTimeout(timer);
      }
      playRetryTimers.clear();
      for (const item of items) clearFrameWatch(item.id);
    };
  }, [clearFrameWatch, items]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = reelRef.current;
    if (!sentinel || !root || !hasNextPage) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage) {
          onLoadMore();
        }
      },
      { root, rootMargin: "800px 0px" }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, onLoadMore]);

  return (
    <section className="mobile-reel-shell" aria-label="竖向刷视频">
      <div className="reel-status" aria-hidden="true">
        <Typography.Text strong>{total.toLocaleString(getIntlLocale())} {t("个文件")}</Typography.Text>
        <Typography.Text type="secondary">
          {t("已加载")} {loaded.toLocaleString(getIntlLocale())}
        </Typography.Text>
      </div>
      <div className="mobile-reel" ref={reelRef}>
        {onExitReel && (
          <button className="reel-exit-button" onClick={onExitReel} type="button">
            <LayoutGrid size={16} />
            双列
          </button>
        )}
        {gestureHint && <div className="reel-gesture-hint">{gestureHint}</div>}
        {items.map((item, index) => {
          const title = getMediaDisplayTitle(item, metadataLanguage);
          const isVideo = item.mediaType === "video";
          const distanceFromActive = activeIndex >= 0 ? Math.abs(index - activeIndex) : 0;
          const shouldAttachVideo = distanceFromActive <= 1;

          return (
            <article className="reel-item" data-id={item.id} key={item.id}>
              <div className="reel-media">
                {isVideo ? (
                  <video
                    autoPlay={item.id === activeId}
                    loop
                    muted
                    playsInline
                    poster={frameReadyIds.has(item.id) ? undefined : getPosterUrl(item.id, "detail")}
                    preload={item.id === activeId ? "auto" : shouldAttachVideo ? "metadata" : "none"}
                    onCanPlay={(event) => {
                      if (item.id === activeId) {
                        requestActivePlayback(item, event.currentTarget);
                      }
                    }}
                    onLoadedData={(event) => {
                      if (item.id === activeId) {
                        requestActivePlayback(item, event.currentTarget);
                      }
                    }}
                    onLoadedMetadata={(event) => {
                      if (item.id === activeId) {
                        prepareVideo(item, event.currentTarget, true);
                        playActiveVideo(item, event.currentTarget);
                      }
                    }}
                    onSeeked={(event) => {
                      if (item.id === activeId) {
                        requestActivePlayback(item, event.currentTarget);
                      }
                    }}
                    onPlaying={(event) => {
                      if (item.id === activeId) {
                        monitorReelVideoFrame(item, event.currentTarget);
                        preloadNextVideo(item.id);
                      }
                    }}
                    ref={(node) => {
                      if (node) {
                        videoRefs.current.set(item.id, node);
                      } else {
                        videoRefs.current.delete(item.id);
                      }
                    }}
                    src={shouldAttachVideo ? getStreamUrl(item.id) : undefined}
                  />
                ) : (
                  <img src={getPosterUrl(item.id, "detail")} alt="" loading="lazy" />
                )}
                {isVideo && visualFailureIds.has(item.id) && (
                  <button
                    className="reel-compatibility-button"
                    onClick={() => onOpen(item)}
                    type="button"
                  >
                    <MonitorPlay size={18} />
                    兼容播放
                  </button>
                )}
                <div
                  aria-label={`${title} 手势层`}
                  className="reel-gesture-layer"
                  onDoubleClick={(event) => handleDoubleClick(event, item)}
                  onPointerCancel={handlePointerCancel}
                  onPointerDown={(event) => handlePointerDown(event, item)}
                  onPointerMove={(event) => handlePointerMove(event, item)}
                  onPointerUp={(event) => handlePointerEnd(event, item)}
                  role="presentation"
                />
                <div className="reel-right-rail">
                  <button
                    aria-pressed={item.isFavorite}
                    aria-label={item.isFavorite ? t("取消收藏") : t("收藏")}
                    className={`favorite-button reel-favorite-button${item.isFavorite ? " is-active" : ""}`}
                    onClick={() => onToggleFavorite?.(item, !item.isFavorite)}
                    title={item.isFavorite ? t("取消收藏") : t("收藏")}
                    type="button"
                  >
                    <Heart size={21} fill={item.isFavorite ? "currentColor" : "none"} />
                  </button>
                  <button
                    aria-label="打开播放器"
                    className="reel-play-button"
                    onClick={() => onOpen(item)}
                    title="打开播放器"
                    type="button"
                  >
                    {isVideo ? <Play size={18} fill="currentColor" /> : <Image size={18} />}
                  </button>
                </div>
                <div className="reel-caption">
                  <strong title={item.name}>{title}</strong>
                  <div>
                    <Tag>{formatBytes(item.size)}</Tag>
                    <Tag>{formatDuration(item.durationSeconds)}</Tag>
                    <Tag>{item.libraryCategory}</Tag>
                  </div>
                </div>
              </div>
            </article>
          );
        })}
        <div className="reel-sentinel" ref={sentinelRef}>
          {isFetchingNextPage && (
            <span>
              <Spin size="small" /> {t("正在加载更多")} </span>
          )}
          {!hasNextPage && loaded > 0 && <Typography.Text>{t("已经到底了")}</Typography.Text>}
        </div>
      </div>
    </section>
  );
}
