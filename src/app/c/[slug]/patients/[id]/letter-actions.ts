"use server";

import { revalidatePath } from "next/cache";
import type { PoolClient } from "pg";
import { z } from "zod";
import { can, requireClinic, type ClinicAccess } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { withSystem } from "@/lib/db";
import { audit } from "@/lib/audit";
import { queueWhatsAppMessage } from "@/lib/outbound";
import { systemMessage } from "@/lib/system-messages";
import { notifyUser } from "@/lib/notify";
import { dictFor } from "@/lib/i18n/client-dict";
import { fmtDate } from "@/lib/dates";
import { firstName } from "@/lib/prescriptions";
import { renderLetterPdf } from "@/lib/letter-pdf";
import {
  LETTER_ROW_SQL,
  MAX_ADDRESSEE,
  MAX_BODY,
  MAX_DIAGNOSIS,
  MAX_LEAVE_DAYS,
  allocateLetterNumber,
  letterNumber,
  letterProblem,
  type LetterKind,
  type LetterLocale,
  type LetterRow,
} from "@/lib/medical-letters";

/*
  Gated on `patients.prescriptions`, like prescriptions: a sick leave or a
  report leaves the building in a doctor's name and under their signature.
  Reading the ones already written stays with `patients` — see the PDF route.
*/

const createSchema = z.object({
  patientId: z.string().uuid(),
  doctorMemberId: z.string().uuid(),
  kind: z.enum(["sick_leave", "report", "referral"]),
  locale: z.enum(["ar", "en"]),
  diagnosis: z.string().max(MAX_DIAGNOSIS).default(""),
  body: z.string().max(MAX_BODY).default(""),
  addressee: z.string().max(MAX_ADDRESSEE).default(""),
  leaveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  leaveDays: z.number().int().min(1).max(MAX_LEAVE_DAYS).nullable().optional(),
  urgent: z.boolean().optional(),
  /** False for Print: saved and rendered, not sent. */
  send: z.boolean(),
  /** Written during a visit: filed under it. */
  appointmentId: z.string().uuid().nullable().optional(),
});

type SendError = "no_phone" | "wa_disconnected" | "pdf_failed" | "not_found";

export type LetterResult = {
  error?: "forbidden" | "invalid" | "not_found" | "bad_doctor" | "leave" | "addressee" | "body";
  /** Saved, but something after the save did not happen. The record stands. */
  warning?: SendError;
  row?: LetterRow;
};

/**
 * Writes a letter, renders it, and — unless this is a Print — sends it.
 *
 * Committed first, delivered after, for the reason the prescription is: a
 * failed render or a disconnected WhatsApp must leave a saved letter and a
 * warning, never a lost one written out twice.
 */
export async function createLetterAction(slug: string, input: z.input<typeof createSchema>): Promise<LetterResult> {
  const access = await requireClinic(slug);
  if (!can(access, "patients.prescriptions")) return { error: "forbidden" };
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  const kind = d.kind as LetterKind;
  const draft = {
    kind,
    diagnosis: d.diagnosis.trim(),
    body: d.body.trim(),
    addressee: d.addressee.trim(),
    // Only a sick leave has dates; anything sent with another kind is dropped, not stored.
    leaveFrom: kind === "sick_leave" ? (d.leaveFrom ?? null) : null,
    leaveDays: kind === "sick_leave" ? (d.leaveDays ?? null) : null,
  };
  const problem = letterProblem(draft);
  if (problem) return { error: problem };

  const created = await inClinic(access, async (c) => {
    const patient = (
      await c.query(`select id, full_name from patients where id = $1 and clinic_id = $2 and merged_into is null`, [
        d.patientId,
        access.clinicId,
      ])
    ).rows[0];
    if (!patient) return { error: "not_found" as const };

    // A doctor here, or the clinic's owner — the same check as a prescription's.
    const doctor = (
      await c.query(
        `select m.id, m.user_id, u.full_name, u.locale, m.license_no, m.syndicate_no,
                u.signature_png_path is not null as has_signature
           from clinic_members m join users u on u.id = m.user_id
          where m.id = $1 and m.clinic_id = $2 and m.active and (m.role = 'doctor' or m.is_owner)`,
        [d.doctorMemberId, access.clinicId]
      )
    ).rows[0];
    if (!doctor) return { error: "bad_doctor" as const };

    const number = await allocateLetterNumber(c, access.clinicId);
    const ins = await c.query(
      `insert into medical_letters (clinic_id, patient_id, kind, number, locale, doctor_member_id, doctor_name,
                                    doctor_license_no, doctor_syndicate_no, author_id, appointment_id,
                                    diagnosis, body, addressee, leave_from, leave_days, urgent, signed)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               (select id from appointments where id = $11::uuid and clinic_id = $1 and patient_id = $2),
               $12, $13, $14, $15::date, $16, $17, $18)
       returning id`,
      [
        access.clinicId,
        patient.id,
        kind,
        number,
        d.locale,
        doctor.id,
        doctor.full_name,
        doctor.license_no ?? null,
        doctor.syndicate_no ?? null,
        access.session.user.id,
        d.appointmentId ?? null,
        draft.diagnosis,
        // A sick leave says what the sheet says; a body typed before switching kind is not kept.
        kind === "sick_leave" ? "" : draft.body,
        kind === "sick_leave" ? "" : draft.addressee,
        draft.leaveFrom,
        draft.leaveDays,
        kind === "referral" && !!d.urgent,
        doctor.has_signature,
      ]
    );
    const id = ins.rows[0].id as string;

    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "letter.create",
      entity: "medical_letter",
      entityId: id,
      detail: { patientId: patient.id, kind, number, doctorMemberId: doctor.id, signed: doctor.has_signature },
    });

    return {
      id,
      number,
      doctorUserId: doctor.user_id as string,
      doctorLocale: doctor.locale as string,
      patientName: patient.full_name as string,
    };
  });
  if ("error" in created) return { error: created.error };

  /*
    The doctor is told when somebody else wrote one in their name, as with a
    prescription — their signature is on it. Written as the system, after the
    commit; a failure is logged, never returned.
  */
  if (created.doctorUserId !== access.session.user.id) {
    const L = dictFor(created.doctorLocale === "en" ? "en" : "ar").letters;
    await withSystem((c) =>
      notifyUser(c, created.doctorUserId, {
        clinicId: access.clinicId,
        kind: "prescription_in_your_name",
        title: L.notifyTitle.replace("{author}", access.session.user.fullName).replace("{kind}", L.kinds[kind]),
        body: L.notifyBody.replace("{patient}", created.patientName),
        url: `/c/${slug}/patients/${d.patientId}?tab=letters`,
      })
    ).catch((e) => console.error("[letter notify]", (e as Error).message));
  }

  const warning = await deliver(access, created.id, created.number, { send: d.send, render: true });
  const row = await loadRow(access, created.id);
  revalidatePath(`/c/${slug}/patients/${d.patientId}`);
  return { row: row ?? undefined, warning };
}

