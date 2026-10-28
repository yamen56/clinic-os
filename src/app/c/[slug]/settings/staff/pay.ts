import type { PoolClient } from "pg";
import { z } from "zod";

/*
  How a member is paid (0086): a percentage of what their work brings in, a
  monthly salary, or a fee for each visit they are called in for — one at a
  time, and none at all is a choice too ("not set").

  Yamen, 2026-10-28: "the percentage with the doctor unless he have a salary or
  on call". The percentage is the deal this product always had; the other two
  had nowhere to live, so a salaried doctor read as "no arrangement" and the
  clinic's profit never heard of their salary.

  Shared by adding a member and editing one, so the two cannot disagree about
  what a deal is. The owner's alone, in both — the callers check that.
*/

export const paySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("percent"),
    percent: z.number().min(0).max(100),
    costsRule: z.enum(["shared", "doctor"]).default("shared"),
  }),
  z.object({
    kind: z.literal("salary"),
    amount: z.number().positive().max(9_999_999),
    day: z.number().int().min(1).max(31).default(1),
  }),
  z.object({ kind: z.literal("on_call"), fee: z.number().min(0).max(9_999_999) }),
]);
export type Pay = z.infer<typeof paySchema>;

/** A share and a per-visit fee are paid on a doctor's own work; anybody can be on a salary. */
export const payFitsRole = (pay: Pay, role: string) =>
  role === "doctor" || pay.kind === "none" || pay.kind === "salary";

/**
 * Writes the deal and keeps the salary's repeating bill in step with it.
 *
 * Every other deal's columns are cleared, so a doctor moved from a percentage
 * to a salary stops taking a share of the next invoice at once — the lines
 * already billed keep the rate frozen on them (0049).
 */
export async function applyPay(c: PoolClient, clinicId: string, memberId: string, pay: Pay) {
  await c.query(
    `update clinic_members
        set commission_percent = $3, costs_rule = coalesce($4, costs_rule),
            salary_amount = $5, salary_day = $6, on_call_fee = $7
      where id = $1 and clinic_id = $2`,
    [
      memberId,
      clinicId,
      pay.kind === "percent" ? pay.percent : null,
      pay.kind === "percent" ? pay.costsRule : null,
      pay.kind === "salary" ? pay.amount : null,
      pay.kind === "salary" ? pay.day : null,
      pay.kind === "on_call" ? pay.fee : null,
    ]
  );
  await syncSalaryBill(c, clinicId, memberId);
}

/**
 * The salary as the clinic's spending: a repeating bill in Salaries, in the
 * member's name, on their pay day — where the rent is, so it comes off what the
 * clinic kept the way every other cost does, and is not counted as a share.
 *
 * Read from the member, so one function answers every change that bears on it:
 * the deal, a rename, being removed or added back. A member with a salary who
 * is here has an active bill; anybody else's bill is switched off, never
 * deleted — the months it already posted stay where they are.
 *
 * It starts from the next pay day. Switched on after this month's pay day, the
 * month is marked done (`last_posted_on`), or adding somebody on the 20th would
 * post a whole month's salary for the 1st they were not here for; before it,
 * this month posts on the day.
 */
export async function syncSalaryBill(c: PoolClient, clinicId: string, memberId: string) {
  const r = await c.query(
    `select cm.salary_amount, cm.salary_day, cm.salary_schedule_id, cm.active, u.full_name,
            s.id as schedule_id, s.active as schedule_active
       from clinic_members cm
       join users u on u.id = cm.user_id
       left join expense_schedules s on s.id = cm.salary_schedule_id and s.clinic_id = cm.clinic_id
      where cm.id = $1 and cm.clinic_id = $2`,
    [memberId, clinicId]
  );
  const m = r.rows[0];
  if (!m) return;
  const wanted = m.active && m.salary_amount != null;

  if (!wanted) {
    if (m.schedule_id && m.schedule_active) {
      await c.query(`update expense_schedules set active = false where id = $1 and clinic_id = $2`, [m.schedule_id, clinicId]);
    }
    return;
  }

  // Today in the clinic's own zone, worked out in SQL: a `date` handed back to
  // node becomes the server's midnight, and sent back it can move a day.
  const today = `(select (now() at time zone timezone)::date from clinics where id = $2)`;
  if (m.schedule_id) {
    await c.query(
      `update expense_schedules
          set amount = $3, day_of_month = $4::int, vendor = $5, active = true,
              last_posted_on = case
                when not active and $4::int <= extract(day from ${today})
                  then greatest(coalesce(last_posted_on, ${today}), ${today})
                else last_posted_on end
        where id = $1 and clinic_id = $2`,
      [m.schedule_id, clinicId, m.salary_amount, m.salary_day ?? 1, m.full_name]
    );
    return;
  }
  const s = await c.query(
    `insert into expense_schedules
       (clinic_id, category_id, amount, vendor, note, method, day_of_month, last_posted_on)
     select $1,
            (select id from expense_categories where clinic_id = $1 and key = 'salaries' limit 1),
            $2, $3, '', 'transfer', $4::int,
            case when $4::int <= extract(day from t.today) then t.today end
       from (select (now() at time zone timezone)::date as today from clinics where id = $1) t
     returning id`,
    [clinicId, m.salary_amount, m.full_name, m.salary_day ?? 1]
  );
  await c.query(`update clinic_members set salary_schedule_id = $3 where id = $1 and clinic_id = $2`, [
    memberId,
    clinicId,
    s.rows[0].id,
  ]);
}
