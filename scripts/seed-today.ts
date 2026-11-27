/**
 * Fills one clinic's today with a believable day: patients, appointments at
 * every stage of the visit, and the invoices and payments of the ones done —
 * for a demo, or to see the screens with something on them.
 *
 *   npx tsx scripts/seed-today.ts "<clinic name or slug>" [--prod] [--dry-run]
 *
 * Safe on a live clinic by construction:
 * - the patients have **no phone number** and are opted out of automations,
 *   so no reminder, confirmation or campaign can message anybody real;
 * - the invoices are marked not to be filed with JoFotara;
 * - every patient carries the tag «تجريبي», so the day can be found and
 *   removed: delete from patients where clinic_id = … and 'تجريبي' = any(tags)
 *   (appointments, invoices and payments go with them).
 *
 * `--prod` reads DATABASE_SUPER_URL from .env.production.local, the way
 * migrate-prod does; without it, the local database from .env.
 */
import { Client } from "pg";
import { DateTime } from "luxon";

const args = process.argv.slice(2);
const PROD = args.includes("--prod");
const DRY = args.includes("--dry-run");
const target = args.find((a) => !a.startsWith("--"));
if (!target) {
  console.error('usage: npx tsx scripts/seed-today.ts "<clinic name or slug>" [--prod] [--dry-run]');
  process.exit(1);
}
process.loadEnvFile(PROD ? ".env.production.local" : ".env");
const url = process.env.DATABASE_SUPER_URL;
if (!url) {
  console.error("DATABASE_SUPER_URL is not set");
  process.exit(1);
}

const TAG = "تجريبي";
const PATIENTS: { name: string; gender: "male" | "female"; age: number }[] = [
  { name: "أحمد خالد العمري", gender: "male", age: 34 },
  { name: "سارة محمود النجار", gender: "female", age: 28 },
  { name: "يوسف إبراهيم الحسن", gender: "male", age: 45 },
  { name: "ليلى عمر الزعبي", gender: "female", age: 52 },
  { name: "محمد سامي القاسم", gender: "male", age: 19 },
  { name: "رنا فادي الخطيب", gender: "female", age: 37 },
  { name: "عمر نبيل الشريف", gender: "male", age: 61 },
  { name: "هبة جمال المصري", gender: "female", age: 25 },
  { name: "خالد وليد عبيدات", gender: "male", age: 40 },
];

