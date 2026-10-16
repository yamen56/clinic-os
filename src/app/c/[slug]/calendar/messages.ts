import type { Dict } from "@/lib/i18n/en";

/** What a failed save says — the same words from the panel, a drag, and the board. */
export function scheduleErrorText(t: Dict, r: { error?: string; conflictWith?: string }): string {
  const who = r.conflictWith ? ` (${r.conflictWith})` : "";
  switch (r.error) {
    case "conflict":
      return `${t.calendar.conflict}${who}`;
    case "room_conflict":
      return `${t.calendar.roomConflict}${who}`;
    case "no_room":
      return t.calendar.noRoom;
    case "bad_room":
      return t.calendar.badRoom;
    case "patient_required":
      return t.common.required;
    default:
      return t.common.genericError;
  }
}

/** What a successful save says, naming the room when it moved. */
export function savedText(t: Dict, base: string, r: { roomChanged?: boolean; roomName?: string }): string {
  return r.roomChanged && r.roomName ? `${base} · ${t.calendar.movedRoom.replace("{room}", r.roomName)}` : base;
}
