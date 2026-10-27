import type { MediaItem, MediaMetadata } from "./api";

export type MetadataLanguage = "zh" | "ja";

export type DisplayMetadata = {
  title: string;
  summary: string;
  director: string;
  actors: string[];
  genres: string[];
  maker: string;
  label: string;
  series: string;
};

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  return values.find((value) => value && value.trim())?.trim() ?? "";
}

function firstNonEmptyArray(primary: string[] | undefined, fallback: string[]): string[] {
  return primary && primary.length > 0 ? primary : fallback;
}

export function getDisplayMetadata(metadata: MediaMetadata, language: MetadataLanguage): DisplayMetadata {
  if (language === "ja") {
    return {
      title: metadata.title,
      summary: metadata.summary ?? "",
      director: metadata.director ?? "",
      actors: metadata.actors,
      genres: metadata.genres,
      maker: metadata.maker ?? "",
      label: metadata.label ?? "",
      series: metadata.series ?? ""
    };
  }

  return {
    title: firstNonEmpty(metadata.titleZh, metadata.title),
    summary: firstNonEmpty(metadata.summaryZh, metadata.summary),
    director: firstNonEmpty(metadata.directorZh, metadata.director),
    actors: firstNonEmptyArray(metadata.actorsZh, metadata.actors),
    genres: firstNonEmptyArray(metadata.genresZh, metadata.genres),
    maker: firstNonEmpty(metadata.makerZh, metadata.maker),
    label: firstNonEmpty(metadata.labelZh, metadata.label),
    series: firstNonEmpty(metadata.seriesZh, metadata.series)
  };
}

export function getMediaDisplayTitle(item: MediaItem, language: MetadataLanguage): string {
  const metadata = item.metadata?.status === "ready" ? item.metadata : null;
  const title = metadata ? getDisplayMetadata(metadata, language).title : "";

  return item.normalizedCode ? [item.normalizedCode, title].filter(Boolean).join(" ") : title || item.basename;
}
