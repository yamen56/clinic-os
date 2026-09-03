"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DateTime } from "luxon";
import type { Dict } from "@/lib/i18n/en";
import { PoweredBy, PrivacyLink, CLINICTI_PRIVACY_URL } from "@/components/powered-by";
import { questionsForService, type PublicQuestion } from "@/lib/booking-intake";
import {
  CalendarCheck2,
  CalendarPlus,
  ChevronRight,
  Clock,
  ClipboardList,
  MapPin,
  MessageCircle,
  Phone,
  Stethoscope,
  User,
  Check,
  Video,
} from "lucide-react";

type Service = {
  id: string;
  name: string;
  nameAr: string | null;
  durationMin: number;
  price: number;
  locationKind: "in_person" | "online";
};
type Doctor = { id: string; name: string; title: string | null; specialty: string | null };

export type LinkCopy = {
  headline: string | null;
  headlineAr: string | null;
  intro: string | null;
  introAr: string | null;
  successNote: string | null;
  successNoteAr: string | null;
  showPrices: boolean;
  allowAnyDoctor: boolean;
  consentText: string | null;
  consentTextAr: string | null;
  requireConsent: boolean;
};

/** What the patient has typed, keyed by question id. */
type AnswerMap = Record<string, string | string[] | boolean>;

