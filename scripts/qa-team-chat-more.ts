/**
 * The team chat as the chat apps everybody uses (0095).
 *
 * Yamen, 2026-11-07: "in the internal chat add more capability and options like
 * the normal social media chat apps, and make sure that it notifies the one who
 * got the message in a premium way".
 *
 * - Reply with a quote; react (one each, replaced, taken back) and the sender is
 *   told; correct a message for 15 minutes; forward only what you can read; pin a
 *   message for the thread and a thread for yourself; mark one unread.
 * - An @mention or a reply to you reaches you in a thread you muted.
 * - Typing is said live to the thread's other people, and to nobody else.
 * - "Seen" turns blue once the other person has read it.
 * - Search finds words in your own threads and never in anybody else's.
 * - The bell line knows who it is from; the pop-up shows their face and answers
 *   from where it is; the phone's notification gets a small copy of a photo.
 *
 * Run against a warm server.
 */
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import sharp from "sharp";

try {
  process.loadEnvFile?.();
} catch {}

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
async function until(fn: () => Promise<boolean>, ms = 20000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function signIn(browser: Browser, email: string, viewport = { width: 1440, height: 1000 }): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
  await ctx.addCookies([{ name: "cos_locale", value: "en", url: BASE }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { timeout: 180000 });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 180000, waitUntil: "commit" });
  return page;
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const tag = Date.now().toString(36);
  const hash = bcrypt.hashSync("password123", 10);
  const slug = `qateam2${tag}`;
  const [clinic] = await q(`insert into clinics (name, slug, timezone) values ('QA Team More', $1, 'Asia/Amman') returning id`, [slug]);
  await q(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  const member = async (who: string, name: string, role: string) => {
    const email = `${who}-${tag}@test.local`;
    const [u] = await q(`insert into users (email, password_hash, full_name, locale) values ($1, $2, $3, 'en') returning id`, [email, hash, name]);
    const [m] = await q(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, $3, false, $4) returning id`, [
      clinic.id,
      u.id,
      role,
      JSON.stringify({ level: "custom", caps: { dashboard: true, conversations: true } }),
    ]);
    return { email, userId: u.id as string, memberId: m.id as string, name };
  };
  const rana = await member("rana", "Rana Desk", "receptionist");
  const omar = await member("omar", "Omar Doctor", "doctor");
  const lina = await member("lina", "Lina Nurse", "other");

  const browser = await chromium.launch();
  const errors: string[] = [];
  try {
    const R = await signIn(browser, rana.email);
    const O = await signIn(browser, omar.email);
    const L = await signIn(browser, lina.email);
    for (const p of [R, O, L]) p.on("pageerror", (e) => errors.push(e.message));
    const api = `${BASE}/api/c/${slug}/team`;
    const post = (p: Page, path: string, data: unknown) => p.request.post(`${api}${path}`, { data });
    const patch = (p: Page, path: string, data: unknown) => p.request.fetch(`${api}${path}`, { method: "PATCH", data });
    const say = async (p: Page, thread: string, body: string, extra: Record<string, unknown> = {}) => {
      const r = await post(p, `/${thread}/messages`, { id: crypto.randomUUID(), body, ...extra });
      return (await r.json()).message as { id: string; createdAt: string; replyTo: { id: string } | null; forwarded: boolean };
    };
    const thread = async (p: Page, id: string) => (await (await p.request.get(`${api}/${id}`)).json()).messages as {
      id: string;
      body: string;
      replyTo: { id: string; body: string } | null;
      reactions: { emoji: string; userIds: string[] }[];
      editedAt: string | null;
      forwarded: boolean;
      mentions: string[];
    }[];
    const threads = async (p: Page) => (await (await p.request.get(api)).json()).threads as {
      id: string;
      kind: string;
      pinned: boolean;
      unread: number;
      pinnedMessage: { id: string } | null;
      members: { userId: string; lastReadAt: string | null }[];
    }[];

    const dm = (await (await post(R, "", { kind: "direct", userId: omar.userId })).json()).id as string;
    const group = (await (await post(O, "", { kind: "group", name: "Floor", userIds: [rana.userId, lina.userId] })).json()).id as string;

    console.log("Reply, react, edit");
    const ask = await say(R, dm, "Can you see Mr Haddad at 4?");
    const answer = await say(O, dm, "Yes, send him in", { replyTo: ask.id });
    check(answer.replyTo?.id === ask.id, "a reply carries the message it answers");
    check((await thread(R, dm)).find((m) => m.id === answer.id)?.replyTo?.body === "Can you see Mr Haddad at 4?", "and the other side sees the quote");
    check((await post(R, `/${group}/messages`, { id: crypto.randomUUID(), body: "x", replyTo: ask.id })).status() === 400, "a reply cannot quote another thread's message");

    await q(`delete from notifications where user_id = $1`, [omar.userId]);
    check((await patch(R, `/messages/${answer.id}`, { op: "react", emoji: "👍" })).ok(), "a reaction is set");
    const told = await q(`select title, body, actor_id, kind from notifications where user_id = $1 and kind = 'team_reaction'`, [omar.userId]);
    check(told.length === 1 && told[0].title === "Rana Desk reacted 👍" && told[0].actor_id === rana.userId, "and its sender is told who reacted", JSON.stringify(told[0]));
    await patch(R, `/messages/${answer.id}`, { op: "react", emoji: "❤️" });
    const reacted = (await thread(O, dm)).find((m) => m.id === answer.id)!;
    check(reacted.reactions.length === 1 && reacted.reactions[0].emoji === "❤️", "a new one replaces it: one each", JSON.stringify(reacted.reactions));
    check((await q(`select count(*)::int as n from notifications where user_id = $1 and kind = 'team_reaction'`, [omar.userId]))[0].n === 1, "and its line on the bell");
    await patch(R, `/messages/${answer.id}`, { op: "react", emoji: null });
    check((await thread(O, dm)).find((m) => m.id === answer.id)!.reactions.length === 0, "taken back");
    check((await q(`select count(*)::int as n from notifications where user_id = $1 and kind = 'team_reaction'`, [omar.userId]))[0].n === 0, "and so is the line");

    check((await patch(O, `/messages/${answer.id}`, { op: "edit", body: "Yes, send him in now" })).ok(), "the sender corrects their message");
    check((await thread(R, dm)).find((m) => m.id === answer.id)?.editedAt, "and it says edited");
    check((await patch(R, `/messages/${answer.id}`, { op: "edit", body: "hijack" })).status() === 404, "nobody else can");
    await q(`update team_messages set created_at = now() - interval '20 minutes' where id = $1`, [answer.id]);
    check((await patch(O, `/messages/${answer.id}`, { op: "edit", body: "late" })).status() === 409, "and not after fifteen minutes");

    console.log("Forward, pin, unread");
    const fwd = await say(R, group, "", { forwardOf: ask.id });
    check(fwd?.forwarded === true, "a message is forwarded into another thread");
    check((await thread(L, group)).find((m) => m.id === fwd.id)?.body === "Can you see Mr Haddad at 4?", "with its words");
    check((await post(L, `/${group}/messages`, { id: crypto.randomUUID(), forwardOf: ask.id })).status() === 404, "but nobody forwards what they cannot read");

    check((await patch(L, `/messages/${fwd.id}`, { op: "pin", pinned: true })).ok(), "anybody in the thread pins a message");
    check((await threads(O)).find((x) => x.id === group)?.pinnedMessage?.id === fwd.id, "and everybody in it sees it pinned");
    await R.request.delete(`${api}/messages/${fwd.id}`);
    check((await threads(O)).find((x) => x.id === group)?.pinnedMessage === null, "deleting it unpins it");

    await post(O, `/${dm}`, { op: "pin", pinned: true });
    const order = await threads(O);
    check(order[0].kind === "clinic" && order[1].id === dm && order[1].pinned, "a pinned thread is first after the room");
    await post(O, `/${dm}`, { op: "read" });
    await post(O, `/${dm}`, { op: "unread" });
    check((await threads(O)).find((x) => x.id === dm)!.unread >= 1, "a read thread can be marked unread");

    console.log("Mentions and replies reach a muted thread");
    await post(R, `/${group}`, { op: "mute", muted: true });
    await q(`delete from notifications where user_id = $1`, [rana.userId]);
    await say(O, group, "Anyone free?");
    check((await q(`select 1 from notifications where user_id = $1`, [rana.userId])).length === 0, "a muted group stays quiet");
    const m1 = await say(O, group, "@Rana Desk can you call the lab?", { mentions: [rana.userId, crypto.randomUUID()] });
    const [mention] = await q(`select title, actor_id from notifications where user_id = $1`, [rana.userId]);
    check(mention?.title === "Omar Doctor mentioned you · Floor", "an @mention gets through", mention?.title);
    check(mention?.actor_id === omar.userId, "from who");
    check(JSON.stringify((await thread(R, group)).find((m) => m.id === m1.id)?.mentions) === JSON.stringify([rana.userId]), "only people in the thread are kept as mentioned");
    const mine = await say(R, group, "On it");
    await q(`delete from notifications where user_id = $1`, [rana.userId]);
    await say(L, group, "Thanks Rana", { replyTo: mine.id });
    const [replied] = await q(`select title from notifications where user_id = $1`, [rana.userId]);
    check(replied?.title === "Lina Nurse replied to you · Floor", "so does a reply to your own message", replied?.title);

    console.log("Typing, seen, search");
    const listen = new Client({ connectionString: PG });
    await listen.connect();
    const heard: Record<string, unknown>[] = [];
    listen.on("notification", (n) => {
      const e = JSON.parse(n.payload ?? "{}");
      if (e.t === "team_typing") heard.push(e);
    });
    await listen.query("listen app_events");
    await post(R, `/${dm}`, { op: "typing" });
    check(await until(async () => heard.length === 1), "typing is said");
    const said = heard[0] as { by: string; id: string; user_ids: string[] };
    check(said.by === rana.userId && said.id === dm && said.user_ids.length === 2 && !said.user_ids.includes(lina.userId), "to the thread's people only", JSON.stringify(said));
    await listen.end();

    const fresh = await say(R, dm, "Seen?");
    await post(O, `/${dm}`, { op: "read" });
    const omarRow = (await threads(R)).find((x) => x.id === dm)!.members.find((p) => p.userId === omar.userId)!;
    check(!!omarRow.lastReadAt && omarRow.lastReadAt >= fresh.createdAt, "the sender sees when it was read");

    const found = (await (await R.request.get(`${api}?q=haddad`)).json()).hits as { messageId: string }[];
    check(found.some((h) => h.messageId === ask.id), "search finds words in your threads");
    const notMine = (await (await L.request.get(`${api}?q=haddad`)).json()).hits as { messageId: string; threadId: string }[];
    check(!notMine.some((h) => h.threadId === dm), "and never in a thread you are not in");

    console.log("Who it is from");
    const bell = await O.request.get(`${BASE}/api/me/notifications?since=${encodeURIComponent(new Date(Date.now() - 3600_000).toISOString())}`);
    const lines = (await bell.json()).notifications as { kind: string; actor: { userId: string; name: string; slug: string } | null }[];
    const line = lines.find((n) => n.kind === "team_message") as { title: string; actor: { userId: string; name: string; slug: string } | null } | undefined;
    check(!!line?.actor && line.title.startsWith(line.actor.name) && line.actor.slug === slug, "the bell line says who wrote it, for their face", JSON.stringify(line));

    const big = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: "#79a" } }).jpeg().toBuffer();
    const up = await R.request.post(`${api}/${dm}/messages`, { multipart: { id: crypto.randomUUID(), body: "", file: { name: "xray.jpg", mimeType: "image/jpeg", buffer: big } } });
    const pic = (await up.json()).message as { id: string };
    const thumb = await O.request.get(`${api}/messages/${pic.id}?thumb=1`);
    const tm = await sharp(Buffer.from(await thumb.body())).metadata();
    check(thumb.ok() && (tm.width ?? 9999) <= 720, "a phone's notification gets a small copy of a photo", `${thumb.status()} ${tm.width}`);
    check((await L.request.get(`${api}/messages/${pic.id}?thumb=1`)).status() === 404, "and only for the thread's people");

    console.log("On the screen");
    await O.goto(`${BASE}/c/${slug}/conversations/team?t=${dm}`, { timeout: 180000 });
    await O.waitForSelector(`[data-team-message='${fresh.id}']`, { timeout: 120000 });
    await R.goto(`${BASE}/c/${slug}/conversations/team?t=${dm}`, { timeout: 180000 });
    await R.waitForSelector(`[data-team-message='${fresh.id}']`, { timeout: 120000 });
    check(await until(async () => (await R.locator(`[data-team-message='${fresh.id}'] [data-team-seen]`).getAttribute("data-team-seen")) === "all"), "the ticks are blue once it is read");
    check((await O.locator(`[data-team-message='${answer.id}'] [data-team-quote]`).count()) === 1, "a reply shows its quote");
    check((await O.locator(`[data-team-message='${answer.id}'] [data-team-edited]`).count()) === 1, "an edited message says so");

    await R.locator(`[data-team-message='${answer.id}'] [data-team-bubble]`).hover();
    await R.locator(`[data-team-message='${answer.id}'] [data-team-react-open]`).click();
    await R.locator(`[data-team-message='${answer.id}'] [data-team-react='😂']`).click();
    check(await until(async () => (await O.locator(`[data-team-message='${answer.id}'] [data-team-reaction='😂']`).count()) === 1), "a reaction shows on the other screen live");

    await R.locator("[data-team-input]").pressSequentially("Coming", { delay: 30 });
    check(await until(async () => (await O.locator("[data-team-typing]").count()) === 1, 8000), "and so does typing");
    await R.locator("[data-team-input]").fill("");

    await O.locator(`[data-team-message='${fresh.id}'] [data-team-bubble]`).hover();
    await O.locator(`[data-team-message='${fresh.id}'] [data-team-reply]`).click();
    check((await O.locator("[data-team-composing='reply']").count()) === 1, "Reply puts the message above the box");
    await O.locator("[data-team-input]").fill("Yes, seen");
    await O.keyboard.press("Enter");
    check(await until(async () => (await q(`select 1 from team_messages where reply_to = $1 and body = 'Yes, seen'`, [fresh.id])).length === 1), "and the answer is sent as a reply");

    await O.locator(`[data-team-message='${fresh.id}'] [data-team-bubble]`).click({ button: "right" });
    await O.waitForSelector("[data-team-sheet]");
    await O.locator("[data-team-action='pin-message']").click();
    check(await until(async () => (await R.locator(`[data-team-pinned='${fresh.id}']`).count()) === 1), "a message pinned from its menu is pinned on both screens");

    await O.goto(`${BASE}/c/${slug}/conversations/team?t=${group}`, { timeout: 180000 });
    await O.waitForSelector("[data-team-input]", { timeout: 120000 });
    await O.locator("[data-team-input]").pressSequentially("@Li", { delay: 30 });
    await O.waitForSelector(`[data-team-mention='${lina.userId}']`, { timeout: 8000 });
    await O.locator(`[data-team-mention='${lina.userId}']`).click();
    check((await O.locator("[data-team-input]").inputValue()) === "@Lina Nurse ", "@ offers the group's people and writes the name");
    await O.locator("[data-team-input]").pressSequentially("please check room 3", { delay: 10 });
    await O.keyboard.press("Enter");
    check(
      await until(async () => (await q(`select mentions from team_messages where thread_id = $1 and body like '@Lina Nurse please%'`, [group]))[0]?.mentions?.[0] === lina.userId),
      "and the message mentions her"
    );

    await O.locator("[data-team-search]").fill("lab");
    check(await until(async () => (await O.locator(`[data-team-hit='${m1.id}']`).count()) === 1), "the search box finds a message");
    await O.locator("[data-team-search]").fill("");

    console.log("The pop-up");
    await L.goto(`${BASE}/c/${slug}`, { timeout: 180000 });
    await L.waitForSelector("main", { timeout: 120000 });
    await L.waitForTimeout(1500);
    await say(O, group, "Lina, the patient in 3 is ready");
    check(await until(async () => (await L.locator("[data-team-popup]").count()) === 1), "a colleague's message pops up on another page");
    check((await L.locator("[data-team-popup]").innerText()).includes("Omar Doctor"), "with who wrote it");
    await L.locator("[data-team-popup-input]").fill("Going now");
    await L.locator("[data-team-popup-send]").click();
    check(await until(async () => (await q(`select 1 from team_messages where thread_id = $1 and sender_id = $2 and body = 'Going now'`, [group, lina.userId])).length === 1), "and is answered from the pop-up");
    check(await until(async () => (await L.locator("[data-team-popup-sent]").count()) === 1), "which says it was sent");

    await R.goto(`${BASE}/c/${slug}/conversations/team?t=${dm}`, { timeout: 180000 });
    await R.waitForSelector("[data-team-input]", { timeout: 120000 });
    await R.waitForTimeout(1500);
    await say(O, dm, "Quick one in this thread");
    await R.waitForTimeout(2500);
    check((await R.locator("[data-team-popup]").count()) === 0, "but not over the thread it is already showing");

    console.log("On a phone");
    const phone = await signIn(browser, omar.email, { width: 390, height: 844 });
    phone.on("pageerror", (e) => errors.push(e.message));
    await phone.goto(`${BASE}/c/${slug}/conversations/team?t=${group}`, { timeout: 180000 });
    await phone.waitForSelector("[data-team-input]", { timeout: 120000 });
    const width = (await phone.evaluate("document.documentElement.scrollWidth")) as number;
    check(width <= 390, "a thread does not scroll sideways", String(width));
    check(errors.length === 0, "no page errors", errors.join(" | "));
  } finally {
    await browser.close();
    await q(`delete from clinics where id = $1`, [clinic.id]).catch((e) => console.log("cleanup:", e.message));
    await q(`delete from users where email like $1`, [`%-${tag}@test.local`]).catch(() => {});
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
