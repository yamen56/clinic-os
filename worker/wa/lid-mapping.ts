import type { BaileysEventMap } from "@whiskeysockets/baileys";
import type { PoolClient } from "pg";
import { withSystem } from "../db";
import { bareJidUser, isLidJid, jidToE164 } from "../../src/lib/phone";
import { findPatientByPhone } from "../../src/lib/patients";

/**
 * Learning the phone number behind a LID.
 *
 * A chat addressed by LID reaches the patient perfectly well, but the number is
 * what ties the thread to a patient file, and it is what a receptionist reads.
 * WhatsApp hands the pairing over eventually — on `chats.phoneNumberShare`, and
 * on contact syncs where a contact carries both forms. This takes it whenever
 * it is offered and upgrades the conversation in place.
 */

/**
 * The number behind one LID, asked the moment a message arrives.
 *
 * This is the difference between preventing the split and repairing it. Baileys
 * often already knows the pairing when the message lands — it just is not
 * volunteered on the message itself — so asking here means an incoming message
 * from a patient we have on file goes straight onto their existing thread. Ask
 * ten minutes later instead and there are two threads to reconcile, and in
 * between them a receptionist reading a stranger's chat.
 *
 * Every failure is a `null`: an older library with no store, a store that has
 * not learned this pairing, a lookup that throws. All of them mean the same
 * thing to the caller — carry on with the LID, exactly as before.
 */
export async function pnForLid(sock: unknown, lidJid: string): Promise<string | null> {
  const store = (
    sock as {
      signalRepository?: { lidMapping?: { getPNForLID?: (lid: string) => Promise<string | null> } };
    }
  ).signalRepository?.lidMapping;
  if (typeof store?.getPNForLID !== "function") return null;
  try {
    const pn = await store.getPNForLID.call(store, lidJid);
    if (!pn) return null;
    // It answers with a JID; tolerate bare digits in case that ever changes.
    return jidToE164(pn) ?? (/^\+?\d{7,15}$/.test(pn) ? `+${pn.replace(/^\+/, "")}` : null);
  } catch {
    return null;
  }
}

/**
 * Folds a LID thread into the thread its real number already had.
 *
 * One person, one conversation. Everything the identity thread accumulated
 * moves across — messages first, because `messages.conversation_id` cascades on
 * delete and a mistake in the order here does not merge a thread, it destroys
 * one. The caller runs inside `withSystem`, which is a transaction, so a
 * failure anywhere rolls the whole fold back rather than leaving half a thread.
 *
 * The surviving row keeps the patient link and the number, and takes the LID
 * thread's *address*: that is the one WhatsApp is currently delivering to, and
 * replacing it with the older phone address is how a reply goes nowhere.
 */
