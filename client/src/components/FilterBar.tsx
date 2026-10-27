import { getIntlLocale } from "../i18n/core";
import { t, useLocale, useLocalizedMemo } from "../i18n";
import { Button, Card, Checkbox, Input, Select, Switch, Tag, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import {
  ArrowDownAZ,
  Building2,
  Check,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Factory,
  Film,
  FolderTree,
  Hash,
  ImageIcon,
  Layers3,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Tags,
  UserRound,
  X
} from "lucide-react";
import { getPosterUrl, type Facet, type MediaQuery } from "../lib/api";
import type { MetadataLanguage } from "../lib/metadataDisplay";

export type FilterBarProps = {
  query: MediaQuery;
  metadataLanguage: MetadataLanguage;
  letters: Facet[];
  categories: Facet[];
  prefixes: Facet[];
  buckets: Facet[];
  actors: Facet[];
  genres: Facet[];
  directors: Facet[];
  makers: Facet[];
  labels: Facet[];
  metadataSeries: Facet[];
  onChange: (patch: Partial<MediaQuery>) => void;
  railMode?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
};

type MultiFilterKey = "actor" | "genre" | "director" | "maker" | "label" | "metadataSeries";
const FACET_SCROLL_BATCH_SIZE = 40;
type FilterSection = "category" | "actor" | "genre" | "metadataSeries" | "prefix" | "index" | "advanced";

type ActiveFilterStripProps = Pick<
  FilterBarProps,
  | "query"
  | "metadataLanguage"
  | "actors"
  | "genres"
  | "directors"
  | "makers"
  | "labels"
  | "metadataSeries"
  | "onChange"
>;

type ActiveFilterItem = {
  key: string;
  label: string;
  patch: Partial<MediaQuery>;
  section: FilterSection;
};

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const digits = "0123456789".split("");
const { Text, Title } = Typography;

function countFor(items: Facet[], value: string): number {
  return items.find((item) => item.value === value)?.count ?? 0;
}

function getFacetDisplayValue(item: Facet | undefined, language: MetadataLanguage, fallback: string): string {
  const valueZh = item?.valueZh?.trim();
  return language === "zh" && valueZh ? valueZh : item?.value || fallback;
}

function buildMultiOptions(items: Facet[], language: MetadataLanguage) {
  return items.filter((item) => item.value).map((item) => {
    const displayValue = getFacetDisplayValue(item, language, item.value);
    const originalSuffix = language === "zh" && displayValue !== item.value ? ` · ${item.value}` : "";
    return {
      value: item.value,
      label: `${displayValue}${originalSuffix} (${item.count.toLocaleString(getIntlLocale())})`,
      searchText: [item.value, item.valueZh].filter(Boolean).join(" "),
      mediaId: item.mediaId,
      imageUrl: item.imageUrl,
      displayValue,
      originalValue: language === "zh" && displayValue !== item.value ? item.value : "",
      count: item.count
    };
  });
}

function FacetArtwork({ item, type }: { item: Facet; type: MultiFilterKey | "category" | "prefix" }) {
  useLocale();
  const posterUrl = item.mediaId ? getPosterUrl(item.mediaId, "card") : "";
  const sources = useLocalizedMemo(() => [...new Set([item.imageUrl, posterUrl].filter(Boolean))] as string[], [item.imageUrl, posterUrl]);
  const [sourceIndex, setSourceIndex] = useState(0);

  useEffect(() => setSourceIndex(0), [item.value, sources.length]);

  const source = sources[sourceIndex];
  const fallback = type === "actor" ? <UserRound size={15} />
    : type === "prefix" ? <Hash size={15} />
    : type === "category" ? <FolderTree size={15} />
    : type === "genre" ? <Tags size={15} />
    : type === "metadataSeries" ? <Film size={15} />
    : type === "director" ? <Clapperboard size={15} />
    : type === "maker" ? <Factory size={15} />
    : type === "label" ? <Building2 size={15} />
    : <ImageIcon size={15} />;

  return <span className={`filter-facet-artwork is-${type}`} aria-hidden="true">
    {source
      ? <img alt="" decoding="async" loading="lazy" onError={() => setSourceIndex((current) => current + 1)} referrerPolicy="no-referrer" src={source} />
      : fallback}
  </span>;
}

function FacetScrollingName({ primary, secondary }: { primary: string; secondary?: string }) {
  useLocale();
  const nameRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (nameRef.current) prepareFacetTextScroll(nameRef.current);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [primary, secondary]);

  return (
    <span className="filter-facet-name" ref={nameRef} title={secondary ? `${primary}\n${secondary}` : primary}>
      <span className="filter-facet-line">
        <span className="filter-facet-line-track">{primary}</span>
      </span>
      {secondary && (
        <small className="filter-facet-line">
          <span className="filter-facet-line-track">{secondary}</span>
        </small>
      )}
    </span>
  );
}

