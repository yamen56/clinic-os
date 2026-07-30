/** QA for Phase 9: PWA installability, service worker, push subscription, notification center, doctor reminders. */
import { chromium } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import https from "node:https";
import fs from "node:fs";
import { createECDH, randomBytes } from "node:crypto";

try {
  process.loadEnvFile?.();
} catch {}

const BASE = "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T | null>, ms = 25000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await wait(500);
  }
  throw new Error("timed out waiting for condition");
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  const slug = `qa9-test${Date.now().toString(36)}`;
  const clinic = (
    await db.query(`insert into clinics (name, slug) values ('QA9 Clinic', $1) returning id, timezone`, [slug])
  ).rows[0];
  await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  const owner = (
    await db.query(
      `insert into users (email, password_hash, full_name, locale, phone_e164) values ($1, $2, 'QA9 Owner', 'en', '+962790009999') returning id`,
      [`owner-qa9-${slug}@test.local`, bcrypt.hashSync("password123", 10)]
    )
  ).rows[0];
  await db.query(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'other', true, '{"level":"full"}')`, [clinic.id, owner.id]);
  const doc = (
    await db.query(
      `insert into users (email, password_hash, full_name, locale) values ($1, $2, 'د. رامي', 'en') returning id`,
      [`doc-qa9-${slug}@test.local`, bcrypt.hashSync("password123", 10)]
    )
  ).rows[0];
  const member = (
    await db.query(
      `insert into clinic_members (clinic_id, user_id, role, reminder_minutes) values ($1, $2, 'doctor', 30) returning id`,
      [clinic.id, doc.id]
    )
  ).rows[0];
  const patient = (
    await db.query(`insert into patients (clinic_id, full_name, phone_e164) values ($1, 'سلمى', '+962791230000') returning id`, [clinic.id])
  ).rows[0];
  console.log(`✓ fixture clinic ${slug}`);

  // 1. Manifest + service worker + icons are served
  const res = await fetch(`${BASE}/manifest.webmanifest`);
  const manifest = await res.json();
  if (!manifest.icons?.length || manifest.display !== "standalone")
    throw new Error("manifest not installable");
  const sw = await fetch(`${BASE}/sw.js`);
  const swBody = await sw.text();
  if (!swBody.includes("addEventListener(\"push\"")) throw new Error("service worker missing push handler");
  const icon = await fetch(`${BASE}/icons/icon-192.png`);
  if (icon.status !== 200) throw new Error("icon missing");
  console.log("✓ manifest, service worker, and icons served (installable PWA)");

  // 2. Offline page renders
  const offline = await fetch(`${BASE}/offline`);
  if (offline.status !== 200) throw new Error("offline page missing");
  console.log("✓ offline fallback page renders");

  // `channel: chromium` selects the new headless mode, which supports the
  // Notifications API (old headless always reports permission "denied").
  const browser = await chromium.launch({ channel: "chromium" });
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  await context.grantPermissions(["notifications"], { origin: BASE });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', `owner-qa9-${slug}@test.local`);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30000 });

  // 3. Service worker registers in the browser
  await page.goto(`${BASE}/c/${slug}/notifications`);
  await page.waitForSelector("text=Notifications", { timeout: 15000 });
  const swReady = await page
    .waitForFunction(
      async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        return !!reg?.active;
      },
      undefined,
      { timeout: 20000 }
    )
    .then(() => true)
    .catch(() => false);
  if (!swReady) throw new Error("service worker did not register");
  console.log("✓ service worker registered in browser");

  // 4. Browser push plumbing: permission prompt, SW ready, VAPID key present.
  // Headless Chromium has no push service, so pushManager.subscribe() itself
  // cannot complete here — the subscription API and delivery are tested below.
  const enableBtn = page.getByRole("button", { name: "Turn on notifications" }).last();
  await enableBtn.waitFor({ state: "visible", timeout: 20000 });
  const browserPush = await page.evaluate(async () => {
    const perm = await Notification.requestPermission();
    const reg = await navigator.serviceWorker.ready;
    return { perm, hasPushManager: !!reg.pushManager };
  });
  if (browserPush.perm !== "granted" || !browserPush.hasPushManager)
    throw new Error(`browser push unavailable: ${JSON.stringify(browserPush)}`);
  console.log("✓ browser grants permission and the service worker is ready for push");

  // 4b. Push subscription API round-trip. The VAPID public key reaches the
  // client through the NEXT_PUBLIC_ bundle; the subscribe() call itself needs a
  // real push service, so we register subscriptions through the API directly.
  const fakeEndpoint = `http://127.0.0.1:4198/push/ok-${Date.now()}`;
  const deadEndpoint = `http://127.0.0.1:4198/gone/${Date.now()}`;
  // A genuine P-256 point, so web-push's ECDH encryption actually succeeds.
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const P256DH = ecdh.getPublicKey().toString("base64url");
  const AUTH = randomBytes(16).toString("base64url");
  const regStatuses: number[] = [];
  for (const endpoint of [fakeEndpoint, deadEndpoint]) {
    const status = await page.evaluate(
      async (args) => {
        const r = await fetch("/api/me/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: args.endpoint,
            keys: { p256dh: args.p256dh, auth: args.auth },
          }),
        });
        return r.status;
      },
      { endpoint, p256dh: P256DH, auth: AUTH }
    );
    regStatuses.push(status);
  }
  if (regStatuses.some((s) => s !== 200)) throw new Error(`push register failed: ${regStatuses}`);
  const subs = await db.query(
    `select endpoint from push_subscriptions where user_id = $1 order by created_at`,
    [owner.id]
  );
  if (subs.rowCount !== 2) throw new Error(`expected 2 subscriptions, got ${subs.rowCount}`);
  console.log("✓ push subscriptions registered through the API");

  // 5. Notification center shows a new notification live (realtime)
  await db.query(
    `insert into notifications (clinic_id, user_id, kind, title, body, url)
     values ($1, $2, 'booking', 'حجز جديد: سلمى', 'كشفية · اليوم 3:00 م', $3)`,
    [clinic.id, owner.id, `/c/${slug}/calendar`]
  );
  await page.waitForSelector("text=حجز جديد: سلمى", { timeout: 20000 });
  console.log("✓ notification streamed into the center via realtime");

  // 6. Mark all read
  await page.click("text=Mark all read");
  await until(async () => {
    const r = await db.query(
      `select count(*)::int as n from notifications where user_id = $1 and read_at is null`,
      [owner.id]
    );
    return r.rows[0].n === 0 ? true : null;
  });
  console.log("✓ mark-all-read persists");

  // 7. Worker's delivery loop marks notifications as attempted
  await db.query(
    `insert into notifications (clinic_id, user_id, kind, title, body, url)
     values ($1, $2, 'booking', 'حجز ثانٍ', 'اختبار الدفع', $3)`,
    [clinic.id, owner.id, `/c/${slug}/calendar`]
  );
  await until(async () => {
    const r = await db.query(
      `select count(*)::int as n from notifications where user_id = $1 and push_sent`,
      [owner.id]
    );
    return r.rows[0].n >= 2 ? r.rows[0] : null;
  }, 40000);
  console.log("✓ worker delivery loop processed the notification queue");

  // 7b. Real encrypted push delivery + revoked-subscription pruning, against a
  // TLS endpoint (web-push refuses plain HTTP).
  const hits: string[] = [];
  const pushServer = https.createServer(
    {
      key: fs.readFileSync("scripts/qa-certs/key.pem"),
      cert: fs.readFileSync("scripts/qa-certs/cert.pem"),
    },
    (req, res) => {
      hits.push(req.url ?? "");
      if ((req.url ?? "").startsWith("/gone")) res.writeHead(410).end();
      else res.writeHead(201).end();
    }
  );
  await new Promise<void>((r) => pushServer.listen(4197, () => r()));
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  const runId = Date.now().toString(36);
  const tlsOk = `https://127.0.0.1:4197/push/ok-${runId}`;
  const tlsGone = `https://127.0.0.1:4197/gone/${runId}`;
  await db.query(`delete from push_subscriptions where user_id = $1`, [owner.id]);
  await db.query(`delete from push_subscriptions where endpoint like 'https://127.0.0.1:4197/%'`);
  for (const e of [tlsOk, tlsGone]) {
    await db.query(
      `insert into push_subscriptions (user_id, endpoint, keys) values ($1, $2, $3)`,
      [owner.id, e, JSON.stringify({ p256dh: P256DH, auth: AUTH })]
    );
  }

  const { pushToUser } = await import("../src/lib/push");
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: PG });
  const pc = await pool.connect();
  await pc.query("select set_config('app.is_admin', 'true', false)");
  const sent = await pushToUser(pc, owner.id, {
    title: "اختبار",
    body: "دفعة حقيقية",
    url: `/c/${slug}`,
  });
  if (sent !== 1) throw new Error(`expected 1 successful push, got ${sent}`);
  if (!hits.some((h) => h.startsWith("/push/"))) throw new Error("encrypted push never reached the endpoint");
  console.log(`✓ encrypted web push delivered (${hits.length} endpoint calls)`);

  const remaining = await pc.query(
    `select count(*)::int as n from push_subscriptions where endpoint = $1`,
    [tlsGone]
  );
  if (remaining.rows[0].n !== 0) throw new Error("revoked (410) subscription was not pruned");
  console.log("✓ revoked (410) subscription pruned automatically");
  pc.release();
  await pool.end();
  pushServer.close();

  // 8. Notification preferences persist
  await page.locator('button[role="switch"]').last().click();
  await until(async () => {
    const r = await db.query(`select notification_prefs from users where id = $1`, [owner.id]);
    const p = r.rows[0].notification_prefs ?? {};
    return Object.values(p).some((v) => v === false) ? p : null;
  });
  console.log("✓ notification preferences saved");

  // 9. Doctor reminder fires from the scheduler
  await db.query(
    `insert into appointments (clinic_id, patient_id, doctor_member_id, starts_at, ends_at, status)
     values ($1, $2, $3, now() + interval '30 minutes' + interval '20 seconds',
             now() + interval '60 minutes', 'confirmed')`,
    [clinic.id, patient.id, member.id]
  );
  const reminder = await until(async () => {
    const r = await db.query(
      `select title, body from notifications where user_id = $1 and kind = 'doctor_reminder'`,
      [doc.id]
    );
    return r.rows[0] ?? null;
  }, 100000);
  if (!reminder.body.includes("سلمى")) throw new Error(`bad reminder: ${JSON.stringify(reminder)}`);
  console.log(`✓ doctor reminder fired 30 min before: "${reminder.title}"`);

  // 10. Doctor sees it in their own notification center
  const dctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const dpage = await dctx.newPage();
  await dpage.goto(`${BASE}/login`);
  await dpage.waitForLoadState("networkidle");
  await dpage.fill('input[name="email"]', `doc-qa9-${slug}@test.local`);
  await dpage.fill('input[name="password"]', "password123");
  await dpage.click('button[type="submit"]');
  await dpage.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30000 });
  await dpage.goto(`${BASE}/c/${slug}/notifications`);
  await dpage.waitForSelector("text=موعدك القادم", { timeout: 15000 });
  await dpage.waitForSelector("text=Before my appointments", { timeout: 10000 });
  console.log("✓ doctor sees the reminder and doctor-only preferences");
  await dpage.screenshot({ path: "scripts/qa-shots/phase9-notifications.png" });
  await dctx.close();

  await page.screenshot({ path: "scripts/qa-shots/phase9-center.png" });
  await context.close();
  await browser.close();

  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  await db.query(`delete from users where id = any($1::uuid[])`, [[owner.id, doc.id]]);
  await db.end();

  if (errors.length) {
    console.error("page errors:", errors.slice(0, 5));
    process.exit(1);
  }
  console.log("PHASE 9 QA PASSED");
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
