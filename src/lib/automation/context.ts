import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { appUrl } from "../urls";
import type { TemplateContext } from "./variables";

/**
 * What a run's messages can say, read once per run step-through.
 *
 * Formatted in the clinic's own language and timezone, as the patient reads it.
 * Every group is optional: a birthday has no appointment, an unknown number
 * writing in has no file yet, and a message that uses one anyway loses the line
 * rather than sending a gap (see renderMessage).
 */
export async function loadRunContext(
  c: PoolClient,
  ids: {
    clinicId: string;
    patientId?: string | null;
    appointmentId?: string | null;
    invoiceId?: string | null;
    documentId?: string | null;
    reply?: string | null;
  }
): Promise<TemplateContext> {
  const ctx: TemplateContext = {};
  const clinic = (
    await c.query(
      `select cl.name, cl.name_ar, cl.address, cl.address_ar, cl.phone_e164, cl.timezone, cl.default_locale,
              cl.google_maps_url, cl.google_review_url,
              (select b.slug from booking_links b where b.clinic_id = cl.id and b.active
                order by b.created_at limit 1) as booking_slug
         from clinics cl where cl.id = $1`,
      [ids.clinicId]
    )
  ).rows[0];
  if (!clinic) return ctx;
  const isAr = clinic.default_locale !== "en";
  const tz = clinic.timezone as string;
  const fmtLocale = isAr ? "ar-JO-u-nu-latn" : "en-GB";
  const local = (d: Date | string) => DateTime.fromJSDate(new Date(d)).setZone(tz).setLocale(fmtLocale);
  const today = DateTime.now().setZone(tz).startOf("day");

  ctx.clinic = {
    name: (isAr ? clinic.name_ar : null) || clinic.name || "",
    address: (isAr ? clinic.address_ar : null) || clinic.address || "",
    phone: clinic.phone_e164 || "",
    map_link: clinic.google_maps_url || "",
    review_link: clinic.google_review_url || "",
    booking_link: clinic.booking_slug ? `${appUrl()}/book/${clinic.booking_slug}` : "",
  };
  if (ids.reply) ctx.reply = { text: ids.reply };

  if (ids.patientId) {
    const p = (
      await c.query(`select full_name, phone_e164, file_no, birth_date from patients where id = $1`, [ids.patientId])
    ).rows[0];
    if (p) {
      const age = p.birth_date
        ? Math.floor(today.diff(DateTime.fromJSDate(new Date(p.birth_date)), "years").years)
        : null;
      ctx.patient = {
        name: p.full_name,
        first_name: String(p.full_name).trim().split(/\s+/)[0] ?? "",
        phone: p.phone_e164 ?? "",
        file_no: p.file_no != null ? String(p.file_no) : "",
        age: age != null && age >= 0 ? String(age) : "",
      };
      const next = (
        await c.query(
          `select a.starts_at, s.name as service_name, s.name_ar as service_name_ar
             from appointments a left join services s on s.id = a.service_id
            where a.patient_id = $1 and a.clinic_id = $2 and a.starts_at > now()
              and a.status in ('pending_approval', 'scheduled', 'confirmed')
            order by a.starts_at limit 1`,
          [ids.patientId, ids.clinicId]
        )
      ).rows[0];
      if (next) {
        const at = local(next.starts_at);
        ctx.next_appointment = {
          date: at.toFormat("cccc d LLLL"),
          time: at.toFormat("h:mm a"),
          service: (isAr ? next.service_name_ar : null) || next.service_name || "",
        };
      }
    }
  }

  if (ids.appointmentId) {
    const a = (
      await c.query(
        `select a.starts_at, a.ends_at, a.status, s.name as service_name, s.name_ar as service_name_ar,
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
      const at = local(a.starts_at);
      const days = Math.round(at.startOf("day").diff(today, "days").days);
      const day =
        days === 0 ? (isAr ? "اليوم" : "today") : days === 1 ? (isAr ? "غداً" : "tomorrow") : at.toFormat("cccc");
      ctx.appointment = {
        date: at.toFormat("cccc d LLLL"),
        time: at.toFormat("h:mm a"),
        day,
        end_time: a.ends_at ? local(a.ends_at).toFormat("h:mm a") : "",
        service: (isAr ? a.service_name_ar : null) || a.service_name || "",
        doctor: a.doctor_name ?? "",
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
        expires: d.expires_at ? local(d.expires_at).toFormat("d LLLL") : "",
      };
    }
  }

  if (ids.invoiceId) {
    const inv = (
      await c.query(`select number, total, amount_paid, currency, public_token from invoices where id = $1`, [
        ids.invoiceId,
      ])
    ).rows[0];
    if (inv) {
      const money = (n: number) => `${n.toFixed(2)} ${inv.currency}`;
      ctx.invoice = {
        number: inv.number,
        total: money(Number(inv.total)),
        paid: money(Number(inv.amount_paid)),
        balance: money(Math.max(0, Number(inv.total) - Number(inv.amount_paid))),
        link: `${appUrl()}/inv/${inv.public_token}`,
      };
    }
  }
  return ctx;
}
