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
function fakeSock(opts: { registered: Set<string>; silent?: Set<string>; onSend?: () => void }) {
  let n = 0;
  return {
    user: { id: "962790000000:1@s.whatsapp.net", name: "QA" },
    onWhatsApp: async (phone: string) => {
      const bare = phone.replace("+", "");
      // WhatsApp declining to answer, which is not the same as saying "no".
      if (opts.silent?.has(bare)) return [];
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
    `insert into whatsapp_sessions (clinic_id, status, desired) values ($1,'connected',false)`,
    [clinic.id]
  );
  console.log(`✓ fixture clinic ${slug}`);

  const good = "+962790111000"; // on WhatsApp
  const bad = "+962790222000"; // a landline someone typed into the patient file
  const quiet = "+962790333000"; // real, but WhatsApp declines to answer about it
  const registered = new Set([good.replace("+", "")]);
  const silent = new Set([quiet.replace("+", "")]);

  const { queueWhatsAppMessage } = await import("../src/lib/outbound");
  const { withSystem } = await import("../worker/db");
  const { sessions } = await import("../worker/wa/session");

  // Slot the fake socket into the registry the sender reads from.
  sessions.set(clinic.id, {
    clinicId: clinic.id,
    sock: fakeSock({ registered, silent }),
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

  /*
    WhatsApp declining to answer is not a verdict. Reading an empty result as
    "no such account" would write off a working number for good, losing every
    later message to it — the same silent loss the check exists to prevent.
  */
  let quietId = "";
  await withSystem(async (c) => {
    quietId = (
      await queueWhatsAppMessage(c, {
        clinicId: clinic.id,
        phoneE164: quiet,
        body: "تذكير بموعدك",
        senderKind: "staff",
      })
    ).messageId;
  });
  await new Promise((r) => setTimeout(r, 10500));
  await processOnce();
  const q1 = (await db.query(`select status, error from messages where id = $1`, [quietId])).rows[0];
  check(
    "no answer from WhatsApp means send anyway, not give up",
    q1.status === "sent",
    `${q1.status}/${q1.error}`
  );
  const qConv = (
    await db.query(`select on_whatsapp from conversations where clinic_id = $1 and phone_e164 = $2`, [
      clinic.id,
      quiet,
    ])
  ).rows[0];
  check("and nothing is recorded about a number we were told nothing about", qConv.on_whatsapp === null);

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
    stats.total === 3 && stats.delivered === 1 && stats.no_account === 1,
    JSON.stringify(stats)
  );

  /*
    The watchdog. A message that errors is visible; one the socket accepts and
    never delivers is not, and that is the shape of every silent-loss bug this
    system has had. A run of sends with no acknowledgement between them has to
    reach somebody.
  */
  const { deliveryWatch } = await import("../worker/delivery-watch");
  const owner = (
    await db.query(
      `insert into users (email, password_hash, full_name) values ($1,'x','Watch Owner') returning id`,
      [`watch-${slug}@test.local`]
    )
  ).rows[0];
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1,$2,'receptionist',true,'{"level":"full"}')`,
    [clinic.id, owner.id]
  );

  const conv = (
    await db.query(`select id from conversations where clinic_id = $1 limit 1`, [clinic.id])
  ).rows[0];
  const seed = async (n: number, ageHours: number, delivered: boolean) => {
    for (let i = 0; i < n; i++) {
      await db.query(
        `insert into messages (clinic_id, conversation_id, direction, sender_kind, msg_type, body,
                               status, created_at, sent_at, delivered_at)
         values ($1,$2,'out','automation','text','تذكير', $3,
                 now() - ($4 || ' hours')::interval, now() - ($4 || ' hours')::interval, $5)`,
        [
          clinic.id,
          conv.id,
          delivered ? "delivered" : "sent",
          String(ageHours),
          delivered ? new Date() : null,
        ]
      );
    }
  };

  // Recent silence is ordinary: a phone can simply be off.
  await seed(8, 1, false);
  await deliveryWatch();
  let notes = await db.query(
    `select count(*)::int n from notifications where clinic_id = $1 and kind = 'whatsapp_undelivered'`,
    [clinic.id]
  );
  check("a fresh message with no receipt yet is not an alarm", notes.rows[0].n === 0);

  // Hours of it, with nothing acknowledged, is the send path being broken.
  await seed(8, 6, false);
  await deliveryWatch();
  notes = await db.query(
    `select count(*)::int n from notifications where clinic_id = $1 and kind = 'whatsapp_undelivered'`,
    [clinic.id]
  );
  // One per recipient — the clinic owner, and the agency, who can act on it.
  const raised = notes.rows[0].n as number;
  check("hours of unacknowledged sends raises the alarm", raised > 0, `${raised} notified`);

  // It is a standing condition, not an event — repeating it teaches people to ignore it.
  await deliveryWatch();
  notes = await db.query(
    `select count(*)::int n from notifications where clinic_id = $1 and kind = 'whatsapp_undelivered'`,
    [clinic.id]
  );
  check("and does not repeat it every minute", notes.rows[0].n === raised, `${notes.rows[0].n}`);

  // One acknowledgement anywhere in the run means the path works.
  await db.query(`delete from notifications where clinic_id = $1`, [clinic.id]);
  await seed(1, 5, true);
  await deliveryWatch();
  notes = await db.query(
    `select count(*)::int n from notifications where clinic_id = $1 and kind = 'whatsapp_undelivered'`,
    [clinic.id]
  );
  check("one delivered message clears the alarm", notes.rows[0].n === 0, `${notes.rows[0].n}`);

  sessions.delete(clinic.id);
  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  await db.query(`delete from users where id = $1`, [owner.id]);
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
