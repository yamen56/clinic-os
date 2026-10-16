import type { PoolClient } from "pg";

export type WaitlistEntry = {
  id: string;
  status: "waiting" | "offered";
  earliest_date: string | null;
  latest_date: string | null;
  note: string;
  last_offered_at: string | null;
  offers_sent: number;
  created_at: string;
  patient_id: string;
  full_name: string;
  phone_e164: string | null;
  doctor_member_id: string | null;
  doctor_name: string | null;
  service_id: string | null;
  service_name: string | null;
  service_name_ar: string | null;
};

/**
 * Who would take an earlier appointment if one came free: the live entries,
 * oldest first within each status — the order worker/waitlist.ts offers in.
 *
 * Also whether the clinic has a booking link at all, since an offer is a link
 * to book and a waitlist with nowhere to send people quietly does nothing.
 */
export async function loadWaitlist(
  c: PoolClient,
  clinicId: string
): Promise<{ entries: WaitlistEntry[]; hasBookingLink: boolean }> {
  const entries = (
    await c.query(
      `select w.id, w.status, w.earliest_date::text, w.latest_date::text, w.note,
              w.last_offered_at, w.offers_sent, w.created_at,
              p.id as patient_id, p.full_name, p.phone_e164,
              w.doctor_member_id, u.full_name as doctor_name,
              w.service_id, s.name as service_name, s.name_ar as service_name_ar
         from waitlist_entries w
         join patients p on p.id = w.patient_id
         left join clinic_members cm on cm.id = w.doctor_member_id
         left join users u on u.id = cm.user_id
         left join services s on s.id = w.service_id
        where w.clinic_id = $1 and w.status in ('waiting', 'offered')
        order by w.status, w.created_at`,
      [clinicId]
    )
  ).rows as WaitlistEntry[];
  const link = await c.query(`select 1 from booking_links where clinic_id = $1 and active limit 1`, [clinicId]);
  return { entries: JSON.parse(JSON.stringify(entries)), hasBookingLink: !!link.rowCount };
}
