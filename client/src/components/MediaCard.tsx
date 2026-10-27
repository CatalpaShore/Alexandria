import { t, useLocale, useLocalizedMemo } from "../i18n";
import { Card, Tag, Typography } from "antd";
import { Heart, Play } from "lucide-react";
import { memo } from "react";
import { formatBytes, formatDuration, getPosterUrl, getThumbnailUrl, type MediaItem } from "../lib/api";
import { selectVisibleCardTagIndexes } from "../lib/mediaWallLayout";
import { getDisplayMetadata, type MetadataLanguage } from "../lib/metadataDisplay";
import { PosterImage } from "./PosterImage";

type MediaCardProps = {
  item: MediaItem;
  metadataLanguage: MetadataLanguage;
  onOpen: (item: MediaItem) => void;
  onPlay?: (item: MediaItem) => void;
  onToggleFavorite?: (item: MediaItem, favorite: boolean) => void;
  visibleTagLimit: number;
};

type CardTagItem = {
  key: string;
  label: string;
  className: string;
  color?: "volcano" | "cyan";
};

function getSuffixFlags(name: string): Array<"U" | "C"> {
  const baseName = name.replace(/\.[^.]+$/, "").toUpperCase();
  const match = baseName.match(/(?:-([UC]{1,2})|(-[UC])+)$/);
  if (!match) return [];

  const suffix = match[0].replace(/-/g, "");
  const flags = new Set<"U" | "C">();

  if (suffix.includes("U")) flags.add("U");
  if (suffix.includes("C")) flags.add("C");

  return (["U", "C"] as const).filter((flag) => flags.has(flag));
}

function getActorLine(actors: string[], metadataStatus?: string): string {
  if (actors.length > 0) return actors.slice(0, 2).join(" / ");

  if (metadataStatus === "fetching") return t("正在补全演员");
  if (metadataStatus === "not_found") return t("素人");
  if (metadataStatus === "failed") return t("演员补全失败");

  return t("演员待补全");
}

function getMetadataTags(genres: string[]): string[] {
  return Array.from(new Set(genres.map((genre) => genre.trim()).filter(Boolean)));
}

function CardTag({ item }: { item: CardTagItem }) {
  useLocale();
  return (
    <Tag
      className={item.className}
      color={item.color}
    >
      {item.label}
    </Tag>
  );
}

function ResponsiveCardTags({ metadataTags, suffixFlags, visibleTagLimit }: {
  metadataTags: string[];
  suffixFlags: Array<"U" | "C">;
  visibleTagLimit: number;
}) {
  useLocale();
  const items = useLocalizedMemo<CardTagItem[]>(() => [
    ...metadataTags.map((tag) => ({
      key: `metadata:${tag}`,
      label: tag,
      className: "metadata-genre-tag"
    })),
    ...(suffixFlags.includes("U") ? [{
      key: "suffix:U",
      label: t("无码"),
      className: "suffix-tag",
      color: "volcano" as const
    }] : []),
    ...(suffixFlags.includes("C") ? [{
      key: "suffix:C",
      label: t("中文"),
      className: "suffix-tag",
      color: "cyan" as const
    }] : [])
  ], [metadataTags, suffixFlags]);
  const visibleIndexes = useLocalizedMemo(
    () => selectVisibleCardTagIndexes(items, visibleTagLimit),
    [items, visibleTagLimit]
  );

  const visibleItems = items.filter((_, index) => visibleIndexes.includes(index));
  const hiddenCount = items.length - visibleItems.length;

  return (
    <div className="metadata-tag-strip" title={items.map((item) => item.label).join(" / ")}>
      {visibleItems.map((item) => (
        <CardTag item={item} key={item.key} />
      ))}
      {hiddenCount > 0 && <Tag className="metadata-tag-more">+{hiddenCount}</Tag>}
    </div>
  );
}

function stripLeadingCode(text: string, code: string): string {
  if (!code) return text;

  const compactCode = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const compactText = text.toUpperCase().replace(/^[^A-Z0-9]+/, "").replace(/[^A-Z0-9]/g, "");

  if (!compactText.startsWith(compactCode)) return text;
  return text.replace(new RegExp(`^\\s*${code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[-_ ]*`, "i"), "").trim();
}

