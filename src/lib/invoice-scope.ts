import type { PoolClient } from "pg";
import { hasFullControl, type ClinicAccess } from "./auth";

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
