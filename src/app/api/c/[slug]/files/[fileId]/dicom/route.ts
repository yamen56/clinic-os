import { NextResponse } from "next/server";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { auditView } from "@/lib/audit";
import { readFileBuffer } from "@/lib/storage";
import { zipStore } from "@/lib/zip-store";
import type { DicomRecord } from "@/lib/imaging/ingest";

/*
  The DICOM originals behind a file — what a CBCT viewer, an implant planner
  or a specialist on referral actually needs, rather than the preview. One
  instance comes back as itself; a series as a ZIP, one .dcm a slice, in the
  order the machine numbered them.
*/

/** What one download may gather into memory. A larger study goes slice by slice from the relay. */
const MAX_ZIP = 600 * 1024 * 1024;

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; fileId: string }> }) {
  const { slug, fileId } = await ctx.params;
  if (!isUuid(fileId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "patients");
  if (!g.ok) return g.res;

  const row = await inClinic(g.access, async (c) => {
    const r = await c.query(
      `select file_name, patient_id, dicom from patient_files where id = $1 and clinic_id = $2 and dicom is not null`,
      [fileId, g.access.clinicId]
    );
    if (r.rows[0]) {
      await auditView(c, {
        clinicId: g.access.clinicId,
        userId: g.access.session.user.id,
        impersonatedBy: g.access.session.impersonatedBy,
        action: "patient.file.dicom",
        entity: "patient_file",
        entityId: fileId,
        detail: { patientId: r.rows[0].patient_id },
      });
    }
    return r.rows[0] as { file_name: string; dicom: DicomRecord } | undefined;
  });
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const instances = [...row.dicom.instances].sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
  const total = instances.reduce((n, i) => n + i.size, 0);
  if (total > MAX_ZIP) return NextResponse.json({ error: "too_large" }, { status: 413 });
  const base = row.file_name.replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[^\w .()-]+/g, "_").slice(0, 80) || "dicom";

  if (instances.length === 1) {
    const data = await readFileBuffer(instances[0].path);
    if (!data) return NextResponse.json({ error: "gone" }, { status: 410 });
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": "application/dicom",
        "Content-Disposition": `attachment; filename="${base}.dcm"`,
        "Content-Length": String(data.length),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  }

  // Sixteen reads at a time: a 400-slice CBCT one by one is a minute of waiting on R2.
  const datas: (Buffer | null)[] = [];
  for (let i = 0; i < instances.length; i += 16) {
    datas.push(...(await Promise.all(instances.slice(i, i + 16).map((inst) => readFileBuffer(inst.path)))));
  }
  const entries = datas.flatMap((data, i) => (data ? [{ name: `${base}/${String(i + 1).padStart(4, "0")}.dcm`, data }] : []));
  if (!entries.length) return NextResponse.json({ error: "gone" }, { status: 410 });
  const zip = zipStore(entries);
  return new NextResponse(new Uint8Array(zip), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${base}.zip"`,
      "Content-Length": String(zip.length),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
