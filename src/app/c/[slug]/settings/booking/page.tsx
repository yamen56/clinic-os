import { guardCap } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { loadBookingQuestions } from "@/lib/booking-intake";
import { BookingLinksClient } from "./booking-client";
import { can } from "@/lib/auth";

export default async function BookingSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await guardCap(slug, "settings");
  const data = await inClinic(access, async (c) => {
    const links = (
      await c.query(
        `select id, name, slug, doctor_member_id, service_ids, min_notice_min, max_days_ahead,
                slot_granularity_min, approval_mode, active, headline, headline_ar, intro, intro_ar,
                success_note, success_note_ar, show_prices, allow_any_doctor,
                consent_text, consent_text_ar, require_consent
         from booking_links where clinic_id = $1 order by created_at`,
        [access.clinicId]
      )
    ).rows;
    const doctors = (
      await c.query(
        `select cm.id, u.full_name as name from clinic_members cm join users u on u.id = cm.user_id
         where cm.clinic_id = $1 and cm.role = 'doctor' and cm.active order by u.full_name`,
        [access.clinicId]
      )
    ).rows;
    const services = (
      await c.query(
        `select id, name, name_ar from services where clinic_id = $1 and active order by sort, name`,
        [access.clinicId]
      )
    ).rows;
    // Switched-off questions are listed too — the screen has to show one in
    // order to switch it back on.
    const questions = await loadBookingQuestions(c, access.clinicId, { includeInactive: true });
    /*
      The patient fields a question may be mapped onto. Only `patient` scope:
      the context fields (clinic name, today's date) are resolved by the
      platform, and offering them here would promise a write that never happens.
    */
    const patientFields = (
      await c.query(
        `select key, label, label_ar from patient_field_definitions
         where clinic_id = $1 and scope = 'patient' and not hidden
           and key not in ('patient.full_name', 'patient.phone')
         order by display_order, label`,
        [access.clinicId]
      )
    ).rows;
    return { links, doctors, services, questions, patientFields };
  });

  return (
    <BookingLinksClient
      slug={slug}
      canEdit={can(access, "settings")}
      links={JSON.parse(JSON.stringify(data.links))}
      doctors={JSON.parse(JSON.stringify(data.doctors))}
      services={JSON.parse(JSON.stringify(data.services))}
      questions={JSON.parse(JSON.stringify(data.questions))}
      patientFields={JSON.parse(JSON.stringify(data.patientFields))}
    />
  );
}
