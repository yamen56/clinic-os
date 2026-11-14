/**
 * Several services on one visit, who booked it, and the booking page's own
 * rules (migration 0106, 2026-11-12).
 *
 *   - the desk books two services: two chips, the length is both together,
 *     and the visit carries the second one;
 *   - the visit's panel says who booked it — the staff member, or "Booked
 *     online" and which link;
 *   - the board card names every service;
 *   - a link that allows it books several services as one visit, and its
 *     free times are long enough for all of them; a link that does not
 *     refuses a second service at every endpoint;
 *   - a time the page would never offer — outside the hours, off the grid,
 *     past the window — is refused, where it used to be booked;
 *   - the page is drawn in the clinic's colour, with dark ink on a pale one.
 *
 * Runs against a dev server on :3000 with the local database.
 */
import { Client } from "pg";
import { chromium, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { DateTime } from "luxon";

try {
  process.loadEnvFile?.();
} catch {}

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const TZ = "Asia/Amman";
// Eight to eight every day, so "three in the morning" is a closed hour.
const HOURS = JSON.stringify(
  Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [["08:00", "20:00"]]]))
);
const SHOTS = process.env.QA_SHOTS || "";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: unknown, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const text = (page: Page, sel = "body") =>
  page.evaluate(`(document.querySelector(${JSON.stringify(sel)}) || document.body).innerText || ""`) as Promise<string>;

