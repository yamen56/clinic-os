/**
 * A booking link can name several doctors, and the page shows their faces.
 *
 * `doctor_member_id` was one doctor or nobody, so a clinic with three dentists
 * and two paediatricians could not make a link for either pair. It is a set
 * now, shaped like `service_ids`: empty means everyone, one still locks and
 * hides the step, two or more narrow the step without removing it.
 *
 * The half worth being careful about is not the widening — it is that the
 * restriction was never enforced anywhere but the page. `serviceId` was checked
 * against the link on the way in and `doctorId` was not, so a link restricted
 * to one doctor could be booked with any colleague by sending a different id.
 * That is checked here explicitly.
 *
 * And the photos: the workspace route for a staff photo requires a session,
 * which a patient does not have, so there is a second, narrower public door. It
 * must answer for a doctor the link offers and 404 for everyone else — a photo
 * endpoint that answers for any member id is a way to enumerate a clinic's
 * staff.
 *
 *   npx tsx scripts/qa-booking-doctors.ts
 */
import { chromium } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { saveFile } from "../src/lib/storage";

/** Hashed once — the settings round trip at the end needs a real sign-in. */
const ownerHash = bcrypt.hashSync("password123", 10);

const BASE = "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** A 1x1 PNG, enough to prove the bytes came back with the right type. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const tag = Date.now().toString(36);
  const slug = `qadocs${tag}`;

  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug) values ('QA Doctors', 'أطباء', $1) returning id`,
      [slug]
    )
  ).rows[0];

  try {
    await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);

    const service = (
      await db.query(
        `insert into services (clinic_id, name, name_ar, duration_min, price, bookable_online)
         values ($1, 'Cleaning', 'تنظيف', 30, 20, true) returning id`,
        [clinic.id]
      )
    ).rows[0].id as string;

    const mkDoctor = async (name: string, withPhoto: boolean) => {
      const u = (
        await db.query(
          `insert into users (email, password_hash, full_name) values ($1, 'x', $2) returning id`,
          [`qadocs-${tag}-${name}@test.local`, name]
        )
      ).rows[0];
      if (withPhoto) {
        const saved = await saveFile(clinic.id, "avatars", `${tag}-${name}.png`, PNG);
        await db.query(`update users set avatar_path = $2 where id = $1`, [u.id, saved.storagePath]);
      }
      const m = (
        await db.query(
          `insert into clinic_members (clinic_id, user_id, role, specialty) values ($1, $2, 'doctor', 'أسنان') returning id`,
          [clinic.id, u.id]
        )
      ).rows[0];
      await db.query(
        `insert into service_doctors (service_id, member_id, clinic_id) values ($1, $2, $3)`,
        [service, m.id, clinic.id]
      );
      return m.id as string;
    };

    const omar = await mkDoctor("د. عمر الخطيب", true);
    const lina = await mkDoctor("د. لينا حداد", true);
    const samer = await mkDoctor("د. سامر ناصر", false);

    const mkLink = async (linkSlug: string, doctorIds: string[]) =>
      db.query(
        `insert into booking_links (clinic_id, slug, service_ids, doctor_member_ids, min_notice_min)
         values ($1, $2, '{}', $3::uuid[], 60)`,
        [clinic.id, linkSlug, doctorIds]
      );

    await mkLink(`${slug}-all`, []);
    await mkLink(`${slug}-pair`, [omar, lina]);
    await mkLink(`${slug}-one`, [omar]);

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const visible = async () => (await page.locator("body").innerText()).replace(/\s+/g, " ");

    try {
      /* ============================================ empty = everyone */
      console.log("\n[a link that names no doctor]");
      await page.goto(`${BASE}/book/${slug}-all`);
      await page.waitForLoadState("networkidle");
      await page.getByRole("button", { name: /Cleaning|تنظيف/ }).first().click();
      await page.waitForTimeout(400);
      const all = await visible();
      check(
        "offers every doctor, as a null used to",
        all.includes("عمر") && all.includes("لينا") && all.includes("سامر"),
        all.slice(0, 80)
      );

      /* ============================================ two named */
      console.log("\n[a link that names two]");
      await page.goto(`${BASE}/book/${slug}-pair`);
      await page.waitForLoadState("networkidle");
      await page.getByRole("button", { name: /Cleaning|تنظيف/ }).first().click();
      await page.waitForTimeout(400);
      const pair = await visible();
      check("the doctor step is still asked", pair.includes("عمر") && pair.includes("لينا"));
      /* The whole point: a single column could not express this at all. */
      check("and the doctor left out is not offered", !pair.includes("سامر"), pair.slice(0, 80));

      /* ============================================ photos */
      console.log("\n[the doctor's own face]");
      const imgs = page.locator(`img[src*="/doctor-photo/"]`);
      check("a doctor with a photo renders an image", (await imgs.count()) >= 2, `${await imgs.count()} images`);
      const loaded = await imgs
        .first()
        .evaluate((el) => (el as HTMLImageElement).naturalWidth > 0)
        .catch(() => false);
      check("and the image actually decodes", loaded === true);

      const photoRes = await page.request.get(`${BASE}/api/public/book/${slug}-pair/doctor-photo/${omar}`);
      check("the endpoint serves it", photoRes.status() === 200, `status ${photoRes.status()}`);
      check(
        "with an image content type",
        (photoRes.headers()["content-type"] ?? "").startsWith("image/"),
        photoRes.headers()["content-type"]
      );

      /*
        The narrowness that keeps this from being a staff directory: Samer is a
        doctor at this clinic, but this link does not offer him.
      */
      const offLink = await page.request.get(`${BASE}/api/public/book/${slug}-pair/doctor-photo/${samer}`);
      check("but not for a doctor the link leaves out", offLink.status() === 404, `status ${offLink.status()}`);
      const bogus = await page.request.get(
        `${BASE}/api/public/book/${slug}-pair/doctor-photo/00000000-0000-0000-0000-000000000000`
      );
      check("nor for an id that is not a member", bogus.status() === 404, `status ${bogus.status()}`);

      /* A doctor with no photo still gets a legible card, not a blank circle. */
      await page.goto(`${BASE}/book/${slug}-all`);
      await page.waitForLoadState("networkidle");
      await page.getByRole("button", { name: /Cleaning|تنظيف/ }).first().click();
      await page.waitForTimeout(400);
      check("a doctor without one falls back to an initial", (await visible()).includes("سامر"));

      /* ============================================ one named still locks */
      console.log("\n[a link that names one]");
      await page.goto(`${BASE}/book/${slug}-one`);
      await page.waitForLoadState("networkidle");
      await page.getByRole("button", { name: /Cleaning|تنظيف/ }).first().click();
      await page.waitForTimeout(600);
      const one = await visible();
      check("the step collapses, as it did for a single column", !one.includes("لينا"), one.slice(0, 80));

      /* ============================================ the restriction is enforced */
      console.log("\n[the restriction is not just a rendering choice]");
      /*
        `serviceId` was validated against the link and `doctorId` was not, so
        this request used to be accepted and booked with a doctor the link does
        not offer.
      */
      const forged = await page.request.post(`${BASE}/api/public/book/${slug}-one/start`, {
        data: {
          serviceId: service,
          doctorId: lina,
          startISO: new Date(Date.now() + 86400000).toISOString(),
          fullName: "مريم القيسي",
          phone: "0790009999",
          answers: {},
        },
      });
      check(
        "a doctor the link does not offer is refused",
        forged.status() === 400,
        `status ${forged.status()}`
      );
      const forgedBody = await forged.json().catch(() => ({}));
      check("and named as the reason", forgedBody?.error === "bad_doctor", String(forgedBody?.error));

      const appts = (
        await db.query(`select count(*)::int as n from appointments where clinic_id = $1`, [clinic.id])
      ).rows[0].n as number;
      check("nothing was booked", appts === 0, `${appts} appointments`);

      /* ============================================ the editor round trip */
      console.log("\n[what the editor saves, it shows again]");
      /*
        Worth its own check because the failure is silent and survives a
        typecheck: if the links query does not select the column, the editor
        reopens with the box unticked and the clinic re-saves it empty,
        quietly widening a link they had restricted.
      */
      const owner = (
        await db.query(
          `insert into users (email, password_hash, full_name) values ($1, $2, 'QA Owner') returning id`,
          [`qadocs-${tag}-owner@test.local`, ownerHash]
        )
      ).rows[0];
      await db.query(
        `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
         values ($1, $2, 'receptionist', true, '{"level":"full"}')`,
        [clinic.id, owner.id]
      );

      await page.setViewportSize({ width: 1280, height: 1000 });
      await page.goto(`${BASE}/login`);
      await page.fill('input[name="email"]', `qadocs-${tag}-owner@test.local`);
      await page.fill('input[name="password"]', "password123");
      await page.click('button[type="submit"]');
      await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120000 });
      await page.goto(`${BASE}/c/${slug}/settings/booking`);
      await page.waitForLoadState("networkidle");

      // The editor for the link that already names two doctors.
      await page.getByRole("button", { name: /تعديل|Edit/ }).nth(1).click();
      await page.waitForTimeout(800);
      const dialog = await page.locator("body").innerText();
      check("the label is the plural one", dialog.includes("الأطباء"), "الأطباء");
      check(
        "reopening shows the restriction it stored",
        dialog.includes("لا يمكن الحجز عبر هذا الرابط إلا مع الأطباء المحدّدين"),
        dialog.replace(/\s+/g, " ").match(/الأطباء.{0,90}/)?.[0] ?? ""
      );

      // Ticking a third and saving has to reach the database.
      await page.locator("button", { hasText: "سامر" }).first().click();
      await page.waitForTimeout(400);
      await page.locator("button", { hasText: /^\s*(حفظ|Save)\s*$/ }).first().click();
      await page.waitForTimeout(3000);
      const stored = (
        await db.query(
          `select doctor_member_ids, doctor_member_id from booking_links where clinic_id = $1 and slug = $2`,
          [clinic.id, `${slug}-pair`]
        )
      ).rows[0];
      check(
        "the third doctor is stored",
        (stored?.doctor_member_ids ?? []).length === 3,
        `${(stored?.doctor_member_ids ?? []).length} doctors`
      );
      /*
        And the column the previous release still reads is null now that there
        are three — "everyone" is the safe way for an old container to be wrong
        during a rollout, where one arbitrary doctor is not. See migration 0048.
      */
      check("the legacy column is null for a multi-doctor link", stored?.doctor_member_id === null);

      check("no client-side errors", errors.length === 0, errors.slice(0, 2).join("; "));
    } finally {
      await browser.close();
    }
  } finally {
    await db.query(`delete from clinics where id = $1`, [clinic.id]);
    await db.query(`delete from users where email like $1`, [`qadocs-${tag}-%`]);
    await db.end();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
