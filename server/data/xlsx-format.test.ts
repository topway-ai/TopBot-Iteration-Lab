import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { afterEach, expect, it } from "vitest";
import { formatXlsxExport } from "./xlsx-format.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "topbot-xlsx-"));
  dirs.push(dir);
  return { dir, path: join(dir, "report.xlsx") };
}

it("keeps Chinese, numbers, dates and literal formulas while fitting a readable table", async () => {
  const { dir, path } = await fixture();
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Research");
  sheet.addRow(["\u4e2d\u6587\u540d\u79f0", "Radius (km)", "Date", "Source", "Note"]);
  sheet.addRow(["\u6c34\u661f", 2440, new Date("2026-11-16T00:00:00Z"), "https://science.nasa.gov/mercury/facts/", "=1+1"]);
  sheet.addRow(["\u5730\u7403", 6378, new Date("2026-11-16T00:00:00Z"), "https://science.nasa.gov/earth/facts/", "Long source explanation ".repeat(10)]);
  sheet.getCell("C2").numFmt = "dd/mm/yy";
  sheet.getCell("C3").numFmt = "dd/mm/yy";
  await workbook.xlsx.writeFile(path);
  const before = sheet.getSheetValues();
  expect(await formatXlsxExport(path, 2)).toEqual([]);
  const read = new ExcelJS.Workbook();
  await read.xlsx.readFile(path);
  const result = read.worksheets[0]!;
  expect(result.getSheetValues()).toEqual(before);
  expect(result.getCell("E2").type).toBe(ExcelJS.ValueType.String);
  expect(result.getCell("C2").numFmt).toBe("yyyy-mm-dd");
  expect(result.getColumn(1).width).toBeGreaterThanOrEqual(12);
  expect(result.getColumn(4).width).toBeGreaterThan(30);
  expect(result.getRow(3).height).toBeGreaterThan(25);
  expect(result.getCell("A1").font.bold).toBe(true);
  expect(result.getCell("E3").alignment.wrapText).toBe(true);
  expect(result.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
  expect(result.autoFilter).toBe("A1:E3");
  expect(await readdir(dir)).toEqual(["report.xlsx"]);
});

it("leaves large exports unchanged and returns an explicit formatting warning", async () => {
  const { path } = await fixture();
  await writeFile(path, "untouched large export");
  const before = await readFile(path);
  expect(await formatXlsxExport(path, 50_001)).toHaveLength(1);
  expect(await readFile(path)).toEqual(before);
});

it("does not destroy a file when parsing fails", async () => {
  const { dir, path } = await fixture();
  await writeFile(path, "not a workbook");
  await expect(formatXlsxExport(path, 1)).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe("not a workbook");
  expect(await readdir(dir)).toEqual(["report.xlsx"]);
});
