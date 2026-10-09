import { NextResponse } from "next/server";
import sharp from "sharp";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { can } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { readFileBuffer, saveFile } from "@/lib/storage";
import { queueWhatsAppMessage } from "@/lib/outbound";

/*
  An x-ray or a photo, to the patient's own WhatsApp, from the chair.

  The imaging software on the clinic's PC cannot do this; it is the moment a
  patient sees the cavity the doctor is talking about, or keeps the panoramic
  for the specialist they are referred to. A copy goes out (as a JPEG,
  WhatsApp's own format for pictures), so deleting the file later never
  breaks the message.

  Two switches, because it is both a record and a message: the file's
  (`patients`) and the inbox's (`conversations`).
*/

const bodySchema = z.object({ caption: z.string().max(1000).default("") });

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; fileId: string }> }) {
  const { slug, fileId } = await ctx.params;
  if (!isUuid(fileId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "patients");
  if (!g.ok) return g.res;
  const access = g.access;
  if (!can(access, "conversations")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const row = await inClinic(access, async (c) =>
    (
      await c.query(
        `select f.storage_path, f.mime_type, f.file_name, f.kind, f.patient_id, p.phone_e164,
                (select status from whatsapp_sessions where clinic_id = f.clinic_id) as wa_status
           from patient_files f join patients p on p.id = f.patient_id
          where f.id = $1 and f.clinic_id = $2`,
        [fileId, access.clinicId]
      )
    ).rows[0]
  );
  if (!row || row.kind === "insurance_card") return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!String(row.mime_type).startsWith("image/")) return NextResponse.json({ error: "not_a_picture" }, { status: 415 });
  if (!row.phone_e164) return NextResponse.json({ error: "no_phone" }, { status: 409 });
  if (row.wa_status !== "connected") return NextResponse.json({ error: "whatsapp_not_connected" }, { status: 409 });

  const original = await readFileBuffer(row.storage_path);
  if (!original) return NextResponse.json({ error: "gone" }, { status: 410 });
  // A 3,000-pixel OPG as a PNG is several megabytes; WhatsApp would recompress it anyway.
  const jpeg = await sharp(original).rotate().resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true }).flatten({ background: "#000" }).jpeg({ quality: 88 }).toBuffer();
  const name = `${String(row.file_name).replace(/\.[a-z0-9]{1,5}$/i, "") || "image"}.jpg`;
  const saved = await saveFile(access.clinicId, "wa-media", name, jpeg);

  const sent = await inClinic(access, async (c) => {
    const q = await queueWhatsAppMessage(c, {
      clinicId: access.clinicId,
      phoneE164: row.phone_e164,
      senderKind: "staff",
      senderUserId: access.session.user.id,
      body: parsed.data.caption.trim(),
      msgType: "image",
      mediaPath: saved.storagePath,
      mediaName: name,
      mediaMime: "image/jpeg",
      patientId: row.patient_id,
    });
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "patient.file.whatsapp",
      entity: "patient_file",
      entityId: fileId,
      detail: { patientId: row.patient_id, messageId: q.messageId },
    });
    return q;
  });
  return NextResponse.json({ ok: true, messageId: sent.messageId, conversationId: sent.conversationId });
}
