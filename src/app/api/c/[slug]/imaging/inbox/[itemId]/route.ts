import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { openFile, deleteFiles } from "@/lib/storage";
import { fileResponseHeaders } from "@/lib/download";
import { fileInboxItem, storedPaths, type DicomRecord } from "@/lib/imaging/ingest";

type Params = { params: Promise<{ slug: string; itemId: string }> };

/** The picture, so a person can see whose x-ray it is before filing it. */
export async function GET(req: Request, ctx: Params) {
  const { slug, itemId } = await ctx.params;
  if (!isUuid(itemId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "patients");
  if (!g.ok) return g.res;
  const row = await inClinic(g.access, async (c) =>
    (
      await c.query(
        `select storage_path, file_name, mime_type from imaging_inbox
          where id = $1 and clinic_id = $2 and assigned_at is null and discarded_at is null`,
        [itemId, g.access.clinicId]
      )
    ).rows[0]
  );
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const f = await openFile(row.storage_path);
  if (!f) return NextResponse.json({ error: "gone" }, { status: 410 });
  return new NextResponse(new Uint8Array(f.data), {
    headers: fileResponseHeaders({
      declaredType: row.mime_type,
      fileName: row.file_name,
      size: f.size,
      wantsDownload: new URL(req.url).searchParams.has("download"),
    }),
  });
}

const bodySchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("file"),
    patientId: z.string().uuid(),
    teeth: z.array(z.string().regex(/^([1-8][1-8]|upper|lower|mouth)$/)).max(32).default([]),
  }),
  z.object({ op: z.literal("discard") }),
]);

/** File it to a patient, or throw it away (a test shot, a retake). */
export async function POST(req: Request, ctx: Params) {
  const { slug, itemId } = await ctx.params;
  if (!isUuid(itemId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "patients");
  if (!g.ok) return g.res;
  const access = g.access;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const b = parsed.data;

  if (b.op === "file") {
    const r = await inClinic(access, (c) =>
      fileInboxItem(c, {
        clinicId: access.clinicId,
        inboxId: itemId,
        patientId: b.patientId,
        teeth: b.teeth,
        userId: access.session.user.id,
        impersonatedBy: access.session.impersonatedBy,
      })
    );
    if ("error" in r) return NextResponse.json({ error: r.error }, { status: 404 });
    return NextResponse.json({ ok: true, fileId: r.fileId, patientId: r.patientId });
  }

  const gone = await inClinic(access, async (c) => {
    const r = await c.query(
      `update imaging_inbox set discarded_at = now(), discarded_by = $3
        where id = $1 and clinic_id = $2 and assigned_at is null and discarded_at is null
        returning storage_path, dicom, file_name`,
      [itemId, access.clinicId, access.session.user.id]
    );
    if (!r.rowCount) return null;
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "imaging.inbox.discard",
      entity: "imaging_inbox",
      entityId: itemId,
      detail: { name: r.rows[0].file_name },
    });
    return r.rows[0] as { storage_path: string; dicom: DicomRecord | null };
  });
  if (!gone) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await deleteFiles(storedPaths(gone));
  return NextResponse.json({ ok: true });
}
