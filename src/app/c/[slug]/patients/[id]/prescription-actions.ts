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
import { renderPrescriptionPdf } from "@/lib/prescription-pdf";
import {
  MAX_ITEMS,
  PRESCRIPTION_ROW_SQL,
  allocatePrescriptionNumber,
  cleanItems,
  firstName,
  formatMedicineLines,
  learnMedications,
  rxNumber,
  type PrescriptionRow,
  type RxItem,
  type RxLocale,
} from "@/lib/prescriptions";

/*
  Every action here is gated on `patients.prescriptions`, not `patients`.

  Opening the file is the desk's job; writing a prescription is done in a
  doctor's name and leaves the building under their signature. Reading the
  ones already written stays with `patients` — see the PDF route.
*/

const createSchema = z.object({
  patientId: z.string().uuid(),
  doctorMemberId: z.string().uuid(),
  locale: z.enum(["ar", "en"]),
  diagnosis: z.string().max(300).default(""),
  items: z.array(z.unknown()).max(MAX_ITEMS),
  /** The template it started from, so the most-used ones come first. */
  templateId: z.string().uuid().nullable().optional(),
  /** False for Print: saved and rendered, not sent. */
  send: z.boolean(),
});

type SendError = "no_phone" | "wa_disconnected" | "pdf_failed" | "not_found";

export type PrescriptionResult = {
  error?: "forbidden" | "invalid" | "no_items" | "not_found" | "bad_doctor" | "failed";
  /** Saved, but something after the save did not happen. The record stands. */
  warning?: SendError;
  row?: PrescriptionRow;
};

/**
 * Writes a prescription, renders it, and — unless this is a Print — sends it.
 *
 * Three steps with a render in the middle that can take seconds, so the record
 * is committed first. Everything after that is delivery: a PDF that failed to
 * render or a WhatsApp that is disconnected leaves a saved prescription and a
 * warning, never a lost one. The doctor who pressed Send and was told "saved,
 * not sent" can print it or resend it; one who was told "failed" would write it
 * out again and file it twice.
 */
