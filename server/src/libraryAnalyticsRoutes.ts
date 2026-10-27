import type { Express } from "express";
import { z } from "zod";
import { isActorNameCandidate } from "./actorAliases.js";
import { db } from "./db.js";
import {getLibraryPrefixAnalytics} from "./libraryPrefixAnalytics.js";
import {getPrefixTotals,savePrefixTotal} from "./libraryPrefixTotals.js";
import { getTopicGraphItems, getTopicLabel, isTopicVisible, type TopicType } from "./productRoutes.js";

type NumericRow = Record<string, number | string | null>;

type DistributionRow = {
  key: string;
  label: string;
  files: number;
  works: number;
  bytes: number;
};

type FacetAnalytics = {
  distinctValues: number;
  coveredWorks: number;
  totalAssignments: number;
  items: Array<{
    value: string;
    label: string;
    works: number;
    files: number;
    bytes: number;
    averageScore: number;
    scoredWorks: number;
    averageRuntimeMinutes: number;
    latestReleaseDate: string | null;
  }>;
};

const ANALYTICS_FACET_TYPES = ["actor", "genre", "series", "maker", "label", "director"] as const;
const ANALYTICS_CACHE_VERSION = "v5-prefix-collection-normalized";
const ANALYTICS_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_MEMORY_CACHE_ENTRIES = 32;
const ANALYTICS_SUMMARY_TTL_MS = 5 * 60 * 1000;

const ANALYTICS_METRIC_DEFINITIONS = [
  { key: "prefixLibraryShare", label: "番号占本馆比例", grain: "works", definition: "某番号系列已有去重作品占本馆去重作品的比例，不使用点赞收藏数。", denominator: "同一发行年筛选范围内的本馆全部视频作品", source: "media_files.normalized_code" },
  { key: "prefixKnownCoverage", label: "番号已知目录收录率", grain: "works", definition: "本系列已有作品除以本馆作品与成功元数据作品的并集；短番号别名对齐。100% 不代表完整发行系列已收齐。", denominator: "同一番号及发行年范围内本馆和 ready 元数据的已知作品并集；不是发行总量", source: "media_files.normalized_code、media_metadata.status/release_date" },
  { key: "works", label: "去重作品", grain: "works", definition: "按 normalized_code 去重；无法识别番号的文件各自计为一部作品。", denominator: "当前发行年筛选范围内的全部视频作品", source: "media_files.normalized_code" },
  { key: "files", label: "媒体文件", grain: "files", definition: "每个实际视频文件计一次，多版本会分别计入。", denominator: "当前发行年筛选范围内的全部视频文件", source: "media_files" },
  { key: "metadataCoverage", label: "元数据覆盖", grain: "works", definition: "元数据状态为 ready 的去重作品占比。", denominator: "去重作品", source: "media_metadata.status" },
  { key: "nativePlaybackRate", label: "原生播放率", grain: "files", definition: "兼容状态为 native 的媒体文件占比。", denominator: "媒体文件", source: "media_files.compatibility_status" },
  { key: "actorAffinity", label: "演员题材偏好", grain: "works", definition: "演员内部题材占比相对全库题材占比的提升度，并使用八部作品先验进行小样本收缩。", denominator: "同时具备规范化演员与题材关系的去重作品", source: "media_metadata_facets" },
  { key: "recentWindow", label: "最近窗口", grain: "works", definition: "以馆藏中最新有效发行年为锚点的最近三个发行年。", denominator: "具有可靠发行日期的匹配作品", source: "media_metadata.release_date" },
  { key: "jobSuccessRate", label: "任务成功率", grain: "jobs", definition: "成功任务占已决任务（成功 + 失败）的比例，等待、运行和取消不进入分母。", denominator: "已完成或失败的历史任务尝试", source: "media_jobs" },
  { key: "qualityGap", label: "字段缺口", grain: "works-or-files", definition: "按每个字段自身适用对象计算未覆盖数量，不跨作品、文件和实体混合相加。", denominator: "指标卡明确标注的作品、文件或实体范围", source: "media_metadata、media_metadata_facets、media_files" }
] as const;

type MatrixFacetType = (typeof ANALYTICS_FACET_TYPES)[number];
type MatrixMember = {
  key: string;
  label: string;
  aliases: string[];
  value: number;
  group?: string;
};
type MatrixCell = {
  rowKey: string;
  columnKey: string;
  value: number;
  rowShare: number;
  columnShare: number;
  globalShare: number;
  lift: number;
  smoothedLift: number;
  expectedValue: number;
  confidence: number;
  stable: boolean;
  recentValue: number;
  previousValue: number;
};
type CrossAnalysisMatrix = {
  id: string;
  title: string;
  subtitle: string;
  rowDimension: MatrixFacetType | "source" | "provider";
  columnDimension: MatrixFacetType | "year" | "resolution" | "compatibility" | "field";
  grain: "works" | "files";
  total: number;
  rows: MatrixMember[];
  columns: MatrixMember[];
  cells: MatrixCell[];
};
type StructureSignal = {
  key: string;
  title: string;
  description: string;
  tone: "orange" | "blue" | "gold" | "green";
  matrixId: string;
  rowKey: string;
  columnKey: string;
  value: number;
};
type MatrixWork = {
  normalizedCode: string;
  releaseDate: string | null;
  releaseYear: number | null;
  score: number;
  facets: Record<MatrixFacetType, Set<string>>;
};
type MatrixContext = {
  works: MatrixWork[];
  members: Record<MatrixFacetType, Map<string, Omit<MatrixMember, "value">>>;
  latestYear: number | null;
  scopedYear: number | null;
};

type LibraryAnalyticsSnapshot = ReturnType<typeof getLibraryAnalyticsSnapshot>;
type MemoryCacheEntry = {
  expiresAt: number;
  value: LibraryAnalyticsSnapshot;
};

type PersistedCacheRow = {
  payloadJson: string;
  expiresAt: string;
};

const analyticsMemoryCache = new Map<string, MemoryCacheEntry>();
const analyticsSummaryCache = new Map<string, { expiresAt: number; value: ReturnType<typeof getLibraryAnalyticsSummary> }>();

const querySchema = z.object({
  year: z.preprocess(
    (value) => value === undefined || value === "" || value === "all" ? null : Number(value),
    z.number().int().min(1900).max(2100).nullable()
  ),
  refresh: z.preprocess(
    (value) => value === "1" || value === "true",
    z.boolean()
  ).default(false),
  mode: z.enum(["all", "actors", "entities", "relations", "prefixes"]).default("all"),
  matrix: z.string().trim().min(1).max(80).optional()
});

const analyticsSectionSchema = z.enum(["overview", "time", "content", "technical", "operations", "quality", "details"]);
const matrixEvidenceQuerySchema = z.object({
  actor: z.string().trim().min(1).max(300),
  genre: z.string().trim().min(1).max(300),
  year: z.preprocess(
    (value) => value === undefined || value === "" || value === "all" ? null : Number(value),
    z.number().int().min(1900).max(2100).nullable()
  ),
  limit: z.coerce.number().int().min(1).max(100).default(30)
});

const resolutionLabels: Record<string, string> = {
  "4k": "4K",
  "1080p": "1080p",
  "720p": "720p",
  sd: "SD",
  unknown: "未知"
};

const compatibilityLabels: Record<string, string> = {
  native: "原生播放",
  remux: "封装转换",
  transcode: "需要转码",
  unsupported: "暂不支持",
  unknown: "待检测"
};

const metadataStatusLabels: Record<string, string> = {
  ready: "已就绪",
  not_found: "未找到",
  failed: "获取失败",
  pending: "待处理",
  fetching: "获取中",
  skipped: "已跳过",
  missing: "尚无记录"
};

const issueLabels: Record<string, string> = {
  duration_conflict: "片长不一致",
  low_completeness: "字段完整度低",
  future_release_date: "发行日期异常",
  unmatched: "未匹配元数据",
  missing_cover: "缺少封面",
  translation: "翻译待处理",
  duplicate: "疑似重复",
  missing_probe: "技术参数待检测",
  compatibility: "播放兼容问题",
  missing_title_zh: "缺少中文标题",
  missing_actor_zh: "缺少演员译名",
  missing_genre_zh: "缺少题材译名"
};

const audioCodecLabels: Record<string, string> = {
  aac: "AAC",
  ac3: "Dolby AC-3",
  eac3: "Dolby E-AC-3",
  mp3: "MP3",
  opus: "Opus",
  flac: "FLAC",
  wmapro: "WMA Pro",
  wmav2: "WMA v2",
  unknown: "未知"
};

const profileTypeLabels: Record<string, string> = {
  actor: "演员",
  series: "系列",
  maker: "厂商",
  label: "厂牌",
  director: "导演"
};

const jobTypeLabels: Record<string, string> = {
  "content-preview": "内容预览",
  hls: "HLS 转码",
  "poster-card": "卡片海报",
  "poster-detail": "详情海报",
  probe: "技术探测",
  remux: "封装转换",
  storyboard: "传统故事板",
  "subtitle-translate": "字幕翻译",
  thumbnail: "缩略图"
};

function numberValue(row: NumericRow | undefined, key: string): number {
  return Number(row?.[key] ?? 0);
}

