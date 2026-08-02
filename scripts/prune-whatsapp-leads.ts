/**
 * Remove the patient files that inbound WhatsApp messages used to create.
 *
 * Until migration 0020 every message minted a patient, so the list filled with
 * anyone who had texted the clinic. This clears out the ones that never became
 * anything — no appointment, no invoice, no document, no note, no file, no
 * campaign, no tag. A file with any of those is somebody's work and is left
 * alone, whatever created it.
 *
 * The conversations survive. `conversations.patient_id` is ON DELETE SET NULL
 * and migration 0020 copied the WhatsApp name onto the thread, so the inbox
 * keeps every message and every title.
 *
 *   npx tsx scripts/prune-whatsapp-leads.ts            # show what would go
 *   npx tsx scripts/prune-whatsapp-leads.ts --delete   # actually remove them
 *
 * Reads .env.production.local rather than taking a connection string, so no
 * credential is ever passed on a command line.
 */
import { Client } from "pg";

process.loadEnvFile(".env.production.local");

const DELETE = process.argv.includes("--delete");

/**
 * Anything here means a human did something with the file, so it stays.
 *
 * Campaign membership is deliberately not on the list. A recipient row is a
 * record of a send, not of anyone working the file — and it keeps its own
 * `phone_e164` and drops the patient link on delete, so the campaign's history
 * survives intact. So does the inbox: messages hang off the conversation, not
 * the patient.
 */
const UNTOUCHED = `
  p.source = 'whatsapp'
  and p.merged_into is null
  and coalesce(array_length(p.tags, 1), 0) = 0
  and not exists (select 1 from appointments a where a.patient_id = p.id)
  and not exists (select 1 from invoices i where i.patient_id = p.id)
  and not exists (select 1 from documents d where d.patient_id = p.id)
  and not exists (select 1 from patient_notes n where n.patient_id = p.id)
  and not exists (select 1 from patient_files f where f.patient_id = p.id)
  and not exists (select 1 from patients o where o.merged_into = p.id)
`;

async function main() {
  const c = new Client({
    connectionString: process.env.DATABASE_SUPER_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  const doomed = await c.query(
    `select p.id, p.full_name, p.phone_e164, cl.name as clinic
       from patients p join clinics cl on cl.id = p.clinic_id
      where ${UNTOUCHED}
      order by cl.name, p.created_at`
  );
  const kept = await c.query(
    `select count(*)::int as n from patients p
      where p.source = 'whatsapp' and p.merged_into is null and not (${UNTOUCHED})`
  );

  console.table(doomed.rows.map((r) => ({ clinic: r.clinic, name: r.full_name, phone: r.phone_e164 })));
  console.log(`${doomed.rowCount} untouched, ${kept.rows[0].n} kept because they have activity`);

  if (!DELETE) {
    console.log("\nDry run. Pass --delete to remove them.");
    await c.end();
    return;
  }

  // The threads must already carry their own name, or deleting the patient
  // would leave the inbox showing bare numbers. Belt and braces: 0020 did this
  // once, but this script may run long after.
  await c.query(
    `update conversations cv set whatsapp_name = p.whatsapp_name
       from patients p
      where p.id = cv.patient_id and cv.whatsapp_name is null and p.whatsapp_name is not null`
  );

  const ids = doomed.rows.map((r) => r.id);
  const del = await c.query(`delete from patients where id = any($1::uuid[])`, [ids]);
  console.log(`\ndeleted ${del.rowCount} patient files`);

  const orphaned = await c.query(
    `select count(*)::int as n from conversations
      where patient_id is null and whatsapp_name is null and phone_e164 is not null`
  );
  console.log(`threads now showing a bare number: ${orphaned.rows[0].n}`);
  await c.end();
}

main().catch((e) => {
  console.error("prune failed:", e.message);
  process.exit(1);
});
