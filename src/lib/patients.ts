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
): Promise<{ id: string; full_name: string; status: string } | null> {
  const r = await c.query(
    `select id, full_name, status from patients
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
    /**
     * Staff are deliberately re-creating a file, so an archived one is brought
     * back and takes the details they just typed. Off by default: see the
     * comment at the call below for why this is the caller's decision.
     */
    restoreArchived?: boolean;
  }
): Promise<{ id: string; created: boolean; restored: boolean; phoneE164: string | null }> {
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
      /*
        Somebody typing a name and a number into "new patient" for a file they
        had archived is re-creating that patient, not navigating to them: the
        archive comes off and the details they just typed win. Returning the old
        record unchanged is what made this look broken — the file stayed out of
        the list and still carried the previous name.

        Two things this deliberately does not do. An *active* file is somebody's
        live record and is never renamed underneath them, because the same
        number reappearing usually means the same person, not a correction. And
        an inbound WhatsApp message never resurrects a file the clinic archived
        on purpose, which is why this is a flag the caller sets rather than
        something that happens by itself.
      */
      let restored = false;
      if (input.restoreArchived && existing.status === "archived") {
        await c.query(
          `update patients set status = 'active', full_name = coalesce($2, full_name)
            where id = $1`,
          [existing.id, input.fullName?.trim() || null]
        );
        restored = true;
      }
      return { id: existing.id, created: false, restored, phoneE164 };
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
  return { id: r.rows[0].id, created: true, restored: false, phoneE164 };
}

export type PatientFilters = {
  q?: string;
  tag?: string;
  source?: string;
  /** Days since last visit: "30" | "90" | "180". */
  visit?: string;
  /**
   * Only patients muted from automations and campaigns ("1").
   *
   * One-way on purpose: the question staff ask is "who did we stop messaging",
   * never "who is still on the list", and the second is just the list.
   */
  optedOut?: string;
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
  if (f.optedOut === "1") conds.push("p.automation_opt_out");
  return { where: conds.join(" and "), values };
}

/**
 * How many patients one page of the list carries.
 *
 * The list used to stop here full stop — `limit 100` with no paging, so on a
 * clinic with thousands of files everyone past the hundredth was reachable only
 * by searching for them by name. Now it is a page size, and there is a page
 * after it.
 */
export const PATIENT_PAGE_SIZE = 100;

/**
 * The list's row select, shared by the first render and by "load more".
 *
 * One definition, because the two must agree about the columns, the order and
 * the tiebreak — and a keyset cursor that disagrees with the ORDER BY by one
 * column silently repeats and skips records rather than failing.
 *
 * **Ordered by `created_at desc, id desc`, and the tiebreak is not decoration.**
 * The order used to be `updated_at desc`, which cannot be paged over at all
 * here: every table in this schema carries a touch trigger, so `updated_at`
 * means "last written to by anything" and an overnight automation stamping a
 * field reorders the list underneath whoever is reading it. `created_at` is
 * never rewritten. The id then gives two files created in the same millisecond
 * one definite order, without which the cursor can drop whichever row the
 * planner happened to put second.
 *
 * Matches `patients_list_idx` (0058) exactly, including the two conditions
 * `patientFilterSql` always applies.
 *
 * @param where        from `patientFilterSql`
 * @param cursorParam  placeholder number for the cursor's timestamp; the id
 *                     follows it. Null for the first page.
 */
export function patientListRowsSql(where: string, cursorParam: number | null): string {
  const after =
    cursorParam === null
      ? ""
      : ` and (p.created_at, p.id) < ($${cursorParam}::timestamptz, $${cursorParam + 1}::uuid)`;
  return `select p.id, p.full_name, p.phone_e164, p.tags, p.source, p.status,
                 p.last_visit_at, p.automation_opt_out,
                 /*
                   As text, and this is not cosmetic — it is the difference
                   between paging that works and paging that silently loses
                   records.

                   Postgres stores a timestamptz to the microsecond; node-pg
                   hands it back as a JavaScript Date, which only has
                   milliseconds. Send that value back as the cursor and it is a
                   rounded version of the row's real timestamp, so the next page
                   starts in the wrong place and everything between the two
                   values is skipped — invisibly, because the page still looks
                   full and the patients that vanished were never on screen to
                   be missed. qa-patient-paging caught 49 of 237 going missing
                   this way.

                   ::text round-trips exactly through $n::timestamptz.
                 */
                 p.created_at::text as created_at,
                 (select a.starts_at from appointments a
                   where a.patient_id = p.id and a.starts_at > now()
                     and a.status not in ('cancelled')
                   order by a.starts_at limit 1) as next_appointment
            from patients p
           where ${where}${after}
           order by p.created_at desc, p.id desc
           limit ${PATIENT_PAGE_SIZE}`;
}

/** One list row, as both the page and the "load more" route return it. */
export type PatientListRow = {
  id: string;
  fullName: string;
  phone: string;
  tags: string[];
  source: string;
  status: string;
  lastVisitAt: string | null;
  createdAt: string;
  nextAppointment: string | null;
  mutedFromAutomations: boolean;
};

/** The one place a row from `patientListRowsSql` becomes a `PatientListRow`. */
export function toPatientListRow(r: Record<string, unknown>): PatientListRow {
  return {
    id: r.id as string,
    fullName: r.full_name as string,
    phone: r.phone_e164 as string,
    tags: (r.tags ?? []) as string[],
    source: r.source as string,
    status: r.status as string,
    lastVisitAt: r.last_visit_at ? String(r.last_visit_at) : null,
    createdAt: String(r.created_at),
    nextAppointment: r.next_appointment ? String(r.next_appointment) : null,
    mutedFromAutomations: Boolean(r.automation_opt_out),
  };
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
