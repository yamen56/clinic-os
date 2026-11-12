"use client";

/*
  The pieces of the public booking page that are not the flow itself: the
  clinic's colour worked into a small palette, the appointment card, the times,
  a clinic's own question, the calendar file. booking-wizard.tsx decides what
  is on screen; these draw it.
*/

import { useMemo, useState } from "react";
import { DateTime } from "luxon";
import type { PublicQuestion } from "@/lib/booking-intake";
import { CLINICTI_PRIVACY_URL } from "@/components/powered-by";
import { CalendarPlus, Clock, UserRound } from "lucide-react";

export type Slot = { startISO: string; doctorMemberId: string | null };

export type Doctor = {
  id: string;
  name: string;
  title: string | null;
  specialty: string | null;
  /** Whether there is a face to show instead of an initial. */
  hasPhoto: boolean;
};

/**
 * The clinic's one colour, as the handful the page needs.
 *
 * The page used to put white text on the clinic's colour wherever it filled
 * something, and the colour itself wherever it wrote something on white. Both
 * are right for a deep colour and unreadable for a pale one — a clinic whose
 * brand is a light mint got white-on-mint buttons, a progress line that was
 * not there, and mint-on-white links. So:
 *
 *  - `band` / `bandInk`: the header, in the clinic's colour exactly, written
 *    on in white or — on a pale colour — near-black.
 *  - `bk` / `ink`: what is pressed or chosen on the white sheet. The clinic's
 *    colour while it stands out from white (3:1), otherwise the same hue made
 *    darker until it does; white on it either way.
 *  - `soft` and `line`: that colour let down with white, for what is chosen.
 *
 * Mixed here rather than with `color-mix()`, which the phones still in use in
 * a clinic's waiting room do not all have.
 */
export function brandTokens(hex: string): {
  band: string;
  bandInk: string;
  bk: string;
  ink: string;
  soft: string;
  line: string;
} {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec((hex ?? "").trim());
  let h = m ? m[1] : "0b1220";
  if (h.length === 3) h = h.split("").map((ch) => ch + ch).join("");
  const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const againstWhite = (c: number[]) => 1.05 / (0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]) + 0.05);
  // Darker in steps, keeping the hue, until it reads on white.
  let act = rgb;
  for (let k = 0.9; againstWhite(act) < 3 && k > 0.15; k -= 0.05) act = rgb.map((v) => Math.round(v * k));
  const hexOf = (c: number[]) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  const mix = (share: number) => `rgb(${act.map((v) => Math.round(v * share + 255 * (1 - share))).join(" ")})`;
  return {
    band: `#${h}`,
    bandInk: againstWhite(rgb) >= 3 ? "#ffffff" : "#0b1220",
    bk: hexOf(act),
    ink: "#ffffff",
    soft: mix(0.08),
    line: mix(0.34),
  };
}

/**
 * The appointment, as the card a clinic hands over the desk.
 *
 * The stub carries the day, because the day is what a patient reads first off
 * a paper card and what they will look for when they open this page again;
 * the rest is what, when and with whom. It is the one place the page draws
 * anything that is not a list or a field.
 */
