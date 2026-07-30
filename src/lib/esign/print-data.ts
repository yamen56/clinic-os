import { DateTime } from "luxon";
import { withSystem } from "../db";
import { readFileBuffer } from "../storage";
import { describeDevice } from "./events";
import { shortHash } from "./render";

/**
 * Everything the printed PDF shows, assembled in one place so the on-screen
 * preview and the file that gets filed in the patient's record cannot drift
 * apart.
 */

export type PrintSigner = {
  id: string;
  roleKey: string;
  roleLabel: string;
  roleLabelAr: string;
  name: string;
  phone: string | null;
  relationship: string | null;
  status: string;
  method: "in_clinic" | "remote" | "staff";
  signedAtUtc: string | null;
  signedAtLocal: string | null;
  openedAt: string | null;
  ip: string | null;
  device: string;
  witnessName: string | null;
  typedName: string | null;
  /** Inlined so the print page needs no second authenticated request. */
  signatureDataUrl: string | null;
  declineReason: string | null;
  answers: Record<string, unknown>;
};

export type PrintDocument = {
  id: string;
  clinicId: string;
  title: string;
  language: "ar" | "en";
  status: string;
  source: "template" | "upload";
  snapshot: string;
  hash: string;
  hashShort: string;
  voidReason: string | null;
  createdAt: string;
  completedAt: string | null;
  timezone: string;
  clinic: {
    name: string;
    nameAr: string | null;
    slug: string;
    logoPath: string | null;
    brandColor: string;
    address: string | null;
    addressAr: string | null;
    phone: string | null;
    invoiceFooter: string;
  };
  patientName: string | null;
  signers: PrintSigner[];
  /** Placed boxes, for the uploaded-PDF overlay. */
  placedFields: {
    id: string;
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
    fieldType: string;
    roleKey: string;
    label: string;
    value: string | null;
    signatureDataUrl: string | null;
  }[];
  pageCount: number;
};

