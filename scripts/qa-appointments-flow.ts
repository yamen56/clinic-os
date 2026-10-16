/**
 * Appointments since 0078: rooms, the patients-today board, the doctor's
 * arrival chime, walk-ins, and the waitlist as a tab.
 *
 * Rooms are checked where they bite — the public booking endpoint and the
 * availability engine — because a room that only the staff panel respects is
 * a room the booking page double-books. The board is driven in a browser,
 * because "the doctor knows the moment reception presses Arrived" is only true
 * if it is true on the doctor's screen.
 */
import { Client } from "pg";
import { chromium, devices, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { DateTime } from "luxon";
import { computeSlots } from "../src/lib/slots";

try {
  process.loadEnvFile?.();
} catch {}

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const TZ = "Asia/Amman";
const ALL_DAY = JSON.stringify(
  Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [["00:00", "23:59"]]]))
);

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
  const slug = `qaflow${tag}`;
  const clinicIds: string[] = [];
  const userIds: string[] = [];

  const mkClinic = async (s: string, name: string) => {
    const c = (
      await db.query(`insert into clinics (name, slug, timezone, working_hours) values ($1, $2, $3, $4) returning id`, [
        name,
        s,
        TZ,
        ALL_DAY,
      ])
    ).rows[0].id as string;
    clinicIds.push(c);
    return c;
  };
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
  const mkLink = async (clinicId: string, s: string) =>
    db.query(`insert into booking_links (clinic_id, slug, min_notice_min) values ($1, $2, 0)`, [clinicId, s]);
  const book = (link: string, body: Record<string, unknown>) =>
    fetch(`${BASE}/api/public/book/${link}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: "en", ...body }),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  let phoneN = 0;
  const phone = () => `+9627${String(81000000 + Math.floor(Math.random() * 900000) + phoneN++)}`;

  const clinic = await mkClinic(slug, "QA Flow");
  // No WhatsApp session: public bookings finalise inline (the offline path).
  const ownerId = await mkUser(`owner-${slug}@test.local`, "QA Owner");
  const docAUser = await mkUser(`doca-${slug}@test.local`, "Dr Alpha");
  const docBUser = await mkUser(`docb-${slug}@test.local`, "Dr Beta");
  const clerkUser = await mkUser(`clerk-${slug}@test.local`, "QA Clerk");
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'receptionist', true, '{"level":"full"}')`,
    [clinic, ownerId]
  );
  const docA = (await db.query(`insert into clinic_members (clinic_id, user_id, role, color) values ($1, $2, 'doctor', '#2b7fb8') returning id`, [clinic, docAUser])).rows[0].id as string;
  const docB = (await db.query(`insert into clinic_members (clinic_id, user_id, role, color) values ($1, $2, 'doctor', '#c2593a') returning id`, [clinic, docBUser])).rows[0].id as string;
  // Somebody who may see patients but not the calendar.
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, permissions) values ($1, $2, 'other', '{"level":"custom","caps":{"patients":true}}')`,
    [clinic, clerkUser]
  );
  const svc = async (name: string, dur: number, kind = "in_person") =>
    (
      await db.query(`insert into services (clinic_id, name, duration_min, price, location_kind) values ($1, $2, $3, 10, $4) returning id`, [
        clinic,
        name,
        dur,
        kind,
      ])
    ).rows[0].id as string;
  const S1 = await svc("Checkup", 30);
  const S2 = await svc("X-ray", 20);
  const S3 = await svc("Video consult", 20, "online");

  const tomorrow = DateTime.now().setZone(TZ).plus({ days: 1 }).startOf("day");
  const at = (h: number, m = 0) => tomorrow.set({ hour: h, minute: m }).toUTC().toISO()!;
  const opts = (serviceId: string, doctorMemberId: string | null, clinicId = clinic) => ({
    clinicId,
    tz: TZ,
    clinicHours: JSON.parse(ALL_DAY),
    blockedDates: [] as string[],
    serviceId,
    doctorMemberId,
    dateISO: tomorrow.toISODate()!,
    minNoticeMin: 0,
    granularityMin: 30,
    linkDoctorIds: [] as string[],
  });
  const offered = async (serviceId: string, doctor: string | null, iso: string, clinicId = clinic) =>
    (await computeSlots(db as never, opts(serviceId, doctor, clinicId))).find((s) => s.startISO === iso) ?? null;

  try {
    /* ------------------------------------------------ 1. no rooms: as before */
    console.log("\nno rooms");
    await mkLink(clinic, `${slug}-a`);
    const a1 = await book(`${slug}-a`, { serviceId: S1, doctorId: docA, startISO: at(10), fullName: "Base One", phone: phone() });
    const a2 = await book(`${slug}-a`, { serviceId: S1, doctorId: docB, startISO: at(10), fullName: "Base Two", phone: phone() });
    check("two doctors can see patients at the same time", a1.status === 200 && a2.status === 200, `${a1.status} ${a2.status}`);
    const baseRooms = await db.query(`select count(*)::int n from appointments where clinic_id = $1 and room_id is not null`, [clinic]);
    check("and nothing takes a room", baseRooms.rows[0].n === 0);
    const s0 = await offered(S1, docA, at(11));
    check("slots say roomId null when the clinic has no rooms", !!s0 && s0.roomId === null, JSON.stringify(s0));
    await db.query(`update appointments set status = 'cancelled' where clinic_id = $1`, [clinic]);

    /* ---------------------------------------------- 2. rooms block, auto-pick */
    console.log("\nrooms");
    const R1 = (await db.query(`insert into clinic_rooms (clinic_id, name, sort) values ($1, 'Room 1', 0) returning id`, [clinic])).rows[0].id as string;
    const R2 = (await db.query(`insert into clinic_rooms (clinic_id, name, sort) values ($1, 'X-ray room', 1) returning id`, [clinic])).rows[0].id as string;
    // The X-ray room only takes X-rays; Room 1 takes anything.
    await db.query(`insert into clinic_room_services (room_id, service_id, clinic_id) values ($1, $2, $3)`, [R2, S2, clinic]);
    await db.query(`update clinic_members set default_room_id = $2 where id = $1`, [docB, R1]);

    await mkLink(clinic, `${slug}-b`);
    const b1 = await book(`${slug}-b`, { serviceId: S1, doctorId: docA, startISO: at(11), fullName: "Room One", phone: phone() });
    const b1row = (await db.query(`select room_id from appointments where clinic_id = $1 and starts_at = $2 and status <> 'cancelled' and doctor_member_id = $3`, [clinic, at(11), docA])).rows[0];
    check("an online booking is given a room that hosts its service", b1.status === 200 && b1row?.room_id === R1, `${b1.status} ${b1row?.room_id}`);
    const sB = await offered(S1, docB, at(11));
    check("a free doctor is not offered the time when no suitable room is free", sB === null, JSON.stringify(sB));
    const b2 = await book(`${slug}-b`, { serviceId: S1, doctorId: docB, startISO: at(11), fullName: "No Room", phone: phone() });
    check("and booking it anyway is refused as taken", b2.status === 409, `${b2.status}`);
    const b3 = await book(`${slug}-b`, { serviceId: S2, doctorId: docB, startISO: at(11), fullName: "Xray Patient", phone: phone() });
    const b3row = (await db.query(`select room_id from appointments where clinic_id = $1 and starts_at = $2 and doctor_member_id = $3 and status <> 'cancelled'`, [clinic, at(11), docB])).rows[0];
    check("a service limited to one room goes into that room", b3.status === 200 && b3row?.room_id === R2, `${b3.status} ${b3row?.room_id}`);
    const b4 = await book(`${slug}-b`, { serviceId: S3, doctorId: docB, startISO: at(13), fullName: "Online Patient", phone: phone() });
    const b4row = (await db.query(`select room_id from appointments where clinic_id = $1 and starts_at = $2 and doctor_member_id = $3`, [clinic, at(13), docB])).rows[0];
    check("an online service takes no room", b4.status === 200 && b4row && b4row.room_id === null, `${b4.status}`);
    const sPref = await offered(S1, docB, at(15));
    check("the doctor's usual room is the one a slot offers", sPref?.roomId === R1, JSON.stringify(sPref));
    await db.query(`update appointments set status = 'cancelled' where clinic_id = $1 and starts_at = $2 and doctor_member_id = $3`, [clinic, at(11), docA]);
    // Dr Alpha again: Dr Beta is busy at 11 with the X-ray.
    const sAgain = await offered(S1, docA, at(11));
    check("cancelling frees the room and the time is offered again", !!sAgain && sAgain.roomId === R1, JSON.stringify(sAgain));

    /* ------------------------------------------------------------ 3. the race */
    console.log("\nrace for the last room");
    await mkLink(clinic, `${slug}-c`);
    const racers = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        book(`${slug}-c`, { serviceId: S1, doctorId: i % 2 ? docA : docB, startISO: at(16), fullName: `Racer ${i}`, phone: phone() })
      )
    );
    const okRace = racers.filter((r) => r.status === 200).length;
    const inRoom = (await db.query(`select count(*)::int n from appointments where clinic_id = $1 and starts_at = $2 and status in ('pending_approval','scheduled','confirmed')`, [clinic, at(16)])).rows[0].n;
    check("six people racing two doctors for one room: exactly one booking", okRace === 1 && inRoom === 1, `${okRace} ok, ${inRoom} rows, ${racers.map((r) => r.status).join(",")}`);

    /* ---------------------------------------------- 4. no doctors, two rooms */
    console.log("\nno doctors: rooms are the capacity");
    const solo = await mkClinic(`${slug}x`, "QA Flow Solo");
    const soloSvc = (await db.query(`insert into services (clinic_id, name, duration_min, price) values ($1, 'Massage', 30, 10) returning id`, [solo])).rows[0].id as string;
    await db.query(`insert into clinic_rooms (clinic_id, name, sort) values ($1, 'Bed 1', 0), ($1, 'Bed 2', 1)`, [solo]);
    await mkLink(solo, `${slug}-x`);
    const x = [];
    for (let i = 0; i < 3; i++) x.push(await book(`${slug}-x`, { serviceId: soloSvc, startISO: at(10), fullName: `Solo ${i}`, phone: phone() }));
    check("two rooms take two patients at once, the third is refused", x[0].status === 200 && x[1].status === 200 && x[2].status === 409, x.map((r) => r.status).join(","));
    const soloRooms = (await db.query(`select count(distinct room_id)::int n from appointments where clinic_id = $1 and status <> 'cancelled'`, [solo])).rows[0].n;
    check("in two different rooms", soloRooms === 2, `${soloRooms}`);

    /* -------------------------------------------- 5. the panel, in a browser */
    console.log("\nbooking panel");
    const browser = await chromium.launch();
    const desk = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    desk.on("pageerror", (e) => errors.push(e.message));
    await signIn(desk, `owner-${slug}@test.local`);
    await desk.goto(`${BASE}/c/${slug}/calendar?tab=schedule`);
    await desk.waitForLoadState("networkidle");
    await desk.addStyleTag({ content: "nextjs-portal{display:none!important}" });
    const panelBook = async (name: string, doctor: string, service: string, time: string, room?: string) => {
      await desk.getByRole("button", { name: "New appointment" }).first().click();
      const aside = desk.locator("aside").last();
      await aside.locator("text=Create new patient").click();
      await aside.locator('input[placeholder="Full name"]').fill(name);
      await aside.locator('input[placeholder="xxxxxxxxxx"]').fill(phone().slice(4));
      await aside.locator("select").nth(0).selectOption(service);
      await aside.locator("select").nth(1).selectOption(doctor);
      if (room) await aside.locator("select[data-room-select]").selectOption(room);
      await aside.locator('input[type="date"]').fill(tomorrow.toISODate()!);
      await aside.locator('input[type="time"]').fill(time);
      await aside.locator("button:has-text('Save')").click();
    };
    await panelBook("Panel One", docA, S1, "17:00");
    const t1 = await desk.waitForSelector("text=Booked in Room 1", { timeout: 15000 }).then(() => true).catch(() => false);
    check("the panel books into a free room and says which", t1);
    await desk.keyboard.press("Escape").catch(() => {});
    await panelBook("Panel Two", docB, S1, "17:00");
    const t2 = await desk.waitForSelector("text=No room is free at this time", { timeout: 15000 }).then(() => true).catch(() => false);
    check("with every suitable room taken it says no room is free", t2);
    await desk.locator("aside").last().locator("select[data-room-select]").selectOption(R1);
    await desk.locator("aside").last().locator("button:has-text('Save')").click();
    const t3 = await desk.waitForSelector("text=That room is taken at this time (Panel One)", { timeout: 15000 }).then(() => true).catch(() => false);
    check("choosing the taken room names who has it", t3);
    await desk.locator("aside").last().locator("footer").getByRole("button", { name: "Cancel", exact: true }).click();

    // Day view, by room: a column per room.
    await desk.getByRole("button", { name: "Day", exact: true }).click();
    await desk.getByRole("button", { name: "By room", exact: true }).click();
    const roomCols = await desk.locator('[data-col="Room 1"], [data-col="X-ray room"]').count();
    check("the day view can show a column per room", roomCols === 2, `${roomCols}`);

    /* --------------------------------------------------- 6. patients today */
    console.log("\npatients today");
    const now = DateTime.now().setZone(TZ);
    const mkPatient = async (name: string) =>
      (await db.query(`insert into patients (clinic_id, full_name, phone_e164) values ($1, $2, $3) returning id`, [clinic, name, phone()])).rows[0].id as string;
    const lateP = await mkPatient("Late Lina");
    const nextP = await mkPatient("Next Nour");
    const busyP = await mkPatient("Busy Basel");
    const mkToday = async (patient: string, startMin: number, extra: Record<string, unknown> = {}) =>
      (
        await db.query(
          `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status, room_id, arrived_at, seated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
          [
            clinic,
            patient,
            extra.doctor ?? docA,
            S1,
            now.plus({ minutes: startMin }).toUTC().toISO(),
            now.plus({ minutes: startMin + 30 }).toUTC().toISO(),
            extra.status ?? "scheduled",
            extra.room ?? R1,
            extra.arrived ?? null,
            extra.seated ?? null,
          ]
        )
      ).rows[0].id as string;
    const lateId = await mkToday(lateP, -20);
    const nextId = await mkToday(nextP, 40);
    // Somebody already in the X-ray room, so the seat menu has an occupied room.
    await mkToday(busyP, -10, { doctor: docB, room: R2, arrived: now.minus({ minutes: 12 }).toUTC().toISO(), seated: now.minus({ minutes: 9 }).toUTC().toISO(), status: "confirmed" });

    // The doctor is on another page entirely when the patient arrives.
    const docCtx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const doctor = await docCtx.newPage();
    await signIn(doctor, `doca-${slug}@test.local`);
    await doctor.goto(`${BASE}/c/${slug}/patients`);
    await doctor.waitForLoadState("networkidle");
    const otherCtx = await browser.newContext();
    const other = await otherCtx.newPage();
    await signIn(other, `docb-${slug}@test.local`);
    await other.goto(`${BASE}/c/${slug}/patients`);
    await other.waitForLoadState("networkidle");

    await desk.goto(`${BASE}/c/${slug}/calendar`);
    await desk.waitForSelector("[data-flow-board]", { timeout: 60000 });
    await desk.addStyleTag({ content: "nextjs-portal{display:none!important}" });
    const card = (id: string) => desk.locator(`[data-flow-card="${id}"]`);
    check("Appointments opens on the board of today's patients", (await desk.locator("[data-flow-board]").count()) === 1);
    check("a patient past their time shows as late", (await card(lateId).getAttribute("data-stage")) === "late");
    check("…and says by how much", /min late/.test(await card(lateId).innerText()));

    const jobsFor = async (id: string, kind: string) =>
      (await db.query(`select count(*)::int n from jobs where clinic_id = $1 and kind = $2 and payload->>'appointmentId' = $3`, [clinic, kind, id])).rows[0].n as number;

    await card(lateId).locator('[data-flow-action="arrived"]').click();
    await desk.waitForSelector(`[data-flow-card="${lateId}"][data-stage="waiting"]`, { timeout: 10000 }).catch(() => {});
    check("Arrived moves the card to the waiting room at once", (await card(lateId).getAttribute("data-stage")) === "waiting");
    await desk.waitForTimeout(800);
    const lateRow = (await db.query(`select status, arrived_at from appointments where id = $1`, [lateId])).rows[0];
    check("…records the arrival", !!lateRow.arrived_at);
    check("…and does not touch the status (no confirmation message fires)", lateRow.status === "scheduled" && (await jobsFor(lateId, "trigger:appointment_status_changed")) === 0);

    const popup = await doctor
      .waitForSelector('[data-notification-popup="patient_arrived"]', { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    check("the doctor, on another page, is told the patient arrived", popup);
    if (popup) check("…by name", (await doctor.locator('[data-notification-popup="patient_arrived"]').innerText()).includes("Late Lina"));
    await other.waitForTimeout(1500);
    check("another doctor is not told about somebody else's patient", (await other.locator('[data-notification-popup="patient_arrived"]').count()) === 0);
    await doctor.reload();
    await doctor.waitForLoadState("networkidle");
    await doctor.waitForTimeout(2500);
    check("a reload does not chime for the same arrival again", (await doctor.locator('[data-notification-popup="patient_arrived"]').count()) === 0);

    const arrA = await doctor.request.get(`${BASE}/api/c/${slug}/appointments/arrivals`);
    const arrAJ = await arrA.json();
    check("the arrivals feed lists the doctor's own waiting patient", arrA.status() === 200 && arrAJ.arrivals.some((a: { id: string }) => a.id === lateId));
    const arrB = await (await other.request.get(`${BASE}/api/c/${slug}/appointments/arrivals`)).json();
    check("…and not another doctor's", !arrB.arrivals.some((a: { id: string }) => a.id === lateId));
    const clerkCtx = await browser.newContext();
    const clerk = await clerkCtx.newPage();
    await signIn(clerk, `clerk-${slug}@test.local`);
    check("…and refuses somebody without the calendar", (await clerk.request.get(`${BASE}/api/c/${slug}/appointments/arrivals`)).status() === 403);
    await clerkCtx.close();

    // Call in: the occupied room is named and closed.
    await card(lateId).getByRole("button", { name: "Call in" }).click();
    const menu = desk.locator('[role="menu"]');
    const xray = menu.locator('button:has-text("X-ray room")');
    check("the room menu shows who is in an occupied room", (await xray.isDisabled()) && (await xray.innerText()).includes("Busy Basel"));
    await menu.locator('button:has-text("Room 1")').click();
    await desk.waitForSelector(`[data-flow-card="${lateId}"][data-stage="in_room"]`, { timeout: 10000 }).catch(() => {});
    // The card moves before the server answers (on purpose); the row follows a moment later.
    let seated: { seated_at: Date | null; room_id: string | null } = { seated_at: null, room_id: null };
    for (let i = 0; i < 20 && !seated.seated_at; i++) {
      seated = (await db.query(`select seated_at, room_id from appointments where id = $1`, [lateId])).rows[0];
      if (!seated.seated_at) await desk.waitForTimeout(250);
    }
    check("Call in puts the patient in the chosen room", !!seated.seated_at && seated.room_id === R1);
    check("the room strip shows the room busy", (await desk.locator('[data-room-tile="Room 1"]').getAttribute("data-room-busy")) === "1");

    await card(lateId).locator('[data-flow-action="finished"]').click();
    await desk.waitForSelector(`[data-flow-card="${lateId}"][data-stage="finished"]`, { timeout: 10000 }).catch(() => {});
    await desk.waitForTimeout(800);
    const fin = (await db.query(`select a.status, a.finished_at, p.last_visit_at from appointments a join patients p on p.id = a.patient_id where a.id = $1`, [lateId])).rows[0];
    check("Finish completes the visit and dates the patient's last visit", fin.status === "completed" && !!fin.finished_at && !!fin.last_visit_at);
    check("…raising one status event", (await jobsFor(lateId, "trigger:appointment_status_changed")) === 1);
    check("a finished card offers the invoice and the next visit", /Create invoice/.test(await card(lateId).innerText()) && /Book next visit/.test(await card(lateId).innerText()));

    await card(lateId).getByRole("button", { name: "More actions" }).click();
    await desk.locator('[role="menu"] button:has-text("Undo")').click();
    await desk.waitForSelector(`[data-flow-card="${lateId}"][data-stage="in_room"]`, { timeout: 10000 }).catch(() => {});
    await desk.waitForTimeout(800);
    const undone = (await db.query(`select status, finished_at from appointments where id = $1`, [lateId])).rows[0];
    check("Undo puts the visit back with the doctor", undone.status === "scheduled" && !undone.finished_at);
    check("…without raising another event", (await jobsFor(lateId, "trigger:appointment_status_changed")) === 1);

    await card(nextId).getByRole("button", { name: "More actions" }).click();
    await desk.locator(`[role="menu"] button:has-text("Didn't come")`).click();
    await desk.waitForTimeout(1200);
    check("Didn't come marks a no-show", (await db.query(`select status from appointments where id = $1`, [nextId])).rows[0].status === "no_show");

    /* ------------------------------------------------------------ 7. walk-in */
    console.log("\nwalk-in");
    const walker = await mkPatient("Walker Wael");
    await db.query(`insert into waitlist_entries (clinic_id, patient_id, note) values ($1, $2, 'QA')`, [clinic, walker]);
    await desk.getByRole("button", { name: "Walk-in" }).first().click();
    const dlg = desk.locator("[data-walk-in]");
    await dlg.locator("input").first().fill("Walker");
    await dlg.locator('button:has-text("Walker Wael")').first().click({ timeout: 15000 });
    await dlg.locator("select").first().selectOption(docA);
    await dlg.getByRole("button", { name: "Arrived" }).click();
    await desk.waitForTimeout(2000);
    const walk = (await db.query(`select id, walk_in, arrived_at, status from appointments where clinic_id = $1 and patient_id = $2`, [clinic, walker])).rows[0];
    check("a walk-in goes straight to the waiting room", !!walk?.walk_in && !!walk?.arrived_at);
    check("…sends no booking message (no appointment_created)", walk && (await jobsFor(walk.id, "trigger:appointment_created")) === 0);
    const wl = (await db.query(`select status from waitlist_entries where clinic_id = $1 and patient_id = $2`, [clinic, walker])).rows[0];
    check("…and leaves their waitlist entry open", wl?.status === "waiting", wl?.status);

    /* ----------------------------------------------------------- 8. waitlist */
    console.log("\nwaitlist tab");
    const wantsP = await mkPatient("Wants Sooner");
    await desk.goto(`${BASE}/c/${slug}/waitlist`);
    await desk.waitForURL((u) => u.search.includes("tab=waitlist"), { timeout: 30000 }).catch(() => {});
    check("the old waitlist address opens the tab", desk.url().includes("/calendar?tab=waitlist"), desk.url());
    await desk.waitForLoadState("networkidle");
    await desk.addStyleTag({ content: "nextjs-portal{display:none!important}" });
    await desk.getByRole("button", { name: /add to waitlist/i }).first().click();
    const wdlg = desk.getByRole("dialog");
    await wdlg.locator("input").first().fill("Wants");
    await wdlg.getByText("Wants Sooner").first().click({ timeout: 15000 });
    await wdlg.locator("select").nth(0).selectOption(docA);
    await wdlg.locator("select").nth(1).selectOption(S1);
    await wdlg.locator('input[type="date"]').first().fill(tomorrow.toISODate()!);
    await wdlg.getByRole("button", { name: /^add$/i }).click();
    await desk.waitForTimeout(1500);
    const entry = (await db.query(`select id, earliest_date::text from waitlist_entries where clinic_id = $1 and patient_id = $2`, [clinic, wantsP])).rows[0];
    check("adding to the waitlist keeps the date they can come from", entry?.earliest_date === tomorrow.toISODate(), entry?.earliest_date);
    const entryCard = desk.locator(`[data-waitlist-entry="${entry?.id}"]`);
    await entryCard.getByRole("button", { name: "Find a free time" }).click();
    await desk.waitForSelector(`[data-waitlist-entry="${entry?.id}"] [data-waitlist-slots] button`, { timeout: 20000 }).catch(() => {});
    const slotBtns = entryCard.locator("[data-waitlist-slots] button");
    check("Find a free time lists times", (await slotBtns.count()) > 0);
    if ((await slotBtns.count()) > 0) {
      await slotBtns.first().click();
      const aside = desk.locator("aside").last();
      await aside.waitFor({ timeout: 10000 });
      check("picking one opens the booking panel with the patient filled in", (await aside.innerText()).includes("Wants Sooner"));
      await aside.locator("footer").getByRole("button", { name: "Cancel", exact: true }).click();
    }

    /* ---------------------------------------------------- 9. rooms settings */
    console.log("\nrooms settings");
    const unroomed = (
      await db.query(
        `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status)
         values ($1, $2, $3, $4, $5, $6, 'scheduled') returning id`,
        [clinic, wantsP, docA, S1, at(19), at(19, 30)]
      )
    ).rows[0].id as string;
    await desk.goto(`${BASE}/c/${slug}/settings/rooms`);
    await desk.waitForLoadState("networkidle");
    check("the rooms page lists the rooms", (await desk.locator("[data-rooms-list]").innerText()).includes("X-ray room"));
    await desk.getByRole("button", { name: "Place upcoming appointments" }).click();
    await desk.waitForTimeout(2000);
    check("placing upcoming appointments gives them a room", (await db.query(`select room_id from appointments where id = $1`, [unroomed])).rows[0].room_id === R1);
    await desk.getByRole("button", { name: "Add room" }).first().click();
    await desk.getByRole("dialog").locator("input").first().fill("Room 3");
    await desk.getByRole("dialog").getByRole("button", { name: "Save" }).click();
    await desk.waitForTimeout(1500);
    check("a room can be added", (await db.query(`select count(*)::int n from clinic_rooms where clinic_id = $1 and name = 'Room 3' and active`, [clinic])).rows[0].n === 1);

    /* ------------------------------------------------------------ 10. sizes */
    console.log("\nsizes");
    const phoneCtx = await browser.newContext({ ...devices["iPhone 13"] });
    const ph = await phoneCtx.newPage();
    await signIn(ph, `owner-${slug}@test.local`);
    await ph.goto(`${BASE}/c/${slug}/calendar`);
    await ph.waitForSelector("[data-flow-board]", { timeout: 60000 });
    const sideways = async (p: Page) => p.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth") as Promise<number>;
    check("phone: the board does not scroll sideways", (await sideways(ph)) <= 0);
    const switcher = await ph.locator('[data-flow-board] [role="tablist"]').isVisible();
    check("phone: one column at a time behind a switcher", switcher);
    await ph.goto(`${BASE}/c/${slug}/calendar?tab=schedule`);
    await ph.getByRole("button", { name: "List", exact: true }).waitFor({ timeout: 60000 });
    check("phone: the schedule opens as a list", (await ph.getByRole("button", { name: "List", exact: true }).getAttribute("aria-pressed")) === "true");
    check("phone: the schedule does not scroll sideways", (await sideways(ph)) <= 0);
    await phoneCtx.close();

    const tops = async (p: Page) =>
      p.evaluate(
        "[...document.querySelectorAll('[data-flow-columns] > [data-flow-column]')].map((e) => Math.round(e.getBoundingClientRect().top))"
      ) as Promise<number[]>;
    const tab = await browser.newPage({ viewport: { width: 1024, height: 1366 } });
    await signIn(tab, `owner-${slug}@test.local`);
    await tab.goto(`${BASE}/c/${slug}/calendar`);
    await tab.waitForSelector("[data-flow-columns]", { timeout: 60000 });
    const tTops = await tops(tab);
    check("tablet: the board is two columns by two", new Set(tTops).size === 2, tTops.join(","));
    await tab.close();
    await desk.goto(`${BASE}/c/${slug}/calendar`);
    await desk.waitForSelector("[data-flow-columns]", { timeout: 60000 });
    const dTops = await tops(desk);
    check("desk: all four columns side by side", dTops.length === 4 && new Set(dTops).size === 1, dTops.join(","));

    await doctor.goto(`${BASE}/c/${slug}/calendar`);
    await doctor.waitForSelector("[data-flow-board]", { timeout: 60000 });
    check("a doctor's board starts on their own patients", (await doctor.getByRole("button", { name: "Mine", exact: true }).getAttribute("aria-pressed")) === "true");

    check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
    await browser.close();
  } finally {
    for (const id of clinicIds) await db.query(`delete from clinics where id = $1`, [id]);
    await db.query(`delete from users where id = any($1::uuid[])`, [userIds]);
    await db.end();
  }

  console.log(`\n  appointments flow: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