export async function createPrescriptionAction(
  slug: string,
  input: z.input<typeof createSchema>
): Promise<PrescriptionResult> {
  const access = await requireClinic(slug);
  if (!can(access, "patients.prescriptions")) return { error: "forbidden" };
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const data = parsed.data;
  const items = cleanItems(data.items);
  if (!items.length) return { error: "no_items" };
  const diagnosis = data.diagnosis.trim();

  const created = await inClinic(access, async (c) => {
    const patient = (
      await c.query(
        `select id, full_name from patients where id = $1 and clinic_id = $2 and merged_into is null`,
        [data.patientId, access.clinicId]
      )
    ).rows[0];
    if (!patient) return { error: "not_found" as const };

    /*
      The prescriber must be a doctor here, or the clinic's owner — the admin
      is usually the dentist who owns the practice, and is filed as "other"
      until they change it themselves. A member id from the form is only a
      claim; this is where it is checked.
    */
    const doctor = (
      await c.query(
        `select m.id, m.user_id, u.full_name, u.locale,
                u.signature_png_path is not null as has_signature
           from clinic_members m join users u on u.id = m.user_id
          where m.id = $1 and m.clinic_id = $2 and m.active and (m.role = 'doctor' or m.is_owner)`,
        [data.doctorMemberId, access.clinicId]
      )
    ).rows[0];
    if (!doctor) return { error: "bad_doctor" as const };

    const number = await allocatePrescriptionNumber(c, access.clinicId);
    const ins = await c.query(
      `insert into prescriptions (clinic_id, patient_id, doctor_member_id, doctor_name, author_id,
                                  number, locale, diagnosis, items, signed)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning id`,
      [
        access.clinicId,
        patient.id,
        doctor.id,
        doctor.full_name,
        access.session.user.id,
        number,
        data.locale,
        diagnosis,
        JSON.stringify(items),
        doctor.has_signature,
      ]
    );
    const id = ins.rows[0].id as string;

    await learnMedications(c, access.clinicId, items);
    if (data.templateId) {
      await c.query(
        `update prescription_templates set use_count = use_count + 1 where id = $1 and clinic_id = $2`,
        [data.templateId, access.clinicId]
      );
    }

    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "prescription.create",
      entity: "prescription",
      entityId: id,
      detail: {
        patientId: patient.id,
        number,
        doctorMemberId: doctor.id,
        items: items.length,
        signed: doctor.has_signature,
      },
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
    The safeguard for "signed automatically". Anyone holding the permission
    may write a prescription in a doctor's name, and the doctor's signature
    goes on it — so the doctor is always told, in their own language, and can
    open it from the notification. Nobody is told about their own.

    Written as the system, after the prescription is committed: a member may
    only write notifications addressed to themselves, and this one is addressed
    to somebody else by design. A failure here is logged rather than returned —
    the prescription stands, and telling the writer it failed would have them
    write it twice.
  */
  if (created.doctorUserId !== access.session.user.id) {
    const L = dictFor(created.doctorLocale === "en" ? "en" : "ar").prescriptions;
    await withSystem((c) =>
      notifyUser(c, created.doctorUserId, {
        clinicId: access.clinicId,
        kind: "prescription_in_your_name",
        title: L.notifyTitle.replace("{author}", access.session.user.fullName),
        body: L.notifyBody.replace("{patient}", created.patientName),
        url: `/c/${slug}/patients/${data.patientId}?tab=prescriptions`,
      })
    ).catch((e) => console.error("[prescription notify]", (e as Error).message));
  }

  const warning = await deliver(access, created.id, created.number, { send: data.send, render: true });
  const row = await loadRow(access, created.id);
  revalidatePath(`/c/${slug}/patients/${data.patientId}`);
  return { row: row ?? undefined, warning };
}

/** Sends an existing prescription again — the patient lost it, or changed phones. */
export async function resendPrescriptionAction(slug: string, id: string): Promise<PrescriptionResult> {
  const access = await requireClinic(slug);
  if (!can(access, "patients.prescriptions")) return { error: "forbidden" };
  const rx = await inClinic(access, async (c) =>
    (
      await c.query(`select number, pdf_path, patient_id from prescriptions where id = $1 and clinic_id = $2`, [
        id,
        access.clinicId,
      ])
    ).rows[0]
  );
  if (!rx) return { error: "not_found" };
  const warning = await deliver(access, id, rx.number as number, { send: true, render: !rx.pdf_path });
  const row = await loadRow(access, id);
  revalidatePath(`/c/${slug}/patients/${rx.patient_id}`);
  return { row: row ?? undefined, warning };
}

/**
 * Renders the PDF when there is none yet, then queues the WhatsApp message.
 *
 * The phone and the connection are checked here, after the save, so that
 * neither can cost the doctor the prescription itself.
 */
async function deliver(
  access: ClinicAccess,
  id: string,
  number: number,
  opts: { send: boolean; render: boolean }
): Promise<SendError | undefined> {
  if (opts.render) {
    const path = await renderPrescriptionPdf(access.clinicId, id, number);
    if (!path) return "pdf_failed";
    await inClinic(access, (c) =>
      c.query(`update prescriptions set pdf_path = $3 where id = $1 and clinic_id = $2`, [
        id,
        access.clinicId,
        path,
      ])
    );
  }
  if (!opts.send) return undefined;
  return inClinic(access, (c) => queueSend(c, access, id));
}

async function queueSend(c: PoolClient, access: ClinicAccess, id: string): Promise<SendError | undefined> {
  const rx = (
    await c.query(
      `select rx.number, rx.created_at, rx.locale, rx.diagnosis, rx.items, rx.doctor_name, rx.pdf_path,
              p.id as patient_id, p.full_name, p.phone_e164,
              cl.name, cl.name_ar, cl.timezone,
              coalesce(ws.status = 'connected', false) as wa_connected
         from prescriptions rx
         join patients p on p.id = rx.patient_id
         join clinics cl on cl.id = rx.clinic_id
         left join whatsapp_sessions ws on ws.clinic_id = rx.clinic_id
        where rx.id = $1 and rx.clinic_id = $2`,
      [id, access.clinicId]
    )
  ).rows[0];
  if (!rx) return "not_found";
  if (!rx.pdf_path) return "pdf_failed";
  if (!rx.phone_e164) return "no_phone";
  if (!rx.wa_connected) return "wa_disconnected";

  const lang = (rx.locale === "en" ? "en" : "ar") as RxLocale;
  const items = (rx.items ?? []) as RxItem[];
  const { body } = await systemMessage(c, {
    clinicId: access.clinicId,
    key: "prescription_sent",
    lang,
    vars: {
      "patient.first_name": firstName(rx.full_name),
      "patient.name": rx.full_name,
      "clinic.name": lang === "ar" ? rx.name_ar || rx.name : rx.name,
      "doctor.name": rx.doctor_name,
      "prescription.date": fmtDate(rx.created_at, rx.timezone, lang),
      "prescription.medicines": formatMedicineLines(items),
      "prescription.diagnosis": rx.diagnosis ?? "",
    },
  });

  const { messageId } = await queueWhatsAppMessage(c, {
    clinicId: access.clinicId,
    phoneE164: rx.phone_e164,
    senderKind: "staff",
    senderUserId: access.session.user.id,
    body,
    msgType: "document",
    mediaPath: rx.pdf_path,
    mediaName: `${dictFor(lang).prescriptions.sheet.title} ${rxNumber(rx.number)}.pdf`,
    mediaMime: "application/pdf",
    // So the message lands on this patient's thread and file, not a stranger's.
    patientId: rx.patient_id,
  });
  await c.query(
    `update prescriptions set message_id = $3, sent_at = now() where id = $1 and clinic_id = $2`,
    [id, access.clinicId, messageId]
  );
  await audit(c, {
    clinicId: access.clinicId,
    userId: access.session.user.id,
    impersonatedBy: access.session.impersonatedBy,
    action: "prescription.send",
    entity: "prescription",
    entityId: id,
    detail: { number: rx.number, messageId },
  });
  return undefined;
}

/** The row as the patient file lists it, so the screen updates without a reload. */
async function loadRow(access: ClinicAccess, id: string): Promise<PrescriptionRow | null> {
  const row = await inClinic(access, async (c) =>
    (await c.query(PRESCRIPTION_ROW_SQL, [id, access.clinicId])).rows[0]
  );
  // Through JSON so dates arrive as the same strings the page's own list holds.
  return row ? (JSON.parse(JSON.stringify(row)) as PrescriptionRow) : null;
}

/* --------------------------------------------------------------- templates */

const templateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  diagnosis: z.string().max(300).default(""),
  items: z.array(z.unknown()).max(MAX_ITEMS),
  locale: z.enum(["ar", "en"]),
});