export function BookingWizard({
  bslug,
  clinic,
  services,
  doctors,
  questions,
  copy,
  words,
  maxDaysAhead,
  approvalMode,
  lockedDoctor,
}: {
  bslug: string;
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
    tz: string;
    defaultLocale: "ar" | "en";
    currency: string;
  };
  services: Service[];
  doctors: Doctor[];
  questions: PublicQuestion[];
  copy: LinkCopy;
  /*
    Both languages, resolved on the server through the workspace's vocabulary.

    Handed down rather than imported. This page has a language toggle that
    switches without a round trip, so one merged dictionary would break it — and
    importing `en.ts` and `ar.ts` here shipped four thousand lines of dictionary
    to a phone that needs fifty, while making the one screen a prospective
    customer ever sees the one screen whose words could not be changed.
  */
  words: { en: Dict["book"]; ar: Dict["book"] };
  maxDaysAhead: number;
  approvalMode: "instant" | "approval";
  lockedDoctor: string | null;
}) {
  const [locale, setLocale] = useState<"ar" | "en">(clinic.defaultLocale);
  const t = locale === "en" ? words.en : words.ar;
  const dir = locale === "en" ? "ltr" : "rtl";
  const isAr = locale === "ar";

  type Step = "service" | "doctor" | "time" | "details" | "verify" | "done";
  const [step, setStep] = useState<Step>("service");
  const [service, setService] = useState<Service | null>(null);
  const [doctorId, setDoctorId] = useState<string | null>(lockedDoctor);
  const [date, setDate] = useState(() => DateTime.now().setZone(clinic.tz).toISODate()!);
  const [dayCounts, setDayCounts] = useState<Record<string, number> | null>(null);
  const [slots, setSlots] = useState<{ startISO: string; doctorMemberId: string | null }[] | null>(null);
  const [slot, setSlot] = useState<{ startISO: string; doctorMemberId: string | null } | null>(null);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [consent, setConsent] = useState(false);
  const [verificationId, setVerificationId] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [badQuestion, setBadQuestion] = useState("");
  const [resendIn, setResendIn] = useState(0);
  const [doneStatus, setDoneStatus] = useState<"confirmed" | "pending_approval">("confirmed");
  /** The room, as it was resolved at booking time. Null for anything in person. */
  const [joinUrl, setJoinUrl] = useState<string | null>(null);

  const clinicName = isAr ? clinic.nameAr || clinic.name : clinic.name;
  const address = isAr ? clinic.addressAr || clinic.address : clinic.address;
  const headline = isAr ? copy.headlineAr || copy.headline : copy.headline;
  const intro = isAr ? copy.introAr || copy.intro : copy.intro;
  const successNote = isAr ? copy.successNoteAr || copy.successNote : copy.successNote;
  const consentText = isAr ? copy.consentTextAr || copy.consentText : copy.consentText;
  const fmtLocale = isAr ? "ar-JO-u-nu-latn" : "en-GB";

  /** Only the questions the chosen service actually calls for. */
  const activeQuestions = useMemo(
    () => questionsForService(questions, service?.id ?? null),
    [questions, service]
  );
  const days = useMemo(() => {
    const today = DateTime.now().setZone(clinic.tz).startOf("day");
    return Array.from({ length: Math.min(maxDaysAhead, 30) }, (_, i) => today.plus({ days: i }));
  }, [clinic.tz, maxDaysAhead]);

  /*
    Which days are worth tapping, fetched once per service/doctor pair.

    Without this the strip is thirty identical buttons and the patient discovers
    the clinic's schedule one "no available times" at a time. `null` means the
    answer has not arrived; every day stays tappable until it does, so the strip
    never blocks a patient who is faster than the request.
  */
  useEffect(() => {
    if (!service) return;
    let alive = true;
    setDayCounts(null);
    const q = new URLSearchParams({ serviceId: service.id });
    if (doctorId) q.set("doctorId", doctorId);
    fetch(`/api/public/book/${bslug}/days?${q}`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive || !d.counts) return;
        setDayCounts(d.counts);
        // Land on the first day that has something rather than on today, which
        // is the day most likely to be past its last slot.
        setDate((current) =>
          d.counts[current] > 0
            ? current
            : (Object.keys(d.counts) as string[]).sort().find((k) => d.counts[k] > 0) ?? current
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [service, doctorId, bslug]);

  useEffect(() => {
    if (step !== "time" || !service) return;
    let alive = true;
    setSlots(null);
    setSlot(null);
    const q = new URLSearchParams({ serviceId: service.id, date });
    if (doctorId) q.set("doctorId", doctorId);
    fetch(`/api/public/book/${bslug}/slots?${q}`)
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
  }, [step, service, doctorId, date, bslug]);

  // Resend cooldown, so the button is honest about when it will work again.
  useEffect(() => {
    if (resendIn <= 0) return;
    const id = setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => clearTimeout(id);
  }, [resendIn]);

  /*
    The next day worth offering — and only one the strip can actually show. The
    counts run to the link's full window, which can be longer than the thirty
    chips rendered, and pointing at a day with no button would move the slots
    while nothing on screen moved with them.
  */
  const firstOpenDay = useMemo(() => {
    if (!dayCounts) return null;
    const last = days[days.length - 1]?.toISODate();
    return (
      Object.keys(dayCounts)
        .sort()
        .find((k) => dayCounts[k] > 0 && k > date && (!last || k <= last)) ?? null
    );
  }, [dayCounts, date, days]);

  const detailsValid = !!fullName.trim() && phone.replace(/\D/g, "").length >= 9;

  /** Everything the clinic marked required has an answer. */
  const questionsValid = useMemo(() => {
    if (copy.requireConsent && !consent) return false;
    return activeQuestions.every((q) => {
      if (!q.required) return true;
      const v = answers[q.id];
      if (q.type === "checkbox") return v === true;
      if (q.type === "multiselect") return Array.isArray(v) && v.length > 0;
      return typeof v === "string" && v.trim().length > 0;
    });
  }, [activeQuestions, answers, consent, copy.requireConsent]);

  const submit = useCallback(async () => {
    if (!service || !slot) return;
    setBusy(true);
    setError("");
    setBadQuestion("");
    try {
      const res = await fetch(`/api/public/book/${bslug}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceId: service.id,
          doctorId: slot.doctorMemberId ?? doctorId,
          startISO: slot.startISO,
          fullName,
          phone,
          locale,
          answers,
          consent,
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        if (d.error === "answer_required" || d.error === "answer_invalid") {
          setBadQuestion(d.questionId ?? "");
          setError(d.error === "answer_required" ? t.answerRequired : t.answerInvalid);
          setStep("details");
          return;
        }
        if (d.error === "consent_required") {
          setError(t.consentRequired);
          setStep("details");
          return;
        }
        setError(
          d.error === "invalid_phone"
            ? t.invalidPhone
            : d.error === "slot_taken"
              ? t.slotTaken
              : d.error === "rate_limited"
                ? t.tooMany
                : t.genericError
        );
        if (d.error === "invalid_phone") setStep("details");
        return;
      }
      if (d.skipVerify) {
        setDoneStatus(d.status);
        setJoinUrl(d.meetingUrl ?? null);
        setStep("done");
      } else {
        setVerificationId(d.verificationId);
        setResendIn(45);
        setStep("verify");
      }
    } catch {
      setError(t.genericError);
    } finally {
      setBusy(false);
    }
  }, [service, slot, doctorId, bslug, fullName, phone, locale, answers, consent, t]);

  const verify = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/public/book/${bslug}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verificationId, code }),
      });
      const d = await res.json();
      if (!res.ok) {
        if (d.error === "expired" && d.newVerificationId) {
          setVerificationId(d.newVerificationId);
          setCode("");
          setResendIn(45);
          setError(t.codeExpired);
        } else if (d.error === "slot_taken") {
          setStep("time");
          setError(t.slotTaken);
        } else {
          setError(t.wrongCode);
        }
        return;
      }
      setDoneStatus(d.status);
      setJoinUrl(d.meetingUrl ?? null);
      setStep("done");
    } catch {
      setError(t.genericError);
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    if (resendIn > 0 || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/public/book/${bslug}/resend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verificationId }),
      });
      const d = await res.json();
      if (!res.ok) {
        setError(d.error === "rate_limited" ? t.tooMany : t.genericError);
        return;
      }
      setVerificationId(d.verificationId);
      setCode("");
      setResendIn(45);
      setError(t.codeResent);
    } catch {
      setError(t.genericError);
    } finally {
      setBusy(false);
    }
  };

  const slotLocal = slot ? DateTime.fromISO(slot.startISO).setZone(clinic.tz).setLocale(fmtLocale) : null;
  const chosenDoctor = doctors.find((d) => d.id === (slot?.doctorMemberId ?? doctorId));
  const showDoctorStep = doctors.length > 1 && !lockedDoctor;
  const backFromTime = () => setStep(showDoctorStep ? "doctor" : "service");

  const totalSteps = 4;
  const stepIndex = {
    service: 0,
    doctor: 1,
    time: 2,
    details: 3,
    verify: 3,
    done: totalSteps,
  }[step];

  const reset = () => {
    setStep("service");
    setService(null);
    setSlot(null);
    setAnswers({});
    setConsent(false);
    setCode("");
    setError("");
    setBadQuestion("");
  };

  return (
    <main
      dir={dir}
      className="min-h-dvh bg-paper"
      style={{ "--bk": clinic.brandColor } as React.CSSProperties}
    >
      <div className="mx-auto flex min-h-dvh max-w-lg flex-col px-4 py-6">
        {/* Clinic header */}
        <header className="mb-6 flex items-center gap-3.5">
          {clinic.hasLogo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/public/clinic-logo/${clinic.slug}`}
              alt=""
              className="h-12 w-12 rounded-2xl border border-line object-cover"
            />
          ) : (
            <span
              className="flex h-12 w-12 items-center justify-center rounded-2xl text-lg font-bold text-white"
              style={{ background: "var(--bk)" }}
            >
              {clinicName.slice(0, 1)}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-bold tracking-tight">{clinicName}</h1>
            {address && (
              <a
                href={clinic.mapsUrl ?? undefined}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 truncate text-[13px] text-ink-500"
              >
                <MapPin className="h-3.5 w-3.5 shrink-0" />
                {address}
              </a>
            )}
          </div>
          <button
            onClick={() => setLocale(isAr ? "en" : "ar")}
            className="rounded-full border border-line-strong bg-surface px-3 py-1.5 text-[13px] font-medium"
          >
            {isAr ? "EN" : "ع"}
          </button>
        </header>

        {/* Progress */}
        {step !== "done" && (
          <div className="mb-5 flex gap-1.5">
            {Array.from({ length: totalSteps }, (_, i) => (
              <span
                key={i}
                className="h-1 flex-1 rounded-full transition-colors"
                style={{ background: i <= stepIndex ? "var(--bk)" : "var(--color-line)" }}
              />
            ))}
          </div>
        )}

        <div className="flex-1">
          {/* STEP: service */}
          {step === "service" && (
            <section className="animate-fade-up">
              {(headline || intro) && (
                <div className="mb-5">
                  {headline && <h2 className="text-[17px] font-bold tracking-tight">{headline}</h2>}
                  {intro && <p className="mt-1 whitespace-pre-line text-[14px] leading-6 text-ink-500">{intro}</p>}
                </div>
              )}
              <h2 className="mb-3 flex items-center gap-2 text-[15px] font-semibold">
                <Stethoscope className="h-4.5 w-4.5" style={{ color: "var(--bk)" }} />
                {t.chooseService}
              </h2>
              <div className="grid gap-2.5">
                {services.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => {
                      setService(s);
                      setStep(showDoctorStep ? "doctor" : "time");
                    }}
                    className="flex items-center gap-3 rounded-card border border-line bg-surface p-4 text-start shadow-card transition-all hover:shadow-pop"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-[15px] font-semibold">{isAr ? s.nameAr || s.name : s.name}</div>
                      <div className="mt-0.5 flex items-center gap-2 text-[13px] text-ink-500 tnum">
                        <Clock className="h-3.5 w-3.5" />
                        {s.durationMin} {t.duration}
                        {/* The clinic's own currency. This printed a literal "JOD"
                            regardless, which was wrong for every clinic that does
                            not bill in dinars. */}
                        {copy.showPrices && s.price > 0 && (
                          <span>
                            · {s.price.toFixed(2)} {clinic.currency}
                          </span>
                        )}
                      </div>
                    </div>
                    <ChevronRight className="h-4.5 w-4.5 text-ink-300 rtl:rotate-180" />
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* STEP: doctor */}
          {step === "doctor" && (
            <section className="animate-fade-up">
              <h2 className="mb-3 flex items-center gap-2 text-[15px] font-semibold">
                <User className="h-4.5 w-4.5" style={{ color: "var(--bk)" }} />
                {t.chooseDoctor}
              </h2>
              <div className="grid gap-2.5">
                {copy.allowAnyDoctor && (
                  <button
                    onClick={() => {
                      setDoctorId(null);
                      setStep("time");
                    }}
                    className="rounded-card border border-dashed border-line-strong bg-surface/70 p-4 text-start text-[15px] font-medium text-ink-700 transition-all hover:shadow-card"
                  >
                    {t.anyDoctor}
                  </button>
                )}
                {doctors.map((d) => (
                  <button
                    key={d.id}
                    onClick={() => {
                      setDoctorId(d.id);
                      setStep("time");
                    }}
                    className="flex items-center gap-3 rounded-card border border-line bg-surface p-4 text-start shadow-card transition-all hover:shadow-pop"
                  >
                    <span
                      className="flex h-10 w-10 items-center justify-center rounded-full text-sm font-bold text-white"
                      style={{ background: "var(--bk)" }}
                    >
                      {/* The Arabic "د." prefix would otherwise make every avatar
                          read the same letter — but only a doctor carries it, and
                          not every workspace books doctors. */}
                      {d.name.replace(/^د\.\s*/, "").trim().slice(0, 1) || d.name.slice(0, 1)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[15px] font-semibold">{d.name}</div>
                      {d.specialty && <div className="text-[13px] text-ink-500">{d.specialty}</div>}
                    </div>
                    <ChevronRight className="h-4.5 w-4.5 text-ink-300 rtl:rotate-180" />
                  </button>
                ))}
              </div>
              <BackBtn onClick={() => setStep("service")} label={t.back} />
            </section>
          )}

          {/* STEP: time */}
          {step === "time" && (
            <section className="animate-fade-up">
              <h2 className="mb-3 flex items-center gap-2 text-[15px] font-semibold">
                <CalendarCheck2 className="h-4.5 w-4.5" style={{ color: "var(--bk)" }} />
                {t.chooseTime}
              </h2>
              {/* date strip */}
              <div className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1">
                {days.map((d) => {
                  const iso = d.toISODate()!;
                  const active = iso === date;
                  // `null` counts = still loading; never disable on unknown.
                  const closed = dayCounts !== null && !dayCounts[iso];
                  return (
                    <button
                      key={iso}
                      onClick={() => setDate(iso)}
                      disabled={closed}
                      aria-label={d.setLocale(fmtLocale).toFormat("cccc d LLLL")}
                      className="flex w-14 shrink-0 flex-col items-center gap-0.5 rounded-xl border py-2 transition-colors disabled:opacity-35"
                      style={
                        active
                          ? { background: "var(--bk)", borderColor: "var(--bk)", color: "#fff" }
                          : { borderColor: "var(--color-line)", background: "var(--color-surface)" }
                      }
                    >
                      <span className="text-[11px] opacity-75">
                        {d.setLocale(fmtLocale).toFormat("ccc")}
                      </span>
                      <span className="text-[15px] font-bold tnum">{d.day}</span>
                    </button>
                  );
                })}
              </div>
              {/* slots */}
              {slots === null ? (
                <div className="flex justify-center py-10 text-ink-400">
                  <span className="slim-progress w-32 rounded-full" />
                </div>
              ) : slots.length === 0 ? (
                <div className="rounded-card border border-dashed border-line-strong bg-surface/60 px-4 py-8 text-center">
                  <p className="text-sm text-ink-500">{t.noSlots}</p>
                  {/*
                    A dead end otherwise. The strip already knows where the next
                    open day is, so offer it instead of making the patient hunt.
                  */}
                  {firstOpenDay && (
                    <button
                      onClick={() => setDate(firstOpenDay)}
                      className="mt-3 text-sm font-semibold underline underline-offset-4"
                      style={{ color: "var(--bk)" }}
                    >
                      {t.nextAvailable}{" "}
                      {DateTime.fromISO(firstOpenDay).setLocale(fmtLocale).toFormat("cccc d LLLL")}
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
                  labels={{ morning: t.morning, afternoon: t.afternoon, evening: t.evening }}
                />
              )}
              {error && <p className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
              <div className="mt-5 flex items-center justify-between">
                <BackBtn onClick={backFromTime} label={t.back} />
                <PrimaryBtn disabled={!slot} onClick={() => { setError(""); setStep("details"); }} label={t.next} />
              </div>
            </section>
          )}

          {/*
            STEP: details — name, number, and whatever else the clinic asks.

            One step, not two. Splitting the clinic's questions onto a screen of
            their own added a tap and a progress segment to say nothing new: the
            patient has already chosen a time and is now simply telling the
            clinic about themselves, and "your name" and "what brings you in"
            are the same errand. Merged, the whole form is visible at once and
            the length of it is honest before you start typing.
          */}
          {step === "details" && service && slotLocal && (
            <section className="animate-fade-up">
              <SummaryCard
                serviceName={isAr ? service.nameAr || service.name : service.name}
                when={`${slotLocal.toFormat("cccc d LLLL")} · ${slotLocal.toFormat("h:mm a")}`}
                doctor={chosenDoctor?.name}
                withLabel={t.with}
              />
              <h2 className="mb-3 mt-5 text-[15px] font-semibold">{t.yourDetails}</h2>
              <div className="grid gap-3">
                <input
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder={t.fullName}
                  autoComplete="name"
                  className="h-12 rounded-xl border border-line-strong bg-surface px-4 text-[15px] outline-none focus:border-[var(--bk)]"
                />
                <div>
                  <input
                    dir="ltr"
                    inputMode="tel"
                    autoComplete="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="079 000 0000"
                    className="h-12 w-full rounded-xl border border-line-strong bg-surface px-4 text-[15px] tnum outline-none focus:border-[var(--bk)]"
                  />
                  <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-ink-500">
                    <MessageCircle className="h-3.5 w-3.5" />
                    {t.phoneHint}
                  </p>
                </div>
              </div>

              {activeQuestions.length > 0 && (
                <>
                  <div className="mt-6 mb-3 flex items-center gap-2 border-t border-line pt-5">
                    <ClipboardList className="h-4 w-4" style={{ color: "var(--bk)" }} />
                    <span className="text-[13px] text-ink-500">{t.fewMoreHint}</span>
                  </div>
                  <div className="grid gap-4">
                    {activeQuestions.map((q) => (
                      <QuestionField
                        key={q.id}
                        q={q}
                        isAr={isAr}
                        value={answers[q.id]}
                        invalid={badQuestion === q.id}
                        optionalLabel={t.optional}
                        choosePlaceholder={t.choose}
                        onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))}
                      />
                    ))}
                  </div>
                </>
              )}

              {copy.requireConsent && consentText && (
                <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-xl border border-line-strong bg-surface p-3.5">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                    className="mt-0.5 h-4.5 w-4.5 shrink-0 accent-[var(--bk)]"
                  />
                  <span className="whitespace-pre-line text-[13px] leading-6 text-ink-700">
                    {consentText}
                  </span>
                </label>
              )}

              {error && <p className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
              <div className="mt-5 flex items-center justify-between">
                <BackBtn onClick={() => setStep("time")} label={t.back} />
                <PrimaryBtn
                  disabled={!detailsValid || !questionsValid || busy}
                  busy={busy}
                  onClick={submit}
                  label={t.sendCode}
                />
              </div>
              <PrivacyNote t={t} />
            </section>
          )}

          {/* STEP: verify */}
          {step === "verify" && (
            <section className="animate-fade-up text-center">
              <MessageCircle className="mx-auto mb-3 h-10 w-10" style={{ color: "var(--bk)" }} />
              <h2 className="mb-1 text-[15px] font-semibold">{t.enterCode}</h2>
              <p className="num mb-4 text-[13px] text-ink-500 tnum">{phone}</p>
              <input
                dir="ltr"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                placeholder={t.codePlaceholder}
                className="mx-auto block h-14 w-48 rounded-xl border border-line-strong bg-surface text-center text-2xl font-bold tracking-[0.3em] tnum outline-none focus:border-[var(--bk)]"
              />
              {error && <p className="mt-3 text-sm text-danger">{error}</p>}
              <button
                onClick={resend}
                disabled={resendIn > 0 || busy}
                className="mt-4 text-[13px] font-medium text-ink-500 underline underline-offset-4 disabled:no-underline disabled:opacity-60"
              >
                {resendIn > 0 ? `${t.resendIn} ${resendIn}` : t.resend}
              </button>
              <div className="mt-5 flex items-center justify-center gap-3">
                <BackBtn onClick={() => setStep("details")} label={t.back} />
                <PrimaryBtn disabled={code.length !== 6 || busy} busy={busy} onClick={verify} label={t.verifyAndBook} />
              </div>
            </section>
          )}

          {/* STEP: done */}
          {step === "done" && service && slotLocal && (
            <section className="animate-fade-up pt-6 text-center">
              <span
                className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full"
                style={{ background: "var(--bk)" }}
              >
                <Check className="h-8 w-8 text-white" />
              </span>
              <h2 className="text-xl font-bold">
                {doneStatus === "confirmed" ? t.booked : t.bookedPending}
              </h2>
              <p className="mt-1 text-sm text-ink-500">
                {doneStatus === "confirmed" ? t.bookedBody : t.bookedPendingBody}
              </p>
              <div className="mt-5">
                <SummaryCard
                  serviceName={isAr ? service.nameAr || service.name : service.name}
                  when={`${slotLocal.toFormat("cccc d LLLL")} · ${slotLocal.toFormat("h:mm a")}`}
                  doctor={chosenDoctor?.name}
                  withLabel={t.with}
                />
              </div>
              {successNote && (
                <p className="mt-4 whitespace-pre-line rounded-card border border-line bg-surface/70 p-4 text-start text-[13px] leading-6 text-ink-700">
                  {successNote}
                </p>
              )}
              {/*
                An online meeting has a link and no address, so the join button
                takes the place of the phone number — the two are alternatives,
                not a row of options. The link is also in the WhatsApp message,
                which is what the note above says and why this is not the only
                copy of it.
              */}
              {joinUrl && (
                <a
                  href={joinUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-5 inline-flex h-11 w-full items-center justify-center gap-2 rounded-full px-5 text-[14px] font-semibold text-white"
                  style={{ background: "var(--bk)" }}
                >
                  <Video className="h-4 w-4" />
                  {t.joinMeeting}
                </a>
              )}
              <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                <AddToCalendar
                  label={t.addToCalendar}
                  startISO={slot!.startISO}
                  minutes={service.durationMin}
                  title={`${isAr ? service.nameAr || service.name : service.name} — ${clinicName}`}
                  location={joinUrl || address || ""}
                  url={joinUrl}
                />
                {!joinUrl && clinic.phone && (
                  <a
                    href={`tel:${clinic.phone}`}
                    className="inline-flex h-10 items-center gap-2 rounded-full border border-line-strong bg-surface px-4 text-[13px] font-medium"
                  >
                    <Phone className="h-3.5 w-3.5" />
                    {t.callClinic}
                  </a>
                )}
              </div>
              <button
                onClick={reset}
                className="mt-6 block w-full text-sm font-medium underline underline-offset-4"
                style={{ color: "var(--bk)" }}
              >
                {t.bookAgain}
              </button>
            </section>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 pt-8 text-center">
          <PoweredBy label={t.poweredBy} />
          <PrivacyLink label={t.privacy} />
        </footer>
      </div>
    </main>
  );
}

/**
 * Times split into morning / afternoon / evening.
 *
 * A clinic open nine to seven at fifteen-minute granularity produces forty
 * buttons, and a flat grid of them is a wall rather than a choice. The headings
 * are how people already describe when they want to come.
 */
function SlotGroups({
  slots,
  tz,
  fmtLocale,
  selected,
  onPick,
  labels,
}: {
  slots: { startISO: string; doctorMemberId: string | null }[];
  tz: string;
  fmtLocale: string;
  selected: string | null;
  onPick: (s: { startISO: string; doctorMemberId: string | null }) => void;
  labels: { morning: string; afternoon: string; evening: string };
}) {
  const groups = useMemo(() => {
    const out: { key: "morning" | "afternoon" | "evening"; items: typeof slots }[] = [
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
          {groups.length > 1 && (
            <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-ink-400">
              {labels[g.key]}
            </div>
          )}
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {g.items.map((s) => {
              const local = DateTime.fromISO(s.startISO).setZone(tz).setLocale(fmtLocale);
              const active = selected === s.startISO;
              return (
                <button
                  key={s.startISO}
                  onClick={() => onPick(s)}
                  className="rounded-xl border py-2.5 text-sm font-semibold tnum transition-colors"
                  style={
                    active
                      ? { background: "var(--bk)", borderColor: "var(--bk)", color: "#fff" }
                      : { borderColor: "var(--color-line)", background: "var(--color-surface)" }
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
function QuestionField({
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
  const box = `w-full rounded-xl border ${ring} bg-surface px-4 text-[15px] outline-none focus:border-[var(--bk)]`;

  if (q.type === "checkbox") {
    return (
      <label className="flex cursor-pointer items-start gap-2.5">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 h-4.5 w-4.5 shrink-0 accent-[var(--bk)]"
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
                onClick={() =>
                  onChange(
                    picked
                      ? (value as string[]).filter((x) => x !== o)
                      : [...(Array.isArray(value) ? value : []), o]
                  )
                }
                className="rounded-full border px-3.5 py-2 text-[13px] font-medium transition-colors"
                style={
                  picked
                    ? { background: "var(--bk)", borderColor: "var(--bk)", color: "#fff" }
                    : { borderColor: "var(--color-line)", background: "var(--color-surface)" }
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

      {help && (
        <p className="mt-1.5 text-[12px] leading-5 text-ink-500">{help}</p>
      )}
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
function AddToCalendar({
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
      className="inline-flex h-10 items-center gap-2 rounded-full border border-line-strong bg-surface px-4 text-[13px] font-medium"
    >
      <CalendarPlus className="h-3.5 w-3.5" />
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
function PrivacyNote({ t }: { t: { privacyConsent: string; privacy: string } }) {
  return (
    <p className="mt-4 text-center text-[11px] leading-5 text-ink-400">
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

function SummaryCard({
  serviceName,
  when,
  doctor,
  withLabel,
}: {
  serviceName: string;
  when: string;
  doctor?: string;
  withLabel: string;
}) {
  return (
    <div className="rounded-card border border-line bg-surface p-4 text-start shadow-card">
      <div className="text-[15px] font-semibold">{serviceName}</div>
      <div className="mt-1 text-[13px] text-ink-500 tnum">{when}</div>
      {doctor && (
        <div className="mt-0.5 text-[13px] text-ink-500">
          {withLabel} {doctor}
        </div>
      )}
    </div>
  );
}

function BackBtn({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} className="rounded-full px-4 py-2 text-sm font-medium text-ink-500 hover:bg-ink-900/5">
      {label}
    </button>
  );
}

function PrimaryBtn({
  onClick,
  label,
  disabled,
  busy,
}: {
  onClick: () => void;
  label: string;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-11 items-center gap-2 rounded-full px-6 text-[15px] font-semibold text-white shadow-card transition-opacity disabled:opacity-40"
      style={{ background: "var(--bk)" }}
    >
      {busy && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
      {label}
    </button>
  );
}
