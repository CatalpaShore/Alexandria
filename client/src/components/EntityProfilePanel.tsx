import { getIntlLocale } from "../i18n/core";
import { useEffect, useState } from "react";
import { Tag } from "antd";
import { Building2, ExternalLink, Ruler, ShieldCheck, UserRound } from "lucide-react";
import type { EntityResponse } from "../lib/api";

type Profile = NonNullable<EntityResponse["profile"]>;

const SOCIAL_LABELS: Record<string, string> = {
  x: "X", instagram: "Instagram", youtube: "YouTube", tiktok: "TikTok"
};

const PROFILE_TITLES: Record<string, string> = {
  actor: "演员公开资料", director: "导演公开资料", maker: "厂商公开资料", label: "厂牌公开资料", series: "系列公开资料"
};

const GENERIC_FACT_LABELS: Record<string, string> = {
  agency: "所属事务所",
  romanizedName: "罗马字",
  reading: "读音",
  nameReading: "姓名读音",
  legalName: "本名",
  entityName: "来源标准名",
  organization: "所属机构",
  organizationName: "组织名称",
  provenanceAliases: "来源别名",
  identityCodes: "身份桥番号",
  occupation: "职业",
  selfDescribedRole: "本人自述身份",
  industrySince: "入行时间",
  birthYear: "出生年份",
  birthplace: "出生地",
  xHandle: "X 账号",
  sourceRole: "资料类型",
  avwikidbDirectorId: "AVWikiDB 导演 ID",
  avwikidbDirectorIds: "AVWikiDB 导演 ID",
  inceptionDate: "成立时间",
  headquarters: "总部",
  country: "所属国家",
  industry: "行业",
  parentOrganization: "母公司",
  legalForm: "组织形式",
  entityTypes: "实体类型",
  relatedMaker: "所属厂商",
  matchedLibraryWorkCount: "馆藏身份验证作品数",
  foundedYear: "成立年份",
  parentGroup: "所属集团",
  brandName: "品牌名",
  canonicalBrandName: "品牌标准名",
  brandPositioning: "品牌定位",
  businessActivities: "业务范围",
  founder: "创办者",
  formerName: "曾用名",
  independentSince: "独立运营时间",
  knownCatalogPrefix: "常见番号前缀",
  currentAffiliation: "当前所属"
};

function factDisplayValue(value: unknown): string {
  if (!Array.isArray(value)) return String(value);
  const visible = value.slice(0, 8).map(String).filter(Boolean);
  return `${visible.join("、")}${value.length > visible.length ? ` 等 ${value.length} 项` : ""}`;
}

