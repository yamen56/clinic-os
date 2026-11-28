"use server";

import { revalidatePath } from "next/cache";
import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { z } from "zod";
import { can, requireClinic, type ClinicAccess } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { clinicNow } from "@/lib/dates";
import { notifyUser, staffMembersInRoles } from "@/lib/notify";
import { NT, asLocale } from "@/lib/notification-text";
import { resolveCapabilities, type MemberRole } from "@/lib/permissions";
import { timeOffRangeText, type TimeOffRow } from "@/lib/time-off";

/*
  Who may record a doctor's days off: the doctor, for themselves — their days
  are theirs, as their hours are (profile/actions) — and whoever holds
  Settings, for any doctor, from Settings → Hours.
*/
function mayManage(access: ClinicAccess, memberId: string): boolean {
  return (access.role === "doctor" && access.memberId === memberId) || can(access, "settings");
}

const CLASHES_LISTED = 8;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const addSchema = z.object({
  memberId: z.string().uuid(),
  from: z.string().regex(DAY),
  to: z.string().regex(DAY),
  note: z.string().max(120).default(""),
  /** The visits on those days were shown, and the person went on. */
  confirmed: z.boolean().optional(),
});

export type TimeOffClash = { id: string; startsAt: string; patient: string | null };

export type TimeOffResult = {
  error?: "forbidden" | "invalid" | "past" | "not_found";
  /** Visits already booked on those days: shown before anything is saved. */
  clashes?: { total: number; list: TimeOffClash[] };
  row?: TimeOffRow;
};

/**
 * Adds a range of days off for one doctor.
 *
 * Bookings never move. The first call stops at the visits that fall on those
 * days so they can be seen; calling again with `confirmed` saves regardless,
 * and the visits stay where they are for the desk to move.
 */
export async function addTimeOffAction(slug: string, input: z.input<typeof addSchema>): Promise<TimeOffResult> {
  const access = await requireClinic(slug);
  const parsed = addSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  if (!mayManage(access, d.memberId)) return { error: "forbidden" };

  const tz = access.clinic.timezone;
  const from = DateTime.fromISO(d.from, { zone: tz });
  const to = DateTime.fromISO(d.to, { zone: tz });
  if (!from.isValid || !to.isValid || to < from || to.diff(from, "days").days > 366) return { error: "invalid" };
  const today = clinicNow(tz).toISODate()!;
  if (d.to < today) return { error: "past" };
  const note = d.note.replace(/\s+/g, " ").trim();
  const seesNames = access.caps.calendar === true;

  const r = await inClinic(access, async (c): Promise<TimeOffResult> => {
    const doctor = (
      await c.query(
        `select m.id, m.user_id, u.full_name, u.locale from clinic_members m join users u on u.id = m.user_id
          where m.id = $1 and m.clinic_id = $2 and m.active and m.role = 'doctor'`,
        [d.memberId, access.clinicId]
      )
    ).rows[0] as { id: string; user_id: string; full_name: string; locale: string | null } | undefined;
    if (!doctor) return { error: "not_found" };

    const booked = (
      await c.query(
        `select a.id, a.starts_at, p.full_name as patient
           from appointments a left join patients p on p.id = a.patient_id
          where a.clinic_id = $1 and a.doctor_member_id = $2
            and a.status in ('pending_approval', 'scheduled', 'confirmed')
            and a.starts_at >= ($3::date)::timestamp at time zone $5
            and a.starts_at < ($4::date + 1)::timestamp at time zone $5
          order by a.starts_at
          limit 500`,
        [access.clinicId, d.memberId, d.from, d.to, tz]
      )
    ).rows as { id: string; starts_at: Date; patient: string | null }[];

    if (booked.length && !d.confirmed) {
      return {
        clashes: {
          total: booked.length,
          list: booked.slice(0, CLASHES_LISTED).map((a) => ({
            id: a.id,
            startsAt: new Date(a.starts_at).toISOString(),
            patient: seesNames ? a.patient : null,
          })),
        },
      };
    }

    const ins = await c.query(
      `insert into doctor_time_off (clinic_id, member_id, starts_on, ends_on, note, created_by)
       values ($1, $2, $3::date, $4::date, $5, $6)
       returning id, member_id, starts_on::text as starts_on, ends_on::text as ends_on, note`,
      [access.clinicId, d.memberId, d.from, d.to, note, access.session.user.id]
    );
    const row = { ...ins.rows[0], doctor_name: doctor.full_name } as TimeOffRow;
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "member.time_off.add",
      entity: "clinic_member",
      entityId: d.memberId,
      detail: { from: d.from, to: d.to, note, bookedOnThoseDays: booked.length },
    });
    await tell(c, access, slug, doctor, row, booked.length);
    return { row };
  });

  if (r.row) revalidate(slug);
  return r;
}

export async function deleteTimeOffAction(slug: string, id: string): Promise<{ error?: "forbidden" | "not_found" }> {
  const access = await requireClinic(slug);
  if (!z.string().uuid().safeParse(id).success) return { error: "not_found" };
  const r = await inClinic(access, async (c) => {
    const row = (
      await c.query(
        `select member_id, starts_on::text as starts_on, ends_on::text as ends_on from doctor_time_off
          where id = $1 and clinic_id = $2`,
        [id, access.clinicId]
      )
    ).rows[0] as { member_id: string; starts_on: string; ends_on: string } | undefined;
    if (!row) return { error: "not_found" as const };
    if (!mayManage(access, row.member_id)) return { error: "forbidden" as const };
    await c.query(`delete from doctor_time_off where id = $1 and clinic_id = $2`, [id, access.clinicId]);
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "member.time_off.remove",
      entity: "clinic_member",
      entityId: row.member_id,
      detail: { from: row.starts_on, to: row.ends_on },
    });
    return {};
  });
  if (!r.error) revalidate(slug);
  return r;
}

function revalidate(slug: string) {
  revalidatePath(`/c/${slug}/settings/hours`);
  revalidatePath(`/c/${slug}/profile/hours`);
}

/**
 * Who hears about it. A doctor adding their own days tells whoever books
 * them, as a change of hours does; somebody adding them for a doctor tells
 * the doctor. Nobody is told about what they did themselves.
 */
async function tell(
  c: PoolClient,
  access: ClinicAccess,
  slug: string,
  doctor: { user_id: string; full_name: string; locale: string | null },
  row: TimeOffRow,
  booked: number
) {
  const actor = access.session.user.id;
  if (doctor.user_id === actor) {
    for (const m of await staffMembersInRoles(c, access.clinicId, ["owner", "receptionist"])) {
      if (m.userId === actor) continue;
      if (!resolveCapabilities(m.permissions, { isOwner: m.isOwner, role: m.role as MemberRole }).calendar) continue;
      const L = NT[asLocale(m.locale)];
      await notifyUser(c, m.userId, {
        clinicId: access.clinicId,
        kind: "doctor_hours",
        title: L.timeOffTitle(doctor.full_name),
        body: L.timeOffBody(timeOffRangeText(row.starts_on, row.ends_on, asLocale(m.locale)), booked),
        url: `/c/${slug}/calendar`,
      });
    }
    return;
  }
  const L = NT[asLocale(doctor.locale)];
  await notifyUser(c, doctor.user_id, {
    clinicId: access.clinicId,
    kind: "doctor_hours",
    title: L.timeOffTitle(doctor.full_name),
    body: L.timeOffBody(timeOffRangeText(row.starts_on, row.ends_on, asLocale(doctor.locale)), booked),
    url: `/c/${slug}/profile/hours`,
  });
}