async function mergeThreads(
  c: PoolClient,
  clinicId: string,
  args: { from: string; into: string; lid: string; phone: string }
): Promise<void> {
  const { from, into } = args;

  const moved = await c.query(
    `update messages set conversation_id = $2 where conversation_id = $1`,
    [from, into]
  );
  await c.query(`update automation_runs set conversation_id = $2 where conversation_id = $1`, [
    from,
    into,
  ]);
  /*
    AI state is keyed by conversation, one row each, so the two cannot both
    survive. The thread being kept kept its own; the identity thread's copy is
    scratch — where the agent had got to in a conversation that is about to stop
    existing — and is dropped rather than overwriting it.
  */
  await c.query(`delete from ai_conversation_state where conversation_id = $1`, [from]);

  await c.query(
    `update conversations tgt
        set wa_jid = src.wa_jid,
            wa_lid = coalesce(src.wa_lid, tgt.wa_lid),
            -- Staff may have made a file from the identity thread, or the AI
            -- booked on it. The thread being deleted must not take that with it.
            patient_id = coalesce(tgt.patient_id, src.patient_id),
            whatsapp_name = coalesce(tgt.whatsapp_name, src.whatsapp_name),
            unread_count = tgt.unread_count + src.unread_count,
            flagged = tgt.flagged or src.flagged,
            flag_reason = coalesce(tgt.flag_reason, src.flag_reason),
            -- Whichever thread was spoken in last is what the inbox should show.
            last_message_at = greatest(
              coalesce(tgt.last_message_at, 'epoch'::timestamptz),
              coalesce(src.last_message_at, 'epoch'::timestamptz)),
            last_message_preview = case
              when coalesce(src.last_message_at, 'epoch'::timestamptz)
                 > coalesce(tgt.last_message_at, 'epoch'::timestamptz)
              then src.last_message_preview else tgt.last_message_preview end,
            last_message_direction = case
              when coalesce(src.last_message_at, 'epoch'::timestamptz)
                 > coalesce(tgt.last_message_at, 'epoch'::timestamptz)
              then src.last_message_direction else tgt.last_message_direction end,
            identifier_kind = 'phone',
            -- Reachability is answerable again now there is a number to ask about.
            on_whatsapp = null,
            wa_checked_at = null
       from conversations src
      where tgt.id = $2 and src.id = $1`,
    [from, into]
  );

  // Only now, with nothing left pointing at it.
  await c.query(`delete from conversations where id = $1 and clinic_id = $2`, [from, clinicId]);

  console.log(
    `[wa ${clinicId}] lid ${args.lid} is ${args.phone} — folded ${moved.rowCount} message(s) into its existing thread`
  );
}

/**
 * Give a patient file the number its thread just turned out to have.
 *
 * A file made from an identity thread — by staff, or by the AI booking — was
 * created without a number, or in older data with the LID stand-in in the
 * phone field. Once the number is known the file should carry it: that is what
 * the receptionist dials and what the next message is matched on. Only fills a
 * gap; a file with a real number of its own keeps it, and a number that
 * already belongs to another file is left for staff to merge.
 */
async function giveFileItsNumber(
  c: PoolClient,
  clinicId: string,
  args: { conversationId: string; lid: string; phone: string }
): Promise<void> {
  /*
    Behind a savepoint: this rides in the transaction that records an inbound
    message, and a file created with the same number a moment ago would trip
    `patients_phone_key` — which must cost the file its number, not the
    patient their message.
  */
  await c.query("savepoint give_file_number");
  let r;
  try {
    r = await c.query(
      `update patients p
          set phone_e164 = $3
         from conversations cv
        where cv.id = $1 and cv.clinic_id = $2 and p.id = cv.patient_id
          and (p.phone_e164 is null or p.phone_e164 = '' or p.phone_e164 = '+' || $4)
          and not exists (
            select 1 from patients o
             where o.clinic_id = $2 and o.id <> p.id and o.merged_into is null
               and (o.phone_e164 = $3 or o.secondary_phone_e164 = $3 or $3 = any(o.extra_phones)))`,
      [args.conversationId, clinicId, args.phone, args.lid]
    );
    await c.query("release savepoint give_file_number");
  } catch (e) {
    await c.query("rollback to savepoint give_file_number");
    console.error(`[wa ${clinicId}] could not give a file its number`, (e as Error).message);
    return;
  }
  if (r.rowCount) console.log(`[wa ${clinicId}] gave a patient file its number from lid ${args.lid}`);
}

/**
 * One LID has turned out to be one number: move its thread onto the number.
 *
 * Runs inside the caller's transaction, so the inbound path can do this in the
 * same breath as recording the message that told us.
 */