async function main() {
  const db = new Client({ connectionString: url, ssl: PROD ? { rejectUnauthorized: false } : undefined });
  await db.connect();
  const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows;
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0];
  try {
    const found = await q(
      `select id, slug, name, name_ar, timezone, currency from clinics
        where deleted_at is null
          and (slug = $1 or ar_normalize(coalesce(name_ar, '')) = ar_normalize($1) or lower(name) = lower($1)
               or ar_normalize(coalesce(name_ar, '')) like '%' || ar_normalize($1) || '%'
               or ar_normalize(name) like '%' || ar_normalize($1) || '%')`,
      [target]
    );
    if (found.length !== 1) {
      console.error(found.length ? "More than one clinic matches — use the slug:" : `No clinic matches "${target}".`);
      for (const c of found) console.error(`  ${c.slug} — ${c.name_ar || c.name}`);
      process.exit(1);
    }
    const clinic = found[0];
    const tz = clinic.timezone as string;
    console.log(`clinic: ${clinic.name_ar || clinic.name} (/${clinic.slug}) on ${PROD ? "PRODUCTION" : "local"}`);

    const owner = await one(
      `select m.id as member_id, m.user_id from clinic_members m where m.clinic_id = $1 and m.is_owner and m.active order by m.created_at limit 1`,
      [clinic.id]
    );
    if (!owner) throw new Error("the clinic has no owner");
    let doctors = await q(
      `select id from clinic_members where clinic_id = $1 and role = 'doctor' and active order by created_at`,
      [clinic.id]
    );
    if (!doctors.length) doctors = [{ id: owner.member_id }];
    let services = await q(
      `select id, name, price, duration_min from services where clinic_id = $1 and active order by sort, name limit 6`,
      [clinic.id]
    );

    // Anchored inside today's working day, so a run late at night still makes a day that reads right.
    const now = DateTime.now().setZone(tz);
    const day = now.startOf("day");
    const anchor = DateTime.max(day.set({ hour: 12 }), DateTime.min(now, day.set({ hour: 20, minute: 30 })));
    type Plan = { at: DateTime; status: string; stage?: "seated" | "waiting"; source?: string; pay?: "full" | "part" | "none" };
    const plan: Plan[] = [
      { at: anchor.minus({ hours: 3, minutes: 30 }), status: "completed", pay: "full" },
      { at: anchor.minus({ hours: 3 }), status: "completed", pay: "full" },
      { at: anchor.minus({ hours: 2, minutes: 15 }), status: "completed", pay: "part" },
      { at: anchor.minus({ hours: 1, minutes: 45 }), status: "no_show" },
      { at: anchor.minus({ hours: 1, minutes: 15 }), status: "completed", pay: "none" },
      { at: anchor.minus({ minutes: 25 }), status: "confirmed", stage: "seated" },
      { at: anchor.minus({ minutes: 5 }), status: "confirmed", stage: "waiting" },
      { at: anchor.plus({ minutes: 45 }), status: "confirmed" },
      { at: anchor.plus({ hours: 1, minutes: 30 }), status: "scheduled", source: "booking_link" },
    ].map((p) => ({ ...p, at: p.at.startOf("hour").plus({ minutes: Math.round(p.at.minute / 15) * 15 }) }));

    if (DRY) {
      console.log(`services: ${services.length || "none — 3 will be created"}; doctors: ${doctors.length}`);
      for (const [i, p] of plan.entries()) console.log(`  ${p.at.toFormat("HH:mm")}  ${PATIENTS[i].name}  ${p.status}${p.stage ? ` (${p.stage})` : ""}${p.pay ? ` · invoice ${p.pay}` : ""}`);
      console.log("dry run — nothing written");
      return;
    }

    await q("begin");
    if (!services.length) {
      for (const [name, price, min] of [["كشف", 15, 20], ["تنظيف", 25, 30], ["متابعة", 10, 15]] as const) {
        await q(`insert into services (clinic_id, name, duration_min, price, bookable_online, active) values ($1, $2, $3, $4, true, true)`, [clinic.id, name, min, price]);
      }
      services = await q(`select id, name, price, duration_min from services where clinic_id = $1 and active order by sort, name`, [clinic.id]);
    }

    let made = 0;
    let invoiced = 0;
    for (const [i, p] of plan.entries()) {
      const pt = PATIENTS[i];
      const patient = await one(
        `insert into patients (clinic_id, full_name, gender, birth_date, source, status, tags, automation_opt_out, last_visit_at)
         values ($1, $2, $3, $4, 'staff', 'active', $5, true, $6) returning id`,
        [clinic.id, pt.name, pt.gender, now.minus({ years: pt.age, days: i * 37 }).toISODate(), [TAG], p.status === "completed" ? p.at.toUTC().toISO() : null]
      );
      const svc = services[i % services.length];
      const doctor = doctors[i % doctors.length];
      const minutes = Math.max(15, Number(svc.duration_min) || 30);
      const end = p.at.plus({ minutes });
      const arrived = p.status === "completed" || p.stage ? p.at.minus({ minutes: 5 }) : null;
      const seated = p.status === "completed" || p.stage === "seated" ? p.at.plus({ minutes: 3 }) : null;
      const finished = p.status === "completed" ? end : null;
      const appt = await one(
        `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status, source,
                                   created_by, arrived_at, seated_at, finished_at, notes)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
        [
          clinic.id, patient.id, doctor.id, svc.id, p.at.toUTC().toISO(), end.toUTC().toISO(), p.status, p.source ?? "staff",
          owner.user_id, arrived?.toUTC().toISO() ?? null, seated?.toUTC().toISO() ?? null, finished?.toUTC().toISO() ?? null, TAG,
        ]
      );
      made++;

      if (p.pay) {
        const price = Number(svc.price) > 0 ? Number(svc.price) : 20;
        const counter = await one(
          `update clinics set invoice_counter = invoice_counter + 1 where id = $1 returning invoice_counter, invoice_prefix`,
          [clinic.id]
        );
        const number = `${counter.invoice_prefix}-${now.year}-${String(counter.invoice_counter).padStart(4, "0")}`;
        const paid = p.pay === "full" ? price : p.pay === "part" ? Math.round(price / 2) : 0;
        const status = paid >= price ? "paid" : paid > 0 ? "partially_paid" : "sent";
        const inv = await one(
          `insert into invoices (clinic_id, patient_id, appointment_id, seq, number, status, currency, subtotal, total, amount_paid,
                                 created_by, sent_at, file_einvoice, einvoice_status, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11, false, 'not_required', $11) returning id`,
          [clinic.id, patient.id, appt.id, counter.invoice_counter, number, status, clinic.currency, price, paid, owner.user_id, (finished ?? p.at).toUTC().toISO()]
        );
        await q(
          `insert into invoice_items (clinic_id, invoice_id, service_id, description, qty, unit_price, amount, sort) values ($1, $2, $3, $4, 1, $5, $5, 0)`,
          [clinic.id, inv.id, svc.id, svc.name, price]
        );
        if (paid > 0) {
          await q(
            `insert into payments (clinic_id, invoice_id, patient_id, amount, method, paid_at, recorded_by) values ($1, $2, $3, $4, $5, $6, $7)`,
            [clinic.id, inv.id, patient.id, paid, i % 2 ? "card" : "cash", (finished ?? p.at).plus({ minutes: 2 }).toUTC().toISO(), owner.user_id]
          );
        }
        invoiced++;
      }
    }
    await q("commit");
    console.log(`made ${PATIENTS.slice(0, plan.length).length} patients, ${made} appointments today, ${invoiced} invoices — tagged «${TAG}»`);
  } catch (e) {
    await db.query("rollback").catch(() => {});
    console.error("failed, nothing written:", (e as Error).message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}

main();
