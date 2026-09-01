"use server";

import { revalidatePath } from "next/cache";
import { can, requireClinic } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { normalizePhone, countryFromClinic, type CountryCode } from "@/lib/phone";
import { findPatientByPhone } from "@/lib/patients";
import {
  parseDelimited,
  guessMapping,
  readGender,
  readDate,
  type ImportField,
} from "@/lib/import/parse";

/**
 * Bringing a clinic's existing patients in.
 *
 * Two steps on purpose. Nobody should discover what an import did by looking at
 * the result: `previewImport` says exactly what will happen to every row, and
 * only `commitImport` writes. The preview is computed from the same code as the
 * commit, so the two cannot disagree.
 */

export type RowPlan = {
  line: number;
  name: string;
  phone: string | null;
  /** What will happen: a new file, an existing one enriched, or nothing. */
  action: "create" | "match" | "skip";
  reason?: string;
  matchedName?: string;
};

export type ImportPreview = {
  headers: string[];
  mapping: ImportField[];
  sample: string[][];
  plan: RowPlan[];
  counts: { create: number; match: number; skip: number };
  error?: string;
};

/** Reads one row through the mapping. Shared by preview and commit. */
function readRow(
  cells: string[],
  mapping: ImportField[]
): { name: string; phone: string; secondary: string; birth: string; gender: string; notes: string; tags: string; insurance: string } {

  const get = (f: ImportField) => {
    const i = mapping.indexOf(f);
    return i >= 0 ? (cells[i] ?? "").trim() : "";
  };
  /*
    A name in one column, or in two. Joined here rather than asked of the
    operator, because merging two columns in Excel before importing is the step
    at which people give up — and the full-name column wins when a sheet somehow
    carries both, so a name is never doubled up with its own surname.
  */
  const joined = [get("first_name"), get("last_name")].filter(Boolean).join(" ").trim();
  return {
    name: get("full_name") || joined,
    phone: get("phone"),
    secondary: get("secondary_phone"),
    birth: get("birth_date"),
    gender: get("gender"),
    notes: get("notes"),
    tags: get("tags"),
    insurance: get("insurance_no"),
  };
}

const MAX_ROWS = 5000;

export async function previewImportAction(
  slug: string,
  text: string,
  mappingOverride?: ImportField[]
): Promise<ImportPreview> {
  const access = await requireClinic(slug);
  if (!can(access, "patients.import")) {
    return { headers: [], mapping: [], sample: [], plan: [], counts: { create: 0, match: 0, skip: 0 }, error: "forbidden" };
  }

  const { headers, rows } = parseDelimited(text);
  if (!headers.length || !rows.length) {
    return { headers, mapping: [], sample: [], plan: [], counts: { create: 0, match: 0, skip: 0 }, error: "empty" };
  }
  if (rows.length > MAX_ROWS) {
    return { headers, mapping: [], sample: [], plan: [], counts: { create: 0, match: 0, skip: 0 }, error: "too_many" };
  }
  const mapping = mappingOverride?.length === headers.length ? mappingOverride : guessMapping(headers);
  const country = countryFromClinic(access.clinic) as CountryCode;

  return inClinic(access, async (c) => {
    const plan: RowPlan[] = [];
    const counts = { create: 0, match: 0, skip: 0 };
    /*
      Duplicates inside the file itself are as common as duplicates against the
      database — the same patient listed twice under two spellings. The second
      occurrence is reported as a match rather than creating a second file.
    */
    const seen = new Map<string, string>();

    for (const [i, cells] of rows.entries()) {
      const r = readRow(cells, mapping);
      const line = i + 2; // +1 for the header, +1 because humans count from one
      if (!r.name) {
        plan.push({ line, name: "", phone: null, action: "skip", reason: "no_name" });
        counts.skip++;
        continue;
      }
      const e164 = r.phone ? normalizePhone(r.phone, country) : null;
      if (r.phone && !e164) {
        plan.push({ line, name: r.name, phone: null, action: "skip", reason: "bad_phone" });
        counts.skip++;
        continue;
      }
      if (e164 && seen.has(e164)) {
        plan.push({ line, name: r.name, phone: e164, action: "match", matchedName: seen.get(e164), reason: "duplicate_in_file" });
        counts.match++;
        continue;
      }
      const existing = e164 ? await findPatientByPhone(c, access.clinicId, e164) : null;
      if (existing) {
        plan.push({ line, name: r.name, phone: e164, action: "match", matchedName: existing.full_name as string });
        counts.match++;
      } else {
        plan.push({ line, name: r.name, phone: e164, action: "create" });
        counts.create++;
      }
      if (e164) seen.set(e164, r.name);
    }

    return { headers, mapping, sample: rows.slice(0, 5), plan, counts };
  });
}

