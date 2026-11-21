import type { PoolClient } from "pg";
import { can, hasFullControl, type ClinicAccess } from "./auth";

/**
 * Which invoices a member may see: all of the clinic's, or only their own work.
 *
 * This is the one place in the product that reads `role` to decide something,
 * and it is worth being plain about why rather than letting it slip past. It is
 * not a gate — gates decide which screens exist and those still read `caps`.
 * It is a row filter, and its key is `invoice_line_doctors.doctor_member_id`, a
 * column only a doctor ever appears in. Filtering reception by the same rule
 * would show them nothing at all, and taking money at the desk for whoever is
 * in the chair is the whole of that job.
 *
 * Whoever holds the clinic is never filtered: they are the one person who has
 * to be able to find any invoice in it.
 */
export function ownInvoicesOnly(access: ClinicAccess): boolean {
  return access.role === "doctor" && !hasFullControl(access);
}

/**
 * The predicate, ready to append to a query over `invoices`.
 *
 * `alias` is interpolated into SQL, so it may only ever be a literal written
 * here in the codebase — never anything derived from a request. Every caller
 * passes a one- or two-letter table alias it wrote itself.
 *
 * Returns an empty string for a member who is not filtered, so the caller can
 * concatenate unconditionally and a query that forgets to is visibly missing
 * the call rather than silently unscoped.
 */
export function invoiceScopeSql(
  access: ClinicAccess,
  alias: string,
  nextParam: number
): { sql: string; params: string[] } {
  if (!ownInvoicesOnly(access)) return { sql: "", params: [] };
  /*
    A filtered member with no membership row cannot match anything, and the
    honest answer is an empty list rather than an unfiltered one. This is
    unreachable today — the only memberless access is a super admin, who is
    `isOwner` and therefore never filtered — but "unreachable" is the wrong
    thing to rely on in the fallback branch of a permission.
  */
  if (!access.memberId) return { sql: " and false", params: [] };
  return {
    sql: ` and exists (
            select 1 from invoice_line_doctors ild
              join invoice_items ii on ii.id = ild.invoice_item_id
             where ii.invoice_id = ${alias}.id and ild.doctor_member_id = $${nextParam})`,
    params: [access.memberId],
  };
}

/**
 * Whether this member may act on one invoice.
 *
 * Every mutation that takes an invoice id calls this, because hiding a row from
 * a list while leaving `voidInvoiceAction` reachable by id is not a permission,
 * it is a wager that nobody will try — and voiding a filed invoice raises a
 * real credit note against a tax authority.
 */
export async function mayTouchInvoice(
  c: PoolClient,
  access: ClinicAccess,
  invoiceId: string
): Promise<boolean> {
  if (todayOnly(access)) {
    const day = invoiceDaySql(access, "i", 3, { owedToo: true });
    const r = await c.query(`select 1 from invoices i where i.id = $1 and i.clinic_id = $2${day.sql}`, [invoiceId, access.clinicId, ...day.params]);
    if (!r.rowCount) return false;
  }
  if (!ownInvoicesOnly(access)) return true;
  if (!access.memberId) return false;
  const r = await c.query(
    `select 1 from invoice_items ii
       join invoice_line_doctors ild on ild.invoice_item_id = ii.id
      where ii.invoice_id = $1 and ii.clinic_id = $2 and ild.doctor_member_id = $3
      limit 1`,
    [invoiceId, access.clinicId, access.memberId]
  );
  return !!r.rowCount;
}

/**
 * Whether this member sees only today's invoices and payments — they have
 * Invoices but not `invoices.history` (Yamen, 2026-11-20: staff "only being
 * able to see today's and create new ones").
 */
export function todayOnly(access: ClinicAccess): boolean {
  return can(access, "invoices") && !can(access, "invoices.history");
}

/**
 * The day filter for a today-only member, ready to append to a query over
 * `invoices`; empty for everybody else.
 *
 * Today's is what was raised today or is dated today — the date an invoice
 * carries can be set back (2026-11-20), and one entered today for last week
 * is still today's work at the desk. `owedToo` adds any invoice that still has
 * something to pay: the desk settles a patient's balance from the file, and a
 * link there must not lead to a page that refuses it. The list itself is
 * today's only, which is the point of the switch.
 *
 * `alias` is interpolated, so it is only ever a literal written here in code.
 */
export function invoiceDaySql(
  access: ClinicAccess,
  alias: string,
  nextParam: number,
  opts: { owedToo?: boolean } = {}
): { sql: string; params: string[] } {
  if (!todayOnly(access)) return { sql: "", params: [] };
  const tz = `$${nextParam}`;
  const today = `(now() at time zone ${tz})::date`;
  const owed = opts.owedToo ? ` or ${alias}.status in ('draft', 'sent', 'partially_paid')` : "";
  return {
    sql: ` and ((${alias}.created_at at time zone ${tz})::date = ${today} or ${alias}.issue_date = ${today}${owed})`,
    params: [access.clinic.timezone],
  };
}

/** The same for a query over `payments`: taken today, or entered today for another day. */
export function paymentDaySql(access: ClinicAccess, alias: string, nextParam: number): { sql: string; params: string[] } {
  if (!todayOnly(access)) return { sql: "", params: [] };
  const tz = `$${nextParam}`;
  const today = `(now() at time zone ${tz})::date`;
  return {
    sql: ` and ((${alias}.paid_at at time zone ${tz})::date = ${today} or (${alias}.created_at at time zone ${tz})::date = ${today})`,
    params: [access.clinic.timezone],
  };
}

/**
 * Whether this member may see what each patient owes — the amount in the
 * patient list's Owes column and its "Owe money" filter. The same answer as
 * the balance on a patient's file: Invoices, and not filtered to their own
 * work (a doctor on their own invoices would otherwise read the clinic's).
 */
export function canSeeOwes(access: ClinicAccess): boolean {
  return can(access, "invoices") && !ownInvoicesOnly(access);
}
