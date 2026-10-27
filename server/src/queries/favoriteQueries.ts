import { config } from "../config.js";
import { db } from "../db.js";
import {
  ENTITY_FAVORITE_TYPES,
  readEntityFavorites,
  type EntityFavoriteType
} from "../entityFavorites.js";
import { readFavoriteKeys } from "../favorites.js";

export function buildFavoritesResponse() {
  const keys = [...readFavoriteKeys()].sort((left, right) => left.localeCompare(right));
  const mediaItems: Array<{
    id: string;
    relativePath: string;
    basename: string;
    normalizedCode: string;
    title: string;
    titleZh: string;
  }> = [];

  for (let offset = 0; offset < keys.length; offset += 400) {
    const chunk = keys.slice(offset, offset + 400);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(", ");
    mediaItems.push(...(db
      .prepare(
        `SELECT m.id, m.relative_path AS relativePath, m.basename, m.normalized_code AS normalizedCode,
                COALESCE(md.title, '') AS title, COALESCE(md.title_zh, '') AS titleZh
         FROM media_files m
         LEFT JOIN media_metadata md ON md.normalized_code = m.normalized_code AND md.status = 'ready'
         WHERE m.relative_path IN (${placeholders})`
      )
      .all(...chunk) as typeof mediaItems));
  }

  mediaItems.sort((left, right) =>
    (left.normalizedCode || left.basename).localeCompare(right.normalizedCode || right.basename, "zh-CN")
  );
  const entities = readEntityFavorites();
  const counts = Object.fromEntries(
    ENTITY_FAVORITE_TYPES.map((type) => [type, entities.filter((item) => item.type === type).length])
  ) as Record<EntityFavoriteType, number>;

  return {
    items: keys,
    mediaItems,
    entities,
    count: keys.length,
    totalCount: keys.length + entities.length,
    counts: {
      media: keys.length,
      ...counts
    },
    filePath: config.favoritesPath
  };
}
