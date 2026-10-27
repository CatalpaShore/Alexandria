import { db } from "./db.js";

export const ENTITY_FAVORITE_TYPES = ["actor", "series", "genre", "prefix", "director", "maker", "label"] as const;

export type EntityFavoriteType = (typeof ENTITY_FAVORITE_TYPES)[number];

export type EntityFavorite = {
  type: EntityFavoriteType;
  value: string;
  label: string;
  createdAt: string;
};

type EntityFavoriteRow = {
  type: EntityFavoriteType;
  value: string;
  label: string;
  createdAt: string;
};

function normalizeValue(value: string): string {
  return value.replace(/\r/g, "").trim();
}

export function readEntityFavorites(type?: EntityFavoriteType): EntityFavorite[] {
  const rows = (type
    ? db
        .prepare(
          `SELECT facet_type AS type, facet_value AS value, label, created_at AS createdAt
           FROM entity_favorites
           WHERE facet_type = ?
           ORDER BY created_at DESC, label COLLATE NOCASE ASC`
        )
        .all(type)
    : db
        .prepare(
          `SELECT facet_type AS type, facet_value AS value, label, created_at AS createdAt
           FROM entity_favorites
           ORDER BY created_at DESC, label COLLATE NOCASE ASC`
        )
        .all()) as EntityFavoriteRow[];

  return rows.map((row) => ({
    ...row,
    label: row.label || row.value
  }));
}

export function readEntityFavoriteValues(type: EntityFavoriteType): Set<string> {
  return new Set(readEntityFavorites(type).map((item) => item.value));
}

export function setEntityFavorite(input: {
  type: EntityFavoriteType;
  value: string;
  label?: string;
  favorite: boolean;
}): boolean {
  const value = normalizeValue(input.value);
  const label = normalizeValue(input.label ?? "") || value;
  if (!value) return false;

  if (input.favorite) {
    db.prepare(
      `INSERT INTO entity_favorites (facet_type, facet_value, label, created_at)
       VALUES (@type, @value, @label, @createdAt)
       ON CONFLICT(facet_type, facet_value) DO UPDATE SET label = excluded.label`
    ).run({
      type: input.type,
      value,
      label,
      createdAt: new Date().toISOString()
    });
    return true;
  }

  db.prepare("DELETE FROM entity_favorites WHERE facet_type = ? AND facet_value = ?").run(input.type, value);
  return false;
}
