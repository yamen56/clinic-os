/**
 * QA for bulk campaigns: audience snapshot, drip pacing, and every rail that is
 * supposed to hold the drip back.
 *
 * The pump is driven directly rather than through the worker loop, because the
 * loop only visits clinics with a live WhatsApp socket and this environment has
 * none. Everything under test — pacing, the sending window, the daily cap, the
 * failure pause, stopping — is database behaviour and runs for real.
 */
import { chromium } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";

try {
  process.loadEnvFile?.();
} catch {}

const BASE = "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

let passed = 0;
function ok(label: string) {
  passed++;
  console.log(`✓ ${label}`);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/** Waits for the campaign row itself; page text is ambiguous ("Start sending" contains "Sending"). */
async function waitForStatus(db: Client, id: string, want: string, ms = 20000) {
  const until = Date.now() + ms;
  for (;;) {
    const r = await db.query(`select status from campaigns where id = $1`, [id]);
    if (r.rows[0]?.status === want) return;
    if (Date.now() > until) throw new Error(`campaign stayed '${r.rows[0]?.status}', expected '${want}'`);
    await new Promise((res) => setTimeout(res, 250));
  }
}

async function main() {
  const { pumpClinic, reconcileDelivery } = await import("../worker/campaigns");
  const db = new Client({ connectionString: PG });
  await db.connect();

  const slug = `qacamp${Date.now().toString(36)}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, slug, timezone, default_locale, message_window_start, message_window_end, daily_outbound_cap)
       values ('QA Campaigns', $1, 'Asia/Amman', 'en', '00:00', '23:59', 300) returning id`,
      [slug]
    )
  ).rows[0];
  await db.query(`insert into whatsapp_sessions (clinic_id, status) values ($1, 'connected')`, [
    clinic.id,
  ]);
  const owner = (
    await db.query(
      `insert into users (email, password_hash, full_name, locale) values ($1, $2, 'QA Owner', 'en') returning id`,
      [`owner-${slug}@test.local`, bcrypt.hashSync("password123", 10)]
    )
  ).rows[0];
  await db.query(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'other', true, '{"level":"full"}')`, [
    clinic.id,
    owner.id,
  ]);

  // 6 patients tagged 'recall', one of them with no phone at all, plus one
  // untagged patient who must not be reached. (A phone number is unique per
  // clinic by schema, so two files cannot share one.)
  for (let i = 1; i <= 5; i++) {
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164, tags, source)
       values ($1, $2, $3, array['recall'], 'staff')`,
      [clinic.id, `Recall Patient ${i}`, `+96279000${String(1000 + i)}`]
    );
  }
  await db.query(
    `insert into patients (clinic_id, full_name, tags, source) values ($1, 'No Phone', array['recall'], 'staff')`,
    [clinic.id]
  );
  await db.query(
    `insert into patients (clinic_id, full_name, phone_e164, source)
     values ($1, 'Untagged', '+962790009999', 'staff')`,
    [clinic.id]
  );

  const cleanup = async () => {
    await db.query(`delete from clinics where id = $1`, [clinic.id]);
    await db.query(`delete from users where id = $1`, [owner.id]);
  };

  try {
    // ---------------------------------------------------------------- browser
    const browser = await chromium.launch({ channel: "chromium" });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto(`${BASE}/login`);
    await page.fill('input[name="email"]', `owner-${slug}@test.local`);
    await page.fill('input[name="password"]', "password123");
    await page.click('button[type="submit"]');
    await page.waitForURL(`**/c/${slug}`, { timeout: 20000 });

    await page.goto(`${BASE}/c/${slug}/campaigns`);
    await page.waitForSelector("text=No campaigns yet", { timeout: 20000 });
    ok("campaigns page renders empty state");

    await page.click("text=New campaign");
    await page.waitForSelector('input[maxlength="120"]');
    await page.fill('input[maxlength="120"]', "Recall drip");
    await page.fill("textarea", "Hi {{patient.first_name}}, time for a check-up at {{clinic.name}}.");
    await page.selectOption("select >> nth=0", "recall");
    // 6 tagged patients, 5 of them with a phone number.
    await page.waitForSelector("text=Will message 5 patients", { timeout: 20000 });
    ok("audience preview counts reachable numbers, not matched rows");
    await page.waitForSelector("text=1 without a phone number will be skipped");
    ok("audience preview reports patients it cannot reach");

    await page.selectOption("select >> nth=3", "60");
    await page.click("text=Review 5 recipients");
    await page.waitForURL(/\/campaigns\/[0-9a-f-]{36}$/, { timeout: 20000 });
    const campaignId = page.url().split("/").pop()!;
    ok("campaign created and opened for review");

    const snapshot = await db.query(
      `select full_name, phone_e164, sort from campaign_recipients where campaign_id = $1 order by sort`,
      [campaignId]
    );
    assert(snapshot.rowCount === 5, `expected 5 recipients, got ${snapshot.rowCount}`);
    assert(
      !snapshot.rows.some((r) => r.full_name === "Untagged"),
      "untagged patient leaked into the audience"
    );
    assert(
      new Set(snapshot.rows.map((r) => r.phone_e164)).size === 5,
      "a phone number was queued twice"
    );
    assert(
      snapshot.rows.every((r, i) => r.sort === i + 1),
      "recipients have no deterministic drip order"
    );
    ok("audience is frozen in send order, one row per number, filtered by tag");

    // Tagging someone new must not change a campaign that was already reviewed.
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164, tags, source)
       values ($1, 'Late Joiner', '+962790008888', array['recall'], 'staff')`,
      [clinic.id]
    );
    const after = await db.query(
      `select count(*)::int as n from campaign_recipients where campaign_id = $1`,
      [campaignId]
    );
    assert(after.rows[0].n === 5, "audience shifted after creation");
    ok("audience does not drift once the campaign exists");

    // ------------------------------------------------------------ drip pacing
    await page.click('button:has-text("Start sending")');
    await waitForStatus(db, campaignId, "running");
    ok("campaign starts from the detail view");

    await pumpClinic(clinic.id);
    let queued = await db.query(
      `select count(*)::int as n from messages where clinic_id = $1 and sender_kind = 'campaign'`,
      [clinic.id]
    );
    assert(queued.rows[0].n === 1, `first pump queued ${queued.rows[0].n}, expected 1`);
    ok("first pump releases exactly one recipient");

    // Immediately again: the interval has not elapsed.
    await pumpClinic(clinic.id);
    await pumpClinic(clinic.id);
    queued = await db.query(
      `select count(*)::int as n from messages where clinic_id = $1 and sender_kind = 'campaign'`,
      [clinic.id]
    );
    assert(queued.rows[0].n === 1, `pacing broken: ${queued.rows[0].n} messages queued`);
    ok("further pumps release nothing until the interval elapses");

    const body = (
      await db.query(
        `select body from messages where clinic_id = $1 and sender_kind = 'campaign' limit 1`,
        [clinic.id]
      )
    ).rows[0].body as string;
    assert(!body.includes("{{"), `template not rendered: ${body}`);
    assert(body.startsWith("Hi Recall"), `unexpected personalisation: ${body}`);
    ok("message is personalised per recipient");

    const due = async () => db.query(`update campaigns set next_send_at = now() where id = $1`, [campaignId]);

    // --------------------------------------------------------- sending window
    await db.query(
      // A window that closed an hour ago in clinic-local time.
      `update clinics set message_window_start = (now() at time zone 'Asia/Amman' - interval '3 hours')::time,
                          message_window_end   = (now() at time zone 'Asia/Amman' - interval '1 hour')::time
       where id = $1`,
      [clinic.id]
    );
    await due();
    await pumpClinic(clinic.id);
    queued = await db.query(
      `select count(*)::int as n from messages where clinic_id = $1 and sender_kind = 'campaign'`,
      [clinic.id]
    );
    assert(queued.rows[0].n === 1, "drip sent outside the clinic's messaging window");
    ok("drip holds outside the sending window");
    await db.query(
      `update clinics set message_window_start = '00:00', message_window_end = '23:59' where id = $1`,
      [clinic.id]
    );

    // -------------------------------------------------------------- daily cap
    await db.query(
      `update whatsapp_sessions set outbound_today = 300, outbound_date = (now() at time zone 'Asia/Amman')::date
       where clinic_id = $1`,
      [clinic.id]
    );
    await due();
    await pumpClinic(clinic.id);
    queued = await db.query(
      `select count(*)::int as n from messages where clinic_id = $1 and sender_kind = 'campaign'`,
      [clinic.id]
    );
    assert(queued.rows[0].n === 1, "drip ignored the daily cap");
    ok("drip holds once the clinic's daily cap is reached");
    await db.query(`update whatsapp_sessions set outbound_today = 0 where clinic_id = $1`, [clinic.id]);

    // ---------------------------------------------------------- failure pause
    await db.query(
      `update whatsapp_sessions set paused_until = now() + interval '10 minutes' where clinic_id = $1`,
      [clinic.id]
    );
    await due();
    await pumpClinic(clinic.id);
    queued = await db.query(
      `select count(*)::int as n from messages where clinic_id = $1 and sender_kind = 'campaign'`,
      [clinic.id]
    );
    assert(queued.rows[0].n === 1, "drip ignored the send-failure pause");
    ok("drip holds while the number is paused for send failures");
    await db.query(`update whatsapp_sessions set paused_until = null where clinic_id = $1`, [clinic.id]);

    // ------------------------------------------------- delivery reconciliation
    await due();
    await pumpClinic(clinic.id);
    await db.query(
      `update messages set status = 'sent', sent_at = now() where clinic_id = $1 and sender_kind = 'campaign' and status = 'queued'`,
      [clinic.id]
    );
    await reconcileDelivery();
    const sent = await db.query(
      `select count(*)::int as n from campaign_recipients where campaign_id = $1 and status = 'sent'`,
      [campaignId]
    );
    assert(sent.rows[0].n === 2, `expected 2 sent recipients, got ${sent.rows[0].n}`);
    ok("recipients follow their message to sent");

    // ------------------------------------------------------------------- stop
    await due();
    await pumpClinic(clinic.id); // one more sitting in the outbox, unsent
    await page.reload();
    await page.click('button:has-text("Stop")');
    await page.waitForSelector("text=Stop this campaign?", { timeout: 20000 });
    await page.click('[role="dialog"] button:has-text("Stop")');
    await waitForStatus(db, campaignId, "cancelled");

    const afterStop = (
      await db.query(
        `select c.status,
                (select count(*)::int from campaign_recipients where campaign_id = c.id and status = 'pending') as pending,
                (select count(*)::int from messages m
                   join campaign_recipients r on r.message_id = m.id
                  where r.campaign_id = c.id and m.status = 'cancelled') as withdrawn
         from campaigns c where c.id = $1`,
        [campaignId]
      )
    ).rows[0];
    assert(afterStop.status === "cancelled", `campaign status is ${afterStop.status}`);
    assert(afterStop.pending === 0, `${afterStop.pending} recipients still pending after stop`);
    assert(afterStop.withdrawn === 1, `expected 1 withdrawn message, got ${afterStop.withdrawn}`);
    ok("stop cancels the campaign and withdraws messages not yet sent");

    // A stopped campaign must stay stopped even if the worker ticks again.
    await due();
    await pumpClinic(clinic.id);
    const finalQueued = await db.query(
      `select count(*)::int as n from messages
       where clinic_id = $1 and sender_kind = 'campaign' and status = 'queued'`,
      [clinic.id]
    );
    assert(finalQueued.rows[0].n === 0, "a stopped campaign resumed sending");
    ok("the pump will not restart a stopped campaign");

    assert(errors.length === 0, `client errors: ${errors.join(" | ")}`);
    ok("no client-side errors across the campaign screens");

    await browser.close();
    console.log(`\n  ${passed} checks passed\n`);
  } finally {
    await cleanup();
    await db.end();
  }
}

main().catch(async (e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
