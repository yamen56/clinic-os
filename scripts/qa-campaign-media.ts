/**
 * QA for campaign photos and videos.
 *
 * Covers the whole path a file takes: picked in the dialog, checked and stored
 * by the upload route, attached by the create action (which must refuse a path
 * that is not this clinic's), carried onto each recipient's message by the drip,
 * and finally turned into the content Baileys sends. That last step is run
 * through Baileys' own media preparation with the network upload stubbed, so the
 * thumbnail, size and length that recipients see are checked on the real proto
 * rather than on our own object.
 *
 * The video is recorded in the page with MediaRecorder: a genuine H.264 MP4,
 * with no ffmpeg on the machine and no binary fixture in the repo.
 */
import { chromium, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import sharp from "sharp";
import { readFileBuffer, deleteClinicFiles } from "../src/lib/storage";

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

async function waitForStatus(db: Client, id: string, want: string, ms = 20000) {
  const until = Date.now() + ms;
  for (;;) {
    const r = await db.query(`select status from campaigns where id = $1`, [id]);
    if (r.rows[0]?.status === want) return;
    if (Date.now() > until) throw new Error(`campaign stayed '${r.rows[0]?.status}', expected '${want}'`);
    await new Promise((res) => setTimeout(res, 250));
  }
}

const silent = {
  level: "silent",
  child() {
    return silent;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

async function main() {
  const { pumpClinic } = await import("../worker/campaigns");
  const { messageContent } = await import("../worker/outbound");
  const { prepareWAMessageMedia } = await import("@whiskeysockets/baileys");
  const db = new Client({ connectionString: PG });
  await db.connect();

  const slug = `qamedia${Date.now().toString(36)}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, slug, timezone, default_locale, message_window_start, message_window_end, daily_outbound_cap)
       values ('QA Campaign Media', $1, 'Asia/Amman', 'en', '00:00', '23:59', 300) returning id`,
      [slug]
    )
  ).rows[0];
  await db.query(`insert into whatsapp_sessions (clinic_id, status) values ($1, 'connected')`, [clinic.id]);
  const hash = bcrypt.hashSync("password123", 10);
  const owner = (
    await db.query(
      `insert into users (email, password_hash, full_name, locale) values ($1, $2, 'QA Owner', 'en') returning id`,
      [`owner-${slug}@test.local`, hash]
    )
  ).rows[0];
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'other', true, '{"level":"full"}')`,
    [clinic.id, owner.id]
  );
  // Can work the inbox, cannot send campaigns.
  const staff = (
    await db.query(
      `insert into users (email, password_hash, full_name, locale) values ($1, $2, 'QA Staff', 'en') returning id`,
      [`staff-${slug}@test.local`, hash]
    )
  ).rows[0];
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1, $2, 'other', false, '{"level":"custom","caps":{"conversations":true}}')`,
    [clinic.id, staff.id]
  );
  for (let i = 1; i <= 3; i++) {
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164, tags, source)
       values ($1, $2, $3, array['promo'], 'staff')`,
      [clinic.id, `Promo Patient ${i}`, `+96279100${String(1000 + i)}`]
    );
  }

  const cleanup = async () => {
    await deleteClinicFiles(clinic.id);
    await db.query(`delete from clinics where id = $1`, [clinic.id]);
    await db.query(`delete from users where id = any($1)`, [[owner.id, staff.id]]);
  };

  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    const login = async (p: Page, email: string) => {
      await p.goto(`${BASE}/login`);
      await p.fill('input[name="email"]', email);
      await p.fill('input[name="password"]', "password123");
      await p.click('button[type="submit"]');
      await p.waitForURL(`**/c/${slug}`, { timeout: 20000 });
    };
    await login(page, `owner-${slug}@test.local`);

    const openDialog = async (name: string) => {
      await page.goto(`${BASE}/c/${slug}/campaigns`);
      await page.click("text=New campaign");
      await page.waitForSelector('input[maxlength="120"]');
      await page.fill('input[maxlength="120"]', name);
      await page.selectOption("select >> nth=0", "promo");
      await page.waitForSelector("text=Will message 3 patients", { timeout: 20000 });
    };
    // Fails with the dialog's own error when there is one, not a bare timeout.
    const create = async () => {
      await page.click("text=Review 3 recipients");
      const shown = page.locator('[role="dialog"] p.bg-danger-soft');
      const navigated = page.waitForURL(/\/campaigns\/[0-9a-f-]{36}$/, { timeout: 30000 }).then(() => null);
      navigated.catch(() => {}); // the loser of the race must not reject unheard
      const refused = shown.waitFor({ timeout: 30000 }).then(
        () => shown.innerText(),
        () => new Promise<null>(() => {})
      );
      const error = await Promise.race([navigated, refused]);
      if (error) throw new Error(`create refused: ${error}`);
      return page.url().split("/").pop()!;
    };
    const fileInput = 'input[type="file"]';
    const campaignCount = async () =>
      (await db.query(`select count(*)::int as n from campaigns where clinic_id = $1`, [clinic.id])).rows[0]
        .n as number;

    // ------------------------------------------------------------ the picker
    await openDialog("Wrong file");
    const gif = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#ff0000" },
    })
      .gif()
      .toBuffer();
    await page.setInputFiles(fileInput, { name: "anim.gif", mimeType: "image/gif", buffer: gif });
    await page.waitForSelector("text=Choose a JPG, PNG or WebP photo, or an MP4 video");
    assert((await page.locator('img[src^="blob:"]').count()) === 0, "a GIF was accepted into the preview");
    ok("the picker refuses a type it does not send, and says what it does");

    // ----------------------------------------------------------------- photo
    // A phone photo as it really arrives: sideways in EXIF, carrying a GPS fix.
    const photo = await sharp({
      create: { width: 3000, height: 1500, channels: 3, background: { r: 30, g: 120, b: 200 } },
    })
      .withMetadata({ orientation: 6 })
      .withExifMerge({
        IFD0: { Artist: "QA Phone" },
        IFD3: { GPSLatitudeRef: "N", GPSLatitude: "31/1 57/1 0/1" },
      })
      .jpeg()
      .toBuffer();
    const photoIn = await sharp(photo).metadata();
    assert(photoIn.exif && photoIn.orientation === 6, "fixture photo lost its EXIF before the test began");

    await openDialog("Photo promo");
    await page.setInputFiles(fileInput, { name: "clinic-photo.jpg", mimeType: "image/jpeg", buffer: photo });
    await page.waitForSelector('img[src^="blob:"]');
    // Compared whole, so the hint's "becomes its caption" cannot satisfy it.
    const labels = await page.locator('[role="dialog"] span.font-semibold').allInnerTexts();
    assert(labels.some((l) => l.trim() === "Caption"), `no Caption label among ${labels.join(" | ")}`);
    assert(!labels.some((l) => l.trim().startsWith("Message")), "the Message label is still shown");
    ok("a photo previews in the dialog and the message becomes its caption");

    // No text at all: a photo alone is a message.
    const photoId = await create();
    const photoRow = (
      await db.query(
        `select media_kind, media_path, media_name, media_mime, media_meta, body from campaigns where id = $1`,
        [photoId]
      )
    ).rows[0];
    assert(photoRow.media_kind === "image", `media_kind ${photoRow.media_kind}`);
    assert(photoRow.media_mime === "image/jpeg", `media_mime ${photoRow.media_mime}`);
    assert(
      String(photoRow.media_path).startsWith(`${clinic.id}/campaign-media/`) &&
        String(photoRow.media_path).endsWith(".jpg"),
      `unexpected path ${photoRow.media_path}`
    );
    assert(photoRow.media_name === "clinic-photo.jpg", `media_name ${photoRow.media_name}`);
    assert(photoRow.body === "" && photoRow.media_meta === null, "photo campaign stored text or meta");
    ok("a photo-only campaign is created with the file attached");

    const storedPhoto = await readFileBuffer(photoRow.media_path);
    assert(storedPhoto, "stored photo is missing");
    const photoOut = await sharp(storedPhoto).metadata();
    assert(photoOut.format === "jpeg", `stored as ${photoOut.format}`);
    assert(
      photoOut.width === 1024 && photoOut.height === 2048,
      `expected the upright photo fitted to 1024x2048, got ${photoOut.width}x${photoOut.height}`
    );
    assert(!photoOut.exif, "EXIF (with the GPS position) survived the upload");
    ok("the photo is turned upright, fitted to 2048px and stripped of its GPS position");

    await page.waitForFunction(
      () => {
        const i = document.querySelector<HTMLImageElement>('img[src$="/media"]');
        return !!i && i.complete && i.naturalWidth > 0;
      },
      undefined,
      { timeout: 20000 }
    );
    ok("the detail page shows the photo");

    await page.click('button:has-text("Start sending")');
    await waitForStatus(db, photoId, "running");
    await pumpClinic(clinic.id);
    const photoMsg = (
      await db.query(
        `select m.*, cv.last_message_preview from campaign_recipients r
           join messages m on m.id = r.message_id
           join conversations cv on cv.id = m.conversation_id
          where r.campaign_id = $1`,
        [photoId]
      )
    ).rows;
    assert(photoMsg.length === 1, `expected 1 queued photo message, got ${photoMsg.length}`);
    assert(photoMsg[0].msg_type === "image", `queued as ${photoMsg[0].msg_type}`);
    assert(photoMsg[0].media_path === photoRow.media_path, "message points at a different file");
    assert(photoMsg[0].last_message_preview === "[image]", `preview ${photoMsg[0].last_message_preview}`);
    ok("the drip queues the photo, with no text, onto the recipient's message");

    const photoContent = (await messageContent(photoMsg[0])) as { image: Buffer; caption?: string };
    assert(Buffer.isBuffer(photoContent.image) && photoContent.caption === undefined, "bad image content");
    const photoProto = await prepareWAMessageMedia(photoContent, {
      upload: async () => ({ mediaUrl: "https://mmg.whatsapp.net/qa", directPath: "/qa" }),
      logger: silent as never,
    });
    const im = photoProto.imageMessage!;
    assert(im.jpegThumbnail && im.jpegThumbnail.length > 0, "WhatsApp would get no preview for the photo");
    assert(im.width === 1024 && im.height === 2048, `photo proto is ${im.width}x${im.height}`);
    ok("Baileys builds the photo with a preview and its real dimensions");

    // ------------------------------------------- a path that is not ours
    /*
      The upload route is bypassed here and the create action handed a path
      directly, which is what a hostile client would do: another clinic's file,
      then one of this clinic's own files from outside the campaign folder.
    */
    const before = await campaignCount();
    for (const forged of [
      `00000000-0000-4000-8000-000000000000/campaign-media/abcd1234-x.jpg`,
      `${clinic.id}/patient-files/abcd1234-x.jpg`,
    ]) {
      await openDialog("Forged");
      await page.fill("textarea", "Hello");
      await page.route(`**/api/c/${slug}/campaigns/media`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ path: forged, name: "x.jpg", kind: "image" }),
        })
      );
      await page.setInputFiles(fileInput, { name: "x.jpg", mimeType: "image/jpeg", buffer: storedPhoto });
      await page.click("text=Review 3 recipients");
      await page.waitForSelector("text=That file could not be read. Try another one", { timeout: 20000 });
      await page.unroute(`**/api/c/${slug}/campaigns/media`);
    }
    assert((await campaignCount()) === before, "a campaign was created around a forged file path");
    ok("the create action refuses another clinic's file and files outside the campaign folder");

    // ---------------------------------------------------- the upload route
    const upload = (name: string, mimeType: string, buffer: Buffer, p: Page = page) =>
      p.request.post(`${BASE}/api/c/${slug}/campaigns/media`, {
        multipart: { file: { name, mimeType, buffer } },
      });
    const mov = Buffer.concat([
      Buffer.from([0, 0, 0, 0x14]),
      Buffer.from("ftypqt  ", "latin1"),
      Buffer.alloc(8),
    ]);
    let res = await upload("renamed.mp4", "video/mp4", mov);
    assert(res.status() === 415 && (await res.json()).error === "mediaType", `renamed .mov got ${res.status()}`);
    res = await upload("fake.png", "image/png", gif);
    assert(res.status() === 415, `GIF labelled PNG got ${res.status()}`);
    res = await upload("noise.jpg", "image/jpeg", Buffer.from("definitely not a picture"));
    assert(res.status() === 400 && (await res.json()).error === "badMedia", `garbage image got ${res.status()}`);
    res = await upload("big.mp4", "video/mp4", Buffer.alloc(16 * 1024 * 1024 + 1));
    assert(res.status() === 413, `oversized file got ${res.status()}`);
    ok("the upload route judges files by their bytes: renamed .mov, mislabelled GIF, garbage, oversize");

    const staffCtx = await browser.newContext();
    const staffPage = await staffCtx.newPage();
    await login(staffPage, `staff-${slug}@test.local`);
    res = await upload("clinic-photo.jpg", "image/jpeg", photo, staffPage);
    assert(res.status() === 403, `member without campaigns could upload: ${res.status()}`);
    res = await staffPage.request.get(`${BASE}/api/c/${slug}/campaigns/${photoId}/media`);
    assert(res.status() === 403, `member without campaigns could read campaign media: ${res.status()}`);
    await staffCtx.close();
    ok("uploading and reading campaign media both need the campaigns capability");

    // ----------------------------------------------------------------- video
    await page.goto(`${BASE}/c/${slug}/campaigns`);
    // A string, not a function: tsx wraps named functions in a `__name` helper
    // that does not exist inside the page.
    const recorded: string = await page.evaluate(`(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 240;
      const ctx = canvas.getContext("2d");
      let n = 0;
      function draw() {
        ctx.fillStyle = "hsl(" + ((n * 15) % 360) + " 70% 50%)";
        ctx.fillRect(0, 0, 320, 240);
        ctx.fillStyle = "#fff";
        ctx.font = "48px sans-serif";
        ctx.fillText(String(n++), 24, 140);
      }
      draw();
      const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: "video/mp4;codecs=avc1" });
      const chunks = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      const timer = setInterval(draw, 33);
      rec.start();
      await new Promise((r) => setTimeout(r, 2500));
      const stopped = new Promise((r) => (rec.onstop = r));
      rec.stop();
      await stopped;
      clearInterval(timer);
      const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    })()`);
    const video = Buffer.from(recorded, "base64");
    assert(video.subarray(4, 8).toString("latin1") === "ftyp", "the recorder did not produce an MP4");

    await openDialog("Video promo");
    await page.fill("textarea", "Watch this, {{patient.first_name}}");
    await page.setInputFiles(fileInput, { name: "promo.mp4", mimeType: "video/mp4", buffer: video });
    await page.waitForSelector('video[src^="blob:"]');
    ok("a video previews in the dialog");

    const videoId = await create();
    const videoRow = (
      await db.query(`select media_kind, media_path, media_mime, media_meta from campaigns where id = $1`, [videoId])
    ).rows[0];
    assert(videoRow.media_kind === "video" && videoRow.media_mime === "video/mp4", "video stored with wrong kind");
    assert(String(videoRow.media_path).endsWith(".mp4"), `unexpected path ${videoRow.media_path}`);
    const storedVideo = await readFileBuffer(videoRow.media_path);
    assert(storedVideo && storedVideo.equals(video), "the stored video is not the uploaded bytes");
    const meta = videoRow.media_meta as { thumb?: string; width?: number; height?: number; seconds?: number };
    assert(meta?.width === 320 && meta?.height === 240, `video measured as ${meta?.width}x${meta?.height}`);
    assert(meta.thumb, "no preview frame was taken from the video");
    const thumb = await sharp(Buffer.from(meta.thumb, "base64")).metadata();
    assert(thumb.format === "jpeg" && thumb.width === 160 && thumb.height === 120, `thumb ${thumb.width}x${thumb.height}`);
    console.log(`    (video ${video.length} bytes, measured ${meta.seconds ?? "no"} seconds)`);
    ok("the browser measures the video and takes a 160px preview frame");

    const mediaUrl = `${BASE}/api/c/${slug}/campaigns/${videoId}/media`;
    res = await page.request.get(mediaUrl);
    assert(res.status() === 200 && res.headers()["accept-ranges"] === "bytes", `full read got ${res.status()}`);
    assert(res.headers()["content-type"] === "video/mp4", `served as ${res.headers()["content-type"]}`);
    assert((await res.body()).length === video.length, "full read returned the wrong length");
    res = await page.request.get(mediaUrl, { headers: { Range: "bytes=0-1" } });
    assert(res.status() === 206, `range read got ${res.status()}`);
    assert(res.headers()["content-range"] === `bytes 0-1/${video.length}`, res.headers()["content-range"]);
    assert((await res.body()).length === 2, "range read returned the wrong length");
    res = await page.request.get(mediaUrl, { headers: { Range: `bytes=${video.length + 10}-` } });
    assert(res.status() === 416, `out-of-range read got ${res.status()}`);
    await page.waitForFunction(
      () => (document.querySelector("video")?.readyState ?? 0) >= 1,
      undefined,
      { timeout: 20000 }
    );
    ok("the detail page plays the video, served with byte ranges for Safari");

    await page.click('button:has-text("Start sending")');
    await waitForStatus(db, videoId, "running");
    await pumpClinic(clinic.id);
    const videoMsg = (
      await db.query(
        `select m.* from campaign_recipients r join messages m on m.id = r.message_id where r.campaign_id = $1`,
        [videoId]
      )
    ).rows;
    assert(videoMsg.length === 1, `expected 1 queued video message, got ${videoMsg.length}`);
    assert(videoMsg[0].msg_type === "video", `queued as ${videoMsg[0].msg_type}`);
    assert(videoMsg[0].media_path === videoRow.media_path, "message points at a different file");
    assert(JSON.stringify(videoMsg[0].media_meta) === JSON.stringify(meta), "message lost the video's meta");
    assert(String(videoMsg[0].body).startsWith("Watch this, Promo"), `caption not personalised: ${videoMsg[0].body}`);
    ok("the drip queues the video with its preview and a personalised caption");

    const videoContent = (await messageContent(videoMsg[0])) as {
      video: Buffer;
      caption?: string;
      jpegThumbnail?: string;
      width?: number;
      height?: number;
      mimetype?: string;
    };
    assert(videoContent.video.equals(video), "Baileys would be handed different bytes");
    assert(videoContent.jpegThumbnail === meta.thumb && videoContent.mimetype === "video/mp4", "bad video content");
    const videoProto = await prepareWAMessageMedia(videoContent, {
      upload: async () => ({ mediaUrl: "https://mmg.whatsapp.net/qa", directPath: "/qa" }),
      logger: silent as never,
    });
    const vm = videoProto.videoMessage!;
    assert(
      vm.jpegThumbnail && Buffer.from(vm.jpegThumbnail).equals(Buffer.from(meta.thumb, "base64")),
      "the preview frame did not reach the WhatsApp message"
    );
    assert(vm.width === 320 && vm.height === 240, `video proto is ${vm.width}x${vm.height}`);
    if (meta.seconds) assert(vm.seconds === meta.seconds, `video proto says ${vm.seconds}s, measured ${meta.seconds}`);
    assert(vm.caption === videoMsg[0].body && vm.mimetype === "video/mp4", "caption or type lost on the proto");
    ok("Baileys builds the video with the browser's frame, size and length, without ffmpeg");

    // --------------------------------------------------------------- delete
    // Somebody was queued: their message keeps pointing at the file.
    await page.reload();
    await page.click('button:has-text("Stop")');
    await page.waitForSelector("text=Stop this campaign?", { timeout: 20000 });
    await page.click('[role="dialog"] button:has-text("Stop")');
    await waitForStatus(db, videoId, "cancelled");
    await page.reload();
    await page.click('button[aria-label="Delete"]');
    await page.click('[role="dialog"] button:has-text("Delete")');
    await page.waitForURL(`**/c/${slug}/campaigns`, { timeout: 20000 });
    assert(!(await db.query(`select 1 from campaigns where id = $1`, [videoId])).rowCount, "campaign not deleted");
    assert(await readFileBuffer(videoRow.media_path), "deleting the campaign removed a file its messages still use");
    ok("deleting a campaign that reached somebody keeps the file their thread shows");

    // Nobody was queued: the file goes with it.
    await openDialog("Draft to delete");
    await page.setInputFiles(fileInput, { name: "draft.jpg", mimeType: "image/jpeg", buffer: photo });
    const draftId = await create();
    const draftPath = (await db.query(`select media_path from campaigns where id = $1`, [draftId])).rows[0]
      .media_path as string;
    assert(await readFileBuffer(draftPath), "draft file was never stored");
    await page.click('button[aria-label="Delete"]');
    await page.click('[role="dialog"] button:has-text("Delete")');
    await page.waitForURL(`**/c/${slug}/campaigns`, { timeout: 20000 });
    assert(!(await readFileBuffer(draftPath)), "a draft's file outlived the draft");
    ok("deleting a draft nobody received removes its file");

    assert(errors.length === 0, `client errors: ${errors.join(" | ")}`);
    ok("no client-side errors across the campaign media screens");

    console.log(`\n  ${passed} checks passed\n`);
  } finally {
    await browser.close();
    await cleanup();
    await db.end();
  }
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
