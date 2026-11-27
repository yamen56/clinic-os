/**
 * The three plans (2026-11-27, lib/plans.ts, migration 0118).
 *
 * A Doctor-plan clinic beside a Clinic+ one, both built in the database, then
 * driven over HTTP and in a browser against the dev server:
 *
 * - the licence: a plan writes its preset and leaves the charts alone; the
 *   worker and the app agree on what is opt-in; a module switched off takes
 *   its dotted capabilities and insurance with it.
 * - booking: the Doctor plan's booking page is closed, its visit link says to
 *   call the clinic, the sitemap leaves it out — Clinic+ is untouched.
 * - signing: no signing link can be minted for a Doctor-plan clinic.
 * - devices: the machine API answers 402 not_licensed for the Doctor plan.
 * - seats: the trigger refuses a third member; the staff screen says the plan
 *   is full and the Add button is off.
 * - automations: "start from scratch" goes back to the list, the gallery says
 *   why, a template's copy saves a new wording and refuses a new step.
 * - a downgrade pauses the flows the clinic built itself and names them.
 * - Settings: no Devices or Booking links on the Doctor plan, and Your plan
 *   says what it is and "2 of 2".
 *
 * Run against a warm server:  npx tsx scripts/qa-plans.ts
 */
import "../worker/env";
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { randomBytes, randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { OPT_IN } from "../worker/features";
import { OPT_IN_FEATURES, maskByFeatures, resolveFeatures, toFeatureSetting } from "../src/lib/features";
import { allCapabilities } from "../src/lib/permissions";
import { PLAN_PROFILES, applyPlan, planFeatures } from "../src/lib/plans";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

let passed = 0;
let failed = 0;
const check = (cond: unknown, m: string, detail = "") => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${m}`);
  } else {
    failed++;
    console.log(`  ✗ ${m}${detail ? ` — ${detail}` : ""}`);
  }
};

async function signIn(browser: Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addCookies([{ name: "cos_locale", value: "en", url: BASE }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { timeout: 180000 });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 180000, waitUntil: "commit" });
  return page;
}

async function main() {
  console.log("The licence");
  check(
    [...OPT_IN].sort().join() === [...OPT_IN_FEATURES].sort().join(),
    "the worker and the app agree on which modules are opt-in",
    `${[...OPT_IN].sort().join()} vs ${[...OPT_IN_FEATURES].sort().join()}`
  );
  const dentalPlus = { ...planFeatures("clinic_plus"), dental: true };
  const asDoctor = applyPlan(dentalPlus, "doctor");
  check(!asDoctor.esign_remote && !asDoctor.booking && !asDoctor.campaigns && !asDoctor.devices, "the Doctor plan switches off links, booking, campaigns and devices");
  check(asDoctor.dental && asDoctor.patients && asDoctor.invoices && asDoctor.automations, "…and keeps the dental chart, patients, finance and automations");
  check(applyPlan(asDoctor, "clinic_pro").ai && applyPlan(asDoctor, "clinic_pro").branding, "Clinic Pro adds the AI receptionist and branding");
  const noInvoices = maskByFeatures(allCapabilities(), { ...resolveFeatures({}), invoices: false });
  check(!noInvoices["invoices.void"] && !noInvoices.insurance && !noInvoices["insurance.claims"], "invoicing off takes void, insurance and claims with it");
  check(resolveFeatures({}).booking && !resolveFeatures({}).branding, "silence keeps booking on and branding off");

  const db = new Client({ connectionString: PG });
  await db.connect();
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];
  const tag = Date.now().toString(36);
  const hash = bcrypt.hashSync("password123", 10);

  const makeClinic = async (kind: "doctor" | "clinic_plus") => {
    const slug = `qa-plan-${kind === "doctor" ? "doc" : "plus"}-${tag}`;
    const cl = await one(
      `insert into clinics (name, slug, plan, member_limit, features, timezone, default_locale, patient_changes)
       values ($1, $2, $3, $4, $5, 'Asia/Amman', 'en', 'cancel_move') returning id`,
      [`QA Plan ${kind}`, slug, kind, PLAN_PROFILES[kind].memberLimit, JSON.stringify(toFeatureSetting(planFeatures(kind)))]
    );
    await q(`insert into whatsapp_sessions (clinic_id, status, desired, phone_number) values ($1, 'connected', false, '962790000001')`, [cl.id]);
    const owner = await one(`insert into users (email, password_hash, full_name, locale) values ($1, $2, 'QA Owner', 'en') returning id`, [
      `${slug}@qa.local`,
      hash,
    ]);
    const member = await one(
      `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'doctor', true, '{"level":"full"}') returning id`,
      [cl.id, owner.id]
    );
    const svc = await one(`insert into services (clinic_id, name, duration_min, price, bookable_online) values ($1, 'Visit', 30, 10, true) returning id`, [cl.id]);
    await q(`insert into booking_links (clinic_id, slug, name, min_notice_min, require_otp) values ($1, $2, 'Main', 0, false)`, [cl.id, slug]);
    const patient = await one(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1, 'QA Patient', '+962790000099', 'staff') returning id`, [cl.id]);
    const start = DateTime.now().plus({ days: 5 }).set({ hour: 11, minute: 0, second: 0, millisecond: 0 });
    const appt = await one(
      `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status, source)
       values ($1, $2, $3, $4, $5, $6, 'confirmed', 'staff') returning id`,
      [cl.id, patient.id, member.id, svc.id, start.toUTC().toISO(), start.plus({ minutes: 30 }).toUTC().toISO()]
    );
    return { id: cl.id as string, slug, email: `${slug}@qa.local`, patientId: patient.id as string, apptId: appt.id as string };
  };

  const doc = await makeClinic("doctor");
  const plus = await makeClinic("clinic_plus");

  console.log("Booking");
  // innerText, not the HTML: every page carries the whole dictionary (memory: qa-must-assert-on-innertext).
  const pub = await chromium.launch();
  const anon = await (await pub.newContext({ locale: "en-GB" })).newPage();
  await anon.context().addCookies([{ name: "cos_locale", value: "en", url: BASE }]);
  const shown = async (url: string) => {
    await anon.goto(url, { timeout: 180000 });
    await anon.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    return anon.locator("body").innerText();
  };
  check((await shown(`${BASE}/book/${doc.slug}`)).includes("no longer active"), "the Doctor plan's booking page is closed");
  check(!(await shown(`${BASE}/book/${plus.slug}`)).includes("no longer active"), "the Clinic+ booking page opens");
  const sitemap = await (await fetch(`${BASE}/sitemap.xml`)).text();
  check(!sitemap.includes(`/book/${doc.slug}<`) && sitemap.includes(`/book/${plus.slug}<`), "the sitemap lists Clinic+ and leaves the Doctor plan out");
  const { visitToken } = await import("../src/lib/visit-link");
  const OFF = "To change or cancel this appointment, contact the clinic";
  check((await shown(`${BASE}/v/${visitToken(doc.apptId, doc.patientId)}`)).includes(OFF), "the Doctor plan's visit link says to contact the clinic");
  const vPlus = await shown(`${BASE}/v/${visitToken(plus.apptId, plus.patientId)}`);
  check(!vPlus.includes(OFF) && vPlus.includes("QA Plan clinic_plus"), "the Clinic+ visit link still changes the visit", vPlus.slice(0, 160));
  await pub.close();

  console.log("Signing links");
  const { issueSigningToken } = await import("../src/lib/esign/tokens");
  let refused = "";
  try {
    await issueSigningToken(db as never, { clinicId: doc.id, documentId: randomUUID(), signerId: randomUUID(), days: 7 });
  } catch (e) {
    refused = (e as Error).message;
  }
  check(refused === "esign_remote_off", "no signing link can be minted for a Doctor-plan clinic", refused);

  console.log("Devices");
  const { hashDeviceKey } = await import("../src/lib/imaging/devices");
  const device = async (clinicId: string) => {
    const key = `ctd_${randomBytes(24).toString("base64url")}`;
    await q(`insert into clinic_devices (clinic_id, name, kind, key_hash, key_hint) values ($1, 'QA X-ray', 'xray', $2, 'qa')`, [clinicId, hashDeviceKey(key)]);
    return key;
  };
  const meStatus = async (key: string) => {
    const r = await fetch(`${BASE}/api/devices/v1/me`, { headers: { authorization: `Bearer ${key}` } });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as { error?: string } };
  };
  const dDoc = await meStatus(await device(doc.id));
  const dPlus = await meStatus(await device(plus.id));
  check(dDoc.status === 402 && dDoc.body.error === "not_licensed", "a Doctor-plan machine is told its plan does not include devices", `${dDoc.status} ${dDoc.body.error}`);
  check(dPlus.status === 200, "a Clinic+ machine is let in", String(dPlus.status));

  console.log("Seats");
  const recep = await one(`insert into users (email, password_hash, full_name, locale) values ($1, $2, 'QA Desk', 'en') returning id`, [`desk-${doc.slug}@qa.local`, hash]);
  await q(`insert into clinic_members (clinic_id, user_id, role) values ($1, $2, 'receptionist')`, [doc.id, recep.id]);
  const third = await one(`insert into users (email, full_name) values ($1, 'QA Third') returning id`, [`third-${doc.slug}@qa.local`]);
  let seatErr = "";
  try {
    await q(`insert into clinic_members (clinic_id, user_id, role) values ($1, $2, 'other')`, [doc.id, third.id]);
  } catch (e) {
    seatErr = (e as Error).message;
  }
  check(seatErr === "member_limit", "the database refuses a third member on the Doctor plan", seatErr);

  console.log("Downgrade");
  const { setClinicPlan } = await import("../src/lib/plan-change");
  await q(
    `insert into automations (clinic_id, name, trigger_type, trigger_config, active, settings, canvas) values ($1, 'QA built by hand', 'patient_created', '{}', true, '{}', '{"trigger": null}')`,
    [plus.id]
  );
  await q("begin");
  const down = await setClinicPlan(db as never, plus.id, "doctor");
  await q("rollback");
  check(down?.paused.includes("QA built by hand"), "moving to the Doctor plan pauses the flow the clinic built and names it", JSON.stringify(down?.paused));
  check(down?.memberLimit === 2, "…and gives it the plan's two seats");

  const browser = await chromium.launch();
  try {
    const page = await signIn(browser, doc.email);
    console.log("Staff");
    await page.goto(`${BASE}/c/${doc.slug}/settings/staff`, { timeout: 180000 });
    await page.waitForSelector("[data-add-staff]", { timeout: 60000 });
    check(await page.locator("[data-seats-full]").isVisible(), "the staff screen says the plan's users are all in use");
    check(await page.locator("[data-add-staff]").isDisabled(), "…and Add is off");

    console.log("Settings");
    await page.goto(`${BASE}/c/${doc.slug}/settings`, { timeout: 180000 });
    await page.waitForSelector("[data-settings-menu]", { timeout: 60000 });
    const menu = await page.locator("[data-settings-menu]").innerText();
    check(!menu.includes("Booking links"), "no Booking links in a Doctor-plan clinic's settings", menu.slice(0, 200));
    check((await page.locator(`a[href="/c/${doc.slug}/settings/devices"]`).count()) === 0, "no Devices either");
    await page.goto(`${BASE}/c/${doc.slug}/settings/plan`, { timeout: 180000 });
    await page.waitForSelector("[data-your-plan]", { timeout: 60000 });
    check((await page.locator("[data-your-plan]").getAttribute("data-your-plan")) === "doctor", "Your plan names the Doctor plan");
    check((await page.locator("[data-plan-seats]").innerText()).includes("2 of 2"), "…and its 2 of 2 users");

    console.log("Automations");
    await page.goto(`${BASE}/c/${doc.slug}/automations/new`, { timeout: 180000 });
    await page.waitForURL((u) => u.pathname === `/c/${doc.slug}/automations`, { timeout: 60000 });
    check(true, "starting from scratch goes back to the list");

    // A template's copy, as the gallery would make it.
    const { installTemplates } = await import("../src/lib/clinic-provision");
    const tpl = await one(`select * from recipe_templates where key = 'reminder_24h' and active`);
    if (!tpl) {
      check(false, "the reminder template exists (npm run seed:recipes)");
    } else {
      await installTemplates(db as never, doc.id, [tpl]);
      const flowId = (await one(`select id from automations where clinic_id = $1 and recipe_key = 'reminder_24h'`, [doc.id])).id as string;
      const { loadFlow } = await import("../src/lib/automation/store");
      const flow = (await loadFlow(db as never, doc.id, flowId))!;
      const post = async (nodes: typeof flow.nodes, edges: typeof flow.edges) => {
        const r = await page.request.post(`${BASE}/api/c/${doc.slug}/automations/${flowId}`, {
          data: {
            patch: {
              flow: {
                baseUpdatedAt: flow.updatedAt,
                name: flow.name,
                description: flow.description,
                trigger: flow.trigger,
                triggerConfig: flow.triggerConfig,
                settings: flow.settings,
                canvas: {},
                nodes,
                edges,
                active: flow.active,
              },
            },
          },
        });
        return (await r.json()) as { ok?: boolean; updatedAt?: string; rejected?: { flow: { error: string } } };
      };
      const reworded = flow.nodes.map((n) =>
        n.type === "send_whatsapp" ? { ...n, config: { ...n.config, message: `${String(n.config.message ?? "")} (QA)` } } : n
      );
      const ok = await post(reworded, flow.edges);
      check(ok.ok === true, "a template's copy takes a new wording", JSON.stringify(ok));
      if (ok.updatedAt) flow.updatedAt = ok.updatedAt;
      const extra = { id: randomUUID(), type: "add_tag", config: { tag: "qa" }, position: null, label: "" };
      const last = flow.nodes[flow.nodes.length - 1];
      const grown = await post([...reworded, extra], [...flow.edges, { from: last.id, handle: "next", to: extra.id }]);
      check(grown.rejected?.flow.error === "not_licensed", "…and refuses a new step", JSON.stringify(grown));
    }

    await page.goto(`${BASE}/c/${doc.slug}/automations?new=1`, { timeout: 180000 });
    const said = await page.waitForSelector("[data-basic-automations]", { timeout: 60000 }).then(() => true).catch(() => false);
    check(said, "the gallery says the plan runs ready-made flows");
    check((await page.locator('[data-template="scratch"]').count()) === 0, "…and offers no Start from scratch");
  } finally {
    await browser.close();
    await q(`delete from clinics where id = any($1::uuid[])`, [[doc.id, plus.id]]).catch(() => {});
    await q(`delete from users where email like $1`, [`%qa-plan-%-${tag}%`]).catch(() => {});
    await db.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
