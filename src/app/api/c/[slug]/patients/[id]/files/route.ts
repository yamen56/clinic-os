import { NextResponse } from "next/server";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { saveFile } from "@/lib/storage";
import { can } from "@/lib/auth";
import { isDicom } from "@/lib/imaging/dicom";
import { ingestImage } from "@/lib/imaging/ingest";
import { FILE_KINDS, isFileView, kindOfView, type FileKind } from "@/lib/imaging/kinds";

const MAX_SIZE = 25 * 1024 * 1024;

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;

  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "patients");
  if (!g.ok) return g.res;
  const access = g.access;

  const form = await req.formData();
  const file = form.get("file");
  /*
    What it shows (a panoramic, a bitewing…), the teeth it is of, and the
    picture it is an edited copy of — sent by the viewer's Save (2026-11-02).
    A view says the kind as well.
  */
  const viewRaw = form.get("view");
  const view = isFileView(viewRaw) ? viewRaw : null;
  const kind = view ? kindOfView(view) : String(form.get("kind") ?? "other");
  const teeth = String(form.get("teeth") ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => /^[1-8][1-8]$/.test(x));
  const editedFromRaw = String(form.get("editedFrom") ?? "");
  const editedFrom = isUuid(editedFromRaw) ? editedFromRaw : null;
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
          `select id, file_name, mime_type, size_bytes, kind, created_at, teeth, view, edited_from from patient_files where id = $1 and clinic_id = $2`,
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
      `insert into patient_files (clinic_id, patient_id, uploaded_by, file_name, mime_type, size_bytes, storage_path, kind, view, teeth, edited_from)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               -- An edited copy points at its original — only one of this patient's own.
               (select id from patient_files where id = $11::uuid and clinic_id = $1 and patient_id = $2))
       returning id, file_name, mime_type, size_bytes, kind, created_at, view, teeth, edited_from`,
      [
        access.clinicId,
        id,
        access.session.user.id,
        file.name,
        file.type || "application/octet-stream",
        sizeBytes,
        storagePath,
        [...FILE_KINDS, "consent", "insurance_card"].includes(kind as FileKind) ? kind : "other",
        view,
        [...new Set(teeth)].sort(),
        editedFrom,
      ]
    );
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "patient.file.upload",
      entity: "patient_file",
      entityId: r.rows[0].id,
      detail: { patientId: id, name: file.name, ...(editedFrom ? { editedFrom } : {}) },
    });
    return r.rows[0];
  });
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, file: row });
}
