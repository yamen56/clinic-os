/**
 * WhatsApp verification is the clinic's choice, per link — and still the default.
 *
 * Every public booking used to pass through a six-digit code. That is the right
 * default: it proves the number belongs to whoever is booking, which is what
 * makes the reminder arrive and a no-show reachable. But it is a step, and a
 * clinic handing a link across its own front desk is protecting against a risk
 * it can see is not there.
 *
 * So the things that have to hold are mostly about *not* weakening anything by
 * accident:
 *
 *   - a link that has not been touched still asks for a code;
 *   - a link with it switched off books immediately, and says so on the button
 *     rather than promising a code that is not coming;
 *   - the browser cannot ask to skip — the setting is read from the link's row;
 *   - and the two ways a booking ends up unverified stay distinguishable on the
 *     appointment, because one is a decision and the other is a fault.
 *
 * Needs the dev stack: npx tsx scripts/dev-all.ts (and qa-warm first).
 *
 *   npx tsx scripts/qa-booking-otp.ts
 */
import { chromium, type Page } from "playwright";
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

/**
 * Walks the public page as far as the details step and fills it in.
 *
 * The day strip renders enabled and the per-day counts arrive afterwards, so a
 * chip can go disabled under a locator that already resolved it — hence the
 * short per-click deadline rather than one long wait that hangs.
 */
async function reachDetails(page: Page, linkSlug: string, name: string, phone: string) {
  await page.goto(`${BASE}/book/${linkSlug}`);
  await page.waitForLoadState("networkidle");
  const chips = page.locator("button:has(span.tnum)");
  const total = await chips.count();
  let open = false;
  for (let i = 1; i < Math.min(total, 10) && !open; i++) {
    try {
      await chips.nth(i).click({ timeout: 3000 });
      await page.waitForSelector("button.tnum", { timeout: 4000 });
      open = true;
    } catch {
      /* Closed, full, or greyed out as the counts landed — try the next. */
    }
  }
  if (!open) return false;
  await page.locator("button.tnum").first().click();
  await page.getByRole("button", { name: /متابعة|Next/ }).first().click();
  await page.fill('input[autocomplete="name"]', name);
  await page.fill('input[autocomplete="tel"]', phone);
  return true;
}

