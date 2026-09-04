/**
 * Can one caller take the platform down?
 *
 * Written after an audit of the public surface found the answer was yes, three
 * different ways: the slot scan — the most expensive thing an anonymous request
 * can ask for — had no limit on it at all, no statement could ever be cancelled
 * so twelve slow ones held every connection the process owned, and every public
 * POST buffered a body of whatever size it was sent before validating a byte.
 *
 * Each of those is checked here at the layer it actually lives at. The counting
 * is exercised directly rather than through a browser, the way
 * `qa-auth-throttle.ts` tests the auth throttle: what is worth proving is the
 * arithmetic and the windowing, and 300 real page loads would prove the same
 * thing far more slowly while poisoning the bucket for the next suite.
 *
 *   npx tsx scripts/qa-dos.ts
 *
 * Needs the local stack (`npm run dev:all`) for the two live checks at the end.
 */

/*
  Set before `../src/lib/db` is ever loaded: the timeout is read once at module
  scope, and the point of this suite is to watch a statement actually be
  cancelled rather than to read the constant back. Hence the dynamic import
  further down — a static one would be hoisted above this line.
*/
process.env.PG_STATEMENT_TIMEOUT_MS = "1500";

import { Client } from "pg";
import fs from "node:fs";
import path from "node:path";
import { allow, resetFloodGate, floodKey, FLOOD_MAX } from "../src/lib/flood-gate";
import { takePublicSlot, publicLoad, readJsonCapped } from "../src/lib/public-guard";

const BASE = "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** A Request carrying a body of exactly `bytes`, with no Content-Length. */
function chunkedRequest(bytes: number): Request {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const chunk = new Uint8Array(16 * 1024).fill(0x20);
      let sent = 0;
      while (sent < bytes) {
        const n = Math.min(chunk.byteLength, bytes - sent);
        c.enqueue(chunk.subarray(0, n));
        sent += n;
      }
      c.close();
    },
  });
  // duplex is required by undici whenever a stream is the body.
  return new Request("http://x/", { method: "POST", body, ...({ duplex: "half" } as object) });
}

