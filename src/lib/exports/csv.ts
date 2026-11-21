import type { ExportSheet } from "./table";

/**
 * A sheet as CSV that Excel opens correctly in Arabic.
 *
 * - A UTF-8 byte-order mark first, or Excel on Windows reads the file as the
 *   local code page and every Arabic name turns into question marks.
 * - CRLF between rows and every text field quoted (RFC 4180), so a comma in
 *   "Amman Lab, Ltd" or a line break in a note stays inside its cell.
 * - A cell that starts with = + - @ or a tab is a formula to a spreadsheet,
 *   and a patient's name or a note is typed by somebody — so such a cell is
 *   prefixed with an apostrophe, which shows nothing and runs nothing. Not
 *   numbers: a phone "+962…" and a negative amount are data, not formulas.
 * - No totals row: a CSV is for loading into other software, where a sum in
 *   the last row is a record that is not one. Excel and the PDF keep it.
 */
export function toCsv(sheet: ExportSheet): string {
  const lines = [sheet.columns.map((c) => cell(c.label)).join(",")];
  for (const r of sheet.rows) lines.push(sheet.columns.map((c) => cell(r[c.key], c.kind)).join(","));
  return String.fromCharCode(0xfeff) + lines.join("\r\n") + "\r\n";
}

const NUMERIC = /^[+-]?\d[\d\s.,]*$/;

function cell(v: unknown, kind?: string): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return kind === "money" ? v.toFixed(2) : String(v);
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !NUMERIC.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
