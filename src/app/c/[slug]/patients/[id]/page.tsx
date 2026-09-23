import { notFound, redirect } from "next/navigation";
import { guardCap } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { loadDocumentList } from "@/lib/esign/queries";
import { PatientProfile } from "./profile-client";
import { can } from "@/lib/auth";
import { invoiceScopeSql } from "@/lib/invoice-scope";
import { countryFromClinic } from "@/lib/phone";
import { PATIENT_PRESCRIPTIONS_JSON } from "@/lib/prescriptions";

export default async function PatientProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { slug, id } = await params;
  // A notification can open the file on a tab — "a prescription was sent in
  // your name" lands on the prescriptions, not the overview.
  const { tab } = await searchParams;
  const access = await guardCap(slug, "patients");
  /*
    The patient's own invoices, filtered the same way the invoice list is.

    This is the least comfortable place the filter lands, and it is here on
    purpose: without it the file would list an invoice that redirects when you
    click it, because `/invoices/[id]` is filtered. The cost is real — a doctor
    no longer sees that their patient still owes for a colleague's work — and if
    that turns out to matter more at the desk than the filter does, these are
    the two queries to unscope.
  */
  const invScope = invoiceScopeSql(access, "i", 3);

  /*
    The sections of the app this member is allowed into, decided once here and
    obeyed twice: the queries below skip what they may not see, and the client
    hides the tab and the button that would have led there.

    Both halves matter, and the query half matters more. Hiding a tab while
    still shipping the rows means the patient's invoice totals are sitting in
    the page payload of somebody who was deliberately denied Invoices, which is
    the same leak with a nicer paint job.
  */
  const caps = {
    conversations: can(access, "conversations"),
    calendar: can(access, "calendar"),
    documents: can(access, "documents"),
    invoices: can(access, "invoices"),
    exportPatient: can(access, "patients.export"),
    manageCategories: can(access, "patients.categories"),
    /** Write, send and repeat. Reading the ones already written is `patients`. */
    prescriptions: can(access, "patients.prescriptions"),
  };
  const none = { rows: [] as Record<string, unknown>[] };

  const data = await inClinic(access, async (c) => {
    /*
      The prescriptions ride inside this select rather than as another query
      below: everything here shares one connection, where each statement is a
      round trip in series whatever Promise.all suggests.
    */
    const row = (
      await c.query(
        `select p.*, ${PATIENT_PRESCRIPTIONS_JSON} as __prescriptions
           from patients p where p.id = $1 and p.clinic_id = $2`,
        [id, access.clinicId]
      )
    ).rows[0];
    if (!row) return null;
    const { __prescriptions: prescriptions, ...p } = row;
    if (p.merged_into) return { mergedInto: p.merged_into as string };

    const [notes, files, appointments, invoices, conversation, defs, activity, balance, documents, templates, clinicTags, insurers, noteCategories] =
      await Promise.all([
        c.query(
          /*
            Every column qualified, across the joins to users, appointments and
            services alike — all of those tables carry a `created_at`, and a bare
            one here is the ambiguity that once took down the template editor.
          */
          `select n.id, n.body, n.category_id, n.created_at, n.edited_at,
                  n.audio_path, n.audio_mime, n.audio_seconds,
                  u.full_name as author, e.full_name as edited_by_name,
                  (select count(*)::int from patient_note_versions v where v.note_id = n.id) as version_count,
                  n.appointment_id,
                  a.starts_at as appointment_starts_at,
                  s.name as appointment_service, s.name_ar as appointment_service_ar
           from patient_notes n
           left join users u on u.id = n.author_id
           left join users e on e.id = n.edited_by
           left join appointments a on a.id = n.appointment_id
           left join services s on s.id = a.service_id
           where n.patient_id = $1 and n.clinic_id = $2 order by n.created_at desc limit 100`,
          [id, access.clinicId]
        ),
        c.query(
          `select id, file_name, mime_type, size_bytes, kind, created_at
           from patient_files where patient_id = $1 and clinic_id = $2 order by created_at desc`,
          [id, access.clinicId]
        ),
        caps.calendar
          ? c.query(
              `select a.id, a.starts_at, a.ends_at, a.status, a.source, s.name as service_name, s.name_ar as service_name_ar,
                      u.full_name as doctor_name
               from appointments a
               left join services s on s.id = a.service_id
               left join clinic_members m on m.id = a.doctor_member_id
               left join users u on u.id = m.user_id
               where a.patient_id = $1 and a.clinic_id = $2 order by a.starts_at desc limit 50`,
              [id, access.clinicId]
            )
          : none,
        caps.invoices
          ? c.query(
              `select i.id, i.number, i.status, i.total, i.amount_paid, i.created_at
               from invoices i where i.patient_id = $1 and i.clinic_id = $2${invScope.sql}
               order by i.created_at desc limit 50`,
              [id, access.clinicId, ...invScope.params]
            )
          : none,
        caps.conversations
          ? c.query(
              `select cv.id,
                      (select json_agg(x) from (
                         select m.id, m.direction, m.sender_kind, m.body, m.msg_type, m.created_at
                         from messages m where m.conversation_id = cv.id order by m.created_at desc limit 30
                      ) x) as msgs
               from conversations cv where cv.patient_id = $1 and cv.clinic_id = $2
               order by cv.last_message_at desc nulls last limit 1`,
              [id, access.clinicId]
            )
          : none,
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
        caps.invoices
          ? c.query(
              `select coalesce(sum(i.total - i.amount_paid), 0) as due from invoices i
               where i.patient_id = $1 and i.clinic_id = $2 and i.status in ('sent', 'partially_paid')${invScope.sql}`,
              [id, access.clinicId, ...invScope.params]
            )
          : { rows: [{ due: 0 }] },
        caps.documents ? loadDocumentList(c, access.clinicId, { patientId: id }) : [],
        caps.documents
          ? c.query(
              `select id, name, name_ar, category, language from document_templates
               where clinic_id = $1 and is_active order by category, name`,
              [access.clinicId]
            )
          : none,
        // The clinic's tag vocabulary, so this file suggests the labels the
        // clinic already uses instead of inviting a third spelling of "سكري",
        // and so a tag wears the colour it was given in settings.
        c.query(`select name, color from clinic_tags where clinic_id = $1 order by sort, name`, [
          access.clinicId,
        ]),
        // Only companies still in use, so a list that has been tidied does not
        // offer a defunct insurer to the next patient.
        c.query(`select id, name from insurers where clinic_id = $1 and active order by name`, [
          access.clinicId,
        ]),
        // The note categories this clinic defined. Inactive ones come too: a note
        // filed under a retired category still has to show which one.
        c.query(
          `select id, key, name, name_ar, color, is_system, active, sort
           from note_categories where clinic_id = $1 order by sort, name`,
          [access.clinicId]
        ),
      ]);

    return {
      patient: p,
      prescriptions,
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
      clinicTags: clinicTags.rows,
      insurers: insurers.rows,
      noteCategories: noteCategories.rows,
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
      clinicTags={JSON.parse(JSON.stringify(d.clinicTags))}
      insurers={JSON.parse(JSON.stringify(d.insurers))}
      noteCategories={JSON.parse(JSON.stringify(d.noteCategories))}
      prescriptions={JSON.parse(JSON.stringify(d.prescriptions ?? []))}
      initialTab={tab}
      canSendDocuments={can(access, "documents.manage")}
      caps={caps}
      country={countryFromClinic(access.clinic)}
    />
  );
}
