/**
 * A booking link that is about one thing does not ask which thing.
 *
 * The public page always opened on "choose a service", so a link offering one
 * showed a menu with a single item — a tap asking the patient to confirm what
 * the page had already told them it was for. The doctor step has always
 * collapsed when there is nobody to choose between; this gives services the
 * same treatment, opt-in.
 *
 * Three things have to hold, and the second and third are where this would go
 * wrong quietly:
 *
 *   - with the setting on and one service, the page opens on the date;
 *   - with the setting on and several services, it still asks — the page cannot
 *     pick one for the patient, so the setting has to be inert rather than
 *     wrong;
 *   - a booking made through the shortened flow carries the right service.
 *
 *   npx tsx scripts/qa-booking-single-service.ts
 */
import { chromium } from "playwright";
import { Client } from "pg";

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

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const tag = Date.now().toString(36);
  const slug = `qa1svc${tag}`;

  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug) values ('QA One Service', 'خدمة واحدة', $1)
       returning id, timezone`,
      [slug]
    )
  ).rows[0];

  try {
    await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);

    const mkService = async (name: string) =>
      (
        await db.query(
          `insert into services (clinic_id, name, name_ar, duration_min, price, bookable_online)
           values ($1, $2, $2, 30, 20, true) returning id`,
          [clinic.id, name]
        )
      ).rows[0].id as string;

    const cleaning = await mkService("Cleaning");
    const whitening = await mkService("Whitening");

    // One doctor, so the doctor step collapses too and the shortened link opens
    // straight on the calendar — the most aggressive version of the change.
    const user = (
      await db.query(
        `insert into users (email, password_hash, full_name) values ($1, 'x', 'د. سامي') returning id`,
        [`qa1svc-${tag}@test.local`]
      )
    ).rows[0];
    const member = (
      await db.query(
        `insert into clinic_members (clinic_id, user_id, role, specialty)
         values ($1, $2, 'doctor', 'أسنان') returning id`,
        [clinic.id, user.id]
      )
    ).rows[0];
    for (const s of [cleaning, whitening]) {
      await db.query(
        `insert into service_doctors (service_id, member_id, clinic_id) values ($1, $2, $3)`,
        [s, member.id, clinic.id]
      );
    }

    /* One link per shape, so both can be checked in the same browser session. */
    const mkLink = async (linkSlug: string, serviceIds: string[], skip: boolean) =>
      db.query(
        `insert into booking_links (clinic_id, slug, service_ids, min_notice_min, skip_service_step)
         values ($1, $2, $3::uuid[], 60, $4)`,
        [clinic.id, linkSlug, serviceIds, skip]
      );

    await mkLink(`${slug}-one`, [cleaning], true);
    await mkLink(`${slug}-many`, [cleaning, whitening], true);
    await mkLink(`${slug}-off`, [cleaning], false);

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    try {
      /* ===================================== one service, setting on */
      console.log("\n[one service, step switched off]");
      await page.goto(`${BASE}/book/${slug}-one`);
      await page.waitForLoadState("networkidle");
      const bodyOne = await page.locator("body").innerText();
      check(
        "the page does not ask which service",
        !bodyOne.includes("اختر الخدمة") && !bodyOne.includes("Cleaning"),
        bodyOne.slice(0, 60).replace(/\s+/g, " ")
      );
      // The date strip is the calendar step; reaching it means the wizard
      // skipped straight past both service and doctor.
      check("it opens on the calendar", (await page.locator("button:has(span.tnum)").count()) > 0);
      /*
        The progress bar is derived from the steps this link actually has.

        It used to be a fixed four with a hard-coded index, so a link that skips
        the first step would open with the second marker already lit — a page
        that looks like it lost your place rather than one with fewer questions.
        Counting the markers is the honest check: this link has time and details
        and nothing else.
      */
      const shortDots = await page.locator("div.mb-5 > span").count();
      check("the progress bar counts only the steps that exist", shortDots === 2, `${shortDots} markers`);

      /* ===================================== several services, setting on */
      console.log("\n[several services, same setting]");
      await page.goto(`${BASE}/book/${slug}-many`);
      await page.waitForLoadState("networkidle");
      const bodyMany = await page.locator("body").innerText();
      /*
        The setting is on and must do nothing here. The page cannot choose
        between two services on the patient's behalf, so the safe direction is
        to keep asking.
      */
      check(
        "the step is still shown rather than guessing",
        bodyMany.includes("Cleaning") && bodyMany.includes("Whitening"),
        bodyMany.slice(0, 60).replace(/\s+/g, " ")
      );

      /* ===================================== one service, setting off */
      console.log("\n[one service, setting left alone]");
      await page.goto(`${BASE}/book/${slug}-off`);
      await page.waitForLoadState("networkidle");
      const bodyOff = await page.locator("body").innerText();
      // Existing links must be untouched: this is opt-in, and the step is where
      // the price and the duration are stated before anyone commits.
      check("the service step still appears", bodyOff.includes("Cleaning"));
      // And it costs a step, which is the difference the setting buys.
      const longDots = await page.locator("div.mb-5 > span").count();
      check("and that link has one step more", longDots === 3, `${longDots} markers`);

      /* ===================================== a booking through the short flow */
      console.log("\n[booking through the shortened link]");
      await page.goto(`${BASE}/book/${slug}-one`);
      await page.waitForLoadState("networkidle");
      /*
        A short deadline per click, matching qa-phase4. The strip renders
        enabled and the day counts arrive afterwards, so a chip can go disabled
        under a locator that had already resolved it — and a click waiting for
        an element to become enabled hangs for the full timeout instead of
        moving on.
      */
      const chips = page.locator("button:has(span.tnum)");
      let booked = false;
      for (let i = 1; i < Math.min(await chips.count(), 10) && !booked; i++) {
        try {
          await chips.nth(i).click({ timeout: 3000 });
          await page.waitForSelector("button.tnum", { timeout: 4000 });
          booked = true;
        } catch {
          /* Closed, full, or greyed out as the counts landed — try the next. */
        }
      }
      check("a day with times can be reached", booked);
      if (booked) {
        await page.locator("button.tnum").first().click();
        await page.getByRole("button", { name: /متابعة|Next/ }).first().click();
        await page.fill('input[autocomplete="name"]', "مريم القيسي");
        await page.fill('input[autocomplete="tel"]', "0790001234");
        await page.getByRole("button", { name: /إرسال الرمز|Send code/ }).first().click();
        await page.waitForTimeout(3500);

        const appt = (
          await db.query(
            `select a.service_id, s.name from appointments a
               join services s on s.id = a.service_id
              where a.clinic_id = $1 limit 1`,
            [clinic.id]
          )
        ).rows[0];
        /*
          The point of the whole change: nobody chose a service, so the one the
          link is for has to be the one that lands on the appointment.
        */
        check(
          "the appointment carries the link's only service",
          appt?.service_id === cleaning,
          appt ? `${appt.name}` : "no appointment created"
        );
      }

      check("no client-side errors", errors.length === 0, errors.slice(0, 2).join("; "));
    } finally {
      await browser.close();
    }
  } finally {
    await db.query(`delete from clinics where id = $1`, [clinic.id]);
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