function profileUpdatedCopy(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat(getIntlLocale(), { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function Fact({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value == null || value === "") return null;
  return <div className="entity-profile-fact"><span>{label}</span><strong>{value}</strong></div>;
}

function statusCopy(status: Profile["status"]): { label: string; color: string } {
  if (status === "verified") return { label: "来源一致，高置信", color: "success" };
  if (status === "auto-resolved") return { label: "来源存在差异，已自动择优", color: "warning" };
  if (status === "auto-matched") return { label: "公开实体自动匹配", color: "gold" };
  return { label: "未形成可靠匹配", color: "default" };
}

function sourceFactCopy(source: Profile["sources"][number]): string {
  const facts = source.facts;
  if (!facts) return "";
  const dimensions = [facts.measurements?.bustCm, facts.measurements?.waistCm, facts.measurements?.hipsCm];
  return [
    facts.birthDate || "",
    facts.heightCm ? `${facts.heightCm} cm` : "",
    dimensions.every((value) => value != null) ? `${dimensions.join("/")} cm` : "",
    facts.measurements?.cup ? `${facts.measurements.cup} 杯` : ""
  ].filter(Boolean).join(" · ");
}

function imageRightsCopy(attribution: NonNullable<Profile["imageAttribution"]>): string {
  if (attribution.rightsStatus === "restricted" || attribution.rightsStatus === "unknown") return "";
  if (!attribution.license || attribution.license.trim().toLowerCase() === "unknown") return "";
  if (attribution.rightsStatus === "public-domain") return attribution.license || "公有领域";
  return attribution.license || "来源许可";
}

function imageSourceCopy(type: Profile["type"], attribution: NonNullable<Profile["imageAttribution"]>): string {
  try {
    if (new URL(attribution.sourceUrl).hostname === "commons.wikimedia.org") return "Wikimedia Commons";
    if (type === "actor") return "官方人物页";
    if (type === "maker") return "官方品牌页";
    if (type === "label") return "官方厂牌页";
    return "官方资料页";
  } catch {
    return type === "actor" ? "官方人物页" : "官方资料页";
  }
}

function profileAliases(profile: Profile): string[] {
  const displayKey = profile.displayName.normalize("NFKC").trim().toLocaleLowerCase("ja");
  const seen = new Set<string>();
  return [...profile.aliases, ...Object.values(profile.names)].filter((value) => {
    const trimmed = value.trim();
    const key = trimmed.normalize("NFKC").toLocaleLowerCase("ja");
    if (!trimmed || key === displayKey || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);
}

export function EntityProfilePanel({ profile }: { profile: Profile }) {
  const [portraitFailed, setPortraitFailed] = useState(false);
  useEffect(() => setPortraitFailed(false), [profile.imageUrl]);
  const entityTypes = Array.isArray(profile.facts.entityTypes) ? profile.facts.entityTypes : [];
  const isOrganization = profile.facts.entityKind === "organization"
    || entityTypes.some((value) => ["组织", "编辑部", "organization"].includes(value.toLocaleLowerCase("ja")));
  const ProfileIcon = isOrganization ? Building2 : UserRound;
  const status = statusCopy(profile.status);
  const dimensions = [profile.measurements.bustCm, profile.measurements.waistCm, profile.measurements.hipsCm];
  const hasDimensions = dimensions.every((value) => value != null);
  const externalIdLinks = Object.entries(profile.externalIds).flatMap(([key, value]) => {
    if (key === "imdb" && /^nm\d+$/u.test(value)) return [{ key: `external-${key}`, label: "IMDb", url: `https://www.imdb.com/name/${value}/` }];
    if ((key === "avwikidb" || key === "avwikidbAlternate") && /^\d+$/u.test(value)) return [{
      key: `external-${key}`, label: key === "avwikidb" ? "AVWikiDB" : "AVWikiDB（别名记录）",
      url: `https://avwikidb.com/director/${value}/`
    }];
    if (key === "javdatabase" && /^[a-z0-9-]+$/iu.test(value)) return [{
      key: `external-${key}`, label: "JAVDatabase", url: `https://www.javdatabase.com/directors/${value}/`
    }];
    if (key === "allcinema" && /^\d+$/u.test(value)) return [{
      key: `external-${key}`, label: "allcinema", url: `https://www.allcinema.net/person/${value}`
    }];
    return [];
  });
  const factXHandle = typeof profile.facts.xHandle === "string"
    ? profile.facts.xHandle.replace(/^@/u, "") : "";
  const factLinks = /^[A-Za-z0-9_]{1,15}$/u.test(factXHandle)
    ? [{ key: "fact-x", label: "X", url: `https://x.com/${factXHandle}` }] : [];
  const externalLinks = ([
    profile.wikipediaUrl ? { key: "wikipedia", label: "Wikipedia", url: profile.wikipediaUrl } : null,
    profile.wikidataId ? { key: "wikidata", label: "Wikidata", url: `https://www.wikidata.org/wiki/${profile.wikidataId}` } : null,
    profile.officialWebsite ? { key: "website", label: "官方网站", url: profile.officialWebsite } : null,
    ...Object.entries(profile.socialLinks).map(([key, url]) => ({ key, label: SOCIAL_LABELS[key] ?? key, url })),
    ...externalIdLinks,
    ...factLinks
  ].filter((item): item is { key: string; label: string; url: string } => Boolean(item)))
    .filter((item, index, items) => items.findIndex((candidate) => candidate.url === item.url) === index);
  const genericFacts = Object.entries(profile.facts ?? {})
    .filter(([key, value]) => GENERIC_FACT_LABELS[key] && (Array.isArray(value) ? value.length : Boolean(value)))
    .map(([key, value]) => ({
      label: GENERIC_FACT_LABELS[key],
      value: factDisplayValue(value)
    }));
  const imageRights = profile.imageAttribution ? imageRightsCopy(profile.imageAttribution) : "";
  const showPortrait = !isOrganization && Boolean(profile.imageUrl && profile.imageAttribution) && !portraitFailed;
  const aliases = profileAliases(profile);
  const updatedCopy = profileUpdatedCopy(profile.updatedAt);
  const visibleSources = profile.sources.filter((source, index, sources) =>
    sources.findIndex((candidate) => candidate.url === source.url) === index);

  return <section className="entity-profile" aria-label={`${profile.displayName}扩展资料`}>
    <header className="entity-profile-header">
      <div><ProfileIcon size={16} /><strong>{isOrganization ? "组织公开资料" : PROFILE_TITLES[profile.type] ?? "公开资料"}</strong></div>
      <span>
        <Tag color={status.color}>{status.label}</Tag>
        <small>置信度 {Math.round(profile.confidence * 100)}%</small>
      </span>
    </header>
    <div className={`entity-profile-body${showPortrait ? " entity-profile-body--with-portrait" : ""}`}>
      {showPortrait && profile.imageUrl && profile.imageAttribution && <figure className="entity-profile-portrait-wrap">
        <img
          alt={`${profile.displayName}公开资料图片`}
          className="entity-profile-portrait"
          loading="lazy"
          onError={() => setPortraitFailed(true)}
          referrerPolicy="no-referrer"
          src={profile.imageUrl}
        />
        <figcaption>
          <span>图片：</span>
          {profile.imageAttribution.creatorUrl
            ? <a href={profile.imageAttribution.creatorUrl} rel="noreferrer" target="_blank">{profile.imageAttribution.creator}</a>
            : <span>{profile.imageAttribution.creator}</span>}
          <span> / </span>
          <a href={profile.imageAttribution.sourceUrl} rel="noreferrer" target="_blank">
            {imageSourceCopy(profile.type, profile.imageAttribution)}
          </a>
          {imageRights && <>
            <span> / </span>
            {profile.imageAttribution.licenseUrl
              ? <a href={profile.imageAttribution.licenseUrl} rel="noreferrer" target="_blank">{imageRights}</a>
              : <span>{imageRights}</span>}
          </>}
          {profile.imageAttribution.attributionText && profile.imageAttribution.attributionText !== profile.imageAttribution.creator &&
            <><span> · </span><span>{profile.imageAttribution.attributionText}</span></>}
          {profile.imageAttribution.credit && profile.imageAttribution.credit !== profile.imageAttribution.attributionText &&
            profile.imageAttribution.credit !== profile.imageAttribution.creator &&
            <><span> · </span><span>{profile.imageAttribution.credit}</span></>}
        </figcaption>
      </figure>}
      <div className="entity-profile-content">
        <div className="entity-profile-facts">
          <Fact label="日文原名" value={profile.originalName && profile.originalName !== profile.displayName
            ? profile.originalName : null} />
          <Fact label="出生日期" value={profile.birthDate} />
          <Fact label="出生地" value={profile.birthplace} />
          <Fact label="国籍" value={profile.nationality} />
          <Fact label="身高" value={profile.heightCm ? `${profile.heightCm} cm` : null} />
          <Fact label="三围" value={hasDimensions ? `${dimensions.join(" / ")} cm` : null} />
          <Fact label="罩杯" value={profile.measurements.cup} />
          {genericFacts.map((fact) => <Fact key={fact.label} label={fact.label} value={fact.value} />)}
        </div>
        {profile.occupations.length > 0 && <div className="entity-profile-occupations">
          {profile.occupations.map((occupation) => <Tag key={occupation}>{occupation}</Tag>)}
        </div>}
        {aliases.length > 0 && <div className="entity-profile-aliases">
          <span>别名</span>
          <div>{aliases.map((alias) => <Tag key={alias}>{alias}</Tag>)}</div>
        </div>}
        {profile.biography && <p className="entity-profile-biography">{profile.biography}</p>}
        {externalLinks.length > 0 && <div className="entity-profile-links">
          {externalLinks.map((item) => <a href={item.url} key={item.key} rel="noreferrer" target="_blank">
            {item.label}<ExternalLink size={11} />
          </a>)}
        </div>}
      </div>
    </div>
    <footer className="entity-profile-sources">
      <div><ShieldCheck size={13} /><span>资料来源</span></div>
      <div>{visibleSources.map((source) => <a href={source.url} key={`${source.provider}:${source.url}`} rel="noreferrer" target="_blank">
        {source.title}{source.license && source.license !== "unknown" && <small>{source.license}</small>}
        {sourceFactCopy(source) && <em>{sourceFactCopy(source)}</em>}
      </a>)}</div>
      <span><Ruler size={12} />{updatedCopy ? `资料更新 ${updatedCopy} · ` : ""}缺失字段会保持为空，不由模型猜测</span>
    </footer>
  </section>;
}
