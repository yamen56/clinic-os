/**
 * Chats WhatsApp addresses by LID rather than by phone number.
 *
 * This is the failure that made documents, invoices and automation messages
 * appear in the thread and never arrive: the digits in a LID look like a phone
 * number, so we matched them out and rebuilt <digits>@s.whatsapp.net. Nobody is
 * at that address. The socket accepts the send and the message is gone — no
 * error, no bounce, nothing to notice.
 *
 * So the assertion that matters is not "did we send" but "what did we send it
 * to". The fake socket records the address.
 */
import { Client } from "pg";
import { DateTime } from "luxon";

const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
process.env.DATABASE_URL ||= PG;

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

const LID = "191091802390675";
const REAL = "+962790555111";

/**
 * `withLIDProtocol()` means WhatsApp answers with both addresses. The legacy
 * one is the trap: it looks right, the socket takes it, and nothing arrives.
 */
// Ids are unique across sockets: `messages.wa_message_id` is unique per clinic,
// and a repeat would fail the insert rather than the behaviour under test.
let waId = 0;
function fakeSock(sentTo: string[], lidFor: Record<string, string> = {}) {
  return {
    user: { id: "962790000000:1@s.whatsapp.net" },
    onWhatsApp: async (phone: string) => [
      {
        jid: `${phone.replace("+", "")}@s.whatsapp.net`,
        exists: phone.startsWith("+962"),
        lid: lidFor[phone] ?? undefined,
      },
    ],
    sendMessage: async (jid: string) => {
      sentTo.push(jid);
      return { key: { id: `LIDQA${++waId}`, fromMe: true } };
    },
  };
}

