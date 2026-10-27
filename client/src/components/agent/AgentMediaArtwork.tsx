import { useQuery } from "@tanstack/react-query";
import { Clapperboard } from "lucide-react";
import { useState } from "react";
import type { AgentCitation } from "../../features/agent/api";
import { getPosterUrl, getThumbnailUrl } from "../../lib/api";
import { fetchContentPreview } from "../../lib/contentPreviewApi";
import { PosterImage } from "../PosterImage";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function formatPreviewTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.round(seconds));
  return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, "0")}`;
}

export function AgentMediaArtwork({
  active,
  citation,
  citationNumber,
  showMotionPreview = true
}: {
  active: boolean;
  citation: AgentCitation;
  citationNumber: number;
  showMotionPreview?: boolean;
}) {
  const [motionLoaded, setMotionLoaded] = useState(false);
  const isDemo = citation.mediaId.startsWith("curator-demo-");
  const reduceMotion = prefersReducedMotion();
  const previewQuery = useQuery({
    enabled: !isDemo && active && showMotionPreview && !reduceMotion,
    queryKey: ["content-preview", citation.mediaId],
    queryFn: () => fetchContentPreview(citation.mediaId),
    retry: 1,
    staleTime: 10 * 60_000
  });
  const gifs = previewQuery.data?.status === "ready" ? previewQuery.data.gifs : [];
  const gif = gifs.length ? gifs[(citationNumber - 1) % gifs.length] : null;

  return (
    <span className={`agent-recommendation-poster${active && motionLoaded ? " has-motion-preview" : ""}`}>
      <PosterImage
        alt=""
        loading="lazy"
        onError={(event) => {
          if (isDemo) return;
          const fallback = getThumbnailUrl(citation.mediaId);
          if (event.currentTarget.src.endsWith(fallback)) return;
          event.currentTarget.src = fallback;
        }}
        src={isDemo ? `/demo/poster-${String(citationNumber).padStart(2, "0")}.svg` : getPosterUrl(citation.mediaId)}
      />
      {active && gif && !reduceMotion && (
        <img
          alt=""
          aria-hidden="true"
          className="agent-recommendation-motion"
          decoding="async"
          onError={() => setMotionLoaded(false)}
          onLoad={() => setMotionLoaded(true)}
          src={gif.url}
        />
      )}
      <span className="agent-recommendation-number">[{citationNumber}]</span>
      {active && motionLoaded && gif && (
        <span className="agent-recommendation-motion-label"><Clapperboard size={9} />GIF · {formatPreviewTime(gif.timeSeconds)}</span>
      )}
    </span>
  );
}
