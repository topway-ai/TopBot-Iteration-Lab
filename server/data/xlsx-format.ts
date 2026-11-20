import { randomUUID } from "node:crypto";
import { rename, rm, stat } from "node:fs/promises";
import ExcelJS from "exceljs";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 50_000;
const MAX_CELLS = 250_000;

function textWidth(text: string): number {
  return Array.from(text).reduce((width, char) => width + ((char.codePointAt(0) ?? 0) > 255 ? 2 : 1), 0);
}

function dateHasTime(date: Date): boolean {
  return date.getUTCHours() + date.getUTCMinutes() + date.getUTCSeconds() + date.getUTCMilliseconds() !== 0;
}

function displayText(cell: ExcelJS.Cell): string {
  return cell.value instanceof Date ? (dateHasTime(cell.value) ? "2000-01-01 12:30:45.123" : "2000-01-01") : cell.text;
}

/** Formats only a fresh DuckDB export, never an imported user workbook. Values and types stay unchanged. */
export async function formatXlsxExport(path: string, rowCount: number): Promise<string[]> {
  if (rowCount > MAX_ROWS || (await stat(path)).size > MAX_BYTES) {
    return ["Excel data was saved without layout formatting because the export exceeds the formatting size limit."];
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  // DuckDB omits themes; ExcelJS 4.4 otherwise writes a relationship to a missing theme.
  workbook.clearThemes();
  if (workbook.worksheets.some((sheet) => sheet.rowCount * sheet.columnCount > MAX_CELLS)) {
    return ["Excel data was saved without layout formatting because the export exceeds the formatting cell limit."];
  }
  let clipped = false;
  for (const sheet of workbook.worksheets) {
    sheet.views = [{ state: "frozen", ySplit: 1, showGridLines: false }];
    if (sheet.columnCount) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: sheet.rowCount, column: sheet.columnCount } };
    for (let index = 1; index <= sheet.columnCount; index++) {
      const column = sheet.getColumn(index);
      let width = 12;
      column.eachCell((cell) => {
        const text = displayText(cell);
        width = Math.max(width, ...text.split(/\r?\n/).map((line) => Math.min(60, textWidth(line) + 3)));
      });
      column.width = Math.min(60, width);
    }
    sheet.eachRow((row, number) => {
      let lines = 1;
      row.eachCell((cell) => {
        cell.font = { name: "Arial", size: 11, ...(number === 1 ? { bold: true, color: { argb: "FFFFFFFF" } } : {}) };
        cell.alignment = { vertical: "middle", wrapText: true, horizontal: number === 1 ? "center" : typeof cell.value === "number" ? "right" : "left" };
        if (number === 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF344B59" } };
        if (cell.value instanceof Date) cell.numFmt = dateHasTime(cell.value) ? "yyyy-mm-dd hh:mm:ss.000" : "yyyy-mm-dd";
        const text = displayText(cell);
        const available = Math.max(8, (sheet.getColumn(cell.col).width ?? 12) - 3);
        lines = Math.max(lines, text.split(/\r?\n/).reduce((sum, line) => sum + Math.max(1, Math.ceil(textWidth(line) / available)), 0));
      });
      const height = lines * 17 + 8;
      if (height > 409) clipped = true;
      row.height = Math.min(409, height);
    });
  }
  // Finish the replacement before touching the valid original export.
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await workbook.xlsx.writeFile(temporary);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return clipped ? ["Some cells exceed Excel's row-height limit; their full text remains available in the formula bar."] : [];
}
