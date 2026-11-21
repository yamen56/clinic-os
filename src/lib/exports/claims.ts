import type { PoolClient } from "pg";
import type { ClinicAccess } from "@/lib/auth";
import type { Dict } from "@/lib/i18n/en";
import { loadClaims } from "@/lib/claims";
import { round2 } from "@/lib/invoices";
import type { ExportTable } from "./table";

export type ClaimsFilters = { insurerId: string | null; status: string; month: string | null };

/**
 * A company's claims, as the statement it asks for.
 *
 * Many insurers want one statement a month rather than a claim per visit, and
 * the clinic used to build it by hand from the invoice list. Two sheets: one
 * row per claim — patient, national number, policy, the services and their
 * billing codes, what the company owes — with a totals row; and one row per
 * service line, for the companies that check line by line. A CSV is the first
 * sheet; Excel and the PDF carry both.
 *
 * Scoped exactly like the claims screen, through loadClaims and the member's
 * own access — which is why it is built here and not by the print page.
 */
export async function claimsTable(
  c: PoolClient,
  access: ClinicAccess,
  filters: ClaimsFilters,
  t: Dict,
  locale: "ar" | "en"
): Promise<ExportTable> {
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
    ? (((await c.query(`select name from insurers where id = $1 and clinic_id = $2`, [filters.insurerId, access.clinicId])).rows[0]
        ?.name as string | undefined) ?? "")
    : "";

  const byInvoice = new Map<string, Record<string, unknown>[]>();
  for (const l of lines) {
    const k = String(l.invoice_id);
    byInvoice.set(k, [...(byInvoice.get(k) ?? []), l]);
  }
  const T = t.claims.sheet;
  const statusLabel = (s: string) => (t.insurers.claimStatus as Record<string, string>)[s] ?? s;

  let total = 0;
  let insurerTotal = 0;
  const claimRows = rows.map((r) => {
    const ls = byInvoice.get(r.id) ?? [];
    const share = Number(r.insurer_amount);
    total = round2(total + Number(r.total));
    insurerTotal = round2(insurerTotal + share);
    return {
      invoice: r.number,
      date: r.issue_day,
      patient: r.patient_name,
      nationalId: r.national_id ?? "",
      policy: r.insurance_no ?? "",
      insurer: r.insurer_name ?? "",
      services: ls.map((l) => String(l.description)).join(" + "),
      codes: ls
        .map((l) => String(l.fee_code ?? ""))
        .filter(Boolean)
        .join(", "),
      total: Number(r.total),
      insurerShare: share,
      patientShare: round2(Number(r.total) - share),
      status: statusLabel(r.claim_status),
      reference: r.claim_ref ?? "",
    };
  });
  const lineRows = rows.flatMap((r) =>
    (byInvoice.get(r.id) ?? []).map((l) => ({
      invoice: r.number,
      date: r.issue_day,
      patient: r.patient_name,
      nationalId: r.national_id ?? "",
      service: String(l.description),
      code: String(l.fee_code ?? ""),
      qty: Number(l.qty),
      lineTotal: round2(Number(l.amount) - Number(l.discount_amount) + Number(l.tax_amount)),
    }))
  );

  const who = (insurerName || "all").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "insurer";
  const statusWord = filters.status === "all" ? "" : statusLabel(filters.status);
  return {
    title: T.claims,
    subtitle: [insurerName, filters.month ?? "", statusWord].filter(Boolean).join(" · ") || undefined,
    clinicName: (locale === "ar" && access.clinic.nameAr) || access.clinic.name,
    fileName: `${access.clinic.slug}-claims-${who}-${filters.month ?? filters.status}`,
    locale,
    currency: access.clinic.currency,
    sheets: [
      {
        name: T.claims,
        // Dates as text, in the order they sort: see the note in lib/patient-sheet.
        columns: [
          { key: "invoice", label: T.invoice },
          { key: "date", label: T.date, kind: "date" },
          { key: "patient", label: T.patient },
          { key: "nationalId", label: T.nationalId },
          { key: "policy", label: T.policy },
          { key: "insurer", label: t.insurers.insurer },
          { key: "services", label: T.services },
          { key: "codes", label: T.codes },
          { key: "total", label: T.total, kind: "money" },
          { key: "insurerShare", label: T.insurerShare, kind: "money" },
          { key: "patientShare", label: T.patientShare, kind: "money" },
          { key: "status", label: T.status },
          { key: "reference", label: T.reference },
        ],
        rows: claimRows,
        totals: { invoice: T.totals, total, insurerShare: insurerTotal, patientShare: round2(total - insurerTotal) },
      },
      {
        name: T.lines,
        columns: [
          { key: "invoice", label: T.invoice },
          { key: "date", label: T.date, kind: "date" },
          { key: "patient", label: T.patient },
          { key: "nationalId", label: T.nationalId },
          { key: "service", label: T.service },
          { key: "code", label: T.code },
          { key: "qty", label: T.qty, kind: "number" },
          { key: "lineTotal", label: T.lineTotal, kind: "money" },
        ],
        rows: lineRows,
      },
    ],
  };
}
