import { parseMediaName } from "./mediaName.js";

export type SidecarMedia = { id: string; basename: string; normalized_code: string };

// Only treat recognised language/accessibility tags as suffixes. Prefix matches
// such as "Film" and "Film 2" must never attach the wrong episode's subtitles.
const subtitleTags = new Set([
  "zh", "cn", "chs", "sc", "zhcn", "hans", "simplified", "简体", "简体中文",
  "tw", "hk", "cht", "tc", "zhtw", "hant", "traditional", "繁體", "繁体", "繁體中文", "繁体中文",
  "en", "eng", "english", "ja", "jp", "jpn", "japanese", "ko", "kor", "korean",
  "fr", "fre", "fra", "de", "ger", "deu", "es", "spa", "it", "ita", "pt", "por", "br", "ru", "rus",
  "forced", "foreign", "sdh", "hi", "cc", "default", "sub", "subs", "subtitle", "subtitles"
]);

export function selectSidecarMedia(sidecarBase: string, candidates: SidecarMedia[]): SidecarMedia | undefined {
  const name = sidecarBase.toLocaleLowerCase();
  const matches = candidates.filter(({ basename }) => {
    const base = basename.toLocaleLowerCase();
    if (name === base) return true;
    if (!name.startsWith(base) || !/^[.\-_ ]/.test(name.slice(base.length))) return false;
    const tags = name.slice(base.length).split(/[.\-_ ]+/).filter(Boolean);
    return tags.length > 0 && tags.every(tag => subtitleTags.has(tag));
  });
  if (matches.length) {
    const longest = Math.max(...matches.map(item => item.basename.length));
    const best = matches.filter(item => item.basename.length === longest);
    return best.length === 1 ? best[0] : undefined;
  }

  // Preserve useful numbered-title matching, but only if unambiguous within
  // the same directory. Do not match a generic title or a different directory.
  const code = parseMediaName(sidecarBase, "").normalizedCode;
  if (!/^[A-Z][A-Z0-9]{1,9}-\d{3,}$/.test(code)) return undefined;
  const byCode = candidates.filter(item => item.normalized_code === code);
  return byCode.length === 1 ? byCode[0] : undefined;
}

export function getSidecarLanguage(name: string): { language: string; label: string } {
  const normalized = name.toLowerCase();
  const tokens = normalized.split(/[.\-_ ]+/);
  if (tokens.some(token => ["zhtw", "cht", "tc", "hant", "traditional", "繁體", "繁体", "繁體中文", "繁体中文"].includes(token)) ||
      (tokens.includes("zh") && (tokens.includes("tw") || tokens.includes("hk")))) return { language: "zh-TW", label: "繁體中文" };
  if (tokens.some(token => ["zh", "zhcn", "chs", "sc", "cn", "hans", "simplified", "简体", "简体中文"].includes(token))) return { language: "zh-CN", label: "简体中文" };
  if (tokens.some(token => ["ja", "jpn", "jp", "japanese"].includes(token))) return { language: "ja", label: "日语" };
  if (tokens.some(token => ["en", "eng", "english"].includes(token))) return { language: "en", label: "English" };
  return { language: "", label: "" };
}
