"use server";

import { revalidatePath } from "next/cache";
import { can, requireClinic } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { lockClinicSchedule } from "@/lib/appointments";
import { loadActiveRooms, pickRoom } from "@/lib/rooms";
import { isUuid } from "@/lib/uuid";

/**
 * The clinic's rooms (migration 0078).
 *
 * Managed by whoever manages services: which room hosts which service is the
 * same kind of decision as which doctor performs it, and the reception desk
 * that keeps the service list is the one that knows Room 2's chair is broken.
 */

const clean = (s: string | null | undefined, n = 60) => (s ?? "").trim().replace(/\s+/g, " ").slice(0, n);

export async function saveRoomAction(
  slug: string,
  input: { id?: string; name: string; nameAr?: string | null; color: string; serviceIds: string[] }
): Promise<{ id?: string; error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings.services")) return { error: "forbidden" };
  const name = clean(input.name);
  if (!name) return { error: "invalid" };
  const nameAr = clean(input.nameAr) || null;
  const color = /^#[0-9a-fA-F]{6}$/.test(input.color) ? input.color : "#4a6b8a";
  const serviceIds = [...new Set((input.serviceIds ?? []).filter((x) => isUuid(x)))].slice(0, 200);
  if (input.id && !isUuid(input.id)) return { error: "not_found" };

  return inClinic(access, async (c) => {
    const dup = await c.query(
      `select 1 from clinic_rooms where clinic_id = $1 and active and lower(name) = lower($2) and ($3::uuid is null or id <> $3)`,
      [access.clinicId, name, input.id ?? null]
    );
    if (dup.rowCount) return { error: "duplicate" };

    let id = input.id;
    if (id) {
      // Saving bumps updated_at even when only the services changed: that is
      // the event the board hears (the join table has no realtime trigger).
      const r = await c.query(
        `update clinic_rooms set name = $3, name_ar = $4, color = $5, updated_at = now()
          where id = $1 and clinic_id = $2 and active returning id`,
        [id, access.clinicId, name, nameAr, color]
      );
      if (!r.rowCount) return { error: "not_found" };
    } else {
      const r = await c.query(
        `insert into clinic_rooms (clinic_id, name, name_ar, color, sort)
         values ($1, $2, $3, $4, coalesce((select max(sort) + 1 from clinic_rooms where clinic_id = $1 and active), 0))
         returning id`,
        [access.clinicId, name, nameAr, color]
      );
      id = r.rows[0].id as string;
    }

    // Only this clinic's services; an id from anywhere else is dropped.
    await c.query(`delete from clinic_room_services where room_id = $1`, [id]);
    if (serviceIds.length) {
      await c.query(
        `insert into clinic_room_services (room_id, service_id, clinic_id)
         select $1, s.id, $2 from services s where s.id = any($3::uuid[]) and s.clinic_id = $2
         on conflict do nothing`,
        [id, access.clinicId, serviceIds]
      );
    }
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: input.id ? "room.update" : "room.create",
      entity: "clinic_room",
      entityId: id,
      detail: { name, services: serviceIds.length },
    });
    revalidatePath(`/c/${slug}/settings/rooms`);
    return { id };
  });
}

export async function moveRoomAction(slug: string, id: string, dir: -1 | 1): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings.services")) return { error: "forbidden" };
  if (!isUuid(id)) return { error: "not_found" };
  return inClinic(access, async (c) => {
    const rows = (
      await c.query(`select id from clinic_rooms where clinic_id = $1 and active order by sort, name`, [access.clinicId])
    ).rows.map((r) => r.id as string);
    const i = rows.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= rows.length) return {};
    [rows[i], rows[j]] = [rows[j], rows[i]];
    await c.query(
      `update clinic_rooms r set sort = x.ord - 1
         from unnest($2::uuid[]) with ordinality as x(id, ord)
        where r.id = x.id and r.clinic_id = $1`,
      [access.clinicId, rows]
    );
    revalidatePath(`/c/${slug}/settings/rooms`);
    return {};
  });
}

/**
 * Takes a room out of use. Not a delete: past visits keep the room they were
 * in. Upcoming ones keep their time and doctor but stop holding it — they show
 * up as "not in a room" and can be placed again.
 */