export const MediaCard = memo(function MediaCard({
  item,
  metadataLanguage,
  onOpen,
  onPlay,
  onToggleFavorite,
  visibleTagLimit
}: MediaCardProps) {
  useLocale();
  const displayMetadata = item.metadata?.status === "ready"
    ? getDisplayMetadata(item.metadata, metadataLanguage)
    : null;
  const metadataTitle = displayMetadata?.title ?? "";
  const code = item.normalizedCode || "";
  const strippedFallbackTitle = stripLeadingCode(item.basename, code);
  const fallbackTitle = item.libraryCategory === "FC2" && strippedFallbackTitle === "1"
    ? "-"
    : strippedFallbackTitle;
  const resolvedTitle = stripLeadingCode(metadataTitle || fallbackTitle, code);
  const title = resolvedTitle || metadataTitle || fallbackTitle || item.basename;
  const codeText = code || item.basename;
  const actorLine = item.libraryCategory === "LOCAL" && !displayMetadata?.actors.length && displayMetadata?.director
    ? t("导演：{{name}}", { name: displayMetadata.director })
    : getActorLine(displayMetadata?.actors ?? [], item.metadata?.status);
  const metadataTags = getMetadataTags(displayMetadata?.genres ?? []);
  const suffixFlags = getSuffixFlags(item.name);
  const cardPosterUrl = getPosterUrl(item.id);
  const thumbnailUrl = getThumbnailUrl(item.id);
  const sizeLabel = formatBytes(item.size);

  return (
    <Card
      className="media-card"
      data-motion-layout-id={`media:${item.id}`}
      hoverable
      onClick={() => onOpen(item)}
      cover={
        <div className="thumb">
          <PosterImage
            src={cardPosterUrl}
            alt=""
            decoding="async"
            loading="lazy"
            onError={(event) => {
              if (event.currentTarget.src.endsWith(thumbnailUrl)) return;
              event.currentTarget.src = thumbnailUrl;
            }}
          />
          <button
            aria-label={t("播放")}
            className="play-pill"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onPlay?.(item);
            }}
            title={t("播放")}
            type="button"
          >
            <Play size={15} fill="currentColor" />
          </button>
        </div>
      }
    >
      <div className="media-meta">
        <div className="media-card-topline">
          <div className="media-code-cluster">
            <button
              aria-label={t("查看 {{p0}}", { p0: codeText })}
              className="media-code-button"
              onClick={(event) => {
                event.stopPropagation();
                onOpen(item);
              }}
              type="button"
            >
              <Typography.Text className="media-code" strong title={codeText}>
                {codeText}
              </Typography.Text>
            </button>
            {(item.versionCount ?? 1) > 1 && (
              <Tag className="version-count-tag">{item.versionCount}版本</Tag>
            )}
          </div>
          <Typography.Text className="media-actors" title={actorLine}>
            {actorLine}
          </Typography.Text>
        </div>
        <Typography.Text className="media-title" title={title}>
          {title}
        </Typography.Text>
        <div className="card-tag-action-row">
          <div className="tag-row">
            <ResponsiveCardTags
              metadataTags={metadataTags}
              suffixFlags={suffixFlags}
              visibleTagLimit={visibleTagLimit}
            />
            <div className="file-tag-strip">
              <Tag className="file-info-tag" title={sizeLabel}>{sizeLabel.replace(/\s+/g, "")}</Tag>
              <Tag className="file-info-tag">{formatDuration(item.durationSeconds)}</Tag>
            </div>
          </div>
          <button
            aria-pressed={item.isFavorite}
            aria-label={item.isFavorite ? t("取消收藏") : t("收藏")}
            className={`favorite-button card-favorite-button${item.isFavorite ? " is-active" : ""}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onToggleFavorite?.(item, !item.isFavorite);
            }}
            title={item.isFavorite ? t("取消收藏") : t("收藏")}
            type="button"
          >
            <Heart size={14} fill={item.isFavorite ? "currentColor" : "none"} />
          </button>
        </div>
      </div>
    </Card>
  );
});
