/**
 * Outbound WhatsApp: does it send, and do we learn whether it arrived?
 *
 * The socket is faked. That is the point — Baileys accepts a message for a
 * number that has no WhatsApp account without complaint, so the interesting
 * behaviour is entirely on our side: the pre-flight check, the retry ladder,
 * and the receipts that arrive minutes after the send already returned.
 */
import { Client } from "pg";
import { handleReceipts } from "../worker/wa/receipts";

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

/** Shaped like the slice of a Baileys socket the sender actually touches. */
function fakeSock(opts: { registered: Set<string>; onSend?: () => void }) {
  let n = 0;
  return {
    user: { id: "962790000000:1@s.whatsapp.net", name: "QA" },
    onWhatsApp: async (phone: string) => {
      const bare = phone.replace("+", "");
      return opts.registered.has(bare)
        ? [{ jid: `${bare}@s.whatsapp.net`, exists: true }]
        : [{ jid: `${bare}@s.whatsapp.net`, exists: false }];
    },
    sendMessage: async () => {
      opts.onSend?.();
      return { key: { id: `QAWAID${++n}`, fromMe: true } };
    },
  };
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  const slug = `qawa-test${Date.now().toString(36)}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, timezone, daily_outbound_cap)
       values ('QA WA','واتساب',$1,'Asia/Amman',200) returning id`,
      [slug]
    )
  ).rows[0];
  await db.query(
    `insert into whatsapp_sessions (clinic_id, status, desired) values ($1,'connected',true)`,
    [clinic.id]
  );
  console.log(`✓ fixture clinic ${slug}`);

  const good = "+962790111000"; // on WhatsApp
  const bad = "+962790222000"; // a landline someone typed into the patient file
  const registered = new Set([good.replace("+", "")]);

  const { queueWhatsAppMessage } = await import("../src/lib/outbound");
  const { withSystem } = await import("../worker/db");
  const { sessions } = await import("../worker/wa/session");

  // Slot the fake socket into the registry the sender reads from.
  sessions.set(clinic.id, {
    clinicId: clinic.id,
    sock: fakeSock({ registered }),
    connected: true,
  } as never);

  let queuedGood = "";
  let queuedBad = "";
  await withSystem(async (c) => {
    queuedGood = (
      await queueWhatsAppMessage(c, {
        clinicId: clinic.id,
        phoneE164: good,
        body: "موعدك غداً الساعة ٣",
        senderKind: "staff",
      })
    ).messageId;
    queuedBad = (
      await queueWhatsAppMessage(c, {
        clinicId: clinic.id,
        phoneE164: bad,
        body: "موعدك غداً الساعة ٤",
        senderKind: "staff",
      })
    ).messageId;
  });
  check("messages queue", !!queuedGood && !!queuedBad);

  /* ------------------------------------------------------- the send itself */
  const { processOnce } = await import("../worker/outbound");

  // One message per pass — the sender deliberately paces itself per clinic.
  await processOnce();
  const afterFirst = (
    await db.query(`select id, status, wa_message_id, error from messages where clinic_id = $1 order by created_at`, [
      clinic.id,
    ])
  ).rows;
  const g1 = afterFirst.find((r) => r.id === queuedGood)!;
  check("a message to a real WhatsApp number is sent", g1.status === "sent", g1.status);
  check("and carries the id WhatsApp gave it", !!g1.wa_message_id, g1.wa_message_id ?? "none");

  const jidRow = (
    await db.query(`select on_whatsapp, wa_jid, wa_checked_at from conversations where clinic_id = $1 and phone_e164 = $2`, [
      clinic.id,
      good,
    ])
  ).rows[0];
  check("the number is remembered as reachable", jidRow.on_whatsapp === true && !!jidRow.wa_checked_at);

  /* ------------------ a number with no WhatsApp must not look like a success */
  // Clear the per-clinic pacing so the second message goes this tick.
  await new Promise((r) => setTimeout(r, 10500));
  await processOnce();
  const b1 = (await db.query(`select status, error, attempts from messages where id = $1`, [queuedBad])).rows[0];
  check(
    "a number with no WhatsApp fails immediately, not silently",
    b1.status === "failed" && b1.error === "no_whatsapp_account",
    `${b1.status}/${b1.error}`
  );
  check("and is not retried three times first", b1.attempts === 1, `${b1.attempts}`);
  const badConv = (
    await db.query(`select on_whatsapp from conversations where clinic_id = $1 and phone_e164 = $2`, [clinic.id, bad])
  ).rows[0];
  check("the unreachable number is remembered too", badConv.on_whatsapp === false);

  const errs = (
    await db.query(`select consecutive_errors from whatsapp_sessions where clinic_id = $1`, [clinic.id])
  ).rows[0];
  check(
    "an unreachable number does not count against the session",
    errs.consecutive_errors === 0,
    `${errs.consecutive_errors}`
  );

  /* --------------------------------------------------------- the receipts */
  const waId = g1.wa_message_id as string;
  const receipt = (code: number) =>
    handleReceipts(clinic.id, [{ key: { id: waId, fromMe: true }, update: { status: code } }] as never);
  const statusOf = async () =>
    (await db.query(`select status, delivered_at, read_at from messages where id = $1`, [queuedGood])).rows[0];

  await receipt(3); // DELIVERY_ACK
  let s = await statusOf();
  check("a delivery receipt marks the message delivered", s.status === "delivered" && !!s.delivered_at, s.status);

  await receipt(4); // READ
  s = await statusOf();
  check("a read receipt marks it read", s.status === "read" && !!s.read_at, s.status);

  // Receipts arrive out of order; a late 'delivered' must not un-read it.
  const readAtBefore = s.read_at;
  await receipt(3);
  s = await statusOf();
  check(
    "a late receipt cannot walk the status backwards",
    s.status === "read" && String(s.read_at) === String(readAtBefore),
    s.status
  );

  // A receipt for someone else's message id must not touch ours.
  await handleReceipts(clinic.id, [
    { key: { id: "SOMEONEELSE", fromMe: true }, update: { status: 4 } },
  ] as never);
  const stray = (await db.query(`select count(*)::int n from messages where clinic_id = $1 and status = 'read'`, [clinic.id]))
    .rows[0];
  check("an unknown message id changes nothing", stray.n === 1, `${stray.n}`);

  /* ------------------------------------------ what the settings page reports */
  const stats = (
    await db.query(
      `select count(*)::int as total,
              count(*) filter (where status in ('delivered','read'))::int as delivered,
              count(*) filter (where status = 'failed' and error = 'no_whatsapp_account')::int as no_account
         from messages where clinic_id = $1 and direction = 'out'
           and created_at > now() - interval '7 days'`,
      [clinic.id]
    )
  ).rows[0];
  check(
    "the delivery summary adds up",
    stats.total === 2 && stats.delivered === 1 && stats.no_account === 1,
    JSON.stringify(stats)
  );

  sessions.delete(clinic.id);
  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  await db.end();
  const { pool } = await import("../worker/db");
  await pool.end();

  console.log(`\n  whatsapp delivery: ${passed} passed, ${failures.length} failed`);
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
