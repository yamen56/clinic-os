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

/**
 * A minimal .docx. Word files are zips of XML, and the only part that matters
 * for the conversion is `word/document.xml`, so this writes the container by
 * hand rather than pulling in a authoring library for one fixture.
 */
function makeDocx(paragraphs: string[]): Buffer {
  const zlib = require("node:zlib") as typeof import("node:zlib");
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`)
    .join("");
  const files: [string, string][] = [
    [
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    ],
    [
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    ],
    [
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    ],
  ];

  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content, "utf8");
    const deflated = zlib.deflateRawSync(data);
    const crc = zlib.crc32 ? zlib.crc32(data) : crc32(data);
    const nameBuf = Buffer.from(name, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0, 10); // time/date
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, deflated);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(0, 12);
    cd.writeUInt32LE(crc >>> 0, 16);
    cd.writeUInt32LE(deflated.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + deflated.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, end]);
}

/** Node 24 has zlib.crc32; this is the fallback for older runtimes. */
function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
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

  /* --------------------------------------------------- 3. importing a file */
  const docxRes = await page.request.post(`${BASE}/api/c/${slug}/documents/import`, {
    multipart: {
      file: {
        name: "consent.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        buffer: makeDocx(["Treatment consent", "I agree to the treatment described above."]),
      },
    },
  });
  const docxJson = await docxRes.json();
  check("a Word file converts", docxRes.ok() && docxJson.format === "docx", JSON.stringify(docxJson).slice(0, 120));
  check(
    "its wording survives",
    typeof docxJson.html === "string" && docxJson.html.includes("I agree to the treatment"),
    String(docxJson.html).slice(0, 80)
  );

  const pdfImport = await page.request.post(`${BASE}/api/c/${slug}/documents/import`, {
    multipart: {
      file: {
        name: "old.pdf",
        mimeType: "application/pdf",
        buffer: await makePdf(["Privacy notice", "Your records are kept for seven years."]),
      },
    },
  });
  const pdfJson = await pdfImport.json();
  check("a PDF gives up its text", pdfImport.ok() && pdfJson.characters > 0, `${pdfJson.characters} chars`);
  check(
    "the text is the right text",
    String(pdfJson.html).includes("seven years"),
    String(pdfJson.html).slice(0, 90)
  );
  check(
    "and the clinic is warned the layout is gone",
    Array.isArray(pdfJson.warnings) && pdfJson.warnings.includes("pdf_layout_lost"),
    JSON.stringify(pdfJson.warnings)
  );

  const badRes = await page.request.post(`${BASE}/api/c/${slug}/documents/import`, {
    multipart: {
      file: { name: "old.doc", mimeType: "application/msword", buffer: Buffer.from("\xd0\xcf\x11\xe0rubbish", "latin1") },
    },
  });
  check(
    "an old .doc is refused by name, not silently mangled",
    badRes.status() === 415 && (await badRes.json()).error === "unsupported_format"
  );

  // The import button is reachable from the editor, which is where the result lands.
  await page.goto(`${BASE}/c/${slug}/settings/documents/new`);
  await page.waitForLoadState("networkidle");
  check(
    "the editor offers the import",
    (await page.locator("button:has-text('Import Word or PDF')").count()) > 0
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