function textValue(row: NumericRow | undefined, key: string): string | null {
  const value = row?.[key];
  return value === null || value === undefined || value === "" ? null : String(value);
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function recordNumber(record: Record<string, unknown>, key: string): number {
  const value = Number(record[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function nestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function genreGroup(label: string, value: string): string {
  const normalized = `${label} ${value}`.toLocaleLowerCase();
  if (/(高清|hi-def|ハイビジョン|4k|４k|马赛克|モザイク|ギリモザ|digital mosaic|デジモ|sample video|サンプル動画|样片|小时以上|hour|长时间|長時間|分钟以上|分以上)/u.test(normalized)) return "format";
  if (/(独家配信|exclusive distribution|独占配信|单体作品|単体作品|出演女优|featured actress|最佳|合辑|合集|best|ベスト|総集編)/u.test(normalized)) return "distribution";
  if (/(巨乳|big tits|美乳|beautiful tits|美少女|beautiful girl|苗条|slender|スレンダー|熟女|mature woman|人妻|married woman|御姐|older sister|女学生|女子〇生|女子校生|\bol\b|office lady)/u.test(normalized)) return "persona";
  return "theme";
}

function emptyMatrixFacets(): Record<MatrixFacetType, Set<string>> {
  return {
    actor: new Set<string>(),
    genre: new Set<string>(),
    series: new Set<string>(),
    maker: new Set<string>(),
    label: new Set<string>(),
    director: new Set<string>()
  };
}

function buildMatrixContext(
  scopeCte: string,
  params: Record<string, string | number>,
  scopedYear: number | null
): MatrixContext {
  const members = {} as MatrixContext["members"];
  const aliases = {} as Record<MatrixFacetType, Map<string, Omit<MatrixMember, "value"> | null>>;

  for (const type of ANALYTICS_FACET_TYPES) {
    const typeMembers = new Map<string, Omit<MatrixMember, "value">>();
    const aliasCandidates = new Map<string, Omit<MatrixMember, "value"> | null>();
    for (const item of getTopicGraphItems(type)) {
      if (type === "actor" && !isActorNameCandidate(item.value)) continue;
      const member = {
        key: item.value,
        label: item.label,
        aliases: [...new Set([item.value, ...item.aliases])],
        ...(type === "genre" ? { group: genreGroup(item.label, item.value) } : {})
      };
      typeMembers.set(member.key, member);
      for (const alias of member.aliases) {
        const existing = aliasCandidates.get(alias);
        aliasCandidates.set(alias, existing && existing.key !== member.key ? null : member);
      }
    }
    members[type] = typeMembers;
    aliases[type] = aliasCandidates;
  }

  const workRows = db.prepare(`${scopeCte}
    SELECT works.normalized_code AS normalizedCode,
      metadata.release_date AS releaseDate,
      COALESCE(metadata.score, 0) AS score
    FROM scoped_works works
    LEFT JOIN media_metadata metadata ON metadata.normalized_code = works.normalized_code
  `).all(params) as NumericRow[];
  const worksByCode = new Map<string, MatrixWork>();
  let latestYear: number | null = null;
  for (const row of workRows) {
    const normalizedCode = String(row.normalizedCode ?? "");
    if (!normalizedCode) continue;
    const releaseDate = textValue(row, "releaseDate");
    const parsedYear = releaseDate && /^\d{4}/u.test(releaseDate) ? Number(releaseDate.slice(0, 4)) : null;
    if (parsedYear !== null && Number.isFinite(parsedYear)) latestYear = Math.max(latestYear ?? parsedYear, parsedYear);
    worksByCode.set(normalizedCode, {
      normalizedCode,
      releaseDate,
      releaseYear: parsedYear,
      score: numberValue(row, "score"),
      facets: emptyMatrixFacets()
    });
  }

  const facetRows = db.prepare(`${scopeCte}
    SELECT DISTINCT facets.normalized_code AS normalizedCode,
      facets.facet_type AS facetType,
      facets.facet_value AS facetValue
    FROM scoped_works works
    JOIN media_metadata_facets facets ON facets.normalized_code = works.normalized_code
    WHERE facets.facet_type IN ('actor', 'genre', 'series', 'maker', 'label', 'director')
  `).all(params) as NumericRow[];

  for (const row of facetRows) {
    const work = worksByCode.get(String(row.normalizedCode ?? ""));
    if (!work) continue;
    const type = String(row.facetType ?? "") as MatrixFacetType;
    if (!ANALYTICS_FACET_TYPES.includes(type)) continue;
    const rawValue = String(row.facetValue ?? "");
    if (!rawValue || (type === "actor" && !isActorNameCandidate(rawValue))) continue;
    let member = aliases[type].get(rawValue);
    if (member === null) member = undefined;
    if (!member) {
      const label = getTopicLabel(type, rawValue);
      if (!isTopicVisible(type, rawValue, label)) continue;
      member = {
        key: rawValue,
        label,
        aliases: [rawValue],
        ...(type === "genre" ? { group: genreGroup(label, rawValue) } : {})
      };
      members[type].set(member.key, member);
      aliases[type].set(rawValue, member);
    }
    work.facets[type].add(member.key);
  }

  return { works: [...worksByCode.values()], members, latestYear, scopedYear };
}

function buildFacetPairMatrix(options: {
  context: MatrixContext;
  id: string;
  title: string;
  subtitle: string;
  rowType: MatrixFacetType;
  columnType: MatrixFacetType;
  rowLimit: number;
  columnLimit: number;
}): CrossAnalysisMatrix {
  const { context, rowType, columnType } = options;
  const eligibleWorks = context.works.filter((work) => work.facets[rowType].size > 0 && work.facets[columnType].size > 0);
  const rowCounts = new Map<string, number>();
  const columnCounts = new Map<string, number>();
  for (const work of eligibleWorks) {
    for (const key of work.facets[rowType]) rowCounts.set(key, (rowCounts.get(key) ?? 0) + 1);
    for (const key of work.facets[columnType]) columnCounts.set(key, (columnCounts.get(key) ?? 0) + 1);
  }
  const rankedKeys = (counts: Map<string, number>, limit: number) => [...counts]
    .sort((left, right) => right[1] - left[1] || (context.members[rowType].get(left[0])?.label ?? left[0]).localeCompare(context.members[rowType].get(right[0])?.label ?? right[0], "zh-CN"))
    .slice(0, limit)
    .map(([key]) => key);
  const rowKeys = rankedKeys(rowCounts, options.rowLimit);
  const rowKeySet = new Set(rowKeys);
  const displayColumnCounts = new Map<string, number>();
  for (const work of eligibleWorks) {
    if (![...work.facets[rowType]].some((key) => rowKeySet.has(key))) continue;
    for (const key of work.facets[columnType]) displayColumnCounts.set(key, (displayColumnCounts.get(key) ?? 0) + 1);
  }
  const columnKeys = [...displayColumnCounts]
    .sort((left, right) => right[1] - left[1] || (context.members[columnType].get(left[0])?.label ?? left[0]).localeCompare(context.members[columnType].get(right[0])?.label ?? right[0], "zh-CN"))
    .slice(0, options.columnLimit)
    .map(([key]) => key);
  const columnKeySet = new Set(columnKeys);
  const counts = new Map<string, { value: number; recentValue: number; previousValue: number }>();
  const recentStart = context.latestYear === null ? null : context.latestYear - 2;
  const previousStart = context.latestYear === null ? null : context.latestYear - 5;

  for (const work of eligibleWorks) {
    const recent = context.scopedYear === null && recentStart !== null && (work.releaseYear ?? -Infinity) >= recentStart;
    const previous = context.scopedYear === null && previousStart !== null && recentStart !== null && (work.releaseYear ?? -Infinity) >= previousStart && (work.releaseYear ?? Infinity) < recentStart;
    for (const rowKey of work.facets[rowType]) {
      if (!rowKeySet.has(rowKey)) continue;
      for (const columnKey of work.facets[columnType]) {
        if (!columnKeySet.has(columnKey)) continue;
        const key = `${rowKey}::${columnKey}`;
        const entry = counts.get(key) ?? { value: 0, recentValue: 0, previousValue: 0 };
        entry.value += 1;
        if (recent) entry.recentValue += 1;
        if (previous) entry.previousValue += 1;
        counts.set(key, entry);
      }
    }
  }

  const toMember = (type: MatrixFacetType, key: string, value: number): MatrixMember => {
    const member = context.members[type].get(key);
    return {
      key,
      label: member?.label ?? key,
      aliases: member?.aliases ?? [key],
      value,
      ...(member?.group ? { group: member.group } : {})
    };
  };
  const total = eligibleWorks.length;
  const cells = [...counts].map(([key, entry]) => {
    const [rowKey, columnKey] = key.split("::") as [string, string];
    const rowTotal = rowCounts.get(rowKey) ?? 0;
    const columnTotal = columnCounts.get(columnKey) ?? 0;
    const globalShare = total > 0 ? columnTotal / total : 0;
    const rowShare = rowTotal > 0 ? entry.value / rowTotal : 0;
    const columnShare = columnTotal > 0 ? entry.value / columnTotal : 0;
    const lift = globalShare > 0 ? rowShare / globalShare : 0;
    const priorStrength = 8;
    const smoothedShare = (entry.value + priorStrength * globalShare) / Math.max(1, rowTotal + priorStrength);
    const smoothedLift = globalShare > 0 ? smoothedShare / globalShare : 0;
    const confidence = Math.min(1, entry.value / 5) * Math.min(1, rowTotal / 20);
    return {
      rowKey,
      columnKey,
      value: entry.value,
      rowShare,
      columnShare,
      globalShare,
      lift,
      smoothedLift,
      expectedValue: rowTotal * globalShare,
      confidence,
      stable: entry.value >= 3 && confidence >= 0.35,
      recentValue: entry.recentValue,
      previousValue: entry.previousValue
    };
  });

  return {
    id: options.id,
    title: options.title,
    subtitle: options.subtitle,
    rowDimension: rowType,
    columnDimension: columnType,
    grain: "works",
    total,
    rows: rowKeys.map((key) => toMember(rowType, key, rowCounts.get(key) ?? 0)),
    columns: columnKeys.map((key) => toMember(columnType, key, columnCounts.get(key) ?? 0)),
    cells
  };
}

function buildGenreYearMatrix(context: MatrixContext): CrossAnalysisMatrix {
  const eligibleWorks = context.works.filter((work) => work.releaseYear !== null && work.facets.genre.size > 0);
  const genreCounts = new Map<string, number>();
  const yearCounts = new Map<number, number>();
  for (const work of eligibleWorks) {
    yearCounts.set(work.releaseYear!, (yearCounts.get(work.releaseYear!) ?? 0) + 1);
    for (const genre of work.facets.genre) genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + 1);
  }
  const rowKeys = [...genreCounts].sort((left, right) => right[1] - left[1]).slice(0, 30).map(([key]) => key);
  const years = [...yearCounts.keys()].sort((left, right) => left - right).slice(-14);
  const rowSet = new Set(rowKeys);
  const yearSet = new Set(years);
  const counts = new Map<string, number>();
  for (const work of eligibleWorks) {
    if (!yearSet.has(work.releaseYear!)) continue;
    for (const genre of work.facets.genre) {
      if (!rowSet.has(genre)) continue;
      const key = `${genre}::${work.releaseYear}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const total = eligibleWorks.filter((work) => yearSet.has(work.releaseYear!)).length;
  const cells = [...counts].map(([key, value]) => {
    const [rowKey, columnKey] = key.split("::") as [string, string];
    const rowTotal = genreCounts.get(rowKey) ?? 0;
    const columnTotal = yearCounts.get(Number(columnKey)) ?? 0;
    const globalShare = total > 0 ? columnTotal / total : 0;
    const rowShare = rowTotal > 0 ? value / rowTotal : 0;
    const lift = globalShare > 0 ? rowShare / globalShare : 0;
    const smoothedShare = (value + 8 * globalShare) / Math.max(1, rowTotal + 8);
    const confidence = Math.min(1, value / 8) * Math.min(1, rowTotal / 30);
    return {
      rowKey,
      columnKey,
      value,
      rowShare,
      columnShare: columnTotal > 0 ? value / columnTotal : 0,
      globalShare,
      lift,
      smoothedLift: globalShare > 0 ? smoothedShare / globalShare : 0,
      expectedValue: rowTotal * globalShare,
      confidence,
      stable: value >= 5 && confidence >= 0.35,
      recentValue: 0,
      previousValue: 0
    };
  });
  return {
    id: "genre-year",
    title: "题材 × 发行年份",
    subtitle: "识别题材的长期周期、阶段性高峰与馆藏年代结构",
    rowDimension: "genre",
    columnDimension: "year",
    grain: "works",
    total,
    rows: rowKeys.map((key) => {
      const member = context.members.genre.get(key);
      return { key, label: member?.label ?? key, aliases: member?.aliases ?? [key], value: genreCounts.get(key) ?? 0, ...(member?.group ? { group: member.group } : {}) };
    }),
    columns: years.map((year) => ({ key: String(year), label: String(year), aliases: [], value: yearCounts.get(year) ?? 0 })),
    cells
  };
}

function buildSourceResolutionMatrix(scopeCte: string, params: Record<string, string | number>): CrossAnalysisMatrix {
  const rows = db.prepare(`${scopeCte}
    SELECT COALESCE(NULLIF(source_name, ''), '未命名来源') AS source,
      CASE
        WHEN height >= 2160 OR width >= 3840 THEN '4k'
        WHEN height >= 1080 THEN '1080p'
        WHEN height >= 720 THEN '720p'
        WHEN height > 0 OR width > 0 THEN 'sd'
        ELSE 'unknown'
      END AS resolution,
      COUNT(*) AS files
    FROM scoped_files
    GROUP BY source, resolution
    ORDER BY files DESC
  `).all(params) as NumericRow[];
  const rowCounts = new Map<string, number>();
  const columnCounts = new Map<string, number>();
  for (const row of rows) {
    const source = String(row.source ?? "未命名来源");
    const resolution = String(row.resolution ?? "unknown");
    const files = numberValue(row, "files");
    rowCounts.set(source, (rowCounts.get(source) ?? 0) + files);
    columnCounts.set(resolution, (columnCounts.get(resolution) ?? 0) + files);
  }
  const rowKeys = [...rowCounts].sort((left, right) => right[1] - left[1]).slice(0, 18).map(([key]) => key);
  const columnKeys = [...columnCounts].sort((left, right) => right[1] - left[1]).map(([key]) => key);
  const rowSet = new Set(rowKeys);
  const total = [...rowCounts.values()].reduce((sum, value) => sum + value, 0);
  const cells = rows.filter((row) => rowSet.has(String(row.source ?? "未命名来源"))).map((row) => {
    const rowKey = String(row.source ?? "未命名来源");
    const columnKey = String(row.resolution ?? "unknown");
    const value = numberValue(row, "files");
    const rowTotal = rowCounts.get(rowKey) ?? 0;
    const columnTotal = columnCounts.get(columnKey) ?? 0;
    const globalShare = total > 0 ? columnTotal / total : 0;
    const rowShare = rowTotal > 0 ? value / rowTotal : 0;
    const lift = globalShare > 0 ? rowShare / globalShare : 0;
    const smoothedShare = (value + 12 * globalShare) / Math.max(1, rowTotal + 12);
    const confidence = Math.min(1, value / 20) * Math.min(1, rowTotal / 100);
    return {
      rowKey,
      columnKey,
      value,
      rowShare,
      columnShare: columnTotal > 0 ? value / columnTotal : 0,
      globalShare,
      lift,
      smoothedLift: globalShare > 0 ? smoothedShare / globalShare : 0,
      expectedValue: rowTotal * globalShare,
      confidence,
      stable: value >= 10 && confidence >= 0.35,
      recentValue: 0,
      previousValue: 0
    };
  });
  return {
    id: "source-resolution",
    title: "来源 × 清晰度",
    subtitle: "按文件口径比较不同来源的清晰度结构与规格偏移",
    rowDimension: "source",
    columnDimension: "compatibility",
    grain: "files",
    total,
    rows: rowKeys.map((key) => ({ key, label: key, aliases: [key], value: rowCounts.get(key) ?? 0 })),
    columns: columnKeys.map((key) => ({ key, label: resolutionLabels[key] ?? key, aliases: [key], value: columnCounts.get(key) ?? 0 })),
    cells
  };
}

function buildSourceCompatibilityMatrix(scopeCte: string, params: Record<string, string | number>): CrossAnalysisMatrix {
  const rows = db.prepare(`${scopeCte}
    SELECT COALESCE(NULLIF(source_name, ''), '未命名来源') AS source,
      COALESCE(NULLIF(compatibility_status, ''), 'unknown') AS compatibility,
      COUNT(*) AS files
    FROM scoped_files
    GROUP BY source, compatibility
    ORDER BY files DESC
  `).all(params) as NumericRow[];
  const rowCounts = new Map<string, number>();
  const columnCounts = new Map<string, number>();
  for (const row of rows) {
    const source = String(row.source ?? "未命名来源");
    const compatibility = String(row.compatibility ?? "unknown");
    const files = numberValue(row, "files");
    rowCounts.set(source, (rowCounts.get(source) ?? 0) + files);
    columnCounts.set(compatibility, (columnCounts.get(compatibility) ?? 0) + files);
  }
  const rowKeys = [...rowCounts].sort((left, right) => right[1] - left[1]).slice(0, 18).map(([key]) => key);
  const columnKeys = [...columnCounts].sort((left, right) => right[1] - left[1]).map(([key]) => key);
  const rowSet = new Set(rowKeys);
  const total = [...rowCounts.values()].reduce((sum, value) => sum + value, 0);
  const cells = rows.filter((row) => rowSet.has(String(row.source ?? "未命名来源"))).map((row) => {
    const rowKey = String(row.source ?? "未命名来源");
    const columnKey = String(row.compatibility ?? "unknown");
    const value = numberValue(row, "files");
    const rowTotal = rowCounts.get(rowKey) ?? 0;
    const columnTotal = columnCounts.get(columnKey) ?? 0;
    const globalShare = total > 0 ? columnTotal / total : 0;
    const rowShare = rowTotal > 0 ? value / rowTotal : 0;
    const lift = globalShare > 0 ? rowShare / globalShare : 0;
    const smoothedShare = (value + 12 * globalShare) / Math.max(1, rowTotal + 12);
    const confidence = Math.min(1, value / 20) * Math.min(1, rowTotal / 100);
    return {
      rowKey,
      columnKey,
      value,
      rowShare,
      columnShare: columnTotal > 0 ? value / columnTotal : 0,
      globalShare,
      lift,
      smoothedLift: globalShare > 0 ? smoothedShare / globalShare : 0,
      expectedValue: rowTotal * globalShare,
      confidence,
      stable: value >= 10 && confidence >= 0.35,
      recentValue: 0,
      previousValue: 0
    };
  });
  return {
    id: "source-compatibility",
    title: "来源 × 播放路径",
    subtitle: "按文件口径定位来源的原生播放、封装转换和转码风险偏移",
    rowDimension: "provider",
    columnDimension: "field",
    grain: "files",
    total,
    rows: rowKeys.map((key) => ({ key, label: key, aliases: [key], value: rowCounts.get(key) ?? 0 })),
    columns: columnKeys.map((key) => ({ key, label: compatibilityLabels[key] ?? key, aliases: [key], value: columnCounts.get(key) ?? 0 })),
    cells
  };
}

function buildProviderGapMatrix(providers: Array<{
  key: string;
  provider: string;
  works: number;
  readyWorks: number;
  titleWorks: number;
  actorWorks: number;
  translatedWorks: number;
  artworkWorks: number;
  scoredWorks: number;
  staleWorks: number;
}>): CrossAnalysisMatrix {
  const rows = providers.slice(0, 18);
  const fields = [
    { key: "ready", label: "未就绪", gap: (item: (typeof rows)[number]) => Math.max(0, item.works - item.readyWorks) },
    { key: "title", label: "缺中文标题", gap: (item: (typeof rows)[number]) => Math.max(0, item.works - item.titleWorks) },
    { key: "actor", label: "缺演员", gap: (item: (typeof rows)[number]) => Math.max(0, item.works - item.actorWorks) },
    { key: "translation", label: "未翻译", gap: (item: (typeof rows)[number]) => Math.max(0, item.works - item.translatedWorks) },
    { key: "artwork", label: "缺封面", gap: (item: (typeof rows)[number]) => Math.max(0, item.works - item.artworkWorks) },
    { key: "score", label: "缺评分", gap: (item: (typeof rows)[number]) => Math.max(0, item.works - item.scoredWorks) },
    { key: "stale", label: "90天未刷新", gap: (item: (typeof rows)[number]) => item.staleWorks }
  ];
  const total = rows.reduce((sum, item) => sum + item.works, 0);
  const columnTotals = new Map(fields.map((field) => [field.key, rows.reduce((sum, item) => sum + field.gap(item), 0)]));
  const cells = rows.flatMap((row) => fields.map((field) => {
    const value = field.gap(row);
    const columnTotal = columnTotals.get(field.key) ?? 0;
    const globalShare = total > 0 ? columnTotal / total : 0;
    const rowShare = row.works > 0 ? value / row.works : 0;
    const lift = globalShare > 0 ? rowShare / globalShare : 0;
    const smoothedShare = (value + 8 * globalShare) / Math.max(1, row.works + 8);
    const confidence = Math.min(1, value / 8) * Math.min(1, row.works / 30);
    return {
      rowKey: row.key,
      columnKey: field.key,
      value,
      rowShare,
      columnShare: columnTotal > 0 ? value / columnTotal : 0,
      globalShare,
      lift,
      smoothedLift: globalShare > 0 ? smoothedShare / globalShare : 0,
      expectedValue: row.works * globalShare,
      confidence,
      stable: value >= 5 && confidence >= 0.35,
      recentValue: 0,
      previousValue: 0
    };
  })).filter((cell) => cell.value > 0);
  return {
    id: "provider-gaps",
    title: "元数据供应商 × 字段缺口",
    subtitle: "按供应商自身作品分母比较字段缺口，不把未识别来源混入平均值",
    rowDimension: "source",
    columnDimension: "resolution",
    grain: "works",
    total,
    rows: rows.map((item) => ({ key: item.key, label: item.provider, aliases: [item.key], value: item.works })),
    columns: fields.map((field) => ({ key: field.key, label: field.label, aliases: [field.key], value: columnTotals.get(field.key) ?? 0 })),
    cells
  };
}

function buildStructureSignals(matrices: CrossAnalysisMatrix[]): StructureSignal[] {
  const labelFor = (matrix: CrossAnalysisMatrix, axis: "row" | "column", key: string) =>
    (axis === "row" ? matrix.rows : matrix.columns).find((item) => item.key === key)?.label ?? key;
  const signals: StructureSignal[] = [];
  for (const [matrixId, title, tone] of [
    ["actor-genre", "最稳定的演员题材偏移", "orange"],
    ["maker-genre", "最鲜明的厂商题材结构", "gold"],
    ["director-genre", "最鲜明的导演题材结构", "blue"]
  ] as const) {
    const matrix = matrices.find((item) => item.id === matrixId);
    const contentColumnKeys = new Set(matrix?.columns.filter((item) => !item.group || ["theme", "persona"].includes(item.group)).map((item) => item.key) ?? []);
    const cell = matrix?.cells.filter((item) => contentColumnKeys.has(item.columnKey) && item.stable && item.smoothedLift > 1)
      .sort((left, right) => right.smoothedLift * Math.log1p(right.value) - left.smoothedLift * Math.log1p(left.value))[0];
    if (!matrix || !cell) continue;
    signals.push({
      key: `${matrix.id}:stable`,
      title,
      description: `${labelFor(matrix, "row", cell.rowKey)} × ${labelFor(matrix, "column", cell.columnKey)}：${cell.value} 部，稳健提升 ${cell.smoothedLift.toFixed(1)}×`,
      tone,
      matrixId: matrix.id,
      rowKey: cell.rowKey,
      columnKey: cell.columnKey,
      value: cell.smoothedLift
    });
  }
  const actorGenre = matrices.find((item) => item.id === "actor-genre");
  const contentGenreKeys = new Set(actorGenre?.columns.filter((item) => ["theme", "persona"].includes(item.group ?? "theme")).map((item) => item.key) ?? []);
  const growthCell = actorGenre?.cells.filter((item) => contentGenreKeys.has(item.columnKey) && item.stable && item.recentValue >= 3 && item.recentValue > item.previousValue)
    .sort((left, right) => (right.recentValue - right.previousValue) - (left.recentValue - left.previousValue))[0];
  if (actorGenre && growthCell) {
    signals.push({
      key: "actor-genre:growth",
      title: "近三年增长最明显的组合",
      description: `${labelFor(actorGenre, "row", growthCell.rowKey)} × ${labelFor(actorGenre, "column", growthCell.columnKey)}：近三年 ${growthCell.recentValue} 部，前一周期 ${growthCell.previousValue} 部`,
      tone: "green",
      matrixId: actorGenre.id,
      rowKey: growthCell.rowKey,
      columnKey: growthCell.columnKey,
      value: growthCell.recentValue - growthCell.previousValue
    });
  }
  const inventoryMismatch = actorGenre?.cells
    .filter((item) => contentGenreKeys.has(item.columnKey) && item.stable && item.value >= 8 && item.smoothedLift < 0.82)
    .sort((left, right) => right.value * (1 - right.smoothedLift) - left.value * (1 - left.smoothedLift))[0];
  if (actorGenre && inventoryMismatch) {
    signals.push({
      key: "actor-genre:inventory-mismatch",
      title: "高库存但相对偏弱",
      description: `${labelFor(actorGenre, "row", inventoryMismatch.rowKey)} × ${labelFor(actorGenre, "column", inventoryMismatch.columnKey)}：已有 ${inventoryMismatch.value} 部，但稳健提升仅 ${inventoryMismatch.smoothedLift.toFixed(1)}×`,
      tone: "blue",
      matrixId: actorGenre.id,
      rowKey: inventoryMismatch.rowKey,
      columnKey: inventoryMismatch.columnKey,
      value: inventoryMismatch.value
    });
  }
  const lowConfidenceSpike = actorGenre?.cells
    .filter((item) => contentGenreKeys.has(item.columnKey) && !item.stable && item.value <= 3 && item.lift >= 2)
    .sort((left, right) => right.lift - left.lift)[0];
  if (actorGenre && lowConfidenceSpike) {
    signals.push({
      key: "actor-genre:low-confidence",
      title: "高提升但证据不足",
      description: `${labelFor(actorGenre, "row", lowConfidenceSpike.rowKey)} × ${labelFor(actorGenre, "column", lowConfidenceSpike.columnKey)}：原始提升 ${lowConfidenceSpike.lift.toFixed(1)}×，仅 ${lowConfidenceSpike.value} 部，建议先补充证据`,
      tone: "gold",
      matrixId: actorGenre.id,
      rowKey: lowConfidenceSpike.rowKey,
      columnKey: lowConfidenceSpike.columnKey,
      value: lowConfidenceSpike.lift
    });
  }
  const dominantActor = actorGenre?.rows[0];
  const dominantActorCell = dominantActor && actorGenre?.cells
    .filter((item) => item.rowKey === dominantActor.key && contentGenreKeys.has(item.columnKey))
    .sort((left, right) => right.value - left.value)[0];
  if (actorGenre && dominantActor && dominantActorCell && dominantActor.value / Math.max(1, actorGenre.total) >= 0.2) {
    signals.push({
      key: "actor-genre:concentration",
      title: "演员覆盖集中提醒",
      description: `${dominantActor.label} 覆盖 ${Math.round(dominantActor.value / Math.max(1, actorGenre.total) * 100)}% 的矩阵作品，建议与其他演员对比后再下结论`,
      tone: "gold",
      matrixId: actorGenre.id,
      rowKey: dominantActor.key,
      columnKey: dominantActorCell.columnKey,
      value: dominantActor.value / Math.max(1, actorGenre.total)
    });
  }
  const sourceResolution = matrices.find((item) => item.id === "source-resolution");
  const sourceCell = sourceResolution?.cells.filter((item) => item.stable)
    .sort((left, right) => right.rowShare - left.rowShare)[0];
  if (sourceResolution && sourceCell) {
    signals.push({
      key: "source-resolution:dominant",
      title: "来源规格集中度",
      description: `${labelFor(sourceResolution, "row", sourceCell.rowKey)} 中 ${labelFor(sourceResolution, "column", sourceCell.columnKey)} 占 ${Math.round(sourceCell.rowShare * 100)}%`,
      tone: "blue",
      matrixId: sourceResolution.id,
      rowKey: sourceCell.rowKey,
      columnKey: sourceCell.columnKey,
      value: sourceCell.rowShare
    });
  }
  return signals.slice(0, 8);
}

function createScopeCte(year: number | null): string {
  return `
    WITH scoped_files AS (
      SELECT files.*
      FROM media_files files
      LEFT JOIN media_metadata metadata ON metadata.normalized_code = files.normalized_code
      WHERE files.media_type = 'video'
        ${year === null ? "" : "AND strftime('%Y', metadata.release_date) = @year"}
    ),
    scoped_works AS (
      SELECT DISTINCT normalized_code
      FROM scoped_files
      WHERE normalized_code != ''
    ),
    scoped_work_stats AS (
      SELECT normalized_code,
        COUNT(*) AS files,
        COALESCE(SUM(size), 0) AS bytes,
        COALESCE(SUM(duration_seconds), 0) AS durationSeconds,
        COALESCE(AVG(NULLIF(size, 0)), 0) AS averageFileBytes,
        COALESCE(MAX(size), 0) AS largestFileBytes
      FROM scoped_files
      WHERE normalized_code != ''
      GROUP BY normalized_code
    )
  `;
}

function createActorScopeCte(year: number | null): string {
  return `
    WITH actor_scoped_files AS (
      SELECT files.*
      FROM media_files files
      LEFT JOIN media_metadata metadata ON metadata.normalized_code = files.normalized_code
      WHERE files.media_type = 'video'
        AND UPPER(COALESCE(NULLIF(files.library_category, ''), 'JAV')) = 'JAV'
        ${year === null ? "" : "AND strftime('%Y', metadata.release_date) = @year"}
    ),
    actor_scoped_works AS (
      SELECT DISTINCT normalized_code
      FROM actor_scoped_files
      WHERE normalized_code != ''
    )
  `;
}

function getLibraryAnalyticsSummary(year: number | null) {
  const params: Record<string, string | number> = year === null ? {} : { year: String(year) };
  const scopeCte = createScopeCte(year);
  const summaryRow = db.prepare(`${scopeCte}
    SELECT
      COUNT(*) AS files,
      COUNT(DISTINCT NULLIF(normalized_code, '')) + SUM(CASE WHEN normalized_code = '' THEN 1 ELSE 0 END) AS works,
      COUNT(*) - COUNT(DISTINCT NULLIF(normalized_code, '')) - SUM(CASE WHEN normalized_code = '' THEN 1 ELSE 0 END) AS variants,
      COALESCE(SUM(size), 0) AS totalBytes,
      COALESCE(SUM(duration_seconds), 0) AS totalDurationSeconds,
      COALESCE(AVG(NULLIF(size, 0)), 0) AS averageFileBytes,
      SUM(CASE WHEN probe_status = 'ready' THEN 1 ELSE 0 END) AS probedFiles,
      SUM(CASE WHEN probe_status = 'failed' THEN 1 ELSE 0 END) AS failedProbeFiles,
      SUM(CASE WHEN compatibility_status = 'native' THEN 1 ELSE 0 END) AS nativeFiles,
      SUM(CASE WHEN compatibility_status IN ('transcode', 'unsupported') THEN 1 ELSE 0 END) AS riskFiles,
      SUM(CASE WHEN height >= 2160 OR width >= 3840 THEN 1 ELSE 0 END) AS fourKFiles,
      SUM(CASE WHEN height >= 1080 THEN 1 ELSE 0 END) AS fullHdFiles,
      MAX(indexed_at) AS indexedAt,
      MIN(NULLIF(first_seen_at, '')) AS firstSeenAt,
      MAX(NULLIF(first_seen_at, '')) AS lastSeenAt
    FROM scoped_files
  `).get(params) as NumericRow | undefined;
  const metadataRow = db.prepare(`${scopeCte}
    SELECT
      COUNT(*) AS codedWorks,
      SUM(CASE WHEN metadata.normalized_code IS NOT NULL THEN 1 ELSE 0 END) AS recordedWorks,
      SUM(CASE WHEN metadata.status = 'ready' THEN 1 ELSE 0 END) AS readyWorks,
      SUM(CASE WHEN metadata.status = 'ready' AND NULLIF(metadata.release_date, '') IS NOT NULL THEN 1 ELSE 0 END) AS releaseDateWorks,
      SUM(CASE WHEN metadata.status = 'ready' AND NULLIF(TRIM(metadata.title_zh), '') IS NOT NULL THEN 1 ELSE 0 END) AS translatedTitleWorks,
      SUM(CASE WHEN metadata.status = 'ready' AND (NULLIF(metadata.cover_url, '') IS NOT NULL OR NULLIF(metadata.thumb_url, '') IS NOT NULL) THEN 1 ELSE 0 END) AS artworkWorks,
      SUM(CASE WHEN metadata.status = 'ready' AND metadata.translation_status = 'ready' THEN 1 ELSE 0 END) AS translatedWorks,
      MIN(CASE WHEN date(metadata.release_date) IS NOT NULL THEN metadata.release_date END) AS earliestReleaseDate,
      MAX(CASE WHEN date(metadata.release_date) IS NOT NULL THEN metadata.release_date END) AS latestReleaseDate,
      MAX(metadata.updated_at) AS metadataUpdatedAt,
      AVG(CASE WHEN metadata.score > 0 THEN metadata.score END) AS averagePositiveScore,
      SUM(CASE WHEN metadata.score > 0 THEN 1 ELSE 0 END) AS scoredWorks
    FROM scoped_works works
    LEFT JOIN media_metadata metadata ON metadata.normalized_code = works.normalized_code
  `).get(params) as NumericRow | undefined;
  const availableYears = (db.prepare(`
    WITH current_works AS (
      SELECT DISTINCT normalized_code FROM media_files
      WHERE media_type = 'video' AND normalized_code != ''
    )
    SELECT CAST(strftime('%Y', metadata.release_date) AS INTEGER) AS year, COUNT(*) AS works
    FROM current_works works
    JOIN media_metadata metadata ON metadata.normalized_code = works.normalized_code
    WHERE date(metadata.release_date) IS NOT NULL
    GROUP BY strftime('%Y', metadata.release_date)
    ORDER BY year DESC
  `).all() as NumericRow[]).map((row) => ({ year: numberValue(row, "year"), works: numberValue(row, "works") }));
  const files = numberValue(summaryRow, "files");
  const works = numberValue(summaryRow, "works");

  return {
    contract: {
      version: ANALYTICS_CACHE_VERSION,
      workIdentity: "normalized_code",
      releaseDateField: "media_metadata.release_date",
      generatedAt: new Date().toISOString(),
      metrics: ANALYTICS_METRIC_DEFINITIONS
    },
    scope: { year, label: year === null ? "全部馆藏" : `${year} 年发行`, dateField: "release_date" as const, generatedAt: new Date().toISOString() },
    freshness: {
      indexedAt: textValue(summaryRow, "indexedAt"),
      metadataUpdatedAt: textValue(metadataRow, "metadataUpdatedAt"),
      firstSeenAt: textValue(summaryRow, "firstSeenAt"),
      lastSeenAt: textValue(summaryRow, "lastSeenAt")
    },
    summary: {
      files,
      works,
      variants: Math.max(0, numberValue(summaryRow, "variants")),
      totalBytes: numberValue(summaryRow, "totalBytes"),
      totalDurationSeconds: numberValue(summaryRow, "totalDurationSeconds"),
      averageFileBytes: numberValue(summaryRow, "averageFileBytes"),
      averageDurationSeconds: files > 0 ? numberValue(summaryRow, "totalDurationSeconds") / files : 0,
      readyMetadataWorks: numberValue(metadataRow, "readyWorks"),
      recordedMetadataWorks: numberValue(metadataRow, "recordedWorks"),
      translatedWorks: numberValue(metadataRow, "translatedWorks"),
      artworkWorks: numberValue(metadataRow, "artworkWorks"),
      metadataCoverage: works > 0 ? numberValue(metadataRow, "readyWorks") / works : 0,
      translationCoverage: works > 0 ? numberValue(metadataRow, "translatedWorks") / works : 0,
      artworkCoverage: works > 0 ? numberValue(metadataRow, "artworkWorks") / works : 0,
      variantRate: files > 0 ? Math.max(0, numberValue(summaryRow, "variants")) / files : 0,
      nativePlaybackRate: files > 0 ? numberValue(summaryRow, "nativeFiles") / files : 0,
      playbackRiskRate: files > 0 ? numberValue(summaryRow, "riskFiles") / files : 0,
      fourKShare: files > 0 ? numberValue(summaryRow, "fourKFiles") / files : 0,
      fullHdShare: files > 0 ? numberValue(summaryRow, "fullHdFiles") / files : 0,
      earliestReleaseDate: textValue(metadataRow, "earliestReleaseDate"),
      latestReleaseDate: textValue(metadataRow, "latestReleaseDate"),
      averagePositiveScore: numberValue(metadataRow, "averagePositiveScore"),
      scoredWorks: numberValue(metadataRow, "scoredWorks")
    },
    availableYears
  };
}

function getCachedLibraryAnalyticsSummary(year: number | null, forceRefresh = false) {
  const key = analyticsCacheKey(year);
  const now = Date.now();
  const cached = analyticsSummaryCache.get(key);
  if (!forceRefresh && cached && cached.expiresAt > now) return { cacheStatus: "HIT" as const, value: cached.value };
  const value = getLibraryAnalyticsSummary(year);
  analyticsSummaryCache.set(key, { expiresAt: now + ANALYTICS_SUMMARY_TTL_MS, value });
  return { cacheStatus: forceRefresh ? "REFRESH" as const : "MISS" as const, value };
}

function projectLibraryAnalyticsSnapshot(
  snapshot: LibraryAnalyticsSnapshot,
  section: z.infer<typeof analyticsSectionSchema>,
  contentMode: "all" | "actors" | "entities" | "relations" | "prefixes" = "all",
  selectedMatrixId?: string
) {
  const emptyFacets = Object.fromEntries(ANALYTICS_FACET_TYPES.map((type) => [type, {
    distinctValues: 0,
    coveredWorks: 0,
    totalAssignments: 0,
    items: []
  }])) as unknown as LibraryAnalyticsSnapshot["facets"];
  const base: LibraryAnalyticsSnapshot = {
    contract: snapshot.contract,
    scope: snapshot.scope,
    freshness: snapshot.freshness,
    summary: snapshot.summary,
    availableYears: snapshot.availableYears,
    releaseHistory: [],
    releaseByMonth: [],
    releaseHeatmap: [],
    yearlyMetrics: [],
    categoryYearTrend: [],
    catalogGrowth: [],
    libraryMix: [],
    sourceMix: [],
    sourceProfiles: [],
    facets: emptyFacets,
    prefixAnalytics: {totalWorks:0,identifiedWorks:0,unidentifiedWorks:0,prefixes:0,knownWorks:0,missingWorks:0,unresolvedCatalogRecords:0,metadataUpdatedAt:null,items:[]},
    contentMatrix: { rows: [], columns: [], cells: [] },
    actorAnalytics: {
      scope: { totalWorks: 0, actorCoveredWorks: 0, actorCoverage: 0, excludedFc2Works: 0, validActors: 0, assignments: 0, invalidActors: 0, invalidAssignments: 0 },
      workBands: [],
      castSizeBands: [],
      activity: { years: [], actors: [], cells: [] },
      genreAffinity: { actors: [], genres: [], cells: [] },
      score: { globalAverage: 0, points: [] },
      collaboration: { actors: [], pairs: [] },
      profileCompleteness: [],
      coverageByYear: [],
      coverageByProvider: []
    },
    crossAnalysis: {
      scope: { canonicalActors: 0, canonicalGenres: 0, rawActors: 0, rawGenres: 0, recentWindow: null, previousWindow: null },
      matrices: [],
      signals: []
    },
    technical: {
      resolutions: [], codecs: [], containers: [], audioCodecs: [], extensions: [], compatibility: [],
      resolutionCodecMatrix: [], durationBands: [], fileSizeBands: [], durationBoxPlots: [], scoreBands: [], variantTags: [], variantBands: []
    },
    dataQuality: {
      coverage: [], metadataPipeline: [], metadataStatuses: [], metadataProviders: [], coverageByReleaseYear: [], issues: [], backlog: [], facetConcentration: [], indexLagBands: [], exceptionWorks: []
    },
    entityKnowledge: { profiles: [], actorBirthDecades: [] },
    operations: {
      scope: { label: "全部生产任务", timeField: "updated_at", ignoresReleaseYearFilter: true },
      summary: { jobs: 0, readyJobs: 0, failedJobs: 0, pendingJobs: 0, runningJobs: 0, cancelledJobs: 0, successRate: 0, currentAssetFailures: 0, currentAssetPending: 0, ingestionRuns: 0, ingestionMoved: 0, latestActivityAt: null },
      jobTypes: [], jobDaily: [], pipelineStages: [], recentIngestionRuns: [],
      ingestionSummary: { runs: 0, completed: 0, partial: 0, failed: 0, manual: 0, scheduled: 0, moved: 0, eligible: 0, conflicts: 0, unstable: 0, previewsQueued: 0, latestScanned: 0, latestRunAt: "" },
      failedJobDetails: []
    }
  };
  if (section === "overview") return {
    ...base,
    releaseHistory: snapshot.releaseHistory,
    yearlyMetrics: snapshot.yearlyMetrics,
    catalogGrowth: snapshot.catalogGrowth,
    libraryMix: snapshot.libraryMix,
    sourceProfiles: snapshot.sourceProfiles,
    facets: snapshot.facets,
    dataQuality: { ...base.dataQuality,
      coverage: snapshot.dataQuality.coverage,
      metadataProviders: snapshot.dataQuality.metadataProviders,
      backlog: snapshot.dataQuality.backlog,
      issues: snapshot.dataQuality.issues,
      exceptionWorks: snapshot.dataQuality.exceptionWorks.slice(0, 80)
    }
  };
  if (section === "time") return {
    ...base,
    releaseHistory: snapshot.releaseHistory,
    releaseByMonth: snapshot.releaseByMonth,
    releaseHeatmap: snapshot.releaseHeatmap,
    yearlyMetrics: snapshot.yearlyMetrics,
    categoryYearTrend: snapshot.categoryYearTrend,
    catalogGrowth: snapshot.catalogGrowth
  };
  if (section === "content") {
    if(contentMode === "prefixes")return {...base,prefixAnalytics:snapshot.prefixAnalytics};
    const crossAnalysis = {
      ...snapshot.crossAnalysis,
      catalog: snapshot.crossAnalysis.matrices.map(({ id, title, subtitle, grain, total }) => ({ id, title, subtitle, grain, total })),
      matrices: contentMode === "all"
        ? snapshot.crossAnalysis.matrices
        : contentMode === "relations"
          ? snapshot.crossAnalysis.matrices.filter((matrix) => !selectedMatrixId || matrix.id === selectedMatrixId)
          : []
    };
    if (contentMode === "actors") return {
      ...base,
      actorAnalytics: snapshot.actorAnalytics,
      crossAnalysis,
      entityKnowledge: snapshot.entityKnowledge
    };
    if (contentMode === "entities") return {
      ...base,
      facets: snapshot.facets,
      contentMatrix: snapshot.contentMatrix,
      crossAnalysis,
      dataQuality: { ...base.dataQuality, facetConcentration: snapshot.dataQuality.facetConcentration },
      entityKnowledge: snapshot.entityKnowledge
    };
    if (contentMode === "relations") return { ...base, crossAnalysis };
    return {
      ...base,
      facets: snapshot.facets,
      prefixAnalytics:snapshot.prefixAnalytics,
      contentMatrix: snapshot.contentMatrix,
      actorAnalytics: snapshot.actorAnalytics,
      crossAnalysis,
      dataQuality: { ...base.dataQuality, facetConcentration: snapshot.dataQuality.facetConcentration },
      entityKnowledge: snapshot.entityKnowledge
    };
  }
  if (section === "technical") return {
    ...base,
    sourceMix: snapshot.sourceMix,
    sourceProfiles: snapshot.sourceProfiles,
    technical: snapshot.technical,
    dataQuality: { ...base.dataQuality, coverage: snapshot.dataQuality.coverage }
  };
  if (section === "operations") return { ...base, operations: snapshot.operations };
  if (section === "quality") return { ...base, dataQuality: snapshot.dataQuality, entityKnowledge: snapshot.entityKnowledge };
  return snapshot;
}

function getMatrixEvidence(actor: string, genre: string, year: number | null, limit: number) {
  const actorMember = getTopicGraphItems("actor").find((item) => item.value === actor);
  const genreMember = getTopicGraphItems("genre").find((item) => item.value === genre);
  const actorAliases = [...new Set([actor, ...(actorMember?.aliases ?? [])])];
  const genreAliases = [...new Set([genre, ...(genreMember?.aliases ?? [])])];
  const params: Array<string | number> = [...actorAliases, ...genreAliases];
  const yearClause = year === null ? "" : "AND strftime('%Y', metadata.release_date) = ?";
  if (year !== null) params.push(String(year));
  const rows = db.prepare(`
    SELECT DISTINCT actors.normalized_code AS normalizedCode, metadata.release_date AS releaseDate
    FROM media_metadata_facets actors
    JOIN media_metadata_facets genres ON genres.normalized_code = actors.normalized_code AND genres.facet_type = 'genre'
    JOIN media_metadata metadata ON metadata.normalized_code = actors.normalized_code
    WHERE actors.facet_type = 'actor'
      AND actors.facet_value IN (${actorAliases.map(() => "?").join(", ")})
      AND genres.facet_value IN (${genreAliases.map(() => "?").join(", ")})
      ${yearClause}
    ORDER BY CASE WHEN date(metadata.release_date) IS NULL THEN 1 ELSE 0 END, metadata.release_date DESC, actors.normalized_code
  `).all(...params) as NumericRow[];
  const latestYearRow = db.prepare(`
    SELECT MAX(CAST(strftime('%Y', release_date) AS INTEGER)) AS latestYear
    FROM media_metadata
    WHERE date(release_date) IS NOT NULL
  `).get() as NumericRow | undefined;
  const latestYear = numberValue(latestYearRow, "latestYear") || null;
  const recentStart = latestYear === null ? null : latestYear - 2;
  const previousStart = latestYear === null ? null : latestYear - 5;
  const items = rows.map((row) => {
    const releaseDate = textValue(row, "releaseDate");
    const releaseYear = releaseDate && /^\d{4}/u.test(releaseDate) ? Number(releaseDate.slice(0, 4)) : null;
    const period = releaseYear === null || recentStart === null || previousStart === null
      ? "undated"
      : releaseYear >= recentStart
        ? "recent"
        : releaseYear >= previousStart
          ? "previous"
          : "historical";
    return { normalizedCode: String(row.normalizedCode ?? ""), releaseDate, releaseYear, period };
  });
  return {
    actor: { value: actor, label: actorMember?.label ?? actor, aliases: actorAliases },
    genre: { value: genre, label: genreMember?.label ?? genre, aliases: genreAliases },
    total: items.length,
    datedWorks: items.filter((item) => item.releaseDate).length,
    undatedWorks: items.filter((item) => !item.releaseDate).length,
    recentWorks: items.filter((item) => item.period === "recent").length,
    previousWorks: items.filter((item) => item.period === "previous").length,
    recentWindow: latestYear === null ? null : `${latestYear - 2}–${latestYear}`,
    previousWindow: latestYear === null ? null : `${latestYear - 5}–${latestYear - 3}`,
    items: items.slice(0, limit)
  };
}

function analyticsCacheKey(year: number | null): string {
  return `library-analytics:${ANALYTICS_CACHE_VERSION}:${year ?? "all"}`;
}

function readMemoryCachedSnapshot(cacheKey: string, now: number): LibraryAnalyticsSnapshot | null {
  const cached = analyticsMemoryCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= now) {
    analyticsMemoryCache.delete(cacheKey);
    return null;
  }
  analyticsMemoryCache.delete(cacheKey);
  analyticsMemoryCache.set(cacheKey, cached);
  return cached.value;
}

function writeMemoryCachedSnapshot(cacheKey: string, value: LibraryAnalyticsSnapshot, expiresAt: number): void {
  analyticsMemoryCache.delete(cacheKey);
  analyticsMemoryCache.set(cacheKey, { expiresAt, value });
  while (analyticsMemoryCache.size > MAX_MEMORY_CACHE_ENTRIES) {
    const oldestKey = analyticsMemoryCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    analyticsMemoryCache.delete(oldestKey);
  }
}

function readPersistedCachedSnapshot(cacheKey: string, now: number): LibraryAnalyticsSnapshot | null {
  const row = db.prepare(`
    SELECT payload_json AS payloadJson, expires_at AS expiresAt
    FROM library_analytics_cache
    WHERE cache_key = ? AND expires_at > ?
  `).get(cacheKey, new Date(now).toISOString()) as PersistedCacheRow | undefined;
  if (!row) return null;

  try {
    const value = JSON.parse(row.payloadJson) as LibraryAnalyticsSnapshot;
    writeMemoryCachedSnapshot(cacheKey, value, Date.parse(row.expiresAt));
    return value;
  } catch {
    db.prepare("DELETE FROM library_analytics_cache WHERE cache_key = ?").run(cacheKey);
    return null;
  }
}

function writePersistedCachedSnapshot(cacheKey: string, value: LibraryAnalyticsSnapshot, now: number): void {
  const generatedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ANALYTICS_CACHE_TTL_MS).toISOString();
  db.prepare(`
    INSERT INTO library_analytics_cache (cache_key, payload_json, generated_at, expires_at)
    VALUES (@cacheKey, @payloadJson, @generatedAt, @expiresAt)
    ON CONFLICT(cache_key) DO UPDATE SET
      payload_json = excluded.payload_json,
      generated_at = excluded.generated_at,
      expires_at = excluded.expires_at
  `).run({ cacheKey, payloadJson: JSON.stringify(value), generatedAt, expiresAt });
  db.prepare("DELETE FROM library_analytics_cache WHERE expires_at <= ?").run(generatedAt);
  writeMemoryCachedSnapshot(cacheKey, value, Date.parse(expiresAt));
}

function getCachedLibraryAnalyticsSnapshot(year: number | null, forceRefresh = false): {
  cacheStatus: "HIT" | "HIT-PERSISTED" | "MISS" | "REFRESH";
  value: LibraryAnalyticsSnapshot;
} {
  const now = Date.now();
  const cacheKey = analyticsCacheKey(year);
  if (!forceRefresh) {
    const memoryCached = readMemoryCachedSnapshot(cacheKey, now);
    if (memoryCached) return { cacheStatus: "HIT", value: memoryCached };
    const persistedCached = readPersistedCachedSnapshot(cacheKey, now);
    if (persistedCached) return { cacheStatus: "HIT-PERSISTED", value: persistedCached };
  }

  const value = getLibraryAnalyticsSnapshot(year);
  writePersistedCachedSnapshot(cacheKey, value, now);
  return { cacheStatus: forceRefresh ? "REFRESH" : "MISS", value };
}

function mapDistributionRows(rows: NumericRow[], keyField: string, labelMap: Record<string, string> = {}): DistributionRow[] {
  return rows.map((row) => {
    const key = String(row[keyField] ?? "unknown");
    return {
      key,
      label: labelMap[key] ?? key,
      files: numberValue(row, "files"),
      works: numberValue(row, "works"),
      bytes: numberValue(row, "bytes")
    };
  });
}

function getLibraryAnalyticsSnapshot(year: number | null) {
  const params: Record<string, string | number> = year === null ? {} : { year: String(year) };
  const scopeCte = createScopeCte(year);

  const summaryRow = db.prepare(`${scopeCte}
    SELECT
      COUNT(*) AS files,
      COUNT(DISTINCT NULLIF(normalized_code, ''))
        + SUM(CASE WHEN normalized_code = '' THEN 1 ELSE 0 END) AS works,
      COUNT(*) - COUNT(DISTINCT NULLIF(normalized_code, ''))
        - SUM(CASE WHEN normalized_code = '' THEN 1 ELSE 0 END) AS variants,
      COALESCE(SUM(size), 0) AS totalBytes,
      COALESCE(SUM(duration_seconds), 0) AS totalDurationSeconds,
      COALESCE(AVG(NULLIF(size, 0)), 0) AS averageFileBytes,
      SUM(CASE WHEN probe_status = 'ready' THEN 1 ELSE 0 END) AS probedFiles,
      SUM(CASE WHEN probe_status = 'failed' THEN 1 ELSE 0 END) AS failedProbeFiles,
      MAX(indexed_at) AS indexedAt,
      MIN(NULLIF(first_seen_at, '')) AS firstSeenAt,
      MAX(NULLIF(first_seen_at, '')) AS lastSeenAt
    FROM scoped_files
  `).get(params) as NumericRow | undefined;

  const metadataRow = db.prepare(`${scopeCte}
    SELECT
      COUNT(*) AS codedWorks,
      SUM(CASE WHEN metadata.normalized_code IS NOT NULL THEN 1 ELSE 0 END) AS recordedWorks,
      SUM(CASE WHEN metadata.status = 'ready' THEN 1 ELSE 0 END) AS readyWorks,
      SUM(CASE WHEN metadata.status = 'ready' AND NULLIF(metadata.release_date, '') IS NOT NULL THEN 1 ELSE 0 END) AS releaseDateWorks,
      SUM(CASE WHEN metadata.status = 'ready' AND NULLIF(TRIM(metadata.title_zh), '') IS NOT NULL THEN 1 ELSE 0 END) AS translatedTitleWorks,
      SUM(CASE WHEN metadata.status = 'ready' AND (metadata.cover_url != '' OR metadata.thumb_url != '') THEN 1 ELSE 0 END) AS artworkWorks,
      SUM(CASE WHEN metadata.status = 'ready' AND metadata.translation_status = 'ready' THEN 1 ELSE 0 END) AS translatedWorks,
      MIN(CASE WHEN date(metadata.release_date) IS NOT NULL THEN metadata.release_date END) AS earliestReleaseDate,
      MAX(CASE WHEN date(metadata.release_date) IS NOT NULL THEN metadata.release_date END) AS latestReleaseDate,
      MAX(metadata.updated_at) AS metadataUpdatedAt,
      AVG(CASE WHEN metadata.score > 0 THEN metadata.score END) AS averagePositiveScore,
      SUM(CASE WHEN metadata.score > 0 THEN 1 ELSE 0 END) AS scoredWorks
    FROM scoped_works works
    LEFT JOIN media_metadata metadata ON metadata.normalized_code = works.normalized_code
  `).get(params) as NumericRow | undefined;

  const availableYears = (db.prepare(`
    WITH current_works AS (
      SELECT DISTINCT normalized_code FROM media_files
      WHERE media_type = 'video' AND normalized_code != ''
    )
    SELECT CAST(strftime('%Y', metadata.release_date) AS INTEGER) AS year,
      COUNT(*) AS works
    FROM current_works works
    JOIN media_metadata metadata ON metadata.normalized_code = works.normalized_code
    WHERE date(metadata.release_date) IS NOT NULL
    GROUP BY strftime('%Y', metadata.release_date)
    ORDER BY year DESC
  `).all() as NumericRow[]).map((row) => ({
    year: numberValue(row, "year"),
    works: numberValue(row, "works")
  }));

  const chronologicalYears = [...availableYears].reverse();
  const worksByYear = new Map(chronologicalYears.map((item) => [item.year, item.works]));
  const firstReleaseYear = chronologicalYears[0]?.year;
  const lastReleaseYear = chronologicalYears.at(-1)?.year;
  const releaseHistory = firstReleaseYear === undefined || lastReleaseYear === undefined
    ? []
    : Array.from({ length: lastReleaseYear - firstReleaseYear + 1 }, (_, index) => ({
        year: firstReleaseYear + index,
        works: worksByYear.get(firstReleaseYear + index) ?? 0
      }));

  const monthlyRows = db.prepare(`${scopeCte}
    SELECT CAST(strftime('%m', metadata.release_date) AS INTEGER) AS month,
      COUNT(*) AS works
    FROM scoped_works works
    JOIN media_metadata metadata ON metadata.normalized_code = works.normalized_code
    WHERE date(metadata.release_date) IS NOT NULL
    GROUP BY strftime('%m', metadata.release_date)
    ORDER BY month
  `).all(params) as NumericRow[];
  const monthlyCounts = new Map(monthlyRows.map((row) => [numberValue(row, "month"), numberValue(row, "works")]));
  const releaseByMonth = Array.from({ length: 12 }, (_, index) => ({
    month: index + 1,
    works: monthlyCounts.get(index + 1) ?? 0
  }));

  const yearlyMetricRows = (db.prepare(`
    WITH dated_files AS (
      SELECT CAST(strftime('%Y', metadata.release_date) AS INTEGER) AS year,
        files.*
      FROM media_files files
      JOIN media_metadata metadata ON metadata.normalized_code = files.normalized_code
      WHERE files.media_type = 'video'
        AND date(metadata.release_date) IS NOT NULL
    ),
    file_summary AS (
      SELECT year,
        COUNT(*) AS files,
        COALESCE(SUM(size), 0) AS bytes,
        COALESCE(SUM(duration_seconds), 0) AS durationSeconds,
        COALESCE(AVG(NULLIF(size, 0)), 0) AS averageFileBytes,
        SUM(CASE WHEN height >= 2160 OR width >= 3840 THEN 1 ELSE 0 END) AS fourKFiles,
        SUM(CASE WHEN height >= 1080 THEN 1 ELSE 0 END) AS fullHdFiles,
        SUM(CASE WHEN probe_status = 'ready' THEN 1 ELSE 0 END) AS probedFiles
      FROM dated_files
      GROUP BY year
    ),
    dated_works AS (
      SELECT DISTINCT year, normalized_code
      FROM dated_files
      WHERE normalized_code != ''
    ),
    work_summary AS (
      SELECT works.year,
        COUNT(*) AS works,
        SUM(CASE WHEN metadata.status = 'ready' THEN 1 ELSE 0 END) AS readyMetadataWorks,
        SUM(CASE WHEN metadata.score > 0 THEN 1 ELSE 0 END) AS scoredWorks,
        COALESCE(AVG(CASE WHEN metadata.score > 0 THEN metadata.score END), 0) AS averageScore
      FROM dated_works works
      LEFT JOIN media_metadata metadata ON metadata.normalized_code = works.normalized_code
      GROUP BY works.year
    )
    SELECT files.year, files.files, works.works, files.bytes, files.durationSeconds,
      files.averageFileBytes, files.fourKFiles, files.fullHdFiles, files.probedFiles,
      works.readyMetadataWorks, works.scoredWorks, works.averageScore
    FROM file_summary files
    JOIN work_summary works ON works.year = files.year
    ORDER BY files.year
  `).all() as NumericRow[]).map((row) => ({
    year: numberValue(row, "year"),
    files: numberValue(row, "files"),
    works: numberValue(row, "works"),
    bytes: numberValue(row, "bytes"),
    durationSeconds: numberValue(row, "durationSeconds"),
    averageFileBytes: numberValue(row, "averageFileBytes"),
    fourKFiles: numberValue(row, "fourKFiles"),
    fullHdFiles: numberValue(row, "fullHdFiles"),
    probedFiles: numberValue(row, "probedFiles"),
    readyMetadataWorks: numberValue(row, "readyMetadataWorks"),
    scoredWorks: numberValue(row, "scoredWorks"),
    averageScore: numberValue(row, "averageScore")
  }));
  const yearlyMetrics = yearlyMetricRows.map((row, index) => {
    const previousWorks = yearlyMetricRows[index - 1]?.works ?? 0;
    return {
      ...row,
      workGrowthRate: previousWorks > 0 ? (row.works - previousWorks) / previousWorks : null,
      metadataCoverage: row.works > 0 ? row.readyMetadataWorks / row.works : 0,
      fourKShare: row.files > 0 ? row.fourKFiles / row.files : 0,
      fullHdShare: row.files > 0 ? row.fullHdFiles / row.files : 0,
      probeCoverage: row.files > 0 ? row.probedFiles / row.files : 0,
      variantRate: row.files > 0 ? Math.max(0, row.files - row.works) / row.files : 0
    };
  });

  const releaseHeatmap = (db.prepare(`${scopeCte}
    SELECT CAST(strftime('%Y', metadata.release_date) AS INTEGER) AS year,
      CAST(strftime('%m', metadata.release_date) AS INTEGER) AS month,
      COUNT(*) AS works
    FROM scoped_works works
    JOIN media_metadata metadata ON metadata.normalized_code = works.normalized_code
    WHERE date(metadata.release_date) IS NOT NULL
    GROUP BY strftime('%Y', metadata.release_date), strftime('%m', metadata.release_date)
    ORDER BY year, month
  `).all(params) as NumericRow[]).map((row) => ({
    year: numberValue(row, "year"),
    month: numberValue(row, "month"),
    works: numberValue(row, "works")
  }));

  const categoryYearTrend = (db.prepare(`${scopeCte},
    category_candidates AS (
      SELECT normalized_code,
        COALESCE(NULLIF(library_category, ''), '其他') AS category,
        COUNT(*) AS categoryFiles
      FROM scoped_files
      WHERE normalized_code != ''
      GROUP BY normalized_code, category
    ),
    category_ranked AS (
      SELECT normalized_code, category,
        ROW_NUMBER() OVER (PARTITION BY normalized_code ORDER BY categoryFiles DESC, category COLLATE NOCASE) AS rank
      FROM category_candidates
    )
    SELECT CAST(strftime('%Y', metadata.release_date) AS INTEGER) AS year,
      categories.category,
      COUNT(*) AS works
    FROM scoped_works works
    JOIN category_ranked categories ON categories.normalized_code = works.normalized_code AND categories.rank = 1
    JOIN media_metadata metadata ON metadata.normalized_code = works.normalized_code
    WHERE date(metadata.release_date) IS NOT NULL
    GROUP BY strftime('%Y', metadata.release_date), categories.category
    ORDER BY year, categories.category
  `).all(params) as NumericRow[]).map((row) => ({
    year: numberValue(row, "year"),
    category: String(row.category ?? "其他"),
    works: numberValue(row, "works")
  }));

  const catalogGrowth = (db.prepare(`${scopeCte}
    , daily_growth AS (
      SELECT date(first_seen_at) AS day,
        COUNT(*) AS files,
        COUNT(DISTINCT NULLIF(normalized_code, '')) AS works,
        COALESCE(SUM(size), 0) AS bytes
      FROM scoped_files
      WHERE datetime(first_seen_at) IS NOT NULL
      GROUP BY date(first_seen_at)
    )
    SELECT day, files, works, bytes,
      SUM(files) OVER (ORDER BY day) AS cumulativeFiles,
      SUM(works) OVER (ORDER BY day) AS cumulativeWorks,
      SUM(bytes) OVER (ORDER BY day) AS cumulativeBytes
    FROM daily_growth
    ORDER BY day
  `).all(params) as NumericRow[]).map((row) => ({
    day: String(row.day ?? ""),
    files: numberValue(row, "files"),
    works: numberValue(row, "works"),
    bytes: numberValue(row, "bytes"),
    cumulativeFiles: numberValue(row, "cumulativeFiles"),
    cumulativeWorks: numberValue(row, "cumulativeWorks"),
    cumulativeBytes: numberValue(row, "cumulativeBytes")
  }));

  const libraryMix = mapDistributionRows(
    db.prepare(`${scopeCte},
      category_candidates AS (
        SELECT CASE WHEN normalized_code = '' THEN id ELSE normalized_code END AS workKey,
          COALESCE(NULLIF(library_category, ''), '其他') AS category,
          COUNT(*) AS categoryFiles
        FROM scoped_files
        GROUP BY workKey, category
      ),
      category_ranked AS (
        SELECT workKey, category,
          ROW_NUMBER() OVER (PARTITION BY workKey ORDER BY categoryFiles DESC, category COLLATE NOCASE) AS rank
        FROM category_candidates
      ),
      category_works AS (
        SELECT category, COUNT(*) AS works
        FROM category_ranked
        WHERE rank = 1
        GROUP BY category
      )
      SELECT COALESCE(NULLIF(files.library_category, ''), '其他') AS category,
        COUNT(*) AS files,
        COALESCE(MAX(category_works.works), 0) AS works,
        COALESCE(SUM(files.size), 0) AS bytes
      FROM scoped_files files
      LEFT JOIN category_works ON category_works.category = COALESCE(NULLIF(files.library_category, ''), '其他')
      GROUP BY category
      ORDER BY works DESC, files DESC
    `).all(params) as NumericRow[],
    "category"
  );

  const sourceMix = mapDistributionRows(
    db.prepare(`${scopeCte}
      SELECT COALESCE(NULLIF(source_name, ''), '未命名来源') AS source,
        COUNT(*) AS files,
        COUNT(DISTINCT NULLIF(normalized_code, '')) AS works,
        COALESCE(SUM(size), 0) AS bytes
      FROM scoped_files
      GROUP BY source
      ORDER BY bytes DESC, files DESC
    `).all(params) as NumericRow[],
    "source"
  );

  const sourceProfiles = (db.prepare(`${scopeCte}
    SELECT COALESCE(NULLIF(source_name, ''), '未命名来源') AS source,
      COUNT(*) AS files,
      COUNT(DISTINCT NULLIF(normalized_code, '')) AS works,
      COALESCE(SUM(size), 0) AS bytes,
      COALESCE(SUM(duration_seconds), 0) AS durationSeconds,
      COALESCE(AVG(NULLIF(size, 0)), 0) AS averageFileBytes,
      SUM(CASE WHEN height >= 2160 OR width >= 3840 THEN 1 ELSE 0 END) AS fourKFiles,
      SUM(CASE WHEN height >= 1080 THEN 1 ELSE 0 END) AS fullHdFiles,
      SUM(CASE WHEN compatibility_status = 'native' THEN 1 ELSE 0 END) AS nativeFiles,
      SUM(CASE WHEN compatibility_status IN ('transcode', 'unsupported') THEN 1 ELSE 0 END) AS riskFiles,
      SUM(CASE WHEN probe_status = 'ready' THEN 1 ELSE 0 END) AS probedFiles
    FROM scoped_files
    GROUP BY source
    ORDER BY bytes DESC, files DESC
  `).all(params) as NumericRow[]).map((row) => {
    const files = numberValue(row, "files");
    const works = numberValue(row, "works");
    return {
      key: String(row.source ?? "未命名来源"),
      label: String(row.source ?? "未命名来源"),
      files,
      works,
      bytes: numberValue(row, "bytes"),
      durationSeconds: numberValue(row, "durationSeconds"),
      averageFileBytes: numberValue(row, "averageFileBytes"),
      fourKFiles: numberValue(row, "fourKFiles"),
      fullHdFiles: numberValue(row, "fullHdFiles"),
      nativeFiles: numberValue(row, "nativeFiles"),
      riskFiles: numberValue(row, "riskFiles"),
      probedFiles: numberValue(row, "probedFiles"),
      variantRate: files > 0 ? Math.max(0, files - works) / files : 0
    };
  });

  const facetCoverageRows = db.prepare(`${scopeCte}
    SELECT facets.facet_type AS type,
      COUNT(DISTINCT facets.facet_value) AS distinctValues,
      COUNT(DISTINCT facets.normalized_code) AS coveredWorks,
      COUNT(*) AS totalAssignments
    FROM scoped_works works
    JOIN media_metadata_facets facets ON facets.normalized_code = works.normalized_code
    WHERE facets.facet_type IN ('actor', 'genre', 'series', 'maker', 'label', 'director')
    GROUP BY facets.facet_type
  `).all(params) as NumericRow[];
  const facetCoverage = new Map(facetCoverageRows.map((row) => [String(row.type), row]));
  const facets = Object.fromEntries(ANALYTICS_FACET_TYPES.map((type) => {
    const rawItems = db.prepare(`${scopeCte}
      SELECT facets.facet_value AS value,
        COUNT(DISTINCT facets.normalized_code) AS works,
        COALESCE(SUM(stats.files), 0) AS files,
        COALESCE(SUM(stats.bytes), 0) AS bytes,
        COALESCE(AVG(CASE WHEN metadata.score > 0 THEN metadata.score END), 0) AS averageScore,
        SUM(CASE WHEN metadata.score > 0 THEN 1 ELSE 0 END) AS scoredWorks,
        COALESCE(AVG(CASE
          WHEN metadata.runtime_minutes > 0 THEN metadata.runtime_minutes
          WHEN stats.durationSeconds > 0 AND stats.files > 0 THEN stats.durationSeconds / stats.files / 60.0
        END), 0) AS averageRuntimeMinutes,
        MAX(CASE WHEN date(metadata.release_date) IS NOT NULL THEN metadata.release_date END) AS latestReleaseDate
      FROM scoped_work_stats stats
      JOIN media_metadata_facets facets ON facets.normalized_code = stats.normalized_code
      LEFT JOIN media_metadata metadata ON metadata.normalized_code = stats.normalized_code
      WHERE facets.facet_type = @type
      GROUP BY facets.facet_value
      ORDER BY works DESC, facets.facet_value COLLATE NOCASE
      LIMIT 50
    `).all({ ...params, type }) as NumericRow[];
    const items = rawItems
      .map((row) => {
        const value = String(row.value ?? "");
        return {
          value,
          label: getTopicLabel(type as TopicType, value),
          works: numberValue(row, "works"),
          files: numberValue(row, "files"),
          bytes: numberValue(row, "bytes"),
          averageScore: numberValue(row, "averageScore"),
          scoredWorks: numberValue(row, "scoredWorks"),
          averageRuntimeMinutes: numberValue(row, "averageRuntimeMinutes"),
          latestReleaseDate: textValue(row, "latestReleaseDate")
        };
      })
      .filter((item) => isTopicVisible(type as TopicType, item.value, item.label))
      .slice(0, 24);
    const coverage = facetCoverage.get(type);
    return [type, {
      distinctValues: numberValue(coverage, "distinctValues"),
      coveredWorks: numberValue(coverage, "coveredWorks"),
      totalAssignments: numberValue(coverage, "totalAssignments"),
      items
    } satisfies FacetAnalytics];
  })) as Record<(typeof ANALYTICS_FACET_TYPES)[number], FacetAnalytics>;

  const matrixContext = buildMatrixContext(scopeCte, params, year);
  const actorGenreCrossMatrix = buildFacetPairMatrix({
    context: matrixContext,
    id: "actor-genre",
    title: "演员 × 题材",
    subtitle: "规范化演员身份与题材同义词后的作品级关系",
    rowType: "actor",
    columnType: "genre",
    rowLimit: 48,
    columnLimit: 36
  });
  const makerGenreMatrix = buildFacetPairMatrix({
    context: matrixContext,
    id: "maker-genre",
    title: "厂商 × 题材",
    subtitle: "比较厂商内容结构、主导题材与相对全库偏移",
    rowType: "maker",
    columnType: "genre",
    rowLimit: 30,
    columnLimit: 30
  });
  const directorGenreMatrix = buildFacetPairMatrix({
    context: matrixContext,
    id: "director-genre",
    title: "导演 × 题材",
    subtitle: "观察导演题材组合与稳定创作倾向",
    rowType: "director",
    columnType: "genre",
    rowLimit: 30,
    columnLimit: 30
  });
  const seriesActorMatrix = buildFacetPairMatrix({
    context: matrixContext,
    id: "series-actor",
    title: "系列 × 演员",
    subtitle: "识别系列与演员之间的长期合作和馆藏集中度",
    rowType: "series",
    columnType: "actor",
    rowLimit: 30,
    columnLimit: 30
  });
  const genreYearMatrix = buildGenreYearMatrix(matrixContext);
  const sourceResolutionMatrix = buildSourceResolutionMatrix(scopeCte, params);
  const sourceCompatibilityMatrix = buildSourceCompatibilityMatrix(scopeCte, params);
  const crossMatrices = [
    actorGenreCrossMatrix,
    makerGenreMatrix,
    directorGenreMatrix,
    seriesActorMatrix,
    genreYearMatrix,
    sourceResolutionMatrix,
    sourceCompatibilityMatrix
  ];

  const matrixActors = actorGenreCrossMatrix.rows.slice(0, 8);
  const matrixGenres = actorGenreCrossMatrix.columns.slice(0, 8);
  const matrixActorKeys = new Set(matrixActors.map((item) => item.key));
  const matrixGenreKeys = new Set(matrixGenres.map((item) => item.key));
  const contentMatrixCells = actorGenreCrossMatrix.cells
    .filter((cell) => matrixActorKeys.has(cell.rowKey) && matrixGenreKeys.has(cell.columnKey))
    .map((cell) => ({ rowKey: cell.rowKey, columnKey: cell.columnKey, works: cell.value }));
  const contentMatrix = {
    rows: matrixActors.map((item) => ({ key: item.key, label: item.label })),
    columns: matrixGenres.map((item) => ({ key: item.key, label: item.label })),
    cells: contentMatrixCells
  };

  const actorScopeCte = createActorScopeCte(year);
  const actorFacetValues = (db.prepare(`${actorScopeCte}
    SELECT DISTINCT facets.facet_value AS value
    FROM actor_scoped_works works
    JOIN media_metadata_facets facets
      ON facets.normalized_code = works.normalized_code AND facets.facet_type = 'actor'
  `).all(params) as NumericRow[]).map((row) => String(row.value ?? ""));
  const invalidActorValues = actorFacetValues.filter((value) => !isActorNameCandidate(value));
  const invalidActorParameters = Object.fromEntries(invalidActorValues.map((value, index) => [`invalidActor${index}`, value]));
  const validActorPredicate = invalidActorValues.length > 0
    ? `facets.facet_value NOT IN (${invalidActorValues.map((_, index) => `@invalidActor${index}`).join(", ")})`
    : "1 = 1";
  const actorParams = { ...params, ...invalidActorParameters };
  const actorAnalyticsCte = `${actorScopeCte},
    visible_actor_facets AS (
      SELECT facets.normalized_code, facets.facet_value
      FROM actor_scoped_works works
      JOIN media_metadata_facets facets
        ON facets.normalized_code = works.normalized_code AND facets.facet_type = 'actor'
      WHERE ${validActorPredicate}
    )
  `;

  const actorScopeRow = db.prepare(`${actorAnalyticsCte}
    SELECT
      (SELECT COUNT(*) FROM actor_scoped_works) AS totalWorks,
      (SELECT COUNT(DISTINCT normalized_code) FROM visible_actor_facets) AS actorCoveredWorks,
      (SELECT COUNT(DISTINCT facet_value) FROM visible_actor_facets) AS validActors,
      (SELECT COUNT(*) FROM visible_actor_facets) AS assignments
  `).get(actorParams) as NumericRow | undefined;
  const excludedFc2Row = db.prepare(`${scopeCte}
    SELECT COUNT(DISTINCT NULLIF(normalized_code, '')) AS works
    FROM scoped_files
    WHERE UPPER(COALESCE(NULLIF(library_category, ''), 'JAV')) = 'FC2'
  `).get(params) as NumericRow | undefined;
  const invalidActorAssignmentRow = invalidActorValues.length === 0
    ? undefined
    : db.prepare(`${actorScopeCte}
      SELECT COUNT(*) AS assignments
      FROM actor_scoped_works works
      JOIN media_metadata_facets facets
        ON facets.normalized_code = works.normalized_code AND facets.facet_type = 'actor'
      WHERE facets.facet_value IN (${invalidActorValues.map((_, index) => `@invalidActor${index}`).join(", ")})
    `).get(actorParams) as NumericRow | undefined;
  const actorTotalWorks = numberValue(actorScopeRow, "totalWorks");
  const actorCoveredWorks = numberValue(actorScopeRow, "actorCoveredWorks");
  const validActorCount = numberValue(actorScopeRow, "validActors");
  const actorAssignments = numberValue(actorScopeRow, "assignments");

  const actorWorkBands = (db.prepare(`${actorAnalyticsCte},
    actor_counts AS (
      SELECT facet_value, COUNT(DISTINCT normalized_code) AS works
      FROM visible_actor_facets
      GROUP BY facet_value
    ),
    banded AS (
      SELECT CASE
          WHEN works = 1 THEN 'one'
          WHEN works <= 4 THEN 'twoToFour'
          WHEN works <= 9 THEN 'fiveToNine'
          WHEN works <= 24 THEN 'tenToTwentyFour'
          WHEN works <= 49 THEN 'twentyFiveToFortyNine'
          ELSE 'fiftyPlus'
        END AS band,
        CASE
          WHEN works = 1 THEN 1
          WHEN works <= 4 THEN 2
          WHEN works <= 9 THEN 3
          WHEN works <= 24 THEN 4
          WHEN works <= 49 THEN 5
          ELSE 6
        END AS sortOrder,
        works
      FROM actor_counts
    )
    SELECT band, COUNT(*) AS actors, SUM(works) AS assignments
    FROM banded
    GROUP BY band
    ORDER BY MIN(sortOrder)
  `).all(actorParams) as NumericRow[]).map((row) => {
    const key = String(row.band ?? "one");
    const actors = numberValue(row, "actors");
    const assignments = numberValue(row, "assignments");
    return {
      key,
      label: ({
        one: "1 部",
        twoToFour: "2–4 部",
        fiveToNine: "5–9 部",
        tenToTwentyFour: "10–24 部",
        twentyFiveToFortyNine: "25–49 部",
        fiftyPlus: "50+ 部"
      } as Record<string, string>)[key] ?? key,
      actors,
      assignments,
      actorShare: validActorCount > 0 ? actors / validActorCount : 0,
      assignmentShare: actorAssignments > 0 ? assignments / actorAssignments : 0
    };
  });

  const actorCastSizeBands = (db.prepare(`${actorAnalyticsCte},
    work_cast AS (
      SELECT works.normalized_code, COUNT(DISTINCT actors.facet_value) AS actors
      FROM actor_scoped_works works
      LEFT JOIN visible_actor_facets actors ON actors.normalized_code = works.normalized_code
      GROUP BY works.normalized_code
    ),
    banded AS (
      SELECT CASE
          WHEN actors = 0 THEN 'missing'
          WHEN actors = 1 THEN 'one'
          WHEN actors = 2 THEN 'two'
          WHEN actors = 3 THEN 'three'
          WHEN actors <= 5 THEN 'fourToFive'
          ELSE 'sixPlus'
        END AS band,
        CASE
          WHEN actors = 0 THEN 0
          WHEN actors = 1 THEN 1
          WHEN actors = 2 THEN 2
          WHEN actors = 3 THEN 3
          WHEN actors <= 5 THEN 4
          ELSE 5
        END AS sortOrder,
        actors
      FROM work_cast
    )
    SELECT band, COUNT(*) AS works
    FROM banded
    GROUP BY band
    ORDER BY MIN(sortOrder)
  `).all(actorParams) as NumericRow[]).map((row) => {
    const key = String(row.band ?? "missing");
    return {
      key,
      label: ({ missing: "演员缺失", one: "单演员", two: "2 人", three: "3 人", fourToFive: "4–5 人", sixPlus: "6+ 人" } as Record<string, string>)[key] ?? key,
      works: numberValue(row, "works")
    };
  });

  const actorSummaries = (db.prepare(`${actorAnalyticsCte}
    SELECT actors.facet_value AS value,
      COUNT(DISTINCT actors.normalized_code) AS works,
      MIN(CASE WHEN date(metadata.release_date) IS NOT NULL THEN metadata.release_date END) AS firstReleaseDate,
      MAX(CASE WHEN date(metadata.release_date) IS NOT NULL THEN metadata.release_date END) AS lastReleaseDate,
      COUNT(DISTINCT CASE WHEN date(metadata.release_date) IS NOT NULL THEN strftime('%Y', metadata.release_date) END) AS activeYears,
      SUM(CASE WHEN metadata.score > 0 THEN 1 ELSE 0 END) AS scoredWorks,
      COALESCE(AVG(CASE WHEN metadata.score > 0 THEN metadata.score END), 0) AS averageScore
    FROM visible_actor_facets actors
    LEFT JOIN media_metadata metadata ON metadata.normalized_code = actors.normalized_code
    GROUP BY actors.facet_value
    ORDER BY works DESC, actors.facet_value COLLATE NOCASE
    LIMIT 48
  `).all(actorParams) as NumericRow[]).map((row) => {
    const value = String(row.value ?? "");
    return {
      value,
      label: getTopicLabel("actor", value),
      works: numberValue(row, "works"),
      firstReleaseDate: textValue(row, "firstReleaseDate"),
      lastReleaseDate: textValue(row, "lastReleaseDate"),
      activeYears: numberValue(row, "activeYears"),
      scoredWorks: numberValue(row, "scoredWorks"),
      averageScore: numberValue(row, "averageScore")
    };
  }).filter((item) => isTopicVisible("actor", item.value, item.label));

  const activityActors = actorSummaries.slice(0, 18);
  const actorActivityRows = activityActors.length === 0
    ? []
    : (db.prepare(`${actorAnalyticsCte}
      SELECT actors.facet_value AS actorValue,
        CAST(strftime('%Y', metadata.release_date) AS INTEGER) AS year,
        COUNT(DISTINCT actors.normalized_code) AS works
      FROM visible_actor_facets actors
      JOIN media_metadata metadata ON metadata.normalized_code = actors.normalized_code
      WHERE actors.facet_value IN (${activityActors.map((_, index) => `@activityActor${index}`).join(", ")})
        AND date(metadata.release_date) IS NOT NULL
      GROUP BY actors.facet_value, strftime('%Y', metadata.release_date)
      ORDER BY year, actors.facet_value
    `).all({
      ...actorParams,
      ...Object.fromEntries(activityActors.map((item, index) => [`activityActor${index}`, item.value]))
    }) as NumericRow[]).map((row) => ({
      actorValue: String(row.actorValue ?? ""),
      year: numberValue(row, "year"),
      works: numberValue(row, "works")
    }));
  const activityYears = [...new Set(actorActivityRows.map((item) => item.year))].sort((left, right) => left - right).slice(-14);
  const activityYearSet = new Set(activityYears);
  const actorWorksByValue = new Map(activityActors.map((item) => [item.value, item.works]));
  const actorActivityCells = actorActivityRows.filter((item) => activityYearSet.has(item.year)).map((item) => ({
    ...item,
    share: item.works / Math.max(1, actorWorksByValue.get(item.actorValue) ?? 0)
  }));

  const affinityActors = actorGenreCrossMatrix.rows.map((item) => {
    const works = matrixContext.works.filter((work) => work.facets.actor.has(item.key));
    const datedWorks = works.filter((work) => work.releaseDate && work.releaseYear !== null);
    const scoredWorks = works.filter((work) => work.score > 0);
    return {
      value: item.key,
      canonicalValue: item.key,
      label: item.label,
      aliases: item.aliases,
      works: item.value,
      firstReleaseDate: datedWorks.map((work) => work.releaseDate!).sort()[0] ?? null,
      lastReleaseDate: datedWorks.map((work) => work.releaseDate!).sort().at(-1) ?? null,
      activeYears: new Set(datedWorks.map((work) => work.releaseYear)).size,
      scoredWorks: scoredWorks.length,
      averageScore: scoredWorks.length > 0 ? scoredWorks.reduce((sum, work) => sum + work.score, 0) / scoredWorks.length : 0
    };
  });
  const affinityGenres = actorGenreCrossMatrix.columns.map((item) => ({
    value: item.key,
    label: item.label,
    aliases: item.aliases,
    group: item.group ?? "theme",
    works: item.value,
    globalShare: item.value / Math.max(1, actorGenreCrossMatrix.total)
  }));
  const actorGenreCells = actorGenreCrossMatrix.cells.map((cell) => ({
    actorValue: cell.rowKey,
    genreValue: cell.columnKey,
    works: cell.value,
    actorShare: cell.rowShare,
    globalShare: cell.globalShare,
    lift: cell.lift,
    smoothedLift: cell.smoothedLift,
    expectedWorks: cell.expectedValue,
    confidence: cell.confidence,
    stable: cell.stable,
    recentWorks: cell.recentValue,
    previousWorks: cell.previousValue
  }));

  const actorScoreGlobalRow = db.prepare(`${actorScopeCte}
    SELECT COALESCE(AVG(metadata.score), 0) AS averageScore
    FROM actor_scoped_works works
    JOIN media_metadata metadata ON metadata.normalized_code = works.normalized_code
    WHERE metadata.score > 0
  `).get(params) as NumericRow | undefined;
  const actorGlobalAverageScore = numberValue(actorScoreGlobalRow, "averageScore");
  const actorScorePoints = (db.prepare(`${actorAnalyticsCte}
    SELECT actors.facet_value AS value,
      COUNT(DISTINCT actors.normalized_code) AS works,
      SUM(CASE WHEN metadata.score > 0 THEN 1 ELSE 0 END) AS scoredWorks,
      COALESCE(AVG(CASE WHEN metadata.score > 0 THEN metadata.score END), 0) AS averageScore,
      COALESCE(AVG(CASE WHEN metadata.runtime_minutes > 0 THEN metadata.runtime_minutes END), 0) AS averageRuntimeMinutes,
      MAX(CASE WHEN date(metadata.release_date) IS NOT NULL THEN metadata.release_date END) AS latestReleaseDate
    FROM visible_actor_facets actors
    LEFT JOIN media_metadata metadata ON metadata.normalized_code = actors.normalized_code
    GROUP BY actors.facet_value
    HAVING SUM(CASE WHEN metadata.score > 0 THEN 1 ELSE 0 END) >= 10
    ORDER BY scoredWorks DESC, works DESC
    LIMIT 120
  `).all(actorParams) as NumericRow[]).map((row) => {
    const value = String(row.value ?? "");
    const scoredWorks = numberValue(row, "scoredWorks");
    const averageScore = numberValue(row, "averageScore");
    return {
      value,
      label: getTopicLabel("actor", value),
      works: numberValue(row, "works"),
      scoredWorks,
      averageScore,
      adjustedScore: (averageScore * scoredWorks + actorGlobalAverageScore * 10) / Math.max(1, scoredWorks + 10),
      averageRuntimeMinutes: numberValue(row, "averageRuntimeMinutes"),
      latestReleaseDate: textValue(row, "latestReleaseDate")
    };
  }).filter((item) => isTopicVisible("actor", item.value, item.label));

  const actorCollaborationPairs = (db.prepare(`${actorAnalyticsCte}
    SELECT left_actor.facet_value AS source,
      right_actor.facet_value AS target,
      COUNT(DISTINCT left_actor.normalized_code) AS works
    FROM visible_actor_facets left_actor
    JOIN visible_actor_facets right_actor
      ON right_actor.normalized_code = left_actor.normalized_code
      AND right_actor.facet_value > left_actor.facet_value
    GROUP BY left_actor.facet_value, right_actor.facet_value
    HAVING COUNT(DISTINCT left_actor.normalized_code) >= 3
    ORDER BY works DESC, source, target
    LIMIT 600
  `).all(actorParams) as NumericRow[]).map((row) => {
    const source = String(row.source ?? "");
    const target = String(row.target ?? "");
    return {
      source,
      target,
      sourceLabel: getTopicLabel("actor", source),
      targetLabel: getTopicLabel("actor", target),
      works: numberValue(row, "works")
    };
  }).filter((item) => isTopicVisible("actor", item.source, item.sourceLabel) && isTopicVisible("actor", item.target, item.targetLabel));

  const actorProfileRow = db.prepare(`${actorAnalyticsCte},
    actor_entities AS (
      SELECT DISTINCT facet_value FROM visible_actor_facets
    )
    SELECT COUNT(*) AS actors,
      SUM(CASE WHEN profiles.facet_value IS NOT NULL THEN 1 ELSE 0 END) AS profiles,
      SUM(CASE WHEN NULLIF(TRIM(profiles.biography), '') IS NOT NULL THEN 1 ELSE 0 END) AS biographies,
      SUM(CASE WHEN NULLIF(TRIM(profiles.image_url), '') IS NOT NULL THEN 1 ELSE 0 END) AS images,
      SUM(CASE WHEN date(profiles.birth_date) IS NOT NULL THEN 1 ELSE 0 END) AS birthDates,
      SUM(CASE WHEN NULLIF(TRIM(profiles.official_website), '') IS NOT NULL THEN 1 ELSE 0 END) AS officialWebsites,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM entity_profile_sources sources
        WHERE sources.facet_type = 'actor' AND sources.facet_value = actors.facet_value
      ) THEN 1 ELSE 0 END) AS sourcedProfiles
    FROM actor_entities actors
    LEFT JOIN entity_profiles profiles
      ON profiles.facet_type = 'actor' AND profiles.facet_value = actors.facet_value
  `).get(actorParams) as NumericRow | undefined;
  const actorProfileTotal = numberValue(actorProfileRow, "actors");
  const actorProfileCompleteness = [
    ["profiles", "已建档案", numberValue(actorProfileRow, "profiles")],
    ["biographies", "人物简介", numberValue(actorProfileRow, "biographies")],
    ["images", "人物图像", numberValue(actorProfileRow, "images")],
    ["birthDates", "出生日期", numberValue(actorProfileRow, "birthDates")],
    ["officialWebsites", "官方网站", numberValue(actorProfileRow, "officialWebsites")],
    ["sourcedProfiles", "可追溯来源", numberValue(actorProfileRow, "sourcedProfiles")]
  ].map(([key, label, value]) => ({
    key: String(key),
    label: String(label),
    value: Number(value),
    total: actorProfileTotal,
    rate: actorProfileTotal > 0 ? Number(value) / actorProfileTotal : 0
  }));

  const actorCoverageByYear = (db.prepare(`${actorAnalyticsCte}
    SELECT COALESCE(strftime('%Y', metadata.release_date), 'undated') AS year,
      COUNT(*) AS works,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM visible_actor_facets actors WHERE actors.normalized_code = works.normalized_code
      ) THEN 1 ELSE 0 END) AS actorWorks
    FROM actor_scoped_works works
    LEFT JOIN media_metadata metadata ON metadata.normalized_code = works.normalized_code
    GROUP BY year
    ORDER BY CASE WHEN year = 'undated' THEN 1 ELSE 0 END, year
  `).all(actorParams) as NumericRow[]).map((row) => {
    const works = numberValue(row, "works");
    const actorWorks = numberValue(row, "actorWorks");
    return {
      year: String(row.year ?? "undated"),
      works,
      actorWorks,
      rate: works > 0 ? actorWorks / works : 0
    };
  });
  const actorCoverageByProvider = (db.prepare(`${actorAnalyticsCte}
    SELECT COALESCE(NULLIF(TRIM(metadata.provider), ''), '__unrecognized__') AS key,
      CASE WHEN NULLIF(TRIM(metadata.provider), '') IS NULL THEN '未识别' ELSE TRIM(metadata.provider) END AS label,
      COUNT(*) AS works,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM visible_actor_facets actors WHERE actors.normalized_code = works.normalized_code
      ) THEN 1 ELSE 0 END) AS actorWorks
    FROM actor_scoped_works works
    LEFT JOIN media_metadata metadata ON metadata.normalized_code = works.normalized_code
    GROUP BY key
    ORDER BY works DESC, key
  `).all(actorParams) as NumericRow[]).map((row) => {
    const works = numberValue(row, "works");
    const actorWorks = numberValue(row, "actorWorks");
    return {
      key: String(row.key ?? "__unrecognized__"),
      label: String(row.label ?? "未识别"),
      works,
      actorWorks,
      rate: works > 0 ? actorWorks / works : 0,
      applicable: true
    };
  });

  const actorAnalytics = {
    scope: {
      totalWorks: actorTotalWorks,
      actorCoveredWorks,
      actorCoverage: actorTotalWorks > 0 ? actorCoveredWorks / actorTotalWorks : 0,
      excludedFc2Works: numberValue(excludedFc2Row, "works"),
      validActors: validActorCount,
      assignments: actorAssignments,
      invalidActors: invalidActorValues.length,
      invalidAssignments: numberValue(invalidActorAssignmentRow, "assignments")
    },
    workBands: actorWorkBands,
    castSizeBands: actorCastSizeBands,
    activity: {
      years: activityYears,
      actors: activityActors,
      cells: actorActivityCells
    },
    genreAffinity: {
      actors: affinityActors,
      genres: affinityGenres,
      cells: actorGenreCells
    },
    score: {
      globalAverage: actorGlobalAverageScore,
      points: actorScorePoints
    },
    collaboration: {
      actors: actorSummaries,
      pairs: actorCollaborationPairs
    },
    profileCompleteness: actorProfileCompleteness,
    coverageByYear: actorCoverageByYear,
    coverageByProvider: actorCoverageByProvider
  };

  const resolutions = mapDistributionRows(
    db.prepare(`${scopeCte}
      SELECT CASE
        WHEN height >= 2160 OR width >= 3840 THEN '4k'
        WHEN height >= 1080 THEN '1080p'
        WHEN height >= 720 THEN '720p'
        WHEN height > 0 OR width > 0 THEN 'sd'
        ELSE 'unknown'
      END AS resolution,
      COUNT(*) AS files, COUNT(DISTINCT NULLIF(normalized_code, '')) AS works,
      COALESCE(SUM(size), 0) AS bytes
      FROM scoped_files
      GROUP BY resolution
      ORDER BY CASE resolution WHEN '4k' THEN 1 WHEN '1080p' THEN 2 WHEN '720p' THEN 3 WHEN 'sd' THEN 4 ELSE 5 END
    `).all(params) as NumericRow[],
    "resolution",
    resolutionLabels
  );

  const codecs = mapDistributionRows(
    db.prepare(`${scopeCte}
      SELECT LOWER(COALESCE(NULLIF(video_codec, ''), 'unknown')) AS codec,
        COUNT(*) AS files, COUNT(DISTINCT NULLIF(normalized_code, '')) AS works,
        COALESCE(SUM(size), 0) AS bytes
      FROM scoped_files
      GROUP BY codec
      ORDER BY files DESC
      LIMIT 8
    `).all(params) as NumericRow[],
    "codec",
    { h264: "H.264", hevc: "HEVC / H.265", av1: "AV1", vp9: "VP9", mpeg4: "MPEG-4", unknown: "未知" }
  );

  const containers = mapDistributionRows(
    db.prepare(`${scopeCte}
      SELECT LOWER(COALESCE(NULLIF(container_format, ''), 'unknown')) AS container,
        COUNT(*) AS files, COUNT(DISTINCT NULLIF(normalized_code, '')) AS works,
        COALESCE(SUM(size), 0) AS bytes
      FROM scoped_files
      GROUP BY container
      ORDER BY files DESC
      LIMIT 8
    `).all(params) as NumericRow[],
    "container",
    { mov: "MOV / MP4", matroska: "Matroska / MKV", avi: "AVI", mpegts: "MPEG-TS", asf: "ASF / WMV", mpeg: "MPEG", unknown: "未知" }
  );

  const audioCodecs = mapDistributionRows(
    db.prepare(`${scopeCte}
      SELECT LOWER(COALESCE(NULLIF(audio_codec, ''), 'unknown')) AS codec,
        COUNT(*) AS files, COUNT(DISTINCT NULLIF(normalized_code, '')) AS works,
        COALESCE(SUM(size), 0) AS bytes
      FROM scoped_files
      GROUP BY codec
      ORDER BY files DESC
      LIMIT 10
    `).all(params) as NumericRow[],
    "codec",
    audioCodecLabels
  );

  const extensions = mapDistributionRows(
    db.prepare(`${scopeCte}
      SELECT LOWER(COALESCE(NULLIF(extension, ''), 'unknown')) AS extension,
        COUNT(*) AS files, COUNT(DISTINCT NULLIF(normalized_code, '')) AS works,
        COALESCE(SUM(size), 0) AS bytes
      FROM scoped_files
      GROUP BY extension
      ORDER BY files DESC
      LIMIT 10
    `).all(params) as NumericRow[],
    "extension"
  );

  const resolutionCodecMatrix = (db.prepare(`${scopeCte}
    SELECT CASE
        WHEN height >= 2160 OR width >= 3840 THEN '4k'
        WHEN height >= 1080 THEN '1080p'
        WHEN height >= 720 THEN '720p'
        WHEN height > 0 OR width > 0 THEN 'sd'
        ELSE 'unknown'
      END AS resolution,
      LOWER(COALESCE(NULLIF(video_codec, ''), 'unknown')) AS codec,
      COUNT(*) AS files,
      COALESCE(SUM(size), 0) AS bytes
    FROM scoped_files
    GROUP BY resolution, codec
    ORDER BY files DESC
  `).all(params) as NumericRow[]).map((row) => {
    const resolution = String(row.resolution ?? "unknown");
    const codec = String(row.codec ?? "unknown");
    return {
      rowKey: resolution,
      rowLabel: resolutionLabels[resolution] ?? resolution,
      columnKey: codec,
      columnLabel: ({ h264: "H.264", hevc: "HEVC", av1: "AV1", vp9: "VP9", mpeg4: "MPEG-4", unknown: "未知" } as Record<string, string>)[codec] ?? codec,
      files: numberValue(row, "files"),
      bytes: numberValue(row, "bytes")
    };
  });

  const compatibility = mapDistributionRows(
    db.prepare(`${scopeCte}
      SELECT COALESCE(NULLIF(compatibility_status, ''), 'unknown') AS compatibility,
        COUNT(*) AS files, COUNT(DISTINCT NULLIF(normalized_code, '')) AS works,
        COALESCE(SUM(size), 0) AS bytes
      FROM scoped_files
      GROUP BY compatibility
      ORDER BY files DESC
    `).all(params) as NumericRow[],
    "compatibility",
    compatibilityLabels
  );

  const durationBands = (db.prepare(`${scopeCte}
    SELECT CASE
        WHEN duration_seconds IS NULL OR duration_seconds <= 0 THEN 'unknown'
        WHEN duration_seconds < 3600 THEN 'under60'
        WHEN duration_seconds < 5400 THEN '60to89'
        WHEN duration_seconds < 7200 THEN '90to119'
        WHEN duration_seconds < 10800 THEN '120to179'
        ELSE '180plus'
      END AS band,
      CASE
        WHEN duration_seconds IS NULL OR duration_seconds <= 0 THEN 6
        WHEN duration_seconds < 3600 THEN 1
        WHEN duration_seconds < 5400 THEN 2
        WHEN duration_seconds < 7200 THEN 3
        WHEN duration_seconds < 10800 THEN 4
        ELSE 5
      END AS sortOrder,
      COUNT(*) AS files
    FROM scoped_files
    GROUP BY band
    ORDER BY sortOrder
  `).all(params) as NumericRow[]).map((row) => ({
    key: String(row.band),
    label: ({ under60: "< 60 分", "60to89": "60–89 分", "90to119": "90–119 分", "120to179": "120–179 分", "180plus": "≥ 180 分", unknown: "未知" } as Record<string, string>)[String(row.band)] ?? String(row.band),
    files: numberValue(row, "files")
  }));

  const fileSizeBands = (db.prepare(`${scopeCte}
    SELECT CASE
        WHEN size < 1073741824 THEN 'under1'
        WHEN size < 2147483648 THEN '1to2'
        WHEN size < 4294967296 THEN '2to4'
        WHEN size < 6442450944 THEN '4to6'
        WHEN size < 8589934592 THEN '6to8'
        WHEN size < 12884901888 THEN '8to12'
        ELSE '12plus'
      END AS band,
      CASE
        WHEN size < 1073741824 THEN 1
        WHEN size < 2147483648 THEN 2
        WHEN size < 4294967296 THEN 3
        WHEN size < 6442450944 THEN 4
        WHEN size < 8589934592 THEN 5
        WHEN size < 12884901888 THEN 6
        ELSE 7
      END AS sortOrder,
      COUNT(*) AS files,
      COALESCE(SUM(size), 0) AS bytes
    FROM scoped_files
    GROUP BY band
    ORDER BY sortOrder
  `).all(params) as NumericRow[]).map((row) => ({
    key: String(row.band),
    label: ({ under1: "< 1 GB", "1to2": "1–2 GB", "2to4": "2–4 GB", "4to6": "4–6 GB", "6to8": "6–8 GB", "8to12": "8–12 GB", "12plus": "≥ 12 GB" } as Record<string, string>)[String(row.band)] ?? String(row.band),
    files: numberValue(row, "files"),
    bytes: numberValue(row, "bytes")
  }));

  const boxPlotMakers = facets.maker.items.slice(0, 8);
  const durationBoxPlots = boxPlotMakers.length === 0
    ? []
    : (db.prepare(`${scopeCte},
      maker_durations AS (
        SELECT facets.facet_value AS maker,
          CASE
            WHEN metadata.runtime_minutes > 0 THEN metadata.runtime_minutes
            WHEN stats.durationSeconds > 0 AND stats.files > 0 THEN stats.durationSeconds / stats.files / 60.0
          END AS minutes
        FROM scoped_work_stats stats
        JOIN media_metadata_facets facets
          ON facets.normalized_code = stats.normalized_code AND facets.facet_type = 'maker'
        LEFT JOIN media_metadata metadata ON metadata.normalized_code = stats.normalized_code
        WHERE facets.facet_value IN (${boxPlotMakers.map((_, index) => `@boxMaker${index}`).join(", ")})
      ),
      ranked AS (
        SELECT maker, minutes,
          PERCENT_RANK() OVER (PARTITION BY maker ORDER BY minutes) AS percentile
        FROM maker_durations
        WHERE minutes > 0
      )
      SELECT maker, COUNT(*) AS sampleSize,
        MIN(minutes) AS minimum,
        MIN(CASE WHEN percentile >= 0.25 THEN minutes END) AS q1,
        MIN(CASE WHEN percentile >= 0.50 THEN minutes END) AS median,
        MIN(CASE WHEN percentile >= 0.75 THEN minutes END) AS q3,
        MAX(minutes) AS maximum
      FROM ranked
      GROUP BY maker
      ORDER BY sampleSize DESC
    `).all({
      ...params,
      ...Object.fromEntries(boxPlotMakers.map((item, index) => [`boxMaker${index}`, item.value]))
    }) as NumericRow[]).map((row) => {
      const key = String(row.maker ?? "");
      return {
        key,
        label: boxPlotMakers.find((item) => item.value === key)?.label ?? key,
        sampleSize: numberValue(row, "sampleSize"),
        minimum: numberValue(row, "minimum"),
        q1: numberValue(row, "q1"),
        median: numberValue(row, "median"),
        q3: numberValue(row, "q3"),
        maximum: numberValue(row, "maximum")
      };
    });

  const scoreBands = (db.prepare(`${scopeCte}
    SELECT CASE
        WHEN metadata.score IS NULL OR metadata.score <= 0 THEN 'unrated'
        WHEN metadata.score < 3 THEN 'under3'
        WHEN metadata.score < 4 THEN '3to39'
        WHEN metadata.score < 4.5 THEN '4to44'
        ELSE '45to5'
      END AS band,
      CASE
        WHEN metadata.score IS NULL OR metadata.score <= 0 THEN 5
        WHEN metadata.score < 3 THEN 1
        WHEN metadata.score < 4 THEN 2
        WHEN metadata.score < 4.5 THEN 3
        ELSE 4
      END AS sortOrder,
      COUNT(*) AS works
    FROM scoped_works works
    LEFT JOIN media_metadata metadata ON metadata.normalized_code = works.normalized_code
    GROUP BY band
    ORDER BY sortOrder
  `).all(params) as NumericRow[]).map((row) => ({
    key: String(row.band),
    label: ({ under3: "< 3.0", "3to39": "3.0–3.9", "4to44": "4.0–4.4", "45to5": "4.5–5.0", unrated: "暂无评分" } as Record<string, string>)[String(row.band)] ?? String(row.band),
    works: numberValue(row, "works")
  }));

  const variantTags = (db.prepare(`${scopeCte}
    SELECT tags.tag, COUNT(DISTINCT tags.media_id) AS files
    FROM scoped_files files
    JOIN media_variant_tags tags ON tags.media_id = files.id
    GROUP BY tags.tag
    ORDER BY files DESC, tags.tag COLLATE NOCASE
    LIMIT 14
  `).all(params) as NumericRow[]).map((row) => ({
    tag: String(row.tag),
    files: numberValue(row, "files")
  }));

  const variantBands = (db.prepare(`${scopeCte}
    SELECT CASE
        WHEN files = 1 THEN 'single'
        WHEN files = 2 THEN 'two'
        WHEN files = 3 THEN 'three'
        WHEN files = 4 THEN 'four'
        ELSE 'fivePlus'
      END AS band,
      CASE
        WHEN files = 1 THEN 1
        WHEN files = 2 THEN 2
        WHEN files = 3 THEN 3
        WHEN files = 4 THEN 4
        ELSE 5
      END AS sortOrder,
      COUNT(*) AS works,
      SUM(files) AS files,
      COALESCE(SUM(CASE WHEN files > 1 THEN bytes - largestFileBytes ELSE 0 END), 0) AS extraBytes
    FROM scoped_work_stats
    GROUP BY band
    ORDER BY sortOrder
  `).all(params) as NumericRow[]).map((row) => ({
    key: String(row.band),
    label: ({ single: "单版本", two: "2 个版本", three: "3 个版本", four: "4 个版本", fivePlus: "5+ 个版本" } as Record<string, string>)[String(row.band)] ?? String(row.band),
    works: numberValue(row, "works"),
    files: numberValue(row, "files"),
    extraBytes: numberValue(row, "extraBytes")
  }));

  const metadataStatuses = (db.prepare(`${scopeCte}
    SELECT CASE WHEN metadata.normalized_code IS NULL THEN 'missing' ELSE metadata.status END AS status,
      COUNT(*) AS works
    FROM scoped_works works
    LEFT JOIN media_metadata metadata ON metadata.normalized_code = works.normalized_code
    GROUP BY status
    ORDER BY works DESC
  `).all(params) as NumericRow[]).map((row) => {
    const key = String(row.status ?? "missing");
    return { key, label: metadataStatusLabels[key] ?? key, works: numberValue(row, "works") };
  });

  const metadataProviders = (db.prepare(`${scopeCte}
    SELECT COALESCE(NULLIF(TRIM(metadata.provider), ''), '__unrecognized__') AS providerKey,
      CASE
        WHEN NULLIF(TRIM(metadata.provider), '') IS NULL THEN '未识别'
        ELSE TRIM(metadata.provider)
      END AS provider,
      COUNT(*) AS works,
      SUM(CASE WHEN metadata.status = 'ready' THEN 1 ELSE 0 END) AS readyWorks,
      SUM(CASE WHEN metadata.status = 'not_found' THEN 1 ELSE 0 END) AS notFoundWorks,
      SUM(CASE WHEN metadata.status = 'failed' THEN 1 ELSE 0 END) AS failedWorks,
      SUM(CASE WHEN metadata.status = 'ready' AND metadata.translation_status = 'ready' THEN 1 ELSE 0 END) AS translatedWorks,
      SUM(CASE WHEN metadata.status = 'ready' AND NULLIF(TRIM(metadata.title_zh), '') IS NOT NULL THEN 1 ELSE 0 END) AS titleWorks,
      SUM(CASE WHEN metadata.status = 'ready' AND (metadata.cover_url != '' OR metadata.thumb_url != '') THEN 1 ELSE 0 END) AS artworkWorks,
      SUM(CASE WHEN metadata.score > 0 THEN 1 ELSE 0 END) AS scoredWorks,
      COALESCE(AVG(CASE WHEN metadata.score > 0 THEN metadata.score END), 0) AS averageScore,
      COALESCE(AVG(COALESCE(metadata.attempts, 0)), 0) AS averageAttempts,
      SUM(CASE WHEN NULLIF(TRIM(COALESCE(metadata.error, '')), '') IS NOT NULL THEN 1 ELSE 0 END) AS errorWorks,
      SUM(CASE
        WHEN metadata.updated_at IS NULL OR julianday('now') - julianday(metadata.updated_at) >= 90 THEN 1
        ELSE 0
      END) AS staleWorks,
      MIN(metadata.updated_at) AS oldestUpdatedAt,
      MAX(metadata.updated_at) AS latestUpdatedAt,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM media_metadata_facets actors
        WHERE actors.normalized_code = works.normalized_code AND actors.facet_type = 'actor'
      ) THEN 1 ELSE 0 END) AS actorWorks
    FROM scoped_works works
    LEFT JOIN media_metadata metadata ON metadata.normalized_code = works.normalized_code
    GROUP BY COALESCE(NULLIF(TRIM(metadata.provider), ''), '__unrecognized__')
    ORDER BY works DESC, providerKey
  `).all(params) as NumericRow[]).map((row) => ({
    key: String(row.providerKey ?? "__unrecognized__"),
    provider: String(row.provider ?? "未识别"),
    works: numberValue(row, "works"),
    readyWorks: numberValue(row, "readyWorks"),
    notFoundWorks: numberValue(row, "notFoundWorks"),
    failedWorks: numberValue(row, "failedWorks"),
    translatedWorks: numberValue(row, "translatedWorks"),
    titleWorks: numberValue(row, "titleWorks"),
    artworkWorks: numberValue(row, "artworkWorks"),
    scoredWorks: numberValue(row, "scoredWorks"),
    averageScore: numberValue(row, "averageScore"),
    actorWorks: numberValue(row, "actorWorks"),
    averageAttempts: numberValue(row, "averageAttempts"),
    errorWorks: numberValue(row, "errorWorks"),
    staleWorks: numberValue(row, "staleWorks"),
    oldestUpdatedAt: textValue(row, "oldestUpdatedAt"),
    latestUpdatedAt: textValue(row, "latestUpdatedAt")
  }));
  crossMatrices.push(buildProviderGapMatrix(metadataProviders));
  const structureSignals = buildStructureSignals(crossMatrices);

  const coverageByReleaseYear = (db.prepare(`${scopeCte}
    SELECT COALESCE(strftime('%Y', metadata.release_date), 'undated') AS releaseYear,
      COUNT(*) AS works,
      SUM(CASE WHEN metadata.status = 'ready' THEN 1 ELSE 0 END) AS readyWorks,
      SUM(CASE WHEN NULLIF(TRIM(metadata.title_zh), '') IS NOT NULL THEN 1 ELSE 0 END) AS titleWorks,
      SUM(CASE WHEN metadata.translation_status = 'ready' THEN 1 ELSE 0 END) AS translatedWorks,
      SUM(CASE WHEN metadata.cover_url != '' OR metadata.thumb_url != '' THEN 1 ELSE 0 END) AS artworkWorks,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM media_metadata_facets actors
        WHERE actors.normalized_code = works.normalized_code AND actors.facet_type = 'actor'
      ) THEN 1 ELSE 0 END) AS actorWorks,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM media_metadata_facets genres
        WHERE genres.normalized_code = works.normalized_code AND genres.facet_type = 'genre'
      ) THEN 1 ELSE 0 END) AS genreWorks
    FROM scoped_works works
    LEFT JOIN media_metadata metadata ON metadata.normalized_code = works.normalized_code
    GROUP BY releaseYear
    ORDER BY CASE WHEN releaseYear = 'undated' THEN 1 ELSE 0 END, releaseYear
  `).all(params) as NumericRow[]).map((row) => ({
    year: String(row.releaseYear ?? "undated"),
    works: numberValue(row, "works"),
    readyWorks: numberValue(row, "readyWorks"),
    titleWorks: numberValue(row, "titleWorks"),
    translatedWorks: numberValue(row, "translatedWorks"),
    artworkWorks: numberValue(row, "artworkWorks"),
    actorWorks: numberValue(row, "actorWorks"),
    genreWorks: numberValue(row, "genreWorks")
  }));

  const issueRows = (db.prepare(`${scopeCte}
    SELECT issues.issue_type AS type, issues.severity, COUNT(*) AS works
    FROM scoped_works works
    JOIN metadata_quality_issues issues ON issues.normalized_code = works.normalized_code
    GROUP BY issues.issue_type, issues.severity
    ORDER BY works DESC, issues.issue_type
  `).all(params) as NumericRow[]).map((row) => {
    const key = String(row.type);
    return {
      key,
      label: issueLabels[key] ?? key,
      severity: String(row.severity ?? "warning"),
      works: numberValue(row, "works")
    };
  });

  const exceptionWorks = (db.prepare(`${scopeCte},
    issue_summary AS (
      SELECT normalized_code,
        COUNT(*) AS issueCount,
        GROUP_CONCAT(issue_type) AS issueTypes,
        MAX(CASE WHEN severity = 'error' THEN 2 ELSE 1 END) AS severityRank
      FROM metadata_quality_issues
      GROUP BY normalized_code
    )
    SELECT stats.normalized_code AS code,
      COALESCE(NULLIF(metadata.title_zh, ''), NULLIF(metadata.title, ''), stats.normalized_code) AS title,
      metadata.release_date AS releaseDate,
      COALESCE(NULLIF(metadata.provider, ''), '未识别') AS provider,
      COALESCE(metadata.status, 'missing') AS status,
      COALESCE(metadata.translation_status, 'missing') AS translationStatus,
      stats.files, stats.bytes,
      COALESCE(issues.issueCount, 0) AS issueCount,
      COALESCE(issues.issueTypes, '') AS issueTypes,
      COALESCE(issues.severityRank, 0) AS severityRank,
      (CASE WHEN NULLIF(TRIM(metadata.title_zh), '') IS NULL THEN 1 ELSE 0 END
        + CASE WHEN date(metadata.release_date) IS NULL THEN 1 ELSE 0 END
        + CASE WHEN NOT EXISTS (
          SELECT 1 FROM media_metadata_facets actors
          WHERE actors.normalized_code = stats.normalized_code AND actors.facet_type = 'actor'
        ) THEN 1 ELSE 0 END
        + CASE WHEN NOT EXISTS (
          SELECT 1 FROM media_metadata_facets genres
          WHERE genres.normalized_code = stats.normalized_code AND genres.facet_type = 'genre'
        ) THEN 1 ELSE 0 END) AS missingFieldCount
    FROM scoped_work_stats stats
    LEFT JOIN media_metadata metadata ON metadata.normalized_code = stats.normalized_code
    LEFT JOIN issue_summary issues ON issues.normalized_code = stats.normalized_code
    WHERE metadata.status IS NULL
      OR metadata.status != 'ready'
      OR COALESCE(issues.issueCount, 0) > 0
      OR NULLIF(TRIM(metadata.title_zh), '') IS NULL
      OR date(metadata.release_date) IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM media_metadata_facets actors
        WHERE actors.normalized_code = stats.normalized_code AND actors.facet_type = 'actor'
      )
    ORDER BY severityRank DESC, issueCount DESC, missingFieldCount DESC, stats.bytes DESC
    LIMIT 80
  `).all(params) as NumericRow[]).map((row) => ({
    code: String(row.code ?? ""),
    title: String(row.title ?? row.code ?? ""),
    releaseDate: textValue(row, "releaseDate"),
    provider: String(row.provider ?? "未识别"),
    status: String(row.status ?? "missing"),
    translationStatus: String(row.translationStatus ?? "missing"),
    files: numberValue(row, "files"),
    bytes: numberValue(row, "bytes"),
    issueCount: numberValue(row, "issueCount"),
    issueTypes: String(row.issueTypes ?? "").split(",").filter(Boolean).map((key) => ({ key, label: issueLabels[key] ?? key })),
    severity: numberValue(row, "severityRank") >= 2 ? "error" : "warning",
    missingFieldCount: numberValue(row, "missingFieldCount")
  }));

  const profileCoverageRows = db.prepare(`${scopeCte},
    scoped_entities AS (
      SELECT DISTINCT facets.facet_type, facets.facet_value
      FROM scoped_works works
      JOIN media_metadata_facets facets ON facets.normalized_code = works.normalized_code
      WHERE facets.facet_type IN ('actor', 'series', 'maker', 'label', 'director')
    )
    SELECT entities.facet_type AS type,
      COUNT(*) AS entities,
      SUM(CASE WHEN profiles.facet_value IS NOT NULL THEN 1 ELSE 0 END) AS profiles,
      SUM(CASE WHEN profiles.image_url != '' THEN 1 ELSE 0 END) AS images,
      SUM(CASE WHEN profiles.biography != '' THEN 1 ELSE 0 END) AS biographies,
      SUM(CASE WHEN profiles.birth_date IS NOT NULL AND profiles.birth_date != '' THEN 1 ELSE 0 END) AS birthDates,
      SUM(CASE WHEN profiles.official_website != '' THEN 1 ELSE 0 END) AS officialWebsites,
      COALESCE(AVG(CASE WHEN profiles.facet_value IS NOT NULL THEN profiles.confidence END), 0) AS averageConfidence
    FROM scoped_entities entities
    LEFT JOIN entity_profiles profiles
      ON profiles.facet_type = entities.facet_type AND profiles.facet_value = entities.facet_value
    GROUP BY entities.facet_type
    ORDER BY entities DESC
  `).all(params) as NumericRow[];
  const enrichmentRows = db.prepare(`${scopeCte},
    scoped_entities AS (
      SELECT DISTINCT facets.facet_type, facets.facet_value
      FROM scoped_works works
      JOIN media_metadata_facets facets ON facets.normalized_code = works.normalized_code
      WHERE facets.facet_type IN ('actor', 'series', 'maker', 'label', 'director')
    )
    SELECT entities.facet_type AS type,
      enrichment.status,
      COUNT(*) AS entities
    FROM scoped_entities entities
    JOIN entity_profile_enrichment enrichment
      ON enrichment.facet_type = entities.facet_type AND enrichment.facet_value = entities.facet_value
    GROUP BY entities.facet_type, enrichment.status
  `).all(params) as NumericRow[];
  const enrichmentByType = new Map<string, Record<string, number>>();
  for (const row of enrichmentRows) {
    const type = String(row.type ?? "");
    const status = String(row.status ?? "unknown");
    const statusCounts = enrichmentByType.get(type) ?? {};
    statusCounts[status] = numberValue(row, "entities");
    enrichmentByType.set(type, statusCounts);
  }
  const entitySourceRows = db.prepare(`${scopeCte},
    scoped_entities AS (
      SELECT DISTINCT facets.facet_type, facets.facet_value
      FROM scoped_works works
      JOIN media_metadata_facets facets ON facets.normalized_code = works.normalized_code
      WHERE facets.facet_type IN ('actor', 'series', 'maker', 'label', 'director')
    )
    SELECT entities.facet_type AS type,
      COUNT(sources.id) AS sources,
      COUNT(DISTINCT NULLIF(sources.provider, '')) AS sourceProviders,
      COALESCE(AVG(sources.confidence), 0) AS averageSourceConfidence
    FROM scoped_entities entities
    LEFT JOIN entity_profile_sources sources
      ON sources.facet_type = entities.facet_type AND sources.facet_value = entities.facet_value
    GROUP BY entities.facet_type
  `).all(params) as NumericRow[];
  const entitySourcesByType = new Map(entitySourceRows.map((row) => [String(row.type ?? ""), row]));
  const entityProfiles = profileCoverageRows.map((row) => {
    const type = String(row.type ?? "");
    const sources = entitySourcesByType.get(type);
    return {
      type,
      label: profileTypeLabels[type] ?? type,
      entities: numberValue(row, "entities"),
      profiles: numberValue(row, "profiles"),
      images: numberValue(row, "images"),
      biographies: numberValue(row, "biographies"),
      birthDates: numberValue(row, "birthDates"),
      officialWebsites: numberValue(row, "officialWebsites"),
      averageConfidence: numberValue(row, "averageConfidence"),
      sources: numberValue(sources, "sources"),
      sourceProviders: numberValue(sources, "sourceProviders"),
      averageSourceConfidence: numberValue(sources, "averageSourceConfidence"),
      enrichment: enrichmentByType.get(type) ?? {}
    };
  });

  const actorBirthDecades = (db.prepare(`${scopeCte},
    scoped_actors AS (
      SELECT DISTINCT facets.facet_value
      FROM scoped_works works
      JOIN media_metadata_facets facets
        ON facets.normalized_code = works.normalized_code AND facets.facet_type = 'actor'
    )
    SELECT (CAST(strftime('%Y', profiles.birth_date) AS INTEGER) / 10) * 10 AS decade,
      COUNT(*) AS actors
    FROM scoped_actors actors
    JOIN entity_profiles profiles
      ON profiles.facet_type = 'actor' AND profiles.facet_value = actors.facet_value
    WHERE date(profiles.birth_date) IS NOT NULL
      AND CAST(strftime('%Y', profiles.birth_date) AS INTEGER) BETWEEN 1900 AND 2100
    GROUP BY decade
    ORDER BY decade
  `).all(params) as NumericRow[]).map((row) => ({
    decade: numberValue(row, "decade"),
    actors: numberValue(row, "actors")
  }));

  const facetConcentration = (db.prepare(`${scopeCte},
    facet_counts AS (
      SELECT facets.facet_type AS type,
        facets.facet_value AS value,
        COUNT(DISTINCT facets.normalized_code) AS works
      FROM scoped_works works
      JOIN media_metadata_facets facets ON facets.normalized_code = works.normalized_code
      WHERE facets.facet_type IN ('actor', 'genre', 'series', 'maker', 'label', 'director')
      GROUP BY facets.facet_type, facets.facet_value
    ),
    ranked AS (
      SELECT facet_counts.*,
        ROW_NUMBER() OVER (PARTITION BY type ORDER BY works DESC, value) AS rank
      FROM facet_counts
    )
    SELECT type,
      COUNT(*) AS entities,
      SUM(CASE WHEN works = 1 THEN 1 ELSE 0 END) AS singletonEntities,
      SUM(works) AS assignments,
      COALESCE(SUM(CASE WHEN rank <= 10 THEN works ELSE 0 END) * 1.0 / NULLIF(SUM(works), 0), 0) AS topTenShare,
      COALESCE(SUM(works * works) * 1.0 / NULLIF(SUM(works) * SUM(works), 0), 0) AS hhi
    FROM ranked
    GROUP BY type
    ORDER BY assignments DESC
  `).all(params) as NumericRow[]).map((row) => {
    const type = String(row.type ?? "actor");
    return {
      type,
      label: ({ actor: "演员", genre: "题材", series: "系列", maker: "厂商", label: "厂牌", director: "导演" } as Record<string, string>)[type] ?? type,
      entities: numberValue(row, "entities"),
      singletonEntities: numberValue(row, "singletonEntities"),
      assignments: numberValue(row, "assignments"),
      topTenShare: numberValue(row, "topTenShare"),
      hhi: numberValue(row, "hhi")
    };
  });

  const indexLagBands = (db.prepare(`${scopeCte},
    work_index AS (
      SELECT normalized_code, MIN(NULLIF(first_seen_at, '')) AS firstSeenAt
      FROM scoped_files
      WHERE normalized_code != ''
      GROUP BY normalized_code
    ),
    lagged AS (
      SELECT CAST(julianday(date(work_index.firstSeenAt)) - julianday(date(metadata.release_date)) AS INTEGER) AS lagDays
      FROM work_index
      JOIN media_metadata metadata ON metadata.normalized_code = work_index.normalized_code
      WHERE date(work_index.firstSeenAt) IS NOT NULL AND date(metadata.release_date) IS NOT NULL
    ),
    categorized AS (
      SELECT CASE
          WHEN lagDays < 0 THEN 'beforeRelease'
          WHEN lagDays < 366 THEN 'under1'
          WHEN lagDays < 731 THEN 'oneToTwo'
          WHEN lagDays < 1826 THEN 'threeToFive'
          WHEN lagDays < 3651 THEN 'sixToTen'
          ELSE 'tenPlus'
        END AS band,
        CASE
          WHEN lagDays < 0 THEN 0
          WHEN lagDays < 366 THEN 1
          WHEN lagDays < 731 THEN 2
          WHEN lagDays < 1826 THEN 3
          WHEN lagDays < 3651 THEN 4
          ELSE 5
        END AS sortOrder,
        lagDays
      FROM lagged
    )
    SELECT band, COUNT(*) AS works, COALESCE(AVG(lagDays), 0) AS averageDays
    FROM categorized
    GROUP BY band
    ORDER BY MIN(sortOrder)
  `).all(params) as NumericRow[]).map((row) => {
    const key = String(row.band ?? "under1");
    return {
      key,
      label: ({ beforeRelease: "发行前已索引", under1: "不足 1 年", oneToTwo: "1–2 年", threeToFive: "3–5 年", sixToTen: "6–10 年", tenPlus: "10 年以上" } as Record<string, string>)[key] ?? key,
      works: numberValue(row, "works"),
      averageDays: numberValue(row, "averageDays")
    };
  });

  const governanceSnapshot = db.prepare(`${scopeCte}
    SELECT
      SUM(CASE WHEN metadata.status IS NULL OR metadata.status != 'ready' THEN 1 ELSE 0 END) AS metadataBacklog,
      SUM(CASE WHEN metadata.cover_url IS NULL OR (metadata.cover_url = '' AND metadata.thumb_url = '') THEN 1 ELSE 0 END) AS artworkBacklog,
      SUM(CASE WHEN metadata.updated_at IS NULL OR julianday('now') - julianday(metadata.updated_at) >= 90 THEN 1 ELSE 0 END) AS staleMetadata,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM metadata_quality_issues issues
        WHERE issues.normalized_code = works.normalized_code
      ) THEN 1 ELSE 0 END) AS issueWorks
    FROM scoped_works works
    LEFT JOIN media_metadata metadata ON metadata.normalized_code = works.normalized_code
  `).get(params) as NumericRow | undefined;

  const totalWorks = numberValue(summaryRow, "works");
  const facetCoverageFor = (type: keyof typeof facets) => facets[type]?.coveredWorks ?? 0;
  const coverage = [
    { key: "metadata", label: "元数据就绪", value: numberValue(metadataRow, "readyWorks"), total: totalWorks, unit: "works" },
    { key: "release", label: "发行日期", value: numberValue(metadataRow, "releaseDateWorks"), total: totalWorks, unit: "works" },
    { key: "titleZh", label: "中文标题", value: numberValue(metadataRow, "translatedTitleWorks"), total: totalWorks, unit: "works" },
    { key: "translation", label: "翻译流程", value: numberValue(metadataRow, "translatedWorks"), total: totalWorks, unit: "works" },
    { key: "artwork", label: "封面图像", value: numberValue(metadataRow, "artworkWorks"), total: totalWorks, unit: "works" },
    { key: "actor", label: "演员", value: facetCoverageFor("actor"), total: totalWorks, unit: "works" },
    { key: "genre", label: "题材标签", value: facetCoverageFor("genre"), total: totalWorks, unit: "works" },
    { key: "maker", label: "厂商", value: facetCoverageFor("maker"), total: totalWorks, unit: "works" },
    { key: "series", label: "系列", value: facetCoverageFor("series"), total: totalWorks, unit: "works" },
    { key: "probe", label: "技术参数", value: numberValue(summaryRow, "probedFiles"), total: numberValue(summaryRow, "files"), unit: "files" }
  ].map((item) => ({ ...item, rate: item.total > 0 ? item.value / item.total : 0 }));

  const metadataPipeline = [
    { key: "library", label: "在馆番号作品", value: totalWorks },
    { key: "recorded", label: "已有元数据记录", value: numberValue(metadataRow, "recordedWorks") },
    { key: "ready", label: "元数据已就绪", value: numberValue(metadataRow, "readyWorks") },
    { key: "translated", label: "翻译已完成", value: numberValue(metadataRow, "translatedWorks") },
    { key: "artwork", label: "封面可用", value: numberValue(metadataRow, "artworkWorks") }
  ];

  const nativeFiles = compatibility.find((item) => item.key === "native")?.files ?? 0;
  const riskFiles = compatibility
    .filter((item) => item.key === "transcode" || item.key === "unsupported")
    .reduce((sum, item) => sum + item.files, 0);
  const fourKFiles = resolutions.find((item) => item.key === "4k")?.files ?? 0;
  const fullHdFiles = resolutions
    .filter((item) => item.key === "1080p" || item.key === "4k")
    .reduce((sum, item) => sum + item.files, 0);

  const scopedEntities = entityProfiles.reduce((sum, item) => sum + item.entities, 0);
  const entityNotFound = entityProfiles.reduce((sum, item) => sum + (item.enrichment["not-found"] ?? 0), 0);
  const backlog = [
    {
      key: "metadata",
      label: "元数据未就绪",
      value: numberValue(governanceSnapshot, "metadataBacklog"),
      total: totalWorks,
      unit: "works" as const,
      severity: "error" as const,
      note: "尚未形成 ready 状态的在馆作品"
    },
    {
      key: "artwork",
      label: "封面待补齐",
      value: numberValue(governanceSnapshot, "artworkBacklog"),
      total: totalWorks,
      unit: "works" as const,
      severity: "warning" as const,
      note: "封面与缩略图均为空"
    },
    {
      key: "issues",
      label: "结构化质量问题",
      value: numberValue(governanceSnapshot, "issueWorks"),
      total: totalWorks,
      unit: "works" as const,
      severity: "warning" as const,
      note: "至少命中一项质量索引"
    },
    {
      key: "stale",
      label: "90 天未刷新",
      value: numberValue(governanceSnapshot, "staleMetadata"),
      total: totalWorks,
      unit: "works" as const,
      severity: "info" as const,
      note: "按元数据 updated_at 计算"
    },
    {
      key: "entityNotFound",
      label: "实体增强未找到",
      value: entityNotFound,
      total: scopedEntities,
      unit: "entities" as const,
      severity: "warning" as const,
      note: "演员、系列、厂商、厂牌与导演"
    },
    {
      key: "probeFailed",
      label: "技术探测失败",
      value: numberValue(summaryRow, "failedProbeFiles"),
      total: numberValue(summaryRow, "files"),
      unit: "files" as const,
      severity: "error" as const,
      note: "当前文件状态，不等同历史任务失败"
    },
    {
      key: "playbackRisk",
      label: "播放兼容风险",
      value: riskFiles,
      total: numberValue(summaryRow, "files"),
      unit: "files" as const,
      severity: "warning" as const,
      note: "需要转码或暂不支持"
    }
  ].map((item) => ({ ...item, rate: item.total > 0 ? item.value / item.total : 0 }));

  const jobTypes = (db.prepare(`
    SELECT job_type AS jobType,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
      COALESCE(AVG(CASE
        WHEN started_at IS NOT NULL AND finished_at IS NOT NULL
        THEN MAX(0, (julianday(finished_at) - julianday(started_at)) * 86400.0)
      END), 0) AS averageDurationSeconds,
      MAX(updated_at) AS latestUpdatedAt
    FROM media_jobs
    GROUP BY job_type
    ORDER BY total DESC, job_type
  `).all() as NumericRow[]).map((row) => {
    const key = String(row.jobType ?? "unknown");
    const ready = numberValue(row, "ready");
    const failed = numberValue(row, "failed");
    return {
      key,
      label: jobTypeLabels[key] ?? key,
      total: numberValue(row, "total"),
      ready,
      failed,
      pending: numberValue(row, "pending"),
      running: numberValue(row, "running"),
      cancelled: numberValue(row, "cancelled"),
      successRate: ready + failed > 0 ? ready / (ready + failed) : 0,
      averageDurationSeconds: numberValue(row, "averageDurationSeconds"),
      latestUpdatedAt: textValue(row, "latestUpdatedAt")
    };
  });
  const jobSummary = jobTypes.reduce((summary, item) => ({
    jobs: summary.jobs + item.total,
    readyJobs: summary.readyJobs + item.ready,
    failedJobs: summary.failedJobs + item.failed,
    pendingJobs: summary.pendingJobs + item.pending,
    runningJobs: summary.runningJobs + item.running,
    cancelledJobs: summary.cancelledJobs + item.cancelled
  }), { jobs: 0, readyJobs: 0, failedJobs: 0, pendingJobs: 0, runningJobs: 0, cancelledJobs: 0 });

  const jobDailyRows = db.prepare(`
    WITH anchor AS (
      SELECT date(MAX(updated_at)) AS latestDay FROM media_jobs
    )
    SELECT date(COALESCE(finished_at, updated_at)) AS day,
      SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM media_jobs, anchor
    WHERE date(COALESCE(finished_at, updated_at)) >= date(anchor.latestDay, '-34 days')
    GROUP BY day
    ORDER BY day
  `).all() as NumericRow[];
  const dailyByDay = new Map(jobDailyRows.map((row) => [String(row.day ?? ""), row]));
  const latestJobDay = jobDailyRows.at(-1)?.day ? new Date(`${String(jobDailyRows.at(-1)?.day)}T00:00:00Z`) : null;
  const jobDaily = latestJobDay && Number.isFinite(latestJobDay.getTime())
    ? Array.from({ length: 35 }, (_, index) => {
        const dayDate = new Date(latestJobDay.getTime() - (34 - index) * 86_400_000);
        const day = dayDate.toISOString().slice(0, 10);
        const row = dailyByDay.get(day);
        const ready = numberValue(row, "ready");
        const failed = numberValue(row, "failed");
        return { day, ready, failed, total: ready + failed };
      })
    : [];

  const pipelineStages = (db.prepare(`
    WITH asset_states AS (
      SELECT 'probe' AS stage, probe_status AS status, 0 AS bytes,
        COALESCE(probed_at, indexed_at) AS updatedAt
      FROM media_files WHERE media_type = 'video'
      UNION ALL
      SELECT 'content-preview', content_status, content_bytes, updated_at FROM media_storyboards
      UNION ALL
      SELECT 'subtitle', status, bytes, updated_at FROM video_subtitle_translations
      UNION ALL
      SELECT kind, status, bytes, updated_at FROM media_derivatives
      WHERE kind IN ('poster', 'hls', 'remux')
    )
    SELECT stage,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
      SUM(CASE WHEN status NOT IN ('ready', 'failed', 'running', 'cancelled') THEN 1 ELSE 0 END) AS pending,
      COALESCE(SUM(bytes), 0) AS bytes,
      MAX(updatedAt) AS latestUpdatedAt
    FROM asset_states
    GROUP BY stage
    ORDER BY CASE stage
      WHEN 'probe' THEN 1 WHEN 'content-preview' THEN 2 WHEN 'subtitle' THEN 3
      WHEN 'poster' THEN 4 WHEN 'hls' THEN 5 WHEN 'remux' THEN 6 ELSE 7 END
  `).all() as NumericRow[]).map((row) => {
    const key = String(row.stage ?? "unknown");
    const config = ({
      probe: { label: "技术探测", grain: "全部视频文件" },
      "content-preview": { label: "内容预览", grain: "全部视频文件" },
      subtitle: { label: "字幕翻译", grain: "已发起翻译的文件" },
      poster: { label: "派生海报", grain: "已生成或已排队记录" },
      hls: { label: "HLS 资产", grain: "按需生成记录" },
      remux: { label: "Remux 资产", grain: "按需生成记录" }
    } as Record<string, { label: string; grain: string }>)[key] ?? { label: key, grain: "现有记录" };
    return {
      key,
      ...config,
      total: numberValue(row, "total"),
      ready: numberValue(row, "ready"),
      failed: numberValue(row, "failed"),
      pending: numberValue(row, "pending"),
      running: numberValue(row, "running"),
      cancelled: numberValue(row, "cancelled"),
      bytes: numberValue(row, "bytes"),
      latestUpdatedAt: textValue(row, "latestUpdatedAt")
    };
  });

  const ingestionRuns = (db.prepare(`
    SELECT id, status, phase, trigger_type AS triggerType, stats_json AS statsJson,
      SUBSTR(COALESCE(error, ''), 1, 500) AS error,
      created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt, updated_at AS updatedAt,
      COALESCE(CASE
        WHEN started_at IS NOT NULL AND finished_at IS NOT NULL
        THEN MAX(0, (julianday(finished_at) - julianday(started_at)) * 86400.0)
      END, 0) AS durationSeconds
    FROM ingestion_runs
    ORDER BY created_at DESC
  `).all() as NumericRow[]).map((row) => {
    const stats = parseJsonRecord(row.statsJson);
    const previews = nestedRecord(stats, "contentPreviews");
    const actors = nestedRecord(stats, "actorProfiles");
    return {
      id: String(row.id ?? ""),
      status: String(row.status ?? "unknown"),
      phase: String(row.phase ?? "unknown"),
      triggerType: String(row.triggerType ?? "unknown"),
      createdAt: String(row.createdAt ?? ""),
      startedAt: textValue(row, "startedAt"),
      finishedAt: textValue(row, "finishedAt"),
      updatedAt: String(row.updatedAt ?? row.createdAt ?? ""),
      durationSeconds: numberValue(row, "durationSeconds"),
      scanned: recordNumber(stats, "scanned"),
      eligible: recordNumber(stats, "eligible"),
      moved: recordNumber(stats, "moved"),
      unstable: recordNumber(stats, "unstable"),
      rejected: recordNumber(stats, "rejected"),
      conflicts: recordNumber(stats, "conflicts"),
      failed: recordNumber(stats, "failed"),
      previewsQueued: recordNumber(previews, "queued"),
      previewsReady: recordNumber(previews, "ready"),
      actorsDiscovered: recordNumber(actors, "discovered"),
      error: String(row.error ?? "")
    };
  });
  const ingestionSummary = ingestionRuns.reduce((summary, run) => {
    summary.runs += 1;
    if (run.status === "completed") summary.completed += 1;
    if (run.status === "partial") summary.partial += 1;
    if (run.status === "failed") summary.failed += 1;
    if (run.triggerType === "manual") summary.manual += 1;
    if (run.triggerType === "scheduled") summary.scheduled += 1;
    summary.moved += run.moved;
    summary.eligible += run.eligible;
    summary.conflicts += run.conflicts;
    summary.unstable += run.unstable;
    summary.previewsQueued += run.previewsQueued;
    return summary;
  }, {
    runs: 0, completed: 0, partial: 0, failed: 0, manual: 0, scheduled: 0,
    moved: 0, eligible: 0, conflicts: 0, unstable: 0, previewsQueued: 0
  });

  const failedJobDetails = (db.prepare(`
    SELECT jobs.id, jobs.job_type AS jobType, jobs.media_id AS mediaId,
      COALESCE(NULLIF(files.normalized_code, ''), NULLIF(files.basename, ''), jobs.media_id) AS code,
      jobs.status, jobs.attempts, jobs.max_attempts AS maxAttempts,
      SUBSTR(COALESCE(jobs.error, ''), 1, 500) AS error,
      jobs.created_at AS createdAt, jobs.updated_at AS updatedAt,
      COALESCE(CASE
        WHEN jobs.started_at IS NOT NULL AND jobs.finished_at IS NOT NULL
        THEN MAX(0, (julianday(jobs.finished_at) - julianday(jobs.started_at)) * 86400.0)
      END, 0) AS durationSeconds
    FROM media_jobs jobs
    LEFT JOIN media_files files ON files.id = jobs.media_id
    WHERE jobs.status = 'failed'
    ORDER BY jobs.updated_at DESC
    LIMIT 80
  `).all() as NumericRow[]).map((row) => {
    const jobType = String(row.jobType ?? "unknown");
    return {
      id: String(row.id ?? ""),
      jobType,
      jobLabel: jobTypeLabels[jobType] ?? jobType,
      mediaId: String(row.mediaId ?? ""),
      code: String(row.code ?? row.mediaId ?? ""),
      status: String(row.status ?? "failed"),
      attempts: numberValue(row, "attempts"),
      maxAttempts: numberValue(row, "maxAttempts"),
      error: String(row.error ?? ""),
      durationSeconds: numberValue(row, "durationSeconds"),
      createdAt: String(row.createdAt ?? ""),
      updatedAt: String(row.updatedAt ?? "")
    };
  });

  const latestActivityAt = [
    ...jobTypes.map((item) => item.latestUpdatedAt),
    ingestionRuns[0]?.updatedAt ?? null,
    ...pipelineStages.map((item) => item.latestUpdatedAt)
  ].filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
  const currentAssetFailures = pipelineStages.reduce((sum, item) => sum + item.failed + item.cancelled, 0);
  const currentAssetPending = pipelineStages.reduce((sum, item) => sum + item.pending + item.running, 0);

  return {
    contract: {
      version: ANALYTICS_CACHE_VERSION,
      workIdentity: "normalized_code",
      releaseDateField: "media_metadata.release_date",
      generatedAt: new Date().toISOString(),
      metrics: ANALYTICS_METRIC_DEFINITIONS
    },
    scope: {
      year,
      label: year === null ? "全部馆藏" : `${year} 年发行`,
      dateField: "release_date",
      generatedAt: new Date().toISOString()
    },
    freshness: {
      indexedAt: textValue(summaryRow, "indexedAt"),
      metadataUpdatedAt: textValue(metadataRow, "metadataUpdatedAt"),
      firstSeenAt: textValue(summaryRow, "firstSeenAt"),
      lastSeenAt: textValue(summaryRow, "lastSeenAt")
    },
    summary: {
      files: numberValue(summaryRow, "files"),
      works: totalWorks,
      variants: Math.max(0, numberValue(summaryRow, "variants")),
      totalBytes: numberValue(summaryRow, "totalBytes"),
      totalDurationSeconds: numberValue(summaryRow, "totalDurationSeconds"),
      averageFileBytes: numberValue(summaryRow, "averageFileBytes"),
      averageDurationSeconds: numberValue(summaryRow, "files") > 0 ? numberValue(summaryRow, "totalDurationSeconds") / numberValue(summaryRow, "files") : 0,
      readyMetadataWorks: numberValue(metadataRow, "readyWorks"),
      recordedMetadataWorks: numberValue(metadataRow, "recordedWorks"),
      translatedWorks: numberValue(metadataRow, "translatedWorks"),
      artworkWorks: numberValue(metadataRow, "artworkWorks"),
      metadataCoverage: totalWorks > 0 ? numberValue(metadataRow, "readyWorks") / totalWorks : 0,
      translationCoverage: totalWorks > 0 ? numberValue(metadataRow, "translatedWorks") / totalWorks : 0,
      artworkCoverage: totalWorks > 0 ? numberValue(metadataRow, "artworkWorks") / totalWorks : 0,
      variantRate: numberValue(summaryRow, "files") > 0 ? Math.max(0, numberValue(summaryRow, "variants")) / numberValue(summaryRow, "files") : 0,
      nativePlaybackRate: numberValue(summaryRow, "files") > 0 ? nativeFiles / numberValue(summaryRow, "files") : 0,
      playbackRiskRate: numberValue(summaryRow, "files") > 0 ? riskFiles / numberValue(summaryRow, "files") : 0,
      fourKShare: numberValue(summaryRow, "files") > 0 ? fourKFiles / numberValue(summaryRow, "files") : 0,
      fullHdShare: numberValue(summaryRow, "files") > 0 ? fullHdFiles / numberValue(summaryRow, "files") : 0,
      earliestReleaseDate: textValue(metadataRow, "earliestReleaseDate"),
      latestReleaseDate: textValue(metadataRow, "latestReleaseDate"),
      averagePositiveScore: numberValue(metadataRow, "averagePositiveScore"),
      scoredWorks: numberValue(metadataRow, "scoredWorks")
    },
    availableYears,
    releaseHistory,
    releaseByMonth,
    releaseHeatmap,
    yearlyMetrics,
    categoryYearTrend,
    catalogGrowth,
    libraryMix,
    sourceMix,
    sourceProfiles,
    facets,
    prefixAnalytics:getLibraryPrefixAnalytics(db,year),
    contentMatrix,
    actorAnalytics,
    crossAnalysis: {
      scope: {
        canonicalActors: matrixContext.members.actor.size,
        canonicalGenres: matrixContext.members.genre.size,
        rawActors: numberValue(facetCoverage.get("actor"), "distinctValues"),
        rawGenres: numberValue(facetCoverage.get("genre"), "distinctValues"),
        recentWindow: matrixContext.latestYear === null ? null : `${matrixContext.latestYear - 2}–${matrixContext.latestYear}`,
        previousWindow: matrixContext.latestYear === null ? null : `${matrixContext.latestYear - 5}–${matrixContext.latestYear - 3}`
      },
      matrices: crossMatrices,
      signals: structureSignals
    },
    technical: {
      resolutions,
      codecs,
      containers,
      audioCodecs,
      extensions,
      compatibility,
      resolutionCodecMatrix,
      durationBands,
      fileSizeBands,
      durationBoxPlots,
      scoreBands,
      variantTags,
      variantBands
    },
    dataQuality: {
      coverage,
      metadataPipeline,
      metadataStatuses,
      metadataProviders,
      coverageByReleaseYear,
      issues: issueRows,
      backlog,
      facetConcentration,
      indexLagBands,
      exceptionWorks
    },
    entityKnowledge: {
      profiles: entityProfiles,
      actorBirthDecades
    },
    operations: {
      scope: {
        label: "全部生产任务",
        timeField: "updated_at",
        ignoresReleaseYearFilter: true
      },
      summary: {
        ...jobSummary,
        successRate: jobSummary.readyJobs + jobSummary.failedJobs > 0
          ? jobSummary.readyJobs / (jobSummary.readyJobs + jobSummary.failedJobs)
          : 0,
        currentAssetFailures,
        currentAssetPending,
        ingestionRuns: ingestionSummary.runs,
        ingestionMoved: ingestionSummary.moved,
        latestActivityAt
      },
      jobTypes,
      jobDaily,
      pipelineStages,
      recentIngestionRuns: ingestionRuns.slice(0, 24),
      ingestionSummary: {
        ...ingestionSummary,
        latestScanned: ingestionRuns[0]?.scanned ?? 0,
        latestRunAt: ingestionRuns[0]?.updatedAt ?? null
      },
      failedJobDetails
    }
  };
}

export function registerLibraryAnalyticsRoutes(app: Express): void {
  app.get("/api/library-analytics/prefix-totals", (_req,res) => {
    res.setHeader("Cache-Control","private, no-store");
    res.json(getPrefixTotals(db));
  });
  app.put("/api/library-analytics/prefix-totals/:prefix", (req,res,next) => {
    try {
      const prefix=z.string().trim().toUpperCase().regex(/^[A-Z0-9]+$/).max(40).parse(req.params.prefix);
      const {total}=z.object({total:z.number().int().min(1).max(10000000).nullable()}).strict().parse(req.body);
      try { res.json(savePrefixTotal(db,prefix,total)); }
      catch(error) { res.status(400).json({error:error instanceof Error?error.message:'无法保存系列总量'}); }
    } catch(error) { next(error); }
  });
  app.get("/api/library-analytics/summary", (req, res, next) => {
    try {
      const { year, refresh } = querySchema.parse(req.query);
      const startedAt = performance.now();
      const result = getCachedLibraryAnalyticsSummary(year, refresh);
      res.setHeader("Cache-Control", refresh ? "private, no-store" : "private, max-age=120");
      res.setHeader("X-AMW-Cache", result.cacheStatus);
      res.setHeader("Server-Timing", `library-analytics-summary;dur=${(performance.now() - startedAt).toFixed(1)}`);
      res.json(result.value);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/library-analytics/sections/:section", (req, res, next) => {
    try {
      const section = analyticsSectionSchema.parse(req.params.section);
      const { year, refresh, mode, matrix } = querySchema.parse(req.query);
      const startedAt = performance.now();
      const result = getCachedLibraryAnalyticsSnapshot(year, refresh);
      res.setHeader("Cache-Control", refresh ? "private, no-store" : "private, max-age=300");
      res.setHeader("X-AMW-Cache", result.cacheStatus);
      res.setHeader("X-AMW-Analytics-Section", section);
      if (section === "content") res.setHeader("X-AMW-Analytics-Mode", mode);
      if (section === "content" && matrix) res.setHeader("X-AMW-Analytics-Matrix", matrix);
      res.setHeader("Server-Timing", `library-analytics-${section};dur=${(performance.now() - startedAt).toFixed(1)}`);
      res.json(projectLibraryAnalyticsSnapshot(result.value, section, mode, matrix));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/library-analytics/matrix-evidence", (req, res, next) => {
    try {
      const { actor, genre, year, limit } = matrixEvidenceQuerySchema.parse(req.query);
      res.setHeader("Cache-Control", "private, max-age=300");
      res.json(getMatrixEvidence(actor, genre, year, limit));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/library-analytics", (req, res, next) => {
    try {
      const { year, refresh } = querySchema.parse(req.query);
      const startedAt = performance.now();
      const result = getCachedLibraryAnalyticsSnapshot(year, refresh);
      res.setHeader("Cache-Control", refresh ? "private, no-store" : "private, max-age=300");
      res.setHeader("X-AMW-Cache", result.cacheStatus);
      res.setHeader("Server-Timing", `library-analytics;dur=${(performance.now() - startedAt).toFixed(1)}`);
      res.json(result.value);
    } catch (error) {
      next(error);
    }
  });
}

export {
  ANALYTICS_METRIC_DEFINITIONS,
  getCachedLibraryAnalyticsSnapshot,
  getCachedLibraryAnalyticsSummary,
  getLibraryAnalyticsSnapshot,
  getLibraryAnalyticsSummary,
  getMatrixEvidence,
  projectLibraryAnalyticsSnapshot
};
