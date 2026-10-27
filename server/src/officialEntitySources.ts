import crypto from "node:crypto";
import {readOptionalSourceRegistry} from "./optionalSourceRegistry.js";
import { db } from "./db.js";
import { getCanonicalActorName, isActorNameCandidate } from "./actorAliases.js";
import {
  normalizeActorCup,
  recordEntityEnrichmentFailure,
  safeOfficialAgencyImageUrl,
  type EntityExtendedProfile,
  type EntityProfileSource
} from "./entityProfiles.js";

const OFFICIAL_REQUEST_INTERVAL_MS = 1_000;
const MAX_OFFICIAL_REQUEST_ATTEMPTS = 4;
const nextRequestAtByDomain = new Map<string, number>();

export type OfficialActorSourceId = "linx" | "nax" | "mines" | "cmore" | "light" | "so" | "tpowers" | "bambi" | "life" | "duo" | "premium";

export type OfficialActorSourceDefinition = {
  id: OfficialActorSourceId;
  agency: string;
  provider: string;
  actorValue: string;
  sourceUrl: string;
  acceptedNames?: string[];
  requestHeaders?: Record<string, string>;
  preserveExistingMeasurements?: boolean;
  archiveIdentityEvidence?: { reading?: string };
};

export type OfficialActorFacts = {
  displayName: string;
  romanizedName: string;
  reading: string;
  birthDate: string | null;
  birthplace: string;
  heightCm: number | null;
  measurements: EntityExtendedProfile["measurements"];
  socialLinks: Record<string, string>;
  profileImageCandidateUrl: string;
  biography: string;
  agency: string;
  sourceNotes: string[];
  sourceOnlyFacts: Record<string, string>;
};

export type OfficialActorEnrichmentPreview = {
  actorValue: string;
  matched: boolean;
  reason?: string;
  profile?: Omit<EntityExtendedProfile, "type" | "value" | "sources" | "updatedAt">;
  sources?: EntityProfileSource[];
  identityDecision?: { method: "exact-rule"; reason: string };
};

export const OFFICIAL_ACTOR_SOURCES: readonly OfficialActorSourceDefinition[] = readOptionalSourceRegistry<OfficialActorSourceDefinition>("official-actor-sources.json");

function decodeHtmlText(value: string): string {
  return value
    .replace(/<br\s*\/?>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;|&#34;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("ja").replace(/[\s\-_.・·()（）]+/gu, "");
}

function firstClassText(html: string, className: string): string {
  const pattern = new RegExp(`<[^>]+class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, "iu");
  return decodeHtmlText(html.match(pattern)?.[1] ?? "");
}

function firstTagText(html: string, tagName: string): string {
  return decodeHtmlText(html.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "iu"))?.[1] ?? "");
}

function definitionList(html: string): Map<string, { text: string; html: string }> {
  const values = new Map<string, { text: string; html: string }>();
  for (const match of html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/giu)) {
    const key = decodeHtmlText(match[1]).replace(/[：:]$/u, "").trim();
    if (key) values.set(key, { text: decodeHtmlText(match[2]), html: match[2] });
  }
  return values;
}

function validDate(value: string): string | null {
  const match = value.match(/(19\d{2}|20\d{2})(?:\s*年\s*|[-/.])(\d{1,2})(?:\s*月\s*|[-/.])(\d{1,2})(?:\s*日)?/u);
  if (!match) return null;
  const result = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  const parsed = new Date(`${result}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result ? null : result;
}

function centimeters(value: string): number | null {
  const parsed = Number(value.normalize("NFKC").match(/(?:T\s*[：:]?\s*)?(\d{2,3}(?:\.\d+)?)\s*(?:cm)?/iu)?.[1] ?? "");
  return Number.isFinite(parsed) && parsed >= 100 && parsed <= 220 ? parsed : null;
}

function measurements(value: string): EntityExtendedProfile["measurements"] {
  const normalized = value.normalize("NFKC");
  const find = (label: "B" | "W" | "H") => {
    const parsed = Number(normalized.match(new RegExp(`${label}\\s*[：:]?\\s*(\\d{2,3})`, "iu"))?.[1] ?? "");
    return Number.isFinite(parsed) && parsed >= 40 && parsed <= 180 ? parsed : undefined;
  };
  const compact = normalized.match(/(\d{2,3})\s*cm?\s*\(([A-Z]{1,3})\)\s*[-／/]\s*(\d{2,3})\s*cm?\s*[-／/]\s*(\d{2,3})/iu);
  const cup = normalizeActorCup(normalized.match(/\(([^)]+)\)/u)?.[1]);
  return compact ? {
    bustCm: Number(compact[1]),
    waistCm: Number(compact[3]),
    hipsCm: Number(compact[4]),
    cup: normalizeActorCup(compact[2])
  } : {
    ...(find("B") ? { bustCm: find("B") } : {}),
    ...(find("W") ? { waistCm: find("W") } : {}),
    ...(find("H") ? { hipsCm: find("H") } : {}),
    ...(cup ? { cup } : {})
  };
}

function safeSocialLinks(html: string): Record<string, string> {
  const links: Record<string, string> = {};
  for (const match of html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>/giu)) {
    try {
      const url = new URL(match[1]);
      if (url.protocol !== "https:") continue;
      const host = url.hostname.replace(/^www\./u, "").toLowerCase();
      if (["x.com", "twitter.com"].includes(host) && !links.x) links.x = url.toString();
      else if (host === "instagram.com" && !links.instagram) links.instagram = url.toString();
      else if (host === "tiktok.com" && !links.tiktok) links.tiktok = url.toString();
      else if (host === "youtube.com" && !links.youtube) links.youtube = url.toString();
    } catch {
      // Ignore malformed and non-absolute links from the official page.
    }
  }
  return links;
}

