import type { PoolClient } from "pg";

/**
 * Rooms: the second thing an appointment takes, after a doctor.
 *
 * Relative imports only — the worker imports this through slots.ts and the AI
 * receptionist, and it cannot resolve `@/`.
 *
 * Every function that answers "is it free" assumes the caller already holds
 * lockClinicSchedule: the answer is only still true at insert time if nothing
 * else could book in between.
 */

export type Room = {
  id: string;
  name: string;
  name_ar: string | null;
  color: string;
  sort: number;
  /** Services this room can host. Empty = any service. */
  serviceIds: string[];
};

/** What occupies a room in a window: an active appointment with a room. */
export type RoomBusy = { id?: string; room_id: string | null; starts_at: Date | string; ends_at: Date | string };

/** The statuses that hold a slot — the same rule as for doctors. */
export const HOLDS_SLOT = `('pending_approval', 'scheduled', 'confirmed')`;

export async function loadActiveRooms(c: PoolClient, clinicId: string): Promise<Room[]> {
  const r = await c.query(
    `select r.id, r.name, r.name_ar, r.color, r.sort,
            coalesce((select array_agg(rs.service_id::text) from clinic_room_services rs where rs.room_id = r.id), '{}') as service_ids
       from clinic_rooms r
      where r.clinic_id = $1 and r.active
      order by r.sort, r.name`,
    [clinicId]
  );
  return r.rows.map((x) => ({
    id: x.id,
    name: x.name,
    name_ar: x.name_ar,
    color: x.color,
    sort: x.sort,
    serviceIds: x.service_ids ?? [],
  }));
}

/**
 * The rooms that can host this service.
 *
 * Empty means the booking is not limited by rooms at all: the clinic has none,
 * the service is online, or no room offers it. That last case is deliberate —
 * one room restricted to X-rays must not quietly make every other service
 * unbookable online. The Rooms page warns about services no room offers.
 *
 * No service (a staff booking that names none) can go in any room: nobody
 * said what it is, so nothing rules a room out.
 */
export function suitableRooms(rooms: Room[], serviceId: string | null, locationKind: string | null): Room[] {
  if (!rooms.length || locationKind === "online") return [];
  if (!serviceId) return rooms;
  return rooms.filter((r) => r.serviceIds.length === 0 || r.serviceIds.includes(serviceId));
}

const ms = (d: Date | string) => (d instanceof Date ? d.getTime() : Date.parse(d));

/**
 * The first suitable room with nothing booked over [start, end), trying the
 * preferred rooms first. Pure — slots.ts runs it per candidate slot over rows
 * it loaded once.
 */
export function freeRoom(
  suitable: Room[],
  busy: RoomBusy[],
  startMs: number,
  endMs: number,
  prefer: (string | null | undefined)[] = []
): string | null {
  if (!suitable.length) return null;
  const order = [
    ...prefer.filter((p): p is string => !!p && suitable.some((r) => r.id === p)),
    ...suitable.map((r) => r.id),
  ];
  const tried = new Set<string>();
  for (const id of order) {
    if (tried.has(id)) continue;
    tried.add(id);
    const taken = busy.some((b) => b.room_id === id && startMs < ms(b.ends_at) && endMs > ms(b.starts_at));
    if (!taken) return id;
  }
  return null;
}

export type PickResult = { roomId: string | null; reason: "picked" | "unconstrained" | "none_free" };

/**
 * Picks a room for a booking. Caller holds lockClinicSchedule.
 *
 * Preference: the room asked for → the doctor's usual room → the room the
 * doctor is already working in nearest that time → the clinic's own order. A
 * doctor who spends the morning in Room 2 stays in Room 2 for the afternoon
 * unless it is taken, rather than being sent across the corridor because Room 1
 * sorts first.
 */
