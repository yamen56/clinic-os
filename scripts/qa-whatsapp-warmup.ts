/**
 * A new number does not get to send like an old one.
 *
 * Sending bulk from a freshly registered number is the pattern WhatsApp bans
 * for, and nothing in this codebase looked at a number's age: a clinic could
 * scan a QR on a new SIM and reach the full 300/day cap the same afternoon.
 * Every other rail — the randomised gaps, the blast guard, the auto-pause —
 * shapes *how* messages leave, not how much reputation the sender has earned.
 *
 * Also covers the metric that goes with it: outbound into conversations the
 * patient never replied in. That is the closest available proxy for a ban,
 * because WhatsApp bans on reports and Baileys is never told about those.
 *
 *   npx tsx scripts/qa-whatsapp-warmup.ts
 */
import { Client } from "pg";
import { effectiveDailyCap, rampCap, warmupDay } from "../src/lib/whatsapp-ramp";
import {
  silenceByClinic,
  concerning,
  SILENCE_MIN_VOLUME,
  SILENCE_ALERT_RATIO,
} from "../src/lib/whatsapp-health";

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

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

async function main() {
  /* ================================================== the ramp */
  console.log("\n[a number earns its allowance]");
  check("day one is twenty", rampCap(daysAgo(0)) === 20, String(rampCap(daysAgo(0))));
  check("it opens up each day", (rampCap(daysAgo(3)) ?? 0) > (rampCap(daysAgo(1)) ?? 0));
  /*
    The curve has to actually reach a normal clinic's cap, and reasonably soon.
    A ramp that never lets go is not a warm-up, it is a permanent throttle
    somebody will switch off entirely.
    */
  check("and reaches 300 within a fortnight", (rampCap(daysAgo(13)) ?? 1e9) >= 300, String(rampCap(daysAgo(13))));
  check("after three weeks there is no ramp at all", rampCap(daysAgo(22)) === null);

  console.log("\n[the ramp only ever lowers the cap]");
  check("a new number is held below its clinic's cap", effectiveDailyCap(300, daysAgo(0)) === 20);
  check("a warm number gets the full cap", effectiveDailyCap(300, daysAgo(60)) === 300);
  /*
    A clinic configured lower than the ramp keeps its own number. The ramp is a
    ceiling, never a floor — otherwise switching this on would *raise* the limit
    for a clinic that had deliberately set a small one.
  */
  check("a clinic capped below the ramp keeps its own", effectiveDailyCap(10, daysAgo(0)) === 10);
  check("an untracked session is treated as warm", effectiveDailyCap(300, null) === 300);
  /*
    A future timestamp — clock skew, or a row edited by hand — must not compute
    a cap *above* day one. Math.pow with a negative exponent would do exactly
    that, quietly, and only on the numbers that matter most.
  */
  check("a future anchor cannot buy a bigger allowance", effectiveDailyCap(300, daysAgo(-5)) === 20);

  console.log("\n[and it is legible]");
  check("day one reads as day 1", warmupDay(daysAgo(0)) === 1);
  check("day four reads as day 4", warmupDay(daysAgo(3)) === 4);
  check("a warm number has no day", warmupDay(daysAgo(60)) === null);

  /* ================================================== the silence ratio */
  const db = new Client({ connectionString: PG });
  await db.connect();
  const tag = Date.now().toString(36);
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug) values ('QA Warmup', 'إحماء', $1) returning id`,
      [`qawarm${tag}`]
    )
  ).rows[0];

  try {
    await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);

    console.log("\n[the warm-up anchor is stored per number]");
    const row = (
      await db.query(
        `select warmup_number, warmup_started_at from whatsapp_sessions where clinic_id = $1`,
        [clinic.id]
      )
    ).rows[0];
    check("a fresh session has no anchor yet", row.warmup_started_at === null);

    /*
      A conversation the patient wrote in, and one they never did. The ratio is
      about threads, not messages: ten replies inside a live conversation are
      not ten risks.
    */
    console.log("\n[messages into silence]");
    const patient = (
      await db.query(
        `insert into patients (clinic_id, full_name) values ($1, 'صامت') returning id`,
        [clinic.id]
      )
    ).rows[0];
    const mkConvo = async (phone: string) =>
      (
        await db.query(
          `insert into conversations (clinic_id, patient_id, phone_e164) values ($1, $2, $3) returning id`,
          [clinic.id, patient.id, phone]
        )
      ).rows[0].id as string;

    const talking = await mkConvo(`+96279${tag.slice(-6).padStart(6, "0")}`);
    const silent = await mkConvo(`+96278${tag.slice(-6).padStart(6, "0")}`);
    /*
      One statement per batch, not one per row. `Promise.all` over a single pg
      client does not parallelise anything — node-pg serialises queries on a
      connection — so it buys nothing and trips the "already executing a query"
      deprecation on the way.
    */
    const send = (convo: string, dir: "in" | "out", n: number) =>
      db.query(
        `insert into messages (clinic_id, conversation_id, direction, body, status, sender_kind)
         select $1, $2, $3, 'x', 'sent', 'staff' from generate_series(1, $4)`,
        [clinic.id, convo, dir, n]
      );

    await send(talking, "in", 2);
    await send(talking, "out", 30);
    await send(silent, "out", 70);

    // A raw Client satisfies everything silenceByClinic uses of a PoolClient.
    const rows = await silenceByClinic(db as unknown as Parameters<typeof silenceByClinic>[0], 30);
    const mine = rows.find((r) => r.clinicId === clinic.id);
    check("the clinic is measured", !!mine, mine ? `${mine.cold}/${mine.out}` : "missing");
    check("replies inside a live thread are not counted", mine?.out === 100, String(mine?.out));
    check("only the one-sided thread is cold", mine?.cold === 70, String(mine?.cold));
    check("the ratio is what it looks like", Math.round((mine?.ratio ?? 0) * 100) === 70);

    console.log("\n[but only above a volume floor]");
    check(
      "70% of 100 messages is worth saying something about",
      concerning(rows).some((r) => r.clinicId === clinic.id),
      `floor ${SILENCE_MIN_VOLUME}, threshold ${SILENCE_ALERT_RATIO}`
    );
    /*
      The same ratio on a handful of messages is noise, and alerting on it is
      how a metric gets ignored. Three of four unanswered is 75% and means
      nothing.
    */
    const quiet = concerning([
      { clinicId: "x", name: "Tiny", slug: "tiny", out: 4, cold: 3, ratio: 0.75 },
    ]);
    check("the same ratio on four messages is not", quiet.length === 0);
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
