/**
 * Dental treatments that take care of themselves (2026-11-03).
 *
 * Yamen: "make sure that the treatment that may need multiple sessions like
 * the root canal treatment have their steps recorded, and if you saw that we
 * have to use some automation that is needed for certain treatment lets work
 * on it".
 *
 * - Steps: a surgical extraction is finished by its surgery and still takes a
 *   suture removal afterwards; a biopsy stays open until its result is read.
 * - Treatment finished (migration 0090): an extraction marked done starts the
 *   extraction aftercare — once for the day, whatever the number of teeth —
 *   and names the teeth; a filling does not; an extraction taken back with
 *   the chart's undo starts nothing; a finished root canal starts the crown
 *   reminder, which waits its two weeks.
 * - Next visit not booked: a root canal whose last step was a week ago, for a
 *   patient with nothing booked, starts the reminder; a patient with a visit
 *   booked does not.
 * - The messages name the treatment and its tooth.
 *
 * Needs the local worker running this commit's code (it acts on the events).
 */
import "../worker/env";
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import type { PoolClient } from "pg";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { ALL_RECIPES } from "./seed-recipes";
import { treeToGraph, type RecipeStep } from "../src/lib/automation/graph";
import { writeFlowGraph } from "../src/lib/automation/store";
import { defaultSettingsFor, normalizeTriggerConfig } from "../src/lib/automation/catalog";
import { loadRunContext } from "../src/lib/automation/context";
import { renderMessage } from "../src/lib/automation/variables";
import { unbookedTreatments } from "../worker/treatments";

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
async function until(fn: () => Promise<boolean>, ms = 30000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
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
  const db = new Client({ connectionString: PG });
  await db.connect();
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const tag = Date.now().toString(36);
  const hash = bcrypt.hashSync("password123", 10);
  const slug = `qadentauto${tag}`;
  const [clinic] = await q(
    `insert into clinics (name, name_ar, slug, specialty, specialties, features, default_locale)
     values ('QA Dental Auto', 'أتمتة الأسنان', $1, 'dental', '{dental}', '{"dental": true}', 'ar') returning id`,
    [slug]
  );
  await q(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  const email = `dentauto-${tag}@test.local`;
  const [user] = await q(`insert into users (email, password_hash, full_name, locale) values ($1, $2, 'Dr. Auto', 'en') returning id`, [email, hash]);
  await q(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'doctor', true, '{"level":"full"}')`, [clinic.id, user.id]);
  const patient = async (name: string, phone: string) =>
    (await q(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1, $2, $3, 'staff') returning id`, [clinic.id, name, phone]))[0].id as string;
  const pA = await patient("Ali Extraction", "+962790101001");
  const pB = await patient("Badr Undo", "+962790101002");
  const pC = await patient("Cyrine RootCanal", "+962790101003");
  const pD = await patient("Dana Stalled", "+962790101004");
  const pE = await patient("Ehab Booked", "+962790101005");

  // The dental recipes, installed as a clinic would switch them on.
  const autoOf: Record<string, string> = {};
  for (const key of ["dental_post_extraction", "dental_crown_after_root_canal", "dental_next_visit_unbooked"]) {
    const r = ALL_RECIPES.find((x) => x.key === key)!;
    const graph = treeToGraph(r.steps as RecipeStep[], () => randomUUID());
    const [a] = await q(
      `insert into automations (clinic_id, name, description, trigger_type, trigger_config, active, recipe_key, recipe_specialty, settings, canvas)
       values ($1, $2, $3, $4, $5, true, $6, 'dental', $7, '{"trigger": null}') returning id`,
      [clinic.id, r.name_ar, r.description, r.trigger_type, JSON.stringify(normalizeTriggerConfig(r.trigger_type, r.trigger_config)), r.key, JSON.stringify(defaultSettingsFor(r.trigger_type))]
    );
    await writeFlowGraph(db as unknown as PoolClient, clinic.id, a.id, graph.nodes, graph.edges);
    autoOf[key] = a.id;
  }
  const runsOf = (auto: string, p: string) => q(`select id, status, context from automation_runs where automation_id = $1 and patient_id = $2`, [autoOf[auto], p]);
  const eventOf = (p: string, key: string) =>
    q(`select id, run_at, payload, status from jobs where kind = 'trigger:treatment_done' and clinic_id = $1 and payload->>'patientId' = $2 and payload->>'treatmentKey' = $3`, [clinic.id, p, key]);
  // The event waits out the chart's undo; the test does not.
  const release = (p: string, key: string) =>
    q(`update jobs set run_at = now() where kind = 'trigger:treatment_done' and clinic_id = $1 and payload->>'patientId' = $2 and payload->>'treatmentKey' = $3 and status = 'pending'`, [clinic.id, p, key]);

  const browser = await chromium.launch();
  try {
    const page = await signIn(browser, email);
    const api = (p: string) => `${BASE}/api/c/${slug}/patients/${p}/dental`;
    const record = async (p: string, marks: { site: string; treatmentKey: string; status: "planned" | "done" | "existing"; surfaces?: string[]; detail?: Record<string, string> }[]) => {
      const body = { marks: marks.map((m) => ({ id: randomUUID(), eventId: randomUUID(), surfaces: [], detail: {}, ...m })) };
      const res = await page.request.post(`${api(p)}/marks`, { data: body });
      if (!res.ok()) throw new Error(`record ${res.status()} ${await res.text()}`);
      return body.marks.map((m) => m.id);
    };
    const step = async (p: string, markId: string, stepKey: string, data: Record<string, unknown> = {}) => {
      const res = await page.request.post(`${api(p)}/marks/${markId}/steps`, { data: { id: randomUUID(), eventId: randomUUID(), step: stepKey, data, note: "" } });
      return { status: res.status(), body: (await res.json().catch(() => ({}))) as { completed?: boolean; error?: string } };
    };
    const markStatus = async (id: string) => (await q(`select status from chart_marks where id = $1`, [id]))[0]?.status;

    /* ── Steps for treatments of more than one visit ────────────────── */
    console.log("Steps");
    const [surg] = await record(pA, [{ site: "38", treatmentKey: "extraction_surgical", status: "planned" }]);
    const s1 = await step(pA, surg, "surgery", { approach: ["flap", "bone"], sutures: "nonresorbable" });
    check(s1.status === 200 && (await markStatus(surg)) === "done", "a surgical extraction is finished by its surgery", JSON.stringify(s1));
    const s2 = await step(pA, surg, "sutures");
    check(s2.status === 200, "and the suture removal is recorded after it, as it happens", JSON.stringify(s2));
    const [bx] = await record(pA, [{ site: "mouth", treatmentKey: "biopsy", status: "planned" }]);
    await step(pA, bx, "biopsy", { type: "excisional" });
    check((await markStatus(bx)) === "planned", "a biopsy taken is not finished: its result is still to be read");
    await step(pA, bx, "result", { result: "Benign" });
    check((await markStatus(bx)) === "done", "with the result reviewed, it is");
    // These made events of their own; the cases below are about extractions and root canals.
    await q(`delete from jobs where kind = 'trigger:treatment_done' and clinic_id = $1`, [clinic.id]);

    /* ── Treatment finished ─────────────────────────────────────────── */
    console.log("Treatment finished");
    await record(pA, [
      { site: "48", treatmentKey: "extraction", status: "done" },
      { site: "18", treatmentKey: "extraction", status: "done" },
    ]);
    const ev = await eventOf(pA, "extraction");
    check(ev.length === 1, "two teeth out at one visit are one event", String(ev.length));
    check(ev[0] && Date.parse(ev[0].run_at) - Date.now() > 100_000, "and it waits out the chart's two-minute undo before acting");
    await release(pA, "extraction");
    check(await until(async () => (await runsOf("dental_post_extraction", pA)).length === 1), "the extraction aftercare starts for the patient");
    const runA = (await runsOf("dental_post_extraction", pA))[0];
    const tA = runA?.context?.trigger?.treatment ?? {};
    check(tA.name === "خلع بسيط" && tA.tooth === "18, 48", "naming the treatment in the clinic's language, and both teeth", JSON.stringify(tA));

    await record(pA, [{ site: "36", treatmentKey: "filling_composite", status: "done", surfaces: ["O"] }]);
    await release(pA, "filling_composite");
    await until(async () => (await eventOf(pA, "filling_composite"))[0]?.status === "done", 30000);
    check((await runsOf("dental_post_extraction", pA)).length === 1, "a filling does not start the extraction aftercare");

    const [oops] = await record(pB, [{ site: "28", treatmentKey: "extraction", status: "done" }]);
    const undo = await page.request.delete(`${api(pB)}/marks/${oops}`);
    check(undo.ok(), "an extraction tapped by mistake is taken back", String(undo.status()));
    await release(pB, "extraction");
    await until(async () => (await eventOf(pB, "extraction"))[0]?.status === "done", 30000);
    check((await runsOf("dental_post_extraction", pB)).length === 0, "and its event, looked at again, starts nothing");

    await record(pC, [{ site: "36", treatmentKey: "rct", status: "done", detail: { canals: "3" } }]);
    await release(pC, "rct");
    check(await until(async () => (await runsOf("dental_crown_after_root_canal", pC)).length === 1), "a finished root canal starts the crown reminder");
    const runC = (await runsOf("dental_crown_after_root_canal", pC))[0];
    check(await until(async () => (await q(`select status from automation_runs where id = $1`, [runC.id]))[0].status === "waiting"), "which waits its two weeks before asking");

    // What the patient will read, with the run's own treatment.
    const ctx = await loadRunContext(db as unknown as PoolClient, { clinicId: clinic.id, patientId: pC, treatment: runC.context?.trigger?.treatment });
    // Found by what it is, not where it sits: the recipe's shape changes as it is improved.
    const crownMsg = ALL_RECIPES.find((r) => r.key === "dental_crown_after_root_canal")!.steps.find((s) => s.step_type === "send_whatsapp")!.config!.message as string;
    const rendered = renderMessage(crownMsg, ctx);
    check(rendered.includes("(36)") && rendered.includes("Cyrine"), "the message names the patient and the tooth", rendered.slice(0, 120));

    /* ── Next visit not booked ──────────────────────────────────────── */
    console.log("Next visit not booked");
    const [rctD] = await record(pD, [{ site: "46", treatmentKey: "rct", status: "planned" }]);
    await step(pD, rctD, "access");
    const [rctE] = await record(pE, [{ site: "26", treatmentKey: "rct", status: "planned" }]);
    await step(pE, rctE, "access");
    // A week ago, in the clinic's own days.
    await q(`update chart_mark_steps set done_at = now() - interval '7 days' where mark_id = any($1::uuid[])`, [[rctD, rctE]]);
    await q(
      `insert into appointments (clinic_id, patient_id, starts_at, ends_at, status) values ($1, $2, now() + interval '3 days', now() + interval '3 days 30 minutes', 'scheduled')`,
      [clinic.id, pE]
    );
    await unbookedTreatments({ force: true });
    const runD = await runsOf("dental_next_visit_unbooked", pD);
    check(runD.length === 1, "a root canal stalled a week, nothing booked: the reminder starts", String(runD.length));
    check(runD[0]?.context?.trigger?.treatment?.name === "علاج عصب" && runD[0]?.context?.trigger?.treatment?.tooth === "46", "naming the treatment and its tooth", JSON.stringify(runD[0]?.context));
    check((await runsOf("dental_next_visit_unbooked", pE)).length === 0, "a patient with the next visit booked hears nothing");
    await unbookedTreatments({ force: true });
    check((await runsOf("dental_next_visit_unbooked", pD)).length === 1, "and the same stall is never sent twice");

    /* ── In the builder ─────────────────────────────────────────────── */
    console.log("In the builder");
    await page.goto(`${BASE}/c/${slug}/automations/${autoOf.dental_next_visit_unbooked}`, { timeout: 180000 });
    await page.waitForLoadState("networkidle");
    const triggerNode = page.getByText("Next visit of a treatment isn't booked").first();
    check(await until(async () => (await triggerNode.count()) > 0, 60000), "the flow's trigger reads: Next visit of a treatment isn't booked");
    await triggerNode.click();
    check(await until(async () => (await page.locator("main").innerText()).includes("Which treatments"), 20000), "its settings offer which treatments, by kind");
    check((await page.locator("main").innerText()).includes("Root canals"), "with the kinds a dentist would name");
    await page.screenshot({ path: "scripts/qa-shots/dental-result/automation-builder.png" });
    await page.goto(`${BASE}/c/${slug}/automations`, { timeout: 180000 });
    // The names the templates carry now, not copies of them that go stale when a template is renamed.
    const names = ["dental_next_visit_unbooked", "dental_crown_after_root_canal", "dental_post_extraction"].map((k) => ALL_RECIPES.find((r) => r.key === k)!.name_ar);
    const listed = await until(async () => {
      const list = await page.locator("main").innerText();
      return names.every((n) => list.includes(n));
    }, 60000);
    check(listed, "the automations list shows the three dental flows", names.join(" · "));
  } finally {
    await browser.close();
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
