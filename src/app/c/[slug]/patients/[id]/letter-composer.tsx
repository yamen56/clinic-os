"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/client";
import { ConfirmDialog } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { fmtDateOnly } from "@/lib/dates";
import {
  LEAVE_DAY_CHIPS,
  LETTER_KINDS,
  MAX_ADDRESSEE,
  MAX_BODY,
  MAX_DIAGNOSIS,
  MAX_LEAVE_DAYS,
  daysPhrase,
  leaveUntil,
  letterProblem,
  type LetterKind,
  type LetterLocale,
  type LetterRow,
} from "@/lib/medical-letters";
import { createLetterAction } from "./letter-actions";
import { RxSheet, type ComposerData } from "./prescription-composer";
import { BedDouble, ClipboardList, Forward, Printer, Send } from "lucide-react";

/** What the composer opens with: nothing, or an old letter to write again. */
export type LetterDraft = {
  kind?: LetterKind;
  locale?: LetterLocale;
  diagnosis?: string;
  body?: string;
  addressee?: string;
  leaveDays?: number | null;
  urgent?: boolean;
  doctorMemberId?: string | null;
};

const KIND_ICON: Record<LetterKind, React.ReactNode> = {
  sick_leave: <BedDouble className="h-5 w-5" />,
  report: <ClipboardList className="h-5 w-5" />,
  referral: <Forward className="h-5 w-5" />,
};

/**
 * A sick leave, a medical report or a referral, written in a doctor's name.
 *
 * The three share one form because they share most of it — the doctor, the
 * language, the diagnosis — and differ in a field or two. What is typed stays
 * when the kind is switched, so a doctor who started a report and meant a
 * referral loses nothing.
 *
 * The doctors come from the prescription composer's data (`useComposerData`),
 * fetched while the file is idle, so this opens with nothing to wait for.
 */
