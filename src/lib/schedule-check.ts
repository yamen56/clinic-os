import type { PoolClient } from "pg";
import { lockClinicSchedule } from "./appointments";
import { loadActiveRooms, pickRoom, roomConflict, suitableRooms, HOLDS_SLOT } from "./rooms";

export type ScheduleError = "conflict" | "room_conflict" | "no_room" | "bad_room";

export type ScheduleAnswer = {
  error?: ScheduleError;
  /** Whose appointment is in the way. */
  conflictWith?: string;
  roomId: string | null;
  roomName?: string;
  /** Kept the time but not the room — the toast says where it went. */
  roomChanged?: boolean;
};

/**
 * Is this time free for this doctor, and which room does it take?
 *
 * Staff-side: the calendar's create, edit and drag, and the desk's walk-in.
 * Takes lockClinicSchedule first and holds it until the transaction commits,
 * so the answer is still true when the caller writes.
 *
 * `roomId`:
 *  - a string — exactly that room; busy is a `room_conflict` naming who has it.
 *  - null — pick one.
 *  - undefined — keep `currentRoomId` while it is still free and still suits
 *    the service, otherwise pick another and say so (`roomChanged`). A drag
 *    should not fail because the room was taken when another one is free.
 *
 * Rooms only come into it when the clinic has some that can host the service
 * (see suitableRooms); otherwise `roomId` comes back null and nothing changes.
 */
export async function scheduleCheck(
  c: PoolClient,
  clinicId: string,
  o: {
    doctorMemberId: string | null;
    serviceId: string | null;
    startsAt: string;
    endsAt: string;
    excludeId?: string;
    roomId: string | null | undefined;
    currentRoomId?: string | null;
  }
): Promise<ScheduleAnswer> {
  await lockClinicSchedule(c, clinicId);
  if (o.doctorMemberId) {
    const r = await c.query(
      `select a.id, p.full_name as patient from appointments a
       join patients p on p.id = a.patient_id
       where a.clinic_id = $1 and a.doctor_member_id = $2
         and a.status in ${HOLDS_SLOT}
         and a.starts_at < $4 and a.ends_at > $3
         and ($5::uuid is null or a.id <> $5)
       limit 1`,
      [clinicId, o.doctorMemberId, o.startsAt, o.endsAt, o.excludeId ?? null]
    );
    if (r.rows[0]) return { error: "conflict", conflictWith: r.rows[0].patient, roomId: null };
  }

  const rooms = await loadActiveRooms(c, clinicId);
  if (!rooms.length) return { roomId: null };
  const nameOf = (id: string | null) => rooms.find((r) => r.id === id)?.name;

  // Exactly the room asked for. Staff may put a visit in a room its service
  // does not list — they know the clinic — but not in somebody else's slot.
  if (typeof o.roomId === "string") {
    if (!rooms.some((r) => r.id === o.roomId)) return { error: "bad_room", roomId: null };
    const taken = await roomConflict(c, clinicId, o.roomId, o.startsAt, o.endsAt, o.excludeId);
    if (taken) return { error: "room_conflict", conflictWith: taken.patient, roomId: null };
    return { roomId: o.roomId, roomName: nameOf(o.roomId) };
  }

  const locationKind = o.serviceId
    ? (((await c.query(`select location_kind from services where id = $1 and clinic_id = $2`, [o.serviceId, clinicId])).rows[0]
        ?.location_kind as string | undefined) ?? null)
    : null;
  const suitable = suitableRooms(rooms, o.serviceId, locationKind);
  if (!suitable.length) return { roomId: null };

  // Keep the room it already has, if that still works.
  if (o.roomId === undefined && o.currentRoomId && suitable.some((r) => r.id === o.currentRoomId)) {
    const taken = await roomConflict(c, clinicId, o.currentRoomId, o.startsAt, o.endsAt, o.excludeId);
    if (!taken) return { roomId: o.currentRoomId, roomName: nameOf(o.currentRoomId) };
  }

  const pick = await pickRoom(c, {
    clinicId,
    serviceId: o.serviceId,
    doctorMemberId: o.doctorMemberId,
    startsAt: o.startsAt,
    endsAt: o.endsAt,
    excludeId: o.excludeId,
    rooms,
    locationKind,
  });
  if (pick.reason === "none_free") return { error: "no_room", roomId: null };
  return {
    roomId: pick.roomId,
    roomName: nameOf(pick.roomId),
    roomChanged: o.roomId === undefined && !!o.currentRoomId && pick.roomId !== o.currentRoomId,
  };
}
