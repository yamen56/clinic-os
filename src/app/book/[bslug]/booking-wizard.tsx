"use client";

import { useEffect, useMemo, useState } from "react";
import { DateTime } from "luxon";
import { en } from "@/lib/i18n/en";
import { ar } from "@/lib/i18n/ar";
import {
  CalendarCheck2,
  ChevronRight,
  Clock,
  MapPin,
  MessageCircle,
  Stethoscope,
  User,
  Loader2,
  Check,
} from "lucide-react";

type Service = { id: string; name: string; nameAr: string | null; durationMin: number; price: number };
type Doctor = { id: string; name: string; title: string | null; specialty: string | null };

export function BookingWizard({
  bslug,
  clinic,
  services,
  doctors,
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
    tz: string;
    defaultLocale: "ar" | "en";
  };
  services: Service[];
  doctors: Doctor[];
  maxDaysAhead: number;
  approvalMode: "instant" | "approval";
  lockedDoctor: string | null;
}) {
  const [locale, setLocale] = useState<"ar" | "en">(clinic.defaultLocale);
  const t = (locale === "en" ? en : ar).book;
  const dir = locale === "en" ? "ltr" : "rtl";
  const isAr = locale === "ar";

  type Step = "service" | "doctor" | "time" | "details" | "verify" | "done";
  const [step, setStep] = useState<Step>("service");
  const [service, setService] = useState<Service | null>(null);
  const [doctorId, setDoctorId] = useState<string | null>(lockedDoctor);
  const [date, setDate] = useState(() => DateTime.now().setZone(clinic.tz).toISODate()!);
  const [slots, setSlots] = useState<{ startISO: string; doctorMemberId: string | null }[] | null>(null);
  const [slot, setSlot] = useState<{ startISO: string; doctorMemberId: string | null } | null>(null);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [verificationId, setVerificationId] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [doneStatus, setDoneStatus] = useState<"confirmed" | "pending_approval">("confirmed");

  const clinicName = isAr ? clinic.nameAr || clinic.name : clinic.name;
  const address = isAr ? clinic.addressAr || clinic.address : clinic.address;
  const fmtLocale = isAr ? "ar-JO-u-nu-latn" : "en-GB";

  const days = useMemo(() => {
    const today = DateTime.now().setZone(clinic.tz).startOf("day");
    return Array.from({ length: Math.min(maxDaysAhead, 30) }, (_, i) => today.plus({ days: i }));
  }, [clinic.tz, maxDaysAhead]);

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

  const start = async () => {
    if (!service || !slot) return;
    setBusy(true);
    setError("");
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
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        setError(d.error === "invalid_phone" ? t.invalidPhone : d.error === "slot_taken" ? t.slotTaken : "!");
        return;
      }
      if (d.skipVerify) {
        setDoneStatus(d.status);
        setStep("done");
      } else {
        setVerificationId(d.verificationId);
        setStep("verify");
      }
    } finally {
      setBusy(false);
    }
  };

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
      setStep("done");
    } finally {
      setBusy(false);
    }
  };

  const slotLocal = slot ? DateTime.fromISO(slot.startISO).setZone(clinic.tz).setLocale(fmtLocale) : null;
  const chosenDoctor = doctors.find((d) => d.id === (slot?.doctorMemberId ?? doctorId));

  const stepIndex = { service: 0, doctor: 1, time: 2, details: 3, verify: 3, done: 4 }[step];

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
            {[0, 1, 2, 3].map((i) => (
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
                      setStep(doctors.length > 1 && !lockedDoctor ? "doctor" : "time");
                    }}
                    className="flex items-center gap-3 rounded-card border border-line bg-surface p-4 text-start shadow-card transition-all hover:shadow-pop"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-[15px] font-semibold">{isAr ? s.nameAr || s.name : s.name}</div>
                      <div className="mt-0.5 flex items-center gap-2 text-[13px] text-ink-500 tnum">
                        <Clock className="h-3.5 w-3.5" />
                        {s.durationMin} {t.duration}
                        {s.price > 0 && <span>· {s.price.toFixed(2)} JOD</span>}
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
                <button
                  onClick={() => {
                    setDoctorId(null);
                    setStep("time");
                  }}
                  className="rounded-card border border-dashed border-line-strong bg-surface/70 p-4 text-start text-[15px] font-medium text-ink-700 transition-all hover:shadow-card"
                >
                  {t.anyDoctor}
                </button>
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
                      {d.name.replace(/^د\.\s*/, "").slice(0, 1)}
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
                  return (
                    <button
                      key={iso}
                      onClick={() => setDate(iso)}
                      className="flex w-14 shrink-0 flex-col items-center gap-0.5 rounded-xl border py-2 transition-colors"
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
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              ) : slots.length === 0 ? (
                <p className="rounded-card border border-dashed border-line-strong bg-surface/60 px-4 py-8 text-center text-sm text-ink-500">
                  {t.noSlots}
                </p>
              ) : (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {slots.map((s) => {
                    const local = DateTime.fromISO(s.startISO).setZone(clinic.tz).setLocale(fmtLocale);
                    const active = slot?.startISO === s.startISO;
                    return (
                      <button
                        key={s.startISO}
                        onClick={() => setSlot(s)}
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
              )}
              {error && <p className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
              <div className="mt-5 flex items-center justify-between">
                <BackBtn
                  onClick={() => setStep(doctors.length > 1 && !lockedDoctor ? "doctor" : "service")}
                  label={t.back}
                />
                <PrimaryBtn disabled={!slot} onClick={() => { setError(""); setStep("details"); }} label={t.next} />
              </div>
            </section>
          )}

          {/* STEP: details */}
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
                  className="h-12 rounded-xl border border-line-strong bg-surface px-4 text-[15px] outline-none focus:border-[var(--bk)]"
                />
                <div>
                  <input
                    dir="ltr"
                    inputMode="tel"
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
              {error && <p className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
              <div className="mt-5 flex items-center justify-between">
                <BackBtn onClick={() => setStep("time")} label={t.back} />
                <PrimaryBtn
                  disabled={!fullName.trim() || phone.replace(/\D/g, "").length < 9 || busy}
                  busy={busy}
                  onClick={start}
                  label={t.sendCode}
                />
              </div>
            </section>
          )}

          {/* STEP: verify */}
          {step === "verify" && (
            <section className="animate-fade-up text-center">
              <MessageCircle className="mx-auto mb-3 h-10 w-10" style={{ color: "var(--bk)" }} />
              <h2 className="mb-1 text-[15px] font-semibold">{t.enterCode}</h2>
              <p className="mb-4 text-[13px] text-ink-500 tnum" dir="ltr">{phone}</p>
              <input
                dir="ltr"
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                placeholder={t.codePlaceholder}
                className="mx-auto block h-14 w-48 rounded-xl border border-line-strong bg-surface text-center text-2xl font-bold tracking-[0.3em] tnum outline-none focus:border-[var(--bk)]"
              />
              {error && <p className="mt-3 text-sm text-danger">{error}</p>}
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
              <button
                onClick={() => {
                  setStep("service");
                  setService(null);
                  setSlot(null);
                  setCode("");
                  setError("");
                }}
                className="mt-6 text-sm font-medium underline underline-offset-4"
                style={{ color: "var(--bk)" }}
              >
                {t.bookAgain}
              </button>
            </section>
          )}
        </div>

        <footer className="pt-8 text-center text-[11px] text-ink-400">{t.poweredBy}</footer>
      </div>
    </main>
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
      {busy && <Loader2 className="h-4 w-4 animate-spin" />}
      {label}
    </button>
  );
}
