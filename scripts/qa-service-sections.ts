/**
 * Sections: the part of the clinic a service belongs to.
 *
 * A clinic running dentistry, pediatrics and aesthetics had one flat list of
 * services — on the settings screen, in the calendar, and on the booking page,
 * where a parent booking a check-up scrolled past eight dental procedures.
 * Sections divide it.
 *
 * The thing most likely to go wrong quietly is not the feature; it is what the
 * feature does to the clinics that never use it. So the first check here is
 * that a clinic with no sections still sees exactly the page it saw before —
 * no heading, no extra step, no filter. After that:
 *
 *   - two sections put a section step in front of the services;
 *   - choosing one shows only its services, and Back returns to the choice;
 *   - one section is not a question, so the step collapses like the doctor step;
 *   - a link restricted to a section offers that section's services and no
 *     others, including services added after the link was made;
 *   - a booking through the section flow carries the right service.
 *
 * Assertions read `innerText`, never `textContent`: the whole dictionary is
 * serialised into every page's RSC payload, so a `textContent` check passes
 * everywhere and proves nothing.
 *
 *   npx tsx scripts/qa-service-sections.ts
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
  const slug = `qasec${tag}`;

  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug) values ('QA Sections', 'أقسام', $1)
       returning id, timezone`,
      [slug]
    )
  ).rows[0];

  try {
    await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);

    const mkSection = async (name: string, nameAr: string, sort: number) =>
      (
        await db.query(
          `insert into service_sections (clinic_id, name, name_ar, sort)
           values ($1, $2, $3, $4) returning id`,
          [clinic.id, name, nameAr, sort]
        )
      ).rows[0].id as string;

    const mkService = async (name: string, sectionId: string | null) =>
      (
        await db.query(
          `insert into services (clinic_id, name, name_ar, duration_min, price, bookable_online, section_id)
           values ($1, $2, $2, 30, 20, true, $3) returning id`,
          [clinic.id, name, sectionId]
        )
      ).rows[0].id as string;

    const mkLink = async (
      linkSlug: string,
      opts: { serviceIds?: string[]; sectionId?: string | null } = {}
    ) =>
      db.query(
        `insert into booking_links (clinic_id, slug, service_ids, section_id, min_notice_min)
         values ($1, $2, $3::uuid[], $4, 60)`,
        [clinic.id, linkSlug, opts.serviceIds ?? [], opts.sectionId ?? null]
      );

    // One doctor, so the doctor step collapses and the section step is the only
    // thing standing in front of the services.
    const user = (
      await db.query(
        `insert into users (email, password_hash, full_name) values ($1, 'x', 'د. سامي') returning id`,
        [`qasec-${tag}@test.local`]
      )
    ).rows[0];
    await db.query(
      `insert into clinic_members (clinic_id, user_id, role, specialty) values ($1, $2, 'doctor', 'أسنان')`,
      [clinic.id, user.id]
    );

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const visible = async () => (await page.locator("body").innerText()).replace(/\s+/g, " ");

    try {
      /* ============================================ no sections at all */
      console.log("\n[a clinic that has never made a section]");
      const cleaning = await mkService("Cleaning", null);
      await mkService("Whitening", null);
      await mkLink(`${slug}-flat`);

      await page.goto(`${BASE}/book/${slug}-flat`);
      await page.waitForLoadState("networkidle");
      const flat = await visible();
      check("the page opens straight on the services", flat.includes("Cleaning") && flat.includes("Whitening"));
      check("and asks nothing about a section", !flat.includes("أي قسم تحتاج"), flat.slice(0, 70));
      // Service, time, details — the three it has always had.
      const flatDots = await page.locator("div.mb-5 > span").count();
      check("the progress bar is unchanged", flatDots === 3, `${flatDots} markers`);

      /* ============================================ two sections */
      console.log("\n[two sections]");
      const dental = await mkSection("Dentistry", "الأسنان", 10);
      const paeds = await mkSection("Pediatrics", "الأطفال", 20);
      await db.query(`update services set section_id = $1 where clinic_id = $2`, [dental, clinic.id]);
      const checkup = await mkService("Child check-up", paeds);
      await mkLink(`${slug}-two`);

      await page.goto(`${BASE}/book/${slug}-two`);
      await page.waitForLoadState("networkidle");
      const two = await visible();
      check("the patient is asked which part of the clinic", two.includes("أي قسم تحتاج"), two.slice(0, 70));
      check("both sections are offered", two.includes("الأسنان") && two.includes("الأطفال"));
      // The section screen names sections, not services — the whole point.
      check("and no service is named yet", !two.includes("Cleaning") && !two.includes("Child check-up"));
      const twoDots = await page.locator("div.mb-5 > span").count();
      check("the progress bar counts the extra step", twoDots === 4, `${twoDots} markers`);

      console.log("\n[choosing a section]");
      await page.getByRole("button", { name: /الأطفال/ }).first().click();
      await page.waitForTimeout(400);
      const inPaeds = await visible();
      check("only that section's services are shown", inPaeds.includes("Child check-up"));
      check("the other section's are not", !inPaeds.includes("Cleaning") && !inPaeds.includes("Whitening"));

      console.log("\n[going back]");
      await page.getByRole("button", { name: /رجوع|Back/ }).first().click();
      await page.waitForTimeout(400);
      const back = await visible();
      check("Back returns to the section choice", back.includes("أي قسم تحتاج") && back.includes("الأسنان"));

      /* ============================================ one section */
      console.log("\n[one section is not a question]");
      await mkLink(`${slug}-onesec`, { sectionId: paeds });
      await page.goto(`${BASE}/book/${slug}-onesec`);
      await page.waitForLoadState("networkidle");
      const one = await visible();
      /*
        Same self-collapsing rule as the doctor step: a screen offering one
        choice is not a question. The link resolves to one section, so the
        patient lands on its services directly.
      */
      check("the step collapses", !one.includes("أي قسم تحتاج"), one.slice(0, 70));
      check("and its services are listed", one.includes("Child check-up"));
      check("without the other section's", !one.includes("Cleaning"));

      /* ============================================ a link follows its section */
      console.log("\n[a service added after the link was made]");
      await mkService("Vaccination", paeds);
      await page.goto(`${BASE}/book/${slug}-onesec`);
      await page.waitForLoadState("networkidle");
      const grown = await visible();
      /*
        The reason a section beats a hand-picked list: nobody edited this link,
        and the new pediatric service is on it anyway.
      */
      check("the link picks it up on its own", grown.includes("Vaccination"));
      check("and still refuses the other section", !grown.includes("Whitening"));

      /* ============================================ a booking through it */
      console.log("\n[booking through the section flow]");
      await page.goto(`${BASE}/book/${slug}-two`);
      await page.waitForLoadState("networkidle");
      await page.getByRole("button", { name: /الأطفال/ }).first().click();
      await page.waitForTimeout(400);
      await page.getByRole("button", { name: /Child check-up/ }).first().click();
      await page.waitForTimeout(600);

      const chips = page.locator("button:has(span.tnum)");
      let booked = false;
      for (let i = 1; i < Math.min(await chips.count(), 10) && !booked; i++) {
        try {
          await chips.nth(i).click({ timeout: 3000 });
          await page.waitForSelector("button.tnum", { timeout: 4000 });
          booked = true;
        } catch {
          /* Closed, full, or greyed out as the day counts landed. */
        }
      }
      check("a day with times can be reached", booked);
      if (booked) {
        await page.locator("button.tnum").first().click();
        await page.getByRole("button", { name: /متابعة|Next/ }).first().click();
        await page.fill('input[autocomplete="name"]', "مريم القيسي");
        await page.fill('input[autocomplete="tel"]', "0790005678");
        await page.getByRole("button", { name: /إرسال الرمز|Send code/ }).first().click();
        await page.waitForTimeout(3500);

        const appt = (
          await db.query(
            `select a.service_id, s.name, s.section_id from appointments a
               join services s on s.id = a.service_id
              where a.clinic_id = $1 limit 1`,
            [clinic.id]
          )
        ).rows[0];
        check(
          "the appointment carries the service chosen inside the section",
          appt?.service_id === checkup,
          appt ? String(appt.name) : "no appointment created"
        );
        check("and it is filed under that section", appt?.section_id === paeds);
      }

      /* ============================================ deleting a section */
      console.log("\n[deleting a section keeps its services]");
      await db.query(`delete from service_sections where id = $1`, [dental]);
      const survivor = (
        await db.query(`select section_id from services where id = $1`, [cleaning])
      ).rows[0];
      /*
        `on delete set null`, deliberately. Deleting a section is a filing
        decision; taking the services with it would take the appointments and
        invoice lines behind them too.
      */
      check("the service survives", !!survivor, "row still present");
      check("and falls back to unfiled", survivor?.section_id === null);

      check("no client-side errors", errors.length === 0, errors.slice(0, 2).join("; "));
    } finally {
      await browser.close();
    }
  } finally {
    await db.query(`delete from clinics where id = $1`, [clinic.id]);
    await db.query(`delete from users where email like $1`, [`qasec-${tag}@%`]);
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
