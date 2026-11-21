/**
 * One export, before it is a file.
 *
 * Every export button asks the same question since 2026-11-21 — Excel, CSV or
 * PDF? — so every export is built once as this shape and then written out by
 * whichever of the three writers was asked for (csv.ts, xlsx.ts, render.ts).
 * A new export writes a loader that returns an ExportTable and gets all three
 * formats, the audit row and the headers for free (respond.ts).
 */

export type ExportFormat = "xlsx" | "csv" | "pdf";

export function asExportFormat(v: string | null | undefined, fallback: ExportFormat): ExportFormat {
  return v === "xlsx" || v === "csv" || v === "pdf" ? v : fallback;
}

/**
 * How a column's values are read. Money and numbers stay numbers in the
 * spreadsheet so they can be summed; dates are already text in the order they
 * sort ("2026-11-21", "2026-11-21 14:05") — see the note in lib/patient-sheet.
 */
export type ColumnKind = "text" | "money" | "number" | "date";

export type ExportColumn = { key: string; label: string; kind?: ColumnKind };

export type ExportSheet = {
  /** The sheet's tab in Excel, and its heading in the PDF. 31 characters at most in Excel. */
  name: string;
  columns: ExportColumn[];
  rows: Record<string, string | number | null>[];
  /** A bold last row: labels in text columns, sums in money ones. */
  totals?: Record<string, string | number | null>;
};

export type ExportTable = {
  /** The PDF's title and the workbook's subject: "Payments". */
  title: string;
  /** What the reader is holding: "1 Nov – 21 Nov 2026", "Open claims · Jordan Insurance". */
  subtitle?: string;
  /** The clinic, for the PDF's header. */
  clinicName: string;
  /** Without the extension, which the format decides. */
  fileName: string;
  locale: "ar" | "en";
  currency: string;
  sheets: ExportSheet[];
};

/** Rows across every sheet: what the size limits count. */
export function rowCount(t: ExportTable): number {
  return t.sheets.reduce((n, s) => n + s.rows.length, 0);
}
