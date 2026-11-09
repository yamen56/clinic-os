/**
 * Every WhatsApp message that did not reach the patient says why, where staff
 * look: under the message in the inbox, in Settings → WhatsApp, and in an
 * automation's history. And "Send again" works from the inbox.
 *
 * The worker's side (what gets recorded) is qa-whatsapp-delivery; this is the
 * reading side, in a real browser. Assertions are on innerText, never
 * textContent — the whole dictionary ships in every page.
 *
 *   npx tsx scripts/qa-wa-delivery-ui.ts          (needs `npm run dev`; run qa-warm first)
 *   QA_SHOTS=1 npx tsx scripts/qa-wa-delivery-ui.ts   also saves screenshots to the temp dir
 */
import { chromium, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  const slug = `qawaui${Date.now().toString(36)}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, timezone) values ('QA Delivery','الوصول',$1,'Asia/Amman') returning id`,
      [slug]
    )
  ).rows[0].id as string;
  // Linked and online: waiting messages are waiting on something other than the phone.
  await db.query(`insert into whatsapp_sessions (clinic_id, status, desired) values ($1,'connected',false)`, [clinic]);
  const email = `waui-${slug}@test.local`;
  const user = (
    await db.query(
      `insert into users (email, password_hash, full_name, locale) values ($1,$2,'QA Delivery','en') returning id`,
      [email, bcrypt.hashSync("password123", 10)]
    )
  ).rows[0].id as string;
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1,$2,'receptionist',true,'{"level":"full"}')`,
    [clinic, user]
  );
  const patient = (
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164) values ($1,'Delivery Patient','+962790555000') returning id`,
      [clinic]
    )
  ).rows[0].id as string;
  const conv = (
    await db.query(
      `insert into conversations (clinic_id, phone_e164, patient_id, on_whatsapp, wa_checked_at)
       values ($1,'+962790555000',$2,false, now()) returning id`,
      [clinic, patient]
    )
  ).rows[0].id as string;

  const automation = (
    await db.query(`insert into automations (clinic_id, name, trigger_type) values ($1,'QA reminder','appointment_reminder') returning id`, [clinic])
  ).rows[0].id as string;
  const run = (
    await db.query(
      `insert into automation_runs (clinic_id, automation_id, patient_id, status, conversation_id) values ($1,$2,$3,'completed',$4) returning id`,
      [clinic, automation, patient, conv]
    )
  ).rows[0].id as string;

  // One message for each way a message can fail to arrive, oldest first.
  const seed = async (
    body: string,
    status: string,
    error: string | null,
    opts: { minutesAgo: number; sentHoursAgo?: number; scheduledInMin?: number; kind?: string; run?: string; delivered?: boolean }
  ) =>
    (
      await db.query(
        `insert into messages (clinic_id, conversation_id, direction, sender_kind, body, status, error,
                               created_at, sent_at, scheduled_at, delivered_at, automation_run_id, wa_message_id)
         values ($1,$2,'out',$3,$4,$5,$6,
                 now() - make_interval(mins => $7),
                 case when $8::int is null then null else now() - make_interval(hours => $8::int) end,
                 now() + make_interval(mins => coalesce($9::int, 0)),
                 case when $10 then now() else null end, $11,
                 case when $5 in ('sent','delivered','read') or $6 like 'wa_rejected:%' then 'QAUI' || gen_random_uuid() else null end)
         returning id`,
        [
          clinic, conv, opts.kind ?? "staff", body, status, error, opts.minutesAgo,
          opts.sentHoursAgo ?? null, opts.scheduledInMin ?? null, !!opts.delivered, opts.run ?? null,
        ]
      )
    ).rows[0].id as string;

  const noAccount = await seed("Your appointment is tomorrow", "failed", "no_whatsapp_account", { minutesAgo: 600 });
  await seed("Your invoice", "failed", "wa_rejected:463", { minutesAgo: 590, sentHoursAgo: 9 });
  await seed("Reminder: see you at 10", "cancelled", "appointment_passed", { minutesAgo: 580, kind: "automation", run });
  await seed("Phone off all night", "sent", null, { minutesAgo: 570, sentHoursAgo: 9 });
  await seed("Arrived fine", "delivered", null, { minutesAgo: 560, sentHoursAgo: 9, delivered: true });
  await seed("Over today's limit", "queued", "held:daily_cap", { minutesAgo: 5, scheduledInMin: 900 });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const shots = process.env.QA_SHOTS ? path.join(os.tmpdir(), `qa-wa-delivery-${slug}`) : null;
  const shot = async (p: Page, name: string) => {
    if (shots) await p.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
  };

  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120000 });

  /* ------------------------------------------------------------- the inbox */
  console.log("  — inbox —");
  await page.goto(`${BASE}/c/${slug}/conversations?open=${conv}`, { timeout: 120000 });
  await page.waitForSelector("[data-delivery-note]", { timeout: 60000 });
  const notes = await page.$$eval("[data-delivery-note]", (els) =>
    els.map((e) => ({ kind: e.getAttribute("data-delivery-note"), text: (e as HTMLElement).innerText }))
  );
  const has = (kind: string, words: string) => notes.some((n) => n.kind === kind && n.text.includes(words));
  check("no WhatsApp account says so", has("failed", "isn't on WhatsApp"), JSON.stringify(notes));
  check("a refusal names the restriction and its code", has("failed", "starting new chats (code 463)"));
  check("a cancelled reminder says the appointment had started", has("cancelled", "appointment had already started"));
  check("a sent message hours without a receipt says not delivered yet", has("undelivered", "Not delivered yet"));
  check("a held message says which limit and when it goes", has("waiting", "today's message limit") && has("waiting", "Sends"));
  check("a delivered message carries no note", notes.length === 5, `${notes.length} notes`);
  const resendable = await page.$$("[data-resend]");
  // Not on the reminder whose appointment has started: "see you at 10" at 11 is what the cancel prevented.
  check("Send again is offered on the three that never arrived and still make sense", resendable.length === 3, `${resendable.length}`);
  await shot(page, "inbox-desktop");

  await page.click(`[data-resend="${noAccount}"]`);
  await page.waitForFunction(
    (id) => !document.querySelector(`[data-resend="${id}"]`),
    noAccount,
    { timeout: 20000 }
  );
  const after = await page.$$eval("[data-delivery-note]", (els) => els.map((e) => (e as HTMLElement).innerText));
  check("after Send again the original says it was sent again", after.some((t) => t.includes("Sent again")), JSON.stringify(after));
  const copy = (
    await db.query(
      `select status, sender_kind, sender_user_id from messages where conversation_id = $1 and body = 'Your appointment is tomorrow' and id <> $2`,
      [conv, noAccount]
    )
  ).rows[0];
  check(
    "and a copy is queued in this staff member's name",
    copy?.status === "queued" && copy?.sender_kind === "staff" && copy?.sender_user_id === user,
    JSON.stringify(copy)
  );
  const cv = (await db.query(`select on_whatsapp from conversations where id = $1`, [conv])).rows[0];
  check("and WhatsApp will be asked about the number again", cv.on_whatsapp === null);

  // The phone goes offline: what is waiting now waits on that.
  await db.query(`update whatsapp_sessions set status = 'qr' where clinic_id = $1`, [clinic]);
  await page.reload();
  await page.waitForSelector("[data-delivery-note]", { timeout: 60000 });
  const offline = await page.$$eval('[data-delivery-note="waiting"]', (els) => els.map((e) => (e as HTMLElement).innerText));
  check(
    "with WhatsApp disconnected, waiting messages say that is why",
    offline.length >= 1 && offline.every((t) => t.includes("not connected")),
    JSON.stringify(offline)
  );

  // At phone width the reasons still fit beside nothing and spill nowhere.
  const phone = await ctx.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(`${BASE}/c/${slug}/conversations?open=${conv}`, { timeout: 120000 });
  await phone.waitForSelector("[data-delivery-note]", { timeout: 60000 });
  const overflow = await phone.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
  check("no sideways scroll on a phone", Number(overflow) <= 0, `${overflow}px`);
  await shot(phone, "inbox-phone");
  await phone.close();
  await db.query(`update whatsapp_sessions set status = 'connected' where clinic_id = $1`, [clinic]);

  /* ---------------------------------------------- Settings → WhatsApp */
  console.log("  — settings —");
  await page.goto(`${BASE}/c/${slug}/settings/whatsapp`, { timeout: 120000 });
  await page.waitForSelector("[data-delivery-problems]", { timeout: 60000 });
  const list = await page.$eval("[data-delivery-problems]", (e) => (e as HTMLElement).innerText);
  check("the week's undelivered messages are listed", list.includes("Messages that didn't reach the patient"));
  check("each with its reason", list.includes("code 463") && list.includes("appointment had already started") && list.includes("Not delivered yet"));
  check("one already sent again is left out", !list.includes("isn't on WhatsApp"), list);
  check("each links to its chat", (await page.$$(`[data-delivery-problems] a[href*="open=${conv}"]`)).length >= 3);
  const card = await page.innerText("main");
  check("the counts include what was not sent", card.includes("Not sent (too late)") && card.includes("not on the phone after 6 hours"));
  await shot(page, "settings");

  /* ------------------------------------------- an automation's history */
  console.log("  — automation history —");
  await page.goto(`${BASE}/c/${slug}/automations/${automation}?tab=activity`, { timeout: 120000 });
  const problem = await page.waitForSelector("[data-run-message-problem]", { timeout: 30000 }).catch(() => null);
  check("a completed run whose message was not sent says so in the list", !!problem && (await problem.innerText()).includes("Not sent"));
  if (problem) {
    await problem.click();
    const detail = await page.waitForSelector("[data-run-messages]", { timeout: 10000 }).catch(() => null);
    check(
      "and opening it gives the reason",
      !!detail && (await detail.innerText()).includes("appointment had already started"),
      detail ? await detail.innerText() : "no detail"
    );
    await shot(page, "automation");
  }

  await browser.close();
  await db.query(`delete from clinics where id = $1`, [clinic]);
  await db.query(`delete from users where id = $1`, [user]);
  await db.end();

  if (shots) console.log(`\n  screenshots: ${shots}`);
  console.log(`\n  whatsapp delivery ui: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
