/**
 * Can a clinic actually send 200–500 messages in a day?
 *
 * Three things stood between it and that, and none of them announced itself:
 * a daily cap of 300 with no way to change it, a blast guard that tripped at
 * eight identical messages — about a minute of sending — and pausing that was
 * silent when it happened.
 *
 * The pacing is real time, so this drives `processOnce` directly rather than
 * waiting on it: what is under test is which messages the sender is willing to
 * release, not how long the clock takes.
 */
import { Client } from "pg";
import { chromium } from "playwright";
import bcrypt from "bcryptjs";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
process.env.DATABASE_URL ||= PG;

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

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  const slug = `qavol-test${Date.now().toString(36)}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, timezone, message_window_start, message_window_end,
                            daily_outbound_cap)
       values ('QA Volume','حجم',$1,'Asia/Amman','00:00','23:59',500) returning id`,
      [slug]
    )
  ).rows[0];
  await db.query(
    `insert into whatsapp_sessions (clinic_id, status, desired) values ($1,'connected',false)`,
    [clinic.id]
  );
  const owner = (
    await db.query(
      `insert into users (email, password_hash, full_name) values ($1,'x','Vol Owner') returning id`,
      [`vol-${slug}@test.local`]
    )
  ).rows[0];
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1,$2,'receptionist',true,'{"level":"full"}')`,
    [clinic.id, owner.id]
  );
  console.log(`✓ fixture clinic ${slug} (cap 500)`);

  /* ------------------------------------------------- the cap is reachable */
  const capRow = await db.query(`select daily_outbound_cap from clinics where id = $1`, [clinic.id]);
  check("a clinic can be set above the old 300 ceiling", capRow.rows[0].daily_outbound_cap === 500);

  // The rail the clinic can raise has to be raisable through the API it uses.
  const bad = await db.query(
    `select 1 from clinics where id = $1 and daily_outbound_cap between 10 and 5000`,
    [clinic.id]
  );
  check("and stays inside the range the API accepts", bad.rowCount === 1);

  /* ----------------------------------- 500 in a day is not deferred by the cap */
  const conv: string[] = [];
  for (let i = 0; i < 60; i++) {
    const phone = `+96279${String(1000000 + i).slice(-7)}`;
    conv.push(
      (
        await db.query(
          `insert into conversations (clinic_id, phone_e164, on_whatsapp, wa_checked_at, wa_jid)
           values ($1,$2,true,now(),$3) returning id`,
          [clinic.id, phone, `${phone.replace("+", "")}@s.whatsapp.net`]
        )
      ).rows[0].id
    );
  }

  // 499 already sent today, and one more waiting: the last message under the
  // cap must go, and the first one over it must be held rather than lost.
  await db.query(
    `update whatsapp_sessions set outbound_today = 499,
            outbound_date = (now() at time zone 'Asia/Amman')::date
      where clinic_id = $1`,
    [clinic.id]
  );

  const { queueWhatsAppMessage } = await import("../src/lib/outbound");
  const { withSystem } = await import("../worker/db");
  const { sessions } = await import("../worker/wa/session");
  const { processOnce } = await import("../worker/outbound");

  let n = 0;
  const sock = {
    user: { id: "962790000000:1@s.whatsapp.net" },
    onWhatsApp: async (p: string) => [{ jid: `${p.replace("+", "")}@s.whatsapp.net`, exists: true }],
    sendMessage: async () => ({ key: { id: `VOL${++n}`, fromMe: true } }),
  };
  sessions.set(clinic.id, { clinicId: clinic.id, sock, connected: true } as never);

  const queue = async (body: string, kind: "staff" | "automation", phone: string) =>
    withSystem(async (c) =>
      (await queueWhatsAppMessage(c, { clinicId: clinic.id, phoneE164: phone, body, senderKind: kind }))
        .messageId
    );

  const under = await queue("رسالة ٥٠٠", "staff", "+962791000000");
  await processOnce();
  let m = (await db.query(`select status from messages where id = $1`, [under])).rows[0];
  check("the 500th message of the day still goes", m.status === "sent", m.status);

  const over = await queue("رسالة ٥٠١", "staff", "+962791000001");
  await new Promise((r) => setTimeout(r, 10500));
  await processOnce();
  m = (await db.query(`select status, scheduled_at from messages where id = $1`, [over])).rows[0];
  check("the 501st is held for tomorrow, not dropped", m.status === "queued", m.status);
  check(
    "and is scheduled, not left to chance",
    new Date(m.scheduled_at).getTime() > Date.now(),
    new Date(m.scheduled_at).toISOString()
  );

  /* --------- an unpersonalised reminder to a roomful of patients is ordinary */
  await db.query(`update whatsapp_sessions set outbound_today = 0, paused_until = null where clinic_id = $1`, [
    clinic.id,
  ]);
  await db.query(`delete from messages where clinic_id = $1`, [clinic.id]);
  await db.query(`delete from notifications where clinic_id = $1`, [clinic.id]);

  const SAME = "نذكّرك بموعدك في العيادة غداً";
  /*
    Seed the history the guard counts rather than driving it through the sender:
    the pacing is real seconds, and forty of them is four minutes of waiting to
    learn something a hundred rows state exactly.
  */
  const seedSent = async (howMany: number) => {
    for (let i = 0; i < howMany; i++) {
      const phone = `+96278${String(1000000 + i).slice(-7)}`;
      const cv = (
        await db.query(
          `insert into conversations (clinic_id, phone_e164, on_whatsapp, wa_checked_at, wa_jid)
           values ($1,$2,true,now(),$3)
           on conflict (clinic_id, phone_e164) do update set on_whatsapp = true
           returning id`,
          [clinic.id, phone, `${phone.replace("+", "")}@s.whatsapp.net`]
        )
      ).rows[0];
      await db.query(
        `insert into messages (clinic_id, conversation_id, direction, sender_kind, msg_type, body, status, sent_at)
         values ($1,$2,'out','automation','text',$3,'sent', now())`,
        [clinic.id, cv.id, SAME]
      );
    }
  };

  // Cap 500 puts the guard at 100. Forty identical reminders is a normal day.
  await seedSent(40);
  const ordinary = await queue(SAME, "automation", "+962781999999");
  await new Promise((r) => setTimeout(r, 10500));
  await processOnce();
  m = (await db.query(`select status from messages where id = $1`, [ordinary])).rows[0];
  check("forty identical reminders do not trip the guard", m.status === "sent", m.status);
  let paused = (
    await db.query(`select paused_until from whatsapp_sessions where clinic_id = $1`, [clinic.id])
  ).rows[0];
  check("and the clinic is not paused for it", paused.paused_until === null);

  /* ---------------------------- a runaway automation still has to be stopped */
  await seedSent(101);
  const runaway = await queue(SAME, "automation", "+962781888888");
  await new Promise((r) => setTimeout(r, 10500));
  await processOnce();
  m = (await db.query(`select status from messages where id = $1`, [runaway])).rows[0];
  check("but a fan-out past the limit is held", m.status === "queued", m.status);
  paused = (
    await db.query(`select paused_until from whatsapp_sessions where clinic_id = $1`, [clinic.id])
  ).rows[0];
  check("the clinic's automations are paused", !!paused.paused_until);

  // Pausing a clinic without telling anyone is how this stayed invisible.
  const told = await db.query(
    `select count(*)::int n from notifications where clinic_id = $1 and kind = 'whatsapp_blast_guard'`,
    [clinic.id]
  );
  check("and somebody is told it happened", told.rows[0].n > 0, `${told.rows[0].n} notified`);

  /*
    A receptionist typing a reply is waiting on it. A reminder is not. Strict
    arrival order made the person wait behind the batch, which is what makes a
    working system feel broken.
  */
  await db.query(`update whatsapp_sessions set outbound_today = 0, paused_until = null where clinic_id = $1`, [
    clinic.id,
  ]);
  await db.query(`delete from messages where clinic_id = $1`, [clinic.id]);

  for (let i = 0; i < 12; i++) {
    await queue(`تذكير رقم ${i}`, "automation", `+96279${String(1000000 + i).slice(-7)}`);
  }
  const reply = await queue("أهلاً، نعم يوجد موعد غداً", "staff", "+962791000000");
  await new Promise((r) => setTimeout(r, 10500));
  await processOnce();
  m = (await db.query(`select status from messages where id = $1`, [reply])).rows[0];
  check("a staff reply goes before the reminder batch", m.status === "sent", m.status);
  const stillQueued = await db.query(
    `select count(*)::int n from messages where clinic_id = $1 and status = 'queued'`,
    [clinic.id]
  );
  check(
    "and the reminders wait their turn behind it",
    stillQueued.rows[0].n === 12,
    `${stillQueued.rows[0].n} still queued`
  );

  /* ------------------- and the clinic can raise the rail without asking us */
  await db.query(`update users set password_hash = $2 where id = $1`, [
    owner.id,
    bcrypt.hashSync("password123", 10),
  ]);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', `vol-${slug}@test.local`);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120000 });
  await page.goto(`${BASE}/c/${slug}/settings/whatsapp`);
  await page.waitForLoadState("networkidle");

  const capInput = page.locator("#daily-cap");
  check("the daily cap is an input, not a read-only number", (await capInput.count()) === 1);
  check(
    "the number safety warning sits next to it",
    (await page.locator("text=/banned|حظر/i").count()) > 0
  );
  await capInput.fill("450");
  await capInput.blur();
  // Wait for the value, not for a guessed number of milliseconds — a fixed
  // wait is what makes this fail on a loaded machine and pass on a quiet one.
  let capNow = 0;
  for (let i = 0; i < 30; i++) {
    capNow = (await db.query(`select daily_outbound_cap from clinics where id = $1`, [clinic.id]))
      .rows[0].daily_outbound_cap;
    if (capNow === 450) break;
    await page.waitForTimeout(500);
  }
  check("and changing it sticks", capNow === 450, `${capNow}`);
  await browser.close();

  sessions.delete(clinic.id);
  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  await db.query(`delete from users where id = $1`, [owner.id]);
  await db.end();
  const { pool } = await import("../worker/db");
  await pool.end();

  console.log(`\n  whatsapp volume: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
