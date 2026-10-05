import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { fileResponseHeaders } from "@/lib/download";
import { dictForClinic, getLocale } from "@/lib/i18n";
import { isUuid } from "@/lib/uuid";
import { loadClaims } from "@/lib/claims";
import { round2 } from "@/lib/invoices";

const NO_CACHE = "no-store, private";

/**
 * A company's claims for a month, as the spreadsheet it asks for.
 *
 * Many insurers want one statement a month rather than a claim per visit, and
 * the clinic has been building it by hand from the invoice list. Two sheets:
 * one row per claim — patient, national number, policy, the services and
 * their billing codes, what the company owes — with a totals row; and one row
 * per service line, for the companies that check line by line.
 *
 * Gated on working the claims (`insurance.claims`), scoped like the claims
 * screen, and audited:
 * this is patient data, with national numbers, leaving the building.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "insurance.claims");
  if (!g.ok) return g.res;
  const access = g.access;
  const url = new URL(req.url);
  const insurerId = url.searchParams.get("insurer");
  const month = url.searchParams.get("month");
  const filters = {
    insurerId: insurerId && isUuid(insurerId) ? insurerId : null,
    status: url.searchParams.get("status") ?? "open",
    month: month && /^\d{4}-\d{2}$/.test(month) ? month : null,
  };

  const t = await dictForClinic(access.clinic.vocabulary);
  const isAr = (await getLocale()) === "ar";
  const T = t.claims.sheet;

  const data = await inClinic(access, async (c) => {
    const rows = await loadClaims(c, access, filters);
    const ids = rows.map((r) => r.id);
    const lines = ids.length
      ? (
          await c.query(
            `select invoice_id, description, qty, amount, discount_amount, tax_amount, fee_code
               from invoice_items where invoice_id = any($1::uuid[]) order by invoice_id, sort`,
            [ids]
          )
        ).rows
      : [];
    const insurerName = filters.insurerId
      ? ((await c.query(`select name from insurers where id = $1 and clinic_id = $2`, [filters.insurerId, access.clinicId]))
          .rows[0]?.name as string | undefined) ?? ""
      : "";
    return { rows, lines, insurerName };
  });

  const byInvoice = new Map<string, Record<string, unknown>[]>();
  for (const l of data.lines) {
    const k = String(l.invoice_id);
    byInvoice.set(k, [...(byInvoice.get(k) ?? []), l]);
  }
  const statusLabel = (s: string) => (t.insurers.claimStatus as Record<string, string>)[s] ?? s;

  const wb = new ExcelJS.Workbook();
  wb.creator = access.clinic.name;
  wb.created = new Date();

  const sheetOf = (name: string, headers: string[]) => {
    const ws = wb.addWorksheet(name.slice(0, 31), { views: [{ state: "frozen", ySplit: 1, rightToLeft: isAr }] });
    ws.addRow(headers);
    ws.getRow(1).font = { bold: true };
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
    return ws;
  };

  // Dates as text, in the order they sort: see the note in lib/patient-sheet.
  const claims = sheetOf(T.claims, [
    T.invoice, T.date, T.patient, T.nationalId, T.policy, t.insurers.insurer,
    T.services, T.codes, T.total, T.insurerShare, T.patientShare, T.status, T.reference,
  ]);
  let total = 0;
  let insurerTotal = 0;
  for (const r of data.rows) {
    const ls = byInvoice.get(r.id) ?? [];
    const share = Number(r.insurer_amount);
    total = round2(total + Number(r.total));
    insurerTotal = round2(insurerTotal + share);
    claims.addRow([
      r.number, r.issue_day, r.patient_name, r.national_id ?? "", r.insurance_no ?? "", r.insurer_name ?? "",
      ls.map((l) => String(l.description)).join(" + "),
      ls.map((l) => String(l.fee_code ?? "")).filter(Boolean).join(", "),
      Number(r.total), share, round2(Number(r.total) - share), statusLabel(r.claim_status), r.claim_ref ?? "",
    ]);
  }
  const sum = claims.addRow([T.totals, "", "", "", "", "", "", "", total, insurerTotal, round2(total - insurerTotal)]);
  sum.font = { bold: true };

  const linesSheet = sheetOf(T.lines, [
    T.invoice, T.date, T.patient, T.nationalId, T.service, T.code, T.qty, T.lineTotal,
  ]);
  for (const r of data.rows) {
    for (const l of byInvoice.get(r.id) ?? []) {
      linesSheet.addRow([
        r.number, r.issue_day, r.patient_name, r.national_id ?? "",
        String(l.description), String(l.fee_code ?? ""), Number(l.qty),
        round2(Number(l.amount) - Number(l.discount_amount) + Number(l.tax_amount)),
      ]);
    }
  }

  for (const ws of [claims, linesSheet]) {
    ws.columns.forEach((col) => {
      let width = 10;
      col.eachCell?.({ includeEmpty: false }, (cell) => {
        width = Math.max(width, Math.min(60, String(cell.value ?? "").length + 2));
      });
      col.width = width;
    });
  }

  const buf = Buffer.from(await wb.xlsx.writeBuffer());

  await inClinic(access, (c) =>
    audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "claims.export",
      entity: "clinic",
      entityId: access.clinicId,
      detail: { count: data.rows.length, ...filters },
    })
  );

  const who = (data.insurerName || "all").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "insurer";
  return new NextResponse(new Uint8Array(buf), {
    headers: fileResponseHeaders({
      declaredType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      fileName: `${slug}-claims-${who}-${filters.month ?? filters.status}.xlsx`,
      size: buf.length,
      wantsDownload: true,
      cacheControl: NO_CACHE,
    }),
  });
}
