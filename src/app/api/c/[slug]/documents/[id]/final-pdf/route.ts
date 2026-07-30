import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { can } from "@/lib/auth";
import { saveFile } from "@/lib/storage";
import { pdfPageCount } from "@/lib/esign/pdf";
import { logDocEvent } from "@/lib/esign/events";

const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Attaches a signed copy that was produced outside this platform.
 *
 * The paper route is real: a form is printed, signed at the desk or carried to a
 * guardian, and scanned. Before this the record here stayed "sent" forever while
 * the signed page sat in a drawer, so the pending list slowly filled with work
 * that was actually finished.
 *
 * What this deliberately does *not* do is pretend the result is the same thing
 * as a document signed here. Nothing about an uploaded scan is verifiable by
 * this platform: no captured signature, no IP, no one-time code, no content
 * hash. So the signers named on it are recorded as having signed on paper, the
 * file is marked `uploaded`, and the audit trail says who attached it and when.
 * The screen then shows that provenance rather than a green tick that means
 * something it did not earn.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const auth = await apiClinic(slug);
  if (!auth.ok) return auth.res;
  const { access } = auth;
  if (!can(access, "documents.manage")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "no_file" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "too_large" }, { status: 413 });

  const data = Buffer.from(await file.arrayBuffer());
  // Trust the bytes, not the Content-Type the browser attached.
  if (data.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return NextResponse.json({ error: "not_pdf" }, { status: 415 });
  }
  let pages: number;
  try {
    pages = await pdfPageCount(data);
  } catch {
    return NextResponse.json({ error: "unreadable_pdf" }, { status: 415 });
  }

  const signerIds = String(form?.get("signerIds") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const note = String(form?.get("note") ?? "").slice(0, 500);

  const result = await inClinic(access, async (c) => {
    const doc = (
      await c.query(
        `select id, status, title from documents where id = $1 and clinic_id = $2`,
        [id, access.clinicId]
      )
    ).rows[0] as { id: string; status: string; title: string } | undefined;
    if (!doc) return { error: "not_found" as const };

    /*
      A voided document stays voided. Attaching a signed copy to one would
      quietly resurrect an agreement somebody deliberately cancelled — if the
      paper copy is genuine, the replacement document is the place for it.
    */
    if (doc.status === "voided") return { error: "voided" as const };

    const saved = await saveFile(access.clinicId, "documents", file.name || "signed.pdf", data);

    // Only the signers the uploader ticked. The rest keep whatever status they
    // already had, including one who declined — an upload does not overrule a
    // refusal that was recorded here.
    let marked = 0;
    if (signerIds.length > 0) {
      const r = await c.query(
        `update document_signers
            set status = 'signed', signed_at = coalesce(signed_at, now()),
                signed_in_person = true, updated_at = now()
          where document_id = $1 and clinic_id = $2 and id = any($3::uuid[])
            and status <> 'declined'`,
        [id, access.clinicId, signerIds]
      );
      marked = r.rowCount ?? 0;
    }

    // Outstanding required signers keep the document open: a copy covering one
    // of three signatures is progress, not completion.
    const outstanding = (
      await c.query(
        `select count(*)::int as n from document_signers
          where document_id = $1 and is_required and status <> 'signed'`,
        [id]
      )
    ).rows[0].n as number;

    const status = outstanding === 0 ? "completed" : "partially_signed";
    await c.query(
      `update documents
          set final_pdf_path = $2, final_pdf_source = 'uploaded', status = $3,
              completed_at = case when $3 = 'completed' then coalesce(completed_at, now()) else completed_at end,
              updated_at = now()
        where id = $1`,
      [id, saved.storagePath, status]
    );

    await logDocEvent(c, {
      clinicId: access.clinicId,
      documentId: id,
      type: "final_uploaded",
      actorUserId: access.session.user.id,
      actorKind: "staff",
      metadata: {
        file: saved.storagePath,
        bytes: saved.sizeBytes,
        pages,
        signersMarked: marked,
        note: note || undefined,
      },
    });
    if (status === "completed") {
      await logDocEvent(c, {
        clinicId: access.clinicId,
        documentId: id,
        type: "completed",
        actorUserId: access.session.user.id,
        actorKind: "staff",
        metadata: { via: "uploaded_copy" },
      });
    }

    return { ok: true as const, status, pages, signersMarked: marked };
  });

  if ("error" in result) {
    const status = result.error === "not_found" ? 404 : 409;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}