export async function adoptNumber(
  c: PoolClient,
  clinicId: string,
  pair: { lid: string; phone: string }
): Promise<void> {
  const lid = bareJidUser(pair.lid);
  const { phone } = pair;
  const conv = (
    await c.query(
      `select id, phone_e164 from conversations
        where clinic_id = $1 and identifier_kind = 'lid'
          and (wa_lid = $2 or wa_lid like $2 || ':%')`,
      [clinicId, lid]
    )
  ).rows[0] as { id: string; phone_e164: string } | undefined;
  if (!conv) return;

  /*
    The real number usually already has a thread of its own: the patient
    wrote from a number once, was saved as a file, and WhatsApp moved them
    to identity addressing afterwards. That is the ordinary case, not the
    exotic one.

    This used to log and give up, on the reasoning that a human should merge
    them — but conversations have never been mergeable by hand, so "leave it
    for a human" meant leaving it forever. The patient's own thread went
    quiet while their messages piled up in a second one that showed a
    fifteen-digit stand-in and was attached to nobody.
  */
  const clash = (
    await c.query(
      `select id from conversations where clinic_id = $1 and phone_e164 = $2 and id <> $3`,
      [clinicId, phone, conv.id]
    )
  ).rows[0] as { id: string } | undefined;
  if (clash) {
    await mergeThreads(c, clinicId, { from: conv.id, into: clash.id, lid, phone });
    await giveFileItsNumber(c, clinicId, { conversationId: clash.id, lid, phone });
    return;
  }

  const patient = await findPatientByPhone(c, clinicId, phone);
  await c.query(
    `update conversations
        set phone_e164 = $2,
            identifier_kind = 'phone',
            patient_id = coalesce(patient_id, $3),
            -- Unknown again, and now answerable: it is a real number.
            on_whatsapp = null,
            wa_checked_at = null
      where id = $1`,
    [conv.id, phone, patient?.id ?? null]
  );
  await giveFileItsNumber(c, clinicId, { conversationId: conv.id, lid, phone });
  console.log(`[wa ${clinicId}] resolved lid ${lid} to ${phone}`);
}

export async function learnLidMapping(
  clinicId: string,
  pairs: { lid: string; jid: string }[]
) {
  const clean = pairs
    .map((p) => ({
      lid: p.lid && isLidJid(p.lid.includes("@") ? p.lid : `${p.lid}@lid`) ? bareJidUser(p.lid) : null,
      phone: jidToE164(p.jid ?? ""),
    }))
    .filter((p): p is { lid: string; phone: string } => !!p.lid && !!p.phone);
  if (!clean.length) return;

  await withSystem(async (c) => {
    for (const pair of clean) await adoptNumber(c, clinicId, pair);
  });
}

/**
 * Fold identity threads into the thread that already holds their LID.
 *
 * When the clinic wrote first, the send resolved the patient's number to their
 * LID and stored it on their own thread; a reply that came back from the LID
 * with no number on it then opened a second thread. Every such pair is one
 * person, and the phone thread already says so — no lookup needed, which is
 * what makes this work even for a LID the mapping store never learned.
 */
async function foldKnownLids(clinicId: string): Promise<number> {
  return withSystem(async (c) => {
    const pairs = (
      await c.query(
        `select distinct on (l.id) l.id as from_id, p.id as into_id, l.wa_lid, p.phone_e164
           from conversations l
           join conversations p
             on p.clinic_id = l.clinic_id and p.id <> l.id and p.identifier_kind = 'phone'
            and split_part(p.wa_lid, ':', 1) = split_part(l.wa_lid, ':', 1)
          where l.clinic_id = $1 and l.identifier_kind = 'lid' and l.wa_lid is not null
          order by l.id, p.last_message_at desc nulls last`,
        [clinicId]
      )
    ).rows as { from_id: string; into_id: string; wa_lid: string; phone_e164: string }[];
    for (const p of pairs) {
      const lid = bareJidUser(p.wa_lid);
      await mergeThreads(c, clinicId, { from: p.from_id, into: p.into_id, lid, phone: p.phone_e164 });
      await giveFileItsNumber(c, clinicId, { conversationId: p.into_id, lid, phone: p.phone_e164 });
    }
    return pairs.length;
  });
}

