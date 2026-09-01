import ExcelJS from "exceljs";

/**
 * Reading a real Excel file.
 *
 * A clinic's patient list is far more often an `.xlsx` than a CSV — it is what
 * Excel saves by default, and what every other practice system exports. Handed
 * one, the importer used to decode a zip archive as if it were text and show a
 * screen of mojibake, which reads as "this product cannot take my list".
 *
 * ## Why this runs on the server
 *
 * The CSV path deliberately decodes in the browser, so the bytes stay on the
 * operator's machine until they have seen what the import will do. That is not
 * available here: an xlsx is a zip of XML, and reading one properly means
 * shared-string tables, inline strings, date serials and merged cells — a
 * hand-rolled reader would be a hundred lines of binary parsing whose bugs all
 * look like "my file did not work".
 *
 * So the file is posted, parsed in memory, and the rows come back as text. It is
 * never written to disk and never stored; what the route returns is the same
 * delimited text the paste box would have produced, and everything after this
 * point is the path that already existed.
 */

/** Cell values Excel hands back, flattened to what a person typed. */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    /*
      A date column comes back as a Date built from Excel's serial number, which
      carries no timezone. Formatted from its UTC parts rather than the server's
      local ones — otherwise a birthday west of Greenwich moves a day.
    */
    const p2 = (n: number) => String(n).padStart(2, "0");
    return `${value.getUTCFullYear()}-${p2(value.getUTCMonth() + 1)}-${p2(value.getUTCDate())}`;
  }
  if (typeof value === "object") {
    const v = value as unknown as Record<string, unknown>;
    // A formula cell carries both the formula and what it evaluated to; the
    // clinic means the result. Rich text arrives as runs that have to be joined,
    // and a hyperlink cell keeps its label under `text`.
    if ("result" in v) return cellText(v.result as ExcelJS.CellValue);
    if ("richText" in v && Array.isArray(v.richText)) {
      return (v.richText as { text?: string }[]).map((r) => r.text ?? "").join("");
    }
    if ("text" in v) return String(v.text ?? "");
    if ("error" in v) return "";
    return "";
  }
  return String(value);
}

/** Quotes every field, so a cell containing a tab or a newline survives. */
function toDelimited(rows: string[][]): string {
  return rows
    .map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join("\t"))
    .join("\n");
}

/**
 * The first sheet with anything on it, as delimited text.
 *
 * The first *populated* sheet rather than the first: a workbook exported from
 * another system often opens on a cover sheet, and taking that literally would
 * report an empty file to somebody looking straight at their data.
 */
export async function xlsxToDelimited(buf: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);

  for (const ws of wb.worksheets) {
    const rows: string[][] = [];
    let width = 0;
    ws.eachRow({ includeEmpty: false }, (row) => {
      // `values` is 1-based with a hole at 0, which is an exceljs convention and
      // not a gap in the data.
      const cells = (row.values as ExcelJS.CellValue[]).slice(1).map(cellText);
      if (cells.some((c) => c.trim() !== "")) {
        rows.push(cells);
        if (cells.length > width) width = cells.length;
      }
    });
    if (!rows.length) continue;
    // Ragged rows are normal — Excel stops writing at the last filled cell — and
    // the parser downstream expects a rectangle.
    return toDelimited(rows.map((r) => [...r, ...Array(width - r.length).fill("")]));
  }
  return "";
}

/** What the file picker offers, and what the route will accept. */
export const IMPORT_ACCEPT =
  ".csv,.tsv,.txt,.xlsx,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** An xlsx is a zip; every one begins PK. Checked on the bytes, not the name. */
export function looksLikeXlsx(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}
