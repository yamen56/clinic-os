import { notFound, redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
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
    return {
      detail: { ...detail, doc: { ...detail.doc, hash_ok: hashOk } },
      hasSavedSignature: !!mySignature?.signature_png_path,
    };
  });

  if (!data) notFound();

  return (
    <DocumentDetailClient
      slug={slug}
      tz={access.clinic.timezone}
      canManage={can(access, "documents.manage")}
      canVoid={can(access, "documents.void")}
      userId={access.session.user.id}
      hasSavedSignature={data.hasSavedSignature}
      autoOpenSignerId={sign ?? null}
      detail={JSON.parse(JSON.stringify(data.detail))}
    />
  );
}
