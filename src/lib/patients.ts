import type { PoolClient } from "pg";
import { normalizePhone, type CountryCode } from "./phone";

/**
 * The patient identity rule: phone number is the single source of identity
 * within a clinic. Every creation path (staff, booking link, WhatsApp inbound,
 * AI agent) must go through here.
 */
export async function findPatientByPhone(
  c: PoolClient,
  clinicId: string,
  phoneE164: string
): Promise<{ id: string; full_name: string } | null> {
  const r = await c.query(
    `select id, full_name from patients
     where clinic_id = $1 and merged_into is null
       and (phone_e164 = $2 or secondary_phone_e164 = $2 or $2 = any(extra_phones))
     order by (phone_e164 = $2) desc
     limit 1`,
    [clinicId, phoneE164]
  );
  return r.rows[0] ?? null;
}

export async function findOrCreatePatient(
  c: PoolClient,
  clinicId: string,
  input: {
    phone: string;
    fullName?: string;
    whatsappName?: string;
    source: "staff" | "booking_link" | "whatsapp" | "ai_agent" | "import";
    status?: "lead" | "active";
    defaultCountry?: CountryCode;
  }
): Promise<{ id: string; created: boolean; phoneE164: string | null }> {
  const phoneE164 = normalizePhone(input.phone, input.defaultCountry ?? "JO");
  if (phoneE164) {
    const existing = await findPatientByPhone(c, clinicId, phoneE164);
    if (existing) {
      // Enrich the file rather than duplicating it
      if (input.whatsappName) {
        await c.query(
          `update patients set whatsapp_name = coalesce(whatsapp_name, $2) where id = $1`,
          [existing.id, input.whatsappName]
        );
      }
      return { id: existing.id, created: false, phoneE164 };
    }
  }
  const name = input.fullName?.trim() || input.whatsappName?.trim() || phoneE164 || input.phone;
  const r = await c.query(
    `insert into patients (clinic_id, full_name, phone_e164, whatsapp_name, source, status)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      clinicId,
      name,
      phoneE164,
      input.whatsappName ?? null,
      input.source,
      input.status ?? (input.source === "whatsapp" ? "lead" : "active"),
    ]
  );
  return { id: r.rows[0].id, created: true, phoneE164 };
}

/** Search by name or any phone format the user might type. */
export function patientSearchClause(
  q: string,
  paramOffset: number
): { clause: string; params: string[] } {
  const trimmed = q.trim();
  const phone = normalizePhone(trimmed);
  const digits = trimmed.replace(/\D/g, "");
  const parts: string[] = [`p.full_name ilike $${paramOffset}`];
  const params: string[] = [`%${trimmed}%`];
  if (phone) {
    parts.push(
      `(p.phone_e164 = $${paramOffset + params.length} or p.secondary_phone_e164 = $${paramOffset + params.length} or $${paramOffset + params.length} = any(p.extra_phones))`
    );
    params.push(phone);
  }
  if (digits.length >= 4) {
    parts.push(`p.phone_e164 like $${paramOffset + params.length}`);
    params.push(`%${digits.slice(-7)}%`);
  }
  return { clause: `(${parts.join(" or ")})`, params };
}
