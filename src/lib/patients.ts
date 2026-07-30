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

export type PatientFilters = {
  q?: string;
  tag?: string;
  source?: string;
  /** Days since last visit: "30" | "90" | "180". */
  visit?: string;
};

/**
 * The patient list's filters, as SQL over an aliased `patients p`.
 *
 * Shared with campaign audiences on purpose: a campaign is built from a filter
 * the user just previewed in the list, and "who did this actually go to?" must
 * have exactly one answer.
 */
export function patientFilterSql(
  clinicId: string,
  f: PatientFilters,
  /** First placeholder number to use, when the caller already has parameters. */
  paramOffset = 1
): { where: string; values: unknown[] } {
  const values: unknown[] = [clinicId];
  const n = () => paramOffset + values.length - 1;
  const conds = [`p.clinic_id = $${n()}`, "p.merged_into is null", "p.status <> 'archived'"];

  if (f.q?.trim()) {
    const { clause, params } = patientSearchClause(f.q, paramOffset + values.length);
    conds.push(clause);
    values.push(...params);
  }
  if (f.tag) {
    values.push(f.tag);
    conds.push(`$${n()} = any(p.tags)`);
  }
  if (f.source) {
    values.push(f.source);
    conds.push(`p.source = $${n()}`);
  }
  if (f.visit === "30" || f.visit === "90" || f.visit === "180") {
    conds.push(
      `(p.last_visit_at is null or p.last_visit_at < now() - interval '${Number(f.visit)} days')`
    );
  }
  return { where: conds.join(" and "), values };
}

/**
 * Search by name or any phone format the user might type.
 *
 * Names are matched through `ar_normalize` on both sides, so the spellings that
 * differ only by hamza, taa marbuta, alif maqsura or diacritics all find each
 * other — staff type أحمد as احمد and expect the file to come up. See
 * migrations/0009_arabic_search.sql.
 */
export function patientSearchClause(
  q: string,
  paramOffset: number
): { clause: string; params: string[] } {
  const trimmed = q.trim();
  const phone = normalizePhone(trimmed);
  const digits = trimmed.replace(/\D/g, "");
  const parts: string[] = [`ar_normalize(p.full_name) like ar_normalize($${paramOffset})`];
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
