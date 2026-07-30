import type { PoolClient } from "pg";
import { queueWhatsAppMessage } from "../outbound";
import { notifyClinicStaff, notifyUser } from "../notify";
import { logDocEvent } from "./events";
import { issueSigningToken } from "./tokens";
import { isStaffRole, markSent, type DocumentRow, type SignerRow } from "./documents";

/**
 * Getting the document to whoever has to sign it next.
 *
 * Patients get one WhatsApp message with one link, in their clinic's thread, so
 * the signed copy comes back to the same place afterwards. Staff get a push and
 * sign inside the workspace — no link is ever minted for them, because a link
 * is a bearer credential and a staff member already has an account.
 */

type Lang = "ar" | "en";

export function signRequestMessage(args: {
  lang: Lang;
  clinicName: string;
  patientFirstName: string;
  title: string;
  url: string;
}): string {
  return args.lang === "ar"
    ? `مرحباً ${args.patientFirstName}، من ${args.clinicName}.\n` +
        `لديك مستند بحاجة إلى توقيعك: ${args.title}\n` +
        `افتح الرابط لقراءته وتوقيعه — يستغرق أقل من دقيقة:\n${args.url}`
    : `Hi ${args.patientFirstName}, this is ${args.clinicName}.\n` +
        `You have a document to sign: ${args.title}\n` +
        `Open the link to read and sign it — it takes under a minute:\n${args.url}`;
}

export function reminderMessage(args: {
  lang: Lang;
  clinicName: string;
  patientFirstName: string;
  title: string;
  url: string;
}): string {
  return args.lang === "ar"
    ? `تذكير من ${args.clinicName}: ما زال المستند "${args.title}" بانتظار توقيعك.\n${args.url}`
    : `A reminder from ${args.clinicName}: "${args.title}" is still waiting for your signature.\n${args.url}`;
}

export function signedCopyMessage(args: { lang: Lang; clinicName: string; title: string }): string {
  return args.lang === "ar"
    ? `شكراً لك. هذه نسختك الموقّعة من "${args.title}" من ${args.clinicName}. احتفظ بها لسجلاتك.`
    : `Thank you. Here is your signed copy of "${args.title}" from ${args.clinicName}. Keep it for your records.`;
}

export function bundleMessage(args: {
  lang: Lang;
  clinicName: string;
  patientFirstName: string;
  items: { title: string; url: string }[];
}): string {
  const list = args.items.map((it, i) => `${i + 1}. ${it.title}\n${it.url}`).join("\n\n");
  return args.lang === "ar"
    ? `مرحباً ${args.patientFirstName}، من ${args.clinicName}.\n` +
        `لديك ${args.items.length} مستندات بحاجة إلى توقيعك. لكل واحد رابط خاص به:\n\n${list}`
    : `Hi ${args.patientFirstName}, this is ${args.clinicName}.\n` +
        `You have ${args.items.length} documents waiting for your signature. Each has its own link:\n\n${list}`;
}

export type ClinicDelivery = {
  id: string;
  name: string;
  name_ar: string | null;
  default_locale: Lang;
  esign_link_days: number;
  wa_connected: boolean;
};

export async function loadClinicDelivery(
  c: PoolClient,
  clinicId: string
): Promise<ClinicDelivery> {
  const r = await c.query(
    `select cl.id, cl.name, cl.name_ar, cl.default_locale, cl.esign_link_days,
            coalesce(ws.status = 'connected', false) as wa_connected
     from clinics cl left join whatsapp_sessions ws on ws.clinic_id = cl.id
     where cl.id = $1`,
    [clinicId]
  );
  return r.rows[0] as ClinicDelivery;
}

export function clinicDisplayName(clinic: ClinicDelivery, lang: Lang): string {
  return (lang === "ar" ? clinic.name_ar : null) || clinic.name;
}

export function firstName(full: string): string {
  return String(full ?? "").trim().split(/\s+/)[0] || "";
}

/**
 * Sends one signer their link.
 *
 * Returns what happened rather than throwing, because "this patient has no
 * WhatsApp number" is an ordinary state the UI has to show plainly — the brief
 * is explicit that it must not fail silently.
 */
