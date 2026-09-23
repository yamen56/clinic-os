import type { PoolClient } from "pg";

/**
 * Prescriptions: the shapes, the wording, and the few queries every caller
 * shares.
 *
 * Imported by the composer in the browser as well as by the server, so nothing
 * here may reach for a Node module — `PoolClient` is a type and disappears at
 * build. It is also inside the worker image (all of `src/lib` is), which is the
 * other reason it imports nothing outside this folder.
 */

export type RxLocale = "ar" | "en";

/** One medicine on a prescription, exactly as the doctor wrote it. */
export type RxItem = {
  name: string;
  dose: string;
  frequency: string;
  duration: string;
  instructions: string;
};

export const MAX_ITEMS = 20;
const MAX_FIELD = 200;

export const emptyItem = (): RxItem => ({ name: "", dose: "", frequency: "", duration: "", instructions: "" });

/**
 * What arrives from a form, made safe to store: trimmed, capped, and without
 * the rows the doctor added and never filled. A row without a medicine name is
 * not a medicine, whatever else was typed on it.
 */
export function cleanItems(raw: unknown): RxItem[] {
  if (!Array.isArray(raw)) return [];
  const out: RxItem[] = [];
  for (const r of raw.slice(0, MAX_ITEMS)) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const f = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "").trim().slice(0, MAX_FIELD);
    const item = {
      name: f("name"),
      dose: f("dose"),
      frequency: f("frequency"),
      duration: f("duration"),
      instructions: f("instructions"),
    };
    if (item.name) out.push(item);
  }
  return out;
}

/*
  The one-tap answers under each field.

  Written out in both languages rather than translated on the fly, because the
  prescription's language is the writer's choice per prescription, not the
  screen's — an Arabic workspace sending an English prescription needs English
  buttons. Each keeps a key so switching language can carry a tapped answer
  across instead of leaving Arabic text on an English prescription.
*/
export type RxChip = { key: string; ar: string; en: string };

export const RX_CHIPS: Record<"dose" | "frequency" | "duration" | "instructions", RxChip[]> = {
  dose: [
    { key: "tab1", ar: "حبة واحدة", en: "1 tablet" },
    { key: "tab2", ar: "حبتان", en: "2 tablets" },
    { key: "cap1", ar: "كبسولة واحدة", en: "1 capsule" },
    { key: "ml5", ar: "5 مل", en: "5 ml" },
  ],
  frequency: [
    { key: "od", ar: "مرة يومياً", en: "Once a day" },
    { key: "bd", ar: "مرتين يومياً", en: "Twice a day" },
    { key: "tds", ar: "3 مرات يومياً", en: "3 times a day" },
    { key: "q8h", ar: "كل 8 ساعات", en: "Every 8 hours" },
    { key: "hs", ar: "قبل النوم", en: "At bedtime" },
    { key: "prn", ar: "عند الحاجة", en: "When needed" },
  ],
  duration: [
    { key: "3d", ar: "3 أيام", en: "3 days" },
    { key: "5d", ar: "5 أيام", en: "5 days" },
    { key: "7d", ar: "7 أيام", en: "7 days" },
    { key: "10d", ar: "10 أيام", en: "10 days" },
    { key: "14d", ar: "14 يوماً", en: "14 days" },
    { key: "1m", ar: "شهر", en: "1 month" },
    { key: "ongoing", ar: "مستمر", en: "Ongoing" },
  ],
  instructions: [
    { key: "after", ar: "بعد الأكل", en: "After food" },
    { key: "before", ar: "قبل الأكل", en: "Before food" },
    { key: "empty", ar: "على معدة فارغة", en: "On an empty stomach" },
  ],
};

/**
 * Carries the tapped answers across a language switch.
 *
 * Only exact matches move: a value the doctor typed is theirs, and guessing at
 * a translation of free text would put words in their mouth on a medical
 * document.
 */
export function switchItemLanguage(item: RxItem, from: RxLocale, to: RxLocale): RxItem {
  const swap = (field: keyof typeof RX_CHIPS, value: string) => {
    const chip = RX_CHIPS[field].find((c) => c[from] === value.trim());
    return chip ? chip[to] : value;
  };
  return {
    ...item,
    dose: swap("dose", item.dose),
    frequency: swap("frequency", item.frequency),
    duration: swap("duration", item.duration),
    instructions: swap("instructions", item.instructions),
  };
}

/** The details of one medicine on one line: "1 tablet · 3 times a day · 7 days · After food". */
export function itemDetail(item: RxItem): string {
  return [item.dose, item.frequency, item.duration, item.instructions].filter((s) => s.trim()).join(" · ");
}

/**
 * The medicines as they read in the WhatsApp caption.
 *
 * Numbered, one medicine to a line with its instructions indented beneath it —
 * the patient reads this on a phone, standing in a pharmacy, so it is laid out
 * for scanning rather than for a page.
 */
