import ExcelJS from "exceljs";
import {describe,expect,it} from "vitest";
describe("legacy spreadsheet export dependency",()=>{
 it("round-trips a neutral metadata workbook with Chinese text after the licensed buffers override",async()=>{
  const book=new ExcelJS.Workbook();const sheet=book.addWorksheet("媒体库");sheet.addRow(["编号","标题","分类"]);sheet.addRow(["DEMO-001","山间的清晨","旅行"]);const bytes=await book.xlsx.writeBuffer();const imported=new ExcelJS.Workbook();await imported.xlsx.load(bytes);expect(imported.getWorksheet("媒体库")?.getRow(2).getCell(2).value).toBe("山间的清晨");
 });
});