async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 60000 });
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const tag = Date.now().toString(36);
  const slug = `qamulti${tag}`;
  const userIds: string[] = [];
  let clinic = "";

  try {
    clinic = (
      await db.query(
        `insert into clinics (name, slug, timezone, working_hours, default_locale, brand_color)
         values ('QA Multi', $1, $2, $3, 'en', '#0f6e5c') returning id`,
        [slug, TZ, HOURS]
      )
    ).rows[0].id as string;
    const mkUser = async (email: string, name: string) => {
      const id = (
        await db.query(`insert into users (email, password_hash, full_name, locale) values ($1, $2, $3, 'en') returning id`, [
          email,
          bcrypt.hashSync("password123", 10),
          name,
        ])
      ).rows[0].id as string;
      userIds.push(id);
      return id;
    };
    const ownerId = await mkUser(`owner-${slug}@test.local`, "Rana Owner");
    const docUser = await mkUser(`doc-${slug}@test.local`, "Dr Alpha");
    await db.query(
      `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'receptionist', true, '{"level":"full"}')`,
      [clinic, ownerId]
    );
    const doc = (
      await db.query(`insert into clinic_members (clinic_id, user_id, role, color) values ($1, $2, 'doctor', '#2b7fb8') returning id`, [clinic, docUser])
    ).rows[0].id as string;
    const svc = async (name: string, dur: number, sort: number) =>
      (
        await db.query(`insert into services (clinic_id, name, duration_min, price, sort) values ($1, $2, $3, 20, $4) returning id`, [
          clinic,
          name,
          dur,
          sort,
        ])
      ).rows[0].id as string;
    const CLEAN = await svc("Cleaning", 30, 1);
    const WHITE = await svc("Whitening", 45, 2);
    const CHECK = await svc("Checkup", 20, 3);

    const multiLink = (
      await db.query(
        `insert into booking_links (clinic_id, slug, name, min_notice_min, allow_multiple_services) values ($1, $2, 'Instagram ad', 0, true) returning id`,
        [clinic, `${slug}-multi`]
      )
    ).rows[0].id as string;
    await db.query(`insert into booking_links (clinic_id, slug, name, min_notice_min) values ($1, $2, 'Desk', 0)`, [clinic, `${slug}-one`]);

    const tomorrow = DateTime.now().setZone(TZ).plus({ days: 1 }).startOf("day");
    const at = (h: number, m = 0) => tomorrow.set({ hour: h, minute: m }).toUTC().toISO()!;
    let phoneN = 0;
    const phone = () => `079${String(3000000 + Math.floor(Math.random() * 900000) + phoneN++)}`;
    const api = (path: string) => fetch(`${BASE}/api/public/book/${path}`).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    const start = (link: string, body: Record<string, unknown>) =>
      fetch(`${BASE}/api/public/book/${link}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: "en", fullName: "QA Patient", phone: phone(), answers: {}, ...body }),
      }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

    // Something already in the doctor's diary tomorrow at 10:30.
    const busyPatient = (
      await db.query(`insert into patients (clinic_id, full_name, phone_e164) values ($1, 'Busy Basel', '+962790000001') returning id`, [clinic])
    ).rows[0].id as string;
    await db.query(
      `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status)
       values ($1, $2, $3, $4, $5, $6, 'confirmed')`,
      [clinic, busyPatient, doc, CHECK, at(10, 30), at(11)]
    );

    /* ----------------------------------------------------- 1. the booking API */
    console.log("\na link that does not allow several services");
    const day = tomorrow.toISODate()!;
    const two = `serviceId=${CLEAN}&serviceId=${WHITE}`;
    const oneSlots = await api(`${slug}-one/slots?${two}&date=${day}`);
    check("its times refuse two services", oneSlots.status === 400 && oneSlots.body.error === "bad_service", JSON.stringify(oneSlots));
    const oneDays = await api(`${slug}-one/days?${two}`);
    check("so does its day strip", oneDays.status === 400, `status ${oneDays.status}`);
    const oneStart = await start(`${slug}-one`, { serviceIds: [CLEAN, WHITE], serviceId: CLEAN, startISO: at(9) });
    check("and so does booking", oneStart.status === 400 && oneStart.body.error === "bad_service", JSON.stringify(oneStart));

    console.log("\na link that allows them");
    const single = await api(`${slug}-multi/slots?serviceId=${CLEAN}&date=${day}`);
    const multi = await api(`${slug}-multi/slots?${two}&date=${day}`);
    const has = (r: { body: { slots?: { startISO: string }[] } }, iso: string) =>
      (r.body.slots ?? []).some((s) => Date.parse(s.startISO) === Date.parse(iso));
    check("one 30-minute service fits at 10:00, before the 10:30 visit", has(single, at(10)));
    check("30 + 45 minutes do not fit at 10:00", !has(multi, at(10)));
    check("nor at 09:30, which would run to 10:45", !has(multi, at(9, 30)));
    check("but fit at 09:00, ending 10:15", has(multi, at(9)));
    const multiDays = await api(`${slug}-multi/days?${two}`);
    check("the day strip answers for both services", multiDays.status === 200 && multiDays.body.counts?.[day] > 0, JSON.stringify(multiDays.body).slice(0, 80));
    const stranger = await api(`${slug}-multi/slots?serviceId=${CLEAN}&serviceId=00000000-0000-4000-8000-000000000000&date=${day}`);
    check("a service the link does not offer is refused", stranger.status === 400);

    const booked = await start(`${slug}-multi`, { serviceId: CLEAN, serviceIds: [CLEAN, WHITE], startISO: at(9), doctorId: doc });
    check("two services book as one visit", booked.status === 200 && booked.body.skipVerify, JSON.stringify(booked).slice(0, 120));
    const row = (
      await db.query(
        `select a.id, a.service_id, a.booking_link_id, extract(epoch from a.ends_at - a.starts_at)::int / 60 as minutes,
                appointment_service_names(a.id, false) as names,
                (select array_agg(service_id::text order by sort) from appointment_extra_services where appointment_id = a.id) as extras
           from appointments a where a.id = $1`,
        [booked.body.appointmentId]
      )
    ).rows[0];
    check("the first service is the visit's own", row?.service_id === CLEAN);
    check("the second is kept with it", JSON.stringify(row?.extras) === JSON.stringify([WHITE]), JSON.stringify(row?.extras));
    check("the visit is as long as both", row?.minutes === 75, `${row?.minutes} min`);
    check("and remembers the link it came through", row?.booking_link_id === multiLink);
    check("its name reads both services", row?.names === "Cleaning + Whitening", row?.names);
    const note = (
      await db.query(`select body from notifications where clinic_id = $1 and kind = 'booking' order by created_at desc limit 1`, [clinic])
    ).rows[0];
    check("the desk's notice names both", String(note?.body ?? "").startsWith("Cleaning + Whitening"), note?.body);

    console.log("\ntimes the page would never offer");
    const night = await start(`${slug}-multi`, { serviceId: CLEAN, startISO: at(3) });
    check("three in the morning is refused", night.status === 409 && night.body.error === "slot_taken", JSON.stringify(night));
    const offGrid = await start(`${slug}-multi`, { serviceId: CLEAN, startISO: at(12, 7) });
    check("a time off the half-hour grid is refused", offGrid.status === 409, JSON.stringify(offGrid));
    const far = await start(`${slug}-multi`, {
      serviceId: CLEAN,
      startISO: tomorrow.plus({ days: 45 }).set({ hour: 9 }).toUTC().toISO(),
    });
    check("a day past the link's window is refused", far.status === 409, JSON.stringify(far));
    const overlap = await start(`${slug}-multi`, { serviceId: CLEAN, startISO: at(10, 30), doctorId: doc });
    check("a time the doctor is busy is refused", overlap.status === 409);
    const fine = await start(`${slug}-multi`, { serviceId: CLEAN, startISO: at(12) });
    check("an offered time still books", fine.status === 200, JSON.stringify(fine).slice(0, 100));

    /* ------------------------------------------------------- 2. the desk */
    console.log("\nthe desk books several services");
    const browser = await chromium.launch();
    try {
      const desk = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const errors: string[] = [];
      desk.on("pageerror", (e) => errors.push(e.message));
      await signIn(desk, `owner-${slug}@test.local`);
      await desk.goto(`${BASE}/c/${slug}/calendar?tab=schedule`);
      await desk.waitForLoadState("networkidle");
      await desk.addStyleTag({ content: "nextjs-portal{display:none!important}" });
      await desk.getByRole("button", { name: "New appointment" }).first().click();
      const aside = desk.locator("aside").last();
      await aside.locator("text=Create new patient").click();
      await aside.locator('input[placeholder="Full name"]').fill("Two Services");
      await aside.locator('input[placeholder="xxxxxxxxxx"]').fill(phone());
      await aside.locator("select[data-add-service]").selectOption(CLEAN);
      await aside.locator("select[data-add-service]").selectOption(CHECK);
      check("each service chosen is a chip", (await aside.locator("[data-visit-service]").count()) === 2);
      check("the list offers what is left, not what is chosen", (await aside.locator(`select[data-add-service] option[value="${CLEAN}"]`).count()) === 0);
      const length = await aside.locator('input[inputmode="numeric"], input[type="number"]').last().inputValue().catch(() => "");
      check("the length is both together", length === "50", length);
      check("and says so", (await desk.locator("aside").last().innerText()).includes("2 services · 50 min in total"));
      if (SHOTS) await desk.locator("aside").last().screenshot({ path: `${SHOTS}/desk-1-new.png` });
      await aside.locator("select[data-doctor-select]").selectOption(doc);
      await aside.locator('input[type="date"]').fill(day);
      await aside.locator('input[type="time"]').fill("15:00");
      await aside.locator("button:has-text('Save')").click();
      await desk.waitForSelector("text=Appointment booked", { timeout: 15000 }).catch(() => {});
      const staff = (
        await db.query(
          `select a.id, a.service_id, a.created_by, (select count(*)::int from appointment_extra_services e where e.appointment_id = a.id) as extras
             from appointments a join patients p on p.id = a.patient_id where a.clinic_id = $1 and p.full_name = 'Two Services'`,
          [clinic]
        )
      ).rows[0];
      check("the visit is saved with both", staff?.service_id === CLEAN && staff?.extras === 1, JSON.stringify(staff));

      console.log("\nwho booked it");
      await desk.goto(`${BASE}/c/${slug}/calendar?open=${staff.id}`);
      await desk.waitForSelector("[data-booked-by]", { timeout: 20000 }).catch(() => {});
      const panel = await desk.locator("aside").last().innerText();
      check("the panel says who booked it", panel.includes("Booked by Rana Owner"), panel.slice(0, 160));
      check("and lists both services", (await desk.locator("aside [data-visit-service]").count()) === 2);
      // Take the second one off again and save: the visit is back to one service.
      await desk.locator(`aside [data-visit-service="${CHECK}"] button`).click();
      const chipsLeft = await desk
        .waitForFunction(`document.querySelectorAll("aside [data-visit-service]").length === 1`, null, { timeout: 5000 })
        .then(() => true)
        .catch(() => false);
      check("the chip goes at once", chipsLeft);
      await desk.locator("aside").last().locator("button:has-text('Save')").click();
      const saved = await desk.waitForSelector("text=Appointment updated", { timeout: 15000 }).then(() => true).catch(() => false);
      check("the change saves", saved, (await desk.locator("aside").last().innerText().catch(() => "")).slice(0, 200));
      const after = (await db.query(`select count(*)::int as n from appointment_extra_services where appointment_id = $1`, [staff.id])).rows[0].n;
      check("removing a chip removes the service", after === 0, `${after}`);

      await desk.goto(`${BASE}/c/${slug}/calendar?open=${booked.body.appointmentId}`);
      await desk.waitForSelector("[data-booked-by]", { timeout: 20000 }).catch(() => {});
      const online = await desk.locator("aside").last().innerText();
      check("an online booking names its link", online.includes("Booked online · Instagram ad"), online.slice(0, 160));
      if (SHOTS) await desk.locator("aside").last().screenshot({ path: `${SHOTS}/desk-2-online.png` });

      console.log("\nthe board names every service");
      const soon = DateTime.now().plus({ minutes: 20 });
      if (soon.setZone(TZ).toISODate() === DateTime.now().setZone(TZ).toISODate()) {
        const todayP = (
          await db.query(`insert into patients (clinic_id, full_name, phone_e164) values ($1, 'Board Bana', '+962790000002') returning id`, [clinic])
        ).rows[0].id as string;
        const todayA = (
          await db.query(
            `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status, created_by)
             values ($1, $2, $3, $4, $5, $6, 'confirmed', $7) returning id`,
            [clinic, todayP, doc, CLEAN, soon.toUTC().toISO(), soon.plus({ minutes: 75 }).toUTC().toISO(), ownerId]
          )
        ).rows[0].id as string;
        await db.query(`insert into appointment_extra_services (clinic_id, appointment_id, service_id, sort) values ($1, $2, $3, 1)`, [
          clinic,
          todayA,
          WHITE,
        ]);
        await desk.goto(`${BASE}/c/${slug}/calendar`);
        await desk.waitForSelector(`[data-flow-card="${todayA}"]`, { timeout: 20000 }).catch(() => {});
        const cardText = await text(desk, `[data-flow-card="${todayA}"]`);
        check("the card reads both services", cardText.includes("Cleaning + Whitening"), cardText.slice(0, 120));
        check("and who booked it", cardText.includes("Booked by Rana"), cardText.slice(0, 160));
      } else {
        console.log("  (skipped: too close to midnight for a visit today)");
      }
      check("no page errors at the desk", errors.length === 0, errors.join(" | "));

      /* ------------------------------------------------- 3. the booking page */
      console.log("\nthe booking page");
      // Reduced motion: the screenshots are of the page at rest, not mid-fade.
      const pub = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
      const pubErrors: string[] = [];
      pub.on("pageerror", (e) => pubErrors.push(e.message));
      await pub.goto(`${BASE}/book/${slug}-multi`);
      await pub.waitForLoadState("networkidle");
      if (SHOTS) await pub.screenshot({ path: `${SHOTS}/book-1-services.png`, fullPage: true });
      check("the services are ticked, not tapped through", (await pub.locator("[data-service-toggle]").count()) === 3);
      await pub.locator(`[data-service-toggle="${CLEAN}"]`).click();
      await pub.locator(`[data-service-toggle="${WHITE}"]`).click();
      const summary = await text(pub, "[data-picked-summary]");
      check("the bar adds them up", summary.includes("2 services · 75 min"), summary);
      await pub.getByRole("button", { name: "Continue" }).click();
      await pub.waitForSelector("button.tnum", { timeout: 20000 }).catch(() => {});
      check("the times say what they are for", (await text(pub)).includes("Cleaning + Whitening · 75 min"));
      if (SHOTS) await pub.screenshot({ path: `${SHOTS}/book-2-time.png`, fullPage: true });
      await pub.locator("button.tnum").first().click();
      await pub.getByRole("button", { name: "Continue" }).click();
      await pub.waitForSelector("[data-booking-card]", { timeout: 10000 }).catch(() => {});
      check("the appointment card names both", (await text(pub, "[data-booking-card]")).includes("Cleaning + Whitening"));
      await pub.getByPlaceholder("Your full name").fill("Page Patient");
      await pub.getByPlaceholder("079 000 0000").fill(phone());
      if (SHOTS) await pub.screenshot({ path: `${SHOTS}/book-3-details.png`, fullPage: true });
      await pub.getByRole("button", { name: /Confirm booking|Send code/ }).click();
      await pub.waitForSelector("text=Booking confirmed", { timeout: 20000 }).catch(() => {});
      check("the patient is told it is booked", (await text(pub)).includes("Booking confirmed"));
      if (SHOTS) await pub.screenshot({ path: `${SHOTS}/book-4-done.png`, fullPage: true });
      const fromPage = (
        await db.query(
          `select appointment_service_names(a.id, false) as names from appointments a join patients p on p.id = a.patient_id
            where a.clinic_id = $1 and p.full_name = 'Page Patient'`,
          [clinic]
        )
      ).rows[0];
      check("and the visit holds both services", fromPage?.names === "Cleaning + Whitening", fromPage?.names);

      await pub.goto(`${BASE}/book/${slug}-one`);
      await pub.waitForLoadState("networkidle");
      check("a link without the switch taps one service through", (await pub.locator("[data-service-toggle]").count()) === 0);

      console.log("\na pale clinic colour");
      await db.query(`update clinics set brand_color = '#cdeee0' where id = $1`, [clinic]);
      await pub.goto(`${BASE}/book/${slug}-multi`);
      await pub.waitForLoadState("networkidle");
      const ink = await pub.evaluate(`getComputedStyle(document.querySelector("[data-booking-band]")).color`);
      check("dark ink on a pale band, not white", ink === "rgb(11, 18, 32)", String(ink));
      if (SHOTS) {
        await pub.locator(`[data-service-toggle="${CLEAN}"]`).click();
        await pub.screenshot({ path: `${SHOTS}/book-5-pale.png`, fullPage: true });
        await db.query(`update clinics set default_locale = 'ar' where id = $1`, [clinic]);
        await pub.goto(`${BASE}/book/${slug}-one`);
        await pub.waitForLoadState("networkidle");
        await pub.screenshot({ path: `${SHOTS}/book-6-arabic.png`, fullPage: true });
      }
      check("no page errors on the booking page", pubErrors.length === 0, pubErrors.join(" | "));
    } finally {
      await browser.close();
    }
  } finally {
    if (clinic) await db.query(`delete from clinics where id = $1`, [clinic]);
    if (userIds.length) await db.query(`delete from users where id = any($1::uuid[])`, [userIds]);
    await db.end();
  }

  console.log(`\n  multi-service: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