export function formatMedicineLines(items: RxItem[]): string {
  return items
    .map((it, i) => {
      const detail = itemDetail(it);
      return detail ? `${i + 1}. ${it.name}\n   ${detail}` : `${i + 1}. ${it.name}`;
    })
    .join("\n");
}

/** What a prescription is called out loud and on paper: RX-0042. */
export function rxNumber(n: number): string {
  return `RX-${String(n).padStart(4, "0")}`;
}

export function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? "";
}

/* ------------------------------------------------------------------ server */

/**
 * The next number in the clinic's own series.
 *
 * Taken with an update-returning on the clinic row, the way receipt numbers
 * are, so two prescriptions written at the same moment cannot share one — the
 * row lock serialises them and the unique index would refuse it anyway.
 */
export async function allocatePrescriptionNumber(c: PoolClient, clinicId: string): Promise<number> {
  const r = await c.query(
    `update clinics set prescription_counter = prescription_counter + 1
      where id = $1 returning prescription_counter`,
    [clinicId]
  );
  return r.rows[0].prescription_counter as number;
}

/**
 * Teaches the clinic's list what was just prescribed.
 *
 * Each medicine is remembered with the way it was written this time, so the
 * next time it is picked the rest of the line fills itself in. A blank field
 * does not erase what was remembered — a doctor who skipped the duration once
 * has not decided the medicine no longer has one.
 *
 * One statement for the whole prescription. The same medicine twice on one
 * prescription is folded first, because an upsert that touches a row twice in
 * one statement is an error rather than a second update.
 */
export async function learnMedications(c: PoolClient, clinicId: string, items: RxItem[]): Promise<void> {
  const seen = new Map<string, RxItem>();
  for (const it of items) seen.set(it.name.trim().toLowerCase(), it);
  if (!seen.size) return;
  await c.query(
    `insert into medications (clinic_id, name, dose, frequency, duration, instructions, use_count, last_used_at)
     select $1, x.name, x.dose, x.frequency, x.duration, x.instructions, 1, now()
       from jsonb_to_recordset($2::jsonb)
         as x(name text, dose text, frequency text, duration text, instructions text)
     on conflict (clinic_id, lower(btrim(name))) do update set
       name = excluded.name,
       dose = coalesce(nullif(excluded.dose, ''), medications.dose),
       frequency = coalesce(nullif(excluded.frequency, ''), medications.frequency),
       duration = coalesce(nullif(excluded.duration, ''), medications.duration),
       instructions = coalesce(nullif(excluded.instructions, ''), medications.instructions),
       use_count = medications.use_count + 1,
       last_used_at = now()`,
    // Stringified by hand: node-pg sends a JS array as a Postgres array literal,
    // which jsonb then refuses.
    [clinicId, JSON.stringify([...seen.values()])]
  );
}

/** A prescription as the patient file lists it. */
export type PrescriptionRow = {
  id: string;
  number: number;
  created_at: string;
  locale: RxLocale;
  diagnosis: string;
  items: RxItem[];
  doctor_member_id: string | null;
  doctor_name: string;
  author_id: string | null;
  author_name: string | null;
  signed: boolean;
  has_pdf: boolean;
  sent_at: string | null;
  message_id: string | null;
  /** Written by somebody other than the doctor it names — an assistant, usually. */
  by_other: boolean;
  /** The WhatsApp message's own status, when it was sent: queued → read. */
  message_status: string | null;
};

const ROW_SELECT = `
  select rx.id, rx.number, rx.created_at, rx.locale, rx.diagnosis, rx.items,
         rx.doctor_member_id, rx.doctor_name, rx.author_id, au.full_name as author_name,
         rx.signed, rx.pdf_path is not null as has_pdf, rx.sent_at, rx.message_id,
         m.status as message_status,
         coalesce(dm.user_id <> rx.author_id, false) as by_other
    from prescriptions rx
    left join users au on au.id = rx.author_id
    left join clinic_members dm on dm.id = rx.doctor_member_id
    left join messages m on m.id = rx.message_id`;

/**
 * The patient's prescriptions as a json column, for folding into a query the
 * page already makes. The patient file loads a dozen things on one connection,
 * where every extra statement is another round trip in series — so this rides
 * inside the patient select rather than adding one.
 *
 * `$1` is the patient id and `$2` the clinic id, matching the caller.
 */
export const PATIENT_PRESCRIPTIONS_JSON = `(
  select coalesce(json_agg(r order by r.created_at desc), '[]'::json) from (
    ${ROW_SELECT}
     where rx.patient_id = $1 and rx.clinic_id = $2
     order by rx.created_at desc
     limit 100
  ) r
)`;

/** One prescription in the same shape. `$1` is its id, `$2` the clinic. */
export const PRESCRIPTION_ROW_SQL = `${ROW_SELECT} where rx.id = $1 and rx.clinic_id = $2`;
