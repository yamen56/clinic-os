import { NextResponse } from "next/server";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { saveFile } from "@/lib/storage";
import { can } from "@/lib/auth";
import { isDicom } from "@/lib/imaging/dicom";
import { ingestImage } from "@/lib/imaging/ingest";
import { FILE_KINDS, type FileKind } from "@/lib/imaging/kinds";

const MAX_SIZE = 25 * 1024 * 1024;

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;

  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "patients");
  if (!g.ok) return g.res;
  const access = g.access;

  const form = await req.formData();
  const file = form.get("file");
  const kind = String(form.get("kind") ?? "other");
  if (!(file instanceof File)) return NextResponse.json({ error: "no_file" }, { status: 400 });
  // A photo of the insurance card is filed as insurance, so it takes the switch.
  if (kind === "insurance_card" && !can(access, "insurance")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (file.size > MAX_SIZE) return NextResponse.json({ error: "too_large" }, { status: 413 });

  const buf = Buffer.from(await file.arrayBuffer());

  /*
    A DICOM — from the imaging station's folder, or dropped here by hand —
    goes the way a machine's would: kept as it came, with a preview the
    browser can draw, and a whole series as one entry.
  */
  if (isDicom(buf)) {
    const r = await ingestImage(
      {
        clinicId: access.clinicId,
        from: { userId: access.session.user.id, impersonatedBy: access.session.impersonatedBy },
        fileName: file.name,
        mime: "application/dicom",
        data: buf,
        kind: (FILE_KINDS as readonly string[]).includes(kind) && kind !== "other" ? (kind as FileKind) : undefined,
        patientRef: id,
      },
      (fn) => inClinic(access, fn)
    );
    if (r.placed === "nowhere") {
      return NextResponse.json({ error: r.error }, { status: r.error === "series_elsewhere" ? 409 : 404 });
    }
    if (r.placed === "inbox") return NextResponse.json({ error: "series_in_inbox" }, { status: 409 });
    const f = await inClinic(access, async (c) =>
      (
        await c.query(
          `select id, file_name, mime_type, size_bytes, kind, created_at, teeth from patient_files where id = $1 and clinic_id = $2`,
          [r.fileId, access.clinicId]
        )
      ).rows[0]
    );
    return NextResponse.json({ ok: true, file: f, added: r.added });
  }

  const row = await inClinic(access, async (c) => {
    const p = await c.query(`select 1 from patients where id = $1 and clinic_id = $2`, [
      id,
      access.clinicId,
    ]);
    if (!p.rowCount) return null;
    const { storagePath, sizeBytes } = await saveFile(access.clinicId, `patients/${id}`, file.name, buf);
    const r = await c.query(
      `insert into patient_files (clinic_id, patient_id, uploaded_by, file_name, mime_type, size_bytes, storage_path, kind)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id, file_name, mime_type, size_bytes, kind, created_at`,
      [
        access.clinicId,
        id,
        access.session.user.id,
        file.name,
        file.type || "application/octet-stream",
        sizeBytes,
        storagePath,
        [...FILE_KINDS, "consent", "insurance_card"].includes(kind as FileKind) ? kind : "other",
      ]
    );
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "patient.file.upload",
      entity: "patient_file",
      entityId: r.rows[0].id,
      detail: { patientId: id, name: file.name },
    });
    return r.rows[0];
  });
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, file: row });
}
