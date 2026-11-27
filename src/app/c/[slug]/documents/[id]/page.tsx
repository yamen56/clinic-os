import { notFound, redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { isUuid } from "@/lib/uuid";
import { can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { loadDocumentDetail } from "@/lib/esign/queries";
import { verifyHash } from "@/lib/esign/documents";
import { DocumentDetailClient } from "./document-detail";

export default async function DocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<{ sign?: string }>;
}) {
  const { slug, id } = await params;
  if (!isUuid(id)) notFound();
  const { sign } = await searchParams;
  const access = await guardClinic(slug);
  if (!can(access, "documents")) redirect(`/c/${slug}`);

  const data = await inClinic(access, async (c) => {
    const detail = await loadDocumentDetail(c, access.clinicId, id);
    if (!detail) return null;
    // The integrity check runs on every view, not only before a signature, so a
    // tampered document is visible to staff before anyone is asked to sign it.
    const hashOk = detail.doc.content_hash ? verifyHash(detail.doc) : true;
    const mySignature = (
      await c.query(`select signature_png_path from users where id = $1`, [access.session.user.id])
    ).rows[0];
    /*
      The people a staff line can name, doctors first — for a document raised
      without a visit in a clinic with several doctors. `auto` is whether they
      will be signed for the moment it goes out (their own switch, and a saved
      signature to apply).
    */
    const staff = (
      await c.query(
        `select cm.user_id, u.full_name, cm.role,
                (cm.auto_sign_documents and u.signature_png_path is not null) as auto
           from clinic_members cm join users u on u.id = cm.user_id
          where cm.clinic_id = $1 and cm.active
          order by (cm.role = 'doctor') desc, u.full_name`,
        [access.clinicId]
      )
    ).rows as { user_id: string; full_name: string; role: string; auto: boolean }[];
    return {
      detail: { ...detail, doc: { ...detail.doc, hash_ok: hashOk } },
      hasSavedSignature: !!mySignature?.signature_png_path,
      staff,
    };
  });

  if (!data) notFound();

  return (
    <DocumentDetailClient
      slug={slug}
      tz={access.clinic.timezone}
      canManage={can(access, "documents.manage")}
      canSendLink={access.clinic.features.esign_remote}
      canVoid={can(access, "documents.void")}
      userId={access.session.user.id}
      hasSavedSignature={data.hasSavedSignature}
      staff={data.staff}
      autoOpenSignerId={sign ?? null}
      detail={JSON.parse(JSON.stringify(data.detail))}
    />
  );
}
