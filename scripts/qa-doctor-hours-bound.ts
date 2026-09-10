/**
 * A doctor cannot be bookable while the clinic is shut.
 *
 * `effectiveHours` used to return a member's hours *instead of* the clinic's,
 * so a member's row could open the practice. It did: a doctor on the demo
 * workspace had Sunday saved as 00:00–17:00, and the public booking page duly
 * offered appointments from midnight — thirty-four slots that Sunday against
 * sixteen on every other day, at hours when nobody is in the building.
 *
 * The clinic's hours are the outer bound now, and the two directions both
 * matter: a doctor may work *less* than the clinic is open, never more.
 *
 *   npx tsx scripts/qa-doctor-hours-bound.ts
 */
import { effectiveHours, rangesForDay, type WeeklyHours } from "../src/lib/hours";
import { DateTime } from "luxon";

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

const CLINIC: WeeklyHours = {
  sun: [["09:00", "17:00"]],
  mon: [["09:00", "17:00"]],
  tue: [["09:00", "17:00"]],
  wed: [["09:00", "17:00"]],
  thu: [["09:00", "17:00"]],
  fri: [],
  sat: [["09:00", "17:00"]],
};

/** A Sunday, to read the `sun` key. */
const SUN = DateTime.fromISO("2026-09-13T12:00:00", { zone: "Asia/Amman" });
const SAT = DateTime.fromISO("2026-09-12T12:00:00", { zone: "Asia/Amman" });
const FRI = DateTime.fromISO("2026-09-11T12:00:00", { zone: "Asia/Amman" });

const on = (h: WeeklyHours, d: DateTime) => JSON.stringify(rangesForDay(h, d));

function main() {
  console.log("\n[the clinic's hours are the ceiling]");
  /*
    The exact row that caused this. A doctor's Sunday running from midnight must
    not open the clinic before nine.
  */
  const midnight = effectiveHours(CLINIC, { sun: [["00:00", "17:00"]] });
  check(
    "a doctor starting at midnight is held to opening time",
    on(midnight, SUN) === '[["09:00","17:00"]]',
    on(midnight, SUN)
  );

  const late = effectiveHours(CLINIC, { sun: [["09:00", "23:00"]] });
  check(
    "and one running past closing is held to closing time",
    on(late, SUN) === '[["09:00","17:00"]]',
    on(late, SUN)
  );

  console.log("\n[but a doctor may still work less]");
  const mornings = effectiveHours(CLINIC, { sun: [["10:00", "13:00"]] });
  check(
    "a shorter day is left exactly as it is",
    on(mornings, SUN) === '[["10:00","13:00"]]',
    on(mornings, SUN)
  );

  const split = effectiveHours(CLINIC, { sun: [["08:00", "11:00"], ["15:00", "20:00"]] });
  check(
    "each half of a split day is clipped separately",
    on(split, SUN) === '[["09:00","11:00"],["15:00","17:00"]]',
    on(split, SUN)
  );

  console.log("\n[days neither side is open]");
  /*
    A day missing from the doctor's map stays closed for them. That is a doctor
    who does not work Saturdays, not a gap to be filled in from the clinic — and
    it is what makes the demo link show nothing on Friday and Saturday.
  */
  const noSat = effectiveHours(CLINIC, { sun: [["09:00", "17:00"]] });
  check("a day the doctor omits stays closed", on(noSat, SAT) === "[]", on(noSat, SAT));

  const worksFri = effectiveHours(CLINIC, { fri: [["09:00", "17:00"]] });
  check(
    "a doctor cannot open a day the clinic closes",
    on(worksFri, FRI) === "[]",
    on(worksFri, FRI)
  );

  const disjoint = effectiveHours(CLINIC, { sun: [["18:00", "21:00"]] });
  check(
    "hours entirely outside the clinic's leave nothing",
    on(disjoint, SUN) === "[]",
    on(disjoint, SUN)
  );

  console.log("\n[a doctor with no hours of their own]");
  check("null takes the clinic's unchanged", effectiveHours(CLINIC, null) === CLINIC);
  check("an empty object does too", effectiveHours(CLINIC, {}) === CLINIC);

  console.log("\n[the shape the demo link was in]");
  /*
    Sixteen half-hour slots fit 09:00–17:00 for a 30-minute service, and
    thirty-four fit 00:00–17:00. That difference is what the booking page was
    showing, so it is worth asserting as the count rather than as a string.
  */
  const slotsIn = (h: WeeklyHours, d: DateTime, durMin: number, step: number) => {
    let n = 0;
    for (const [open, close] of rangesForDay(h, d)) {
      const [oh, om] = open.split(":").map(Number);
      const [ch, cm] = close.split(":").map(Number);
      for (let t = oh * 60 + om; t + durMin <= ch * 60 + cm; t += step) n++;
    }
    return n;
  };
  const before = slotsIn({ sun: [["00:00", "17:00"]] }, SUN, 30, 30);
  const after = slotsIn(midnight, SUN, 30, 30);
  check("the Sunday that showed 34 now shows 16", before === 34 && after === 16, `${before} → ${after}`);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main();
