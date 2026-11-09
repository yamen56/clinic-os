/**
 * Outbound WhatsApp: does it send, and do we learn whether it arrived?
 *
 * The socket is faked. That is the point — Baileys accepts a message for a
 * number that has no WhatsApp account without complaint, so the interesting
 * behaviour is entirely on our side: the pre-flight check, the retry ladder,
 * and the receipts that arrive minutes after the send already returned.
 */
import { Client } from "pg";


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

let waIds = 0;

/**
 * Shaped like the slice of a Baileys socket the sender actually touches, and
 * answering exactly as Baileys 7 does (node_modules/@whiskeysockets/baileys/
 * lib/Socket/socket.js, onWhatsApp): the result is filtered to registered
 * contacts, so a number with no account comes back as [] — never as
 * `exists: false` — and undefined means the query itself failed.
 *
 * This fake used to return `exists: false` for an unregistered number, which
 * the library never does. That is why the sender could read the real answer,
 * [], as "no verdict" and send to nowhere while this suite stayed green.
 */
function fakeSock(opts: {
  registered: Set<string>;
  silent?: Set<string>;
  onSend?: () => void;
  onLookup?: () => void;
  failWith?: () => string | null;
}) {
  return {
    user: { id: "962790000000:1@s.whatsapp.net", name: "QA" },
    onWhatsApp: async (phone: string) => {
      opts.onLookup?.();
      const bare = phone.replace("+", "");
      // The query not coming back as a result, which is not the same as saying "no".
      if (opts.silent?.has(bare)) return undefined;
      return opts.registered.has(bare) ? [{ jid: `${bare}@s.whatsapp.net`, exists: true }] : [];
    },
    sendMessage: async (_jid: string, content: Record<string, unknown>) => {
      opts.onSend?.();
      const err = opts.failWith?.();
      if (err) throw new Error(err);
      // What Baileys hands back: the key, and the message as it went out.
      const message =
        "image" in content
          ? { imageMessage: { caption: String(content.caption ?? ""), mimetype: "image/png", mediaKey: Buffer.alloc(32, 7), url: "https://mmg.whatsapp.net/qa" } }
          : { conversation: String(content.text ?? "") };
      return { key: { id: `QAWAID${++waIds}`, fromMe: true }, message };
    },
  };
}

