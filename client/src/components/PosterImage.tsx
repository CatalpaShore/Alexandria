import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ImgHTMLAttributes, type SyntheticEvent } from "react";

type PosterImageProps = ImgHTMLAttributes<HTMLImageElement>;

const PLACEHOLDER_RETRY_DELAYS = [1_200, 2_400, 4_800] as const;

function withRetryToken(src: PosterImageProps["src"], attempt: number): PosterImageProps["src"] {
  if (!src || attempt === 0 || !src.startsWith("/api/media/")) return src;
  const separator = src.includes("?") ? "&" : "?";
  return `${src}${separator}posterRetry=${attempt}`;
}

function isGeneratedPlaceholder(image: HTMLImageElement): boolean {
  return image.currentSrc.includes("/api/media/") && image.naturalWidth === 640 && image.naturalHeight === 400;
}

function updateOrientation(image: HTMLImageElement): void {
  if (!image.naturalWidth || !image.naturalHeight) return;
  image.dataset.orientation = image.naturalHeight > image.naturalWidth ? "portrait" : "landscape";
}

export function PosterImage({ className, onLoad, src, ...props }: PosterImageProps) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const retrySrc = useMemo(() => withRetryToken(src, retryAttempt), [retryAttempt, src]);

  useEffect(() => {
    setRetryAttempt(0);
    if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    return () => {
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
    };
  }, [src]);

  useLayoutEffect(() => {
    const image = imageRef.current;
    if (!image) return;
    delete image.dataset.orientation;
    if (image.complete) updateOrientation(image);
  }, [retrySrc]);

  const handleLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    updateOrientation(event.currentTarget);
    if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    if (isGeneratedPlaceholder(event.currentTarget) && retryAttempt < PLACEHOLDER_RETRY_DELAYS.length) {
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null;
        setRetryAttempt((current) => Math.min(current + 1, PLACEHOLDER_RETRY_DELAYS.length));
      }, PLACEHOLDER_RETRY_DELAYS[retryAttempt]);
    }
    onLoad?.(event);
  };

  return (
    <img
      {...props}
      className={["poster-image", className].filter(Boolean).join(" ")}
      onLoad={handleLoad}
      ref={imageRef}
      src={retrySrc}
    />
  );
}