async function main() {
  const { recordMessage } = await import("../worker/wa/inbound");
  const { learnLidMapping } = await import("../worker/wa/lid-mapping");
  const { withinWindow } = await import("../worker/automations");
  /* ------------------------------------- resolving where a message should go */
  const { resolveSendAddress } = await import("../worker/wa/resolve-address");
  const PN = "+962790111222";

  // Baileys 7: the mapping store answers, and its answer wins.
  const withMapper = {
    signalRepository: { lidMapping: { getLIDForPN: async () => "99887766554433@lid" } },
    onWhatsApp: async () => [{ jid: `962790111222@s.whatsapp.net`, exists: true }],
  };
  let a = await resolveSendAddress(withMapper, PN);
  check("the mapping store's LID is preferred over the phone address", a.jid === "99887766554433@lid", a.jid ?? "");
  check("and the bare LID comes back with it", a.lid === "99887766554433", a.lid ?? "");

  // Baileys 6.7: no mapping store, but onWhatsApp may still offer a LID.
  a = await resolveSendAddress(
    { onWhatsApp: async () => [{ jid: `962790111222@s.whatsapp.net`, exists: true, lid: "1122334455@lid" }] },
    PN
  );
  check("a LID from onWhatsApp is used when there is no mapper", a.jid === "1122334455@lid", a.jid ?? "");

  // A number still on legacy addressing has to keep working.
  a = await resolveSendAddress(
    { onWhatsApp: async () => [{ jid: `962790111222@s.whatsapp.net`, exists: true }] },
    PN
  );
  check("no LID anywhere falls back to the phone address", a.jid === "962790111222@s.whatsapp.net", a.jid ?? "");
  check("and is still marked reachable", a.exists === true);

  // WhatsApp saying no, versus WhatsApp saying nothing.
  a = await resolveSendAddress({ onWhatsApp: async () => [{ jid: "x", exists: false }] }, PN);
  check("a real 'no account' is reported as such", a.exists === false && a.jid === null);
  a = await resolveSendAddress({ onWhatsApp: async () => [] }, PN);
  check("silence is not a verdict", a.exists === null, String(a.exists));

  // A mapper that throws must not become a verdict either.
  a = await resolveSendAddress(
    {
      signalRepository: { lidMapping: { getLIDForPN: async () => { throw new Error("boom"); } } },
      onWhatsApp: async () => [{ jid: `962790111222@s.whatsapp.net`, exists: true }],
    },
    PN
  );
  check("a failing resolver falls through rather than giving up", a.jid === "962790111222@s.whatsapp.net", a.jid ?? "");

  /* ------------------------------------------ the window, before anything else */
  const tz = "Asia/Amman";
  const at = (h: number, m = 0) =>
    DateTime.fromObject({ year: 2026, month: 8, day: 3, hour: h, minute: m }, { zone: tz });

  // A clinic open noon to midnight. 00:00 read literally is *before* noon, which
  // collapsed the window to nothing and pushed every message a day late.
  check(
    "a message inside a window closing at midnight goes now",
    withinWindow(at(14), tz, "12:00", "00:00").toISO() === at(14).toISO(),
    withinWindow(at(14), tz, "12:00", "00:00").toISO() ?? ""
  );
  check(
    "late in that window it still goes now",
    withinWindow(at(23, 30), tz, "12:00", "00:00").toISO() === at(23, 30).toISO()
  );
  check(
    "before it opens it waits for today's opening, not tomorrow's",
    withinWindow(at(8, 56), tz, "12:00", "00:00").toISO() === at(12).toISO(),
    withinWindow(at(8, 56), tz, "12:00", "00:00").toISO() ?? ""
  );
  check(
    "a window that runs past midnight also holds",
    withinWindow(at(1), tz, "20:00", "02:00").toISO() === at(1).toISO()
  );
  check(
    "and an ordinary window is unchanged",
    withinWindow(at(22), tz, "09:00", "21:00").toISO() === at(9).plus({ days: 1 }).toISO(),
    withinWindow(at(22), tz, "09:00", "21:00").toISO() ?? ""
  );

  /* ------------------------------------------------------------ the LID chat */
  const db = new Client({ connectionString: PG });
  await db.connect();
  const slug = `qalid-test${Date.now().toString(36)}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, timezone, message_window_start, message_window_end)
       values ('QA LID','معرف',$1,'Asia/Amman','00:00','23:59') returning id`,
      [slug]
    )
  ).rows[0];
  await db.query(
    `insert into whatsapp_sessions (clinic_id, status, desired) values ($1,'connected',false)`,
    [clinic.id]
  );
  console.log(`✓ fixture clinic ${slug}`);

  // A patient writes in, and WhatsApp addresses the chat by LID.
  await recordMessage(clinic.id, {
    phone: `+${LID}`,
    jid: `${LID}@lid`,
    lid: LID,
    dialable: false,
    fromMe: false,
    waId: "INBOUND1",
    msgType: "text",
    body: "بدي أحجز موعد",
    mediaPath: null,
    mediaMime: null,
    mediaName: null,
    pushName: "Raed",
  });

  const conv = (
    await db.query(
      `select id, phone_e164, wa_jid, wa_lid, identifier_kind, whatsapp_name, patient_id
         from conversations where clinic_id = $1`,
      [clinic.id]
    )
  ).rows[0];
  check("a LID chat is threaded", !!conv);
  check("the address is kept exactly as WhatsApp sent it", conv.wa_jid === `${LID}@lid`, conv.wa_jid);
  check("and is not rewritten into a phone address", !String(conv.wa_jid).includes("s.whatsapp.net"));
  check("the thread knows it is not holding a real number", conv.identifier_kind === "lid");
  check("the sender still has a name", conv.whatsapp_name === "Raed");
  check("and no patient file was invented", conv.patient_id === null);

  /* ------------------------- the reply must go back to where it came from */
  const { queueWhatsAppMessage } = await import("../src/lib/outbound");
  const { withSystem } = await import("../worker/db");
  const { sessions } = await import("../worker/wa/session");
  const { processOnce } = await import("../worker/outbound");

  const sentTo: string[] = [];
  sessions.set(clinic.id, {
    clinicId: clinic.id,
    sock: fakeSock(sentTo),
    connected: true,
  } as never);

  let msgId = "";
  await withSystem(async (c) => {
    msgId = (
      await queueWhatsAppMessage(c, {
        clinicId: clinic.id,
        phoneE164: conv.phone_e164,
        body: "تفضل رابط التوقيع",
        senderKind: "staff",
      })
    ).messageId;
  });
  await processOnce();

  const sent = (await db.query(`select status, error from messages where id = $1`, [msgId])).rows[0];
  check("the reply is sent, not written off as unreachable", sent.status === "sent", `${sent.status}/${sent.error}`);
  check("and it goes to the LID address", sentTo[0] === `${LID}@lid`, sentTo[0] ?? "nothing sent");

  /*
    A LID chat carrying a stale verdict from when we treated it as a number.
    Every clinic that ran the old code has these, and the flag must not be
    allowed to keep throwing away messages that would arrive.
  */
  await db.query(
    `update conversations set on_whatsapp = false, wa_checked_at = now() where id = $1`,
    [conv.id]
  );
  let msg2 = "";
  await withSystem(async (c) => {
    msg2 = (
      await queueWhatsAppMessage(c, {
        clinicId: clinic.id,
        phoneE164: conv.phone_e164,
        body: "فاتورتك جاهزة",
        senderKind: "staff",
      })
    ).messageId;
  });
  await new Promise((r) => setTimeout(r, 10500)); // the per-clinic send pacing
  await processOnce();
  const second = (await db.query(`select status, error from messages where id = $1`, [msg2])).rows[0];
  check(
    "a stale 'no account' verdict cannot silence a LID chat",
    second.status === "sent",
    `${second.status}/${second.error}`
  );
  check("and that message reached the LID too", sentTo[1] === `${LID}@lid`, sentTo[1] ?? "nothing sent");

  /* --------------------------------- and the number is adopted once offered */
  await learnLidMapping(clinic.id, [{ lid: `${LID}@lid`, jid: `${REAL.replace("+", "")}@s.whatsapp.net` }]);
  const after = (
    await db.query(`select phone_e164, identifier_kind, wa_lid, wa_jid from conversations where id = $1`, [
      conv.id,
    ])
  ).rows[0];
  check("the thread takes the real number when WhatsApp shares it", after.phone_e164 === REAL, after.phone_e164);
  check("and stops calling itself a LID", after.identifier_kind === "phone");
  check("while keeping the address that works", after.wa_jid === `${LID}@lid`, after.wa_jid);

  /*
    A number the clinic writes to first, which has never written to them: there
    is no LID to copy from an inbound message, so the address has to come from
    the lookup. WhatsApp answers with both, and taking the legacy one is what
    made every message to a new number disappear.
  */
  const COLD = "+962790123456";
  const COLD_LID = "55512345678901";
  const sent2: string[] = [];
  sessions.set(clinic.id, {
    clinicId: clinic.id,
    sock: fakeSock(sent2, { [COLD]: COLD_LID }),
    connected: true,
  } as never);

  let coldId = "";
  await withSystem(async (c) => {
    coldId = (
      await queueWhatsAppMessage(c, {
        clinicId: clinic.id,
        phoneE164: COLD,
        body: "أهلاً، هذا موعدك",
        senderKind: "staff",
      })
    ).messageId;
  });
  await new Promise((r) => setTimeout(r, 10500));
  await processOnce();

  const coldMsg = (await db.query(`select status from messages where id = $1`, [coldId])).rows[0];
  check("a message to a number that never wrote is sent", coldMsg.status === "sent", coldMsg.status);
  check(
    "and it goes to the LID WhatsApp gave us, not the phone address",
    sent2[0] === `${COLD_LID}@lid`,
    sent2[0] ?? "nothing sent"
  );
  const coldConv = (
    await db.query(
      `select wa_jid, wa_lid, identifier_kind from conversations where clinic_id = $1 and phone_e164 = $2`,
      [clinic.id, COLD]
    )
  ).rows[0];
  check("the resolved address is remembered", coldConv.wa_jid === `${COLD_LID}@lid`, coldConv.wa_jid);
  check("along with the LID itself", coldConv.wa_lid === COLD_LID, coldConv.wa_lid);
  check(
    "and the thread still knows it holds a real phone number",
    coldConv.identifier_kind === "phone",
    coldConv.identifier_kind
  );

  // A number still on legacy addressing has no LID, and must still be reachable.
  const LEGACY = "+962790654321";
  const sent3: string[] = [];
  sessions.set(clinic.id, { clinicId: clinic.id, sock: fakeSock(sent3), connected: true } as never);
  let legacyId = "";
  await withSystem(async (c) => {
    legacyId = (
      await queueWhatsAppMessage(c, {
        clinicId: clinic.id,
        phoneE164: LEGACY,
        body: "مرحبا",
        senderKind: "staff",
      })
    ).messageId;
  });
  await new Promise((r) => setTimeout(r, 10500));
  await processOnce();
  const legacyMsg = (await db.query(`select status from messages where id = $1`, [legacyId])).rows[0];
  check("a number with no LID still gets the phone address", legacyMsg.status === "sent", legacyMsg.status);
  check(
    "which is the legacy one",
    sent3[0] === `${LEGACY.replace("+", "")}@s.whatsapp.net`,
    sent3[0] ?? "nothing sent"
  );

  /*
    The thread the patient started arrives holding an identity, not a number.
    Asking the library for the number behind it is what puts a real, dialable
    phone on the patient file instead of a fifteen-digit thing or a blank.
  */
  const { resolvePendingLids } = await import("../worker/wa/lid-mapping");
  const PENDING_LID = "600100200300400";
  const PENDING_PN = "+962791234567";
  await db.query(
    `insert into conversations (clinic_id, phone_e164, wa_jid, wa_lid, identifier_kind, whatsapp_name)
     values ($1, $2, $3, $4, 'lid', 'Nadia')`,
    [clinic.id, `+${PENDING_LID}`, `${PENDING_LID}@lid`, PENDING_LID]
  );
  const batchSock = {
    signalRepository: {
      lidMapping: {
        getPNsForLIDs: async (lids: string[]) =>
          lids
            .filter((l) => l.startsWith(PENDING_LID))
            .map((l) => ({ lid: l, pn: `${PENDING_PN.replace("+", "")}@s.whatsapp.net` })),
      },
    },
  };
  await resolvePendingLids(clinic.id, batchSock);
  const resolved = (
    await db.query(`select phone_e164, identifier_kind, wa_jid from conversations where wa_lid = $1`, [
      PENDING_LID,
    ])
  ).rows[0];
  check(
    "an identity thread is given its real number",
    resolved.phone_e164 === PENDING_PN,
    resolved.phone_e164
  );
  check("and stops standing in for one", resolved.identifier_kind === "phone");
  check(
    "while still addressed the way that reaches them",
    resolved.wa_jid === `${PENDING_LID}@lid`,
    resolved.wa_jid
  );

  // An old library has no resolver, and the sweep must simply do nothing.
  check(
    "a library without the resolver is not an error",
    (await resolvePendingLids(clinic.id, {})) === 0
  );

  // A number that already has its own thread must not be merged behind our back.
  const other = (
    await db.query(
      `insert into conversations (clinic_id, phone_e164, wa_lid, identifier_kind)
       values ($1,'+962790777222','888777666','lid') returning id`,
      [clinic.id]
    )
  ).rows[0];
  await learnLidMapping(clinic.id, [{ lid: "888777666", jid: `${REAL.replace("+", "")}@s.whatsapp.net` }]);
  const untouched = (await db.query(`select phone_e164 from conversations where id = $1`, [other.id])).rows[0];
  check(
    "a clashing number is left for a human rather than merged",
    untouched.phone_e164 === "+962790777222",
    untouched.phone_e164
  );

  /* ------------------------------------------------- and on the screen */
  /*
    Everything above proves the *data* is right, which is exactly why the
    screen was wrong for so long: `conversations.phone_e164` holds the LID for
    an identity thread, and the inbox header rendered it through formatPhone
    like any other number. Fifteen digits with a plus in front, sitting under
    the person's name, read as their phone — and got copied onto patient files
    and dialled.
  */
  const { chromium } = await import("playwright");
  const bcrypt = (await import("bcryptjs")).default;
  const BASE = process.env.APP_URL || "http://localhost:3000";

  const uiSlug = (await db.query(`select slug from clinics where id = $1`, [clinic.id])).rows[0].slug;
  const owner = (
    await db.query(
      `insert into users (email, password_hash, full_name, locale) values ($1,$2,'LID QA','en') returning id`,
      [`lidui-${uiSlug}@test.local`, bcrypt.hashSync("password123", 10)]
    )
  ).rows[0];
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1,$2,'receptionist',true,'{"level":"full"}')`,
    [clinic.id, owner.id]
  );
  const standIn = "+177176108388417";
  await db.query(
    `insert into conversations (clinic_id, phone_e164, wa_lid, identifier_kind, whatsapp_name,
                                last_message_at, last_message_preview)
     values ($1,$2,$3,'lid','Screen Test', now(), 'hello')`,
    [clinic.id, standIn, standIn.slice(1)]
  );

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`${BASE}/login`);
    await page.waitForLoadState("networkidle");
    await page.fill('input[name="email"]', `lidui-${uiSlug}@test.local`);
    await page.fill('input[name="password"]', "password123");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120_000 });

    await page.goto(`${BASE}/c/${uiSlug}/conversations`);
    await page.waitForLoadState("networkidle");
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
    await page.getByText("Screen Test").first().click({ timeout: 30_000 });
    /*
      Prove the thread is open before asserting what it does not contain. Every
      check below is a negative, and a negative passes beautifully against a
      page that never rendered — which would be a test that guards nothing.
    */
    const opened = page.getByText(/WhatsApp has not shared their number|واتساب لم يشارك رقمهم/);
    await opened.first().waitFor({ state: "visible", timeout: 30_000 });
    check("the thread opens and says why there is no number", true, "");

    const shown = await page.locator("body").innerText();
    const digits = standIn.slice(1);
    check(
      "an identity thread never shows its LID as a phone number",
      !shown.includes(digits) && !shown.includes("+" + digits),
      shown.includes(digits) ? "the LID is on screen" : ""
    );
    // Formatted as well as raw: formatPhone would have grouped it.
    check(
      "not even prettified into one",
      !/177\s?176\s?108\s?388\s?417/.test(shown.replace(/‎|‏/g, "")),
      ""
    );
  } finally {
    await browser.close();
  }

  sessions.delete(clinic.id);
  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  await db.query(`delete from users where id = $1`, [owner.id]);
  await db.end();
  const { pool } = await import("../worker/db");
  await pool.end();

  console.log(`\n  whatsapp LID: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
