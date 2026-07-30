import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { loadAppointmentDocuments } from "@/lib/esign/queries";
import { buildDefaultSigners, createDocument } from "@/lib/esign/documents";
import { sendDocument } from "@/lib/esign/flow";

/**
 * The consent forms a booked service requires, and where each one stands.
 *
 * Read by the appointment side panel, so staff can see at a glance whether the
 * paperwork is done before the patient is in the chair — and raise or send it
 * without leaving the appointment.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const auth = await apiClinic(slug);
  if (!auth.ok) return auth.res;
  const { access } = auth;

  const rows = await inClinic(access, (c) =>
    loadAppointmentDocuments(c, access.clinicId, id)
  );
  return NextResponse.json({ documents: rows });
}

/** Raises one of the required documents, optionally sending it straight away. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const auth = await apiClinic(slug);
  if (!auth.ok) return auth.res;
  const { access } = auth;
  if (access.role === "doctor") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}) as { templateId?: string; send?: boolean });
  if (!body.templateId) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const result = await inClinic(access, async (c) => {
    const appt = (
      await c.query(
        `select id, patient_id, service_id from appointments where id = $1 and clinic_id = $2`,
        [id, access.clinicId]
      )
    ).rows[0];
    if (!appt) return { error: "not_found", status: 404 };

    const template = (
      await c.query(
        `select id, name, name_ar, language, signer_config, source, source_pdf_path
         from document_templates where id = $1 and clinic_id = $2 and is_active`,
        [body.templateId, access.clinicId]
      )
    ).rows[0];
    if (!template) return { error: "not_found", status: 404 };

    const patient = (
      await c.query(
        `select id, full_name, phone_e164, birth_date from patients where id = $1 and clinic_id = $2`,
        [appt.patient_id, access.clinicId]
      )
    ).rows[0];

    let language: "ar" | "en" = access.clinic.defaultLocale === "en" ? "en" : "ar";
    if (template.language === "ar") language = "ar";
    if (template.language === "en") language = "en";

    const signers = await buildDefaultSigners(c, {
      clinicId: access.clinicId,
      signerConfig: template.signer_config ?? {},
      patient: patient ?? null,
      appointmentId: id,
    });

    const documentId = await createDocument(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      patientId: appt.patient_id,
      templateId: template.id,
      title: (language === "ar" ? template.name_ar : null) || template.name,
      language,
      source: template.source,
      sourcePdfPath: template.source_pdf_path,
      signingMode: (template.signer_config?.mode ?? "sequential") as "sequential" | "parallel",
      appointmentId: id,
      serviceId: appt.service_id,
      signers,
    });

    if (!body.send) return { documentId, status: 200 };

    const sent = await sendDocument(c, {
      clinicId: access.clinicId,
      documentId,
      userId: access.session.user.id,
    });
    if (!sent.ok) {
      return { documentId, error: sent.error, missing: sent.missing, status: 200 };
    }
    return { documentId, delivered: sent.delivered, noPhone: sent.noPhone, status: 200 };
  });

  const { status, ...rest } = result;
  return NextResponse.json(rest, { status });
}
