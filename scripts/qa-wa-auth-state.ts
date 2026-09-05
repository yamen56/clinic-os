/**
 * Does a WhatsApp session survive being written down and read back?
 *
 * This is the least forgiving storage in the product. Baileys keeps Signal
 * protocol material here — identity keys, sessions, pre-keys — as `Buffer`s
 * inside nested objects, and JSON has no idea what a Buffer is. Get the
 * encoding subtly wrong and nothing throws: the session simply fails to decrypt
 * later, and a clinic is told to scan a QR code again with no explanation.
 *
 * Written when the adapter was changed from one transaction per key to one per
 * batch. Pairing writes on the order of eight hundred pre-keys in a single
 * `keys.set` call, and doing that one round trip at a time is eight hundred
 * sequential waits with the socket held open — at sixty clinics reconnecting
 * after a restart, all at once. The batch is a large speed-up and a total
 * rewrite of the read and write paths, which is exactly when fidelity needs
 * proving rather than assuming.
 *
 *   npx tsx scripts/qa-wa-auth-state.ts
 */
import { Client } from "pg";
import { randomBytes } from "node:crypto";
/*
  Imported inside `main`, not at the top.

  Baileys pulls in an optional native bridge whose package publishes no CommonJS
  entry point. tsx compiles this script as CJS, so a static import resolves that
  through `require` and throws ERR_PACKAGE_PATH_NOT_EXPORTED before a single
  test runs; the ESM `import()` path finds it. The worker is unaffected — it is
  the shape of this file that provokes it — and either way the module under test
  is the real one.
*/

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

async function main() {
  const { useDbAuthState } = await import("../worker/wa/auth-state");
  const db = new Client({ connectionString: PG });
  await db.connect();
  const tag = Date.now().toString(36);
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug) values ('QA Auth', 'مصادقة', $1) returning id`,
      [`qaauth${tag}`]
    )
  ).rows[0];

  try {
    const { state, saveCreds, clear } = await useDbAuthState(clinic.id);

    /* ============================================ buffers survive the round trip */
    console.log("\n[the bytes come back as the same bytes]");
    const nested = {
      keyPair: { private: randomBytes(32), public: randomBytes(33) },
      registrationId: 12345,
      signedIdentity: { keyId: 7, signature: randomBytes(64) },
    };
    await state.keys.set({ "pre-key": { "1": nested } } as never);
    const back = (await state.keys.get("pre-key", ["1"])) as unknown as Record<string, typeof nested>;
    const got = back["1"];
    check("the key comes back at all", !!got);
    check(
      "a Buffer is still a Buffer",
      Buffer.isBuffer(got?.keyPair?.private),
      got?.keyPair?.private?.constructor?.name ?? "missing"
    );
    check(
      "and byte-for-byte identical",
      Buffer.compare(got.keyPair.private, nested.keyPair.private) === 0 &&
        Buffer.compare(got.keyPair.public, nested.keyPair.public) === 0
    );
    check(
      "a Buffer nested two levels down survives too",
      Buffer.compare(got.signedIdentity.signature, nested.signedIdentity.signature) === 0
    );
    check("numbers are not stringified", got.registrationId === 12345);

    /* ============================================ the batch */
    console.log("\n[a whole batch in one call]");
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 300; i++) many[String(i)] = { k: randomBytes(32), n: i };
    const t0 = Date.now();
    await state.keys.set({ session: many } as never);
    const ms = Date.now() - t0;
    const readBack = (await state.keys.get(
      "session",
      Object.keys(many)
    )) as unknown as Record<string, { k: Buffer; n: number }>;
    check("every one of 300 keys was stored", Object.keys(readBack).length === 300, `${ms}ms`);
    check(
      "all 300 round-trip byte-for-byte",
      Object.keys(many).every((id) =>
        Buffer.compare(readBack[id].k, (many[id] as { k: Buffer }).k) === 0
      )
    );
    check("and keep their own identity", readBack["299"].n === 299 && readBack["7"].n === 7);
    /*
      The point of the change, asserted as a ratio rather than a stopwatch.

      A fixed millisecond budget cannot tell these apart: reverting to one
      transaction per key made 300 writes take 241ms against a local database,
      which sails under any threshold generous enough not to be flaky. It is
      only against a *remote* database — four round trips per transaction, five
      milliseconds each — that the same code costs six seconds and pairing's
      eight hundred keys costs sixteen.

      So measure one write, then measure three hundred. Batched, the second is a
      small multiple of the first because it is still one transaction. Unbatched
      it is three hundred times it, whatever the latency happens to be, which is
      exactly the property that matters and the only one that survives being run
      on somebody else's hardware.
    */
    const s0 = Date.now();
    await state.keys.set({ session: { solo: { k: randomBytes(32), n: -1 } } } as never);
    const oneMs = Math.max(1, Date.now() - s0);
    check(
      "300 keys cost far less than 300 writes",
      ms < oneMs * 30,
      `${ms}ms for 300 vs ${oneMs}ms for one`
    );

    /* ============================================ deletion */
    console.log("\n[forgetting a key means forgetting it]");
    await state.keys.set({ session: { "1": null } } as never);
    const afterDelete = await state.keys.get("session", ["1", "2"]);
    check("the deleted key is gone", afterDelete["1"] === undefined);
    check("its neighbour is untouched", afterDelete["2"] !== undefined);

    /*
      Baileys sends writes and deletes together in one call — a used pre-key is
      removed in the same batch that stores the session it produced. Splitting
      them wrongly would either lose a session or resurrect a spent key.
    */
    console.log("\n[writes and deletes in the same batch]");
    await state.keys.set({
      session: { "2": null, "500": { k: randomBytes(8), n: 500 } },
    } as never);
    const mixed = (await state.keys.get("session", ["2", "500"])) as unknown as Record<string, { n: number }>;
    check("the delete in a mixed batch happened", mixed["2"] === undefined);
    check("and the write in the same batch happened", mixed["500"]?.n === 500);

    /* ============================================ absent keys */
    console.log("\n[asking for what is not there]");
    const none = await state.keys.get("session", ["nope-1", "nope-2"]);
    check("missing keys are simply absent", Object.keys(none).length === 0);
    const empty = await state.keys.get("session", []);
    check("an empty request is not an error", Object.keys(empty).length === 0);

    /* ============================================ creds */
    console.log("\n[the credentials themselves]");
    await saveCreds();
    const stored = (
      await db.query(`select value from whatsapp_auth_state where clinic_id = $1 and key = 'creds'`, [
        clinic.id,
      ])
    ).rows[0];
    check("creds are persisted", !!stored);
    const reopened = await useDbAuthState(clinic.id);
    check(
      "and a fresh adapter loads the same registration id",
      reopened.state.creds.registrationId === state.creds.registrationId,
      String(reopened.state.creds.registrationId)
    );

    /* ============================================ logout */
    console.log("\n[logging out takes it all]");
    await clear();
    const left = (
      await db.query(`select count(*)::int n from whatsapp_auth_state where clinic_id = $1`, [
        clinic.id,
      ])
    ).rows[0].n;
    check("nothing is left behind", Number(left) === 0, `${left} rows`);
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