async function main() {
  /* ========================================== the flood gate, in front of it all */
  console.log("\n[the flood gate: one machine, every public page]");
  resetFloodGate();
  const t0 = 1_000_000;
  let allowed = 0;
  for (let i = 0; i < FLOOD_MAX + 20; i++) if (allow("1.2.3.4", t0)) allowed++;
  check("it allows exactly the budget", allowed === FLOOD_MAX, `${allowed} of ${FLOOD_MAX}`);
  check("and refuses past it", !allow("1.2.3.4", t0));
  check("a different address is untouched", allow("5.6.7.8", t0));
  // The window has to actually roll, or a single burst bans an address forever.
  check("the window reopens", allow("1.2.3.4", t0 + 61_000));

  /*
    The regression that has already happened once in this codebase, in
    `clientIp`: reading the leftmost X-Forwarded-For entry lets the caller
    choose their own bucket by prepending a fake address, and the limit then
    never applies to anybody. Only the rightmost entry was written by our proxy.
  */
  console.log("\n[whose address it is]");
  check(
    "the rightmost forwarded address wins",
    floodKey("9.9.9.9, 10.0.0.1, 172.16.0.4", null) === "172.16.0.4"
  );
  check(
    "a spoofed prefix cannot mint a new bucket",
    floodKey("evil, 172.16.0.4", null) === "172.16.0.4"
  );
  check("x-real-ip is the fallback", floodKey(null, "8.8.8.8") === "8.8.8.8");
  /*
    An unidentifiable caller is not counted, rather than sharing one bucket with
    every other unidentifiable caller. Folding them together would rate-limit
    the whole internet as a single visitor the moment a proxy stopped setting
    the header — every public page dark at 300 requests a minute, worldwide, and
    silently. The flood this guards against is less bad than that.
  */
  check("an unidentifiable caller is not counted", floodKey(null, null) === null);

  /* ========================================== the pool allowance */
  console.log("\n[the pool allowance: strangers never get every connection]");
  const max = publicLoad().max;
  check("public work is capped below the pool", max < Number(process.env.PG_POOL_MAX || 12), `${max}`);
  const held: { release: () => void }[] = [];
  for (let i = 0; i < max; i++) {
    const s = takePublicSlot();
    if (s) held.push(s);
  }
  check("the allowance is handed out in full", held.length === max, `${held.length}`);
  check("and the next caller is shed, not queued", takePublicSlot() === null);
  held[0].release();
  const after = takePublicSlot();
  check("releasing returns capacity", after !== null);
  /*
    A double release would credit an allowance we never took, which hands out
    more of the pool than exists — the failure this whole file is about, caused
    by the thing meant to prevent it.
  */
  const before = publicLoad().inFlight;
  held[0].release();
  check("a double release credits nothing", publicLoad().inFlight === before, `${before}`);
  after?.release();
  for (const s of held.slice(1)) s.release();
  check("everything is handed back", publicLoad().inFlight === 0, `${publicLoad().inFlight}`);

  /* ========================================== body ceilings */
  console.log("\n[body ceilings: what we can be made to hold]");
  const small = new Request("http://x/", { method: "POST", body: JSON.stringify({ a: 1 }) });
  const okRead = await readJsonCapped<{ a: number }>(small, 1024);
  check("a normal body is read", okRead.ok && okRead.body.a === 1);

  const declared = new Request("http://x/", {
    method: "POST",
    body: "x".repeat(5000),
    headers: { "content-length": "5000" },
  });
  const dRes = await readJsonCapped(declared, 1024);
  check("an oversized Content-Length is refused", !dRes.ok && dRes.res.status === 413);

  /*
    The one that matters. A chunked request declares no length, so the header is
    a hint and not a guarantee — if only the header were checked, saying nothing
    would buy an attacker an unlimited body.
  */
  const chunked = await readJsonCapped(chunkedRequest(64 * 1024), 8 * 1024);
  check("a chunked body over the cap is refused too", !chunked.ok && chunked.res.status === 413);

  const bad = new Request("http://x/", { method: "POST", body: "{not json" });
  const bRes = await readJsonCapped(bad, 1024);
  check("bad JSON is a 400, not a 413", !bRes.ok && bRes.res.status === 400);

  /* ========================================== statement timeout */
  console.log("\n[no statement may hold a connection forever]");
  const { withSystem } = await import("../src/lib/db");
  const shown = await withSystem(async (c) => (await c.query("show statement_timeout")).rows[0]);
  check(
    "the timeout reaches the session",
    shown.statement_timeout === "1500ms",
    String(shown.statement_timeout)
  );
  let cancelled = "";
  try {
    await withSystem((c) => c.query("select pg_sleep(4)"));
  } catch (e) {
    cancelled = String((e as { code?: string }).code ?? (e as Error).message);
  }
  // 57014 is query_canceled. Proving the constant is set proves nothing; this
  // proves Postgres acts on it.
  check("a slow statement is actually cancelled", cancelled === "57014", cancelled || "it completed");

  /* ========================================== coverage: no public route unguarded */
  console.log("\n[every public endpoint counts its callers]");
  const publicDir = path.join("src", "app", "api", "public");
  const routes: string[] = [];
  (function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "route.ts") routes.push(p);
    }
  })(publicDir);
  check("public routes were found at all", routes.length > 5, `${routes.length}`);
  const unguarded = routes.filter((r) => !fs.readFileSync(r, "utf8").includes("rateLimit("));
  /*
    This is the check that would have caught the slot scan, which sat unmetered
    next to a guarded sibling for as long as both existed. It was found by
    reading the directory; nothing failed. A rule beats a reading.
  */
  check("none of them is unmetered", unguarded.length === 0, unguarded.join(", "));

  console.log("\n[the gate is wired, not merely written]");
  const mw = fs.readFileSync(path.join("src", "middleware.ts"), "utf8");
  check("the middleware calls the flood gate", /\ballow\(/.test(mw) && mw.includes("flood-gate"));
  for (const p of ["/book/:path*", "/inv/:path*", "/sign/:path*", "/login", "/api/public/:path*"]) {
    check(`the matcher covers ${p}`, mw.includes(`"${p}"`));
  }

  /* ========================================== live, against the running app */
  console.log("\n[live: the slot scan refuses a loop]");
  const db = new Client({ connectionString: PG });
  await db.connect();
  const slug = `qados${Date.now().toString(36)}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug) values ('QA DoS', 'عيادة الضغط', $1) returning id`,
      [slug]
    )
  ).rows[0];
  try {
    await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
    await db.query(
      `insert into booking_links (clinic_id, slug, min_notice_min) values ($1, $2, 60)`,
      [clinic.id, slug]
    );
    const service = (
      await db.query(
        `insert into services (clinic_id, name, name_ar, duration_min, price)
         values ($1, 'Checkup', 'كشفية', 30, 15) returning id`,
        [clinic.id]
      )
    ).rows[0];

    const date = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
    const url = `${BASE}/api/public/book/${slug}/slots?serviceId=${service.id}&date=${date}`;
    let first = 0;
    let limited = 0;
    for (let i = 0; i < 60; i++) {
      const r = await fetch(url);
      if (i === 0) first = r.status;
      if (r.status === 429) limited++;
    }
    check("the first call is served", first === 200, `HTTP ${first}`);
    check("a loop over it is refused", limited > 0, `${limited} of 60 refused`);

    console.log("\n[live: an oversized body is refused before it is parsed]");
    const big = "x".repeat(6 * 1024 * 1024);
    const r = await fetch(`${BASE}/api/public/sign/nosuchtoken/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ png: big }),
    });
    check("a 6 MB signature post is a 413", r.status === 413, `HTTP ${r.status}`);
  } finally {
    await db.query(`delete from clinics where id = $1`, [clinic.id]);
    await db.end();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
