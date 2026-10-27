import type { MediaQuery } from "./api";
import { requestJson } from "./http";

export type PlaylistKind = "manual" | "smart";

export type Playlist = {
  id: string;
  name: string;
  description: string;
  kind: PlaylistKind;
  query: Partial<MediaQuery>;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
};

export type PlaylistItem = {
  id: string;
  normalizedCode: string;
  basename: string;
  relativePath: string;
  durationSeconds: number | null;
  title: string;
  position: number;
  addedAt: string;
};

export type MediaPlaylistAssignment = Playlist & {
  containsMedia: boolean;
};

export type CreatePlaylistInput = {
  name: string;
  description?: string;
  kind: PlaylistKind;
  query?: Partial<MediaQuery>;
  mediaIds?: string[];
};

export function fetchPlaylists(): Promise<{ items: Playlist[] }> {
  return requestJson<{ items: Playlist[] }>("/api/playlists", { cache: "no-store" });
}

export function createPlaylist(input: CreatePlaylistInput): Promise<Playlist> {
  return requestJson<Playlist>("/api/playlists", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: input.name,
      description: input.description ?? "",
      kind: input.kind,
      query: input.query ?? {},
      mediaIds: input.mediaIds ?? []
    })
  });
}

export function deletePlaylist(id: string): Promise<void> {
  return requestJson<void>(`/api/playlists/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function fetchPlaylistItems(id: string): Promise<{ playlist: Playlist; items: PlaylistItem[] }> {
  return requestJson<{ playlist: Playlist; items: PlaylistItem[] }>(
    `/api/playlists/${encodeURIComponent(id)}/items`,
    { cache: "no-store" }
  );
}

export function updatePlaylistItem(id: string, mediaId: string, favorite = true): Promise<Playlist> {
  return requestJson<Playlist>(`/api/playlists/${encodeURIComponent(id)}/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mediaId, favorite })
  });
}

export function fetchMediaPlaylistAssignments(mediaId: string): Promise<{ items: MediaPlaylistAssignment[] }> {
  return requestJson<{ items: MediaPlaylistAssignment[] }>(
    `/api/media/${encodeURIComponent(mediaId)}/playlists`,
    { cache: "no-store" }
  );
}

export function updateMediaPlaylistAssignments(
  mediaId: string,
  playlistIds: string[]
): Promise<{ items: MediaPlaylistAssignment[] }> {
  return requestJson<{ items: MediaPlaylistAssignment[] }>(
    `/api/media/${encodeURIComponent(mediaId)}/playlists`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playlistIds })
    }
  );
}

export function reorderPlaylistItems(id: string, mediaIds: string[]): Promise<Playlist> {
  return requestJson<Playlist>(`/api/playlists/${encodeURIComponent(id)}/items/order`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mediaIds })
  });
}