const submitBtn = (page: Page) =>
  page.getByRole("button", { name: /إرسال الرمز|تأكيد الحجز/ }).first();

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const tag = Date.now().toString(36);
  const slug = `qaotp${tag}`;

  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug) values ('QA OTP', 'رمز التحقق', $1) returning id`,
      [slug]
    )
  ).rows[0];

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  try {
    /*
      Connected, deliberately. With WhatsApp offline every link skips the code
      anyway, and a suite about the setting would pass without the setting
      existing — the oldest way for a test like this to prove nothing.
    */
    await db.query(`insert into whatsapp_sessions (clinic_id, status) values ($1, 'connected')`, [
      clinic.id,
    ]);

    const service = (
      await db.query(
        `insert into services (clinic_id, name, name_ar, duration_min, price, bookable_online)
         values ($1, 'Checkup', 'فحص', 30, 20, true) returning id`,
        [clinic.id]
      )
    ).rows[0].id as string;
    const user = (
      await db.query(
        `insert into users (email, password_hash, full_name) values ($1, 'x', 'د. سامي') returning id`,
        [`qaotp-${tag}@test.local`]
      )
    ).rows[0];
    const member = (
      await db.query(
        `insert into clinic_members (clinic_id, user_id, role) values ($1, $2, 'doctor') returning id`,
        [clinic.id, user.id]
      )
    ).rows[0];
    await db.query(
      `insert into service_doctors (service_id, member_id, clinic_id) values ($1, $2, $3)`,
      [service, member.id, clinic.id]
    );

    /*
      The "on" link is inserted without naming the column at all — so this also
      asserts the column's own default, which is the thing protecting every link
      that existed before this shipped.
    */
    await db.query(
      `insert into booking_links (clinic_id, slug, service_ids, min_notice_min, skip_service_step)
       values ($1, $2, $3::uuid[], 60, true)`,
      [clinic.id, `${slug}-on`, [service]]
    );
    await db.query(
      `insert into booking_links (clinic_id, slug, service_ids, min_notice_min, skip_service_step, require_otp)
       values ($1, $2, $3::uuid[], 60, true, false)`,
      [clinic.id, `${slug}-off`, [service]]
    );
    // One question, so the heading above them can be read.
    await db.query(
      `insert into booking_questions (clinic_id, label, label_ar, field_type, required)
       values ($1, 'What brings you in?', 'ما سبب الزيارة؟', 'text', false)`,
      [clinic.id]
    );

    console.log("\n[a link nobody has touched]");
    const dflt = (
      await db.query(`select require_otp from booking_links where slug = $1`, [`${slug}-on`])
    ).rows[0];
    check("the column defaults to verifying", dflt.require_otp === true);

    const reached = await reachDetails(page, `${slug}-on`, "رنا الشريف", "0790001111");
    check("a day with times can be reached", reached);
    if (!reached) throw new Error("no open day — the rest of the suite cannot run");

    check(
      "the button offers to send a code",
      (await submitBtn(page).innerText()).includes("إرسال الرمز"),
      await submitBtn(page).innerText()
    );
    const hintOn = await page.locator("body").innerText();
    check("and the line under the number says one is coming", hintOn.includes("سنرسل رمز تأكيد"));

    console.log("\n[the heading above the clinic's own questions]");
    /*
      It used to be a sentence explaining why the clinic was asking — "تسأل
      العيادة هذه الأسئلة ليكون موعدك جاهزاً قبل وصولك" — where a heading was
      wanted. The explanation is the label's job to not need.
    */
    check("it names the section", hintOn.includes("أسئلة إضافية"));
    check("rather than explaining itself", !hintOn.includes("ليكون موعدك جاهزاً"));

    console.log("\n[submitting it]");
    await submitBtn(page).click();
    await page.waitForSelector('input[autocomplete="one-time-code"]', { timeout: 15000 });
    check("the code step is reached", true);
    const pending = (
      await db.query(`select count(*)::int as n from appointments where clinic_id = $1`, [clinic.id])
    ).rows[0].n;
    check("and nothing is booked until it is answered", pending === 0, `${pending} appointment(s)`);

    console.log("\n[a link with verification switched off]");
    const reached2 = await reachDetails(page, `${slug}-off`, "خالد النجار", "0790002222");
    check("its details step is reachable", reached2);
    check(
      "the button offers to book, not to send a code",
      (await submitBtn(page).innerText()).includes("تأكيد الحجز"),
      await submitBtn(page).innerText()
    );
    const hintOff = await page.locator("body").innerText();
    check(
      "and stops promising a code that is not coming",
      hintOff.includes("سنرسل تأكيد الحجز") && !hintOff.includes("سنرسل رمز تأكيد")
    );

    await submitBtn(page).click();
    await page.waitForSelector("text=تم تأكيد الحجز", { timeout: 20000 }).catch(() => {});
    const booked = (
      await db.query(
        `select a.notes, p.phone_e164 from appointments a join patients p on p.id = a.patient_id
          where a.clinic_id = $1`,
        [clinic.id]
      )
    ).rows;
    check("it books in one step", booked.length === 1, `${booked.length} appointment(s)`);
    check(
      "against the number that was typed",
      booked[0]?.phone_e164 === "+962790002222",
      booked[0]?.phone_e164
    );
    check(
      "and the appointment says it was booked without a code",
      (booked[0]?.notes ?? "").includes("does not ask"),
      booked[0]?.notes
    );

    console.log("\n[the browser does not get to decide]");
    /*
      The page labels itself from the setting; the route reads the link's own
      row. A posted flag asking to skip verification is exactly what an attacker
      would send, so the answer has to come from the database either way.
    */
    const res = await page.request.post(`${BASE}/api/public/book/${slug}-on/start`, {
      data: {
        serviceId: service,
        startISO: new Date(Date.now() + 5 * 864e5).toISOString(),
        fullName: "محاولة",
        phone: "0790003333",
        locale: "ar",
        requireOtp: false,
        skipVerify: true,
      },
    });
    const body = (await res.json()) as { verificationId?: string; skipVerify?: boolean };
    check(
      "asking to skip the code on a verifying link does not",
      !body.skipVerify,
      JSON.stringify(body).slice(0, 80)
    );
    const after = (
      await db.query(`select count(*)::int as n from appointments where clinic_id = $1`, [clinic.id])
    ).rows[0].n;
    check("and books nothing", after === 1, `${after} appointment(s)`);

    console.log("\n[a fault is not a decision]");
    /*
      Both now produce an unverified booking, and staff opening the appointment
      have to be able to tell which happened: one is worth looking into and the
      other is the clinic's own setting working.
    */
    await db.query(`update whatsapp_sessions set status = 'disconnected' where clinic_id = $1`, [
      clinic.id,
    ]);
    const reached3 = await reachDetails(page, `${slug}-on`, "سلمى الدباس", "0790004444");
    check("the verifying link is still usable with WhatsApp down", reached3);
    await submitBtn(page).click();
    await page.waitForSelector("text=تم تأكيد الحجز", { timeout: 20000 }).catch(() => {});
    const offline = (
      await db.query(
        `select a.notes from appointments a join patients p on p.id = a.patient_id
          where a.clinic_id = $1 and p.phone_e164 = '+962790004444'`,
        [clinic.id]
      )
    ).rows[0];
    check(
      "it books rather than losing the patient",
      !!offline,
      offline ? "booked" : "no appointment"
    );
    check(
      "and says WhatsApp was offline, not that the link asks for no code",
      (offline?.notes ?? "").includes("offline") && !(offline?.notes ?? "").includes("does not ask"),
      offline?.notes
    );

    check("no client-side errors", errors.length === 0, errors.slice(0, 2).join("; "));
  } finally {
    await browser.close();
    await db.query(`delete from clinics where id = $1`, [clinic.id]);
    await db.query(`delete from users where email like $1`, [`qaotp-${tag}@test.local`]);
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
