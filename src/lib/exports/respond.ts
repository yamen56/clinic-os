import { NextResponse } from "next/server";
import type { ClinicAccess } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { fileResponseHeaders } from "@/lib/download";
import { toCsv } from "./csv";
import { toXlsx } from "./xlsx";
import { MAX_PDF_ROWS, tableToPdf } from "./render";
import { rowCount, type ExportFormat, type ExportTable } from "./table";

const TYPES: Record<ExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

/**
 * An export, written in the format asked for, recorded, and handed back.
 *
 * - Audited, every format: this is the clinic's data leaving the building.
 * - Never cached: one member's file must not sit in a shared browser profile
 *   for the next.
 * - A PDF over its size is refused with the count, the way the patient export
 *   refuses — never quietly cut short; Excel and CSV carry what the loader
 *   allowed. A CSV is one table, so it is the first sheet.
 */
export async function sendExport(opts: {
  access: ClinicAccess;
  table: ExportTable;
  format: ExportFormat;
  /** The audit row's action: "payments.export". */
  action: string;
  detail?: Record<string, unknown>;
}): Promise<NextResponse> {
  const { access, table, format } = opts;
  const count = rowCount(table);
  if (format === "pdf" && count > MAX_PDF_ROWS) {
    return NextResponse.json({ error: "too_many", count, max: MAX_PDF_ROWS }, { status: 413 });
  }

  let body: Buffer;
  try {
    body =
      format === "csv"
        ? Buffer.from(toCsv(table.sheets[0]), "utf8")
        : format === "xlsx"
          ? await toXlsx(table)
          : await tableToPdf(access, table);
  } catch (e) {
    console.error(`[${opts.action} ${format}]`, (e as Error).message);
    return NextResponse.json({ error: "render_failed" }, { status: 502 });
  }

  await inClinic(access, (c) =>
    audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: opts.action,
      entity: "clinic",
      entityId: access.clinicId,
      detail: { count, format, bytes: body.length, ...opts.detail },
    })
  );

  return new NextResponse(new Uint8Array(body), {
    headers: fileResponseHeaders({
      declaredType: TYPES[format],
      fileName: `${table.fileName}.${format}`,
      size: body.length,
      wantsDownload: true,
      cacheControl: "no-store, private",
    }),
  });
}

/** More rows than an export will carry, as the 413 the export menu explains. */
export function tooMany(count: number, max: number): NextResponse {
  return NextResponse.json({ error: "too_many", count, max }, { status: 413 });
}