function prepareFacetTextScroll(row: HTMLElement) {
  row.querySelectorAll<HTMLElement>(".filter-facet-line").forEach((line) => {
    const track = line.querySelector<HTMLElement>(".filter-facet-line-track");
    if (!track) return;
    const travel = Math.max(0, Math.ceil(track.scrollWidth - line.clientWidth));
    line.classList.toggle("is-overflowing", travel > 2);
    line.style.setProperty("--filter-text-travel", `${travel}px`);
    line.style.setProperty("--filter-text-duration", `${Math.min(12, Math.max(4, 3 + travel / 35)).toFixed(1)}s`);
  });
}

function selectFilterOption(input: string, option?: { label?: unknown; value?: unknown; searchText?: unknown }) {
  const text = [option?.label, option?.value, option?.searchText]
    .map((value) => String(value ?? ""))
    .join(" ")
    .toLowerCase();
  return text.includes(input.trim().toLowerCase());
}

function activeFilterCount(query: MediaQuery): number {
  return [
    query.category !== "ALL",
    query.letter !== "ALL",
    query.bucket !== "ALL",
    query.prefix !== "ALL"
  ].filter(Boolean).length + query.actor.length + query.genre.length + query.director.length
    + query.maker.length + query.label.length + query.metadataSeries.length;
}

function clearFilterPatch(): Partial<MediaQuery> {
  return {
    category: "ALL",
    letter: "ALL",
    bucket: "ALL",
    source: "ALL",
    prefix: "ALL",
    tag: "ALL",
    actor: [],
    genre: [],
    director: [],
    maker: [],
    label: [],
    metadataSeries: [],
    extension: "ALL",
    mediaType: "ALL",
    page: 1
  };
}

function buildActiveFilterItems({
  query,
  metadataLanguage,
  actors,
  genres,
  directors,
  makers,
  labels,
  metadataSeries
}: Omit<ActiveFilterStripProps, "onChange">): ActiveFilterItem[] {
  const scalarFilters: ActiveFilterItem[] = [];
  if (query.category !== "ALL") {
    scalarFilters.push({
      key: "category",
      label: t("分类 · {{p0}}", { p0: query.category }),
      patch: { category: "ALL", letter: "ALL", bucket: "ALL" },
      section: "category"
    });
  }
  if (query.letter !== "ALL") {
    scalarFilters.push({ key: "letter", label: t("索引 · {{p0}}", { p0: query.letter }), patch: { letter: "ALL" }, section: "index" });
  }
  if (query.bucket !== "ALL") {
    scalarFilters.push({ key: "bucket", label: t("索引 · {{p0}}", { p0: query.bucket }), patch: { bucket: "ALL" }, section: "index" });
  }
  if (query.prefix !== "ALL") {
    scalarFilters.push({ key: "prefix", label: t("番号 · {{p0}}", { p0: query.prefix }), patch: { prefix: "ALL" }, section: "prefix" });
  }

  const multiFilters = [
    { key: "actor" as const, label: t("演员"), values: query.actor, items: actors, section: "actor" as const },
    { key: "genre" as const, label: t("标签"), values: query.genre, items: genres, section: "genre" as const },
    {
      key: "metadataSeries" as const,
      label: t("系列"),
      values: query.metadataSeries,
      items: metadataSeries,
      section: "metadataSeries" as const
    },
    { key: "director" as const, label: t("导演"), values: query.director, items: directors, section: "advanced" as const },
    { key: "maker" as const, label: t("厂商"), values: query.maker, items: makers, section: "advanced" as const },
    { key: "label" as const, label: t("厂牌"), values: query.label, items: labels, section: "advanced" as const }
  ].flatMap((filter) => filter.values.map((value) => ({
    key: `${filter.key}:${value}`,
    label: `${filter.label} · ${getFacetDisplayValue(filter.items.find((item) => item.value === value), metadataLanguage, value)}`,
    patch: { [filter.key]: query[filter.key].filter((current) => current !== value) } as Partial<MediaQuery>,
    section: filter.section
  })));

  return [...scalarFilters, ...multiFilters];
}

