import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { queueWhatsAppMessage } from "@/lib/outbound";
import { saveFile } from "@/lib/storage";

/**
 * Staff reply into a thread. Accepts JSON {body} or multipart with a file.
 * Manual replies pause the AI on this thread for the clinic's configured window.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const g = await apiClinic(slug);
  if (!g.ok) return g.res;
  const access = g.access;

  let text = "";
  let media: { buf: Buffer; name: string; mime: string } | null = null;
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    text = String(form.get("body") ?? "");
    const file = form.get("file");
    if (file instanceof File) {
      if (file.size > 16 * 1024 * 1024)
        return NextResponse.json({ error: "too_large" }, { status: 413 });
      media = {
        buf: Buffer.from(await file.arrayBuffer()),
        name: file.name,
        mime: file.type || "application/octet-stream",
      };
    }
  } else {
    const body = (await req.json().catch(() => ({}))) as { body?: string };
    text = String(body.body ?? "");
  }
  if (!text.trim() && !media) return NextResponse.json({ error: "empty" }, { status: 400 });

  const result = await inClinic(access, async (c) => {
    const conv = (
      await c.query(
        `select cv.phone_e164, cv.patient_id, cl.ai_paused_minutes
         from conversations cv join clinics cl on cl.id = cv.clinic_id
         where cv.id = $1 and cv.clinic_id = $2`,
        [id, access.clinicId]
      )
    ).rows[0];
    if (!conv) return null;

    let mediaPath: string | null = null;
    let msgType: "text" | "image" | "document" = "text";
    if (media) {
      const saved = await saveFile(access.clinicId, "wa-media", media.name, media.buf);
      mediaPath = saved.storagePath;
      msgType = media.mime.startsWith("image/") ? "image" : "document";
    }

    const q = await queueWhatsAppMessage(c, {
      clinicId: access.clinicId,
      phoneE164: conv.phone_e164,
      senderKind: "staff",
      senderUserId: access.session.user.id,
      body: text.trim(),
      msgType,
      mediaPath,
      mediaName: media?.name ?? null,
      mediaMime: media?.mime ?? null,
      patientId: conv.patient_id,
    });

    // Human replied — pause AI on this thread
    await c.query(
      `update conversations set ai_paused_until = now() + ($2 * interval '1 minute'), unread_count = 0
       where id = $1`,
      [id, conv.ai_paused_minutes ?? 30]
    );
    return q;
  });

  if (!result) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, messageId: result.messageId });
}
