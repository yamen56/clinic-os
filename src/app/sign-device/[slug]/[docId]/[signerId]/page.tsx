import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { isSignerDue, isTerminal, loadSigners } from "@/lib/esign/documents";
import type { PublicSigningView } from "@/lib/esign/public";
import { KioskSigning } from "./kiosk-signing";

/**
 * The in-clinic signing view.
 *
 * Deliberately outside `/c/[slug]` so that the workspace layout — sidebar,
 * patient list, everything else about the clinic — is not merely hidden but
 * absent from the page. This route is opened and then the device is handed to a
 * patient, so "not rendered" is the only acceptable standard.
 */
export const metadata: Metadata = { robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function SignDevicePage({
  params,
}: {
  params: Promise<{ slug: string; docId: string; signerId: string }>;
}) {
  const { slug, docId, signerId } = await params;
  const access = await guardClinic(slug);

  const data = await inClinic(access, async (c) => {
    const doc = (
      await c.query(
        `select d.*, cl.name, cl.name_ar, cl.slug, cl.logo_path, cl.brand_color,
                cl.phone_e164 as clinic_phone, t.fields_schema
         from documents d
         join clinics cl on cl.id = d.clinic_id
         left join document_templates t on t.id = d.template_id
         where d.id = $1 and d.clinic_id = $2`,
        [docId, access.clinicId]
      )
    ).rows[0];
    if (!doc) return null;

    const signers = await loadSigners(c, docId, access.clinicId);
    const signer = signers.find((s) => s.id === signerId);
    if (!signer) return null;

    const session = (
      await c.query(
        `select last_step, scrolled_to_end, consent_confirmed, partial_signature, field_answers
         from signing_sessions where signer_id = $1`,
        [signerId]
      )
    ).rows[0];

    const nextAfter = signers
      .filter((s) => s.status !== "signed" && s.is_required && s.id !== signerId)
      .sort((a, b) => a.signing_order - b.signing_order)[0];

    const hasPin = !!(
      await c.query(`select kiosk_pin_hash from users where id = $1`, [access.session.user.id])
    ).rows[0]?.kiosk_pin_hash;

    const isAr = doc.language === "ar";
    const view: PublicSigningView = {
      state:
        signer.status === "signed"
          ? "already_signed"
          : signer.status === "declined"
            ? "declined"
            : isTerminal(doc)
              ? "already_signed"
              : isSignerDue(signers, signerId, doc.signing_mode)
                ? "ready"
                : "not_your_turn",
      clinic: {
        name: (isAr ? doc.name_ar : null) || doc.name,
        slug: doc.slug,
        logoPath: doc.logo_path,
        brandColor: doc.brand_color,
        phone: doc.clinic_phone,
        vocabulary: access.clinic.vocabulary,
      },
      document: {
        id: doc.id,
        title: doc.title,
        language: doc.language,
        snapshot: doc.content_snapshot ?? "",
        source: doc.source,
        pdfUrl: null,
        status: doc.status,
        expiresAt: null,
      },
      signer: {
        id: signer.id,
        displayName: signer.display_name,
        roleKey: signer.role_key,
        status: signer.status,
      },
      session: session
        ? {
            lastStep: Number(session.last_step) || 1,
            scrolledToEnd: !!session.scrolled_to_end,
            consentConfirmed: !!session.consent_confirmed,
            partialSignature: session.partial_signature ?? null,
            fieldAnswers: (session.field_answers ?? {}) as Record<string, unknown>,
          }
        : null,
      extraQuestions: ((doc.fields_schema ?? []) as PublicSigningView["extraQuestions"]).filter(
        (q) => !q.roles?.length || q.roles.includes(signer.role_key)
      ),
      waitingOn:
        signers
          .filter(
            (s) =>
              s.status !== "signed" &&
              s.is_required &&
              s.id !== signerId &&
              s.signing_order < signer.signing_order
          )
          .sort((a, b) => a.signing_order - b.signing_order)[0]?.display_name ?? null,
      nextSignerName: nextAfter?.display_name ?? null,
      tokenId: null,
    };

    // The uploaded file is served through the authenticated clinic route here,
    // because this device has a session; the public token route does not apply.
    if (doc.source === "upload" && doc.source_pdf_path) {
      view.document!.pdfUrl = `/api/c/${slug}/documents/template-pdf?path=${encodeURIComponent(
        doc.source_pdf_path
      )}`;
    }

    return { view, hasPin };
  });

  if (!data) notFound();

  return (
    <KioskSigning
      slug={slug}
      docId={docId}
      signerId={signerId}
      hasPin={data.hasPin}
      view={JSON.parse(JSON.stringify(data.view))}
    />
  );
}
