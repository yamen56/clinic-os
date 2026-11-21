import ExcelJS from "exceljs";
import type { ExportTable } from "./table";

/**
 * The table as an Excel workbook, one tab per sheet.
 *
 * Laid out to be worked in, not just opened: the header row frozen and
 * filterable, columns wide enough for what is in them, money as numbers with
 * two decimals so a column can be summed, and the whole sheet right to left
 * for an Arabic reader — Excel's own setting, so the columns run the way the
 * clinic reads.
 */
export async function toXlsx(t: ExportTable): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = t.clinicName;
  wb.created = new Date();
  wb.subject = t.title;

  for (const s of t.sheets) {
    const ws = wb.addWorksheet(s.name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet", {
      views: [{ state: "frozen", ySplit: 1, rightToLeft: t.locale === "ar" }],
    });
    ws.addRow(s.columns.map((c) => c.label));
    ws.getRow(1).font = { bold: true };
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: Math.max(1, s.columns.length) } };
    for (const r of s.rows) ws.addRow(s.columns.map((c) => r[c.key] ?? ""));
    if (s.totals) ws.addRow(s.columns.map((c) => s.totals![c.key] ?? "")).font = { bold: true };

    s.columns.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      if (c.kind === "money") col.numFmt = "#,##0.00";
      let width = Math.max(8, c.label.length + 2);
      col.eachCell?.({ includeEmpty: false }, (cell) => {
        width = Math.max(width, Math.min(60, String(cell.value ?? "").length + 2));
      });
      col.width = width;
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
