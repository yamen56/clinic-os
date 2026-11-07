/**
 * A patient's messages read on the clinic's phone stop being unread here too.
 *
 * Yamen, 2026-11-07: "if it is opened in WhatsApp I want it to show that, not
 * that you have to open it another time in the app for the missed messages to
 * disappear".
 *
 * - A read receipt from the clinic's own phone names the messages read; what came
 *   in after the latest of them is still unread.
 * - A chat marked read from the phone's chat list clears the thread, whether it is
 *   addressed by number or by LID.
 * - The patient's own read receipts on our messages still only move our ticks.
 *
 * Needs the database only.
 */
import "../worker/env";
import { Client } from "pg";
import type { BaileysEventMap } from "@whiskeysockets/baileys";
import { handleChatsRead, handleReceipts } from "../worker/wa/receipts";

const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

let passed = 0;
let failed = 0;
const check = (cond: unknown, m: string, detail = "") => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${m}`);
  } else {
    failed++;
    console.log(`  ✗ ${m}${detail ? ` — ${detail}` : ""}`);
  }
};

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const tag = Date.now().toString(36);
  const [clinic] = await q(`insert into clinics (name, slug, timezone) values ('QA Read sync', $1, 'Asia/Amman') returning id`, [`qaread${tag}`]);
  try {
    const thread = async (phone: string, jid: string | null, lid: string | null) =>
      (await q(`insert into conversations (clinic_id, phone_e164, wa_jid, wa_lid, unread_count) values ($1, $2, $3, $4, 0) returning id`, [clinic.id, phone, jid, lid]))[0]
        .id as string;
    const say = async (conv: string, waId: string, direction: "in" | "out", ago: number) => {
      await q(
        `insert into messages (clinic_id, conversation_id, direction, sender_kind, wa_message_id, body, status, created_at)
         values ($1, $2, $3, $4, $5, 'hi', $6, now() - ($7 || ' seconds')::interval)`,
        [clinic.id, conv, direction, direction === "in" ? "patient" : "staff", waId, direction === "in" ? "delivered" : "sent", ago]
      );
      if (direction === "in") await q(`update conversations set unread_count = unread_count + 1 where id = $1`, [conv]);
    };
    const unread = async (conv: string) => (await q(`select unread_count from conversations where id = $1`, [conv]))[0].unread_count as number;
    const receipt = (id: string, fromMe: boolean, status: number) =>
      ({ key: { remoteJid: "962790000001@s.whatsapp.net", id, fromMe }, update: { status } }) as unknown as BaileysEventMap["messages.update"][number];

    console.log("Read on the phone, message by message");
    const a = await thread("+962790000001", "962790000001@s.whatsapp.net", null);
    await say(a, `A1${tag}`, "in", 30);
    await say(a, `A2${tag}`, "in", 20);
    await say(a, `A3${tag}`, "in", 10);
    check((await unread(a)) === 3, "three messages from the patient, unread");
    await handleReceipts(clinic.id, [receipt(`A2${tag}`, false, 4)]);
    check((await unread(a)) === 1, "read up to the second on the phone: one is still unread", String(await unread(a)));
    await handleReceipts(clinic.id, [receipt(`A3${tag}`, false, 4), receipt(`A1${tag}`, false, 4)]);
    check((await unread(a)) === 0, "read to the last: none", String(await unread(a)));
    await say(a, `A4${tag}`, "in", 0);
    await handleReceipts(clinic.id, [receipt(`A3${tag}`, false, 4)]);
    check((await unread(a)) === 1, "a late receipt for an older message leaves a newer one unread", String(await unread(a)));
    await handleReceipts(clinic.id, [receipt(`A4${tag}`, false, 3)]);
    check((await unread(a)) === 1, "delivered to the phone is not read");

    console.log("Marked read from the chat list");
    await handleChatsRead(clinic.id, [{ id: "962790000001@s.whatsapp.net", unreadCount: 0 }]);
    check((await unread(a)) === 0, "by the number");
    const b = await thread("+999123456789012", null, "123456789012345@lid");
    await say(b, `B1${tag}`, "in", 5);
    await handleChatsRead(clinic.id, [{ id: "123456789012345@lid", unreadCount: 1 }]);
    check((await unread(b)) === 1, "marked unread on the phone changes nothing");
    await handleChatsRead(clinic.id, [{ id: "123456789012345@lid", unreadCount: 0 }]);
    check((await unread(b)) === 0, "and by the LID");

    console.log("Our own messages");
    await say(a, `O1${tag}`, "out", 0);
    await say(a, `A5${tag}`, "in", 0);
    await handleReceipts(clinic.id, [receipt(`O1${tag}`, true, 4)]);
    const [out] = await q(`select status from messages where wa_message_id = $1`, [`O1${tag}`]);
    check(out.status === "read", "the patient reading ours still turns our ticks blue");
    check((await unread(a)) === 1, "and does not clear what they wrote to us");
  } finally {
    await q(`delete from clinics where id = $1`, [clinic.id]).catch((e) => console.log("cleanup:", e.message));
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
