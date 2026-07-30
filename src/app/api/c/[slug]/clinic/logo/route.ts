import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { saveFile, deleteFile } from "@/lib/storage";
import { audit } from "@/lib/audit";
import { can } from "@/lib/auth";

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug);
  if (!g.ok) return g.res;
  if (!can(g.access, "settings.clinic")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "no_file" }, { status: 400 });
  if (file.size > 2 * 1024 * 1024) return NextResponse.json({ error: "too_large" }, { status: 413 });
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    return NextResponse.json({ error: "bad_type" }, { status: 415 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";

  return inClinic(g.access, async (c) => {
    const old = (await c.query(`select logo_path from clinics where id = $1`, [g.access.clinicId]))
      .rows[0]?.logo_path;
    const { storagePath } = await saveFile(g.access.clinicId, "branding", `logo.${ext}`, buf);
    await c.query(`update clinics set logo_path = $2 where id = $1`, [g.access.clinicId, storagePath]);
    if (old) await deleteFile(old);
    await audit(c, {
      clinicId: g.access.clinicId,
      userId: g.access.session.user.id,
      impersonatedBy: g.access.session.impersonatedBy,
      action: "clinic.logo.update",
      entity: "clinic",
      entityId: g.access.clinicId,
    });
    return NextResponse.json({ ok: true });
  });
}
