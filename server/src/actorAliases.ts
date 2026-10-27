import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {config} from "./config.js";
import { createHash } from "node:crypto";

type ActorAliasGroup = {
  canonicalName: string;
  aliases: string[];
  sources: string[];
};

const privateAliasPath = process.env.AMW_ACTOR_ALIASES_PATH?.trim() || path.join(config.dataDir,"actor-aliases.json");
const groups = JSON.parse(
  readFileSync(existsSync(privateAliasPath) ? privateAliasPath : new URL("../../scripts/config/actor-aliases.json", import.meta.url), "utf8")
) as ActorAliasGroup[];

export const ACTOR_ALIAS_REGISTRY_SIGNATURE = createHash("sha256")
  .update(JSON.stringify(groups))
  .digest("hex")
  .slice(0, 16);

const ACTOR_UI_FRAGMENT_KEYS = new Set([
  "画像を拡大する",
  "画像を拡大",
  "拡大画像",
  "放大图像",
  "放大圖片",
  "放大图片",
  "查看大图",
  "查看大圖",
  "点击放大",
  "點擊放大",
  "enlargeimage",
  "viewlargerimage",
  "clicktoenlarge"
]);

function actorUiFragmentKey(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("ja")
    .replace(/[\s\-_.・·:：()（）/／]+/gu, "");
}

/**
 * Conservative metadata-boundary check. It rejects markup and a small set of
 * exact image-viewer labels while leaving short, Latin, Chinese and Japanese
 * stage names untouched; identity merging remains driven by the verified alias
 * registry and stable public IDs.
 */
export function isActorNameCandidate(value: string | null | undefined): boolean {
  const normalized = String(value ?? "").normalize("NFKC").trim();
  const hasControlCharacter = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (!normalized || hasControlCharacter) return false;
  if (/[<>]/u.test(normalized) || /(?:&lt;|&gt;|&#0*60;|&#x0*3c;)/iu.test(normalized)) return false;
  if (/(?:的名字|的名称|叫什么|姓名为)/u.test(normalized)) return false;
  // Some providers put age/occupation or multiple role descriptions into the
  // cast array. Keep the source metadata intact, but do not expose these rows
  // as person topics or send them to public identity search.
  if (/\d{1,2}\s*歳/u.test(normalized) || /(?:現役|勤務|店員|会社員|女子大生|大学生|歯科衛生士|教師|先生|副業|ホステス)/u.test(normalized)) return false;
  if (/(?:先輩|後輩)\s*[:：]/u.test(normalized) || /(?:先輩|後輩).*(?:先輩|後輩)/u.test(normalized)) return false;
  if (/さん(?:$|\s|[（(])/u.test(normalized) || /(?:事業会社|制作企画|営業部|メーカー|部門)/u.test(normalized)) return false;
  if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{1,12}[?？]$/u.test(normalized)) return false;
  return !ACTOR_UI_FRAGMENT_KEYS.has(actorUiFragmentKey(normalized));
}

export function actorProviderWorkIdentity(
  provider: string,
  providerId: string,
  normalizedCode: string
): string {
  const stableId = providerId.trim() || normalizedCode.trim();
  return `${provider.trim().toLocaleLowerCase("en-US")}:${stableId.toLocaleLowerCase("en-US")}`;
}

export function normalizeActorIdentityKey(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("ja")
    .replace(/[\s\-_・·]+/g, "")
    .replace(/[()（）]/g, "")
    // Conservative one-to-one glyph folds seen in localized actor facets.
    // Do not perform general Simplified/Traditional conversion because names
    // that are translations rather than glyph variants still require evidence.
    .replace(/宫/gu, "宮")
    .replace(/见/gu, "見")
    .replace(/爱/gu, "愛");
}

const canonicalByAlias = new Map<string, string>();
for (const group of groups) {
  for (const alias of [group.canonicalName, ...group.aliases]) {
    const key = normalizeActorIdentityKey(alias);
    if (key) canonicalByAlias.set(key, group.canonicalName);
  }
}

export function getCanonicalActorName(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const canonical = canonicalByAlias.get(normalizeActorIdentityKey(value));
    if (canonical) return canonical;
  }
  return null;
}

export function getActorDisplayName(source: string, translated = ""): string {
  const safeSource = isActorNameCandidate(source) ? source.trim() : "";
  const safeTranslated = isActorNameCandidate(translated) ? translated.trim() : "";
  return getCanonicalActorName(safeSource, safeTranslated) || safeTranslated || safeSource;
}

export function getLocalizedActorDisplayName(source: string, translated = ""): string {
  const safeSource = isActorNameCandidate(source) ? source.trim() : "";
  const safeTranslated = isActorNameCandidate(translated) ? translated.trim() : "";
  const isChineseDisplayName = (value: string) => /\p{Script=Han}/u.test(value)
    && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value);
  // Identity remains governed by the curated canonical registry, but a trusted
  // Chinese metadata value is the better UI label for a Japanese stage name.
  // Keep this presentation decision separate from getCanonicalActorName so
  // searches and deduplication still retain the original Japanese identity.
  if (isChineseDisplayName(safeTranslated)) return safeTranslated;
  if (isChineseDisplayName(safeSource)) return safeSource;
  return getCanonicalActorName(safeSource, safeTranslated) || safeTranslated || safeSource;
}

export type ActorMetadataTranslationRow = {
  source: string;
  translated: string;
  frequency?: number;
};

/**
 * Resolve a facet value back to the source-language actor name from the same
 * metadata row. Reverse translation is accepted only when one translated name
 * points to exactly one source identity; ambiguous localized homonyms remain
 * independent candidates.
 */
export function resolveActorMetadataTranslation(
  value: string,
  rows: ActorMetadataTranslationRow[]
): { source: string; translated: string; searchNames: string[] } {
  const normalizedValue = value.normalize("NFKC").trim();
  const matchingSourceRows = rows
    .filter((row) => row.source.normalize("NFKC").trim() === normalizedValue)
    .sort((left, right) => (right.frequency ?? 0) - (left.frequency ?? 0));
  if (matchingSourceRows.length > 0) {
    const translated = matchingSourceRows[0]?.translated.normalize("NFKC").trim() ?? "";
    return {
      source: normalizedValue,
      translated,
      searchNames: [...new Set([normalizedValue, translated].filter(isActorNameCandidate))]
    };
  }
  const reverseRows = rows.filter((row) => row.translated.normalize("NFKC").trim() === normalizedValue);
  const sourceByKey = new Map<string, string>();
  for (const row of reverseRows) {
    const source = row.source.normalize("NFKC").trim();
    if (isActorNameCandidate(source)) sourceByKey.set(normalizeActorIdentityKey(source), source);
  }
  if (sourceByKey.size === 1) {
    const source = [...sourceByKey.values()][0]!;
    return { source, translated: normalizedValue, searchNames: [source, normalizedValue] };
  }
  return { source: normalizedValue, translated: "", searchNames: [normalizedValue].filter(isActorNameCandidate) };
}

export function getActorAliasRegistry(): ActorAliasGroup[] {
  return groups;
}