export type TemplateRow = {
  id: string;
  name: string;
  diagnosis: string;
  items: RxItem[];
  locale: RxLocale;
  use_count: number;
};

export async function saveTemplateAction(
  slug: string,
  input: z.input<typeof templateSchema>
): Promise<{ error?: string; template?: TemplateRow }> {
  const access = await requireClinic(slug);
  if (!can(access, "patients.prescriptions")) return { error: "forbidden" };
  const parsed = templateSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const items = cleanItems(parsed.data.items);
  if (!items.length) return { error: "no_items" };

  return inClinic(access, async (c) => {
    const r = await c.query(
      `insert into prescription_templates (clinic_id, name, diagnosis, items, locale, created_by)
       values ($1, $2, $3, $4, $5, $6)
       returning id, name, diagnosis, items, locale, use_count`,
      [
        access.clinicId,
        parsed.data.name,
        parsed.data.diagnosis.trim(),
        JSON.stringify(items),
        parsed.data.locale,
        access.session.user.id,
      ]
    );
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "prescription.template.create",
      entity: "prescription_template",
      entityId: r.rows[0].id,
    });
    return { template: r.rows[0] as TemplateRow };
  });
}

export async function deleteTemplateAction(slug: string, id: string): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "patients.prescriptions")) return { error: "forbidden" };
  return inClinic(access, async (c) => {
    // Prescriptions carry their own copy of every line, so nothing written
    // from this template changes when it goes.
    const r = await c.query(`delete from prescription_templates where id = $1 and clinic_id = $2`, [
      id,
      access.clinicId,
    ]);
    if (!r.rowCount) return { error: "not_found" };
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "prescription.template.delete",
      entity: "prescription_template",
      entityId: id,
    });
    return {};
  });
}

/** Stops a medicine being suggested — a misspelling, usually — or brings it back. */
export async function setMedicationHiddenAction(
  slug: string,
  id: string,
  hidden: boolean
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "patients.prescriptions")) return { error: "forbidden" };
  return inClinic(access, async (c) => {
    const r = await c.query(`update medications set hidden = $3 where id = $1 and clinic_id = $2`, [
      id,
      access.clinicId,
      hidden,
    ]);
    return r.rowCount ? {} : { error: "not_found" };
  });
}
