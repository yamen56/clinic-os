import { notFound, redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { loadDocumentList } from "@/lib/esign/queries";
import { PatientProfile } from "./profile-client";

export default async function PatientProfilePage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  const access = await guardClinic(slug);

  const data = await inClinic(access, async (c) => {
    const p = (
      await c.query(`select * from patients where id = $1 and clinic_id = $2`, [id, access.clinicId])
    ).rows[0];
    if (!p) return null;
    if (p.merged_into) return { mergedInto: p.merged_into as string };

    const [notes, files, appointments, invoices, conversation, defs, activity, balance, documents, templates] =
      await Promise.all([
        c.query(
          `select n.id, n.kind, n.body, n.created_at, u.full_name as author
           from patient_notes n left join users u on u.id = n.author_id
           where n.patient_id = $1 and n.clinic_id = $2 order by n.created_at desc limit 100`,
          [id, access.clinicId]
        ),
        c.query(
          `select id, file_name, mime_type, size_bytes, kind, created_at
           from patient_files where patient_id = $1 and clinic_id = $2 order by created_at desc`,
          [id, access.clinicId]
        ),
        c.query(
          `select a.id, a.starts_at, a.ends_at, a.status, a.source, s.name as service_name, s.name_ar as service_name_ar,
                  u.full_name as doctor_name
           from appointments a
           left join services s on s.id = a.service_id
           left join clinic_members m on m.id = a.doctor_member_id
           left join users u on u.id = m.user_id
           where a.patient_id = $1 and a.clinic_id = $2 order by a.starts_at desc limit 50`,
          [id, access.clinicId]
        ),
        c.query(
          `select id, number, status, total, amount_paid, created_at
           from invoices where patient_id = $1 and clinic_id = $2 order by created_at desc limit 50`,
          [id, access.clinicId]
        ),
        c.query(
          `select cv.id,
                  (select json_agg(x) from (
                     select m.id, m.direction, m.sender_kind, m.body, m.msg_type, m.created_at
                     from messages m where m.conversation_id = cv.id order by m.created_at desc limit 30
                  ) x) as msgs
           from conversations cv where cv.patient_id = $1 and cv.clinic_id = $2
           order by cv.last_message_at desc nulls last limit 1`,
          [id, access.clinicId]
        ),
        // The clinic's own field definitions drive this form, the template
        // variable picker and the document preview from one place, so a field
        // renamed in settings is renamed here without a second thought.
        c.query(
          `select id, key, label, label_ar, field_type, options, is_required,
                  storage_key, source_column
           from patient_field_definitions
           where clinic_id = $1 and scope = 'patient' and not hidden and show_in_profile
           order by display_order, label`,
          [access.clinicId]
        ),
        c.query(
          `select al.action, al.created_at, al.detail, u.full_name as actor
           from audit_log al left join users u on u.id = al.user_id
           where al.clinic_id = $1 and al.entity = 'patient' and al.entity_id = $2
           order by al.created_at desc limit 15`,
          [access.clinicId, id]
        ),
        c.query(
          `select coalesce(sum(total - amount_paid), 0) as due from invoices
           where patient_id = $1 and clinic_id = $2 and status in ('sent', 'partially_paid')`,
          [id, access.clinicId]
        ),
        loadDocumentList(c, access.clinicId, { patientId: id }),
        c.query(
          `select id, name, name_ar, category, language from document_templates
           where clinic_id = $1 and is_active order by category, name`,
          [access.clinicId]
        ),
      ]);

    return {
      patient: p,
      notes: notes.rows,
      files: files.rows,
      appointments: appointments.rows,
      invoices: invoices.rows,
      conversation: conversation.rows[0] ?? null,
      defs: defs.rows,
      activity: activity.rows,
      balanceDue: Number(balance.rows[0].due),
      documents,
      templates: templates.rows,
    };
  });

  if (!data) notFound();
  if ("mergedInto" in data && data.mergedInto) redirect(`/c/${slug}/patients/${data.mergedInto}`);
  const d = data as Exclude<typeof data, { mergedInto: string }>;

  return (
    <PatientProfile
      slug={slug}
      tz={access.clinic.timezone}
      currency={access.clinic.currency}
      balanceDue={d.balanceDue}
      patient={JSON.parse(JSON.stringify(d.patient))}
      notes={JSON.parse(JSON.stringify(d.notes))}
      files={JSON.parse(JSON.stringify(d.files))}
      appointments={JSON.parse(JSON.stringify(d.appointments))}
      invoices={JSON.parse(JSON.stringify(d.invoices))}
      conversation={d.conversation ? JSON.parse(JSON.stringify(d.conversation)) : null}
      defs={JSON.parse(JSON.stringify(d.defs))}
      activity={JSON.parse(JSON.stringify(d.activity))}
      documents={JSON.parse(JSON.stringify(d.documents))}
      docTemplates={JSON.parse(JSON.stringify(d.templates))}
      canSendDocuments={access.role !== "doctor"}
    />
  );
}
