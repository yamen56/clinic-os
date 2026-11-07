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
 * - The other way (0096): what is read in the app is marked read on WhatsApp, once,
 *   on the chat each message came in on, and only last week's; opening a thread
 *   or answering it queues that.
 *
 * Needs the database, and a warm server for the last part.
 */
import "../worker/env";
import { Client } from "pg";
import type { BaileysEventMap } from "@whiskeysockets/baileys";
import { handleChatsRead, handleReceipts } from "../worker/wa/receipts";
import { chromium } from "playwright";
import bcrypt from "bcryptjs";

const BASE = process.env.APP_URL || "http://localhost:3000";

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
  // The worker is ESM (Baileys); a dynamic import is how a CommonJS script reaches it.
  const { recordMessage } = await import("../worker/wa/inbound");
  const { sendReadReceipts } = await import("../worker/wa/read");
  const { sessions } = await import("../worker/wa/session");
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

    console.log("Read in the app, read on WhatsApp");
    const [readA1] = await q(`select read_at from messages where wa_message_id = $1`, [`A1${tag}`]);
    check(!!readA1.read_at, "what the phone read is marked read, so the app does not tell it again");
    await recordMessage(clinic.id, { phone: "+962790000002", jid: "555000111222333@lid", lid: "555000111222333@lid", dialable: true, fromMe: false, waId: `C1${tag}`, msgType: "text", body: "hello", mediaPath: null, mediaMime: null, mediaName: null, pushName: "Sami" });
    await recordMessage(clinic.id, { phone: "+962790000002", jid: "962790000002@s.whatsapp.net", dialable: true, fromMe: false, waId: `C2${tag}`, msgType: "text", body: "are you open?", mediaPath: null, mediaMime: null, mediaName: null, pushName: "Sami" });
    const [c1] = await q(`select conversation_id, wa_remote_jid from messages where wa_message_id = $1`, [`C1${tag}`]);
    check(c1.wa_remote_jid === "555000111222333@lid", "a patient's message keeps the chat it came in on");
    await q(`insert into messages (clinic_id, conversation_id, direction, sender_kind, wa_message_id, body, status, created_at) values ($1, $2, 'in', 'patient', $3, 'old', 'delivered', now() - interval '10 days')`, [clinic.id, c1.conversation_id, `C0${tag}`]);
    const told: { remoteJid: string; id: string }[][] = [];
    const fake = { sock: { user: { id: "962790009999@s.whatsapp.net" }, readMessages: async (keys: { remoteJid: string; id: string }[]) => void told.push(keys) } };
    await sendReadReceipts({ conversationId: c1.conversation_id }, clinic.id);
    check(told.length === 0, "with WhatsApp not connected, nothing is sent");
    sessions.set(clinic.id, fake as never);
    await sendReadReceipts({ conversationId: c1.conversation_id }, clinic.id);
    const sent = Object.fromEntries((told[0] ?? []).map((k) => [k.id, k.remoteJid]));
    check(sent[`C1${tag}`] === "555000111222333@lid" && sent[`C2${tag}`] === "962790000002@s.whatsapp.net", "each is marked read on the chat it came in on", JSON.stringify(sent));
    check(!(`C0${tag}` in sent), "and not something from ten days ago");
    await sendReadReceipts({ conversationId: c1.conversation_id }, clinic.id);
    check(told.length === 1, "once: a second pass sends nothing");
    sessions.delete(clinic.id);

    console.log("Opening or answering a thread asks for it");
    await recordMessage(clinic.id, { phone: "+962790000002", jid: "962790000002@s.whatsapp.net", dialable: true, fromMe: false, waId: `C3${tag}`, msgType: "text", body: "hello?", mediaPath: null, mediaMime: null, mediaName: null, pushName: "Sami" });
    const email = `readsync-${tag}@test.local`;
    const [u] = await q(`insert into users (email, password_hash, full_name, locale) values ($1, $2, 'Desk Read', 'en') returning id`, [email, bcrypt.hashSync("password123", 10)]);
    await q(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'receptionist', true, '{"level":"full"}')`, [clinic.id, u.id]);
    const browser = await chromium.launch();
    try {
      const page = await (await browser.newContext()).newPage();
      await page.goto(`${BASE}/login`, { timeout: 180000 });
      await page.fill('input[name="email"]', email);
      await page.fill('input[name="password"]', "password123");
      await page.click('button[type="submit"]');
      await page.waitForURL((x) => !x.pathname.includes("login"), { timeout: 180000, waitUntil: "commit" });
      const jobs = async () => (await q(`select count(*)::int as n from jobs where clinic_id = $1 and kind = 'wa:read' and payload->>'conversationId' = $2`, [clinic.id, c1.conversation_id]))[0].n as number;
      const r = await page.request.post(`${BASE}/api/c/qaread${tag}/conversations/${c1.conversation_id}`, { data: { op: "read" } });
      check(r.ok() && (await jobs()) === 1, "opening a thread with something unread asks WhatsApp to mark it read", String(r.status()));
      await q(`update messages set read_at = now() where conversation_id = $1`, [c1.conversation_id]);
      await page.request.post(`${BASE}/api/c/qaread${tag}/conversations/${c1.conversation_id}`, { data: { op: "read" } });
      check((await jobs()) === 1, "and nothing more when all of it is already read");
    } finally {
      await browser.close();
      await q(`delete from users where email = $1`, [email]);
    }
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
