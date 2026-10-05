import type { PoolClient } from "pg";
import type { ClinicAccess } from "./auth";
import { invoiceScopeSql } from "./invoice-scope";
import { OPEN_CLAIM_STATUSES, CLAIM_STATUSES, ageBucket } from "./insurance";

/**
 * Insurance claims: the invoices a clinic is owed money on by a company.
 *
 * Not a table of their own. A claim is an invoice seen from the insurer's
 * side — `insurer_id`, `insurer_amount`, `claim_status` — and keeping it there
 * means the number on the claims screen, the invoice and the monthly statement
 * cannot disagree. One loader for the screen and the statement, for the same
 * reason.
 *
 * Scoped like the invoice list: a doctor who sees only their own invoices sees
 * only their own claims.
 */

export type ClaimFilters = {
  insurerId?: string | null;
  /** "open" (the default), "all", or one status. */
  status?: string | null;
  /** yyyy-MM, by issue date. */
  month?: string | null;
};

export type ClaimRow = {
  id: string;
  number: string;
  issue_day: string;
  total: string;
  insurer_amount: string;
  amount_paid: string;
  claim_status: string;
  claim_ref: string | null;
  claim_note: string | null;
  insurer_id: string | null;
  insurer_name: string | null;
  patient_id: string;
  patient_name: string;
  national_id: string | null;
  insurance_no: string | null;
  cover_until: string | null;
};

export const MAX_CLAIM_ROWS = 1000;

export function statusesFor(status: string | null | undefined): readonly string[] {
  if (!status || status === "open") return OPEN_CLAIM_STATUSES;
  if (status === "all") return CLAIM_STATUSES.filter((s) => s !== "none");
  return (CLAIM_STATUSES as readonly string[]).includes(status) && status !== "none" ? [status] : OPEN_CLAIM_STATUSES;
}

export async function loadClaims(c: PoolClient, access: ClinicAccess, f: ClaimFilters): Promise<ClaimRow[]> {
  const params: unknown[] = [access.clinicId, statusesFor(f.status)];
  let where = "";
  if (f.insurerId) {
    params.push(f.insurerId);
    where += ` and i.insurer_id = $${params.length}`;
  }
  if (f.month && /^\d{4}-\d{2}$/.test(f.month)) {
    params.push(f.month);
    where += ` and to_char(i.issue_date, 'YYYY-MM') = $${params.length}`;
  }
  const scope = invoiceScopeSql(access, "i", params.length + 1);
  /*
    The creation day stands in for a missing issue date. Every invoice gets one
    (0034 backfilled the old ones), but a row without it used to take the whole
    screen down in `ageBucket` rather than land in the wrong aging column.
  */
  return (
    await c.query(
      `select i.id, i.number, coalesce(i.issue_date, i.created_at::date)::text as issue_day,
              i.total, i.insurer_amount, i.amount_paid,
              i.claim_status, i.claim_ref, i.claim_note, i.insurer_id, ins.name as insurer_name,
              p.id as patient_id, p.full_name as patient_name, p.national_id, p.insurance_no,
              p.insurance_valid_until::text as cover_until
         from invoices i
         join patients p on p.id = i.patient_id
         left join insurers ins on ins.id = i.insurer_id
        where i.clinic_id = $1 and i.claim_status = any($2::text[])
          and i.status <> 'void' and i.credit_note_of is null${where}${scope.sql}
        order by i.issue_date desc, i.seq desc
        limit ${MAX_CLAIM_ROWS}`,
      [...params, ...scope.params]
    )
  ).rows as ClaimRow[];
}

export type InsurerSummary = {
  insurerId: string;
  name: string;
  open: number;
  rejected: number;
  /** Owed and not yet paid: to submit, submitted, approved. */
  awaiting: number;
  aging: { d30: number; d60: number; d90: number; older: number };
};

/**
 * What each company owes, and how long it has owed it — across every open
 * claim, whatever the list below is filtered to. The question the owner asks
 * is "who owes us, and since when", and it does not change with a filter.
 */
export async function summariseOpenClaims(
  c: PoolClient,
  access: ClinicAccess,
  today: string
): Promise<InsurerSummary[]> {
  const rows = await loadClaims(c, access, { status: "open" });
  const by = new Map<string, InsurerSummary>();
  for (const r of rows) {
    if (!r.insurer_id) continue;
    const s =
      by.get(r.insurer_id) ??
      ({
        insurerId: r.insurer_id,
        name: r.insurer_name ?? "",
        open: 0,
        rejected: 0,
        awaiting: 0,
        aging: { d30: 0, d60: 0, d90: 0, older: 0 },
      } satisfies InsurerSummary);
    s.open++;
    if (r.claim_status === "rejected") {
      s.rejected++;
    } else {
      const amount = Number(r.insurer_amount);
      s.awaiting = Math.round((s.awaiting + amount) * 100) / 100;
      const b = ageBucket(r.issue_day, today);
      s.aging[b] = Math.round((s.aging[b] + amount) * 100) / 100;
    }
    by.set(r.insurer_id, s);
  }
  return [...by.values()].sort((a, b) => b.awaiting - a.awaiting || a.name.localeCompare(b.name));
}
