import { DateTime } from "luxon";
import type { PoolClient } from "pg";

export type TemplateContext = Record<string, Record<string, string>>;

/**
 * Loads the {{variable}} context for an automation run:
 * patient.*, clinic.*, appointment.*, doctor.*, invoice.*
 */
export async function loadContext(
  c: PoolClient,
  ids: {
    clinicId: string;
    patientId?: string | null;
    appointmentId?: string | null;
    invoiceId?: string | null;
    documentId?: string | null;
  }
): Promise<TemplateContext> {
  const ctx: TemplateContext = {};
  const clinic = (
    await c.query(
      `select name, name_ar, address, address_ar, phone_e164, timezone, default_locale from clinics where id = $1`,
      [ids.clinicId]
    )
  ).rows[0];
  const isAr = clinic.default_locale !== "en";
  const tz = clinic.timezone as string;
  const fmtLocale = isAr ? "ar-JO-u-nu-latn" : "en-GB";
  ctx.clinic = {
    name: (isAr ? clinic.name_ar : null) || clinic.name || "",
    address: (isAr ? clinic.address_ar : null) || clinic.address || "",
    phone: clinic.phone_e164 || "",
  };

  if (ids.patientId) {
    const p = (
      await c.query(`select full_name, phone_e164 from patients where id = $1`, [ids.patientId])
    ).rows[0];
    if (p) {
      ctx.patient = {
        name: p.full_name,
        first_name: String(p.full_name).trim().split(/\s+/)[0] ?? "",
        phone: p.phone_e164 ?? "",
      };
    }
  }

  if (ids.appointmentId) {
    const a = (
      await c.query(
        `select a.starts_at, a.status, s.name as service_name, s.name_ar as service_name_ar,
                u.full_name as doctor_name
         from appointments a
         left join services s on s.id = a.service_id
         left join clinic_members cm on cm.id = a.doctor_member_id
         left join users u on u.id = cm.user_id
         where a.id = $1`,
        [ids.appointmentId]
      )
    ).rows[0];
    if (a) {
      const local = DateTime.fromJSDate(new Date(a.starts_at)).setZone(tz).setLocale(fmtLocale);
      ctx.appointment = {
        date: local.toFormat("cccc d LLLL"),
        time: local.toFormat("h:mm a"),
        service: (isAr ? a.service_name_ar : null) || a.service_name || "",
        status: a.status,
      };
      ctx.doctor = { name: a.doctor_name ?? "" };
    }
  }

  if (ids.documentId) {
    const d = (
      await c.query(`select title, status, expires_at from documents where id = $1`, [ids.documentId])
    ).rows[0];
    if (d) {
      ctx.document = {
        title: d.title,
        status: d.status,
        expires: d.expires_at
          ? DateTime.fromJSDate(new Date(d.expires_at)).setZone(tz).setLocale(fmtLocale).toFormat("d LLLL")
          : "",
      };
    }
  }

  if (ids.invoiceId) {
    const inv = (
      await c.query(`select number, total, currency, public_token from invoices where id = $1`, [
        ids.invoiceId,
      ])
    ).rows[0];
    if (inv) {
      ctx.invoice = {
        number: inv.number,
        total: `${Number(inv.total).toFixed(2)} ${inv.currency}`,
        link: `${process.env.APP_URL || "http://localhost:3000"}/inv/${inv.public_token}`,
      };
    }
  }
  return ctx;
}

/** Replaces {{group.key}} tokens; unknown tokens become empty strings. */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const [group, key] = path.split(".");
    return ctx[group]?.[key] ?? "";
  });
}
