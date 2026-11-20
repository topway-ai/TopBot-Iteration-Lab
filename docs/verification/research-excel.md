# Research to Excel

Run server checks in an isolated fixture, never against the person's workspace:

```sh
OMB_TEST_DUCKDB_EXTENSIONS=1 pnpm exec vitest run server/data/xlsx-format.test.ts server/data/tools.test.ts server/data/data.e2e.test.ts --maxWorkers=1
pnpm build:server
node scripts/smoke-packaged-server.mjs
```

The optional extension test downloads the signed DuckDB Excel extension. It checks
real export, formatting, fresh-reader import and numbered, non-overwriting exports.
The fixture mints a fresh Data capability after completing its conversation turns;
turn cleanup deliberately invalidates the earlier capability.

For an explicitly requested live acceptance test, use public pages and a dedicated
Downloads subfolder. Do not expose private files or change approval settings.
Ask the installed bot to research several records, retain source URLs and units,
calculate a derived numeric column, export xlsx, then load the returned path and
check every row. Do not supply the expected answers in the task prompt.

Independently open the actual workbook with a second reader. Check numeric and
date types, Chinese text, row counts, source values and calculations. Render the
saved workbook to check clipping. Repeat with new sources and an existing output
filename; compare the original file's hash before and after the collision test.
Record elapsed time, failed tool calls and actual output paths. One successful run
is not evidence of general autonomous-task reliability.

Excel export is a typed static data table, not a live-formula spreadsheet. Layout
formatting is limited to 10 MiB, 50,000 data rows and 250,000 cells to bound memory
on small PCs. Larger exports retain DuckDB's layout and return a warning. Extremely
long cells may exceed Excel's row-height limit; their complete values remain in
the file and the warning must not be presented as a clean visual check.

## Installed acceptance run: 2026-11-16

Windows desktop build `0.1.161-topbot.4` completed these three consecutive live
turns with OpenAI `gpt-6-astra`, submitted through the normal desktop chat:

| Run | Public research dataset | Seconds | Tool calls | Failed calls |
| --- | --- | ---: | ---: | ---: |
| R2 | NASA Mercury, Venus and Earth facts | 65.551 | 10 | 0 |
| R3 | NASA Mars, Jupiter and Saturn facts | 78.842 | 10 | 0 |
| R4 | Fresh inner-planet research with an existing output filename | 53.571 | 10 | 0 |

Each turn visited all three source pages, exported a typed three-row workbook,
loaded the actual returned file path and checked the saved values. An independent
reader checked the NASA values, calculations, Chinese text, source URLs, dates,
ZIP integrity, OOXML relationships and layout properties. Artifact Tool imported
and rendered each saved workbook; visual inspection found no clipped text.

R4 requested `topbot-planets-r2.xlsx` and received `topbot-planets-r2-2.xlsx`.
The original file's SHA-256 was unchanged before and after:
`a79b042df9e651df5f075b13b2fa6116cb7526d45e22c56c278d2c3a09488eb3`.

This validates this bounded research/export/readback workflow, not arbitrary
websites, large workbooks, native Excel automation or live formula authoring.
The baseline build exported correct values but unreadable default column widths.
The formatting fix also removes a dangling theme relationship introduced when
ExcelJS rewrites a theme-less DuckDB export; all installed-run OOXML references
were checked independently.