function fmt(iso: string | null, zone: string, locale: string): string | null {
  if (!iso) return null;
  return DateTime.fromJSDate(new Date(iso))
    .setZone(zone)
    .setLocale(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB")
    .toFormat("d LLL yyyy · HH:mm");
}

async function inlineSignature(path: string | null): Promise<string | null> {
  if (!path) return null;
  const buf = await readFileBuffer(path);
  if (!buf) return null;
  return `data:image/png;base64,${buf.toString("base64")}`;
}

export async function loadPrintDocument(documentId: string): Promise<PrintDocument | null> {
  const data = await withSystem(async (c) => {
    const doc = (
      await c.query(
        `select d.*, cl.name, cl.name_ar, cl.slug, cl.logo_path, cl.brand_color, cl.address,
                cl.address_ar, cl.phone_e164 as clinic_phone, cl.timezone, cl.invoice_footer,
                p.full_name as patient_name
         from documents d
         join clinics cl on cl.id = d.clinic_id
         left join patients p on p.id = d.patient_id
         where d.id = $1`,
        [documentId]
      )
    ).rows[0];
    if (!doc) return null;

    const signers = (
      await c.query(
        `select s.*, r.label as role_label, r.label_ar as role_label_ar, w.full_name as witness_name
         from document_signers s
         left join signer_roles r on r.clinic_id = s.clinic_id and r.key = s.role_key
         left join users w on w.id = s.witnessed_by_user_id
         where s.document_id = $1
         order by s.signing_order, s.created_at`,
        [documentId]
      )
    ).rows;

    const fields = (
      await c.query(
        `select f.*, s.signature_png_path, s.display_name, s.signed_at
         from document_fields f
         left join document_signers s
           on s.document_id = f.document_id and s.role_key = f.assigned_role_key
         where f.document_id = $1
         order by f.page_number, f.sort`,
        [documentId]
      )
    ).rows;

    return { doc, signers, fields };
  });
  if (!data) return null;
  const { doc, signers, fields } = data;

  const locale = doc.language as "ar" | "en";
  const tz = doc.timezone as string;

  const printSigners: PrintSigner[] = await Promise.all(
    signers.map(async (s) => ({
      id: s.id,
      roleKey: s.role_key,
      roleLabel: s.role_label ?? s.role_key,
      roleLabelAr: s.role_label_ar ?? s.role_label ?? s.role_key,
      name: s.display_name,
      phone: s.phone_e164,
      relationship: s.relationship,
      status: s.status,
      method: s.signed_in_person ? "in_clinic" : s.user_id ? "staff" : "remote",
      signedAtUtc: s.signed_at
        ? DateTime.fromJSDate(new Date(s.signed_at)).toUTC().toFormat("yyyy-LL-dd HH:mm:ss 'UTC'")
        : null,
      signedAtLocal: fmt(s.signed_at, tz, locale),
      openedAt: fmt(s.link_opened_at ?? s.viewed_at, tz, locale),
      ip: s.ip_address,
      device: describeDevice(s.user_agent),
      witnessName: s.witness_name,
      typedName: s.typed_name,
      signatureDataUrl: await inlineSignature(s.signature_png_path),
      declineReason: s.decline_reason,
      answers: (s.field_answers ?? {}) as Record<string, unknown>,
    }))
  );

  const placedFields = await Promise.all(
    fields.map(async (f) => ({
      id: f.id,
      page: f.page_number as number,
      x: Number(f.x),
      y: Number(f.y),
      width: Number(f.width),
      height: Number(f.height),
      fieldType: f.field_type as string,
      roleKey: f.assigned_role_key as string,
      label: f.label as string,
      value:
        f.field_type === "date" && f.signed_at
          ? fmt(f.signed_at, tz, locale)
          : (f.value ?? f.prefilled_value ?? null),
      signatureDataUrl:
        f.field_type === "signature" || f.field_type === "initials"
          ? await inlineSignature(f.signature_png_path)
          : null,
    }))
  );

  return {
    id: doc.id,
    clinicId: doc.clinic_id,
    title: doc.title,
    language: locale,
    status: doc.status,
    source: doc.source,
    snapshot: doc.content_snapshot ?? "",
    hash: doc.content_hash ?? "",
    hashShort: doc.content_hash ? shortHash(doc.content_hash) : "—",
    voidReason: doc.void_reason,
    createdAt: fmt(doc.created_at, tz, locale) ?? "",
    completedAt: fmt(doc.completed_at, tz, locale),
    timezone: tz,
    clinic: {
      name: doc.name,
      nameAr: doc.name_ar,
      slug: doc.slug,
      logoPath: doc.logo_path,
      brandColor: doc.brand_color,
      address: doc.address,
      addressAr: doc.address_ar,
      phone: doc.clinic_phone,
      invoiceFooter: doc.invoice_footer ?? "",
    },
    patientName: doc.patient_name ?? null,
    signers: printSigners,
    placedFields,
    pageCount: placedFields.reduce((m, f) => Math.max(m, f.page), 1),
  };
}

/** Certificate wording, in both languages. */
export const CERT_LABELS = {
  ar: {
    title: "شهادة إتمام التوقيع",
    subtitle: "سجل تدقيق إلكتروني لهذا المستند",
    document: "المستند",
    docHash: "بصمة المستند (SHA-256)",
    created: "أُنشئ في",
    completed: "اكتمل في",
    signers: "الموقّعون",
    role: "الصفة",
    name: "الاسم",
    phone: "رقم الاستلام",
    method: "طريقة التوقيع",
    inClinic: "في العيادة",
    remote: "عن بُعد",
    staff: "من داخل النظام",
    opened: "فتح الرابط",
    signedAt: "وقت التوقيع",
    ip: "عنوان IP",
    device: "الجهاز",
    witness: "بحضور",
    typed: "وقّع باسمه المكتوب",
    declined: "رفض التوقيع",
    reason: "السبب",
    notSigned: "لم يوقّع",
    guardianOf: "ولي أمر",
    voided: "ملغى",
    voidReason: "سبب الإلغاء",
    footer:
      "أُنشئت هذه الشهادة تلقائياً ولا يمكن تعطيلها. أي تعديل على محتوى المستند بعد تجميده يُبطل بصمته أعلاه.",
    tzNote: "الأوقات بتوقيت",
  },
  en: {
    title: "Certificate of Completion",
    subtitle: "Electronic audit record for this document",
    document: "Document",
    docHash: "Document fingerprint (SHA-256)",
    created: "Created",
    completed: "Completed",
    signers: "Signers",
    role: "Role",
    name: "Name",
    phone: "Delivered to",
    method: "Method",
    inClinic: "In clinic",
    remote: "Remote link",
    staff: "In workspace",
    opened: "Link opened",
    signedAt: "Signed at",
    ip: "IP address",
    device: "Device",
    witness: "Witnessed by",
    typed: "Signed by typing their name",
    declined: "Declined to sign",
    reason: "Reason",
    notSigned: "Not signed",
    guardianOf: "Guardian",
    voided: "VOID",
    voidReason: "Void reason",
    footer:
      "This certificate is generated automatically and cannot be disabled. Any change to the document content after it was frozen invalidates the fingerprint above.",
    tzNote: "Times shown in",
  },
} as const;
