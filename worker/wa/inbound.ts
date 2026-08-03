import {
  downloadMediaMessage,
  type WASocket,
  type WAMessage,
  type BaileysEventMap,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { withSystem } from "../db";
import { findPatientByPhone } from "../../src/lib/patients";
import { jidToE164 } from "../../src/lib/phone";
import { saveFile } from "../../src/lib/storage";

const logger = pino({ level: "silent" });

type Extracted = {
  msgType: "text" | "image" | "audio" | "document" | "video" | "sticker" | "location" | "unknown";
  body: string;
  mediaMime?: string;
  mediaName?: string;
  hasMedia: boolean;
};

function extract(msg: WAMessage): Extracted {
  const m = msg.message;
  if (!m) return { msgType: "unknown", body: "", hasMedia: false };
  if (m.conversation) return { msgType: "text", body: m.conversation, hasMedia: false };
  if (m.extendedTextMessage?.text)
    return { msgType: "text", body: m.extendedTextMessage.text, hasMedia: false };
  if (m.imageMessage)
    return {
      msgType: "image",
      body: m.imageMessage.caption ?? "",
      mediaMime: m.imageMessage.mimetype ?? "image/jpeg",
      hasMedia: true,
    };
  if (m.videoMessage)
    return {
      msgType: "video",
      body: m.videoMessage.caption ?? "",
      mediaMime: m.videoMessage.mimetype ?? "video/mp4",
      hasMedia: true,
    };
  if (m.audioMessage)
    return {
      msgType: "audio",
      body: "",
      mediaMime: m.audioMessage.mimetype ?? "audio/ogg",
      hasMedia: true,
    };
  if (m.documentMessage)
    return {
      msgType: "document",
      body: m.documentMessage.caption ?? "",
      mediaMime: m.documentMessage.mimetype ?? "application/octet-stream",
      mediaName: m.documentMessage.fileName ?? "document",
      hasMedia: true,
    };
  if (m.stickerMessage) return { msgType: "sticker", body: "", hasMedia: false };
  if (m.locationMessage)
    return {
      msgType: "location",
      body: `${m.locationMessage.degreesLatitude},${m.locationMessage.degreesLongitude}`,
      hasMedia: false,
    };
  return { msgType: "unknown", body: "", hasMedia: false };
}

export async function handleUpsert(
  clinicId: string,
  sock: WASocket,
  upsert: BaileysEventMap["messages.upsert"]
) {
  if (upsert.type !== "notify" && upsert.type !== "append") return;
  for (const msg of upsert.messages) {
    try {
      await handleOne(clinicId, sock, msg);
    } catch (e) {
      console.error(`[wa ${clinicId}] message failed`, (e as Error).message);
    }
  }
}

async function handleOne(clinicId: string, sock: WASocket, msg: WAMessage) {
  const jid = msg.key.remoteJid ?? "";
  if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast" || jid.endsWith("@newsletter")) return;

  /*
    WhatsApp addresses many chats by an opaque LID rather than a phone number.
    The digits in one look like a number and are not: matching them out and
    rebuilding <digits>@s.whatsapp.net produces an address nobody is at, and
    the send silently goes nowhere. Keep the LID as a LID, and keep the real
    JID so replies go back to where the message came from.
  */
  const isLid = jid.endsWith("@lid");
  const lid = isLid ? jid.split("@")[0] : null;
  const phone = isLid ? null : jidToE164(jid);
  // The identifier the conversation is keyed by. For a LID chat we do not know
  // the number yet — `chats.phoneNumberShare` and the contact list fill it in
  // later, and until then the LID stands in for it.
  const identifier = phone ?? (lid ? `+${lid}` : null);
  if (!identifier) return;

  const fromMe = !!msg.key.fromMe;
  const waId = msg.key.id ?? null;
  const ex = extract(msg);
  if (ex.msgType === "unknown" && !ex.body) return;

  let mediaPath: string | null = null;
  if (ex.hasMedia) {
    try {
      const buf = (await downloadMediaMessage(
        msg,
        "buffer",
        {},
        { logger, reuploadRequest: sock.updateMediaMessage }
      )) as Buffer;
      const ext = (ex.mediaMime ?? "").split("/")[1]?.split(";")[0] || "bin";
      const name = ex.mediaName || `${ex.msgType}.${ext}`;
      const saved = await saveFile(clinicId, "wa-media", name, buf);
      mediaPath = saved.storagePath;
    } catch (e) {
      console.error(`[wa ${clinicId}] media download failed`, (e as Error).message);
    }
  }

  await recordMessage(clinicId, {
    phone: identifier,
    jid,
    lid,
    dialable: phone !== null,
    fromMe,
    waId,
    msgType: ex.msgType,
    body: ex.body,
    mediaPath,
    mediaMime: ex.mediaMime ?? null,
    mediaName: ex.mediaName ?? null,
    pushName: fromMe ? null : (msg.pushName ?? null),
  });
}

/**
 * Threading core (also used by the dev simulate endpoint): identity rule,
 * conversation upsert, unread counts, inbound trigger.
 */
export async function recordMessage(
  clinicId: string,
  m: {
    /** What the conversation is keyed by — a real number, or a LID standing in. */
    phone: string;
    /** The address WhatsApp used, kept verbatim so replies go back to it. */
    jid?: string | null;
    lid?: string | null;
    /** False when `phone` is really a LID: nothing may dial or match on it. */
    dialable?: boolean;
    fromMe: boolean;
    waId: string | null;
    msgType: string;
    body: string;
    mediaPath: string | null;
    mediaMime: string | null;
    mediaName: string | null;
    pushName: string | null;
  }
) {
  const dialable = m.dialable ?? true;
  await withSystem(async (c) => {
    // Dedup (our own sends echo back through messages.upsert)
    if (m.waId) {
      const dup = await c.query(
        `select 1 from messages where clinic_id = $1 and wa_message_id = $2`,
        [clinicId, m.waId]
      );
      if (dup.rowCount) return;
    }

    /*
      Look the sender up, but never create them. A message is not a patient —
      the patient list is for people staff added, the AI booked, or who came
      through the booking link. Anyone else gets a conversation and nothing
      more, and becomes a patient the moment somebody decides they are one.
    */
    // A LID is not a number, so it cannot identify a patient. Only look one up
    // when we actually have something dialable.
    const existing = dialable ? await findPatientByPhone(c, clinicId, m.phone) : null;
    const patientId = existing?.id ?? null;
    if (patientId && m.pushName) {
      await c.query(
        `update patients set whatsapp_name = coalesce(whatsapp_name, $2) where id = $1`,
        [patientId, m.pushName]
      );
    }

    const conv = await c.query(
      `insert into conversations (clinic_id, phone_e164, patient_id, wa_jid, wa_lid,
                                  identifier_kind, whatsapp_name)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (clinic_id, phone_e164) do update
         set patient_id = coalesce(conversations.patient_id, excluded.patient_id),
             -- Always take the newest address: this is the one that works, and
             -- an older fabricated one is exactly what we are correcting.
             wa_jid = coalesce(excluded.wa_jid, conversations.wa_jid),
             wa_lid = coalesce(excluded.wa_lid, conversations.wa_lid),
             identifier_kind = excluded.identifier_kind,
             -- The thread's own name, so an unknown number is still a person.
             whatsapp_name = coalesce(conversations.whatsapp_name, excluded.whatsapp_name)
       returning id, ai_enabled, ai_paused_until`,
      [
        clinicId,
        m.phone,
        patientId,
        m.jid ?? `${m.phone.replace("+", "")}@s.whatsapp.net`,
        m.lid ?? null,
        dialable ? "phone" : "lid",
        m.pushName ?? null,
      ]
    );
    const convId = conv.rows[0].id as string;
    const preview = m.body ? m.body.slice(0, 120) : `[${m.msgType}]`;

    await c.query(
      `insert into messages (clinic_id, conversation_id, direction, sender_kind, wa_message_id,
                             msg_type, body, media_path, media_mime, media_name, status, sent_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())`,
      [
        clinicId,
        convId,
        m.fromMe ? "out" : "in",
        m.fromMe ? "staff" : "patient",
        m.waId,
        m.msgType,
        m.body,
        m.mediaPath,
        m.mediaMime,
        m.mediaName,
        m.fromMe ? "sent" : "delivered",
      ]
    );

    await c.query(
      `update conversations set
         last_message_at = now(), last_message_preview = $2, last_message_direction = $3,
         status = 'open',
         unread_count = unread_count + $4
       where id = $1`,
      [convId, preview, m.fromMe ? "out" : "in", m.fromMe ? 0 : 1]
    );

    if (!m.fromMe) {
      await c.query(
        `insert into jobs (clinic_id, kind, payload) values ($1, 'trigger:inbound_message', $2)`,
        [
          clinicId,
          JSON.stringify({
            conversationId: convId,
            // Null when the sender has no file yet; every consumer already
            // treats the patient as optional.
            patientId,
            body: m.body,
            msgType: m.msgType,
          }),
        ]
      );
    }
  });
}
