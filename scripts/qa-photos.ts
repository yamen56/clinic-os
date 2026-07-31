/**
 * Staff photos: upload, display, permission and removal.
 *
 * The permission rules are the point. A photo is served to colleagues, so who
 * may set one — and whose — has to hold: your own face is yours, anyone else's
 * needs the staff capability, and nobody at another clinic can be reached at
 * all.
 */
import { chromium, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

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

/** A real 1x1 PNG, so the byte sniffing has something honest to accept. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30000 });
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  const slug = `qaphoto-test${Date.now().toString(36)}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, default_locale) values ('QA Photo','صور',$1,'en') returning id`,
      [slug]
    )
  ).rows[0];
  await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);

  const mkUser = async (label: string, name: string) =>
    (
      await db.query(
        `insert into users (email, password_hash, full_name, locale) values ($1,$2,$3,'en') returning id`,
        [`${label}-${slug}@test.local`, bcrypt.hashSync("password123", 10), name]
      )
    ).rows[0].id as string;

  const ownerU = await mkUser("owner", "QA Owner");
  const docU = await mkUser("doc", "QA Doctor");

  const mkMember = async (userId: string, role: string, isOwner: boolean) =>
    (
      await db.query(
        `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
         values ($1,$2,$3,$4,$5) returning id`,
        [
          clinic.id,
          userId,
          role,
          isOwner,
          isOwner
            ? JSON.stringify({ level: "full" })
            : JSON.stringify({ level: "custom", caps: { calendar: true, patients: true } }),
        ]
      )
    ).rows[0].id as string;

  const ownerM = await mkMember(ownerU, "receptionist", true);
  const docM = await mkMember(docU, "doctor", false);
  console.log(`✓ fixture clinic ${slug}`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  const postPhoto = async (memberId: string, bytes: Buffer, name = "face.png", type = "image/png") =>
    page.request.post(`${BASE}/api/c/${slug}/staff/${memberId}/photo`, {
      multipart: { file: { name, mimeType: type, buffer: bytes } },
    });

  /* ------------------------------------------- 1. the doctor sets their own */
  await signIn(page, `doc-${slug}@test.local`);

  let res = await postPhoto(docM, PNG);
  check("a doctor can set their own photo", res.ok(), String(res.status()));

  const stored = (
    await db.query(`select avatar_path from users where id = $1`, [docU])
  ).rows[0].avatar_path;
  check("it is recorded against the user, not the membership", !!stored, stored?.slice(0, 40));

  const got = await page.request.get(`${BASE}/api/c/${slug}/staff/${docM}/photo`);
  const body = await got.body();
  check(
    "and serves back as an image",
    got.ok() && body.subarray(1, 4).toString("latin1") === "PNG",
    `${got.status()}, ${body.length} bytes, ${got.headers()["content-type"]}`
  );
  check(
    "privately, so a shared cache cannot keep it",
    (got.headers()["cache-control"] ?? "").includes("private"),
    got.headers()["cache-control"]
  );

  /* ------------------------ 2. the doctor may not set a colleague's photo */
  res = await postPhoto(ownerM, PNG);
  check(
    "a doctor cannot change someone else's photo",
    res.status() === 403,
    String(res.status())
  );

  /* --------------------------------- 3. but can see one, being a colleague */
  await postPhotoAsOwner();
  async function postPhotoAsOwner() {
    const owner = await browser.newPage();
    await signIn(owner, `owner-${slug}@test.local`);
    const r = await owner.request.post(`${BASE}/api/c/${slug}/staff/${ownerM}/photo`, {
      multipart: { file: { name: "o.png", mimeType: "image/png", buffer: PNG } },
    });
    check("someone with the staff capability can set another's photo", r.ok(), String(r.status()));
    await owner.close();
  }

  const colleague = await page.request.get(`${BASE}/api/c/${slug}/staff/${ownerM}/photo`);
  check("a colleague's photo is visible inside the clinic", colleague.ok(), String(colleague.status()));

  /* ------------------------------------------- 4. rubbish is not an image */
  res = await postPhoto(docM, Buffer.from("<?php echo 1; ?>"), "evil.png", "image/png");
  check(
    "a non-image is refused however it labels itself",
    res.status() === 415,
    String(res.status())
  );

  /* ------------------------------------------------ 5. another clinic's staff */
  const otherClinic = (
    await db.query(`insert into clinics (name, slug, default_locale) values ('Other',$1,'en') returning id`, [
      `${slug}-other`,
    ])
  ).rows[0];
  const otherU = await mkUser("other", "Other Person");
  const otherM = (
    await db.query(
      `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
       values ($1,$2,'receptionist',true,'{"level":"full"}') returning id`,
      [otherClinic.id, otherU]
    )
  ).rows[0].id as string;

  const cross = await page.request.get(`${BASE}/api/c/${slug}/staff/${otherM}/photo`);
  check(
    "a membership from another clinic is simply not found",
    cross.status() === 404,
    String(cross.status())
  );

  /* --------------------------------------------------------- 6. removal */
  const del = await page.request.delete(`${BASE}/api/c/${slug}/staff/${docM}/photo`);
  check("a photo can be removed", del.ok(), String(del.status()));
  const after = (await db.query(`select avatar_path from users where id = $1`, [docU])).rows[0];
  check("and the record is cleared", after.avatar_path === null);
  const gone = await page.request.get(`${BASE}/api/c/${slug}/staff/${docM}/photo`);
  check("serving it afterwards is a 404", gone.status() === 404, String(gone.status()));

  /* ---------------------------------------- 7. it shows on the staff screen */
  const owner2 = await browser.newPage();
  await signIn(owner2, `owner-${slug}@test.local`);
  await owner2.goto(`${BASE}/c/${slug}/settings/staff`);
  await owner2.waitForLoadState("networkidle");
  const imgs = await owner2.locator(`img[src*="/staff/"][src*="/photo"]`).count();
  check("the staff list renders the photo", imgs > 0, `${imgs} image(s)`);
  await owner2.close();

  check("no page errors", errors.length === 0, errors.join(" | "));

  await browser.close();
  await db.query(`delete from clinics where id = any($1::uuid[])`, [[clinic.id, otherClinic.id]]);
  await db.query(`delete from users where id = any($1::uuid[])`, [[ownerU, docU, otherU]]);
  await db.end();

  console.log(`\n  photos: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
