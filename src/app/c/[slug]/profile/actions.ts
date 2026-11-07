"use server";

import { revalidatePath } from "next/cache";
import { requireClinic, destroySession } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { withSystem } from "@/lib/db";
import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { effectiveHours, isWithinHours, parseWeeklyHours, type WeeklyHours } from "@/lib/hours";
import { resolveCapabilities, type MemberRole } from "@/lib/permissions";
import { notifyUser, staffMembersInRoles } from "@/lib/notify";
import { NT, asLocale } from "@/lib/notification-text";

/** Long enough for a full Arabic name with a grandfather in it; `users.full_name` is text. */
const NAME_MAX = 80;

/** How many clashing visits the doctor is shown by name before "and N more". */
const CLASHES_LISTED = 8;

/**
 * Told once per save, to whoever books this doctor. Not the doctor: they just
 * did it. Only people who may open the calendar, which is where it points.
 */
async function tellTheDeskHoursChanged(
  c: PoolClient,
  clinicId: string,
  slug: string,
  doctor: string,
  actorUserId: string,
  clashes: number
) {
  for (const m of await staffMembersInRoles(c, clinicId, ["owner", "receptionist"])) {
    if (m.userId === actorUserId) continue;
    if (!resolveCapabilities(m.permissions, { isOwner: m.isOwner, role: m.role as MemberRole }).calendar) continue;
    const L = NT[asLocale(m.locale)];
    await notifyUser(c, m.userId, {
      clinicId,
      kind: "doctor_hours",
      title: L.hoursTitle(doctor),
      body: clashes ? L.hoursClash(clashes) : L.hoursNoClash,
      url: `/c/${slug}/calendar`,
    });
  }
}

/**
 * A person changing their own name.
 *
 * The name a member signs in under is typed by whoever invited them — an owner
 * filling in a colleague's row, or a super admin creating the workspace — and
 * until now nothing could change it afterwards. A typo, a marriage or a name
 * that was only ever a placeholder was permanent, and it is not a cosmetic
 * field: it is what appears on the calendar, on consultation notes, and on the
 * documents this person signs.
 *
 * Self-service, and deliberately not scoped to one clinic. `users` is shared —
 * the same person can work at two clinics — so this changes their name in both,
 * which is right, because it is one person with one name. That is also why the
 * write needs no system connection: the RLS policy on `users` allows a row to
 * write itself (`with check (id = app_user_id())`) and nobody else's, so the
 * database is enforcing "your own name" independently of this function.
 */
export async function updateMyNameAction(
  slug: string,
  fullName: string
): Promise<{ error?: "invalid" }> {
  const access = await requireClinic(slug);
  const userId = access.session.user.id;
  // Collapsed whitespace, because a name pasted from a form often arrives with
  // a double space in it and two names that differ only there read as one.
  const name = fullName.replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
  if (name.length < 2) return { error: "invalid" };

  return inClinic(access, async (c) => {
    const before = (
      await c.query(`select full_name from users where id = $1`, [userId])
    ).rows[0]?.full_name as string | undefined;
    if (before === name) return {};

    await c.query(`update users set full_name = $2 where id = $1`, [userId, name]);
    /*
      Audited with both names. A record signed last month says one name and the
      account now says another; the only thing that reconciles them is a row
      saying when it changed and what it changed from.
    */
    await audit(c, {
      clinicId: access.clinicId,
      userId,
      impersonatedBy: access.session.impersonatedBy,
      action: "user.rename",
      entity: "user",
      entityId: userId,
      detail: { from: before ?? null, to: name },
    });
    revalidatePath(`/c/${slug}/profile`);
    return {};
  });
}

export type HoursClash = { id: string; startsAt: string; patient: string | null };

/**
 * A doctor setting their own working hours.
 *
 * Writes only the caller's own membership, which is why it answers to who is
 * asking rather than to a capability: `settings.staff` is what lets somebody
 * change a colleague's hours, and most doctors rightly do not hold it.
 *
 * `hours` null means "use the clinic's hours". Anything else is stored with all
 * seven days (see `parseWeeklyHours`).
 *
 * Bookings never move. A visit the new hours leave outside is reported, and the
 * first call stops there so the doctor sees them before anything changes;
 * calling again with `confirmed` saves regardless. Patient names need the
 * calendar, because this list is a window onto it.
 */
