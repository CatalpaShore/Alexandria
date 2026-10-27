import { useQuery } from "@tanstack/react-query";
import { requestJson } from "../../lib/http";

export type DemoFilm = {
  slug: string; title: string; year: number; director: string; actors: string[];
  tags: string[]; collection: string; summary: string; source: string; mediaId: string | null;
  favorite: boolean; completed: boolean; lastPlayedAt: string;
  artwork: { file: string; license: string; licenseUrl: string; attribution: string; changes: string };
};
export function useDemoFilms(enabled: boolean) {
  return useQuery({ queryKey: ["demo-film-catalog"], queryFn: () => requestJson<{ films: DemoFilm[] }>("/api/demo/catalog"), enabled, staleTime: 60_000, retry: false });
}
