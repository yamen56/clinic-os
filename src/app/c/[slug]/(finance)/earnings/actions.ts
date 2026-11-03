"use server";

import { revalidatePath } from "next/cache";
import { DateTime } from "luxon";
import { z } from "zod";
import { requireClinic, can, hasFullControl } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { withSystem } from "@/lib/db";
import { audit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { NT, asLocale } from "@/lib/notification-text";
import { fmtMoney } from "@/lib/dates";
import { PAYOUT_METHODS, periodOf } from "@/lib/payouts";

const payoutSchema = z.object({
  doctorMemberId: z.string().uuid(),
  /** The month it pays for, as its first day. */
  period: z.string().regex(/^\d{4}-\d{2}-01$/),
  amount: z.coerce.number().positive().max(1_000_000),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  method: z.enum(PAYOUT_METHODS).default("cash"),
  note: z.string().max(300).optional().default(""),
});

/**
 * Money handed to a doctor for a month (0091).
 *
 * The doctor is told, in their own language, unless they are the one marking
 * it — an owner who is also a doctor paying themselves knows.
 */
export async function recordPayoutAction(
  slug: string,
  data: unknown
): Promise<{ error?: string; id?: string }> {
  const access = await requireClinic(slug);
  /*
    The same door as the payout table itself: the takings capability, and
    holding the clinic. What a colleague is paid is not something a capability
    alone opens (see the earnings page), and marking it paid is no less.
  */
  if (!can(access, "invoices.analytics") || !hasFullControl(access)) return { error: "forbidden" };
  const parsed = payoutSchema.safeParse(data);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  // A month that has not started has earned nobody anything to be paid.
  if (d.period > periodOf(access.clinic.timezone, 0)) return { error: "invalid" };

  const r = await inClinic(access, async (c): Promise<{ error?: string; id?: string }> => {
    /*
      By hand rather than left to the foreign key: FK checks run as the table
      owner and bypass row-level security, so another clinic's member id would
      satisfy the constraint.
    */
    const doctor = (
      await c.query(
        `select cm.user_id, u.full_name, u.locale from clinic_members cm join users u on u.id = cm.user_id
          where cm.id = $1 and cm.clinic_id = $2`,
        [d.doctorMemberId, access.clinicId]
      )
    ).rows[0];
    if (!doctor) return { error: "not_found" };

    const id = (
      await c.query(
        `insert into doctor_payouts (clinic_id, doctor_member_id, period, amount, paid_on, method, note, created_by)
         values ($1, $2, $3::date, $4, $5::date, $6, $7, $8) returning id`,
        [access.clinicId, d.doctorMemberId, d.period, d.amount, d.paidOn, d.method, d.note.trim(), access.session.user.id]
      )
    ).rows[0].id as string;

    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "payout.create",
      entity: "doctor_payout",
      entityId: id,
      detail: { doctorMemberId: d.doctorMemberId, period: d.period, amount: d.amount, method: d.method },
    });

    if (doctor.user_id !== access.session.user.id) {
      const locale = asLocale(doctor.locale);
      const L = NT[locale];
      const month = DateTime.fromISO(d.period)
        .setLocale(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB")
        .toFormat("LLLL yyyy");
      await notifyUser(c, doctor.user_id as string, {
        clinicId: access.clinicId,
        kind: "payout_paid",
        title: L.payoutTitle(month, fmtMoney(d.amount, access.clinic.currency, locale)),
        body: [L.payoutMethods[d.method], d.note.trim()].filter(Boolean).join(" · "),
        url: `/c/${slug}/earnings?month=${d.period.slice(0, 7)}`,
        dedupeKey: `payout:${id}`,
      });
    }
    return { id };
  });
  if (r.id) revalidatePath(`/c/${slug}/earnings`);
  return r;
}

/** A payout recorded by mistake, and the notification that told the doctor about it. */
export async function removePayoutAction(slug: string, id: string): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "invoices.analytics") || !hasFullControl(access)) return { error: "forbidden" };
  if (!z.string().uuid().safeParse(id).success) return { error: "invalid" };

  const gone = await inClinic(access, async (c) => {
    const r = await c.query(
      `delete from doctor_payouts where id = $1 and clinic_id = $2
       returning doctor_member_id, to_char(period, 'YYYY-MM-DD') as period, amount,
                 (select user_id from clinic_members where id = doctor_member_id) as user_id`,
      [id, access.clinicId]
    );
    if (!r.rowCount) return null;
    const row = r.rows[0];
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "payout.delete",
      entity: "doctor_payout",
      entityId: id,
      detail: { doctorMemberId: row.doctor_member_id, period: row.period, amount: Number(row.amount) },
    });
    return row as { user_id: string | null };
  });
  if (!gone) return { error: "not_found" };

  /*
    A colleague's notifications are not ours to touch from inside the clinic's
    transaction (they are readable by their owner alone), so this one is taken
    back from system context, after the payout is gone for certain. "You were
    paid" left standing for money that was never handed over is the one
    notification here that would be a lie.
  */
  if (gone.user_id) {
    await withSystem((c) =>
      c.query(`delete from notifications where dedupe_key = $1`, [`payout:${id}:${gone.user_id}`])
    );
  }
  revalidatePath(`/c/${slug}/earnings`);
  return {};
}
