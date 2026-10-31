import type { PoolClient } from "pg";

/**
 * What a clinic has to set up before the platform works for it, read from what
 * it has actually done — never ticked by hand.
 *
 * "Setup is confusing" (Yamen, 2026-10-31): nineteen settings tabs and nothing
 * saying which matter first. These are the ones that do, in the order a clinic
 * meets them, each pointing at the exact page that completes it. The owner sees
 * it on the dashboard until it is done; the agency sees the same list on the
 * clinic's admin page, which is how the old "automations enabled" item — done
 * from day one, because the welcome flow is — stopped lying.
 */
export const SETUP_KEYS = ["details", "services", "team", "whatsapp", "booking", "reminders", "patients"] as const;
export type SetupKey = (typeof SETUP_KEYS)[number];

export type SetupItem = { key: SetupKey; done: boolean; /** Under /c/<slug>. */ path: string };

const PATHS: Record<SetupKey, string> = {
  details: "/settings",
  services: "/settings/services",
  team: "/settings/staff",
  whatsapp: "/settings/whatsapp",
  booking: "/settings/booking",
  reminders: "/automations",
  patients: "/patients/import",
};

export async function setupChecklist(c: PoolClient, clinicId: string): Promise<SetupItem[]> {
  const r = (
    await c.query(
      `select
         -- The clinic's face and where it is: on every invoice, booking page and form.
         (cl.logo_path is not null or cl.brand_color <> '#0f6e5c') and coalesce(nullif(cl.address, ''), nullif(cl.address_ar, '')) is not null as details,
         -- Something to book, at a price.
         exists (select 1 from services s where s.clinic_id = cl.id and s.active and s.price > 0) as services,
         -- A doctor to book it with.
         exists (select 1 from clinic_members m where m.clinic_id = cl.id and m.active and m.role = 'doctor') as team,
         coalesce((select ws.status = 'connected' from whatsapp_sessions ws where ws.clinic_id = cl.id), false) as whatsapp,
         exists (select 1 from booking_links b where b.clinic_id = cl.id and b.active) as booking,
         -- The day-before reminder, or a flow of the clinic's own before appointments.
         exists (select 1 from automations a where a.clinic_id = cl.id and a.active and a.trigger_type = 'before_appointment') as reminders,
         exists (select 1 from patients p where p.clinic_id = cl.id and p.merged_into is null) as patients
       from clinics cl where cl.id = $1`,
      [clinicId]
    )
  ).rows[0];
  return SETUP_KEYS.map((key) => ({ key, done: !!r?.[key], path: PATHS[key] }));
}