export function AppointmentCard({
  when,
  services,
  doctor,
  withLabel,
  length,
}: {
  /** In the clinic's time, already in the reader's language. */
  when: DateTime;
  /** Every service of the visit, first one first. */
  services: string[];
  doctor?: string;
  withLabel: string;
  /** "45 min" — the whole visit. */
  length: string;
}) {
  return (
    <div className="relative flex rounded-2xl border border-line bg-surface text-start shadow-card" data-booking-card>
      <div
        className="flex w-[5.25rem] shrink-0 flex-col items-center justify-center gap-1 rounded-s-[15px] px-2 py-4"
        style={{ background: "var(--bk)", color: "var(--bk-ink)" }}
      >
        <span className="text-[11.5px] font-semibold leading-none opacity-85">{when.toFormat("ccc")}</span>
        <span className="font-display text-[30px] font-bold leading-none tabular-nums">{when.day}</span>
        <span className="text-[11.5px] font-semibold leading-none opacity-85">{when.toFormat("LLL")}</span>
      </div>
      {/* Where the card tears: a dashed line and the two notches at its ends. */}
      <div className="relative w-0 shrink-0" aria-hidden>
        <span className="absolute inset-y-3 left-0 border-l border-dashed border-line-strong" />
        <span className="absolute -top-px left-0 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-line bg-surface [clip-path:inset(50%_0_0_0)]" />
        <span className="absolute -bottom-px left-0 h-4 w-4 -translate-x-1/2 translate-y-1/2 rounded-full border border-line bg-surface [clip-path:inset(0_0_50%_0)]" />
      </div>
      <div className="min-w-0 flex-1 px-4 py-3.5">
        <div className="font-display text-[20px] font-bold leading-none tabular-nums">{when.toFormat("h:mm a")}</div>
        <div className="mt-2 text-[14.5px] font-semibold leading-snug">{services.join(" + ")}</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink-500">
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Clock className="h-3.5 w-3.5" />
            {length}
          </span>
          {doctor && (
            <span className="inline-flex min-w-0 items-center gap-1">
              <UserRound className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">
                {withLabel} {doctor}
              </span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Times split into morning / afternoon / evening.
 *
 * A clinic open nine to seven at fifteen-minute granularity produces forty
 * buttons, and a flat grid of them is a wall rather than a choice. The headings
 * are how people already describe when they want to come.
 */
export function SlotGroups({
  slots,
  tz,
  fmtLocale,
  selected,
  onPick,
  labels,
}: {
  slots: Slot[];
  tz: string;
  fmtLocale: string;
  selected: string | null;
  onPick: (s: Slot) => void;
  labels: { morning: string; afternoon: string; evening: string };
}) {
  const groups = useMemo(() => {
    const out: { key: "morning" | "afternoon" | "evening"; items: Slot[] }[] = [
      { key: "morning", items: [] },
      { key: "afternoon", items: [] },
      { key: "evening", items: [] },
    ];
    for (const s of slots) {
      const h = DateTime.fromISO(s.startISO).setZone(tz).hour;
      out[h < 12 ? 0 : h < 17 ? 1 : 2].items.push(s);
    }
    return out.filter((g) => g.items.length);
  }, [slots, tz]);

  return (
    <div className="grid gap-4">
      {groups.map((g) => (
        <div key={g.key}>
          {groups.length > 1 && <div className="mb-2 text-[12px] font-semibold text-ink-500">{labels[g.key]}</div>}
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {g.items.map((s) => {
              const local = DateTime.fromISO(s.startISO).setZone(tz).setLocale(fmtLocale);
              const active = selected === s.startISO;
              return (
                <button
                  key={s.startISO}
                  type="button"
                  onClick={() => onPick(s)}
                  aria-pressed={active}
                  className="h-11 touch-manipulation rounded-xl border text-[14px] font-semibold tnum transition-colors"
                  style={
                    active
                      ? { background: "var(--bk)", borderColor: "var(--bk)", color: "var(--bk-ink)" }
                      : { borderColor: "var(--color-line-strong)", background: "var(--color-surface)" }
                  }
                >
                  {local.toFormat("h:mm a")}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/** One clinic-defined question, rendered as whatever type it was defined as. */
export function QuestionField({
  q,
  isAr,
  value,
  invalid,
  optionalLabel,
  choosePlaceholder,
  onChange,
}: {
  q: PublicQuestion;
  isAr: boolean;
  value: string | string[] | boolean | undefined;
  invalid: boolean;
  optionalLabel: string;
  choosePlaceholder: string;
  onChange: (v: string | string[] | boolean) => void;
}) {
  const label = isAr ? q.labelAr : q.label;
  const help = isAr ? q.helpAr : q.help;
  // The stored value is always the option as the clinic wrote it in `options`;
  // `optionsAr` is a display translation, never what gets sent.
  const optionLabel = (o: string, i: number) => (isAr ? q.optionsAr[i] ?? o : o);
  const ring = invalid ? "border-danger" : "border-line-strong";
  // 16px, or an iPhone zooms the page in on every field it focuses.
  const box = `w-full rounded-xl border ${ring} bg-surface px-4 text-[16px] outline-none focus:border-[var(--bk-text)]`;

  if (q.type === "checkbox") {
    return (
      <label className="flex cursor-pointer items-start gap-2.5">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 h-4.5 w-4.5 shrink-0 accent-[var(--bk-text)]"
        />
        <span className="text-[14px] leading-6">
          {label}
          {help && <span className="block text-[12px] text-ink-500">{help}</span>}
        </span>
      </label>
    );
  }

  return (
    <div>
      <span className="mb-1.5 block text-[13px] font-semibold">
        {label}
        {!q.required && <span className="ms-1.5 font-normal text-ink-400">{optionalLabel}</span>}
      </span>

      {q.type === "longtext" ? (
        <textarea
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          maxLength={2000}
          className={`${box} min-h-24 py-3`}
        />
      ) : q.type === "select" ? (
        <select
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          className={`${box} h-12 appearance-none`}
        >
          <option value="">{choosePlaceholder}</option>
          {q.options.map((o, i) => (
            <option key={o} value={o}>
              {optionLabel(o, i)}
            </option>
          ))}
        </select>
      ) : q.type === "multiselect" ? (
        <div className="flex flex-wrap gap-2">
          {q.options.map((o, i) => {
            const picked = Array.isArray(value) && value.includes(o);
            return (
              <button
                key={o}
                type="button"
                aria-pressed={picked}
                onClick={() =>
                  onChange(
                    picked
                      ? (value as string[]).filter((x) => x !== o)
                      : [...(Array.isArray(value) ? value : []), o]
                  )
                }
                className="min-h-10 touch-manipulation rounded-full border px-3.5 py-2 text-[13px] font-medium transition-colors"
                style={
                  picked
                    ? { background: "var(--bk)", borderColor: "var(--bk)", color: "var(--bk-ink)" }
                    : { borderColor: "var(--color-line-strong)", background: "var(--color-surface)" }
                }
              >
                {optionLabel(o, i)}
              </button>
            );
          })}
        </div>
      ) : (
        <input
          type={q.type === "date" ? "date" : q.type === "number" ? "number" : q.type === "email" ? "email" : q.type === "phone" ? "tel" : "text"}
          dir={q.type === "phone" || q.type === "email" || q.type === "number" ? "ltr" : undefined}
          inputMode={q.type === "phone" ? "tel" : q.type === "number" ? "numeric" : undefined}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          maxLength={200}
          className={`${box} h-12`}
        />
      )}

      {help && <p className="mt-1.5 text-[12px] leading-5 text-ink-500">{help}</p>}
    </div>
  );
}

/**
 * The appointment as a calendar entry.
 *
 * Built in the browser rather than fetched: the details are all on screen
 * already, and a download that needs a round trip is one more thing that can
 * fail on a phone with one bar of signal.
 */
export function AddToCalendar({
  url,
  label,
  startISO,
  minutes,
  title,
  location,
}: {
  label: string;
  startISO: string;
  minutes: number;
  title: string;
  location: string;
  /** An online meeting's join link, so the invite is clickable. */
  url?: string | null;
}) {
  const href = useMemo(() => {
    const start = DateTime.fromISO(startISO).toUTC();
    const stamp = (d: DateTime) => d.toFormat("yyyyLLdd'T'HHmmss'Z'");
    const esc = (s: string) => s.replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Clinicti//Booking//EN",
      "BEGIN:VEVENT",
      `UID:${startISO}-clinicti`,
      `DTSTAMP:${stamp(DateTime.utc())}`,
      `DTSTART:${stamp(start)}`,
      `DTEND:${stamp(start.plus({ minutes }))}`,
      `SUMMARY:${esc(title)}`,
      /*
        LOCATION carries the join link for an online meeting, because that is the
        field Google and Apple turn into a clickable join button. URL and
        DESCRIPTION are set as well: between the three, every calendar client
        worth having shows something you can press.
      */
      location ? `LOCATION:${esc(location)}` : "",
      url ? `URL:${esc(url)}` : "",
      url ? `DESCRIPTION:${esc(url)}` : "",
      "BEGIN:VALARM",
      "TRIGGER:-PT2H",
      "ACTION:DISPLAY",
      `DESCRIPTION:${esc(title)}`,
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ]
      .filter(Boolean)
      .join("\r\n");
    return `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`;
  }, [startISO, minutes, title, location, url]);

  return (
    <a
      href={href}
      download="appointment.ics"
      className="inline-flex h-11 items-center gap-2 rounded-full border border-line-strong bg-surface px-4 text-[13.5px] font-semibold"
    >
      <CalendarPlus className="h-4 w-4" />
      {label}
    </a>
  );
}

/*
  Shown on whichever step submits, not on the verify step: `submit` is what
  POSTs the details, and it commits the booking outright when the clinic's
  WhatsApp is offline — that path never reaches an OTP, so a notice living
  there would be skipped exactly when it matters.
*/
export function PrivacyNote({ t }: { t: { privacyConsent: string; privacy: string } }) {
  return (
    <p className="mt-4 text-center text-[11.5px] leading-5 text-ink-400">
      {t.privacyConsent.split("{link}")[0]}
      <a
        href={CLINICTI_PRIVACY_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-ink-500 no-underline transition-colors hover:text-ink-700"
      >
        {t.privacy}
      </a>
      {t.privacyConsent.split("{link}")[1]}
    </p>
  );
}

/**
 * The doctor's own face, falling back to their initial.
 *
 * The initial was all this ever showed, which on a page choosing between two
 * colleagues is the least useful thing about them — and the photo the clinic
 * already uploaded was sitting behind a route that requires a session.
 *
 * `hasPhoto` comes from the server, so the common cases never flicker. The
 * `failed` state is for the ones it cannot predict: a file deleted out of
 * storage between page load and render, or an image that will not decode.
 * Without it a broken photo leaves a blank circle where a name should be.
 */
export function DoctorFace({ bslug, doctor }: { bslug: string; doctor: Doctor }) {
  const [failed, setFailed] = useState(false);
  // The Arabic "د." prefix would otherwise make every avatar read the same
  // letter — but only a doctor carries it, and not every workspace books
  // doctors.
  const initial = doctor.name.replace(/^د\.\s*/, "").trim().slice(0, 1) || doctor.name.slice(0, 1);

  if (doctor.hasPhoto && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/api/public/book/${bslug}/doctor-photo/${doctor.id}`}
        alt=""
        width={48}
        height={48}
        loading="lazy"
        onError={() => setFailed(true)}
        className="h-12 w-12 shrink-0 rounded-full object-cover"
        style={{ background: "var(--color-sunken)" }}
      />
    );
  }
  return (
    <span
      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-[15px] font-bold"
      style={{ background: "var(--bk-soft)", color: "var(--bk-text)" }}
    >
      {initial}
    </span>
  );
}
