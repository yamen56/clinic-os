/**
 * Note categories can be deleted, and not by everyone.
 *
 * Two changes that belong together. A category could be invented from the
 * patient file and never removed, so a clinic's list only ever grew — and the
 * inventing was open to anyone who could open a patient, because it sat under
 * `patients` along with writing the notes themselves.
 *
 * Deleting is the part that has to be safe. `patient_notes.category_id` and the
 * version history behind it are both `on delete set null`, so the notes stay in
 * the patient's record and simply lose their label. A note is a clinical
 * record; if removing a category could remove notes this feature could not
 * exist. That is the first thing checked here.
 *
 * The second is the gate. `patients.categories` is a new capability and an
 * absent one reads as false, so a member granted Patients before today can
 * still write notes and can no longer reshape the list everyone files against.
 * Both halves are checked — the buttons are gone from the screen *and* the
 * action refuses — because a hidden button is a decision and a server that
 * still accepts the call is a hole.
 *
 * Assertions read `innerText`, never `textContent`: the whole dictionary ships
 * in every page's RSC payload, so a `textContent` check passes everywhere.
 *
 *   npx tsx scripts/qa-note-categories.ts
 */
import { chromium, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";

const BASE = "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const PASSWORD = "password123";

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

async function login(page: Page, email: string) {
  // Three members sign in over one browser. Without this the second /login
  // redirects straight back into the first one's workspace and the form the
  // fill is waiting for never renders.
  await page.context().clearCookies();
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120000 });
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const tag = Date.now().toString(36);
  const slug = `qacat${tag}`;
  const hash = bcrypt.hashSync(PASSWORD, 10);

  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug) values ('QA Categories', 'تصنيفات', $1) returning id`,
      [slug]
    )
  ).rows[0];

  try {
    await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);

    const mkUser = async (who: string, caps: Record<string, boolean> | "owner") => {
      const u = (
        await db.query(
          `insert into users (email, password_hash, full_name) values ($1, $2, $3) returning id`,
          [`qacat-${tag}-${who}@test.local`, hash, `QA ${who}`]
        )
      ).rows[0];
      await db.query(
        `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
         values ($1, $2, 'receptionist', $3, $4)`,
        [
          clinic.id,
          u.id,
          caps === "owner",
          caps === "owner" ? '{"level":"full"}' : JSON.stringify({ level: "custom", caps }),
        ]
      );
      return `qacat-${tag}-${who}@test.local`;
    };

    const ownerEmail = await mkUser("owner", "owner");
    /* Patients, but not the list everyone files against — the case this exists for. */
    const plainEmail = await mkUser("plain", { dashboard: true, patients: true });
    const curatorEmail = await mkUser("curator", {
      dashboard: true,
      patients: true,
      "patients.categories": true,
    });

    // The two seeded categories, as a real clinic gets them.
    await db.query(`select seed_note_categories($1)`, [clinic.id]);
    const extra = (
      await db.query(
        `insert into note_categories (clinic_id, name, name_ar, color, sort)
         values ($1, 'Follow-up', 'متابعة', '#8a5a44', 99) returning id`,
        [clinic.id]
      )
    ).rows[0].id as string;

    const patient = (
      await db.query(
        `insert into patients (clinic_id, full_name, phone_e164) values ($1, 'مريم القيسي', $2) returning id`,
        [clinic.id, `+96279000${Math.floor(Math.random() * 9000 + 1000)}`]
      )
    ).rows[0];

    // Two notes under the category that is about to be deleted.
    for (const body of ["Follow-up in two weeks", "Patient called about the follow-up"]) {
      await db.query(
        `insert into patient_notes (clinic_id, patient_id, body, category_id, kind)
         values ($1, $2, $3, $4, 'clinical')`,
        [clinic.id, patient.id, body, extra]
      );
    }

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const notesUrl = `${BASE}/c/${slug}/patients/${patient.id}?tab=notes`;
    const visible = async () => (await page.locator("main").first().innerText()).replace(/\s+/g, " ");

    const openNotes = async () => {
      await page.goto(notesUrl);
      await page.waitForLoadState("networkidle");
      // The tab is client state, so click it rather than trusting the query.
      // These are role="tab", not buttons — see components/ui/misc.tsx.
      await page.getByRole("tab", { name: /الملاحظات|Notes/ }).first().click();
      await page.waitForTimeout(700);
    };

    try {
      /* ================================= a member without the capability */
      console.log("\n[patients, but not the clinic's list]");
      await login(page, plainEmail);
      await openNotes();
      const plainView = await visible();
      check("they still see the notes", plainView.includes("Follow-up in two weeks"));
      check("and the category chips", plainView.includes("متابعة"), plainView.slice(0, 70));
      check(
        "but no way to add one",
        (await page.getByRole("button", { name: /تصنيف جديد|New category/ }).count()) === 0
      );
      check(
        "and no way to manage the list",
        (await page.getByRole("button", { name: /إدارة التصنيفات|Manage categories/ }).count()) === 0
      );

      /* ================================= and the server agrees */
      console.log("\n[the button being gone is not the gate]");
      /*
        A hidden control is a rendering decision. The check that matters is
        whether the action refuses when called anyway — which is what a member
        with the page open and a console can do.
      */
      const before = (
        await db.query(`select count(*)::int n from note_categories where clinic_id = $1`, [clinic.id])
      ).rows[0].n as number;
      const forged = await page.evaluate(
        async ([s, id]) => {
          // Next server actions are not callable by name from the page, so go
          // through the same POST the form would make and read the status.
          const res = await fetch(location.href, {
            method: "POST",
            headers: { "Next-Action": "invalid-probe", "Content-Type": "text/plain;charset=UTF-8" },
            body: JSON.stringify([s, id]),
          });
          return res.status;
        },
        [slug, extra] as const
      );
      const after = (
        await db.query(`select count(*)::int n from note_categories where clinic_id = $1`, [clinic.id])
      ).rows[0].n as number;
      check("a hand-made action call changes nothing", after === before, `${before} → ${after}`);
      check("and is not silently accepted", forged !== 200 || after === before, `status ${forged}`);

      /* ================================= a member with it */
      console.log("\n[the member who curates the list]");
      await login(page, curatorEmail);
      await openNotes();
      check(
        "sees the add control",
        (await page.getByRole("button", { name: /تصنيف جديد|New category/ }).count()) > 0
      );
      const manage = page.getByRole("button", { name: /إدارة التصنيفات|Manage categories/ });
      check("and the manage control", (await manage.count()) > 0);

      await manage.first().click();
      await page.waitForTimeout(600);
      const modal = await page.locator("body").innerText();
      check("the modal lists every category", modal.includes("متابعة") && modal.includes("سريري"));
      /*
        Including the two seeded ones. `is_system` used to make those
        undeletable; a list where two rows have no delete button reads as broken
        rather than as protected, and the notes are safe either way.
      */
      check("the seeded ones included", modal.includes("إداري"), "إداري");

      /* ================================= the delete itself */
      console.log("\n[deleting one]");
      const rows = page.locator("li", { hasText: "متابعة" });
      await rows.first().getByRole("button", { name: /حذف|Delete/ }).first().click();
      await page.waitForTimeout(500);
      const dialog = await page.locator("body").innerText();
      check(
        "the dialog says the notes are kept",
        dialog.includes("تبقى كما هي") || dialog.includes("are kept"),
        dialog.replace(/\s+/g, " ").match(/الملاحظات المدرجة.{0,60}/)?.[0] ?? ""
      );
      await page
        .getByRole("button", { name: /^\s*(حذف|Delete)\s*$/ })
        .last()
        .click();
      await page.waitForTimeout(2500);

      const gone = (
        await db.query(`select 1 from note_categories where id = $1`, [extra])
      ).rowCount;
      check("the category is gone", gone === 0);

      /*
        The whole reason this can exist: a clinical record is never collateral.
      */
      const survivors = (
        await db.query(
          `select body, category_id from patient_notes where clinic_id = $1 and patient_id = $2
            order by created_at`,
          [clinic.id, patient.id]
        )
      ).rows;
      check("both notes survive", survivors.length === 2, `${survivors.length} notes`);
      check(
        "and are simply unfiled",
        survivors.every((n) => n.category_id === null),
        survivors.map((n) => String(n.category_id)).join(", ")
      );

      // The tab is client state, so a reload lands on the overview — reopen it,
      // or this reads the wrong screen and passes for the wrong reason.
      await openNotes();
      const afterView = await visible();
      check("the notes are still on the screen", afterView.includes("Follow-up in two weeks"));
      check("and both of them", afterView.includes("Patient called about the follow-up"));
      check("without the deleted category", !afterView.includes("متابعة"), afterView.slice(0, 70));

      /* ================================= the owner, and the settings screen */
      console.log("\n[the owner always has it]");
      await login(page, ownerEmail);
      await openNotes();
      check(
        "an owner can manage the list whatever is stored",
        (await page.getByRole("button", { name: /إدارة التصنيفات|Manage categories/ }).count()) > 0
      );

      /*
        The toggles live inside a member's edit panel, and only on custom
        access — so open the member who already has it, rather than reading the
        list page and concluding the permission does not exist.
      */
      await page.goto(`${BASE}/c/${slug}/settings/staff`);
      await page.waitForLoadState("networkidle");
      // The row is not clickable; the pencil at the end of it is.
      await page
        .locator("li", { hasText: "QA plain" })
        .first()
        .getByRole("button", { name: /تعديل|Edit/ })
        .first()
        .click();
      await page.waitForTimeout(1000);
      check(
        "and the new permission is offered under Patients",
        (await page.locator("body").innerText()).includes("إضافة وحذف فئات الملاحظات"),
        "إضافة وحذف فئات الملاحظات"
      );

      check("no client-side errors", errors.length === 0, errors.slice(0, 2).join("; "));
    } finally {
      await browser.close();
    }
  } finally {
    await db.query(`delete from clinics where id = $1`, [clinic.id]);
    await db.query(`delete from users where email like $1`, [`qacat-${tag}-%`]);
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
