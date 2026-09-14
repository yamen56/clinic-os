import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { saveFile, openFile, deleteFile } from "@/lib/storage";
import { fileResponseHeaders } from "@/lib/download";
import { audit } from "@/lib/audit";

/**
 * The bill behind an expense.
 *
 * An API route rather than a server action for the reason the patient-files
 * upload is one: a server action cannot take a `File` cleanly, and the size cap
 * wants a real status code rather than a thrown error.
 */
const MAX_SIZE = 10 * 1024 * 1024;

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  // The same capability as the screen. The nav hides what a member may not
  // reach and the page redirects them, but neither stands between a request and
  // the database — only this does.
  const g = await apiClinic(slug, "expenses");
  if (!g.ok) return g.res;
  const access = g.access;

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "no_file" }, { status: 400 });
  if (file.size > MAX_SIZE) return NextResponse.json({ error: "too_large" }, { status: 413 });

  const buf = Buffer.from(await file.arrayBuffer());

  const row = await inClinic(access, async (c) => {
    // The parent, checked by hand: the id in the URL is the caller's to choose.
    const own = await c.query(
      `select receipt_path from expenses where id = $1 and clinic_id = $2`,
      [id, access.clinicId]
    );
    if (!own.rowCount) return null;

    const saved = await saveFile(access.clinicId, `expenses/${id}`, file.name, buf);
    const prev = own.rows[0].receipt_path as string | null;

    const r = await c.query(
      `update expenses set receipt_path = $3, receipt_name = $4, receipt_mime = $5
        where id = $1 and clinic_id = $2
        returning id`,
      [id, access.clinicId, saved.storagePath, file.name, file.type || "application/octet-stream"]
    );

    /*
      Replacing a receipt removes the one it replaced, and only once the row
      points at the new bytes — the same order the patient-file delete uses, so
      a failure leaves a file nobody references rather than a row pointing at
      nothing.
    */
    if (prev && r.rowCount) await deleteFile(prev);

    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "expense.receipt",
      entity: "expense",
      entityId: id,
      detail: { name: file.name, replaced: !!prev },
    });
    return r.rows[0] ?? null;
  });

  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function GET(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const g = await apiClinic(slug, "expenses");
  if (!g.ok) return g.res;

  const meta = await inClinic(g.access, async (c) => {
    const r = await c.query(
      `select receipt_path, receipt_name, receipt_mime from expenses
        where id = $1 and clinic_id = $2`,
      [id, g.access.clinicId]
    );
    return r.rows[0] ?? null;
  });
  if (!meta?.receipt_path) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const f = await openFile(meta.receipt_path);
  // The row survives its bytes: 404 means there was never a receipt, 410 means
  // there was and it is gone.
  if (!f) return NextResponse.json({ error: "gone" }, { status: 410 });

  /*
    Through `fileResponseHeaders`, which is where the safety is. The stored type
    came from the uploader's browser and decides nothing on its own — anything
    off the inline allowlist is served as an attachment with `nosniff`, which is
    what keeps an `image/svg+xml` "receipt" from being a scripting document.
  */
  return new NextResponse(new Uint8Array(f.data), {
    headers: fileResponseHeaders({
      declaredType: (meta.receipt_mime as string) || "application/octet-stream",
      fileName: (meta.receipt_name as string) || "receipt",
      size: f.size,
      wantsDownload: new URL(req.url).searchParams.has("download"),
    }),
  });
}
