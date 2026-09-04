/**
 * The dashboard: what it shows, who it shows it to, and the keys.
 *
 * Two things are being protected. The first is that the front page is the one
 * screen every member can open, so it is the one screen where a section hidden
 * from the nav can leak anyway — a receptionist whose owner removed Invoices
 * must not read the week's takings off it, and the queries behind those numbers
 * should not even run for her.
 *
 * The second is that the numbers are right. A dashboard that is merely plausible
 * is worse than none: nobody checks a figure they believe, so a wrong one is
 * believed for months. Every total here is asserted against a fixture whose
 * arithmetic is written out in the test.
 */
try { process.loadEnvFile?.(); } catch {}

import { Client } from "pg";
import { chromium, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { DateTime } from "luxon";
import { ar } from "../src/lib/i18n/ar";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const TZ = "Asia/Amman";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Sign in, then wait for the dashboard itself rather than for the network. */
async function signIn(page: Page, email: string) {
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120_000 });
}

/**
 * Land on a page and let it settle.
 *
 * `networkidle` can fire while the shell is still streaming under
 * c/[slug]/loading.tsx, and the dev overlay is itself wider than a 320px phone —
 * see qa-mobile-width, which is where this sequence comes from.
 */
async function land(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.waitForTimeout(400);
}