function safeOfficialImageUrl(
  definition: OfficialActorSourceDefinition,
  html: string,
  imageTagPattern: RegExp
): string {
  const imageTag = html.match(imageTagPattern)?.[0] ?? "";
  const rawUrl = (imageTag.match(/\bsrc=["']([^"']+)["']/iu)?.[1] ??
    imageTag.match(/\bdata-src=["']([^"']+)["']/iu)?.[1] ??
    imageTag.match(/background-image\s*:\s*url\(\s*["']?([^"')\s]+)["']?\s*\)/iu)?.[1] ?? "")
    .replace(/&amp;/giu, "&");
  if (!rawUrl) return "";
  try {
    const baseHref = html.match(/<base[^>]+href=["']([^"']+)["']/iu)?.[1];
    const baseUrl = new URL(baseHref || definition.sourceUrl, definition.sourceUrl);
    const url = new URL(rawUrl, baseUrl);
    return safeOfficialAgencyImageUrl(definition.sourceUrl, url.toString());
  } catch {
    return "";
  }
}

function createFacts(definition: OfficialActorSourceDefinition, input: {
  displayName: string;
  romanizedName?: string;
  reading?: string;
  birthDate?: string;
  birthplace?: string;
  height?: string;
  sizes?: string;
  socialHtml?: string;
  profileImageCandidateUrl?: string;
}): OfficialActorFacts | null {
  if (!input.displayName) return null;
  const socialLinks = safeSocialLinks(input.socialHtml ?? "");
  return {
    displayName: input.displayName,
    romanizedName: input.romanizedName ?? "",
    reading: input.reading ?? "",
    birthDate: validDate(input.birthDate ?? ""),
    birthplace: input.birthplace ?? "",
    heightCm: centimeters(input.height ?? ""),
    measurements: measurements(input.sizes ?? ""),
    socialLinks,
    profileImageCandidateUrl: input.profileImageCandidateUrl ?? "",
    biography: `${input.displayName}，收录于 ${definition.agency} 事务所官方人物资料。`,
    agency: definition.agency,
    sourceNotes: [],
    sourceOnlyFacts: {}
  };
}