export function LetterComposer({
  slug,
  patient,
  today,
  draft,
  data,
  reload,
  onClose,
  onSaved,
  appointmentId = null,
}: {
  slug: string;
  patient: { id: string; full_name: string; phone_e164: string | null };
  /** The clinic's today, yyyy-MM-dd: the first day of a new sick leave. */
  today: string;
  draft: LetterDraft | null;
  data: ComposerData | null;
  reload: () => Promise<void>;
  onClose: () => void;
  onSaved: (row: LetterRow, warning: string | undefined, sent: boolean) => void;
  /** The visit going on now: the letter is filed under it. */
  appointmentId?: string | null;
}) {
  const { t, locale: uiLocale } = useI18n();
  const T = t.letters;
  const { toast } = useToast();

  useEffect(() => {
    if (!data) void reload();
  }, [data, reload]);

  const [kind, setKind] = useState<LetterKind>(draft?.kind ?? "sick_leave");
  const [locale, setLocale] = useState<LetterLocale>(
    () => draft?.locale ?? data?.clinic.defaultLocale ?? (uiLocale === "en" ? "en" : "ar")
  );
  const [doctorId, setDoctorId] = useState<string | null>(draft?.doctorMemberId ?? null);
  const [diagnosis, setDiagnosis] = useState(draft?.diagnosis ?? "");
  const [body, setBody] = useState(draft?.body ?? "");
  const [addressee, setAddressee] = useState(draft?.addressee ?? "");
  const [urgent, setUrgent] = useState(!!draft?.urgent);
  const [leaveFrom, setLeaveFrom] = useState(today);
  const [leaveDays, setLeaveDays] = useState<number | null>(draft?.leaveDays ?? 1);
  const [otherDays, setOtherDays] = useState(() => !!draft?.leaveDays && !LEAVE_DAY_CHIPS.includes(draft.leaveDays as 1));
  const [problem, setProblem] = useState<"leave" | "addressee" | "body" | null>(null);
  const [pending, setPending] = useState<"send" | "print" | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // The prescriber, chosen the way the prescription composer chooses.
  useEffect(() => {
    if (!data || (doctorId && data.doctors.some((d) => d.member_id === doctorId))) return;
    const ds = data.doctors;
    const pick =
      ds.find((d) => d.is_me && d.is_doctor) ??
      ds.find((d) => d.member_id === data.lastDoctor) ??
      ds.find((d) => d.is_doctor) ??
      ds.find((d) => d.is_me) ??
      ds[0];
    if (pick) setDoctorId(pick.member_id);
  }, [data, doctorId]);
  const doctor = data?.doctors.find((d) => d.member_id === doctorId) ?? null;

  const snapshot = () => JSON.stringify({ kind, diagnosis, body, addressee, urgent, leaveFrom, leaveDays });
  const opened = useRef<string | null>(null);
  if (opened.current === null) opened.current = snapshot();
  const dirty = snapshot() !== opened.current;

  const requestClose = () => {
    if (pending || confirmDiscard) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const hasPhone = !!patient.phone_e164;

  const submit = (send: boolean) => {
    if (!doctorId || pending) return;
    const p = letterProblem({ kind, diagnosis, body, addressee, leaveFrom, leaveDays });
    if (p) {
      setProblem(p);
      toast(p === "leave" ? T.needLeave : p === "addressee" ? T.needAddressee : T.needBody, "error");
      return;
    }
    setProblem(null);

    // Opened inside the press, or the browser blocks it (see the prescription composer).
    let win: Window | null = null;
    if (!send) {
      win = window.open("", "_blank");
      try {
        win?.document.write(`<p style="font:16px system-ui,sans-serif;padding:32px;color:#4b5159">${T.preparing}</p>`);
      } catch {}
    }

    setPending(send ? "send" : "print");
    createLetterAction(slug, {
      patientId: patient.id,
      doctorMemberId: doctorId,
      kind,
      locale,
      diagnosis,
      body,
      addressee,
      leaveFrom: kind === "sick_leave" ? leaveFrom : null,
      leaveDays: kind === "sick_leave" ? leaveDays : null,
      urgent: kind === "referral" && urgent,
      send,
      appointmentId,
    })
      .then((r) => {
        if (r.error || !r.row) {
          win?.close();
          if (r.error === "leave" || r.error === "addressee" || r.error === "body") setProblem(r.error);
          toast(T.failed, "error");
          setPending(null);
          return;
        }
        if (!send) {
          if (r.warning === "pdf_failed") win?.close();
          else if (win) win.location.href = `/api/c/${slug}/letters/${r.row.id}/pdf`;
          else toast(T.popupBlocked, "error");
        }
        onSaved(r.row, r.warning, send);
      })
      .catch(() => {
        win?.close();
        toast(T.failed, "error");
        setPending(null);
      });
  };

  const footer = (
    <div className="flex items-center gap-2 sm:justify-end">
      <Button
        variant="outline"
        size="lg"
        onClick={() => submit(false)}
        loading={pending === "print"}
        disabled={!!pending || !doctorId}
        aria-label={T.print}
        className="max-[359px]:px-3.5"
        data-letter-print
      >
        <Printer className="h-4 w-4" />
        <span className="max-[359px]:sr-only">{T.print}</span>
      </Button>
      <Button
        size="lg"
        className="min-w-0 flex-1 max-[359px]:px-3 sm:flex-none"
        onClick={() => submit(true)}
        loading={pending === "send"}
        disabled={!!pending || !doctorId || !hasPhone}
        title={hasPhone ? undefined : T.noPhone}
        data-letter-send
      >
        <Send className="h-4 w-4" />
        {T.send}
      </Button>
    </div>
  );

  const until = leaveFrom && leaveDays ? fmtDateOnly(leaveUntil(leaveFrom, leaveDays), uiLocale) : "";

  return (
    <>
      <RxSheet title={T.new} sub={patient.full_name} closeLabel={t.common.close} onClose={requestClose} footer={footer}>
        <div className="mx-auto max-w-2xl space-y-5" data-letter-composer>
          {!hasPhone && (
            <p className="rounded-lg border border-st-pending/30 bg-st-pending/10 px-3 py-2 text-[0.8125rem] text-ink-700">
              {T.noPhone}
            </p>
          )}

          {/* The kind, as three large choices: the first thing decided, and the one that shapes the rest. */}
          <div role="radiogroup" aria-label={T.new} className="grid grid-cols-3 gap-2">
            {LETTER_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                data-letter-kind={k}
                onClick={() => {
                  setKind(k);
                  setProblem(null);
                }}
                className={`flex min-h-[4.5rem] flex-col items-center justify-center gap-1 rounded-ctl border px-2 py-2.5 text-center text-[0.8125rem] font-semibold leading-tight transition-colors duration-140 ${
                  kind === k
                    ? "border-brand-600 bg-brand-600 text-on-brand"
                    : "border-line text-ink-900 hover:bg-sunken"
                }`}
              >
                {KIND_ICON[k]}
                {T.kinds[k]}
              </button>
            ))}
          </div>
          <p className="-mt-3 text-[0.75rem] text-ink-500">{T.kindHints[kind]}</p>

          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
            <label className="block min-w-0">
              <span className="mb-1.5 block text-[0.8125rem] font-medium text-ink-700">{T.doctor}</span>
              <Select value={doctorId ?? ""} onChange={(e) => setDoctorId(e.target.value)} disabled={!data}>
                {!data && <option value="">{t.common.loading}</option>}
                {data?.doctors.map((d) => (
                  <option key={d.member_id} value={d.member_id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </label>
            <div>
              <span className="mb-1.5 block text-[0.8125rem] font-medium text-ink-700">{T.language}</span>
              <div role="radiogroup" aria-label={T.language} className="flex h-10 rounded-ctl border border-line p-0.5">
                {(["ar", "en"] as const).map((l) => (
                  <button
                    key={l}
                    type="button"
                    role="radio"
                    aria-checked={locale === l}
                    aria-label={l === "ar" ? "عربي" : "English"}
                    onClick={() => setLocale(l)}
                    className={`min-w-12 rounded-[6px] px-3 text-sm font-semibold transition-colors duration-140 ${
                      locale === l ? "bg-brand-600 text-on-brand" : "text-ink-700 hover:bg-sunken"
                    }`}
                  >
                    {l === "ar" ? "عربي" : "EN"}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {doctor && !doctor.has_signature && (
            <p className="-mt-2 text-[0.75rem] leading-5 text-ink-500">
              {t.prescriptions.noSignature.replace("{doctor}", doctor.name)}{" "}
              {doctor.is_me && (
                <Link href={`/c/${slug}/signature`} className="font-semibold text-brand-700 underline">
                  {t.prescriptions.addSignature}
                </Link>
              )}
            </p>
          )}

          {kind === "sick_leave" && (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
                <Field label={T.leaveFrom} error={problem === "leave" && !leaveFrom ? T.needLeave : undefined}>
                  <Input
                    type="date"
                    value={leaveFrom}
                    onChange={(e) => setLeaveFrom(e.target.value)}
                    data-letter-from
                  />
                </Field>
                <div>
                  <span className="mb-1.5 block text-[0.8125rem] font-semibold text-ink-900">{T.leaveDays}</span>
                  <div className="flex flex-wrap gap-2">
                    {LEAVE_DAY_CHIPS.map((n) => (
                      <button
                        key={n}
                        type="button"
                        aria-pressed={!otherDays && leaveDays === n}
                        data-letter-days={n}
                        onClick={() => {
                          setOtherDays(false);
                          setLeaveDays(n);
                        }}
                        className={`h-10 min-w-10 rounded-ctl border px-3 text-sm font-semibold tnum transition-colors duration-140 ${
                          !otherDays && leaveDays === n
                            ? "border-brand-600 bg-brand-600 text-on-brand"
                            : "border-line text-ink-900 hover:bg-sunken"
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                    {otherDays ? (
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={MAX_LEAVE_DAYS}
                        autoFocus
                        className="w-24"
                        aria-label={T.leaveDays}
                        value={leaveDays ?? ""}
                        onChange={(e) => {
                          const n = Math.round(Number(e.target.value));
                          setLeaveDays(Number.isFinite(n) && n > 0 ? Math.min(n, MAX_LEAVE_DAYS) : null);
                        }}
                        data-letter-days-other
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => setOtherDays(true)}
                        className="h-10 rounded-ctl border border-line px-3 text-sm font-semibold text-ink-700 hover:bg-sunken"
                      >
                        {T.otherDays}
                      </button>
                    )}
                  </div>
                </div>
              </div>
              {until && leaveDays && (
                <p className="-mt-2 text-[0.8125rem] text-ink-700" data-letter-until>
                  {daysPhrase(leaveDays, uiLocale === "en" ? "en" : "ar")} · {T.leaveUntil.replace("{date}", until)}
                </p>
              )}
              <Field label={T.diagnosis} hint={T.diagnosisLeaveHint}>
                <Input
                  value={diagnosis}
                  maxLength={MAX_DIAGNOSIS}
                  placeholder={T.diagnosisPlaceholder}
                  onChange={(e) => setDiagnosis(e.target.value)}
                  dir="auto"
                />
              </Field>
            </>
          )}

          {kind !== "sick_leave" && (
            <>
              <Field
                label={kind === "referral" ? T.addresseeReferral : T.addresseeReport}
                required={kind === "referral"}
                error={problem === "addressee" ? T.needAddressee : undefined}
              >
                <Input
                  value={addressee}
                  maxLength={MAX_ADDRESSEE}
                  placeholder={kind === "referral" ? T.addresseeReferralPlaceholder : T.addresseeReportPlaceholder}
                  onChange={(e) => setAddressee(e.target.value)}
                  dir="auto"
                  data-letter-addressee
                />
              </Field>
              {kind === "referral" && (
                <label className="flex min-h-10 cursor-pointer items-center gap-2.5 text-sm font-semibold text-ink-900">
                  <input
                    type="checkbox"
                    checked={urgent}
                    onChange={(e) => setUrgent(e.target.checked)}
                    className="h-5 w-5 accent-[var(--color-danger)]"
                  />
                  {T.urgent}
                </label>
              )}
              <Field label={T.diagnosis}>
                <Input
                  value={diagnosis}
                  maxLength={MAX_DIAGNOSIS}
                  placeholder={T.diagnosisPlaceholder}
                  onChange={(e) => setDiagnosis(e.target.value)}
                  dir="auto"
                  data-letter-diagnosis
                />
              </Field>
              <Field
                label={kind === "referral" ? T.bodyReferral : T.bodyReport}
                error={problem === "body" ? T.needBody : undefined}
              >
                <Textarea
                  rows={7}
                  value={body}
                  maxLength={MAX_BODY}
                  placeholder={kind === "referral" ? T.bodyReferralPlaceholder : T.bodyReportPlaceholder}
                  onChange={(e) => setBody(e.target.value)}
                  dir="auto"
                  data-letter-body
                />
              </Field>
            </>
          )}
        </div>
      </RxSheet>
      <ConfirmDialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false);
          onClose();
        }}
        title={T.discardTitle}
        body={T.discardBody}
        confirmLabel={T.discard}
        cancelLabel={T.keepEditing}
      />
    </>
  );
}