export async function deliverToSigner(
  c: PoolClient,
  args: {
    clinic: ClinicDelivery;
    doc: DocumentRow;
    signer: SignerRow;
    senderUserId?: string | null;
    isReminder?: boolean;
  }
): Promise<{ sent: boolean; reason?: "staff" | "no_phone" | "wa_offline"; url?: string }> {
  const { clinic, doc, signer } = args;

  if (isStaffRole(signer.role_key) || signer.user_id) {
    // Staff sign in the workspace. Push, not a link.
    if (signer.user_id) {
      await notifyUser(c, signer.user_id, {
        clinicId: clinic.id,
        kind: "document_awaiting_signature",
        title: doc.language === "ar" ? "مستند بانتظار توقيعك" : "A document needs your signature",
        body: doc.title,
        url: `/c/${await clinicSlug(c, clinic.id)}/documents/${doc.id}?sign=${signer.id}`,
      });
    }
    return { sent: false, reason: "staff" };
  }

  if (!signer.phone_e164) return { sent: false, reason: "no_phone" };

  const { url } = await issueSigningToken(c, {
    clinicId: clinic.id,
    documentId: doc.id,
    signerId: signer.id,
    days: clinic.esign_link_days,
  });

  if (!clinic.wa_connected) {
    // The link exists and staff can copy it; the message cannot go out yet.
    return { sent: false, reason: "wa_offline", url };
  }

  const lang = doc.language;
  const body = args.isReminder
    ? reminderMessage({
        lang,
        clinicName: clinicDisplayName(clinic, lang),
        patientFirstName: firstName(signer.display_name),
        title: doc.title,
        url,
      })
    : signRequestMessage({
        lang,
        clinicName: clinicDisplayName(clinic, lang),
        patientFirstName: firstName(signer.display_name),
        title: doc.title,
        url,
      });

  await queueWhatsAppMessage(c, {
    clinicId: clinic.id,
    phoneE164: signer.phone_e164,
    senderKind: args.senderUserId ? "staff" : "system",
    senderUserId: args.senderUserId ?? null,
    body,
    patientId: doc.patient_id,
  });

  await logDocEvent(c, {
    clinicId: clinic.id,
    documentId: doc.id,
    signerId: signer.id,
    type: args.isReminder ? "reminder_sent" : "sent",
    actorUserId: args.senderUserId ?? null,
    actorKind: args.senderUserId ? "staff" : "system",
    metadata: { phone: signer.phone_e164 },
  });

  return { sent: true, url };
}

async function clinicSlug(c: PoolClient, clinicId: string): Promise<string> {
  const r = await c.query(`select slug from clinics where id = $1`, [clinicId]);
  return r.rows[0]?.slug ?? "";
}

/**
 * Puts a document into circulation: freezes the send timestamp and expiry, then
 * notifies whoever is due now.
 */
export async function dispatchDueSigners(
  c: PoolClient,
  args: {
    clinic: ClinicDelivery;
    doc: DocumentRow;
    due: SignerRow[];
    senderUserId?: string | null;
  }
): Promise<{ delivered: number; staff: number; noPhone: SignerRow[]; waOffline: boolean }> {
  await markSent(c, args.clinic.id, args.doc.id, args.clinic.esign_link_days);

  let delivered = 0;
  let staff = 0;
  let waOffline = false;
  const noPhone: SignerRow[] = [];

  for (const signer of args.due) {
    const r = await deliverToSigner(c, {
      clinic: args.clinic,
      doc: args.doc,
      signer,
      senderUserId: args.senderUserId,
    });
    if (r.sent) delivered++;
    else if (r.reason === "staff") staff++;
    else if (r.reason === "no_phone") noPhone.push(signer);
    else if (r.reason === "wa_offline") waOffline = true;
  }
  return { delivered, staff, noPhone, waOffline };
}

/** Reception hears about every patient signature and every decline. */
export async function notifyStaffOfSignerAction(
  c: PoolClient,
  args: {
    clinicId: string;
    clinicSlug: string;
    doc: { id: string; title: string };
    signerName: string;
    action: "signed" | "declined" | "completed";
    reason?: string | null;
  }
): Promise<void> {
  const titles: Record<typeof args.action, string> = {
    signed: `${args.signerName} signed "${args.doc.title}"`,
    declined: `${args.signerName} declined "${args.doc.title}"`,
    completed: `"${args.doc.title}" is fully signed`,
  };
  await notifyClinicStaff(c, args.clinicId, {
    kind: `document_${args.action}`,
    title: titles[args.action],
    body: args.reason ? `Reason: ${args.reason}` : "",
    url: `/c/${args.clinicSlug}/documents/${args.doc.id}`,
    roles: ["owner", "receptionist"],
  });
}
