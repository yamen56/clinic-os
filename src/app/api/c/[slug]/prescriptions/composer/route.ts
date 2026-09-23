import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { systemMessageDef } from "@/lib/system-messages";

/**
 * Everything the prescription composer needs before the doctor types a letter.
 *
 * The prescribers, the clinic's medicine list, its templates and the caption
 * wording, in one statement — the page asks for this while it is idle, so the
 * composer opens already knowing them and the autocomplete filters in the
 * browser with nothing to wait for per keystroke.
 *
 * A prescriber is a doctor, or the clinic's owner: the owner is usually the
 * dentist who owns the practice and is filed as "other" until they change it.
 * The action checks the same rule again, since this list is only a menu.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "patients.prescriptions");
  if (!g.ok) return g.res;
  const { access } = g;
  const patientId = new URL(req.url).searchParams.get("patient");
  const uuid = /^[0-9a-f-]{36}$/i;

  const row = await inClinic(access, async (c) => {
    const r = await c.query(
      `select
         (select coalesce(json_agg(d order by d.is_doctor desc, d.name), '[]'::json) from (
            select m.id as member_id, u.full_name as name, m.role = 'doctor' as is_doctor,
                   m.user_id = $2 as is_me,
                   u.signature_png_path is not null as has_signature
              from clinic_members m join users u on u.id = m.user_id
             where m.clinic_id = $1 and m.active and (m.role = 'doctor' or m.is_owner)
         ) d) as doctors,
         (select coalesce(json_agg(x order by x.use_count desc, x.name), '[]'::json) from (
            select id, name, dose, frequency, duration, instructions, use_count, hidden
              from medications where clinic_id = $1
             order by use_count desc limit 2000
         ) x) as medications,
         (select coalesce(json_agg(t order by t.use_count desc, t.name), '[]'::json) from (
            select id, name, diagnosis, items, locale, use_count
              from prescription_templates where clinic_id = $1
         ) t) as templates,
         -- Who saw this patient last: the likeliest prescriber when the person
         -- writing is the assistant rather than the doctor.
         (select a.doctor_member_id from appointments a
           where a.clinic_id = $1 and a.patient_id = $3 and a.doctor_member_id is not null
             and a.starts_at <= now() + interval '12 hours'
           order by a.starts_at desc limit 1) as last_doctor,
         (select row_to_json(s) from (
            select body_ar, body_en from clinic_system_messages
             where clinic_id = $1 and key = 'prescription_sent'
         ) s) as caption,
         cl.name as clinic_name, cl.name_ar as clinic_name_ar, cl.default_locale, cl.timezone
       from clinics cl where cl.id = $1`,
      [access.clinicId, access.session.user.id, patientId && uuid.test(patientId) ? patientId : null]
    );
    return r.rows[0];
  });
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // The clinic's own wording where it has changed it, the default where not —
  // the same layering the send applies, so the preview is what goes out.
  const def = systemMessageDef("prescription_sent")!;
  const override = (row.caption ?? {}) as { body_ar?: string | null; body_en?: string | null };

  return NextResponse.json(
    {
      doctors: row.doctors,
      medications: row.medications,
      templates: row.templates,
      lastDoctor: row.last_doctor,
      captions: {
        ar: override.body_ar?.trim() ? override.body_ar : def.ar,
        en: override.body_en?.trim() ? override.body_en : def.en,
      },
      clinic: {
        name: row.clinic_name,
        nameAr: row.clinic_name_ar,
        defaultLocale: row.default_locale === "en" ? "en" : "ar",
        timezone: row.timezone,
      },
    },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
