import { requestJson } from "./http";

export type ContentPreviewAsset = {
  key: string;
  kind: "photo" | "gif";
  timeSeconds: number;
  startSeconds: number;
  durationSeconds: number;
  width: number;
  bytes: number;
  url: string;
};

export type ContentPreviewResponse = {
  mediaId: string;
  storageAvailable: boolean;
  status: "unavailable" | "missing" | "pending" | "ready" | "failed" | "stale";
  photos: ContentPreviewAsset[];
  gifs: ContentPreviewAsset[];
  totalBytes: number;
  generatedAt: string | null;
  fallbackShort: boolean;
  error: string | null;
};

export function fetchContentPreview(mediaId: string): Promise<ContentPreviewResponse> {
  return requestJson(`/api/media/${mediaId}/content-preview`);
}

export function requestContentPreview(mediaId: string): Promise<{ jobId: string; preview: ContentPreviewResponse }> {
  return requestJson(`/api/media/${mediaId}/content-preview`, { method: "POST" });
}
