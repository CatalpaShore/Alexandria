import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { config } from "./config.js";
import { db } from "./db.js";

export type MetadataOriginImportResult = {
  imported: number;
  skipped: boolean;
  sourcePath: string;
};

export async function importMetadataOriginsFromWorkbookIfNeeded(): Promise<MetadataOriginImportResult> {
  const sourcePath = config.metadataExcelPath;
  const existing = db.prepare("SELECT COUNT(*) AS count FROM metadata_file_origins").get() as { count: number };
  if (existing.count > 0 || !fs.existsSync(sourcePath)) {
    return { imported: 0, skipped: true, sourcePath };
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(sourcePath);
  const sheet = workbook.getWorksheet("元数据明细");
  if (!sheet) throw new Error("元数据 Excel 缺少“元数据明细”工作表");

  const headers = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, column) => headers.set(String(cell.value ?? "").trim(), column));
  const codeColumn = headers.get("番号");
  const pathColumn = headers.get("原始路径") ?? headers.get("样例路径");
  const basenameColumn = headers.get("原始文件名");
  if (!codeColumn || (!pathColumn && !basenameColumn)) {
    throw new Error("元数据 Excel 缺少番号或历史文件路径列");
  }

  const importedAt = new Date().toISOString();
  const rows: Array<{ code: string; basename: string; relativePath: string }> = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const code = String(row.getCell(codeColumn).value ?? "").trim();
    const relativePath = pathColumn ? String(row.getCell(pathColumn).value ?? "").trim() : "";
    const explicitBasename = basenameColumn ? String(row.getCell(basenameColumn).value ?? "").trim() : "";
    const filename = relativePath ? path.basename(relativePath) : "";
    const basename = explicitBasename || (filename ? path.basename(filename, path.extname(filename)) : "");
    if (code && basename) rows.push({ code, basename, relativePath });
  });

  const insert = db.prepare(`
    INSERT OR IGNORE INTO metadata_file_origins
      (normalized_code, original_basename, original_relative_path, source_path, imported_at)
    VALUES (@code, @basename, @relativePath, @sourcePath, @importedAt)
  `);
  const importRows = db.transaction(() => {
    let imported = 0;
    for (const row of rows) {
      imported += insert.run({ ...row, sourcePath, importedAt }).changes;
    }
    return imported;
  });

  return { imported: importRows(), skipped: false, sourcePath };
}