export function FilterActiveStrip({
  query,
  metadataLanguage,
  actors,
  genres,
  directors,
  makers,
  labels,
  metadataSeries,
  onChange
}: ActiveFilterStripProps) {
  useLocale();
  const activeItems = buildActiveFilterItems({
    query,
    metadataLanguage,
    actors,
    genres,
    directors,
    makers,
    labels,
    metadataSeries
  });

  if (activeItems.length === 0) return null;

  return (
    <div className="filter-active-strip motion-expand-region" aria-label={t("当前筛选条件")}>
      <Text className="filter-active-strip-label">{t("已选条件")}</Text>
      <div className="filter-active-strip-tags">
        {activeItems.map((item) => (
          <Tag
            className="filter-active-strip-tag motion-list-item"
            closable
            key={item.key}
            onClose={(event) => {
              event.preventDefault();
              onChange({ ...item.patch, page: 1 });
            }}
          >
            {item.label}
          </Tag>
        ))}
      </div>
      <Button className="filter-active-strip-clear" onClick={() => onChange(clearFilterPatch())} type="text">
        {t("清空全部")} </Button>
    </div>
  );
}

export function FilterBar({
  query,
  metadataLanguage,
  letters,
  categories,
  prefixes,
  buckets,
  actors,
  genres,
  directors,
  makers,
  labels,
  metadataSeries,
  onChange,
  railMode = false,
  expanded = true,
  onExpandedChange
}: FilterBarProps) {
  useLocale();
  const [activeSection, setActiveSection] = useState<FilterSection>("actor");
  const [searchValue, setSearchValue] = useState("");
  const flyoutRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!flyoutRef.current) return;
    flyoutRef.current.toggleAttribute("inert", !expanded);
  }, [expanded]);
  const isFc2 = query.category === "FC2";
  const activeIndex = isFc2 ? query.bucket : query.letter;
  const activeCount = activeFilterCount(query);
  const categoryItems = [
    { value: "ALL", label: t("全部"), count: categories.reduce((sum, category) => sum + category.count, 0) },
    ...categories.map((category) => ({
      value: category.value,
      label: category.value,
      count: category.count,
      mediaId: category.mediaId,
      imageUrl: category.imageUrl
    }))
  ];
  const metadataSections: Record<MultiFilterKey, { label: string; items: Facet[] }> = {
    actor: { label: t("演员"), items: actors },
    genre: { label: t("标签"), items: genres },
    metadataSeries: { label: t("系列"), items: metadataSeries },
    director: { label: t("导演"), items: directors },
    maker: { label: t("厂商"), items: makers },
    label: { label: t("厂牌"), items: labels }
  };
  const sectionTitles: Record<FilterSection, string> = {
    category: "选择分类",
    actor: t("选择演员"),
    genre: t("选择标签"),
    metadataSeries: t("选择系列"),
    prefix: t("番号与版本"),
    index: isFc2 ? t("数字索引") : t("字母索引"),
    advanced: t("更多筛选")
  };
  const railItems = [
    { key: "category" as const, label: t("分类"), icon: <FolderTree size={20} /> },
    { key: "actor" as const, label: t("演员"), icon: <UserRound size={20} /> },
    { key: "genre" as const, label: t("标签"), icon: <Tags size={20} /> },
    { key: "metadataSeries" as const, label: t("系列"), icon: <Film size={20} /> },
    { key: "prefix" as const, label: t("番号"), icon: <Hash size={20} /> },
    { key: "index" as const, label: t("索引"), icon: <ArrowDownAZ size={20} /> },
    { key: "advanced" as const, label: t("更多"), icon: <SlidersHorizontal size={20} /> }
  ];
  const activeItems = buildActiveFilterItems({
    query,
    metadataLanguage,
    actors,
    genres,
    directors,
    makers,
    labels,
    metadataSeries
  });
  const sectionCounts: Record<FilterSection, number> = {
    category: query.category === "ALL" ? 0 : 1,
    actor: query.actor.length,
    genre: query.genre.length,
    metadataSeries: query.metadataSeries.length,
    prefix: query.prefix === "ALL" ? 0 : 1,
    index: activeIndex === "ALL" ? 0 : 1,
    advanced: query.director.length + query.maker.length + query.label.length
  };
  const currentMultiKey = (["actor", "genre", "metadataSeries"] as FilterSection[]).includes(activeSection)
    ? activeSection as MultiFilterKey
    : null;
  const currentMetadata = currentMultiKey ? metadataSections[currentMultiKey] : null;
  const matchingFacets = useLocalizedMemo(() => {
    if (!currentMetadata) return [];
    const search = searchValue.trim().toLowerCase();
    return currentMetadata.items
      .filter((item) => !search || [item.value, item.valueZh].filter(Boolean).join(" ").toLowerCase().includes(search));
  }, [currentMetadata, searchValue]);
  const matchingPrefixes = useLocalizedMemo(() => {
    const search = searchValue.trim().toLowerCase();
    return prefixes
      .filter((item) => item.value && (!search || item.value.toLowerCase().includes(search)));
  }, [prefixes, searchValue]);
  const [visibleOptionCount, setVisibleOptionCount] = useState(FACET_SCROLL_BATCH_SIZE);
  const loadMoreOptionsRef = useRef<HTMLDivElement>(null);
  const scrollableOptionCount = currentMultiKey
    ? matchingFacets.length
    : activeSection === "prefix" ? matchingPrefixes.length : 0;
  const visibleFacets = useLocalizedMemo(
    () => matchingFacets.slice(0, visibleOptionCount),
    [matchingFacets, visibleOptionCount]
  );
  const visiblePrefixes = useLocalizedMemo(
    () => matchingPrefixes.slice(0, visibleOptionCount),
    [matchingPrefixes, visibleOptionCount]
  );

  useEffect(() => {
    setVisibleOptionCount(FACET_SCROLL_BATCH_SIZE);
  }, [activeSection, searchValue]);

  useEffect(() => {
    const target = loadMoreOptionsRef.current;
    if (!target || visibleOptionCount >= scrollableOptionCount) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setVisibleOptionCount((current) => Math.min(current + FACET_SCROLL_BATCH_SIZE, scrollableOptionCount));
    }, { rootMargin: "240px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [scrollableOptionCount, visibleOptionCount]);

  function renderLoadMoreStatus(visibleCount: number, totalCount: number) {
    if (visibleCount >= totalCount) return null;
    return (
      <div className="filter-facet-load-more" ref={loadMoreOptionsRef}>
        <span>{t("继续向下滚动")}</span>
        <small>{t("已显示")} {visibleCount.toLocaleString(getIntlLocale())} / {totalCount.toLocaleString(getIntlLocale())}</small>
      </div>
    );
  }

  function activateSection(section: FilterSection) {
    setSearchValue("");
    if (railMode && activeSection === section && expanded) {
      onExpandedChange?.(false);
      return;
    }
    focusSection(section);
  }

  function focusSection(section: FilterSection) {
    setSearchValue("");
    setActiveSection(section);
    onExpandedChange?.(true);
  }

  function changeCategory(value: string) {
    onChange({
      category: value,
      letter: "ALL",
      bucket: "ALL",
      source: "ALL",
      prefix: "ALL",
      tag: "ALL",
      actor: [],
      genre: [],
      director: [],
      maker: [],
      label: [],
      metadataSeries: [],
      page: 1
    });
  }

  function toggleMultiValue(key: MultiFilterKey, value: string) {
    const currentValues = query[key];
    onChange({
      [key]: currentValues.includes(value)
        ? currentValues.filter((current) => current !== value)
        : [...currentValues, value],
      page: 1
    });
  }

  function renderMetadataPanel(key: MultiFilterKey) {
    const section = metadataSections[key];
    const selectedValues = query[key];
    return (
      <>
        <Input
          allowClear
          className="filter-flyout-search"
          onChange={(event) => setSearchValue(event.target.value)}
          placeholder={t("搜索{{p0}}", { p0: section.label })}
          prefix={<Search size={16} />}
          value={searchValue}
        />
        <div className="filter-flyout-subhead filter-flyout-list-title">
            <Text strong>{searchValue ? t("搜索结果") : t("全部{{p0}} · 热门优先", { p0: section.label })}</Text>
          <Text type="secondary">
            {searchValue
              ? t("{{p0}} 项", { p0: matchingFacets.length.toLocaleString(getIntlLocale()) })
              : t("共 {{p0}} 项", { p0: section.items.length.toLocaleString(getIntlLocale()) })}
          </Text>
        </div>
        <div className="filter-facet-list motion-tab-panel" key={`${key}:${searchValue}`}>
          {visibleFacets.map((item) => {
            const checked = selectedValues.includes(item.value);
            return (
              <label
                className={`filter-facet-row motion-pressable${checked ? " is-selected" : ""}`}
                key={item.value}
                onMouseEnter={(event) => prepareFacetTextScroll(event.currentTarget)}
              >
                <Checkbox checked={checked} onChange={() => toggleMultiValue(key, item.value)} />
                <FacetArtwork item={item} type={key} />
                <FacetScrollingName
                  primary={getFacetDisplayValue(item, metadataLanguage, item.value)}
                  secondary={metadataLanguage === "zh" && item.valueZh && item.valueZh !== item.value ? item.value : undefined}
                />
                <span className="filter-facet-count">{item.count.toLocaleString(getIntlLocale())}</span>
              </label>
            );
          })}
          {renderLoadMoreStatus(visibleFacets.length, matchingFacets.length)}
          {visibleFacets.length === 0 && <div className="filter-facet-empty">{t("没有匹配的筛选项")}</div>}
        </div>
      </>
    );
  }

  function renderPanelBody() {
    if (currentMultiKey) return renderMetadataPanel(currentMultiKey);
    if (activeSection === "category") {
      return (
        <div className="filter-category-list motion-tab-panel" role="group" aria-label={t("媒体分类")}>
          {categoryItems.map((category) => (
            <button
              aria-pressed={query.category === category.value}
              className={`filter-category-row motion-pressable${query.category === category.value ? " is-selected" : ""}`}
              key={category.value}
              onMouseEnter={(event) => prepareFacetTextScroll(event.currentTarget)}
              onClick={() => changeCategory(category.value)}
              type="button"
            >
              <FacetArtwork item={category} type="category" />
              <FacetScrollingName primary={category.label} />
              <strong>{category.count.toLocaleString(getIntlLocale())}</strong>
              {query.category === category.value && <Check size={17} />}
            </button>
          ))}
        </div>
      );
    }
    if (activeSection === "prefix") {
      const prefixTotal = prefixes.reduce((sum, item) => sum + item.count, 0);
      return (
        <div className="filter-prefix-panel">
          <Input
            allowClear
            className="filter-flyout-search"
            onChange={(event) => setSearchValue(event.target.value)}
            placeholder={t("搜索番号")}
            prefix={<Search size={16} />}
            value={searchValue}
          />
          <div className="filter-flyout-subhead filter-flyout-list-title">
            <Text strong>{searchValue ? t("搜索结果") : t("全部番号 · 热门优先")}</Text>
            <Text type="secondary">{matchingPrefixes.length.toLocaleString(getIntlLocale())} {t("项")}</Text>
          </div>
          <div className="filter-facet-list" role="group" aria-label={t("番号选择")}>
            {!searchValue && (
                <label
                  className={`filter-facet-row${query.prefix === "ALL" ? " is-selected" : ""}`}
                  onMouseEnter={(event) => prepareFacetTextScroll(event.currentTarget)}
                >
                  <Checkbox checked={query.prefix === "ALL"} onChange={() => onChange({ prefix: "ALL", page: 1 })} />
                  <FacetArtwork item={{ value: "ALL", count: prefixTotal }} type="prefix" />
                  <FacetScrollingName primary={t("全部番号")} />
                <span className="filter-facet-count">{prefixTotal.toLocaleString(getIntlLocale())}</span>
              </label>
            )}
            {visiblePrefixes.map((item) => {
              const checked = query.prefix === item.value;
              return (
                <label
                  className={`filter-facet-row${checked ? " is-selected" : ""}`}
                  key={item.value}
                  onMouseEnter={(event) => prepareFacetTextScroll(event.currentTarget)}
                >
                  <Checkbox checked={checked} onChange={() => onChange({ prefix: checked ? "ALL" : item.value, page: 1 })} />
                  <FacetArtwork item={item} type="prefix" />
                  <FacetScrollingName primary={item.value} />
                  <span className="filter-facet-count">{item.count.toLocaleString(getIntlLocale())}</span>
                </label>
              );
            })}
            {renderLoadMoreStatus(visiblePrefixes.length, matchingPrefixes.length)}
            {visiblePrefixes.length === 0 && <div className="filter-facet-empty">{t("没有匹配的番号")}</div>}
          </div>
          <label className="filter-version-row">
            <span><Layers3 size={16} /> {t("同番号版本聚合")}</span>
            <Switch checked={query.groupVersions} onChange={(checked) => onChange({ groupVersions: checked, page: 1 })} />
          </label>
        </div>
      );
    }
    if (activeSection === "index") {
      const indexItems = isFc2 ? digits : ["#", ...alphabet];
      return (
        <div className="filter-index-panel">
          <Button
            className="filter-index-all"
            onClick={() => isFc2 ? onChange({ bucket: "ALL", page: 1 }) : onChange({ letter: "ALL", page: 1 })}
            type={activeIndex === "ALL" ? "primary" : "default"}
          >
            {t("全部索引")} </Button>
          <div className="filter-index-grid">
            {indexItems.map((value) => (
              <Button
                disabled={value !== "#" && countFor(isFc2 ? buckets : letters, value) === 0}
                key={value}
                onClick={() => isFc2 ? onChange({ bucket: value, page: 1 }) : onChange({ letter: value, page: 1 })}
                type={activeIndex === value ? "primary" : "default"}
              >
                {value}
              </Button>
            ))}
          </div>
        </div>
      );
    }
    return (
      <div className="filter-form-stack">
        {([
          ["director", t("导演"), <Clapperboard size={15} />],
          ["maker", t("厂商"), <Factory size={15} />],
          ["label", t("厂牌"), <Building2 size={15} />]
        ] as const).map(([key, label, icon]) => (
          <label className="filter-form-field" key={key}>
            <span>{icon} {label}</span>
            <Select
              allowClear
              showSearch
              className="filter-select"
              filterOption={selectFilterOption}
              maxTagCount="responsive"
              mode="multiple"
              onChange={(value) => onChange({ [key]: value, page: 1 })}
              options={buildMultiOptions(metadataSections[key].items, metadataLanguage)}
              optionRender={(option) => {
                const data = option.data as Facet & { displayValue?: string; originalValue?: string };
                return <div className="filter-select-option">
                  <FacetArtwork item={data} type={key} />
                  <span><strong>{data.displayValue ?? data.value}</strong>{data.originalValue && <small>{data.originalValue}</small>}</span>
                  <em>{data.count?.toLocaleString(getIntlLocale())}</em>
                </div>;
              }}
              placeholder={t("搜索{{p0}}", { p0: label })}
              popupMatchSelectWidth={320}
              value={query[key]}
            />
          </label>
        ))}
      </div>
    );
  }

  return (
    <Card className={`filter-panel filter-workbench${railMode ? " is-rail-mode" : " is-drawer-mode"}${expanded ? " is-expanded" : " is-collapsed"}`} variant="borderless">
      <div className="filter-workbench-inner">
        <nav className="filter-rail" aria-label={t("筛选维度")}>
          <button
            aria-label={expanded ? t("收起筛选面板") : t("展开筛选面板")}
            className="filter-rail-master"
            onClick={() => onExpandedChange?.(!expanded)}
            type="button"
          >
            <SlidersHorizontal size={22} />
            {activeCount > 0 && <span>{activeCount}</span>}
          </button>
          <div className="filter-rail-items">
            {railItems.map((item) => (
              <button
                aria-current={activeSection === item.key ? "page" : undefined}
                className={`filter-rail-item${activeSection === item.key ? " is-active" : ""}`}
                key={item.key}
                onClick={() => activateSection(item.key)}
                type="button"
              >
                {item.icon}
                <span>{item.label}</span>
                {sectionCounts[item.key] > 0 && (
                  <span className="filter-rail-item-count">{sectionCounts[item.key]}</span>
                )}
              </button>
            ))}
          </div>
          <div className="filter-rail-footer">
            <button disabled={activeCount === 0} onClick={() => onChange(clearFilterPatch())} type="button">
              <RotateCcw size={18} />
              <span>{t("重置")}</span>
            </button>
            {railMode && (
              <button onClick={() => onExpandedChange?.(!expanded)} type="button">
                {expanded ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
                <span>{expanded ? t("收起") : t("展开")}</span>
              </button>
            )}
          </div>
        </nav>

        <section
          aria-hidden={!expanded}
          aria-label={sectionTitles[activeSection]}
          className="filter-flyout"
          ref={flyoutRef}
        >
            <header className="filter-flyout-header">
              <div>
                <Title level={4}>{sectionTitles[activeSection]}</Title>
                <Text type="secondary">{t("筛选后结果会实时更新")}</Text>
              </div>
              {railMode && (
                <Button aria-label={t("关闭筛选面板")} icon={<X size={18} />} onClick={() => onExpandedChange?.(false)} type="text" />
              )}
            </header>
            {activeItems.length > 0 && (
              <div className="filter-global-selection" aria-label={t("全部已选筛选条件")}>
                <div className="filter-global-selection-head">
                  <Text strong>{t("当前已选 ·")} {activeItems.length}</Text>
                  <Button onClick={() => onChange(clearFilterPatch())} size="small" type="text">{t("清空全部")}</Button>
                </div>
                <div className="filter-global-selection-tags">
                  {activeItems.map((item) => (
                    <Tag
                      className={`filter-global-selection-tag${activeSection === item.section ? " is-current" : ""}`}
                      closable
                      key={item.key}
                      onClick={() => focusSection(item.section)}
                      onClose={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onChange({ ...item.patch, page: 1 });
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") focusSection(item.section);
                      }}
                      role="button"
                      tabIndex={0}
                    >
                      {item.label}
                    </Tag>
                  ))}
                </div>
              </div>
            )}
            <div className="filter-flyout-body" key={activeSection}>{renderPanelBody()}</div>
            <footer className="filter-flyout-footer">
              <Button
                block
                icon={<Check size={17} />}
                onClick={() => onExpandedChange?.(false)}
                type="primary"
              >
                {activeCount > 0 ? t("完成 · {{p0}} 个条件", { p0: activeCount }) : t("完成筛选")}
              </Button>
            </footer>
        </section>
      </div>
    </Card>
  );
}