async function main() {
  const { handleReceipts } = await import("../worker/wa/receipts");
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
    A lookup that failed outright is not a verdict. Reading it as "no such
    account" would write off a working number, losing every later message to
    it — the same silent loss the check exists to prevent.
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
    "a lookup that failed means send anyway, not give up",
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

  /*
    Every message arrives or says why not (lib/wa-delivery, migration 0104).

    Each scenario gets its own clinic: the sender paces itself per clinic, so a
    fresh one sends on the first pass instead of ten seconds later.
  */
  console.log("\n  — every message arrives or says why —");
  const { deliveryNote, deliveryText } = await import("../src/lib/wa-delivery");
  const { en } = await import("../src/lib/i18n/en");
  const { retryContent, WASession } = await import("../worker/wa/session");
  const { saveFile, deleteFile } = await import("../src/lib/storage");
  const { resendMessage } = await import("../src/lib/wa-resend");

  const extra: string[] = [];
  const fixture = async (name: string, sock: ReturnType<typeof fakeSock>, cap = 200) => {
    const id = (
      await db.query(
        `insert into clinics (name, name_ar, slug, timezone, daily_outbound_cap)
         values ($1,'واتساب',$2,'Asia/Amman',$3) returning id`,
        [`QA ${name}`, `qawa-${name}-${Date.now().toString(36)}`, cap]
      )
    ).rows[0].id as string;
    await db.query(`insert into whatsapp_sessions (clinic_id, status, desired) values ($1,'connected',false)`, [id]);
    sessions.set(id, { clinicId: id, sock, connected: true } as never);
    extra.push(id);
    return id;
  };
  type QueueExtra = Partial<Parameters<typeof queueWhatsAppMessage>[1]>;
  const queue = (clinicId: string, phone: string, body: string, more: QueueExtra = {}) =>
    withSystem(async (c) =>
      (await queueWhatsAppMessage(c, { clinicId, phoneE164: phone, body, senderKind: "staff", ...more })).messageId
    );
  const row = async (id: string) => (await db.query(`select * from messages where id = $1`, [id])).rows[0];

  /* WhatsApp refusing a message. Baileys reports it as status ERROR (0) with the server's code. */
  const idA = await fixture("refused", fakeSock({ registered }));
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1,$2,'receptionist',true,'{"level":"full"}')`,
    [idA, owner.id]
  );
  const mA = await queue(idA, good, "تذكير بالموعد");
  await processOnce();
  let a = await row(mA);
  check("(refusal) the message goes out first", a.status === "sent" && !!a.wa_message_id, a.status);
  // An update with no status at all — an edit, a reaction — is not an error.
  await handleReceipts(idA, [{ key: { id: a.wa_message_id, fromMe: true }, update: { status: null } }] as never);
  a = await row(mA);
  check("an update carrying status null does not fail a message", a.status === "sent", a.status);
  await handleReceipts(idA, [
    { key: { id: a.wa_message_id, fromMe: true, remoteJid: "1234@lid" }, update: { status: 0, messageStubParameters: ["463"] } },
  ] as never);
  a = await row(mA);
  check(
    "a message WhatsApp refuses is failed with WhatsApp's own code",
    a.status === "failed" && a.error === "wa_rejected:463",
    `${a.status}/${a.error}`
  );
  const nA = deliveryNote(a, { connected: true });
  check(
    "and reads as the clinic's number being restricted",
    nA?.kind === "failed" && nA.reason === "restricted",
    JSON.stringify(nA)
  );
  const told = (
    await db.query(`select count(*)::int n from notifications where clinic_id = $1 and kind = 'whatsapp_restricted'`, [idA])
  ).rows[0].n as number;
  check("a 463 tells the owner the number cannot start new chats", told >= 1, `${told}`);
  await handleReceipts(idA, [{ key: { id: a.wa_message_id, fromMe: true }, update: { status: 3 } }] as never);
  a = await row(mA);
  check(
    "a delivery receipt after a refusal means it arrived after all",
    a.status === "delivered" && a.error === null,
    `${a.status}/${a.error}`
  );

  /* The connection dropping mid-send says nothing about the message. */
  let dropOnce = true;
  const idB = await fixture("dropped", fakeSock({ registered, failWith: () => (dropOnce ? ((dropOnce = false), "Connection Closed") : null) }));
  const mB = await queue(idB, good, "رسالة أثناء الانقطاع");
  await processOnce();
  const b = await row(mB);
  check(
    "a dropped connection puts the message back with the reason",
    b.status === "queued" && b.error === "connection_lost" && b.attempts === 1,
    `${b.status}/${b.error}/${b.attempts}`
  );
  const bErrs = (await db.query(`select consecutive_errors from whatsapp_sessions where clinic_id = $1`, [idB])).rows[0]
    .consecutive_errors as number;
  check("and does not count towards pausing the clinic", bErrs === 0, `${bErrs}`);
  check("the inbox says it is being tried again", deliveryNote(b, { connected: true })?.kind === "waiting");

  const idB2 = await fixture("flapping", fakeSock({ registered, failWith: () => "Timed Out" }));
  const mB2 = await queue(idB2, good, "رسالة رابعة");
  await db.query(`update messages set attempts = 3 where id = $1`, [mB2]);
  await processOnce();
  const b2 = await row(mB2);
  check(
    "a connection drop on the fourth try is still not the end of the message",
    b2.status === "queued" && b2.attempts === 4,
    `${b2.status}/${b2.attempts}`
  );

  /* A missing attachment will be missing next time too. */
  const idC = await fixture("nofile", fakeSock({ registered }));
  const mC = await queue(idC, good, "", {
    msgType: "image",
    mediaPath: `${idC}/wa-media/never-uploaded.png`,
    mediaName: "never-uploaded.png",
    mediaMime: "image/png",
  });
  await processOnce();
  const cRow = await row(mC);
  check(
    "a missing attachment fails at once, saying so",
    cRow.status === "failed" && cRow.error === "media_missing" && cRow.attempts === 1,
    `${cRow.status}/${cRow.error}/${cRow.attempts}`
  );

  /* A picture can be sent again when the patient's phone asks for it. */
  const idD = await fixture("picture", fakeSock({ registered }));
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b40000000049454e44ae426082",
    "hex"
  );
  const saved = await saveFile(idD, "wa-media", "qa.png", png);
  const mD = await queue(idD, good, "فاتورتك", {
    msgType: "image",
    mediaPath: saved.storagePath,
    mediaName: "qa.png",
    mediaMime: "image/png",
  });
  await processOnce();
  const d = await row(mD);
  check("a picture is sent", d.status === "sent", `${d.status}/${d.error}`);
  check("and the exact message is kept for a retry request", !!d.wa_payload);
  const again = await retryContent(idD, d.wa_message_id);
  check(
    "a retry request for a picture is answered with the picture",
    !!again?.imageMessage && again.imageMessage.caption === "فاتورتك",
    JSON.stringify(Object.keys(again ?? {}))
  );
  const textAgain = await retryContent(idA, a.wa_message_id);
  check("a retry request for text is rebuilt from the thread", textAgain?.conversation === "تذكير بالموعد");
  check("text keeps no payload of its own", (await row(mA)).wa_payload === null);

  /* Held by a rail: waiting, with the rail named. */
  const idE = await fixture("capped", fakeSock({ registered }), 10);
  const todayAmman = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Amman" }).format(new Date());
  await db.query(`update whatsapp_sessions set outbound_today = 10, outbound_date = $2 where clinic_id = $1`, [idE, todayAmman]);
  const mE = await queue(idE, good, "فوق الحد");
  await processOnce();
  const e = await row(mE);
  check(
    "a message over the daily cap waits for tomorrow with the reason",
    e.status === "queued" && e.error === "held:daily_cap" && new Date(e.scheduled_at) > new Date(),
    `${e.status}/${e.error}`
  );
  const nE = deliveryNote(e, { connected: true });
  check(
    "and the inbox says when it will go",
    nE?.kind === "waiting" && nE.reason === "dailyCap" && !!nE.at,
    JSON.stringify(nE)
  );

  /* "Not on WhatsApp" is a day-old answer at most. */
  const installed = "+962790444000";
  let lookupsF = 0;
  const idF = await fixture("recheck", fakeSock({ registered: new Set([installed.replace("+", "")]), onLookup: () => lookupsF++ }));
  await db.query(
    `insert into conversations (clinic_id, phone_e164, on_whatsapp, wa_checked_at) values ($1,$2,false, now() - interval '25 hours')`,
    [idF, installed]
  );
  const mF = await queue(idF, installed, "بعد التثبيت");
  await processOnce();
  const fRow = await row(mF);
  check(
    "a day-old 'not on WhatsApp' is asked again, and the message goes",
    lookupsF === 1 && fRow.status === "sent",
    `${lookupsF} lookups, ${fRow.status}/${fRow.error}`
  );
  let lookupsG = 0;
  const idG = await fixture("fresh-no", fakeSock({ registered: new Set([installed.replace("+", "")]), onLookup: () => lookupsG++ }));
  await db.query(
    `insert into conversations (clinic_id, phone_e164, on_whatsapp, wa_checked_at) values ($1,$2,false, now() - interval '1 hour')`,
    [idG, installed]
  );
  const mG = await queue(idG, installed, "قبل يوم");
  await processOnce();
  const gRow = await row(mG);
  check(
    "an hour-old 'no' is trusted without asking WhatsApp again",
    lookupsG === 0 && gRow.status === "failed" && gRow.error === "no_whatsapp_account",
    `${lookupsG} lookups, ${gRow.status}/${gRow.error}`
  );

  /* What the inbox says, read from the message alone. */
  const nowIso = new Date().toISOString();
  const base = { direction: "out", error: null as string | null, created_at: nowIso };
  const w = deliveryNote({ ...base, status: "queued", scheduled_at: nowIso }, { connected: false });
  check("a queued message with WhatsApp disconnected says so", w?.kind === "waiting" && w.reason === "disconnected", JSON.stringify(w));
  const cn = deliveryNote({ ...base, status: "cancelled", error: "appointment_passed" }, { connected: true });
  check(
    "a cancelled reminder says its appointment had already started",
    cn?.kind === "cancelled" && cn.reason === "appointmentPassed",
    JSON.stringify(cn)
  );
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
  check(
    "sent with no receipt for seven hours reads as not delivered",
    deliveryNote({ ...base, status: "sent", sent_at: hoursAgo(7) }, { connected: true })?.kind === "undelivered"
  );
  check(
    "sent an hour ago is not a problem yet",
    deliveryNote({ ...base, status: "sent", sent_at: hoursAgo(1) }, { connected: true }) === null
  );
  check(
    "the words carry WhatsApp's code",
    deliveryText({ kind: "failed", reason: "rejected", code: "500" }, en.delivery, (x) => x).includes("500")
  );

  /* A socket counts as connected only while it is open. */
  const probe = new WASession("00000000-0000-4000-8000-000000000000");
  (probe as unknown as { sock: unknown }).sock = { user: { id: "962790000000:1@s.whatsapp.net" } };
  check("a socket with a user that has not opened is not connected", probe.connected === false);
  (probe as unknown as { open: boolean }).open = true;
  check("an open socket is", probe.connected === true);

  /* Send again. Last, so no later pass sends the copy. */
  const badConvId = (
    await db.query(`select id from conversations where clinic_id = $1 and phone_e164 = $2`, [clinic.id, bad])
  ).rows[0].id as string;
  const r1 = await withSystem((c) =>
    resendMessage(c, { clinicId: clinic.id, conversationId: badConvId, messageId: queuedBad, userId: owner.id })
  );
  check("Send again on a failed message queues a fresh copy", r1.ok, JSON.stringify(r1));
  if (r1.ok) {
    const copy = await row(r1.messageId);
    check(
      "the copy goes now, as staff, with the same words",
      copy.status === "queued" && copy.sender_kind === "staff" && copy.body === "موعدك غداً الساعة ٤",
      `${copy.status}/${copy.sender_kind}`
    );
  }
  const old = await row(queuedBad);
  check(
    "the original keeps its reason and is marked as sent again",
    old.status === "failed" && old.error === "no_whatsapp_account" && !!old.resent_at
  );
  const reasked = (await db.query(`select on_whatsapp, wa_checked_at from conversations where id = $1`, [badConvId])).rows[0];
  check("and WhatsApp is asked about the number again", reasked.on_whatsapp === null && reasked.wa_checked_at === null);
  const r2 = await withSystem((c) =>
    resendMessage(c, { clinicId: clinic.id, conversationId: badConvId, messageId: queuedBad, userId: owner.id })
  );
  check("a second tap does not send it twice", !r2.ok && r2.error === "not_resendable", JSON.stringify(r2));
  const goodConv = (
    await db.query(`select id from conversations where clinic_id = $1 and phone_e164 = $2`, [clinic.id, good])
  ).rows[0].id as string;
  const r3 = await withSystem((c) =>
    resendMessage(c, { clinicId: clinic.id, conversationId: goodConv, messageId: queuedGood, userId: owner.id })
  );
  check("a message that was read cannot be sent again from here", !r3.ok && r3.error === "not_resendable", JSON.stringify(r3));

  for (const id of extra) {
    sessions.delete(id);
    await db.query(`delete from clinics where id = $1`, [id]);
  }
  await deleteFile(saved.storagePath).catch(() => {});

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