/** Sends a letter again — the patient lost it, or the employer wants it forwarded. */
export async function resendLetterAction(slug: string, id: string): Promise<LetterResult> {
  const access = await requireClinic(slug);
  if (!can(access, "patients.prescriptions")) return { error: "forbidden" };
  const l = await inClinic(access, async (c) =>
    (
      await c.query(`select number, pdf_path, patient_id from medical_letters where id = $1 and clinic_id = $2`, [
        id,
        access.clinicId,
      ])
    ).rows[0]
  );
  if (!l) return { error: "not_found" };
  const warning = await deliver(access, id, l.number as number, { send: true, render: !l.pdf_path });
  const row = await loadRow(access, id);
  revalidatePath(`/c/${slug}/patients/${l.patient_id}`);
  return { row: row ?? undefined, warning };
}

async function deliver(
  access: ClinicAccess,
  id: string,
  number: number,
  opts: { send: boolean; render: boolean }
): Promise<SendError | undefined> {
  if (opts.render) {
    const path = await renderLetterPdf(access.clinicId, id, number);
    if (!path) return "pdf_failed";
    await inClinic(access, (c) =>
      c.query(`update medical_letters set pdf_path = $3 where id = $1 and clinic_id = $2`, [id, access.clinicId, path])
    );
  }
  if (!opts.send) return undefined;
  return inClinic(access, (c) => queueSend(c, access, id));
}

async function queueSend(c: PoolClient, access: ClinicAccess, id: string): Promise<SendError | undefined> {
  const l = (
    await c.query(
      `select l.kind, l.number, l.created_at, l.locale, l.doctor_name, l.pdf_path,
              p.id as patient_id, p.full_name, patient_reach_phone(p.id) as phone_e164,
              cl.name, cl.name_ar, cl.timezone,
              coalesce(ws.status = 'connected', false) as wa_connected
         from medical_letters l
         join patients p on p.id = l.patient_id
         join clinics cl on cl.id = l.clinic_id
         left join whatsapp_sessions ws on ws.clinic_id = l.clinic_id
        where l.id = $1 and l.clinic_id = $2`,
      [id, access.clinicId]
    )
  ).rows[0];
  if (!l) return "not_found";
  if (!l.pdf_path) return "pdf_failed";
  if (!l.phone_e164) return "no_phone";
  if (!l.wa_connected) return "wa_disconnected";

  const lang = (l.locale === "en" ? "en" : "ar") as LetterLocale;
  const L = dictFor(lang).letters;
  const kind = l.kind as LetterKind;
  const { body } = await systemMessage(c, {
    clinicId: access.clinicId,
    key: "letter_sent",
    lang,
    vars: {
      "patient.first_name": firstName(l.full_name),
      "patient.name": l.full_name,
      "clinic.name": lang === "ar" ? l.name_ar || l.name : l.name,
      "doctor.name": l.doctor_name,
      "letter.title": L.captionTitles[kind],
      "letter.date": fmtDate(l.created_at, l.timezone, lang),
    },
  });

  const { messageId } = await queueWhatsAppMessage(c, {
    clinicId: access.clinicId,
    phoneE164: l.phone_e164,
    senderKind: "staff",
    senderUserId: access.session.user.id,
    body,
    msgType: "document",
    mediaPath: l.pdf_path,
    mediaName: `${L.sheet.titles[kind]} ${letterNumber(l.number)}.pdf`,
    mediaMime: "application/pdf",
    patientId: l.patient_id,
  });
  await c.query(`update medical_letters set message_id = $3, sent_at = now() where id = $1 and clinic_id = $2`, [
    id,
    access.clinicId,
    messageId,
  ]);
  await audit(c, {
    clinicId: access.clinicId,
    userId: access.session.user.id,
    impersonatedBy: access.session.impersonatedBy,
    action: "letter.send",
    entity: "medical_letter",
    entityId: id,
    detail: { number: l.number, kind, messageId },
  });
  return undefined;
}

async function loadRow(access: ClinicAccess, id: string): Promise<LetterRow | null> {
  const row = await inClinic(access, async (c) => (await c.query(LETTER_ROW_SQL, [id, access.clinicId])).rows[0]);
  return row ? (JSON.parse(JSON.stringify(row)) as LetterRow) : null;
}