export async function commitImportAction(
  slug: string,
  text: string,
  mapping: ImportField[],
  filename: string
): Promise<{ batchId?: string; created?: number; matched?: number; skipped?: number; error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "patients.import")) return { error: "forbidden" };

  const { headers, rows } = parseDelimited(text);
  if (!headers.length || !rows.length) return { error: "empty" };
  if (rows.length > MAX_ROWS) return { error: "too_many" };
  if (mapping.length !== headers.length) return { error: "bad_mapping" };
  // A name is required, but it may arrive as one column or as two.
  const named =
    mapping.includes("full_name") ||
    mapping.includes("first_name") ||
    mapping.includes("last_name");
  if (!named) return { error: "name_required" };

  const country = countryFromClinic(access.clinic) as CountryCode;

  return inClinic(access, async (c) => {
    const batch = await c.query(
      `insert into import_batches (clinic_id, filename, mapping, row_count, created_by)
       values ($1, $2, $3, $4, $5) returning id`,
      [access.clinicId, filename.slice(0, 200), JSON.stringify(mapping), rows.length, access.session.user.id]
    );
    const batchId = batch.rows[0].id as string;

    let created = 0;
    let matched = 0;
    let skipped = 0;
    const seen = new Map<string, string>();

    for (const cells of rows) {
      const r = readRow(cells, mapping);
      if (!r.name) {
        skipped++;
        continue;
      }
      const e164 = r.phone ? normalizePhone(r.phone, country) : null;
      if (r.phone && !e164) {
        skipped++;
        continue;
      }
      const tags = r.tags
        ? r.tags.split(/[,;|]/).map((t) => t.trim()).filter(Boolean).slice(0, 10)
        : [];

      const existingId = e164 ? seen.get(e164) ?? (await findPatientByPhone(c, access.clinicId, e164))?.id : null;
      if (existingId) {
        /*
          An existing file is enriched, never overwritten. The clinic has been
          using this record; the spreadsheet is older than it. Only genuinely
          empty fields are filled, and the import batch is not stamped — this
          patient is not one an undo may remove.
        */
        await c.query(
          `update patients set
             birth_date = coalesce(birth_date, $2::date),
             gender = coalesce(gender, $3),
             insurance_no = case when insurance_no = '' then $4 else insurance_no end,
             tags = (select array(select distinct unnest(tags || $5::text[])))
           where id = $1`,
          [existingId, readDate(r.birth), readGender(r.gender), r.insurance.slice(0, 60), tags]
        );
        if (r.notes.trim()) {
          await c.query(
            `insert into patient_notes (clinic_id, patient_id, author_id, kind, category_id, body)
             values ($1, $2, $3, 'admin',
                     (select id from note_categories where clinic_id = $1 and key = 'admin'), $4)`,
            [access.clinicId, existingId, access.session.user.id, r.notes.slice(0, 5000)]
          );
        }
        matched++;
        if (e164) seen.set(e164, existingId);
        continue;
      }

      const ins = await c.query(
        `insert into patients (clinic_id, full_name, phone_e164, secondary_phone_e164, birth_date,
                               gender, tags, insurance_no, source, status, import_batch_id)
         values ($1, $2, $3, $4, $5::date, $6, $7, $8, 'import', 'active', $9) returning id`,
        [
          access.clinicId,
          r.name.slice(0, 200),
          e164,
          r.secondary ? normalizePhone(r.secondary, country) : null,
          readDate(r.birth),
          readGender(r.gender),
          tags,
          r.insurance.slice(0, 60),
          batchId,
        ]
      );
      const newId = ins.rows[0].id as string;
      if (r.notes.trim()) {
        await c.query(
          `insert into patient_notes (clinic_id, patient_id, author_id, kind, category_id, body)
           values ($1, $2, $3, 'admin',
                   (select id from note_categories where clinic_id = $1 and key = 'admin'), $4)`,
          [access.clinicId, newId, access.session.user.id, r.notes.slice(0, 5000)]
        );
      }
      // Tags typed here join the clinic's vocabulary, exactly as they do when
      // typed on a patient file — otherwise Settings shows a different list.
      for (const tag of tags) {
        await c.query(
          `insert into clinic_tags (clinic_id, name) values ($1, $2)
           on conflict (clinic_id, name) do nothing`,
          [access.clinicId, tag]
        );
      }
      created++;
      if (e164) seen.set(e164, newId);
    }

    await c.query(
      `update import_batches set created_count = $2, matched_count = $3, skipped_count = $4 where id = $1`,
      [batchId, created, matched, skipped]
    );
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "patients.import",
      entity: "clinic",
      entityId: access.clinicId,
      detail: { batchId, created, matched, skipped, filename },
    });

    revalidatePath(`/c/${slug}/patients`);
    return { batchId, created, matched, skipped };
  });
}

/**
 * Undoes an import.
 *
 * Only files this import created, and only those nothing has happened to since.
 * A patient who has since been given an appointment, an invoice or a message is
 * left alone and reported — by then they are part of the clinic's real records,
 * and removing them to tidy up a bad import would destroy work.
 */
export async function undoImportAction(
  slug: string,
  batchId: string
): Promise<{ removed?: number; kept?: number; error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "patients.import")) return { error: "forbidden" };

  return inClinic(access, async (c) => {
    const r = await c.query(
      `delete from patients p
        where p.clinic_id = $1 and p.import_batch_id = $2
          and not exists (select 1 from appointments a where a.patient_id = p.id)
          and not exists (select 1 from invoices i where i.patient_id = p.id)
          and not exists (select 1 from conversations cv where cv.patient_id = p.id)
          and not exists (select 1 from documents d where d.patient_id = p.id)
        returning p.id`,
      [access.clinicId, batchId]
    );
    const kept = (
      await c.query(
        `select count(*)::int n from patients where clinic_id = $1 and import_batch_id = $2`,
        [access.clinicId, batchId]
      )
    ).rows[0].n as number;

    await c.query(`update import_batches set undone_at = now() where id = $1 and clinic_id = $2`, [
      batchId,
      access.clinicId,
    ]);
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "patients.import_undo",
      entity: "clinic",
      entityId: access.clinicId,
      detail: { batchId, removed: r.rowCount, kept },
    });
    revalidatePath(`/c/${slug}/patients`);
    return { removed: r.rowCount ?? 0, kept };
  });
}
