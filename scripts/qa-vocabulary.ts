/**
 * The per-workspace vocabulary, and the promise that it is per-workspace.
 *
 * The interesting assertions are the negative ones. One clinic reading
 * different words is easy; the thing that would actually hurt is a clinic
 * that never asked for it waking up to "Clinics" where it used to say
 * "Patients", or a clinic created next month inheriting it silently.
 */
try { process.loadEnvFile?.(); } catch {}

import { Client } from "pg";
import { en } from "../src/lib/i18n/en";
import { ar } from "../src/lib/i18n/ar";
import { applyVocabulary } from "../src/lib/i18n/vocab";

const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
let pass = 0;
const fails: string[] = [];
const ok = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok  ${n}`); } else { fails.push(`${n} — ${d}`); console.log(`  FAIL ${n} ${d}`); }
};

/** Every leaf in the merged dict must correspond to a leaf in the base. */
function invented(merged: unknown, base: unknown, path: string[] = [], out: string[] = []): string[] {
  for (const [k, v] of Object.entries(merged as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)?.[k];
    if (b === undefined) out.push([...path, k].join("."));
    else if (v && typeof v === "object" && !Array.isArray(v)) invented(v, b, [...path, k], out);
  }
  return out;
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  console.log("\n[the default is untouched]");
  ok("medical returns the very same object, not a copy",
    applyVocabulary(en, "medical", "en") === en);
  ok("a default workspace still says Patients",
    applyVocabulary(en, "medical", "en").nav.patients === "Patients");
  ok("and يقول المرضى in Arabic",
    applyVocabulary(ar, "medical", "ar").nav.patients === ar.nav.patients);

  console.log("\n[the agency workspace speaks differently]");
  const aEn = applyVocabulary(en, "agency", "en");
  const aAr = applyVocabulary(ar, "agency", "ar");
  ok("nav says Clinics", aEn.nav.patients === "Clinics", aEn.nav.patients);
  ok("nav يقول العيادات", aAr.nav.patients === "العيادات", aAr.nav.patients);
  ok("documents become contracts", aEn.nav.documents === "Contracts");
  ok("the signing consent is a commercial agreement",
    /agreement/i.test(aEn.sign.consentLabel), aEn.sign.consentLabel.slice(0, 40));
  ok("Arabic consent is an agreement too",
    aAr.sign.consentLabel.includes("الاتفاقية"), aAr.sign.consentLabel.slice(0, 40));

  console.log("\n[the override cannot drift out of the dictionary]");
  ok("no invented English keys", invented(aEn, en).length === 0, invented(aEn, en).join(", "));
  ok("no invented Arabic keys", invented(aAr, ar).length === 0, invented(aAr, ar).join(", "));

  console.log("\n[untouched keys keep their wording]");
  ok("invoices title is unchanged", aEn.invoices.title === en.invoices.title);
  ok("settings are unchanged", aEn.nav.settings === en.nav.settings);
  ok("auth is unchanged", aEn.auth.signIn === en.auth.signIn);

  console.log("\n[the database agrees]");
  const col = await db.query(
    `select column_default, is_nullable from information_schema.columns
      where table_name = 'clinics' and column_name = 'vocabulary'`
  );
  ok("the column exists and defaults to medical",
    /medical/.test(col.rows[0]?.column_default ?? ""), col.rows[0]?.column_default ?? "missing");

  // A clinic created the ordinary way must not opt in by accident.
  const slug = `vocab${Date.now().toString(36)}`;
  const c = (await db.query(
    `insert into clinics (name, name_ar, slug, default_locale) values ('Vocab','مفردات',$1,'ar') returning id, vocabulary`,
    [slug]
  )).rows[0];
  ok("a newly created clinic is medical", c.vocabulary === "medical", c.vocabulary);

  const others = await db.query(
    `select count(*)::int n from clinics where vocabulary <> 'medical' and slug <> 'clinicti'`
  );
  ok("no clinic other than clinicti has been switched", others.rows[0].n === 0, `${others.rows[0].n} others`);

  const bad = await db.query(`select count(*)::int n from clinics where vocabulary is null`);
  ok("no clinic has a null vocabulary", bad.rows[0].n === 0);

  await db.query(`delete from clinics where id = $1`, [c.id]);
  await db.end();

  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) { fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
