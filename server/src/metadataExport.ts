import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { config } from "./config.js";
import { db } from "./db.js";

type MetadataExportRow = {
  normalized_code: string;
  status: string;
  title: string;
  summary: string;
  director: string;
  actors_json: string;
  genres_json: string;
  maker: string;
  label: string;
  series: string;
  title_zh: string;
  summary_zh: string;
  director_zh: string;
  actors_zh_json: string;
  genres_zh_json: string;
  maker_zh: string;
  label_zh: string;
  series_zh: string;
  release_date: string | null;
  runtime_minutes: number | null;
  score: number | null;
  provider: string;
  homepage: string;
  cover_url: string;
  thumb_url: string;
  preview_video_url: string;
  preview_video_hls_url: string;
  preview_images_json: string;
  error: string | null;
  attempts: number;
  translation_status: string;
  translation_error: string | null;
  translation_source: string;
  translated_at: string | null;
  fetched_at: string | null;
  updated_at: string;
  file_count: number;
  categories: string | null;
  sources: string | null;
  sample_path: string | null;
  original_basename: string | null;
  original_relative_path: string | null;
};

export type MetadataWorkbookExport = {
  path: string;
  rows: number;
  exportedAt: string;
};

const columns: Array<{ header: string; key: string; width: number; style?: Partial<ExcelJS.Style> }> = [
  { header: "番号", key: "normalizedCode", width: 16 },
  { header: "状态", key: "status", width: 12 },
  { header: "标题(中文)", key: "titleZh", width: 52 },
  { header: "简介(中文)", key: "summaryZh", width: 68 },
  { header: "演员(中文)", key: "actorsZh", width: 30 },
  { header: "导演(中文)", key: "directorZh", width: 18 },
  { header: "标签(中文)", key: "genresZh", width: 34 },
  { header: "厂商(中文)", key: "makerZh", width: 22 },
  { header: "厂牌(中文)", key: "labelZh", width: 20 },
  { header: "系列(中文)", key: "seriesZh", width: 28 },
  { header: "翻译状态", key: "translationStatus", width: 12 },
  { header: "翻译来源", key: "translationSource", width: 18 },
  { header: "翻译时间", key: "translatedAt", width: 21, style: { numFmt: "yyyy-mm-dd hh:mm" } },
  { header: "翻译错误", key: "translationError", width: 32 },
  { header: "标题(日文)", key: "title", width: 52 },
  { header: "简介(日文)", key: "summary", width: 68 },
  { header: "演员(日文)", key: "actors", width: 30 },
  { header: "导演(日文)", key: "director", width: 18 },
  { header: "标签(日文)", key: "genres", width: 34 },
  { header: "厂商(日文)", key: "maker", width: 22 },
  { header: "厂牌(日文)", key: "label", width: 20 },
  { header: "系列(日文)", key: "series", width: 28 },
  { header: "发行日期", key: "releaseDate", width: 13, style: { numFmt: "yyyy-mm-dd" } },
  { header: "时长(分钟)", key: "runtimeMinutes", width: 12, style: { numFmt: "#,##0" } },
  { header: "评分", key: "score", width: 9, style: { numFmt: "0.0" } },
  { header: "Provider", key: "provider", width: 14 },
  { header: "文件数", key: "fileCount", width: 9, style: { numFmt: "#,##0" } },
  { header: "分类", key: "categories", width: 14 },
  { header: "来源", key: "sources", width: 18 },
  { header: "样例路径", key: "samplePath", width: 52 },
  { header: "原始文件名", key: "originalBasename", width: 30 },
  { header: "原始路径", key: "originalRelativePath", width: 52 },
  { header: "主页", key: "homepage", width: 44 },
  { header: "封面", key: "coverUrl", width: 44 },
  { header: "缩略图", key: "thumbUrl", width: 44 },
  { header: "预览视频", key: "previewVideoUrl", width: 44 },
  { header: "HLS预览", key: "previewVideoHlsUrl", width: 44 },
  { header: "预览图集", key: "previewImages", width: 68 },
  { header: "错误", key: "error", width: 32 },
  { header: "尝试次数", key: "attempts", width: 10, style: { numFmt: "#,##0" } },
  { header: "抓取时间", key: "fetchedAt", width: 21, style: { numFmt: "yyyy-mm-dd hh:mm" } },
  { header: "更新时间", key: "updatedAt", width: 21, style: { numFmt: "yyyy-mm-dd hh:mm" } }
];

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const match = value.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (!match) return null;
  const date = new Date(`${match}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseDateTime(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function columnLetter(index: number): string {
  let value = index;
  let letter = "";

  while (value > 0) {
    const remainder = (value - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    value = Math.floor((value - 1) / 26);
  }

  return letter;
}

function writeCellBlock(sheet: ExcelJS.Worksheet, startRow: number, startColumn: number, values: unknown[][]): void {
  values.forEach((rowValues, rowOffset) => {
    rowValues.forEach((value, columnOffset) => {
      sheet.getCell(startRow + rowOffset, startColumn + columnOffset).value = value as ExcelJS.CellValue;
    });
  });
}

function forEachCellInBlock(
  sheet: ExcelJS.Worksheet,
  startRow: number,
  startColumn: number,
  rowCount: number,
  columnCount: number,
  callback: (cell: ExcelJS.Cell) => void
): void {
  for (let row = startRow; row < startRow + rowCount; row += 1) {
    for (let column = startColumn; column < startColumn + columnCount; column += 1) {
      callback(sheet.getCell(row, column));
    }
  }
}

function getProcessedMetadataRows(): MetadataExportRow[] {
  return db
    .prepare(
      `
      SELECT
        media_metadata.normalized_code,
        media_metadata.status,
        media_metadata.title,
        media_metadata.summary,
        media_metadata.director,
        media_metadata.actors_json,
        media_metadata.genres_json,
        media_metadata.maker,
        media_metadata.label,
        media_metadata.series,
        media_metadata.title_zh,
        media_metadata.summary_zh,
        media_metadata.director_zh,
        media_metadata.actors_zh_json,
        media_metadata.genres_zh_json,
        media_metadata.maker_zh,
        media_metadata.label_zh,
        media_metadata.series_zh,
        media_metadata.release_date,
        media_metadata.runtime_minutes,
        media_metadata.score,
        media_metadata.provider,
        media_metadata.homepage,
        media_metadata.cover_url,
        media_metadata.thumb_url,
        media_metadata.preview_video_url,
        media_metadata.preview_video_hls_url,
        media_metadata.preview_images_json,
        media_metadata.error,
        media_metadata.attempts,
        media_metadata.translation_status,
        media_metadata.translation_error,
        media_metadata.translation_source,
        media_metadata.translated_at,
        media_metadata.fetched_at,
        media_metadata.updated_at,
        COUNT(media_files.id) AS file_count,
        GROUP_CONCAT(DISTINCT media_files.library_category) AS categories,
        GROUP_CONCAT(DISTINCT media_files.source_name) AS sources,
        MIN(media_files.relative_path) AS sample_path
        , metadata_file_origins.original_basename
        , metadata_file_origins.original_relative_path
      FROM media_metadata
      LEFT JOIN media_files
        ON media_files.normalized_code = media_metadata.normalized_code
      LEFT JOIN metadata_file_origins
        ON metadata_file_origins.normalized_code = media_metadata.normalized_code
      WHERE media_metadata.status != 'pending'
      GROUP BY media_metadata.normalized_code
      ORDER BY
        CASE media_metadata.status
          WHEN 'ready' THEN 0
          WHEN 'failed' THEN 1
          WHEN 'not_found' THEN 2
          ELSE 3
        END,
        media_metadata.normalized_code
    `
    )
    .all() as MetadataExportRow[];
}

function styleTitleCell(cell: ExcelJS.Cell): void {
  cell.font = { bold: true, size: 16, color: { argb: "FFFFFFFF" } };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF111111" } };
  cell.alignment = { vertical: "middle", horizontal: "left" };
}

function styleHeaderRow(row: ExcelJS.Row): void {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FF111111" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFF9900" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.border = {
      bottom: { style: "thin", color: { argb: "FF7A4A00" } }
    };
  });
}

function applyStatusStyle(row: ExcelJS.Row, status: string): void {
  const statusCell = row.getCell("status");
  const fill =
    status === "ready"
      ? "FFE7F6EC"
      : status === "failed"
        ? "FFFFE8E6"
        : status === "not_found"
          ? "FFFFF4CC"
          : "FFE8EEF8";
  const font =
    status === "ready"
      ? "FF16794A"
      : status === "failed"
        ? "FFB42318"
        : status === "not_found"
          ? "FF946200"
          : "FF2F5597";

  statusCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
  statusCell.font = { bold: true, color: { argb: font } };
  statusCell.alignment = { horizontal: "center", vertical: "middle" };
}

function createSummarySheet(workbook: ExcelJS.Workbook, rows: MetadataExportRow[], exportedAt: string): void {
  const sheet = workbook.addWorksheet("概览", {
    views: [{ showGridLines: false }]
  });
  const ready = rows.filter((row) => row.status === "ready").length;
  const failed = rows.filter((row) => row.status === "failed").length;
  const notFound = rows.filter((row) => row.status === "not_found").length;

  sheet.mergeCells("A1:F1");
  sheet.getCell("A1").value = "Alexandria 18+ 元数据导出";
  styleTitleCell(sheet.getCell("A1"));
  sheet.getRow(1).height = 30;

  writeCellBlock(sheet, 3, 1, [
    ["导出时间", new Date(exportedAt)],
    ["Excel 路径", config.metadataExcelPath],
    ["已处理番号", rows.length],
    ["补全成功", ready],
    ["补全失败", failed],
    ["未匹配", notFound]
  ]);
  sheet.getColumn(1).width = 16;
  sheet.getColumn(2).width = 72;
  sheet.getCell("B3").numFmt = "yyyy-mm-dd hh:mm";
  forEachCellInBlock(sheet, 3, 1, 6, 1, (cell) => {
    cell.font = { bold: true };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };
  });
  forEachCellInBlock(sheet, 3, 1, 6, 2, (cell) => {
    cell.border = { bottom: { style: "thin", color: { argb: "FFE5E5E5" } } };
    cell.alignment = { vertical: "middle" };
  });

  sheet.getCell("D3").value = "状态说明";
  sheet.getCell("D3").font = { bold: true };
  writeCellBlock(sheet, 4, 4, [
    ["ready", "已成功补全，并写入片名/演员/标签等字段", ""],
    ["failed", "请求超时或外部源错误，可后续重试", ""],
    ["not_found", "外部源未找到匹配结果", ""],
    ["fetching", "正在抓取，通常只会短暂出现", ""]
  ]);
  sheet.getColumn(4).width = 14;
  sheet.getColumn(5).width = 46;
  sheet.getColumn(6).width = 4;
  forEachCellInBlock(sheet, 4, 4, 4, 1, (cell) => {
    cell.font = { bold: true };
    cell.alignment = { horizontal: "center" };
  });
  forEachCellInBlock(sheet, 4, 4, 4, 3, (cell) => {
    cell.border = { bottom: { style: "thin", color: { argb: "FFE5E5E5" } } };
    cell.alignment = { vertical: "middle" };
  });
}

function createMetadataSheet(workbook: ExcelJS.Workbook, rows: MetadataExportRow[]): void {
  const sheet = workbook.addWorksheet("元数据明细", {
    views: [{ state: "frozen", ySplit: 1, showGridLines: false }]
  });

  sheet.columns = columns.map((column) => ({
    header: column.header,
    key: column.key,
    width: column.width,
    style: column.style
  }));

  styleHeaderRow(sheet.getRow(1));
  sheet.autoFilter = {
    from: "A1",
    to: `${columnLetter(columns.length)}1`
  };

  for (const row of rows) {
    const added = sheet.addRow({
      normalizedCode: row.normalized_code,
      status: row.status,
      titleZh: row.title_zh || row.title,
      summaryZh: row.summary_zh || row.summary,
      actorsZh: parseJsonArray(row.actors_zh_json).join(" / ") || parseJsonArray(row.actors_json).join(" / "),
      directorZh: row.director_zh || row.director,
      genresZh: parseJsonArray(row.genres_zh_json).join(" / ") || parseJsonArray(row.genres_json).join(" / "),
      makerZh: row.maker_zh || row.maker,
      labelZh: row.label_zh || row.label,
      seriesZh: row.series_zh || row.series,
      translationStatus: row.translation_status,
      translationSource: row.translation_source,
      translatedAt: parseDateTime(row.translated_at),
      translationError: row.translation_error ?? "",
      title: row.title,
      summary: row.summary,
      actors: parseJsonArray(row.actors_json).join(" / "),
      director: row.director,
      genres: parseJsonArray(row.genres_json).join(" / "),
      maker: row.maker,
      label: row.label,
      series: row.series,
      releaseDate: parseDate(row.release_date),
      runtimeMinutes: row.runtime_minutes,
      score: row.score,
      provider: row.provider,
      fileCount: row.file_count,
      categories: row.categories ?? "",
      sources: row.sources ?? "",
      samplePath: row.sample_path ?? "",
      originalBasename: row.original_basename ?? "",
      originalRelativePath: row.original_relative_path ?? "",
      homepage: row.homepage,
      coverUrl: row.cover_url,
      thumbUrl: row.thumb_url,
      previewVideoUrl: row.preview_video_url,
      previewVideoHlsUrl: row.preview_video_hls_url,
      previewImages: "",
      error: row.error ?? "",
      attempts: row.attempts,
      fetchedAt: parseDateTime(row.fetched_at),
      updatedAt: parseDateTime(row.updated_at)
    });

    applyStatusStyle(added, row.status);
    added.alignment = { vertical: "top", wrapText: false };
  }

  sheet.getColumn("title").alignment = { vertical: "top", wrapText: true };
  sheet.getColumn("summary").alignment = { vertical: "top", wrapText: true };
  sheet.getColumn("titleZh").alignment = { vertical: "top", wrapText: true };
  sheet.getColumn("summaryZh").alignment = { vertical: "top", wrapText: true };
  sheet.getColumn("genresZh").alignment = { vertical: "top", wrapText: true };
  sheet.getColumn("translationError").alignment = { vertical: "top", wrapText: true };
  sheet.getColumn("genres").alignment = { vertical: "top", wrapText: true };
  sheet.getColumn("samplePath").alignment = { vertical: "top", wrapText: false };
  sheet.getColumn("homepage").alignment = { vertical: "top", wrapText: false };
  sheet.getColumn("coverUrl").alignment = { vertical: "top", wrapText: false };
  sheet.getColumn("thumbUrl").alignment = { vertical: "top", wrapText: false };
  sheet.getColumn("previewVideoUrl").alignment = { vertical: "top", wrapText: false };
  sheet.getColumn("previewVideoHlsUrl").alignment = { vertical: "top", wrapText: false };
  sheet.getColumn("previewImages").alignment = { vertical: "top", wrapText: true };

  sheet.eachRow((row, rowNumber) => {
    row.height = rowNumber === 1 ? 24 : 22;
    row.eachCell((cell) => {
      cell.border = {
        bottom: { style: "thin", color: { argb: "FFE8E8E8" } }
      };
    });
  });
}

export async function exportMetadataWorkbook(): Promise<MetadataWorkbookExport> {
  const rows = getProcessedMetadataRows();
  const exportedAt = new Date().toISOString();
  const workbook = new ExcelJS.Workbook();

  workbook.creator = "Alexandria 18+";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.properties.date1904 = false;

  createSummarySheet(workbook, rows, exportedAt);
  createMetadataSheet(workbook, rows);

  fs.mkdirSync(path.dirname(config.metadataExcelPath), { recursive: true });
  await workbook.xlsx.writeFile(config.metadataExcelPath);

  return {
    path: config.metadataExcelPath,
    rows: rows.length,
    exportedAt
  };
}
