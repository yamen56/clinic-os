"use server";

import { revalidatePath } from "next/cache";
import { requireClinic, can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { QUESTION_TYPES } from "@/lib/booking-intake";
import { z } from "zod";

const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : null));

const linkSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(60),
  slug: z
    .string()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  doctorMemberId: z.string().uuid().nullable().default(null),
  serviceIds: z.array(z.string().uuid()).default([]),
  minNoticeMin: z.coerce.number().int().min(0).max(10080),
  maxDaysAhead: z.coerce.number().int().min(1).max(365),
  slotGranularityMin: z.coerce.number().int().min(5).max(120),
  approvalMode: z.enum(["instant", "approval"]),
  active: z.boolean().default(true),
  // What the page says, in the clinic's own words.
  headline: optional(120),
  headlineAr: optional(120),
  intro: optional(600),
  introAr: optional(600),
  successNote: optional(600),
  successNoteAr: optional(600),
  showPrices: z.boolean().default(true),
  allowAnyDoctor: z.boolean().default(true),
  consentText: optional(1000),
  consentTextAr: optional(1000),
  requireConsent: z.boolean().default(false),
});

export async function saveBookingLinkAction(
  slug: string,
  data: unknown
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings")) return { error: "forbidden" };
  const parsed = linkSchema.safeParse(data);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;

  // A tick-box with nothing written next to it is a dead control on a public
  // page, so requiring consent requires the words the patient is agreeing to.
  if (d.requireConsent && !d.consentText && !d.consentTextAr) {
    return { error: "consent_text_required" };
  }

  return inClinic(access, async (c) => {
    const dup = await c.query(
      `select 1 from booking_links where slug = $1 and ($2::uuid is null or id <> $2)`,
      [d.slug, d.id ?? null]
    );
    if (dup.rowCount) return { error: "slug_taken" };

    const shared = [
      d.name, d.slug, d.doctorMemberId, d.serviceIds, d.minNoticeMin, d.maxDaysAhead,
      d.slotGranularityMin, d.approvalMode, d.active, d.headline, d.headlineAr, d.intro,
      d.introAr, d.successNote, d.successNoteAr, d.showPrices, d.allowAnyDoctor,
      d.consentText, d.consentTextAr, d.requireConsent,
    ];

    if (d.id) {
      const r = await c.query(
        `update booking_links set name = $3, slug = $4, doctor_member_id = $5, service_ids = $6,
           min_notice_min = $7, max_days_ahead = $8, slot_granularity_min = $9, approval_mode = $10,
           active = $11, headline = $12, headline_ar = $13, intro = $14, intro_ar = $15,
           success_note = $16, success_note_ar = $17, show_prices = $18, allow_any_doctor = $19,
           consent_text = $20, consent_text_ar = $21, require_consent = $22
         where id = $1 and clinic_id = $2`,
        [d.id, access.clinicId, ...shared]
      );
      if (!r.rowCount) return { error: "not_found" };
    } else {
      await c.query(
        `insert into booking_links (clinic_id, name, slug, doctor_member_id, service_ids,
           min_notice_min, max_days_ahead, slot_granularity_min, approval_mode, active,
           headline, headline_ar, intro, intro_ar, success_note, success_note_ar,
           show_prices, allow_any_doctor, consent_text, consent_text_ar, require_consent)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
        [access.clinicId, ...shared]
      );
    }
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "booking_link.save",
      entity: "booking_link",
      entityId: d.slug,
    });
    revalidatePath(`/c/${slug}/settings/booking`);
    return {};
  });
}

export async function deleteBookingLinkAction(slug: string, id: string) {
  const access = await requireClinic(slug);
  if (!can(access, "settings")) return;
  await inClinic(access, (c) =>
    c.query(`delete from booking_links where id = $1 and clinic_id = $2`, [id, access.clinicId])
  );
  revalidatePath(`/c/${slug}/settings/booking`);
}

/* ------------------------------------------------------------------ questions */

const questionSchema = z.object({
  id: z.string().uuid().optional(),
  // null = asked on every one of the clinic's booking links.
  bookingLinkId: z.string().uuid().nullable().default(null),
  label: z.string().trim().min(1).max(120),
  labelAr: optional(120),
  help: optional(200),
  helpAr: optional(200),
  fieldType: z.enum(QUESTION_TYPES),
  options: z.array(z.string().trim().min(1).max(80)).max(40).default([]),
  optionsAr: z.array(z.string().trim().max(80)).max(40).default([]),
  required: z.boolean().default(false),
  serviceIds: z.array(z.string().uuid()).max(60).default([]),
  patientFieldKey: z.string().trim().max(80).nullable().default(null),
  active: z.boolean().default(true),
});

export async function saveBookingQuestionAction(
  slug: string,
  input: unknown
): Promise<{ error?: string; id?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings")) return { error: "forbidden" };
  const parsed = questionSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const q = parsed.data;

  const needsOptions = q.fieldType === "select" || q.fieldType === "multiselect";
  if (needsOptions && q.options.length < 1) return { error: "options_required" };
  // A choice list with a half-filled Arabic column would pair an Arabic label
  // with an English value; the reader either translates all of them or none.
  const optionsAr =
    q.optionsAr.filter(Boolean).length === q.options.length ? q.optionsAr : [];

  return inClinic(access, async (c) => {
    if (q.patientFieldKey) {
      // The mapping must name a real patient field on *this* clinic, or the
      // answer would quietly go nowhere.
      const def = await c.query(
        `select 1 from patient_field_definitions
         where clinic_id = $1 and key = $2 and scope = 'patient'`,
        [access.clinicId, q.patientFieldKey]
      );
      if (!def.rowCount) return { error: "unknown_field" };
    }
    if (q.bookingLinkId) {
      const link = await c.query(`select 1 from booking_links where id = $1 and clinic_id = $2`, [
        q.bookingLinkId,
        access.clinicId,
      ]);
      if (!link.rowCount) return { error: "not_found" };
    }

    const values = [
      q.bookingLinkId,
      q.label,
      q.labelAr,
      q.help,
      q.helpAr,
      q.fieldType,
      JSON.stringify(needsOptions ? q.options : []),
      JSON.stringify(needsOptions ? optionsAr : []),
      q.required,
      q.serviceIds,
      q.patientFieldKey,
      q.active,
    ];

    let id = q.id;
    if (q.id) {
      const r = await c.query(
        `update booking_questions set booking_link_id = $3, label = $4, label_ar = $5, help = $6,
           help_ar = $7, field_type = $8, options = $9::jsonb, options_ar = $10::jsonb,
           required = $11, service_ids = $12, patient_field_key = $13, active = $14
         where id = $1 and clinic_id = $2`,
        [q.id, access.clinicId, ...values]
      );
      if (!r.rowCount) return { error: "not_found" };
    } else {
      const r = await c.query(
        `insert into booking_questions
           (clinic_id, booking_link_id, label, label_ar, help, help_ar, field_type, options,
            options_ar, required, service_ids, patient_field_key, active, display_order)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13,
                 (select coalesce(max(display_order), 0) + 10 from booking_questions where clinic_id = $1))
         returning id`,
        [access.clinicId, ...values]
      );
      id = r.rows[0].id as string;
    }

    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: q.id ? "booking_question.update" : "booking_question.create",
      entity: "booking_question",
      entityId: id!,
      detail: { label: q.label, type: q.fieldType },
    });
    revalidatePath(`/c/${slug}/settings/booking`);
    return { id };
  });
}

export async function deleteBookingQuestionAction(
  slug: string,
  id: string
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings")) return { error: "forbidden" };
  return inClinic(access, async (c) => {
    /*
      Deleting the question does not touch the answers. They are frozen onto the
      appointments as label/value snapshots, so a visit booked last month keeps
      showing what the patient was asked even after the clinic drops the
      question.
    */
    const r = await c.query(
      `delete from booking_questions where id = $1 and clinic_id = $2 returning label`,
      [id, access.clinicId]
    );
    if (!r.rowCount) return { error: "not_found" };
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "booking_question.delete",
      entity: "booking_question",
      entityId: id,
      detail: { label: r.rows[0].label },
    });
    revalidatePath(`/c/${slug}/settings/booking`);
    return {};
  });
}

export async function moveBookingQuestionAction(
  slug: string,
  id: string,
  direction: "up" | "down"
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings")) return { error: "forbidden" };
  return inClinic(access, async (c) => {
    const me = (
      await c.query(
        `select id, display_order from booking_questions where id = $1 and clinic_id = $2`,
        [id, access.clinicId]
      )
    ).rows[0];
    if (!me) return { error: "not_found" };

    const neighbour = (
      await c.query(
        `select id, display_order from booking_questions
         where clinic_id = $1 and display_order ${direction === "up" ? "<" : ">"} $2
         order by display_order ${direction === "up" ? "desc" : "asc"} limit 1`,
        [access.clinicId, me.display_order]
      )
    ).rows[0];
    if (!neighbour) return {};

    await c.query(
      `update booking_questions set display_order = case id when $1 then $4::int else $3::int end
       where id in ($1, $2)`,
      [me.id, neighbour.id, me.display_order, neighbour.display_order]
    );
    revalidatePath(`/c/${slug}/settings/booking`);
    return {};
  });
}