function parseLinx(definition: OfficialActorSourceDefinition, html: string): OfficialActorFacts | null {
  const fields = definitionList(html);
  const modernFields = duoFields(html);
  const romanizedName = firstClassText(html, "en");
  const modernHeading = firstClassText(html, "lv01");
  const modelName = fields.get("モデル名")?.text ?? (modernHeading.replace(romanizedName, "").trim() || firstTagText(html, "h1"));
  const nameMatch = modelName.match(/^(.+?)[（(]([^（）()]+)[）)]$/u);
  const legacySocialHtml = ["X", "Instagram", "TikTok", "YouTube"]
    .map((label) => fields.get(label)?.html ?? "")
    .filter(Boolean)
    .join(" ");
  const modernSocialHtml = html.match(/<ul[^>]*class=["'][^"']*\bprof_sns\b[^"']*["'][^>]*>([\s\S]*?)<\/ul>/iu)?.[1] ?? "";
  return createFacts(definition, {
    displayName: (nameMatch?.[1] ?? modelName).replace(/\s+/gu, ""),
    romanizedName,
    reading: nameMatch?.[2] ?? "",
    birthDate: fields.get("誕生日")?.text ?? modernFields.get("生年月日"),
    birthplace: fields.get("出身地")?.text ?? modernFields.get("出身地"),
    height: fields.get("身長")?.text ?? modernFields.get("身長"),
    sizes: fields.get("3サイズ")?.text ?? modernFields.get("3サイズ"),
    socialHtml: `${legacySocialHtml} ${modernSocialHtml}`,
    profileImageCandidateUrl: safeOfficialImageUrl(
      definition,
      html,
      /<img(?=[^>]*\bname=["']myImg["'])[^>]*>|<div[^>]*class=["'][^"']*\bmodel_prof\b[^"']*["'][^>]*>[\s\S]*?<figure[^>]*>[\s\S]*?<img[^>]*>/iu
    )
  });
}

function parseNax(definition: OfficialActorSourceDefinition, html: string): OfficialActorFacts | null {
  const fields = definitionList(html);
  const profileHtml = html.match(/<dl[^>]*c-Model-Single_Top_ProfileList[^>]*>([\s\S]*?)<\/dl>/iu)?.[1] ?? "";
  return createFacts(definition, {
    displayName: firstClassText(html, "c-Model-Single_Top-Title"),
    reading: firstClassText(html, "c-Model-Single_Top-Title-Kana"),
    birthDate: fields.get("生年月日")?.text,
    height: fields.get("身長")?.text,
    sizes: fields.get("サイズ")?.text,
    socialHtml: profileHtml,
    profileImageCandidateUrl: safeOfficialImageUrl(definition, html, /<img(?=[^>]*\bc-Model_Top-Img\b)[^>]*>/iu)
  });
}

function parseMines(definition: OfficialActorSourceDefinition, html: string): OfficialActorFacts | null {
  const fields = definitionList(html);
  const profileHtml = html.match(/<dl[^>]*profileData[^>]*>([\s\S]*?)<\/dl>/iu)?.[1] ?? "";
  return createFacts(definition, {
    displayName: firstClassText(html, "profileName_name"),
    romanizedName: firstClassText(html, "profileName_kana"),
    birthDate: fields.get("生年月日")?.text,
    birthplace: fields.get("出身地")?.text,
    height: fields.get("身長")?.text,
    sizes: fields.get("スリーサイズ")?.text,
    socialHtml: profileHtml,
    profileImageCandidateUrl: safeOfficialImageUrl(definition, html, /<div[^>]*\bprofilePhoto\b[^>]*>[\s\S]*?<img[^>]*>/iu)
  });
}

function cmoreField(html: string, label: string): string {
  const pattern = new RegExp(`<span[^>]*class=["'][^"']*\\borg\\b[^"']*["'][^>]*>\\s*【${label}】\\s*<\\/span>\\s*<br\\s*\\/?>\\s*([\\s\\S]*?)<br\\s*\\/?>`, "iu");
  return decodeHtmlText(html.match(pattern)?.[1] ?? "");
}

function parseCmore(definition: OfficialActorSourceDefinition, html: string): OfficialActorFacts | null {
  if (definition.archiveIdentityEvidence) {
    const pageText = decodeHtmlText(html);
    const reading = definition.archiveIdentityEvidence.reading ?? "";
    const identityText = reading ? `${definition.actorValue}（${reading}）` : definition.actorValue;
    if (!pageText.includes(identityText)) return null;
    const facts = createFacts(definition, { displayName: definition.actorValue, reading });
    if (!facts) return null;
    facts.biography = `${definition.agency} 官方活动归档以${identityText}名义发布活动信息。`;
    facts.sourceNotes.push("official-event-archive-identity");
    return facts;
  }
  const socialHtml = html.match(/SNS LINK([\s\S]*?)(?:area-footer-links|<footer)/iu)?.[1] ?? "";
  const sizes = cmoreField(html, "サイズ");
  return createFacts(definition, {
    displayName: firstClassText(html, "heading-lv1"),
    birthDate: cmoreField(html, "生年月日"),
    height: sizes,
    sizes,
    socialHtml,
    profileImageCandidateUrl: safeOfficialImageUrl(definition, html, /<div[^>]*\bblock-item_media-large\b[^>]*>[\s\S]*?<img[^>]*>/iu)
  });
}

function parseLight(definition: OfficialActorSourceDefinition, html: string): OfficialActorFacts | null {
  const fields = definitionList(html);
  const profileHtml = html.match(/<div[^>]*class=["'][^"']*\bprofile\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/iu)?.[1] ?? "";
  const facts = createFacts(definition, {
    displayName: firstClassText(html, "name_main"),
    romanizedName: firstClassText(html, "name_sub"),
    birthDate: fields.get("生年月日")?.text,
    height: fields.get("身長")?.text,
    sizes: fields.get("スリーサイズ")?.text,
    socialHtml: profileHtml,
    profileImageCandidateUrl: safeOfficialImageUrl(definition, html, /<div[^>]*class=["'][^"']*\bcms-img\b[^"']*\bphoto\b[^"']*["'][^>]*>[\s\S]*?<img[^>]*>/iu)
  });
  if (facts && /SI\s*デビュー/u.test(decodeHtmlText(html))) facts.sourceNotes.push("SIデビュー");
  return facts;
}

function parseSo(definition: OfficialActorSourceDefinition, html: string): OfficialActorFacts | null {
  const detailHtml = html.match(/<div[^>]*class=["'][^"']*\bsec_prf_txt_deta\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/iu)?.[1] ?? "";
  const detail = decodeHtmlText(detailHtml);
  const read = (label: string): string => detail.match(new RegExp(`${label.split("").join("\\s*")}\\s*[:：]\\s*([^:：]+?)(?=\\s*(?:年\\s*齢|身\\s*長|サ\\s*イ\\s*ズ|出\\s*身)\\s*[:：]|$)`, "iu"))?.[1]?.trim() ?? "";
  const profileHtml = html.match(/<div[^>]*class=["'][^"']*\bsec_prf_txtbox\b[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/iu)?.[1] ?? "";
  const facts = createFacts(definition, {
    displayName: firstClassText(html, "sec_prf_txt_name"),
    romanizedName: firstClassText(html, "sec_prf_txt_name2"),
    birthplace: read("出身").replace(/^--$/u, ""),
    height: read("身長"),
    sizes: read("サイズ"),
    socialHtml: profileHtml,
    profileImageCandidateUrl: safeOfficialImageUrl(definition, html, /<div[^>]*\bsec_prf_imgbox_img\b[^>]*>[\s\S]*?<img[^>]*>/iu)
  });
  const statedAge = read("年齢");
  if (facts && statedAge) facts.sourceOnlyFacts.statedAge = statedAge;
  return facts;
}

function tpowersFields(html: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const match of html.matchAll(/<dt[^>]*\bp-talent-detail__term\b[^>]*>([\s\S]*?)<\/dt>\s*<dt[^>]*\bp-talent-detail__desc\b[^>]*>([\s\S]*?)<\/dt>/giu)) {
    const key = decodeHtmlText(match[1]).replace(/[：:]$/u, "").trim();
    if (key) fields.set(key, decodeHtmlText(match[2]));
  }
  return fields;
}

function parseTpowers(definition: OfficialActorSourceDefinition, html: string): OfficialActorFacts | null {
  const fields = tpowersFields(html);
  const birthText = fields.get("生年月日") ?? "";
  const socialStart = html.search(/<div[^>]*\bp-talent-detail__sns\b/iu);
  const socialHtml = socialStart >= 0 ? html.slice(socialStart, html.indexOf("</section>", socialStart)) : "";
  const romanizedName = firstClassText(html, "p-talent-detail__vis-name-item");
  const facts = createFacts(definition, {
    displayName: firstClassText(html, "p-talent-detail__name-pc") || firstClassText(html, "p-talent-detail__name-sp"),
    romanizedName,
    birthDate: birthText,
    birthplace: fields.get("出身地"),
    height: fields.get("身長"),
    sizes: fields.get("スリーサイズ"),
    socialHtml,
    profileImageCandidateUrl: safeOfficialImageUrl(definition, html, /<div[^>]*\bp-talent-detail__vis-slider-img\b[^>]*>/iu)
  });
  const monthDay = birthText.match(/^(\d{1,2})\s*月\s*(\d{1,2})\s*日$/u);
  if (facts && !facts.birthDate && monthDay) {
    facts.sourceOnlyFacts.birthMonthDay = `${monthDay[1].padStart(2, "0")}-${monthDay[2].padStart(2, "0")}`;
  }
  return facts;
}

function parseBambi(definition: OfficialActorSourceDefinition, html: string): OfficialActorFacts | null {
  const fields = definitionList(html);
  const officialName = fields.get("名前")?.text ?? "";
  const nameMatch = officialName.match(/^(.+?)[（(]([^（）()]+)[）)]$/u);
  const romanizedName = decodeHtmlText(html.match(
    /<span[^>]*class=["'][^"']*\bprofileTitle-color\b[^"']*["'][^>]*>([\s\S]*?)<\/span>\s*profile\b/iu
  )?.[1] ?? "");
  const facts = createFacts(definition, {
    displayName: (nameMatch?.[1] ?? officialName).replace(/\s+/gu, ""),
    romanizedName,
    reading: nameMatch?.[2] ?? "",
    birthDate: fields.get("生年月日")?.text,
    height: fields.get("身長")?.text,
    sizes: fields.get("スリーサイズ")?.text,
    socialHtml: fields.get("SNS")?.html ?? "",
    profileImageCandidateUrl: safeOfficialImageUrl(
      definition,
      html,
      /<div[^>]*class=["'][^"']*\bin-model-popup-content\b[^"']*["'][^>]*>[\s\S]*?<img[^>]*>/iu
    )
  });
  const maker = fields.get("所属メーカー")?.text ?? "";
  if (facts && maker) facts.sourceOnlyFacts.affiliatedMaker = maker;
  return facts;
}

function duoFields(html: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const match of html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/giu)) {
    const key = decodeHtmlText(match[1]).replace(/[：:]$/u, "").trim();
    if (key) fields.set(key, decodeHtmlText(match[2]));
  }
  return fields;
}

function parseDuo(definition: OfficialActorSourceDefinition, html: string): OfficialActorFacts | null {
  const fields = duoFields(html);
  const combinedName = firstClassText(html, "p-page-header__title") || firstTagText(html, "h1");
  const nameMatch = combinedName.match(/^(.+?)\s+([A-Za-z][A-Za-z\s.'-]+)$/u);
  const profileStart = html.search(/<div[^>]*class=["'][^"']*\bsiteorigin-widget-tinymce\b[^"']*["'][^>]*>/iu);
  const profileEnd = profileStart >= 0 ? html.indexOf("</table>", profileStart) : -1;
  const profileHtml = profileStart >= 0 ? html.slice(profileStart, profileEnd >= 0 ? profileEnd : undefined) : "";
  const sizes = (fields.get("スリーサイズ") ?? "").replace(/\(([A-Z]{1,3})-\d+\)/iu, "($1)");
  return createFacts(definition, {
    displayName: decodeHtmlText(nameMatch?.[1] ?? combinedName).replace(/\s+/gu, ""),
    romanizedName: decodeHtmlText(nameMatch?.[2] ?? ""),
    birthDate: fields.get("誕生日"),
    height: fields.get("身長"),
    sizes,
    socialHtml: profileHtml,
    profileImageCandidateUrl: safeOfficialImageUrl(
      definition,
      html,
      /<img(?=[^>]*class=["'][^"']*\bso-widget-image\b[^"']*["'])[^>]*>/iu
    )
  });
}

function lifeField(html: string, label: string): string {
  return decodeHtmlText(html.match(new RegExp(
    `<p[^>]*>\\s*${label}[\\s\\u3000]*[：:]\\s*([\\s\\S]*?)<\\/p>`,
    "iu"
  ))?.[1] ?? "");
}

function parseLife(definition: OfficialActorSourceDefinition, html: string): OfficialActorFacts | null {
  const heading = html.match(/<h1[^>]*class=["'][^"']*\bmove\b[^"']*["'][^>]*>\s*([^<]+?)\s*<span[^>]*>([^<]+)<\/span>/iu);
  const profileStart = html.search(/<div[^>]*class=["'][^"']*\bprofile\b[^"']*["'][^>]*>/iu);
  const profileEnd = profileStart >= 0 ? html.indexOf("</article>", profileStart) : -1;
  const profileHtml = profileStart >= 0 ? html.slice(profileStart, profileEnd >= 0 ? profileEnd : undefined) : "";
  return createFacts(definition, {
    displayName: decodeHtmlText(heading?.[1] ?? "").replace(/\s+/gu, "")
      .replace(/[（(][A-Za-z][A-Za-z\s._-]*[）)]$/u, ""),
    romanizedName: decodeHtmlText(heading?.[2] ?? ""),
    birthDate: lifeField(profileHtml, "生年月日"),
    height: lifeField(profileHtml, "身長"),
    sizes: lifeField(profileHtml, "サイズ"),
    socialHtml: profileHtml,
    profileImageCandidateUrl: safeOfficialImageUrl(
      definition,
      html,
      /<img(?=[^>]*class=["'][^"']*\bmodel\b[^"']*["'])(?=[^>]*alt=["'][^"']+["'])[^>]*>/iu
    )
  });
}

function parsePremium(definition: OfficialActorSourceDefinition, html: string): OfficialActorFacts | null {
  const fields = new Map<string, string>();
  for (const match of html.matchAll(
    /<div[^>]*class=["'][^"']*\bitem\b[^"']*["'][^>]*>\s*<p[^>]*class=["'][^"']*\bth\b[^"']*["'][^>]*>([\s\S]*?)<\/p>\s*<p[^>]*class=["'][^"']*\btd\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/giu
  )) {
    const key = decodeHtmlText(match[1]);
    if (key) fields.set(key, decodeHtmlText(match[2]));
  }
  const titleName = decodeHtmlText(html.match(/<title[^>]*>([\s\S]*?)\s*\|/iu)?.[1] ?? "");
  const romanizedName = decodeHtmlText(html.match(
    /<p[^>]*class=["'][^"']*\bbottom\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/iu
  )?.[1] ?? "");
  return createFacts(definition, {
    displayName: titleName,
    romanizedName,
    height: fields.get("身長"),
    sizes: fields.get("3サイズ"),
    profileImageCandidateUrl: safeOfficialImageUrl(
      definition,
      html,
      /<div[^>]*class=["'][^"']*\bswiper-slide\b[^"']*["'][^>]*>[\s\S]*?<img[^>]*>/iu
    )
  });
}

export function parseOfficialActorPage(
  definition: OfficialActorSourceDefinition,
  html: string
): OfficialActorFacts | null {
  if (definition.id === "linx") return parseLinx(definition, html);
  if (definition.id === "nax") return parseNax(definition, html);
  if (definition.id === "mines") return parseMines(definition, html);
  if (definition.id === "cmore") return parseCmore(definition, html);
  if (definition.id === "light") return parseLight(definition, html);
  if (definition.id === "so") return parseSo(definition, html);
  if (definition.id === "tpowers") return parseTpowers(definition, html);
  if (definition.id === "bambi") return parseBambi(definition, html);
  if (definition.id === "duo") return parseDuo(definition, html);
  if (definition.id === "premium") return parsePremium(definition, html);
  return parseLife(definition, html);
}

export function officialActorIdentityMatches(definition: OfficialActorSourceDefinition, displayName: string): boolean {
  const expectedNames = [definition.actorValue, ...(definition.acceptedNames ?? [])];
  if (expectedNames.some((name) => normalizeName(name) === normalizeName(displayName))) return true;
  const expectedCanonical = getCanonicalActorName(definition.actorValue) || definition.actorValue;
  const actualCanonical = getCanonicalActorName(displayName) || displayName;
  return normalizeName(expectedCanonical) === normalizeName(actualCanonical);
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfterSeconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? Math.min(30_000, retryAfterSeconds * 1_000)
    : Math.min(30_000, 2_000 * 2 ** attempt);
}

async function fetchOfficialHtml(definition: OfficialActorSourceDefinition): Promise<string> {
  const host = new URL(definition.sourceUrl).hostname;
  for (let attempt = 0; attempt < MAX_OFFICIAL_REQUEST_ATTEMPTS; attempt += 1) {
    const waitMs = Math.max(0, (nextRequestAtByDomain.get(host) ?? 0) - Date.now());
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    let response: Response;
    try {
      response = await fetch(definition.sourceUrl, {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "AlexandriaArchive/0.1 (local official profile enrichment)",
          ...definition.requestHeaders
        },
        redirect: "follow",
        signal: AbortSignal.timeout(20_000)
      });
    } catch (error) {
      if (attempt === MAX_OFFICIAL_REQUEST_ATTEMPTS - 1) throw error;
      nextRequestAtByDomain.set(host, Date.now() + Math.min(30_000, 2_000 * 2 ** attempt));
      continue;
    }
    nextRequestAtByDomain.set(host, Date.now() + OFFICIAL_REQUEST_INTERVAL_MS);
    if (response.ok) return response.text();
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === MAX_OFFICIAL_REQUEST_ATTEMPTS - 1) {
      throw new Error(`Official profile request failed (${response.status})`);
    }
    await response.body?.cancel().catch(() => undefined);
    nextRequestAtByDomain.set(host, Date.now() + retryDelay(response, attempt));
  }
  throw new Error("Official profile request failed");
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function mergeNonEmpty<T extends Record<string, string>>(base: T, additions: Record<string, string>): T {
  return { ...base, ...Object.fromEntries(Object.entries(additions).filter(([, value]) => value.trim())) };
}

function mergeFacts(base: Record<string, unknown>, additions: Record<string, unknown>): Record<string, unknown> {
  return {
    ...base,
    ...Object.fromEntries(Object.entries(additions).filter(([, value]) =>
      value != null && value !== "" && (!Array.isArray(value) || value.length > 0)
    ))
  };
}

function persistOfficialProfile(
  definition: OfficialActorSourceDefinition,
  profile: NonNullable<OfficialActorEnrichmentPreview["profile"]>,
  source: EntityProfileSource,
  decisionReason: string
): void {
  const sourceIdentity = db.prepare(`
    SELECT facet_value AS value FROM entity_profile_sources
    WHERE facet_type = 'actor' AND source_url = @sourceUrl
    LIMIT 1
  `).get({ sourceUrl: definition.sourceUrl }) as { value: string } | undefined;
  const identityNames = [...new Set([definition.actorValue, ...(definition.acceptedNames ?? [])])];
  const normalizedIdentityNames = identityNames.map((value) => value.replace(/[\s\u3000]+/gu, ""));
  const nameIdentity = db.prepare(`
    SELECT facet_value AS value FROM entity_profiles
    WHERE facet_type = 'actor' AND (facet_value IN (SELECT CAST(value AS TEXT) FROM json_each(@identityNamesJson)) OR EXISTS (
      SELECT 1 FROM json_each(entity_profiles.aliases_json)
      WHERE REPLACE(REPLACE(TRIM(CAST(value AS TEXT)), ' ', ''), CHAR(12288), '')
        IN (SELECT CAST(value AS TEXT) FROM json_each(@normalizedIdentityNamesJson))
    ))
    ORDER BY CASE WHEN facet_value = @actorValue THEN 0 ELSE 1 END, confidence DESC
    LIMIT 1
  `).get({ actorValue: definition.actorValue, identityNamesJson: JSON.stringify(identityNames),
    normalizedIdentityNamesJson: JSON.stringify(normalizedIdentityNames) }) as { value: string } | undefined;
  const facetValue = sourceIdentity?.value ?? nameIdentity?.value ?? definition.actorValue;
  const existing = db.prepare(`
    SELECT display_name AS displayName, names_json AS namesJson, aliases_json AS aliasesJson,
      biography, birth_date AS birthDate, birthplace, height_cm AS heightCm,
      source_status AS status, facts_json AS factsJson,
      social_links_json AS socialLinksJson, external_ids_json AS externalIdsJson,
      measurements_json AS measurementsJson, official_website AS officialWebsite
    FROM entity_profiles WHERE facet_type = 'actor' AND facet_value = ?
  `).get(facetValue) as {
    displayName: string; namesJson: string; aliasesJson: string; biography: string;
    birthDate: string | null; birthplace: string; heightCm: number | null; status: string;
    factsJson: string; socialLinksJson: string; externalIdsJson: string;
    measurementsJson: string; officialWebsite: string;
  } | undefined;
  const preserveVerifiedFields = existing?.status === "verified";
  const preserveResolvedScalarFields = preserveVerifiedFields || existing?.status === "auto-resolved";
  const existingNames = parseJson<Record<string, string>>(existing?.namesJson ?? "{}", {});
  const names = preserveVerifiedFields
    ? mergeNonEmpty(profile.names, existingNames)
    : mergeNonEmpty(existingNames, profile.names);
  const aliases = [...new Set([
    ...parseJson<string[]>(existing?.aliasesJson ?? "[]", []),
    facetValue,
    definition.actorValue,
    profile.displayName,
    ...profile.aliases
  ].filter(isActorNameCandidate))];
  const existingFacts = parseJson<Record<string, unknown>>(existing?.factsJson ?? "{}", {});
  const facts = preserveVerifiedFields ? mergeFacts(profile.facts, existingFacts) : mergeFacts(existingFacts, profile.facts);
  const existingMeasurements = parseJson<EntityExtendedProfile["measurements"]>(existing?.measurementsJson ?? "{}", {});
  const mergedMeasurements = preserveVerifiedFields || definition.preserveExistingMeasurements
    ? { ...profile.measurements, ...existingMeasurements }
    : { ...existingMeasurements, ...profile.measurements };
  const existingSocialLinks = parseJson<Record<string, string>>(existing?.socialLinksJson ?? "{}", {});
  const socialLinks = preserveVerifiedFields
    ? mergeNonEmpty(profile.socialLinks, existingSocialLinks)
    : mergeNonEmpty(existingSocialLinks, profile.socialLinks);
  const externalIds = mergeNonEmpty(parseJson<Record<string, string>>(existing?.externalIdsJson ?? "{}", {}), {
    [`official-${definition.id}`]: definition.sourceUrl
  });
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO entity_profiles (
        facet_type, facet_value, display_name, names_json, aliases_json, biography,
        birth_date, birthplace, nationality, height_cm, measurements_json, facts_json, occupations_json,
        image_url, official_website, social_links_json, external_ids_json, wikidata_id,
        wikipedia_url, source_status, confidence, fetched_at, updated_at
      ) VALUES (
        'actor', @facetValue, @displayName, @namesJson, @aliasesJson, @biography,
        @birthDate, @birthplace, '', @heightCm, @measurementsJson, @factsJson, @occupationsJson,
        '', @officialWebsite, @socialLinksJson, @externalIdsJson, '',
        '', 'auto-matched', @confidence, @fetchedAt, @updatedAt
      )
      ON CONFLICT(facet_type, facet_value) DO UPDATE SET
        display_name = excluded.display_name,
        names_json = excluded.names_json,
        aliases_json = excluded.aliases_json,
        biography = CASE
          WHEN entity_profiles.biography = '' OR entity_profiles.biography LIKE '%公式プロフィールに掲載されている所属人物です。'
            THEN excluded.biography
          ELSE entity_profiles.biography
        END,
        birth_date = COALESCE(excluded.birth_date, entity_profiles.birth_date),
        birthplace = CASE WHEN excluded.birthplace != '' THEN excluded.birthplace ELSE entity_profiles.birthplace END,
        height_cm = COALESCE(excluded.height_cm, entity_profiles.height_cm),
        measurements_json = excluded.measurements_json,
        facts_json = excluded.facts_json,
        occupations_json = CASE WHEN entity_profiles.occupations_json != '[]' THEN entity_profiles.occupations_json ELSE excluded.occupations_json END,
        official_website = excluded.official_website,
        social_links_json = excluded.social_links_json,
        external_ids_json = excluded.external_ids_json,
        source_status = CASE
          WHEN entity_profiles.source_status IN ('verified', 'auto-resolved') THEN entity_profiles.source_status
          ELSE 'auto-matched'
        END,
        confidence = MAX(entity_profiles.confidence, excluded.confidence),
        fetched_at = excluded.fetched_at,
        updated_at = excluded.updated_at
    `).run({
      facetValue,
      displayName: preserveVerifiedFields && existing?.displayName ? existing.displayName : profile.displayName,
      namesJson: JSON.stringify(names),
      aliasesJson: JSON.stringify(aliases),
      biography: profile.biography,
      birthDate: preserveResolvedScalarFields && existing?.birthDate ? existing.birthDate : profile.birthDate,
      birthplace: preserveResolvedScalarFields && existing?.birthplace ? existing.birthplace : profile.birthplace,
      heightCm: preserveResolvedScalarFields && existing?.heightCm != null ? existing.heightCm : profile.heightCm,
      measurementsJson: JSON.stringify(mergedMeasurements),
      factsJson: JSON.stringify(facts),
      occupationsJson: JSON.stringify(profile.occupations),
      officialWebsite: preserveVerifiedFields && existing?.officialWebsite ? existing.officialWebsite : definition.sourceUrl,
      socialLinksJson: JSON.stringify(socialLinks),
      externalIdsJson: JSON.stringify(externalIds),
      confidence: profile.confidence,
      fetchedAt: profile.fetchedAt,
      updatedAt: now
    });
    db.prepare(`
      INSERT INTO entity_profile_sources (
        id, facet_type, facet_value, provider, source_title, source_url, license,
        language, fields_json, payload_json, confidence, retrieved_at
      ) VALUES (
        @id, 'actor', @facetValue, @provider, @title, @url, 'unknown',
        'ja', @fieldsJson, @payloadJson, @confidence, @retrievedAt
      )
      ON CONFLICT(facet_type, facet_value, provider, source_url) DO UPDATE SET
        source_title = excluded.source_title,
        fields_json = excluded.fields_json,
        payload_json = excluded.payload_json,
        confidence = excluded.confidence,
        retrieved_at = excluded.retrieved_at
    `).run({
      id: crypto.randomUUID(),
      facetValue,
      provider: source.provider,
      title: source.title,
      url: source.url,
      fieldsJson: JSON.stringify(source.fields),
      payloadJson: JSON.stringify(source.facts ?? {}),
      confidence: source.confidence,
      retrievedAt: source.retrievedAt
    });
    db.prepare(`
      INSERT INTO entity_profile_enrichment (
        facet_type, facet_value, display_name, status, attempt_count, matched_external_id,
        confidence, decision_method, decision_reason, last_attempt_at, next_retry_at, updated_at
      ) VALUES (
        'actor', @facetValue, @displayName, 'matched', 1, @sourceUrl,
        @confidence, 'exact-rule', @decisionReason, @updatedAt, NULL, @updatedAt
      )
      ON CONFLICT(facet_type, facet_value) DO UPDATE SET
        display_name = excluded.display_name,
        status = 'matched',
        attempt_count = entity_profile_enrichment.attempt_count + 1,
        matched_external_id = excluded.matched_external_id,
        confidence = excluded.confidence,
        last_error_code = '',
        last_error = '',
        decision_method = excluded.decision_method,
        decision_reason = excluded.decision_reason,
        last_attempt_at = excluded.last_attempt_at,
        next_retry_at = NULL,
        updated_at = excluded.updated_at
    `).run({ facetValue, displayName: profile.displayName, sourceUrl: definition.sourceUrl,
      confidence: profile.confidence, decisionReason, updatedAt: now });
  })();
}

export async function enrichActorFromOfficialSource(
  definition: OfficialActorSourceDefinition,
  execute = false
): Promise<OfficialActorEnrichmentPreview> {
  try {
    const html = await fetchOfficialHtml(definition);
    const facts = parseOfficialActorPage(definition, html);
    if (!facts) throw new Error("Official profile parser did not find a name");
    if (!officialActorIdentityMatches(definition, facts.displayName)) {
      throw new Error(`Official profile identity mismatch: expected ${definition.actorValue}, received ${facts.displayName}`);
    }
    const retrievedAt = new Date().toISOString();
    const names = {
      ja: facts.displayName,
      ...(facts.romanizedName ? { en: facts.romanizedName } : {}),
      ...(facts.reading ? { "ja-Kana": facts.reading } : {})
    };
    const aliases = [...new Set([
      definition.actorValue,
      ...(definition.acceptedNames ?? []),
      facts.displayName,
      facts.romanizedName,
      facts.reading
    ].filter(isActorNameCandidate))];
    const fields = [
      "names", "aliases", "biography", "officialWebsite", "facts",
      ...(facts.birthDate ? ["birthDate"] : []),
      ...(facts.birthplace ? ["birthplace"] : []),
      ...(facts.heightCm != null ? ["heightCm"] : []),
      ...(Object.keys(facts.measurements).length ? ["measurements"] : []),
      ...(Object.keys(facts.socialLinks).length ? ["socialLinks"] : [])
    ];
    const profile = {
      displayName: facts.displayName,
      names,
      aliases,
      biography: facts.biography,
      birthDate: facts.birthDate,
      birthplace: facts.birthplace,
      nationality: "",
      heightCm: facts.heightCm,
      measurements: facts.measurements,
      facts: {
        agency: facts.agency,
        ...(facts.reading ? { reading: facts.reading } : {}),
        ...(facts.romanizedName ? { romanizedName: facts.romanizedName } : {}),
        ...(facts.profileImageCandidateUrl ? { profileImageCandidateUrl: facts.profileImageCandidateUrl } : {})
      },
      occupations: ["AV女優"],
      imageUrl: "",
      imageAttribution: null,
      officialWebsite: definition.sourceUrl,
      socialLinks: facts.socialLinks,
      externalIds: { [`official-${definition.id}`]: definition.sourceUrl },
      wikidataId: "",
      wikipediaUrl: "",
      status: "auto-matched" as const,
      confidence: 0.98,
      fetchedAt: retrievedAt
    };
    const source: EntityProfileSource = {
      provider: definition.provider,
      title: `${facts.displayName} · ${definition.agency}公式プロフィール`,
      url: definition.sourceUrl,
      license: "unknown",
      language: "ja",
      fields,
      confidence: 0.98,
      retrievedAt,
      facts: {
        displayName: facts.displayName,
        ...(facts.romanizedName ? { romanizedName: facts.romanizedName } : {}),
        ...(facts.reading ? { reading: facts.reading } : {}),
        ...(facts.birthDate ? { birthDate: facts.birthDate } : {}),
        ...(facts.birthplace ? { birthplace: facts.birthplace } : {}),
        ...(facts.heightCm != null ? { heightCm: facts.heightCm } : {}),
        ...(Object.keys(facts.measurements).length ? { measurements: facts.measurements } : {}),
        ...(Object.keys(facts.socialLinks).length ? { socialLinks: facts.socialLinks } : {}),
        ...(facts.profileImageCandidateUrl ? { profileImageCandidateUrl: facts.profileImageCandidateUrl } : {}),
        ...(facts.sourceNotes.length ? { sourceNotes: facts.sourceNotes } : {}),
        ...facts.sourceOnlyFacts,
        agency: facts.agency,
        identityBridge: { officialName: facts.displayName, stableUrl: definition.sourceUrl }
      }
    };
    const decisionReason = "预核验的事务所稳定页面与官方日文名精确一致，按唯一身份桥自动合并";
    const preview: OfficialActorEnrichmentPreview = {
      actorValue: definition.actorValue,
      matched: true,
      profile,
      sources: [source],
      identityDecision: { method: "exact-rule", reason: decisionReason }
    };
    if (execute) persistOfficialProfile(definition, profile, source, decisionReason);
    return preview;
  } catch (error) {
    if (execute) recordEntityEnrichmentFailure("actor", definition.actorValue, definition.actorValue, error);
    throw error;
  }
}
