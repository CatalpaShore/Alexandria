import { requestJson } from "./http";

export type StoryboardCue = {
  start: number;
  end: number;
  x: number;
  y: number;
};

export type StoryboardResponse = {
  mediaId: string;
  status: "missing" | "pending" | "ready" | "failed";
  imageUrl: string;
  frameCount?: number;
  intervalSeconds?: number;
  columns?: number;
  tileWidth?: number;
  tileHeight?: number;
  duration?: number;
  cues: StoryboardCue[];
  error?: string | null;
};

export type ReadinessResponse = {
  mediaId: string;
  probeStatus: string;
  compatibilityStatus: string;
  recommendedAction: "probe" | "remux" | "hls" | null;
  sourceAvailable: boolean;
  playbackReady: boolean;
  preferred: "source" | "remux" | "hls";
  remuxReady: boolean;
  hlsReady: boolean;
  derivatives: Record<"remux" | "hls", {
    status: "missing" | "pending" | "ready" | "failed";
    failureReason: "source_unavailable" | "ffmpeg_unavailable" | "preparation_failed" | null;
  }>;
  storyboard: StoryboardResponse | null;
};

export type ExternalPlayerResponse = {
  mediaId: string;
  streamUrl: string;
  links: { vlc: string; infuse: string };
};

export function fetchReadiness(id: string): Promise<ReadinessResponse> {
  return requestJson(`/api/media/${id}/readiness`);
}

export function prepareReadiness(id: string, options: { playback: boolean; storyboard: boolean }): Promise<{ jobs: string[]; readiness: ReadinessResponse }> {
  return requestJson(`/api/media/${id}/readiness`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options)
  });
}

export function fetchStoryboard(id: string): Promise<StoryboardResponse> {
  return requestJson(`/api/media/${id}/storyboard`);
}

export function fetchExternalPlayerLinks(id: string): Promise<ExternalPlayerResponse> {
  return requestJson(`/api/media/${id}/external-player`);
}
