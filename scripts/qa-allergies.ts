/**
 * Allergies have one home: the medical history (2026-11-28, migration 0122).
 *
 * - An allergy custom field is recognised in English and Arabic.
 * - A booking answer to a question mapped to it lands in the medical history,
 *   added to what is there, never twice.
 * - A consent form's allergy merge field prints the medical history.
 * - Migration 0122 took the field off the profile form everywhere.
 *
 *   npx tsx scripts/qa-allergies.ts
 */
import "../worker/env";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { addAllergyText, isAllergyField } from "../src/lib/medical-history";
import { applyAnswersToPatient, type BookingQuestion, type IntakeAnswer } from "../src/lib/booking-intake";
import { resolveFields, type FieldDefinition } from "../src/lib/esign/fields";

const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
let passed = 0;
let failed = 0;
const check = (cond: unknown, m: string, detail = "") => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${m}`);
  } else {
    failed++;
    console.log(`  ✗ ${m}${detail ? ` — ${detail}` : ""}`);
  }
};

async function main() {
  check(isAllergyField({ label_ar: "الحساسية" }) && isAllergyField({ storage_key: "allergies" }) && !isAllergyField({ label: "Address" }), "an allergy field is recognised in either language");
  check(addAllergyText("بنسلين", "بنسلين") === "بنسلين" && addAllergyText("", "Latex") === "Latex" && addAllergyText("Penicillin", "Latex") === "Penicillin، Latex", "adding an allergy never repeats one");

  const db = new Client({ connectionString: PG });
  await db.connect();
  const tag = Date.now().toString(36);
  const cl = (await db.query(`insert into clinics (name, slug) values ('QA Allergies', $1) returning id`, [`qa-allerg-${tag}`])).rows[0];
  try {
    await db.query(
      `insert into patient_field_definitions (clinic_id, scope, key, label, label_ar, field_type, storage_key, display_order)
       values ($1, 'patient', 'patient.allergies', 'Allergies', 'الحساسية', 'text', 'allergies', 50)`,
      [cl.id]
    );
    const p = (await db.query(
      `insert into patients (clinic_id, full_name, medical_history) values ($1, 'QA Patient', '{"allergies": "Penicillin"}') returning id`,
      [cl.id]
    )).rows[0];
    const qid = randomUUID();
    const question = { id: qid, booking_link_id: null, label: "Allergies?", label_ar: "هل لديك حساسية؟", help: null, help_ar: null, field_type: "text", options: [], options_ar: [], required: false, service_ids: [], patient_field_key: "patient.allergies", active: true, display_order: 1 } as BookingQuestion;
    const answer = { id: qid, label: "Allergies?", labelAr: "هل لديك حساسية؟", type: "text", value: "Latex" } as IntakeAnswer;
    await applyAnswersToPatient(db as never, cl.id, p.id, [question], [answer]);
    await applyAnswersToPatient(db as never, cl.id, p.id, [question], [answer]);
    const h = (await db.query(`select medical_history from patients where id = $1`, [p.id])).rows[0].medical_history;
    check(h.allergies === "Penicillin، Latex", "a booking answer about allergies lands in the medical history, once", h.allergies);

    const def = { key: "patient.allergies", label: "Allergies", label_ar: "الحساسية", field_type: "text", storage_key: "allergies", source_column: null } as unknown as FieldDefinition;
    const row = (await db.query(`select * from patients where id = $1`, [p.id])).rows[0];
    const merged = resolveFields([def], { clinic: { id: cl.id, name: "x", name_ar: null, address: null, address_ar: null, phone_e164: null, timezone: "Asia/Amman", currency: "JOD" }, patient: { ...row, custom_fields: { allergies: "an old answer" } }, doctorName: null, service: null, appointmentStartsAt: null }, "en");
    check(merged[0]?.value === "Penicillin، Latex", "a consent form's allergy field prints the medical history", merged[0]?.value);

    const shown = (await db.query(
      `select count(*)::int as n from patient_field_definitions
        where scope = 'patient' and not is_system and show_in_profile and coalesce(label_ar, '') ~ 'حساسي'
          and clinic_id <> $1`,
      [cl.id]
    )).rows[0].n;
    check(shown === 0, "no clinic's profile form still asks for allergies in a second place", String(shown));
  } finally {
    await db.query(`delete from clinics where id = $1`, [cl.id]).catch(() => {});
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