export async function pickRoom(
  c: PoolClient,
  o: {
    clinicId: string;
    serviceId: string | null;
    doctorMemberId: string | null;
    startsAt: string;
    endsAt: string;
    excludeId?: string;
    preferRoomId?: string | null;
    /** Already loaded by the caller, to save the read. */
    rooms?: Room[];
    locationKind?: string | null;
  }
): Promise<PickResult> {
  const rooms = o.rooms ?? (await loadActiveRooms(c, o.clinicId));
  if (!rooms.length) return { roomId: null, reason: "unconstrained" };
  const locationKind =
    o.locationKind !== undefined
      ? o.locationKind
      : o.serviceId
        ? (((await c.query(`select location_kind from services where id = $1 and clinic_id = $2`, [o.serviceId, o.clinicId])).rows[0]
            ?.location_kind as string | undefined) ?? null)
        : null;
  const suitable = suitableRooms(rooms, o.serviceId, locationKind);
  if (!suitable.length) return { roomId: null, reason: "unconstrained" };

  const prefer: (string | null)[] = [o.preferRoomId ?? null];
  if (o.doctorMemberId) {
    const r = (
      await c.query(
        `select cm.default_room_id,
                (select a.room_id from appointments a
                  where a.clinic_id = cm.clinic_id and a.doctor_member_id = cm.id and a.room_id is not null
                    and a.status in ${HOLDS_SLOT}
                    and a.starts_at between $3::timestamptz - interval '12 hours' and $3::timestamptz + interval '12 hours'
                    and ($4::uuid is null or a.id <> $4)
                  order by abs(extract(epoch from a.starts_at - $3::timestamptz)) limit 1) as near_room
           from clinic_members cm where cm.id = $1 and cm.clinic_id = $2`,
        [o.doctorMemberId, o.clinicId, o.startsAt, o.excludeId ?? null]
      )
    ).rows[0];
    if (r) prefer.push(r.default_room_id, r.near_room);
  }

  const busy = (
    await c.query(
      `select id, room_id, starts_at, ends_at from appointments
        where clinic_id = $1 and room_id = any($2::uuid[]) and status in ${HOLDS_SLOT}
          and starts_at < $4 and ends_at > $3 and ($5::uuid is null or id <> $5)`,
      [o.clinicId, suitable.map((r) => r.id), o.startsAt, o.endsAt, o.excludeId ?? null]
    )
  ).rows as RoomBusy[];

  const id = freeRoom(suitable, busy, Date.parse(o.startsAt), Date.parse(o.endsAt), prefer);
  return id ? { roomId: id, reason: "picked" } : { roomId: null, reason: "none_free" };
}

/** Another active appointment in this room over [start, end), and whose it is. */
export async function roomConflict(
  c: PoolClient,
  clinicId: string,
  roomId: string,
  startsAt: string,
  endsAt: string,
  excludeId?: string
): Promise<{ id: string; patient: string } | null> {
  const r = await c.query(
    `select a.id, p.full_name as patient from appointments a
       join patients p on p.id = a.patient_id
      where a.clinic_id = $1 and a.room_id = $2 and a.status in ${HOLDS_SLOT}
        and a.starts_at < $4 and a.ends_at > $3
        and ($5::uuid is null or a.id <> $5)
      limit 1`,
    [clinicId, roomId, startsAt, endsAt, excludeId ?? null]
  );
  return r.rows[0] ?? null;
}

/**
 * Who is in this room right now: seated, not finished.
 *
 * What is happening beats what was planned, so seating checks this rather than
 * the schedule. Twelve hours bounds it, so a patient nobody pressed Finish on
 * yesterday does not hold the room forever.
 */
export async function roomOccupant(
  c: PoolClient,
  clinicId: string,
  roomId: string,
  excludeId?: string
): Promise<{ id: string; patient: string } | null> {
  const r = await c.query(
    `select a.id, p.full_name as patient from appointments a
       join patients p on p.id = a.patient_id
      where a.clinic_id = $1 and a.room_id = $2 and a.status in ${HOLDS_SLOT}
        and a.seated_at is not null and a.finished_at is null
        and a.seated_at > now() - interval '12 hours'
        and ($3::uuid is null or a.id <> $3)
      limit 1`,
    [clinicId, roomId, excludeId ?? null]
  );
  return r.rows[0] ?? null;
}
