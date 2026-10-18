"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireClinic, can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { round2 } from "@/lib/invoices";

const paySchema = z.object({
  caseIds: z.array(z.string().uuid()).min(1).max(200),
  method: z.enum(["cash", "cliq", "card", "transfer", "cheque"]),
});

/**
 * A lab paid for its work: one expense, in the clinic's Lab category, for the
 * cases it covers — and those cases point at it, so their cost is settled
 * (it no longer changes a doctor's share) and they leave To pay. Deleting the
 * expense in Expenses puts them back.
 *
 * One lab at a time: an expense is money paid to somebody. Only outside labs'
 * work, not called off, not paid already; the clinic's own lab is paid
 * through the payroll.
 */
export async function markLabCasesPaidAction(slug: string, data: unknown): Promise<{ expenseId?: string; amount?: number; error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "expenses")) return { error: "forbidden" };
  if (!access.clinic.features.dental) return { error: "forbidden" };
  const parsed = paySchema.safeParse(data);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  const ids = [...new Set(d.caseIds)];

  return inClinic(access, async (c) => {
    const rows = (
      await c.query(
        `select lc.id, lc.cost, lc.lab_id, lc.status, lc.expense_id, l.name, l.in_house
           from lab_cases lc join dental_labs l on l.id = lc.lab_id
          where lc.id = any($1::uuid[]) and lc.clinic_id = $2
          for update of lc`,
        [ids, access.clinicId]
      )
    ).rows;
    if (rows.length !== ids.length) return { error: "not_found" };
    if (new Set(rows.map((r) => r.lab_id)).size !== 1) return { error: "one_lab" };
    if (rows.some((r) => r.in_house || r.status === "cancelled" || r.expense_id)) return { error: "not_payable" };
    const amount = round2(rows.reduce((s, r) => s + Number(r.cost), 0));
    if (!(amount > 0)) return { error: "nothing_to_pay" };
    const lab = rows[0];
    const exp = (
      await c.query(
        `insert into expenses (clinic_id, category_id, amount, vendor, note, spent_on, method, created_by)
         values ($1, (select id from expense_categories where clinic_id = $1 and key = 'lab' and active limit 1), $2, $3, $4,
                 ((now() at time zone (select timezone from clinics where id = $1)))::date, $5, $6)
         returning id`,
        [access.clinicId, amount, String(lab.name).slice(0, 120), `${ids.length} lab case${ids.length === 1 ? "" : "s"}`, d.method, access.session.user.id]
      )
    ).rows[0];
    await c.query(`update lab_cases set expense_id = $1 where id = any($2::uuid[]) and clinic_id = $3`, [exp.id, ids, access.clinicId]);
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "lab_case.paid",
      entity: "expense",
      entityId: exp.id,
      detail: { lab: lab.lab_id, cases: ids.length, amount, method: d.method },
    });
    revalidatePath(`/c/${slug}/labs`);
    revalidatePath(`/c/${slug}/expenses`);
    return { expenseId: exp.id as string, amount };
  });
}