/**
 * Give the LID-addressed threads their real numbers.
 *
 * A thread WhatsApp addresses by identity reaches the patient perfectly well,
 * but the number is what ties it to a patient file — and what a receptionist
 * reads, dials, and expects to see when they open the file. Without it a new
 * patient profile shows either a fifteen-digit thing that is not a number or
 * nothing at all.
 *
 * The library can answer this directly, in one batched round trip, so the
 * threads that have been sitting on an identity get resolved rather than
 * waiting for WhatsApp to volunteer the pairing.
 */
export async function resolvePendingLids(clinicId: string, sock: unknown): Promise<number> {
  /*
    Report what changed, not what was asked: the rows that actually stopped
    being LID-addressed. For its first seven weeks this job looked up every
    pending thread every ten minutes and moved none of them — the store's
    answers carry a device suffix the number parser refused — so a count of
    lookups would have announced success the whole time.
  */
  const stillLid = () =>
    withSystem(async (c) =>
      Number(
        (
          await c.query(
            `select count(*)::int n from conversations
              where clinic_id = $1 and identifier_kind = 'lid'`,
            [clinicId]
          )
        ).rows[0].n
      )
    );

  const before = await stillLid();
  if (!before) return 0;

  // The pairs the database can already prove, before asking the library anything.
  await foldKnownLids(clinicId).catch((e) =>
    console.error(`[wa ${clinicId}] lid fold`, (e as Error).message)
  );

  const store = (
    sock as {
      signalRepository?: {
        lidMapping?: { getPNsForLIDs?: (lids: string[]) => Promise<{ pn: string; lid: string }[] | null> };
      };
    }
  ).signalRepository?.lidMapping;
  const resolver = store?.getPNsForLIDs;
  if (typeof resolver === "function") {
    /*
      Every pending thread, a page at a time. This used to take the newest
      hundred, so a clinic whose newest hundred were unresolvable never had
      the older ones asked about at all. The store answers from its own keys,
      without a network round trip, so asking about all of them is cheap.
      Paged by id, which stays stable while threads leave the set under it.
    */
    const PAGE = 200;
    let after: string | null = null;
    for (;;) {
      const page = await withSystem((c) =>
        c.query(
          `select id, wa_lid from conversations
            where clinic_id = $1 and identifier_kind = 'lid' and wa_lid is not null
              and ($2::uuid is null or id > $2::uuid)
            order by id
            limit $3`,
          [clinicId, after, PAGE]
        )
      );
      if (!page.rowCount) break;
      after = page.rows[page.rows.length - 1].id as string;

      let pairs: { pn: string; lid: string }[] | null = null;
      try {
        pairs = await resolver.call(
          store,
          page.rows.map((r) => `${bareJidUser(String(r.wa_lid))}@lid`)
        );
      } catch (e) {
        console.error(`[wa ${clinicId}] lid batch lookup failed`, (e as Error).message);
        break;
      }
      if (pairs?.length) {
        await learnLidMapping(
          clinicId,
          pairs.filter((p) => p.pn && p.lid).map((p) => ({ lid: p.lid, jid: p.pn }))
        );
      }
      if (page.rowCount < PAGE) break;
    }
  }

  return Math.max(0, before - (await stillLid()));
}

/** Contact syncs carry both forms of the same person often enough to be worth reading. */
export function pairsFromContacts(
  contacts: BaileysEventMap["contacts.upsert"] | BaileysEventMap["contacts.update"]
): { lid: string; jid: string }[] {
  const out: { lid: string; jid: string }[] = [];
  for (const ct of contacts) {
    const lid = ct.lid ?? (ct.id?.endsWith("@lid") ? ct.id : undefined);
    // `phoneNumber` is what the contact's PN form is called now; `id` still
    // holds it on contacts that were never LID-addressed.
    const jid = ct.phoneNumber ?? (ct.id?.endsWith("@s.whatsapp.net") ? ct.id : undefined);
    if (lid && jid) out.push({ lid, jid });
  }
  return out;
}
