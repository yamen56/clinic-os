import type { ClinicAccess } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { renderUrlToPdf } from "@/lib/pdf";
import { printKeyFor } from "@/lib/print-token";
import { appUrl } from "@/lib/urls";
import type { ExportTable } from "./table";

/**
 * Rows one PDF will carry. The worker's Chromium has thirty seconds per page
 * load; a few thousand table rows is well inside it, and past that a PDF is
 * not what anybody reads — Excel is.
 */
export const MAX_PDF_ROWS = 2000;

/**
 * The table as a PDF, printed by the worker from /table-print.
 *
 * The print page has no session, so it cannot run the export's query under the
 * member's access. The table is built here, under that access, parked in
 * `export_renders` (0112) for the length of the render, and the page only
 * draws it. The row goes when the PDF is back, and a render that died half
 * way leaves one that the next export from the clinic sweeps.
 */
export async function tableToPdf(access: ClinicAccess, table: ExportTable): Promise<Buffer> {
  const id = await inClinic(access, async (c) => {
    await c.query(`delete from export_renders where clinic_id = $1 and created_at < now() - interval '1 hour'`, [access.clinicId]);
    // jsonb from a string: node-pg would send a nested array as a Postgres array literal.
    const r = await c.query(`insert into export_renders (clinic_id, payload) values ($1, $2::jsonb) returning id`, [
      access.clinicId,
      JSON.stringify(table),
    ]);
    return r.rows[0].id as string;
  });
  try {
    const { exp, sig } = printKeyFor(id, "table");
    const qs = new URLSearchParams({ exp: String(exp), sig });
    return await renderUrlToPdf(`${appUrl()}/table-print/${id}?${qs}`);
  } finally {
    await inClinic(access, (c) => c.query(`delete from export_renders where id = $1`, [id])).catch(() => {});
  }
}