export async function saveMyHoursAction(
  slug: string,
  hours: unknown,
  opts: { confirmed?: boolean } = {}
): Promise<{
  error?: "forbidden" | "invalid";
  saved?: boolean;
  clashes?: { total: number; list: HoursClash[] };
}> {
  const access = await requireClinic(slug);
  const memberId = access.memberId;
  if (!memberId || access.role !== "doctor") return { error: "forbidden" };

  const next: WeeklyHours | null = hours === null ? null : parseWeeklyHours(hours);
  if (hours !== null && !next) return { error: "invalid" };

  const userId = access.session.user.id;
  const tz = access.clinic.timezone;
  const seesNames = access.caps.calendar === true;

  const r = await inClinic(access, async (c) => {
    const row = (
      await c.query(
        `select cm.working_hours, cl.working_hours as clinic_hours
           from clinic_members cm join clinics cl on cl.id = cm.clinic_id
          where cm.id = $1 and cm.clinic_id = $2`,
        [memberId, access.clinicId]
      )
    ).rows[0] as { working_hours: WeeklyHours | null; clinic_hours: WeeklyHours } | undefined;
    if (!row) return { error: "forbidden" as const };

    const stored = row.working_hours && Object.keys(row.working_hours).length ? row.working_hours : null;
    const before = stored ? (parseWeeklyHours(stored) ?? stored) : null;
    if (JSON.stringify(before) === JSON.stringify(next)) return { saved: true };

    const bookable = effectiveHours(row.clinic_hours, next);
    const upcoming = (
      await c.query(
        `select a.id, a.starts_at, a.ends_at, p.full_name as patient
           from appointments a left join patients p on p.id = a.patient_id
          where a.clinic_id = $1 and a.doctor_member_id = $2 and a.starts_at >= now()
            and a.status in ('pending_approval', 'scheduled', 'confirmed')
          order by a.starts_at
          limit 500`,
        [access.clinicId, memberId]
      )
    ).rows as { id: string; starts_at: Date; ends_at: Date; patient: string | null }[];
    const outside = upcoming.filter(
      (a) =>
        !isWithinHours(
          bookable,
          DateTime.fromJSDate(new Date(a.starts_at)).setZone(tz),
          DateTime.fromJSDate(new Date(a.ends_at)).setZone(tz)
        )
    );

    if (outside.length && !opts.confirmed) {
      return {
        clashes: {
          total: outside.length,
          list: outside.slice(0, CLASHES_LISTED).map((a) => ({
            id: a.id,
            startsAt: new Date(a.starts_at).toISOString(),
            patient: seesNames ? a.patient : null,
          })),
        },
      };
    }

    await c.query(`update clinic_members set working_hours = $3 where id = $1 and clinic_id = $2`, [
      memberId,
      access.clinicId,
      next ? JSON.stringify(next) : null,
    ]);
    await audit(c, {
      clinicId: access.clinicId,
      userId,
      impersonatedBy: access.session.impersonatedBy,
      action: "member.own_hours",
      entity: "clinic_member",
      entityId: memberId,
      detail: { from: before, to: next, outsideNewHours: outside.length },
    });
    await tellTheDeskHoursChanged(c, access.clinicId, slug, access.session.user.fullName, userId, outside.length);
    return { saved: true };
  });

  if (r.saved) {
    revalidatePath(`/c/${slug}/profile`);
    revalidatePath(`/c/${slug}/profile/hours`);
  }
  return r;
}

/**
 * A person erasing their own account.
 *
 * Jordan's PDPL gives a data subject the right to have their personal data
 * erased, and until now the only way to exercise it here was to ask somebody
 * with database access. This is that right, as a button.
 *
 * **What is deleted, and what deliberately is not.** Deleting the `users` row
 * is enough, and the schema is what makes it enough — every reference to a user
 * is already declared one of two ways:
 *
 *   - `on delete cascade` for the things that *are* the account: sessions,
 *     memberships, notifications, push subscriptions, auth tokens. These go.
 *   - `on delete set null` for the thirty-odd places a user appears as an
 *     author or an actor: `patient_notes.author_id`, `invoices.created_by`,
 *     `documents.locked_by`, `audit_log.user_id`. These stay, with the person
 *     detached from them.
 *
 * That second half is not a compromise on erasure, it is the other law. A
 * consultation note is a medical record with its own retention period, and it
 * belongs to the patient rather than to the doctor who typed it — erasing the
 * note to erase the author would delete somebody else's health record to satisfy
 * a request they did not make. So the note survives and stops naming anybody.
 *
 * Ownership is the case this refuses. An owner's account is not separable from
 * the workspace: cascading their membership would leave a clinic full of patient
 * records with nobody able to reach it, no way to grant anybody access, and no
 * way to delete it afterwards. They are told to hand ownership over or close the
 * workspace, which is a different and much louder operation.
 */
export async function deleteMyAccountAction(
  slug: string,
  confirmEmail: string
): Promise<{ error?: "owner" | "email_mismatch" }> {
  const access = await requireClinic(slug);
  const userId = access.session.user.id;

  /*
    Typed email rather than a confirm dialog, for the same reason the clinic
    danger zone asks for a slug: the second confirm dialog in a session is not
    read. Compared case-insensitively because the address is stored that way —
    `users_email_key` is a unique index on `lower(email)`.
  */
  const typed = confirmEmail.trim().toLowerCase();

  /*
    System connection, not `inClinic`.

    This is the one operation whose blast radius is deliberately wider than the
    tenant: a user may be a member of several clinics, and RLS scopes writes to
    the one whose id is set. Under `inClinic` the delete would either be refused
    or, worse, silently affect nothing while reporting success.
  */
  return withSystem(async (c) => {
    const me = (
      await c.query(
        `select u.email,
                (select count(*) from clinic_members m
                  where m.user_id = u.id and m.is_owner)::int as owns
           from users u where u.id = $1`,
        [userId]
      )
    ).rows[0] as { email: string; owns: number } | undefined;

    if (!me) return { error: "email_mismatch" as const };
    if (me.email.trim().toLowerCase() !== typed) return { error: "email_mismatch" as const };
    // Owning anything at all is disqualifying, not just owning this workspace.
    if (me.owns > 0) return { error: "owner" as const };

    /*
      Audited before the delete, and with `user_id` left null.

      `audit_log.user_id` is `on delete set null`, so filing this against the
      account would blank the actor the moment the delete lands and leave a row
      that records an erasure without recording whose. The address goes in the
      payload instead, which is the one place it is legitimate to keep it: the
      record that it was erased is the evidence the request was honoured.
    */
    await c.query(
      `insert into audit_log (clinic_id, user_id, action, entity, entity_id, detail)
       values ($1, null, 'user.self_delete', 'user', $2, $3)`,
      [access.clinicId, userId, JSON.stringify({ email: me.email, slug })]
    );

    await c.query(`delete from users where id = $1`, [userId]);
    return {};
  }).then(async (r) => {
    // The cascade already dropped every session row; this clears the cookie so
    // the next request is a clean sign-in rather than a lookup that finds nothing.
    if (!r.error) await destroySession();
    return r;
  });
}
