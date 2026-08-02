"use server";

import { revalidatePath } from "next/cache";
import { requireClinic, can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { findOrCreatePatient } from "@/lib/patients";
import { countryFromClinic } from "@/lib/phone";
import { audit } from "@/lib/audit";

export async function addQuickReplyAction(
  slug: string,
  data: { title: string; body: string }
): Promise<{ id?: string; error?: string }> {
  const access = await requireClinic(slug);
  if (!data.title.trim() || !data.body.trim()) return { error: "invalid" };
  return inClinic(access, async (c) => {
    const r = await c.query(
      `insert into quick_replies (clinic_id, title, body, sort)
       values ($1, $2, $3, (select coalesce(max(sort), 0) + 1 from quick_replies where clinic_id = $1))
       returning id`,
      [access.clinicId, data.title.trim().slice(0, 60), data.body.trim().slice(0, 2000)]
    );
    return { id: r.rows[0].id as string };
  });
}

export async function deleteQuickReplyAction(slug: string, id: string) {
  const access = await requireClinic(slug);
  await inClinic(access, (c) =>
    c.query(`delete from quick_replies where id = $1 and clinic_id = $2`, [id, access.clinicId])
  );
}

/**
 * Turn a conversation into a patient file.
 *
 * Someone texting the clinic is not a patient, so inbound messages no longer
 * create one. This is the deliberate step in the other direction: a member
 * decides this person is a patient and says so.
 */
export async function createPatientFromConversationAction(
  slug: string,
  conversationId: string
): Promise<{ patientId?: string; error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "patients")) return { error: "forbidden" };

  return inClinic(access, async (c) => {
    const conv = (
      await c.query(
        `select id, phone_e164, patient_id, whatsapp_name from conversations
          where id = $1 and clinic_id = $2`,
        [conversationId, access.clinicId]
      )
    ).rows[0] as
      | { id: string; phone_e164: string; patient_id: string | null; whatsapp_name: string | null }
      | undefined;
    if (!conv) return { error: "not_found" };
    if (conv.patient_id) return { patientId: conv.patient_id };

    // Still goes through the identity rule — the number may already belong to
    // a file created some other way since this thread started.
    const patient = await findOrCreatePatient(c, access.clinicId, {
      phone: conv.phone_e164,
      whatsappName: conv.whatsapp_name ?? undefined,
      source: "staff",
      status: "active",
      defaultCountry: countryFromClinic(access.clinic),
    });
    await c.query(`update conversations set patient_id = $2 where id = $1`, [conv.id, patient.id]);

    if (patient.created) {
      await c.query(
        `insert into jobs (clinic_id, kind, payload) values ($1, 'trigger:patient_created', $2)`,
        [access.clinicId, JSON.stringify({ patientId: patient.id, source: "staff" })]
      );
      await audit(c, {
        clinicId: access.clinicId,
        userId: access.session.user.id,
        impersonatedBy: access.session.impersonatedBy,
        action: "patient.create",
        entity: "patient",
        entityId: patient.id,
        detail: { from: "conversation" },
      });
    }

    revalidatePath(`/c/${slug}/patients`);
    return { patientId: patient.id };
  });
}
