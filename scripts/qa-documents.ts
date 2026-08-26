/**
 * Browser QA for the document changes: instant tabs, uploading a signed copy,
 * and importing a Word or PDF file into a template.
 *
 * The tab timing check is a measurement, not a vibe. The tabs used to push a new
 * URL and wait for a server render; the assertion here is that switching them
 * changes what is on screen without a navigation at all, because "feels slow"
 * is only fixable if it is also measurable.
 */
import { chromium, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { PDFDocument, StandardFonts } from "pdf-lib";

const BASE = "http://localhost:3000";
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

/** A small, real PDF with a text layer, so the import path has something to read. */
async function makePdf(lines: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  let y = 780;
  for (const line of lines) {
    page.drawText(line, { x: 50, y, size: 12, font });
    y -= 28;
  }
  return Buffer.from(await doc.save());
}

async function signIn(page: Page, email: string) {
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

  const slug = `qadoc-test${Date.now().toString(36)}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, default_locale) values ('QA Docs', 'مستندات', $1, 'en') returning id`,
      [slug]
    )
  ).rows[0];
  await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  const owner = (
    await db.query(
      `insert into users (email, password_hash, full_name, locale) values ($1, $2, 'QA Docs Owner', 'en') returning id`,
      [`owner-${slug}@test.local`, bcrypt.hashSync("password123", 10)]
    )
  ).rows[0];
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1, $2, 'receptionist', true, '{"level":"full"}')`,
    [clinic.id, owner.id]
  );
  await db.query(
    `insert into signer_roles (clinic_id, key, label, is_system) values ($1, 'patient', 'Patient', true)`,
    [clinic.id]
  );
  const patient = (
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164, source)
       values ($1, 'Layla Odeh', '+962790000111', 'staff') returning id`,
      [clinic.id]
    )
  ).rows[0];

  // One document per tab, so switching between them is a visible change.
  const mkDoc = async (title: string, status: string) => {
    const d = (
      await db.query(
        `insert into documents (clinic_id, patient_id, title, language, status, sent_at, completed_at)
         values ($1, $2, $3, 'en', $4, case when $4 <> 'draft' then now() end,
                 case when $4 = 'completed' then now() end)
         returning id`,
        [clinic.id, patient.id, title, status]
      )
    ).rows[0];
    await db.query(
      `insert into document_signers (clinic_id, document_id, role_key, display_name, phone_e164, status, signed_at)
       values ($1, $2, 'patient', 'Layla Odeh', '+962790000111', $3,
               case when $3 = 'signed' then now() end)`,
      [clinic.id, d.id, status === "completed" ? "signed" : "pending"]
    );
    return d.id as string;
  };
  const pendingDoc = await mkDoc("Consent — pending", "sent");
  await mkDoc("Consent — finished", "completed");
  console.log(`✓ fixture clinic ${slug}`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await signIn(page, `owner-${slug}@test.local`);

  /* ------------------------------------------------------------ 1. the tabs */
  await page.goto(`${BASE}/c/${slug}/documents`);
  await page.waitForLoadState("networkidle");

  /*
    Counting requests for the documents route itself, not frame events. A frame
    event also fires for the background `router.refresh()` the realtime hook
    schedules, which has nothing to do with the tab and made this flaky; what
    the fix actually claims is that pressing a tab needs no server render, and
    that is exactly a request for this route not happening.
  */
  let routeRequests = 0;
  const countRequest = (url: string) => {
    if (new URL(url).pathname === `/c/${slug}/documents`) routeRequests++;
  };
  page.on("request", (r) => countRequest(r.url()));

  const urlBefore = page.url();
  const t0 = Date.now();
  await page.click("button[role='tab']:has-text('Completed')");
  await page.waitForSelector("text=Consent — finished", { timeout: 4000 });
  const elapsed = Date.now() - t0;

  check("switching tabs shows the other list", true);
  check("it asks the server for nothing", routeRequests === 0, `${routeRequests} request(s)`);
  check("the URL does not change", page.url() === urlBefore);
  check("the switch is immediate", elapsed < 400, `${elapsed}ms`);
  check(
    "the pending document is filtered out",
    (await page.locator("text=Consent — pending").count()) === 0
  );

  await page.click("button[role='tab']:has-text('Waiting')");
  await page.waitForSelector("text=Consent — pending", { timeout: 4000 });
  check("and back again", (await page.locator("text=Consent — finished").count()) === 0);

  /* ------------------------------------------- 2. uploading a signed copy */
  await page.goto(`${BASE}/c/${slug}/documents/${pendingDoc}`);
  await page.waitForLoadState("networkidle");
  check(
    "the upload button is offered",
    (await page.locator("button:has-text('Upload signed copy')").count()) > 0
  );

  const signedPdf = await makePdf(["Signed on paper", "Layla Odeh"]);
  await page.click("button:has-text('Upload signed copy')");
  await page.waitForSelector("input[type=file]", { timeout: 10000 });
  await page.setInputFiles("input[type=file]", {
    name: "signed.pdf",
    mimeType: "application/pdf",
    buffer: signedPdf,
  });
  await page.locator("button:has-text('Upload signed copy')").last().click();
  await page.waitForSelector("text=This is a signed copy from outside", { timeout: 20000 });

  const doc = (
    await db.query(
      `select status, final_pdf_path, final_pdf_source, completed_at from documents where id = $1`,
      [pendingDoc]
    )
  ).rows[0];
  check("the document completes", doc.status === "completed", doc.status);
  check("the file is stored", !!doc.final_pdf_path);
  check("its provenance is recorded", doc.final_pdf_source === "uploaded", doc.final_pdf_source);
  check("and the screen says so, rather than looking signed here", true);

  const signer = (
    await db.query(`select status, signed_in_person from document_signers where document_id = $1`, [
      pendingDoc,
    ])
  ).rows[0];
  check("the ticked signer is marked signed on paper", signer.status === "signed" && signer.signed_in_person);

  const ev = await db.query(
    `select event_type from document_events where document_id = $1 order by created_at`,
    [pendingDoc]
  );
  const types = ev.rows.map((r) => r.event_type);
  check("the audit trail records the upload", types.includes("final_uploaded"), types.join(", "));

  // The PDF that comes back is the uploaded one, not a regenerated render.
  const pdfRes = await page.request.get(`${BASE}/api/c/${slug}/documents/${pendingDoc}/pdf`);
  const pdfBody = await pdfRes.body();
  check(
    "downloading returns the uploaded file",
    pdfRes.ok() && pdfBody.subarray(0, 5).toString("latin1") === "%PDF-",
    `${pdfRes.status()}, ${pdfBody.length} bytes`
  );

  /* ------------------------ 2b. a completed document with nothing stored yet */
  /*
    The case staff actually hit: the last signature landed a moment ago, or the
    worker was down, so `final_pdf_path` is still null. The button used to be
    hidden on exactly those documents — which reads as the feature missing
    rather than the render being a few seconds behind.
  */
  const freshDoc = await mkDoc("Consent — just completed", "completed");
  await page.goto(`${BASE}/c/${slug}/documents/${freshDoc}`);
  await page.waitForLoadState("networkidle");
  check(
    "a completed document offers the download before its file exists",
    (await page.getByRole("button", { name: /Download signed PDF/i }).count()) > 0
  );

  const beforePath = (
    await db.query(`select final_pdf_path from documents where id = $1`, [freshDoc])
  ).rows[0];
  check("and nothing is stored for it yet", beforePath.final_pdf_path === null);

  const built = await page.request.get(`${BASE}/api/c/${slug}/documents/${freshDoc}/pdf`);
  const builtBody = await built.body();
  check(
    "pressing it builds the signed PDF on demand",
    built.ok() && builtBody.subarray(0, 5).toString("latin1") === "%PDF-",
    `${built.status()}, ${builtBody.length} bytes`
  );

  const afterPath = (
    await db.query(`select final_pdf_path, final_pdf_source from documents where id = $1`, [freshDoc])
  ).rows[0];
  check("and keeps it, so the next download is instant", !!afterPath.final_pdf_path);
  check(
    "the generated one is not labelled as an upload",
    afterPath.final_pdf_source === "generated",
    afterPath.final_pdf_source
  );

  // A document nobody has finished has nothing to hand over, and says so
  // rather than producing a half-signed file.
  const draftDoc = await mkDoc("Consent — draft", "draft");
  const notReady = await page.request.get(`${BASE}/api/c/${slug}/documents/${draftDoc}/pdf`);
  check(
    "an unfinished document refuses instead of inventing one",
    notReady.status() === 409,
    String(notReady.status())
  );

  /* ------------------------------ 3. the withdrawn import and upload paths */
  /*
    Both are gone, and this asserts they stay gone rather than that they work.
    Converting a Word file or a PDF into an editable template never did so
    reliably — Arabic came back reversed and disconnected out of a PDF text
    layer (decision 27), and a consent form that comes out wrong is worse than
    one somebody has to type. Existing uploaded templates still render and
    still sign; only the making of new ones was removed.
  */
  for (const route of ["import", "upload-template"]) {
    const gone = await page.request.post(`${BASE}/api/c/${slug}/documents/${route}`, {
      multipart: {
        file: { name: "x.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-") },
      },
    });
    /*
      Any 4xx/5xx will do, and pinning an exact code here would be wrong: Next
      answers an unmatched POST with a 404 when signed out and a rendered 500
      error page when signed in. What matters is that nothing accepts the file.
    */
    check(
      `/documents/${route} is gone`,
      !gone.ok(),
      `${gone.status()} — the route still answers`
    );
  }

  await page.goto(`${BASE}/c/${slug}/settings/documents`);
  await page.waitForLoadState("networkidle");
  // Wait for the page's own content, not just the shell: reading innerText at
  // networkidle can catch the nav alone and pass on an empty page.
  await page.locator("button:has-text('New template')").first().waitFor({ timeout: 30000 });
  const offered = await page.evaluate(() => document.body.innerText);
  check(
    "the templates page offers neither upload nor import",
    !/Upload a PDF|Import Word or PDF/i.test(offered),
    (offered.match(/.{0,90}(Upload a PDF|Import Word or PDF).{0,90}/i)?.[0] ?? offered.slice(0, 120))
      .replace(/\s+/g, " ")
  );

  // And writing one still works, which is the path that remains.
  await page.goto(`${BASE}/c/${slug}/settings/documents/new`);
  await page.waitForLoadState("networkidle");
  check(
    "a template is still written in the editor",
    (await page.locator("[contenteditable='true']").count()) > 0
  );

  check("no page errors", errors.length === 0, errors.join(" | "));

  await browser.close();
  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  await db.query(`delete from users where id = $1`, [owner.id]);
  await db.end();

  console.log(`\n  documents: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
