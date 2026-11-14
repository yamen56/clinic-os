"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DateTime } from "luxon";
import type { Dict } from "@/lib/i18n/en";
import { PoweredBy, PrivacyLink } from "@/components/powered-by";
import { questionsForServices, type PublicQuestion } from "@/lib/booking-intake";
import { trackSchedule } from "@/components/meta-pixel";
import { PhoneInput } from "@/components/ui/phone-input";
import { countryFromClinic, formatPhone } from "@/lib/phone";
import {
  AddToCalendar,
  AppointmentCard,
  brandTokens,
  DoctorFace,
  PrivacyNote,
  QuestionField,
  SlotGroups,
  type Doctor,
  type Slot,
} from "./booking-parts";
import { CalendarX, Check, ChevronRight, Clock, MapPin, MessageCircle, Phone, Users, Video } from "lucide-react";

type Service = {
  id: string;
  name: string;
  nameAr: string | null;
  durationMin: number;
  price: number;
  locationKind: "in_person" | "online";
  /** Null for a service the clinic has not filed under a section. */
  sectionId: string | null;
};
type Section = { id: string | null; name: string; nameAr: string | null; count: number };

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

/** A visit holds no more services than this — the server says the same. */
const MAX_SERVICES = 8;

export function BookingWizard({
  bslug,
  clinic,
  services,
  sections,
  doctors,
  questions,
  copy,
  words,
  maxDaysAhead,
  lockedDoctor,
  skipServiceStep,
  allowMultiple,
  brandHeader = true,
  verifyByOtp,
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
  /** The sections this link offers, already narrowed to what it can book. */
  sections: Section[];
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
  /**
   * Hide "choose a service" and book the only one there is.
   *
   * Arrives already resolved: the server sets it only when the link genuinely
   * comes down to a single service, so this component never has to decide which
   * one was meant. Turning the setting on for a link offering three does
   * nothing, which is the safe direction.
   */
  skipServiceStep: boolean;
  /**
   * The patient may tick several services and book them as one visit (0106).
   * Resolved on the server: only for a link that allows it and offers more
   * than one. The routes check it again; this only decides what is drawn.
   */
  allowMultiple: boolean;
  /** A band in the clinic's colour across the top (default), or a plain white page (0107). */
  brandHeader?: boolean;
  /**
   * Whether a WhatsApp code stands between this form and the appointment.
   *
   * Resolved on the server from both halves of the question — the link's
   * setting and whether the clinic's WhatsApp is actually connected — because
   * the answer decides what this screen promises: a button that says "Send
   * code" and a line that says a code is coming are wrong on a page that books
   * immediately, and were already wrong for a clinic whose WhatsApp was down.
   *
   * It labels, it does not decide. `/start` reads the link's own row and can
   * disagree if WhatsApp drops or reconnects between this render and the tap;
   * both directions are handled, and a browser claiming no code is needed is
   * never believed.
   */
  verifyByOtp: boolean;
}) {
  const [locale, setLocale] = useState<"ar" | "en">(clinic.defaultLocale);
  const t = locale === "en" ? words.en : words.ar;
  const dir = locale === "en" ? "ltr" : "rtl";
  const isAr = locale === "ar";
  const brand = useMemo(() => brandTokens(clinic.brandColor), [clinic.brandColor]);

  type Step = "section" | "service" | "doctor" | "time" | "details" | "verify" | "done";

  /*
    Whether this link asks the patient what they are booking.

    `skipServiceStep` arrives already resolved — the server only sets it when
    the link really does come down to one service, so there is no case here
    where the step is hidden and `services[0]` is the wrong answer or missing.
    See loadPublicLink and the page.
  */
  const showServiceStep = !skipServiceStep;
  const multi = allowMultiple && showServiceStep && services.length > 1;
  /*
    And whether it asks which part of the clinic first.

    Same self-collapsing rule as the doctor step: a screen offering one choice
    is not a question. One section, or none, and the patient goes straight to
    the services — which is every clinic that has not set sections up, so this
    changes nothing for them. A link where the patient ticks several services
    lists them all under their section headings instead: the second service may
    well be in another part of the clinic.
  */
  const showSectionStep = showServiceStep && !multi && sections.length > 1;
  const showDoctorStep = doctors.length > 1 && !lockedDoctor;
  const firstStep: Step = showSectionStep ? "section" : showServiceStep ? "service" : showDoctorStep ? "doctor" : "time";

  const [step, setStep] = useState<Step>(firstStep);
  // Pre-chosen when the step is gone, so every downstream screen — the slot
  // scan, the price, the summary — has the service it expects.
  const [picked, setPicked] = useState<Service[]>(showServiceStep ? [] : services.slice(0, 1));
  const [sectionId, setSectionId] = useState<string | null>(null);
  const [doctorId, setDoctorId] = useState<string | null>(lockedDoctor);
  const [date, setDate] = useState(() => DateTime.now().setZone(clinic.tz).toISODate()!);
  const [dayCounts, setDayCounts] = useState<Record<string, number> | null>(null);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [consent, setConsent] = useState(false);
  const [verificationId, setVerificationId] = useState("");
  const [code, setCode] = useState("");
  /*
    The code was right but the time went meanwhile: the patient picks another
    and the same code books it (see /verify) — no second WhatsApp message.
    `newTime` is that other time, carried through a code that expired too.
  */
  const [retiming, setRetiming] = useState(false);
  const [newTime, setNewTime] = useState<Slot | null>(null);
  /** Bumped to read the days and times again after one was taken from under the patient. */
  const [nonce, setNonce] = useState(0);
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
  const nameOf = (s: { name: string; nameAr: string | null }) => (isAr ? s.nameAr || s.name : s.name);
  /** Where a number typed without its code is from: the clinic's own country. */
  const homeCountry = countryFromClinic({ timezone: clinic.tz, currency: clinic.currency });

  const pickedIds = useMemo(() => picked.map((s) => s.id), [picked]);
  const pickedKey = pickedIds.join(",");
  const totalMin = picked.reduce((n, s) => n + s.durationMin, 0);
  const serviceNames = picked.map(nameOf);

  /** Only the questions the chosen services actually call for. */
  const activeQuestions = useMemo(() => questionsForServices(questions, pickedIds), [questions, pickedIds]);
  const days = useMemo(() => {
    const today = DateTime.now().setZone(clinic.tz).startOf("day");
    return Array.from({ length: Math.min(maxDaysAhead, 30) }, (_, i) => today.plus({ days: i }));
  }, [clinic.tz, maxDaysAhead]);

  /** `?serviceId=a&serviceId=b` — every service the visit is for. */
  const query = useCallback(
    (extra: Record<string, string>) => {
      const q = new URLSearchParams();
      for (const id of pickedKey.split(",").filter(Boolean)) q.append("serviceId", id);
      if (doctorId) q.set("doctorId", doctorId);
      for (const [k, v] of Object.entries(extra)) q.set(k, v);
      return q;
    },
    [pickedKey, doctorId]
  );

  /*
    Which days are worth tapping, fetched once per services/doctor pair.

    Without this the strip is thirty identical buttons and the patient discovers
    the clinic's schedule one "no available times" at a time. `null` means the
    answer has not arrived; every day stays tappable until it does, so the strip
    never blocks a patient who is faster than the request.
  */
  useEffect(() => {
    if (!pickedKey) return;
    let alive = true;
    setDayCounts(null);
    fetch(`/api/public/book/${bslug}/days?${query({})}`)
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
  }, [pickedKey, query, bslug, nonce]);

  useEffect(() => {
    if (step !== "time" || !pickedKey) return;
    let alive = true;
    setSlots(null);
    setSlot(null);
    fetch(`/api/public/book/${bslug}/slots?${query({ date })}`)
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
  }, [step, pickedKey, query, date, bslug, nonce]);

  // Resend cooldown, so the button is honest about when it will work again.
  useEffect(() => {
    if (resendIn <= 0) return;
    const id = setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => clearTimeout(id);
  }, [resendIn]);

  /*
    The chosen day, kept in view. The strip lands on the first open day, which
    can be the twelfth chip — off the edge of a phone — so the patient saw
    today's chip greyed out and the times of a day they could not see.
  */
  const dayRefs = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    if (step !== "time") return;
    const el = dayRefs.current.get(date);
    if (!el) return;
    const still = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ inline: "center", block: "nearest", behavior: still ? "auto" : "smooth" });
  }, [date, step]);

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

  /** The time went from under the patient: back to the times, read again. */
  const timeWent = () => {
    setError(t.slotTaken);
    setStep("time");
    setNonce((n) => n + 1);
  };

  const submit = useCallback(async () => {
    if (!picked.length || !slot) return;
    setBusy(true);
    setError("");
    setBadQuestion("");
    try {
      const res = await fetch(`/api/public/book/${bslug}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceId: picked[0].id,
          serviceIds: picked.map((s) => s.id),
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
          return;
        }
        if (d.error === "consent_required") {
          setError(t.consentRequired);
          return;
        }
        /*
          Taken while the patient was typing. It used to say so and leave them
          here, on a form whose only button books a time that is gone; the
          times are where the answer is, so that is where they go.
        */
        if (d.error === "slot_taken") {
          timeWent();
          return;
        }
        setError(d.error === "invalid_phone" ? t.invalidPhone : d.error === "rate_limited" ? t.tooMany : t.genericError);
        return;
      }
      if (d.skipVerify) {
        // The appointment row exists by the time `/start` answers this way.
        trackSchedule(d.appointmentId, picked.map((s) => s.name).join(" + "));
        setDoneStatus(d.status);
        setJoinUrl(d.meetingUrl ?? null);
        setStep("done");
      } else {
        setVerificationId(d.verificationId);
        setCode("");
        setResendIn(45);
        setStep("verify");
      }
    } catch {
      setError(t.genericError);
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, slot, doctorId, bslug, fullName, phone, locale, answers, consent, t]);

  /**
   * The code, and with it the booking. `at` is another time for the same
   * booking, after the first one went (see `retiming`).
   */
  const verify = async (c: string, at: Slot | null) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/public/book/${bslug}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          verificationId,
          code: c,
          ...(at ? { startISO: at.startISO, doctorId: at.doctorMemberId ?? doctorId } : {}),
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        if (d.error === "expired" && d.newVerificationId) {
          setVerificationId(d.newVerificationId);
          setCode("");
          setResendIn(45);
          setError(t.codeExpired);
          setStep("verify");
        } else if (d.error === "slot_taken") {
          setRetiming(true);
          timeWent();
        } else if (d.error === "too_many") {
          // Five wrong tries retire the code; a new one is the only way on, so
          // the button for it opens now rather than in forty seconds.
          setCode("");
          setResendIn(0);
          setError(t.tooManyCodes);
        } else if (d.error === "rate_limited") {
          setError(t.tooMany);
        } else if (d.error === "wrong_code") {
          setCode("");
          setError(t.wrongCode);
        } else {
          setError(t.genericError);
        }
        return;
      }
      // Same point on the other route in: the code was accepted, so the
      // appointment has been written.
      trackSchedule(d.appointmentId, picked.map((s) => s.name).join(" + "));
      if (at) setSlot(at);
      setRetiming(false);
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
  /* Back goes to the previous step that exists — not to `firstStep`, which
     since the section step was added is no longer the same thing. */
  const backFromTime = () => setStep(showDoctorStep ? "doctor" : showServiceStep ? "service" : firstStep);

  /** Only the services in the chosen section, when the patient chose one. */
  const shownServices = showSectionStep ? services.filter((s) => s.sectionId === sectionId) : services;

  /*
    The steps this particular link actually has, in order.

    Derived rather than counted, because three of them are conditional: the
    section and doctor steps collapse when there is nothing to choose between,
    and the service step when the clinic has said this link is about one thing.
    A fixed count would open a short link with its progress part-filled, which
    reads as a page that lost your place rather than one with fewer questions.

    `verify` shares a mark with `details`: it is the same answer being
    confirmed, not a further thing to decide.
  */
  const flow: Step[] = [
    ...(showSectionStep ? (["section"] as const) : []),
    ...(showServiceStep ? (["service"] as const) : []),
    ...(showDoctorStep ? (["doctor"] as const) : []),
    "time",
    "details",
  ];
  const totalSteps = flow.length;
  const stepIndex = step === "done" ? totalSteps : Math.max(0, flow.indexOf(step === "verify" ? "details" : step));

  const reset = () => {
    setStep(firstStep);
    // Booking again on a single-service link starts from the same service, not
    // from a choice the page no longer offers.
    setPicked(showServiceStep ? [] : services.slice(0, 1));
    setSectionId(null);
    setDoctorId(lockedDoctor);
    setSlot(null);
    setAnswers({});
    setConsent(false);
    setCode("");
    setRetiming(false);
    setNewTime(null);
    setError("");
    setBadQuestion("");
  };

  const toggleService = (s: Service) =>
    setPicked((xs) =>
      xs.some((x) => x.id === s.id) ? xs.filter((x) => x.id !== s.id) : xs.length >= MAX_SERVICES ? xs : [...xs, s]
    );

  const length = `${totalMin} ${t.duration}`;
  const price = (s: Service) =>
    copy.showPrices && s.price > 0 ? (
      // The clinic's own currency; this once printed a literal "JOD" for everyone.
      <span>
        · {s.price.toFixed(2)} {clinic.currency}
      </span>
    ) : null;

  const title: Record<Step, string> = {
    section: t.chooseSection,
    service: multi ? t.chooseServices : t.chooseService,
    doctor: t.chooseDoctor,
    time: t.chooseTime,
    details: t.yourDetails,
    verify: t.enterCode,
    done: "",
  };

  /** What the patient has chosen so far, said once above the times. */
  const crumb =
    showServiceStep && picked.length
      ? [serviceNames.join(" + "), length, showDoctorStep && doctorId ? chosenDoctor?.name : null].filter(Boolean).join(" · ")
      : "";

  /* The bar along the bottom of the sheet: Back, and the step's one action. */
  let bar: React.ReactNode = null;
  if (step === "section" || step === "doctor" || (step === "service" && !multi)) {
    const back =
      step === "service" ? (showSectionStep ? () => setStep("section") : null) : step === "doctor" && showServiceStep ? () => setStep("service") : null;
    // Nothing behind the first step: a Back that returns to a screen the link
    // does not have is worse than no Back at all.
    if (back) bar = <BackBtn onClick={back} label={t.back} />;
  } else if (step === "service") {
    bar = (
      <>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink-700 tabular-nums" data-picked-summary aria-live="polite">
          {picked.length > 0 &&
            (picked.length === 1 ? t.onePicked : t.servicesPicked)
              .replace("{n}", String(picked.length))
              .replace("{min}", String(totalMin))}
        </span>
        <PrimaryBtn
          disabled={!picked.length}
          onClick={() => {
            setError("");
            setStep(showDoctorStep ? "doctor" : "time");
          }}
          label={t.next}
        />
      </>
    );
  } else if (step === "time") {
    bar = (
      <>
        {/* A link with one service and one doctor opens here, so there is
            nowhere back to; nor is there while the patient is only choosing
            another time for a code already accepted. */}
        {step === firstStep || retiming ? <span /> : <BackBtn onClick={backFromTime} label={t.back} />}
        <PrimaryBtn
          disabled={!slot || busy}
          busy={busy}
          onClick={() => {
            setError("");
            if (retiming && slot) {
              setNewTime(slot);
              void verify(code, slot);
            } else setStep("details");
          }}
          label={retiming ? t.verifyAndBook : t.next}
        />
      </>
    );
  } else if (step === "details") {
    bar = (
      <>
        <BackBtn onClick={() => setStep("time")} label={t.back} />
        <PrimaryBtn
          disabled={!detailsValid || !questionsValid || busy}
          busy={busy}
          onClick={submit}
          label={verifyByOtp ? t.sendCode : t.verifyAndBook}
        />
      </>
    );
  } else if (step === "verify") {
    bar = (
      <>
        <BackBtn
          onClick={() => {
            setError("");
            setStep(retiming ? "time" : "details");
          }}
          label={t.back}
        />
        <PrimaryBtn disabled={code.length !== 6 || busy} busy={busy} onClick={() => void verify(code, newTime)} label={t.verifyAndBook} />
      </>
    );
  }

  const card = (s: React.ReactNode) =>
    `flex min-h-[4.25rem] w-full touch-manipulation items-center gap-3.5 rounded-2xl border px-4 py-3.5 text-start transition-colors ${s}`;
  const plainCard = card("border-line bg-surface hover:border-[var(--bk-line)] hover:bg-[var(--bk-soft)]");

  /*
    The band in the clinic's colour, or a plain white page (0107). Plain on a
    phone is the sheet edge to edge under a quiet header; from a tablet up it
    is the same sheet as a bordered card. `gutter` is the sheet's side padding
    in each, which the date strip bleeds out to.
  */
  const banded = brandHeader;
  const gutter = banded ? "px-5 sm:px-6" : "px-4 sm:px-6";
  const bleed = banded ? "-mx-5 px-5 sm:-mx-6 sm:px-6" : "-mx-4 px-4 sm:-mx-6 sm:px-6";

  return (
    <main
      dir={dir}
      className={`theme-light min-h-dvh text-ink-900 ${banded ? "bg-sunken" : "bg-surface"}`}
      data-booking-style={banded ? "band" : "plain"}
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
      {/*
        The clinic, in its own colour. Ink on it is chosen by contrast
        (brandTokens), so a pale brand gets dark writing instead of white on
        white.
      */}
      <header
        className={
          banded
            ? "px-4 pb-12 pt-[max(1.5rem,env(safe-area-inset-top))]"
            : "border-b border-line px-4 pb-4 pt-[max(1.25rem,env(safe-area-inset-top))] sm:border-b-0"
        }
        style={banded ? { background: "var(--band)", color: "var(--band-ink)" } : undefined}
        data-booking-band={banded ? "" : undefined}
      >
        <div className="mx-auto flex max-w-lg items-center gap-3.5">
          {clinic.hasLogo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/public/clinic-logo/${clinic.slug}`}
              alt=""
              className={`h-14 w-14 shrink-0 rounded-2xl bg-white object-contain p-1 ${banded ? "" : "border border-line"}`}
            />
          ) : (
            <span
              className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl font-display text-[22px] font-bold"
              style={{ color: "var(--bk)", background: banded ? "#ffffff" : "var(--bk-soft)" }}
            >
              {clinicName.slice(0, 1)}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-[19px] font-bold leading-tight">{clinicName}</h1>
            {address && (
              <a
                href={clinic.mapsUrl ?? undefined}
                target="_blank"
                rel="noreferrer"
                className="mt-1 flex items-center gap-1 text-[13px] opacity-85"
              >
                <MapPin className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{address}</span>
              </a>
            )}
          </div>
          <button
            type="button"
            onClick={() => setLocale(isAr ? "en" : "ar")}
            aria-label={isAr ? "English" : "العربية"}
            className="grid h-10 min-w-10 shrink-0 touch-manipulation place-items-center rounded-full border px-3 text-[13px] font-semibold"
            style={{
              borderColor: !banded
                ? "var(--color-line-strong)"
                : brand.bandInk === "#ffffff"
                  ? "rgba(255,255,255,0.45)"
                  : "rgba(11,18,32,0.25)",
            }}
          >
            {isAr ? "EN" : "ع"}
          </button>
        </div>
      </header>

      <div className={`mx-auto max-w-lg ${banded ? "-mt-7 px-3 sm:px-4" : "sm:mt-2 sm:px-4"}`}>
        <div className={banded ? "rounded-[22px] bg-surface shadow-pop" : "bg-surface sm:rounded-[22px] sm:border sm:border-line"}>
          <div className={`${gutter} pb-6 pt-5`}>
            {services.length === 0 ? (
              /* Nothing to book: say so, and how to book instead. */
              <section className="py-8 text-center" data-booking-empty>
                <CalendarX className="mx-auto mb-3 h-10 w-10 text-ink-300" />
                <h2 className="text-[16px] font-semibold">{t.noServices}</h2>
                <p className="mt-1 text-[14px] text-ink-500">{t.noServicesHint}</p>
                {clinic.phone && (
                  <a
                    href={`tel:${clinic.phone}`}
                    className="mt-5 inline-flex h-11 items-center gap-2 rounded-full px-5 text-[14px] font-semibold"
                    style={{ background: "var(--bk)", color: "var(--bk-ink)" }}
                  >
                    <Phone className="h-4 w-4" />
                    {t.callClinic}
                  </a>
                )}
              </section>
            ) : (
              <>
                {/* The clinic's own words, once, before the first question. */}
                {step === firstStep && !retiming && (headline || intro) && (
                  <div className="mb-5 border-b border-line pb-5" data-booking-intro>
                    {headline && <p className="font-display text-[18px] font-bold leading-snug">{headline}</p>}
                    {intro && <p className="mt-1.5 whitespace-pre-line text-[14px] leading-6 text-ink-500">{intro}</p>}
                  </div>
                )}

                {step !== "done" && (
                  <>
                    <p className="text-[12px] font-semibold text-ink-500 tabular-nums">
                      {t.stepOf.replace("{n}", String(stepIndex + 1)).replace("{total}", String(totalSteps))}
                    </p>
                    <h2 className="mt-1 font-display text-[21px] font-bold leading-tight">{title[step]}</h2>
                    {/* One mark per step this link has; qa counts them. */}
                    <div className="mb-5 mt-3 flex gap-1" data-booking-progress={totalSteps} aria-hidden>
                      {Array.from({ length: totalSteps }, (_, i) => (
                        <span
                          key={i}
                          className="h-1 flex-1 rounded-full transition-colors duration-300"
                          style={{ background: i <= stepIndex ? "var(--bk)" : "var(--color-line)" }}
                        />
                      ))}
                    </div>
                  </>
                )}

                {/* STEP: section */}
                {step === "section" && (
                  <section className="grid gap-2.5 animate-fade-up motion-reduce:animate-none">
                    {sections.map((sec) => (
                      <button
                        key={sec.id ?? "__unfiled"}
                        type="button"
                        onClick={() => {
                          setSectionId(sec.id);
                          setStep("service");
                        }}
                        className={plainCard}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-[15.5px] font-semibold">
                            {/* An unfiled group has no name of its own — it is
                                whatever the clinic has not filed yet. */}
                            {sec.id === null ? t.otherSection : nameOf(sec)}
                          </div>
                          <div className="mt-0.5 text-[13px] text-ink-500 tabular-nums">
                            {sec.count === 1 ? t.oneService : t.servicesCount.replace("{n}", String(sec.count))}
                          </div>
                        </div>
                        <ChevronRight className="h-5 w-5 shrink-0 text-ink-300 rtl:rotate-180" />
                      </button>
                    ))}
                  </section>
                )}

                {/* STEP: service — one, or (where the link allows) several ticked. */}
                {step === "service" && !multi && (
                  <section className="grid gap-2.5 animate-fade-up motion-reduce:animate-none">
                    {shownServices.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => {
                          setPicked([s]);
                          setError("");
                          setStep(showDoctorStep ? "doctor" : "time");
                        }}
                        className={plainCard}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-[15.5px] font-semibold leading-snug">{nameOf(s)}</div>
                          <div className="mt-1 flex items-center gap-1.5 text-[13px] text-ink-500 tabular-nums">
                            <Clock className="h-3.5 w-3.5" />
                            {s.durationMin} {t.duration}
                            {price(s)}
                          </div>
                        </div>
                        <ChevronRight className="h-5 w-5 shrink-0 text-ink-300 rtl:rotate-180" />
                      </button>
                    ))}
                  </section>
                )}
                {step === "service" && multi && (
                  <section className="grid gap-4 animate-fade-up motion-reduce:animate-none" data-multi-services>
                    <p className="-mt-2 text-[13.5px] leading-5 text-ink-500">{t.chooseServicesHint}</p>
                    {(sections.length > 1
                      ? sections.map((sec) => ({ sec, items: services.filter((s) => s.sectionId === sec.id) }))
                      : [{ sec: null as Section | null, items: services }]
                    )
                      .filter((g) => g.items.length)
                      .map((g) => (
                        <div key={g.sec?.id ?? "__all"} className="grid gap-2">
                          {g.sec && (
                            <h3 className="text-[12.5px] font-semibold text-ink-500">
                              {g.sec.id === null ? t.otherSection : nameOf(g.sec)}
                            </h3>
                          )}
                          {g.items.map((s) => {
                            const on = picked.some((x) => x.id === s.id);
                            return (
                              <button
                                key={s.id}
                                type="button"
                                aria-pressed={on}
                                onClick={() => toggleService(s)}
                                className={card(on ? "" : "border-line bg-surface hover:border-[var(--bk-line)]")}
                                style={on ? { borderColor: "var(--bk-line)", background: "var(--bk-soft)" } : undefined}
                                data-service-toggle={s.id}
                              >
                                <span
                                  className="grid h-6 w-6 shrink-0 place-items-center rounded-lg border-2 transition-colors"
                                  style={
                                    on
                                      ? { background: "var(--bk)", borderColor: "var(--bk)", color: "var(--bk-ink)" }
                                      : { borderColor: "var(--color-line-strong)" }
                                  }
                                  aria-hidden
                                >
                                  {on && <Check className="h-4 w-4" strokeWidth={3} />}
                                </span>
                                <div className="min-w-0 flex-1">
                                  <div className="text-[15.5px] font-semibold leading-snug">{nameOf(s)}</div>
                                  <div className="mt-1 flex items-center gap-1.5 text-[13px] text-ink-500 tabular-nums">
                                    <Clock className="h-3.5 w-3.5" />
                                    {s.durationMin} {t.duration}
                                    {price(s)}
                                  </div>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      ))}
                  </section>
                )}

                {/* STEP: doctor */}
                {step === "doctor" && (
                  <section className="grid gap-2.5 animate-fade-up motion-reduce:animate-none">
                    {copy.allowAnyDoctor && (
                      <button
                        type="button"
                        onClick={() => {
                          setDoctorId(null);
                          setStep("time");
                        }}
                        className={card("border-dashed border-line-strong bg-surface hover:bg-[var(--bk-soft)]")}
                      >
                        <span
                          className="grid h-12 w-12 shrink-0 place-items-center rounded-full"
                          style={{ background: "var(--bk-soft)", color: "var(--bk-text)" }}
                        >
                          <Users className="h-5 w-5" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-[15.5px] font-semibold">{t.anyDoctor}</div>
                          <div className="mt-0.5 text-[13px] text-ink-500">{t.anyDoctorHint}</div>
                        </div>
                        <ChevronRight className="h-5 w-5 shrink-0 text-ink-300 rtl:rotate-180" />
                      </button>
                    )}
                    {doctors.map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => {
                          setDoctorId(d.id);
                          setStep("time");
                        }}
                        className={plainCard}
                      >
                        <DoctorFace bslug={bslug} doctor={d} />
                        <div className="min-w-0 flex-1">
                          <div className="text-[15.5px] font-semibold">{d.name}</div>
                          {(d.specialty || d.title) && <div className="mt-0.5 text-[13px] text-ink-500">{d.specialty || d.title}</div>}
                        </div>
                        <ChevronRight className="h-5 w-5 shrink-0 text-ink-300 rtl:rotate-180" />
                      </button>
                    ))}
                  </section>
                )}

                {/* STEP: time */}
                {step === "time" && (
                  <section className="animate-fade-up motion-reduce:animate-none">
                    {crumb && <p className="-mt-1 mb-4 text-[13px] font-medium text-ink-500">{crumb}</p>}
                    <p className="mb-2 text-[13px] font-semibold text-ink-700" aria-live="polite">
                      {DateTime.fromISO(date, { zone: clinic.tz }).setLocale(fmtLocale).toFormat("LLLL yyyy")}
                    </p>
                    {/* The date strip. Each chip's day is the one `span.tnum` in it — how qa finds the chips. */}
                    <div className={`${bleed} mb-5 flex snap-x gap-2 overflow-x-auto overscroll-x-contain pb-1 [scrollbar-width:none]`}>
                      {days.map((d) => {
                        const iso = d.toISODate()!;
                        const active = iso === date;
                        // `null` counts = still loading; never disable on unknown.
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
                            <span className="text-[11.5px] font-medium opacity-75">{d.setLocale(fmtLocale).toFormat("ccc")}</span>
                            <span className="text-[18px] font-bold leading-none tnum">{d.day}</span>
                            {open && !active && (
                              <span className="absolute bottom-1.5 h-1 w-1 rounded-full" style={{ background: "var(--bk)" }} aria-hidden />
                            )}
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
                      <div className="rounded-2xl border border-dashed border-line-strong px-4 py-8 text-center">
                        <p className="text-sm text-ink-500">{t.noSlots}</p>
                        {/*
                          A dead end otherwise. The strip already knows where the next
                          open day is, so offer it instead of making the patient hunt.
                        */}
                        {firstOpenDay && (
                          <button
                            type="button"
                            onClick={() => setDate(firstOpenDay)}
                            className="mt-3 text-sm font-semibold underline underline-offset-4"
                            style={{ color: "var(--bk-text)" }}
                          >
                            {t.nextAvailable} {DateTime.fromISO(firstOpenDay).setLocale(fmtLocale).toFormat("cccc d LLLL")}
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
                    {error && <ErrorLine text={error} />}
                  </section>
                )}

                {/*
                  STEP: details — name, number, and whatever else the clinic asks.

                  One step, not two: the patient has already chosen a time and is
                  now simply telling the clinic about themselves, and "your name"
                  and "what brings you in" are the same errand. Merged, the whole
                  form is visible at once and its length is honest from the start.
                */}
                {step === "details" && slotLocal && (
                  <section className="animate-fade-up motion-reduce:animate-none">
                    <AppointmentCard
                      when={slotLocal}
                      services={serviceNames}
                      doctor={chosenDoctor?.name}
                      withLabel={t.with}
                      length={length}
                    />
                    <div className="mt-6 grid gap-4">
                      <input
                        value={fullName}
                        onChange={(e) => setFullName(e.target.value)}
                        placeholder={t.fullName}
                        aria-label={t.fullName}
                        autoComplete="name"
                        className="h-12 scroll-mb-28 rounded-xl border border-line-strong bg-surface px-4 text-[16px] outline-none focus:border-[var(--bk-text)]"
                      />
                      <div>
                        <span className="mb-1.5 block text-[13px] font-semibold">{t.phone}</span>
                        {/*
                          The country first, the clinic's own by default: a
                          patient with a Palestinian or Saudi number picks it
                          rather than having it refused (2026-11-14).
                        */}
                        <PhoneInput
                          value={phone}
                          defaultCountry={homeCountry}
                          onChange={setPhone}
                          placeholder={homeCountry === "JO" ? "079 000 0000" : undefined}
                          size="lg"
                          locale={locale}
                          countryLabel={isAr ? "الدولة" : "Country"}
                          // `tel`, not `tel-national`: autofill hands over the whole number, and the field reads its code.
                          inputAttrs={{ autoComplete: "tel", "aria-label": t.phone }}
                        />
                        <span className="mt-1.5 flex items-start gap-1.5 text-[12.5px] leading-5 text-ink-500">
                          <MessageCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          {verifyByOtp ? t.phoneHint : t.phoneHintNoCode}
                        </span>
                      </div>
                    </div>

                    {activeQuestions.length > 0 && (
                      <>
                        <h3 className="mb-3 mt-6 border-t border-line pt-5 text-[14px] font-semibold">{t.fewMore}</h3>
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
                      <label className="mt-5 flex cursor-pointer items-start gap-2.5 rounded-xl border border-line-strong p-3.5">
                        <input
                          type="checkbox"
                          checked={consent}
                          onChange={(e) => setConsent(e.target.checked)}
                          className="mt-0.5 h-4.5 w-4.5 shrink-0 accent-[var(--bk-text)]"
                        />
                        <span className="whitespace-pre-line text-[13px] leading-6 text-ink-700">{consentText}</span>
                      </label>
                    )}

                    {error && <ErrorLine text={error} />}
                    <PrivacyNote t={t} />
                  </section>
                )}

                {/* STEP: verify */}
                {step === "verify" && (
                  <section className="animate-fade-up text-center motion-reduce:animate-none">
                    <span
                      className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-full"
                      style={{ background: "var(--bk-soft)", color: "var(--bk-text)" }}
                    >
                      <MessageCircle className="h-7 w-7" />
                    </span>
                    <p className="num mb-5 text-[14px] text-ink-500 tabular-nums">{formatPhone(phone) || phone}</p>
                    <input
                      dir="ltr"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      autoFocus
                      maxLength={6}
                      value={code}
                      onChange={(e) => {
                        const v = e.target.value.replace(/\D/g, "").slice(0, 6);
                        setCode(v);
                        // Six digits are the whole answer: no second tap to send them.
                        if (v.length === 6) void verify(v, newTime);
                      }}
                      placeholder={t.codePlaceholder}
                      aria-label={t.enterCode}
                      className="mx-auto block h-14 w-52 rounded-xl border border-line-strong bg-surface text-center text-2xl font-bold tracking-[0.3em] tabular-nums outline-none focus:border-[var(--bk-text)]"
                    />
                    {error && <p className="mt-3 text-sm text-danger" role="alert">{error}</p>}
                    <button
                      type="button"
                      onClick={resend}
                      disabled={resendIn > 0 || busy}
                      className="mt-4 min-h-10 text-[13px] font-medium text-ink-500 underline underline-offset-4 disabled:no-underline disabled:opacity-60"
                    >
                      {resendIn > 0 ? `${t.resendIn} ${resendIn}` : t.resend}
                    </button>
                  </section>
                )}

                {/* STEP: done */}
                {step === "done" && slotLocal && (
                  <section className="animate-fade-up pt-2 text-center motion-reduce:animate-none">
                    <span
                      className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full"
                      style={{ background: "var(--bk)", color: "var(--bk-ink)" }}
                    >
                      <Check className="h-8 w-8" strokeWidth={2.5} />
                    </span>
                    <h2 className="font-display text-[22px] font-bold">{doneStatus === "confirmed" ? t.booked : t.bookedPending}</h2>
                    <p className="mx-auto mt-1 max-w-xs text-[14px] leading-6 text-ink-500">
                      {doneStatus === "confirmed" ? t.bookedBody : t.bookedPendingBody}
                    </p>
                    <div className="mt-6">
                      <AppointmentCard
                        when={slotLocal}
                        services={serviceNames}
                        doctor={chosenDoctor?.name}
                        withLabel={t.with}
                        length={length}
                      />
                    </div>
                    {successNote && (
                      <p className="mt-4 whitespace-pre-line rounded-2xl bg-sunken p-4 text-start text-[13.5px] leading-6 text-ink-700">
                        {successNote}
                      </p>
                    )}
                    {/*
                      An online meeting has a link and no address, so the join button
                      takes the place of the phone number — the two are alternatives,
                      not a row of options. The link is also in the WhatsApp message.
                    */}
                    {joinUrl && (
                      <a
                        href={joinUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-5 inline-flex h-12 w-full items-center justify-center gap-2 rounded-full px-5 text-[15px] font-semibold"
                        style={{ background: "var(--bk)", color: "var(--bk-ink)" }}
                      >
                        <Video className="h-4 w-4" />
                        {t.joinMeeting}
                      </a>
                    )}
                    <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                      <AddToCalendar
                        label={t.addToCalendar}
                        startISO={slot!.startISO}
                        minutes={totalMin}
                        title={`${serviceNames.join(" + ")} — ${clinicName}`}
                        location={joinUrl || address || ""}
                        url={joinUrl}
                      />
                      {!joinUrl && clinic.phone && (
                        <a
                          href={`tel:${clinic.phone}`}
                          className="inline-flex h-11 items-center gap-2 rounded-full border border-line-strong bg-surface px-4 text-[13.5px] font-semibold"
                        >
                          <Phone className="h-4 w-4" />
                          {t.callClinic}
                        </a>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={reset}
                      className="mt-6 min-h-10 w-full text-[14px] font-semibold underline underline-offset-4"
                      style={{ color: "var(--bk-text)" }}
                    >
                      {t.bookAgain}
                    </button>
                  </section>
                )}
              </>
            )}
          </div>

          {/*
            Back and the step's one action, held at the bottom of the phone's
            screen while the times or the questions scroll under them.
          */}
          {bar && (
            <div
              className={`sticky bottom-0 z-10 flex items-center justify-between gap-3 border-t border-line bg-surface ${gutter} pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] ${banded ? "rounded-b-[22px]" : "sm:rounded-b-[22px]"}`}
              data-booking-bar
            >
              {bar}
            </div>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 py-8 text-center">
          <PoweredBy label={t.poweredBy} />
          <PrivacyLink label={t.privacy} />
        </footer>
      </div>
    </main>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <p className="mt-4 rounded-xl bg-danger-soft px-3.5 py-2.5 text-[13.5px] text-danger" role="alert">
      {text}
    </p>
  );
}

function BackBtn({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-12 shrink-0 touch-manipulation rounded-full px-4 text-[15px] font-semibold text-ink-500 hover:bg-sunken"
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
      className="inline-flex h-12 min-w-[9rem] shrink-0 touch-manipulation items-center justify-center gap-2 rounded-full px-6 text-[15px] font-semibold shadow-card transition-opacity disabled:opacity-40"
      style={{ background: "var(--bk)", color: "var(--bk-ink)" }}
    >
      {busy && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {label}
    </button>
  );
}