const text = async (page: Page) =>
  (await page.locator("main").first().innerText()).replace(/\s+/g, " ");

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  const stamp = Date.now().toString(36);
  const slug = `qadash${stamp}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, default_locale, timezone, currency, invoice_prefix)
       values ('QA Dash','لوحة',$1,'ar',$2,'JOD','QAD') returning id`,
      [slug, TZ]
    )
  ).rows[0];
  const clinicId = clinic.id as string;
  await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinicId]);

  const mkUser = async (tag: string, perms: string) =>
    (
      await db.query(
        `insert into users (email, password_hash, full_name, locale) values ($1,$2,$3,'ar') returning id`,
        [`${tag}-${slug}@test.local`, bcrypt.hashSync("password123", 10), `QA ${tag}`]
      )
    ).rows[0].id as string;

  const ownerId = await mkUser("owner", "");
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1,$2,'receptionist',true,'{"level":"full"}')`,
    [clinicId, ownerId]
  );
  /*
    A member with everything except invoices. The point of the fixture: the
    money must be absent from her dashboard, not merely hidden by CSS.
  */
  const deskId = await mkUser("desk", "");
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, permissions)
     values ($1,$2,'receptionist',$3)`,
    [
      clinicId,
      deskId,
      JSON.stringify({
        level: "custom",
        caps: { calendar: true, patients: true, conversations: true, invoices: false },
      }),
    ]
  );

  const docUser = await mkUser("doc", "");
  const doctor = (
    await db.query(
      `insert into clinic_members (clinic_id, user_id, role) values ($1,$2,'doctor') returning id`,
      [clinicId, docUser.length ? docUser : docUser]
    )
  ).rows[0].id as string;
  await db.query(`update users set full_name = 'د. قياس' where id = $1`, [docUser]);

  const service = (
    await db.query(
      `insert into services (clinic_id, name, name_ar, price) values ($1,'Whitening','تبييض',100) returning id`,
      [clinicId]
    )
  ).rows[0].id as string;
  const patient = (
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164, source) values ($1,'مريض القياس','+962790909090','staff') returning id`,
      [clinicId]
    )
  ).rows[0].id as string;

  const now = DateTime.now().setZone(TZ);

  /* ---- today: three appointments, one of them cancelled and so not counted */
  const at = (h: number) => now.set({ hour: h, minute: 0, second: 0, millisecond: 0 });
  for (const [h, status] of [[9, "confirmed"], [11, "scheduled"], [13, "cancelled"]] as const) {
    await db.query(
      `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [clinicId, patient, doctor, service, at(h).toUTC().toISO(), at(h).plus({ minutes: 30 }).toUTC().toISO(), status]
    );
  }

  /* ---- this month: 4 completed, 1 no-show, for the doctor breakdown */
  const monthStart = now.startOf("month");
  const inMonth = (d: number, h: number) => {
    // Keep every fixture appointment inside this month *and* in the past, so
    // "completed" is not a claim about the future.
    const day = monthStart.plus({ days: d }).set({ hour: h });
    return day > now ? now.minus({ hours: 24 - h }) : day;
  };
  for (let i = 0; i < 4; i++) {
    const s = inMonth(i, 10);
    await db.query(
      `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status)
       values ($1,$2,$3,$4,$5,$6,'completed')`,
      [clinicId, patient, doctor, service, s.toUTC().toISO(), s.plus({ minutes: 30 }).toUTC().toISO()]
    );
  }
  const missed = inMonth(4, 10);
  await db.query(
    `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status)
     values ($1,$2,$3,$4,$5,$6,'no_show')`,
    [clinicId, patient, doctor, service, missed.toUTC().toISO(), missed.plus({ minutes: 30 }).toUTC().toISO()]
  );

  /* ---- money: one invoice of 300 billed this month, 120 collected, 180 owed */
  const invoice = (
    await db.query(
      `insert into invoices (clinic_id, patient_id, seq, number, subtotal, total, amount_paid, status, issue_date)
       values ($1,$2,1,$3,300,300,120,'partially_paid',current_date) returning id`,
      [clinicId, patient, `QAD-1`]
    )
  ).rows[0].id as string;
  await db.query(
    `insert into invoice_items (clinic_id, invoice_id, service_id, description, qty, unit_price, amount)
     values ($1,$2,$3,'تبييض',3,100,300)`,
    [clinicId, invoice, service]
  );
  await db.query(
    `insert into payments (clinic_id, invoice_id, patient_id, amount, method, paid_at)
     values ($1,$2,$3,120,'cash',$4)`,
    [clinicId, invoice, patient, now.toUTC().toISO()]
  );
  // A void invoice, which must not appear in "what earns".
  const voided = (
    await db.query(
      `insert into invoices (clinic_id, patient_id, seq, number, subtotal, total, status, issue_date)
       values ($1,$2,2,$3,999,999,'void',current_date) returning id`,
      [clinicId, patient, `QAD-2`]
    )
  ).rows[0].id as string;
  await db.query(
    `insert into invoice_items (clinic_id, invoice_id, service_id, description, qty, unit_price, amount)
     values ($1,$2,$3,'ملغاة',1,999,999)`,
    [clinicId, voided, service]
  );
  console.log(`\n✓ fixture clinic ${slug}`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  try {
    /* =============================================================== owner */
    console.log("\n[what the owner sees]");
    await signIn(page, `owner-${slug}@test.local`);
    await land(page, `${BASE}/c/${slug}`);
    let body = await text(page);

    check("today counts the day's appointments", body.includes("مواعيد اليوم"), "");
    /*
      Counted from the database rather than hard-coded.

      The number used to be a literal 2 — the three this fixture books today,
      less the cancelled one. That held only in the middle of a month. The
      "earlier this month" appointments below are built as `monthStart + d days`
      for d=0..4 and clamped back into the past if they land in the future, so
      during the first days of a month several of them come to rest on *today*
      and join the count: 7 on the 1st, 4 on the 4th, 2 for the rest of the
      month. The suite went red for the first week of every month and the answer
      was always "not a regression, ignore it" — which is exactly the habit a
      test suite must not teach.

      Asking the database keeps the assertion pointed at what it was always
      about: the tile counts today's appointments and leaves the cancelled one
      out. Both halves are checked, so a tile that simply counted everything
      would still fail.
    */
    const todays = await db.query(
      `select count(*) filter (where status <> 'cancelled')::int as live,
              count(*)::int as all_of_them
         from appointments
        where clinic_id = $1 and (starts_at at time zone $2)::date = (now() at time zone $2)::date`,
      [clinicId, TZ]
    );
    const { live, all_of_them: booked } = todays.rows[0] as { live: number; all_of_them: number };
    check(
      "and excludes the cancelled one",
      live < booked && new RegExp(`مواعيد اليوم\\s*${live}\\b`).test(body),
      `tile should say ${live} of ${booked} booked — ${body.slice(0, 80)}`
    );
    check("the week's takings are shown", body.includes(ar.dashboard.revenueWeek), "");
    check(
      "collected this week is the 120 that was paid",
      body.includes("120.00"),
      body.match(/[\d,]+\.\d\d/g)?.slice(0, 4).join(" ") ?? ""
    );
    /*
      Scoped to the tile, not the page. 300 legitimately appears further down as
      what the service billed, so a page-wide "does not contain 300" would fail
      for the right reason and teach the wrong lesson.
    */
    const owedTile = await page
      .locator(`text=${ar.dashboard.outstanding}`)
      .locator("xpath=ancestor::*[contains(@class,'rounded-card')][1]")
      .innerText();
    check(
      "owed is total minus paid, not the invoice total",
      owedTile.includes("180.00") && !owedTile.includes("300.00"),
      owedTile.replace(/\s+/g, " ")
    );

    console.log("\n[the analytics]");
    check("the takings chart is there", body.includes(ar.dashboard.revenueTrend), "");
    check("so is the appointments chart", body.includes(ar.dashboard.appointmentsTrend), "");
    check("what earns, this month", body.includes(ar.dashboard.topServices), "");
    check("named by service", body.includes("تبييض"), "");
    check(
      "billed at the line total",
      body.includes("300.00"),
      body.match(/[\d,]+\.\d\d/g)?.join(" ") ?? ""
    );
    check("a void invoice is left out of it", !body.includes("999"), "");
    check("the doctor breakdown is there", body.includes(ar.dashboard.byDoctor), "");
    check("with the doctor named", body.includes("د. قياس"), "");
    check(
      "four completed and one missed",
      /4 مكتمل/.test(body) && /1 لم يحضر/.test(body),
      body.match(/\d+ مكتمل[^,]{0,20}/)?.[0] ?? ""
    );
    check(
      "and the clinic's own no-show share, 1 of 5",
      body.includes(ar.dashboard.noShowShare.replace("{n}", "20")),
      "expected 20%"
    );

    /* =============================================================== keys */
    console.log("\n[the shortcuts]");
    check("the buttons are on the header", body.includes(ar.dashboard.newAppointment), "");

    await page.keyboard.press("KeyA");
    await page.waitForURL(/\/calendar/, { timeout: 20_000 }).catch(() => {});
    check("A opens a new appointment", page.url().includes("/calendar?new=1"), page.url());
    /*
      By its heading, not by role=dialog. The appointment panel is a side panel
      rather than a Modal and carries no dialog role — worth knowing, because it
      means a screen reader is not told it opened either.
    */
    const panel = page.locator(`text=${ar.calendar.newAppointment}`).first();
    await panel.waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});
    check("and the create panel is actually open", await panel.isVisible().catch(() => false), "");

    await land(page, `${BASE}/c/${slug}`);
    await page.keyboard.press("KeyP");
    await page.waitForURL(/\/patients/, { timeout: 20_000 }).catch(() => {});
    check("P opens a new patient", page.url().includes("/patients?new=1"), page.url());
    const newPatient = page.getByRole("dialog");
    await newPatient.waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});
    check("with its dialog open", (await newPatient.count()) > 0, "");
    await page.keyboard.press("Escape");

    await land(page, `${BASE}/c/${slug}`);
    await page.keyboard.press("KeyI");
    await page.waitForURL(/\/invoices/, { timeout: 20_000 }).catch(() => {});
    check("I starts an invoice", page.url().includes("/invoices/new"), page.url());

    /*
      The negative that matters: a shortcut must never fire while somebody is
      typing, or a receptionist searching for "Ahmad" navigates away on the "a".
    */
    await land(page, `${BASE}/c/${slug}/patients`);
    const search = page.locator('input[type="search"]').first();
    await search.click();
    await search.type("سامي");
    await page.waitForTimeout(500);
    check(
      "typing in a field does not trigger one",
      page.url().includes("/patients") && !page.url().includes("new=1"),
      page.url()
    );
    check("and the text reached the box", (await search.inputValue()).length > 0, await search.inputValue());

    /* ====================================================== restricted */
    console.log("\n[a member who cannot see money]");
    const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const p2 = await ctx2.newPage();
    await signIn(p2, `desk-${slug}@test.local`);
    await land(p2, `${BASE}/c/${slug}`);
    const deskBody = await text(p2);

    check("no takings", !deskBody.includes(ar.dashboard.revenueWeek), "");
    check("no balance owed", !deskBody.includes(ar.dashboard.outstanding), "");
    check("no takings chart", !deskBody.includes(ar.dashboard.revenueTrend), "");
    check("and none of what earns", !deskBody.includes(ar.dashboard.topServices), "");
    check(
      "not one of the amounts leaks",
      !deskBody.includes("180.00") && !deskBody.includes("300.00") && !deskBody.includes("120.00"),
      ""
    );
    check("but she still gets today's list", deskBody.includes(ar.dashboard.todayAppointments), "");
    check("the appointments chart", deskBody.includes(ar.dashboard.appointmentsTrend), "");
    check("and the doctor breakdown", deskBody.includes(ar.dashboard.byDoctor), "");
    check(
      "her row of tiles is still full",
      deskBody.includes(ar.dashboard.noShowRate) || deskBody.includes(ar.dashboard.newPatientsMonth),
      ""
    );
    check("no invoice shortcut for her", !deskBody.includes(ar.dashboard.newInvoice), "");
    await ctx2.close();

    /* ====================================================== the phone */
    console.log("\n[on a phone]");
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await land(page, `${BASE}/c/${slug}`);
      const over = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      check(`nothing scrolls sideways at ${width}px`, over <= 1, `${over}px`);
      const cut = await page.evaluate(() => {
        // A tile whose number is clipped is a number nobody can trust.
        const els = [...document.querySelectorAll<HTMLElement>(".tnum")];
        return els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent ?? "");
      });
      check(`no tile number is cut off at ${width}px`, cut.length === 0, cut.join(" | "));
    }

    check("no page errors anywhere", errors.length === 0, errors.slice(0, 2).join(" | "));
  } finally {
    await browser.close();
  }

  await db.query(`delete from clinics where id = $1`, [clinicId]);
  await db.query(`delete from users where email like $1`, [`%-${slug}@test.local`]);
  await db.end();

  console.log(`\n${failures.length ? "✗" : "✓"} ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
