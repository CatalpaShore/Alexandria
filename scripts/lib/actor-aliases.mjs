import { readFileSync } from "node:fs";

const aliasGroups = JSON.parse(
  readFileSync(new URL("../config/actor-aliases.json", import.meta.url), "utf8")
);

function normalizeActorAlias(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("ja")
    .replace(/[\s\-_・·]+/g, "")
    .replace(/[()（）]/g, "");
}

const canonicalByAlias = new Map();
for (const group of aliasGroups) {
  for (const alias of [group.canonicalName, ...group.aliases]) {
    const key = normalizeActorAlias(alias);
    if (key) canonicalByAlias.set(key, group.canonicalName);
  }
}

export function getCanonicalActorName(...values) {
  for (const value of values) {
    const canonical = canonicalByAlias.get(normalizeActorAlias(value));
    if (canonical) return canonical;
  }
  return "";
}

export function getActorTranslationEntries() {
  return aliasGroups.flatMap((group) =>
    [group.canonicalName, ...group.aliases].map((alias) => [alias, group.canonicalName])
  );
}

export { aliasGroups as ACTOR_ALIAS_GROUPS };
