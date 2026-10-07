import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { ingestImage } from "@/lib/imaging/ingest";
import { isDicom } from "@/lib/imaging/dicom";

/*
  The imaging station, with an image nobody is waiting for.

  A DICOM series arrives as many files: the doctor's "Take x-ray" is answered
  by the first slice, and the rest come in after the request is closed. Here
  they join the series they belong to — and a DICOM that belongs to no series
  and no request goes to the clinic's imaging inbox, rather than living only
  in one browser tab until somebody closes it.

  DICOM only. A plain JPEG carries nothing that says whose it is, so the
  station keeps those in its own "held" list for a person to send.
*/

const MAX_SIZE = 100 * 1024 * 1024;

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "patients");
  if (!g.ok) return g.res;
  const access = g.access;

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "no_file" }, { status: 400 });
  if (file.size > MAX_SIZE) return NextResponse.json({ error: "too_large" }, { status: 413 });
  const data = Buffer.from(await file.arrayBuffer());
  if (!isDicom(data)) return NextResponse.json({ error: "not_dicom" }, { status: 415 });

  const r = await ingestImage(
    {
      clinicId: access.clinicId,
      from: { userId: access.session.user.id, impersonatedBy: access.session.impersonatedBy },
      fileName: file.name,
      mime: "application/dicom",
      data,
      // A slice of a series already on file joins it; a new series answers
      // whoever has waited longest — the same order the station uses.
      useOpenRequest: true,
    },
    (fn) => inClinic(access, fn)
  );
  if (r.placed === "nowhere") return NextResponse.json({ error: r.error }, { status: 409 });
  if (r.placed === "inbox") return NextResponse.json({ ok: true, placed: "inbox", added: r.added, inboxId: r.inboxId });
  const p = await inClinic(access, async (c) =>
    (
      await c.query(
        `select p.full_name, f.teeth from patients p join patient_files f on f.patient_id = p.id where p.id = $1 and f.id = $2 and p.clinic_id = $3`,
        [r.patientId, r.fileId, access.clinicId]
      )
    ).rows[0]
  );
  return NextResponse.json({
    ok: true,
    placed: "patient",
    added: r.added,
    fileId: r.fileId,
    patientId: r.patientId,
    patientName: p?.full_name ?? "",
    teeth: (p?.teeth ?? []) as string[],
    requestId: r.requestId,
  });
}
