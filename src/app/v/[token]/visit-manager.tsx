"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DateTime } from "luxon";
import type { Dict } from "@/lib/i18n/en";
import type { VisitRights } from "@/lib/visit-link";
import { PoweredBy, PrivacyLink } from "@/components/powered-by";
import { AddToCalendar, AppointmentCard, SlotGroups, brandTokens, type Slot } from "@/app/book/[bslug]/booking-parts";
import { CalendarClock, CalendarX, Check, MapPin, MessageCircle, Phone, Video, X } from "lucide-react";

type Words = { book: Dict["book"]; visit: Dict["visit"] };
type Mode = "view" | "move" | "cancel" | "moved" | "cancelled";

const REASONS = ["cant_make_it", "feel_better", "booked_elsewhere", "other"] as const;

/**
 * One appointment, the patient's own: change the time or cancel it (0115).
 *
 * Laid out like the booking page — the clinic's band, one white sheet, the
 * step's action held at the bottom of the phone — because it is the same
 * clinic and very often the same patient a week later. What the buttons offer
 * comes from the server (`rights`); the routes check it all again.
 */
export function VisitManager({
  token,
  words,
  clinic,
  visit,
  rights: initialRights,
  cutoffHours,
  maxDaysAhead,
  bookUrl,
}: {
  token: string;
  words: { en: Words; ar: Words };
  clinic: {
    name: string;
    nameAr: string | null;
    slug: string;
    hasLogo: boolean;
    brandColor: string;
    address: string | null;
    addressAr: string | null;
    mapsUrl: string | null;
    phone: string | null;
    waNumber: string | null;
    tz: string;
    defaultLocale: "ar" | "en";
    /** Clinic Pro's own branding: no Clinicti credit. */
    whiteLabel?: boolean;
  };
  visit: {
    status: string;
    startISO: string;
    endISO: string;
    firstName: string;
    services: { en: string; ar: string };
    doctor: string | null;
    meetingUrl: string | null;
  };
  rights: VisitRights;
  cutoffHours: number;
  maxDaysAhead: number;
  bookUrl: string | null;
}) {
  const [locale, setLocale] = useState<"ar" | "en">(clinic.defaultLocale);
  const isAr = locale === "ar";
  const tb = words[locale].book;
  const t = words[locale].visit;
  const brand = useMemo(() => brandTokens(clinic.brandColor), [clinic.brandColor]);
  const fmtLocale = isAr ? "ar-JO-u-nu-latn" : "en-GB";

  const [mode, setMode] = useState<Mode>("view");
  const [at, setAt] = useState({ startISO: visit.startISO, endISO: visit.endISO });
  const [rights, setRights] = useState<VisitRights>(initialRights);
  const [status, setStatus] = useState(visit.status);
  const [date, setDate] = useState(() => DateTime.now().setZone(clinic.tz).toISODate()!);
  const [dayCounts, setDayCounts] = useState<Record<string, number> | null>(null);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0);

  const clinicName = isAr ? clinic.nameAr || clinic.name : clinic.name;
  const address = isAr ? clinic.addressAr || clinic.address : clinic.address;
  const service = isAr ? visit.services.ar : visit.services.en;
  const minutes = Math.max(1, Math.round((Date.parse(at.endISO) - Date.parse(at.startISO)) / 60_000));
  const when = DateTime.fromISO(at.startISO).setZone(clinic.tz).setLocale(fmtLocale);
  const waDigits = (clinic.waNumber ?? clinic.phone ?? "").replace(/\D/g, "");

  const days = useMemo(() => {
    const today = DateTime.now().setZone(clinic.tz).startOf("day");
    return Array.from({ length: Math.max(1, Math.min(maxDaysAhead, 30)) }, (_, i) => today.plus({ days: i }));
  }, [clinic.tz, maxDaysAhead]);

  // Which days have another time, once, when the patient opens "Change the time".
  useEffect(() => {
    if (mode !== "move") return;
    let alive = true;
    setDayCounts(null);
    fetch(`/api/public/visit/${token}/days`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive || !d.counts) return;
        setDayCounts(d.counts);
        setDate((cur) => (d.counts[cur] > 0 ? cur : Object.keys(d.counts).sort().find((k) => d.counts[k] > 0) ?? cur));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [mode, token, nonce]);

  useEffect(() => {
    if (mode !== "move") return;
    let alive = true;
    setSlots(null);
    setSlot(null);
    fetch(`/api/public/visit/${token}/slots?date=${date}`)
      .then((r) => r.json())
      .then((d) => {
        if (alive) setSlots(d.slots ?? []);
      })
      .catch(() => {
        if (alive) setSlots([]);
      });
    return () => {
      alive = false;
    };
  }, [mode, token, date, nonce]);

  // The chosen day kept in view, as on the booking page.
  const dayRefs = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    if (mode !== "move") return;
    dayRefs.current.get(date)?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [date, mode]);

  const anyOpen = dayCounts ? Object.values(dayCounts).some((n) => n > 0) : true;
  const nextOpen = useMemo(() => {
    if (!dayCounts) return null;
    const last = days[days.length - 1]?.toISODate();
    return Object.keys(dayCounts).sort().find((k) => dayCounts[k] > 0 && k > date && (!last || k <= last)) ?? null;
  }, [dayCounts, date, days]);

  const move = async () => {
    if (!slot || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/public/visit/${token}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startISO: slot.startISO, locale }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (d.error === "slot_taken") {
          setError(t.timeTaken);
          setNonce((n) => n + 1);
        } else if (d.error === "not_allowed") {
          setRights((r) => ({ ...r, move: false, why: d.why ?? r.why }));
          setMode("view");
        } else {
          setError(tb.genericError);
        }
        return;
      }
      setAt({ startISO: d.startISO, endISO: d.endISO });
      setRights(d.rights);
      setMode("moved");
    } catch {
      setError(tb.genericError);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/public/visit/${token}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, locale }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (d.error === "not_allowed") {
          setRights({ cancel: false, move: false, why: d.why ?? "closed" });
          setMode("view");
        } else {
          setError(tb.genericError);
        }
        return;
      }
      setStatus("cancelled");
      setRights({ cancel: false, move: false, why: "closed" });
      setMode("cancelled");
    } catch {
      setError(tb.genericError);
    } finally {
      setBusy(false);
    }
  };

  /** Why the link can do less than everything, in the patient's words. */
  const whyText =
    rights.why === "closed"
      ? status === "cancelled"
        ? t.whyCancelled
        : t.whyDone
      : rights.why === "past"
        ? t.whyPast
        : rights.why === "off"
          ? t.whyOff
          : rights.why === "too_late"
            ? t.whyTooLate.replace("{hours}", String(cutoffHours))
            : rights.why === "cancel_only"
              ? t.whyCancelOnly
              : rights.why === "moves_used"
                ? t.whyMovesUsed
                : rights.why === "not_online"
                  ? t.whyNotOnline
                  : "";
  /** The clinic's phone and WhatsApp, when the answer is "contact the clinic". */
  const showContact = rights.why === "off" || rights.why === "too_late" || rights.why === "moves_used" || rights.why === "cancel_only" || rights.why === "not_online";

  const statusLine = (t.statuses as Record<string, string>)[status] ?? "";
  const live = status !== "cancelled" && rights.why !== "closed" && rights.why !== "past";

  let bar: React.ReactNode = null;
  if (mode === "move") {
    bar = (
      <>
        <GhostBtn onClick={() => { setError(""); setMode("view"); }} label={tb.back} />
        <PrimaryBtn disabled={!slot || busy} busy={busy} onClick={() => void move()} label={t.moveHere} />
      </>
    );
  } else if (mode === "cancel") {
    bar = (
      <>
        <GhostBtn onClick={() => { setError(""); setMode("view"); }} label={t.keep} />
        <button
          type="button"
          onClick={() => void cancel()}
          disabled={busy}
          className="inline-flex h-12 min-w-[9rem] shrink-0 touch-manipulation items-center justify-center gap-2 rounded-full bg-danger px-6 text-[0.9375rem] font-semibold text-white shadow-card disabled:opacity-40"
          data-visit-confirm-cancel
        >
          {busy && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
          {t.confirmCancel}
        </button>
      </>
    );
  }

  const card = (
    <AppointmentCard
      when={when}
      services={service ? [service] : []}
      doctor={visit.doctor ?? undefined}
      withLabel={tb.with}
      length={`${minutes} ${tb.duration}`}
    />
  );

  return (
    <main
      dir={isAr ? "rtl" : "ltr"}
      className="theme-light min-h-dvh bg-sunken text-ink-900"
      data-visit-mode={mode}
      style={
        {
          "--band": brand.band,
          "--band-ink": brand.bandInk,
          "--bk": brand.bk,
          "--bk-ink": brand.ink,
          "--bk-text": brand.bk,
          "--bk-soft": brand.soft,
          "--bk-line": brand.line,
        } as React.CSSProperties
      }
    >
      <header
        className="px-4 pb-12 pt-[max(1.5rem,env(safe-area-inset-top))]"
        style={{ background: "var(--band)", color: "var(--band-ink)" }}
      >
        <div className="mx-auto flex max-w-lg items-center gap-3.5">
          {clinic.hasLogo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/api/public/clinic-logo/${clinic.slug}`} alt="" className="h-14 w-14 shrink-0 rounded-2xl bg-white object-contain p-1" />
          ) : (
            <span
              className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-white font-display text-[1.375rem] font-bold"
              style={{ color: "var(--bk)" }}
            >
              {clinicName.slice(0, 1)}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-[1.1875rem] font-bold leading-tight">{clinicName}</h1>
            {address && (
              <a href={clinic.mapsUrl ?? undefined} target="_blank" rel="noreferrer" className="mt-1 flex items-center gap-1 text-[0.8125rem] opacity-85">
                <MapPin className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{address}</span>
              </a>
            )}
          </div>
          <button
            type="button"
            onClick={() => setLocale(isAr ? "en" : "ar")}
            aria-label={isAr ? "English" : "العربية"}
            className="grid h-10 min-w-10 shrink-0 touch-manipulation place-items-center rounded-full border px-3 text-[0.8125rem] font-semibold"
            style={{ borderColor: brand.bandInk === "#ffffff" ? "rgba(255,255,255,0.45)" : "rgba(11,18,32,0.25)" }}
          >
            {isAr ? "EN" : "ع"}
          </button>
        </div>
      </header>

      <div className="mx-auto -mt-7 max-w-lg px-3 sm:px-4">
        <div className="rounded-[22px] bg-surface shadow-pop">
          <div className="px-5 pb-6 pt-5 sm:px-6">
            {mode === "view" && (
              <section className="animate-fade-up motion-reduce:animate-none" data-visit-view>
                <p className="text-[0.8125rem] font-medium text-ink-500">{t.hello.replace("{name}", visit.firstName)}</p>
                <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                  <h2 className="font-display text-[1.3125rem] font-bold leading-tight">{t.title}</h2>
                  {statusLine && (
                    <span
                      className="rounded-full px-2.5 py-1 text-[0.75rem] font-semibold"
                      style={
                        status === "cancelled"
                          ? { background: "var(--color-danger-soft)", color: "var(--color-danger)" }
                          : { background: "var(--bk-soft)", color: "var(--bk-text)" }
                      }
                      data-visit-status={status}
                    >
                      {statusLine}
                    </span>
                  )}
                </div>
                <div className={`mt-5 ${live ? "" : "opacity-60"}`}>{card}</div>

                {live && visit.meetingUrl && (
                  <a
                    href={visit.meetingUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-4 inline-flex h-12 w-full items-center justify-center gap-2 rounded-full px-5 text-[0.9375rem] font-semibold"
                    style={{ background: "var(--bk)", color: "var(--bk-ink)" }}
                  >
                    <Video className="h-4 w-4" />
                    {tb.joinMeeting}
                  </a>
                )}

                {(rights.move || rights.cancel) && (
                  <div className="mt-6 grid gap-2.5">
                    {rights.move && (
                      <button
                        type="button"
                        onClick={() => {
                          setError("");
                          setSlot(null);
                          setMode("move");
                        }}
                        className="inline-flex h-12 w-full touch-manipulation items-center justify-center gap-2 rounded-full px-5 text-[0.9375rem] font-semibold shadow-card"
                        style={{ background: "var(--bk)", color: "var(--bk-ink)" }}
                        data-visit-change
                      >
                        <CalendarClock className="h-4.5 w-4.5" />
                        {t.changeTime}
                      </button>
                    )}
                    {rights.cancel && (
                      <button
                        type="button"
                        onClick={() => {
                          setError("");
                          setReason(null);
                          setMode("cancel");
                        }}
                        className="inline-flex h-12 w-full touch-manipulation items-center justify-center gap-2 rounded-full border border-line-strong bg-surface px-5 text-[0.9375rem] font-semibold text-danger"
                        data-visit-cancel
                      >
                        <X className="h-4.5 w-4.5" />
                        {t.cancel}
                      </button>
                    )}
                  </div>
                )}

                {whyText && (
                  <p className="mt-5 rounded-2xl bg-sunken p-4 text-[0.84375rem] leading-6 text-ink-700" data-visit-why={rights.why ?? ""}>
                    {whyText}
                  </p>
                )}

                {showContact && (clinic.phone || waDigits) && (
                  <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                    {clinic.phone && (
                      <a href={`tel:${clinic.phone}`} className="inline-flex h-11 items-center gap-2 rounded-full border border-line-strong bg-surface px-4 text-[0.84375rem] font-semibold">
                        <Phone className="h-4 w-4" />
                        {tb.callClinic}
                      </a>
                    )}
                    {waDigits && (
                      <a
                        href={`https://wa.me/${waDigits}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex h-11 items-center gap-2 rounded-full border border-line-strong bg-surface px-4 text-[0.84375rem] font-semibold"
                      >
                        <MessageCircle className="h-4 w-4" />
                        {t.messageClinic}
                      </a>
                    )}
                  </div>
                )}

                {live && (
                  <div className="mt-5 flex justify-center">
                    <AddToCalendar
                      label={tb.addToCalendar}
                      startISO={at.startISO}
                      minutes={minutes}
                      title={`${service ? `${service} — ` : ""}${clinicName}`}
                      location={visit.meetingUrl || address || ""}
                      url={visit.meetingUrl}
                    />
                  </div>
                )}

                {!live && bookUrl && (
                  <a
                    href={bookUrl}
                    className="mt-6 inline-flex h-12 w-full items-center justify-center rounded-full px-5 text-[0.9375rem] font-semibold"
                    style={{ background: "var(--bk)", color: "var(--bk-ink)" }}
                  >
                    {t.bookAnother}
                  </a>
                )}
              </section>
            )}

            {mode === "move" && (
              <section className="animate-fade-up motion-reduce:animate-none" data-visit-move>
                <h2 className="font-display text-[1.3125rem] font-bold leading-tight">{t.pickNewTime}</h2>
                <p className="mb-4 mt-1 text-[0.8125rem] font-medium text-ink-500">
                  {t.nowAt.replace("{when}", `${when.toFormat("cccc d LLLL")} · ${when.toFormat("h:mm a")}`)}
                </p>
                {dayCounts && !anyOpen ? (
                  <div className="rounded-2xl border border-dashed border-line-strong px-4 py-8 text-center" data-visit-no-times>
                    <CalendarX className="mx-auto mb-2 h-8 w-8 text-ink-300" />
                    <p className="text-sm text-ink-500">{t.noTimes}</p>
                  </div>
                ) : (
                  <>
                    <p className="mb-2 text-[0.8125rem] font-semibold text-ink-700" aria-live="polite">
                      {DateTime.fromISO(date, { zone: clinic.tz }).setLocale(fmtLocale).toFormat("LLLL yyyy")}
                    </p>
                    <div className="-mx-5 mb-5 flex snap-x gap-2 overflow-x-auto overscroll-x-contain px-5 pb-1 [scrollbar-width:none] sm:-mx-6 sm:px-6">
                      {days.map((d) => {
                        const iso = d.toISODate()!;
                        const active = iso === date;
                        const closed = dayCounts !== null && !dayCounts[iso];
                        const open = dayCounts !== null && !!dayCounts[iso];
                        return (
                          <button
                            key={iso}
                            ref={(el) => {
                              if (el) dayRefs.current.set(iso, el);
                              else dayRefs.current.delete(iso);
                            }}
                            type="button"
                            onClick={() => setDate(iso)}
                            disabled={closed}
                            aria-pressed={active}
                            aria-label={d.setLocale(fmtLocale).toFormat("cccc d LLLL")}
                            className="relative flex h-[4.5rem] w-[3.6rem] shrink-0 snap-start touch-manipulation flex-col items-center justify-center gap-0.5 rounded-2xl border transition-colors disabled:opacity-35"
                            style={
                              active
                                ? { background: "var(--bk)", borderColor: "var(--bk)", color: "var(--bk-ink)" }
                                : { borderColor: "var(--color-line)", background: "var(--color-surface)" }
                            }
                          >
                            <span className="text-[length:max(11px,0.71875rem)] font-medium opacity-75">{d.setLocale(fmtLocale).toFormat("ccc")}</span>
                            <span className="text-[1.125rem] font-bold leading-none tnum">{d.day}</span>
                            {open && !active && (
                              <span className="absolute bottom-1.5 h-1 w-1 rounded-full" style={{ background: "var(--bk)" }} aria-hidden />
                            )}
                          </button>
                        );
                      })}
                    </div>
                    {slots === null ? (
                      <div className="flex justify-center py-10 text-ink-400">
                        <span className="slim-progress w-32 rounded-full" />
                      </div>
                    ) : slots.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-line-strong px-4 py-8 text-center">
                        <p className="text-sm text-ink-500">{tb.noSlots}</p>
                        {nextOpen && (
                          <button
                            type="button"
                            onClick={() => setDate(nextOpen)}
                            className="mt-3 min-h-10 text-sm font-semibold underline underline-offset-4"
                            style={{ color: "var(--bk-text)" }}
                          >
                            {tb.nextAvailable} {DateTime.fromISO(nextOpen).setLocale(fmtLocale).toFormat("cccc d LLLL")}
                          </button>
                        )}
                      </div>
                    ) : (
                      <SlotGroups
                        slots={slots}
                        tz={clinic.tz}
                        fmtLocale={fmtLocale}
                        selected={slot?.startISO ?? null}
                        onPick={setSlot}
                        labels={{ morning: tb.morning, afternoon: tb.afternoon, evening: tb.evening }}
                      />
                    )}
                  </>
                )}
                {error && <ErrorLine text={error} />}
              </section>
            )}

            {mode === "cancel" && (
              <section className="animate-fade-up motion-reduce:animate-none" data-visit-cancel-sheet>
                <h2 className="font-display text-[1.3125rem] font-bold leading-tight">{t.cancelTitle}</h2>
                <p className="mb-5 mt-1 text-[0.875rem] leading-6 text-ink-500">{t.cancelBody}</p>
                {card}
                <p className="mb-2 mt-6 text-[0.8125rem] font-semibold text-ink-700">{t.reasonLabel}</p>
                <div className="flex flex-wrap gap-2">
                  {REASONS.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setReason((cur) => (cur === r ? null : r))}
                      aria-pressed={reason === r}
                      className="min-h-10 touch-manipulation rounded-full border px-4 text-[0.84375rem] font-medium transition-colors"
                      style={
                        reason === r
                          ? { background: "var(--bk-soft)", borderColor: "var(--bk)", color: "var(--bk-text)" }
                          : { borderColor: "var(--color-line-strong)" }
                      }
                      data-visit-reason={r}
                    >
                      {t.reasons[r]}
                    </button>
                  ))}
                </div>
                {error && <ErrorLine text={error} />}
              </section>
            )}

            {(mode === "moved" || mode === "cancelled") && (
              <section className="animate-fade-up pt-2 text-center motion-reduce:animate-none" data-visit-done={mode}>
                <span
                  className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full"
                  style={mode === "moved" ? { background: "var(--bk)", color: "var(--bk-ink)" } : { background: "var(--color-sunken)", color: "var(--color-ink-500)" }}
                >
                  {mode === "moved" ? <Check className="h-8 w-8" strokeWidth={2.5} /> : <CalendarX className="h-8 w-8" />}
                </span>
                <h2 className="font-display text-[1.375rem] font-bold">{mode === "moved" ? t.moved : t.cancelled}</h2>
                <p className="mx-auto mt-1 max-w-xs text-[0.875rem] leading-6 text-ink-500">
                  {mode === "moved" ? t.movedBody : t.cancelledBody}
                </p>
                {mode === "moved" && (
                  <>
                    <div className="mt-6 text-start">{card}</div>
                    <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                      <AddToCalendar
                        label={tb.addToCalendar}
                        startISO={at.startISO}
                        minutes={minutes}
                        title={`${service ? `${service} — ` : ""}${clinicName}`}
                        location={visit.meetingUrl || address || ""}
                        url={visit.meetingUrl}
                      />
                    </div>
                    {(rights.move || rights.cancel) && (
                      <button
                        type="button"
                        onClick={() => setMode("view")}
                        className="mt-6 min-h-10 w-full text-[0.875rem] font-semibold underline underline-offset-4"
                        style={{ color: "var(--bk-text)" }}
                      >
                        {t.changeAgain}
                      </button>
                    )}
                  </>
                )}
                {mode === "cancelled" && bookUrl && (
                  <a
                    href={bookUrl}
                    className="mt-6 inline-flex h-12 w-full items-center justify-center rounded-full px-5 text-[0.9375rem] font-semibold"
                    style={{ background: "var(--bk)", color: "var(--bk-ink)" }}
                    data-visit-book-another
                  >
                    {t.bookAnother}
                  </a>
                )}
              </section>
            )}
          </div>

          {bar && (
            <div
              className="sticky bottom-0 z-10 flex items-center justify-between gap-3 rounded-b-[22px] border-t border-line bg-surface px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6"
              data-visit-bar
            >
              {bar}
            </div>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 py-8 text-center">
          <PoweredBy label={tb.poweredBy} hidden={clinic.whiteLabel} />
          <PrivacyLink label={tb.privacy} />
        </footer>
      </div>
    </main>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <p className="mt-4 rounded-xl bg-danger-soft px-3.5 py-2.5 text-[0.84375rem] text-danger" role="alert">
      {text}
    </p>
  );
}

function GhostBtn({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-12 shrink-0 touch-manipulation rounded-full px-4 text-[0.9375rem] font-semibold text-ink-500 hover:bg-sunken"
    >
      {label}
    </button>
  );
}

function PrimaryBtn({ onClick, label, disabled, busy }: { onClick: () => void; label: string; disabled?: boolean; busy?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-12 min-w-[9rem] shrink-0 touch-manipulation items-center justify-center gap-2 rounded-full px-6 text-[0.9375rem] font-semibold shadow-card transition-opacity disabled:opacity-40"
      style={{ background: "var(--bk)", color: "var(--bk-ink)" }}
      data-visit-primary
    >
      {busy && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {label}
    </button>
  );
}
