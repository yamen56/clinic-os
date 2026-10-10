import { notFound, redirect } from "next/navigation";
import { guardCap } from "@/lib/guard";
import { isUuid } from "@/lib/uuid";
import { inClinic } from "@/lib/clinic-api";
import { loadDocumentList } from "@/lib/esign/queries";
import { PatientProfile } from "./profile-client";
import { can } from "@/lib/auth";
import { invoiceScopeSql } from "@/lib/invoice-scope";
import { countryFromClinic } from "@/lib/phone";
import { PATIENT_PRESCRIPTIONS_JSON } from "@/lib/prescriptions";
import { auditView } from "@/lib/audit";
import { DateTime } from "luxon";
import { loadDentalChart } from "@/lib/charts/dental/db";
import type { PoolClient } from "pg";
import { IMAGING_REQUEST_OPEN_FOR, nameWords } from "@/lib/imaging/ingest";
import { clinicSpecialties } from "@/lib/specialties";
import { profileFor } from "@/lib/specialty-profile";

export default async function PatientProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { slug, id } = await params;
  if (!isUuid(id)) notFound();
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
    merge: can(access, "patients.merge"),
    insurance: can(access, "insurance"),
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
        // The cover's end date as text: a `date` read through node-pg is a JS Date in
        // the server's zone, which moves it by a day west of the clinic.
        `select p.*, p.insurance_valid_until::text as cover_until, ${PATIENT_PRESCRIPTIONS_JSON} as __prescriptions,
                -- Who typed this patient in, as the clinic knows them: the
                -- header says "Lina · Reception", not "staff".
                (select json_build_object('name', u.full_name, 'title', cm.title, 'role', cm.role, 'owner', coalesce(cm.is_owner, false))
                   from users u left join clinic_members cm on cm.user_id = u.id and cm.clinic_id = p.clinic_id
                  where u.id = p.created_by) as added_by
           from patients p where p.id = $1 and p.clinic_id = $2`,
        [id, access.clinicId]
      )
    ).rows[0];
    if (!row) return null;
    const { __prescriptions: prescriptions, ...p } = row;
    // The dental chart is a module the agency switches on for a clinic that charts teeth.
    const dental = access.clinic.features.dental;
    if (p.merged_into) return { mergedInto: p.merged_into as string };
    await auditView(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "patient.view",
      entity: "patient",
      entityId: id,
    });

    const [notes, files, appointments, invoices, conversation, defs, activity, balance, documents, templates, clinicTags, insurers, noteCategories, dentalDoctors] =
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
          `select f.id, f.file_name, f.mime_type, f.size_bytes, f.kind, f.created_at, f.teeth, d.name as device_name,
                  case when f.dicom is null then null else jsonb_build_object(
                    'modality', f.dicom->>'modality', 'instances', jsonb_array_length(f.dicom->'instances')) end as dicom
             from patient_files f left join clinic_devices d on d.id = f.device_id
            where f.patient_id = $1 and f.clinic_id = $2 order by f.created_at desc`,
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
              `select i.id, i.number, i.status, i.total, i.amount_paid, i.created_at,
                      i.insurer_amount, i.claim_status, i.issue_date::text as issue_day, ins.name as insurer_name
               from invoices i left join insurers ins on ins.id = i.insurer_id
               where i.patient_id = $1 and i.clinic_id = $2${invScope.sql}
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
        // offer a defunct insurer to the next patient — plus this patient's own,
        // so a file whose company was retired still says who covered them.
        // Not at all without Insurance: an empty list is what hides the card.
        caps.insurance
          ? c.query(
              `select id, name, coverage_percent, coverage_cap from insurers
                where clinic_id = $1 and (active or id = $2) order by name`,
              [access.clinicId, p.insurer_id ?? null]
            )
          : none,
        // The note categories this clinic defined. Inactive ones come too: a note
        // filed under a retired category still has to show which one.
        c.query(
          `select id, key, name, name_ar, color, is_system, active, sort
           from note_categories where clinic_id = $1 order by sort, name`,
          [access.clinicId]
        ),
        // The doctors a chart entry can be performed by.
        dental
          ? c.query(
              `select m.id, u.full_name as name from clinic_members m join users u on u.id = m.user_id
                where m.clinic_id = $1 and m.active and m.role = 'doctor' order by u.full_name`,
              [access.clinicId]
            )
          : none,
      ]);

    /*
      Without Insurance the file says nothing about cover, rather than only not
      drawing it: the row goes to the browser whole, so the fields are emptied
      here, and the card photos are left out of the files with them. Who covers
      a patient is billing, and the switch was turned off so that it stays with
      whoever does the billing.
    */
    const patient = caps.insurance
      ? p
      : { ...p, insurer_id: null, insurance_no: "", insurance_valid_until: null, cover_until: null };
    const visibleFiles = caps.insurance
      ? files.rows
      : files.rows.filter((f) => f.kind !== "insurance_card");

    return {
      patient,
      prescriptions,
      notes: notes.rows,
      files: visibleFiles,
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
      dentalDoctors: dentalDoctors.rows as { id: string; name: string }[],
      // The saved chart: its entries and their history, the clinic's own treatments and favourites.
      dentalChart: dental ? await loadDentalChart(c, access.clinicId, id) : null,
      filesHub: await loadFilesHub(c, access.clinicId, id, p.full_name as string, (p.birth_date as Date | null) ?? null),
    };
  });

  if (!data) notFound();
  if ("mergedInto" in data && data.mergedInto) redirect(`/c/${slug}/patients/${data.mergedInto}`);
  const d = data as Exclude<typeof data, { mergedInto: string }>;

  return (
    <PatientProfile
      slug={slug}
      tz={access.clinic.timezone}
      today={DateTime.now().setZone(access.clinic.timezone).toISODate()!}
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
      renderedAt={Date.now()}
      canSendDocuments={can(access, "documents.manage")}
      caps={caps}
      country={countryFromClinic(access.clinic)}
      filesHub={d.filesHub ? JSON.parse(JSON.stringify({ ...d.filesHub, canMessage: can(access, "conversations") && !!d.patient.phone_e164, canManageDevices: can(access, "settings.clinic"), clinicName: access.clinic.name })) : null}
      dental={
        d.dentalChart
          ? JSON.parse(
              JSON.stringify({
                me: { id: access.session.user.id, name: access.session.user.fullName },
                myMemberId: access.memberId,
                doctors: d.dentalDoctors,
                canWrite: can(access, "patients.charts"),
                chart: d.dentalChart,
                clinicName: access.clinic.name,
                // Pictures to the patient go through the inbox: its switch, and a number to send to.
                canMessage: can(access, "conversations") && !!d.patient.phone_e164,
              })
            )
          : null
      }
    />
  );
}

/**
 * What the patient's Files need besides the files: the clinic's machines (to
 * ask one for this patient's next result), the requests already waiting, and
 * results a machine sent without saying whose that look like this patient's
 * — so they can be filed from here, without going to the Devices page. One
 * statement, one round trip; the likeness is scored in JS with the same rule
 * the Devices inbox uses (birth date counts 2, each shared name word 1).
 */
async function loadFilesHub(c: PoolClient, clinicId: string, patientId: string, fullName: string, birth: Date | null) {
  const r = (
    await c.query(
      `select
         (select coalesce(json_agg(json_build_object('id', d.id, 'name', d.name, 'kind', d.kind) order by d.created_at), '[]')
            from clinic_devices d where d.clinic_id = $2 and d.revoked_at is null) as devices,
         (select coalesce(json_agg(json_build_object('id', r.id, 'kind', r.kind, 'note', r.note, 'device', d.name, 'createdAt', r.created_at, 'teeth', r.teeth) order by r.created_at), '[]')
            from imaging_requests r left join clinic_devices d on d.id = r.device_id
           where r.clinic_id = $2 and r.patient_id = $1 and r.fulfilled_at is null and r.cancelled_at is null
             and r.created_at > now() - interval '${IMAGING_REQUEST_OPEN_FOR}') as waiting,
         (select coalesce(json_agg(x order by x.received_at), '[]') from (
            select i.id, i.file_name, i.mime_type, i.kind, i.received_at, d.name as device, i.hint->'machine' as machine
              from imaging_inbox i left join clinic_devices d on d.id = i.device_id
             where i.clinic_id = $2 and i.assigned_at is null and i.discarded_at is null and i.hint ? 'machine'
             order by i.received_at desc limit 50) x) as inbox,
         (select json_build_object('specialty', cl.specialty, 'specialties', cl.specialties) from clinics cl where cl.id = $2) as clinic`,
      [patientId, clinicId]
    )
  ).rows[0];
  const words = new Set(nameWords(fullName));
  const birthIso = birth ? `${birth.getFullYear()}-${String(birth.getMonth() + 1).padStart(2, "0")}-${String(birth.getDate()).padStart(2, "0")}` : null;
  type Inbox = { id: string; file_name: string; mime_type: string; kind: string; received_at: string; device: string | null; machine: { name?: string; birthDate?: string | null } | null };
  const likely = (r.inbox as Inbox[]).filter((i) => {
    const theirs = nameWords(i.machine?.name ?? "");
    const score = (birthIso && i.machine?.birthDate === birthIso ? 2 : 0) + theirs.filter((w) => words.has(w)).length;
    return score >= 2;
  });
  const practises = clinicSpecialties(r.clinic?.specialty, r.clinic?.specialties ?? []);
  return {
    devices: r.devices as { id: string; name: string; kind: string }[],
    waiting: r.waiting as { id: string; kind: string; note: string; device: string | null; createdAt: string; teeth: string[] }[],
    likely,
    // The kinds of result this clinic's fields keep, in their order (lib/specialty-profile).
    kinds: profileFor(practises).files,
  };
}
