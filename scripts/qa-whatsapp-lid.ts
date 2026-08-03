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
import { recordMessage } from "../worker/wa/inbound";
import { learnLidMapping } from "../worker/wa/lid-mapping";
import { withinWindow } from "../worker/automations";
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

function fakeSock(sentTo: string[]) {
  let n = 0;
  return {
    user: { id: "962790000000:1@s.whatsapp.net" },
    onWhatsApp: async (phone: string) => [
      { jid: `${phone.replace("+", "")}@s.whatsapp.net`, exists: phone.startsWith("+962") },
    ],
    sendMessage: async (jid: string) => {
      sentTo.push(jid);
      return { key: { id: `LIDQA${++n}`, fromMe: true } };
    },
  };
}

async function main() {
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
    `insert into whatsapp_sessions (clinic_id, status, desired) values ($1,'connected',true)`,
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

  sessions.delete(clinic.id);
  await db.query(`delete from clinics where id = $1`, [clinic.id]);
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
