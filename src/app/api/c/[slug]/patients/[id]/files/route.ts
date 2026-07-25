import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { saveFile } from "@/lib/storage";

const MAX_SIZE = 25 * 1024 * 1024;

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const g = await apiClinic(slug);
  if (!g.ok) return g.res;
  const access = g.access;

  const form = await req.formData();
  const file = form.get("file");
  const kind = String(form.get("kind") ?? "other");
  if (!(file instanceof File)) return NextResponse.json({ error: "no_file" }, { status: 400 });
  if (file.size > MAX_SIZE) return NextResponse.json({ error: "too_large" }, { status: 413 });

  const buf = Buffer.from(await file.arrayBuffer());

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
        ["xray", "lab", "consent", "photo", "other"].includes(kind) ? kind : "other",
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