export async function removeRoomAction(slug: string, id: string): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings.services")) return { error: "forbidden" };
  if (!isUuid(id)) return { error: "not_found" };
  return inClinic(access, async (c) => {
    const r = await c.query(`update clinic_rooms set active = false where id = $1 and clinic_id = $2 returning name`, [
      id,
      access.clinicId,
    ]);
    if (!r.rowCount) return { error: "not_found" };
    await c.query(`update clinic_members set default_room_id = null where clinic_id = $1 and default_room_id = $2`, [
      access.clinicId,
      id,
    ]);
    await c.query(
      `update appointments set room_id = null
        where clinic_id = $1 and room_id = $2 and starts_at > now()
          and status in ('pending_approval', 'scheduled', 'confirmed') and seated_at is null`,
      [access.clinicId, id]
    );
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "room.remove",
      entity: "clinic_room",
      entityId: id,
      detail: { name: r.rows[0].name },
    });
    revalidatePath(`/c/${slug}/settings/rooms`);
    return {};
  });
}

export async function setDoctorRoomAction(
  slug: string,
  memberId: string,
  roomId: string | null
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings.services")) return { error: "forbidden" };
  if (!isUuid(memberId) || (roomId !== null && !isUuid(roomId))) return { error: "not_found" };
  return inClinic(access, async (c) => {
    if (roomId) {
      const ok = await c.query(`select 1 from clinic_rooms where id = $1 and clinic_id = $2 and active`, [
        roomId,
        access.clinicId,
      ]);
      if (!ok.rowCount) return { error: "not_found" };
    }
    const r = await c.query(
      `update clinic_members set default_room_id = $3 where id = $1 and clinic_id = $2 and role = 'doctor'`,
      [memberId, access.clinicId, roomId]
    );
    if (!r.rowCount) return { error: "not_found" };
    revalidatePath(`/c/${slug}/settings/rooms`);
    return {};
  });
}

/**
 * Gives a room to every upcoming visit that was booked before the clinic had
 * rooms. Until then those visits block nothing, so a new booking could land in
 * a room somebody is already booked into. Earliest first, under the schedule
 * lock, through the same picker a new booking uses — so a doctor's usual room
 * wins where it is free. What cannot be placed is reported, not forced.
 */
export async function placeUpcomingAction(slug: string): Promise<{ placed?: number; notPlaced?: number; error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings.services")) return { error: "forbidden" };
  return inClinic(access, async (c) => {
    await lockClinicSchedule(c, access.clinicId);
    const rooms = await loadActiveRooms(c, access.clinicId);
    if (!rooms.length) return { placed: 0, notPlaced: 0 };
    const rows = (
      await c.query(
        `select a.id, a.doctor_member_id, a.service_id, a.starts_at, a.ends_at, s.location_kind
           from appointments a left join services s on s.id = a.service_id
          where a.clinic_id = $1 and a.room_id is null and a.starts_at > now()
            and a.status in ('pending_approval', 'scheduled', 'confirmed')
            and coalesce(s.location_kind, 'in_person') <> 'online'
          order by a.starts_at
          limit 1000`,
        [access.clinicId]
      )
    ).rows;
    let placed = 0;
    let notPlaced = 0;
    for (const a of rows) {
      const pick = await pickRoom(c, {
        clinicId: access.clinicId,
        serviceId: a.service_id,
        doctorMemberId: a.doctor_member_id,
        startsAt: new Date(a.starts_at).toISOString(),
        endsAt: new Date(a.ends_at).toISOString(),
        excludeId: a.id,
        rooms,
        locationKind: a.location_kind ?? null,
      });
      if (pick.reason === "none_free") notPlaced++;
      else if (pick.roomId) {
        await c.query(`update appointments set room_id = $2 where id = $1`, [a.id, pick.roomId]);
        placed++;
      }
    }
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "room.place_upcoming",
      entity: "clinic",
      entityId: access.clinicId,
      detail: { placed, notPlaced },
    });
    revalidatePath(`/c/${slug}/settings/rooms`);
    return { placed, notPlaced };
  });
}
