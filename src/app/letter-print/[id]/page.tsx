import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Fragment } from "react";
import { withSystem } from "@/lib/db";
import { verifyPrintKeyFor } from "@/lib/print-token";
import { readFileBuffer } from "@/lib/storage";
import { clinicNow, fmtDate, fmtDateOnly } from "@/lib/dates";
import { formatPhone } from "@/lib/phone";
import { dictFor } from "@/lib/i18n/client-dict";
import { ageOn, daysPhrase, leaveUntil, letterNumber, type LetterKind } from "@/lib/medical-letters";
import { PoweredBy } from "@/components/powered-by";
import { whiteLabelSql } from "@/lib/white-label";

export const metadata: Metadata = { robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const KINDS = ["letter"] as const;

/**
 * The page a medical letter's PDF is made of: a sick leave, a medical report or
 * a referral on the clinic's letterhead, signed by the doctor (migration 0123).
 *
 * The prescription print page's twin (rx-print): rendered by the worker's
 * Chromium, reachable only with a short-lived HMAC over the letter's id, and
 * everything on it read from the letter itself. The language is the letter's.
 */
export default async function LetterPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ exp?: string; sig?: string; kind?: string }>;
}) {
  const { id } = await params;
  const { exp, sig, kind = "letter" } = await searchParams;
  if (!verifyPrintKeyFor(id, kind, exp, sig, KINDS)) notFound();

  const l = await withSystem(async (c) => {
    const r = await c.query(
      `select l.kind, l.number, l.created_at, l.locale, l.doctor_name, l.doctor_license_no, l.doctor_syndicate_no,
              l.diagnosis, l.body, l.addressee, l.leave_from::text as leave_from, l.leave_days, l.urgent,
              a.starts_at as visit_at,
              p.full_name as patient_name, p.gender, p.birth_date::text as birth_date, p.national_id, p.file_no,
              u.signature_png_path,
              cl.name, cl.name_ar, cl.slug, cl.logo_path, cl.brand_color, cl.address, cl.address_ar,
              ${whiteLabelSql()} as white_label,
              cl.phone_e164 as clinic_phone, cl.timezone, cl.moh_license_no
         from medical_letters l
         join patients p on p.id = l.patient_id
         join clinics cl on cl.id = l.clinic_id
         left join appointments a on a.id = l.appointment_id
         left join clinic_members m on m.id = l.doctor_member_id
         left join users u on u.id = m.user_id
        where l.id = $1`,
      [id]
    );
    return r.rows[0];
  });
  if (!l) notFound();

  // Inlined for the reason rx-print gives: Chromium arrives with no session.
  let signature: string | null = null;
  if (l.signature_png_path) {
    const buf = await readFileBuffer(l.signature_png_path as string).catch(() => null);
    if (buf) signature = `data:image/png;base64,${buf.toString("base64")}`;
  }

  const locale = l.locale === "en" ? "en" : "ar";
  const isAr = locale === "ar";
  const L = dictFor(locale).letters.sheet;
  const letterKind = l.kind as LetterKind;
  const clinicName = (isAr ? l.name_ar : null) || l.name;
  const address = (isAr ? l.address_ar : null) || l.address;
  const gender: "male" | "female" | "any" = l.gender === "male" || l.gender === "female" ? l.gender : "any";
  const today = clinicNow(l.timezone).toISODate() ?? new Date().toISOString().slice(0, 10);
  const age = ageOn(l.birth_date, today);
  const visitDate = fmtDate(l.visit_at ?? l.created_at, l.timezone, locale);

  const facts = [
    { label: L.patient, value: l.patient_name as string, wide: true },
    age !== null && { label: L.age, value: L.years.replace("{n}", String(age)) },
    gender !== "any" && { label: L.gender, value: L[gender] },
    l.national_id && { label: L.nationalId, value: String(l.national_id), ltr: true },
    l.file_no && { label: L.fileNo, value: String(l.file_no), ltr: true },
  ].filter(Boolean) as { label: string; value: string; wide?: boolean; ltr?: boolean }[];

  const addressee = letterKind === "referral" ? l.addressee : (l.addressee as string).trim() || L.toWhom;

  return (
    <main
      dir={isAr ? "rtl" : "ltr"}
      className="bg-white text-ink-900"
      style={{ "--bk": l.brand_color } as React.CSSProperties}
    >
      <div className="mx-auto flex min-h-[285mm] w-full max-w-[210mm] flex-col bg-white">
        <div className="h-2.5 w-full" style={{ background: "var(--bk)" }} />
        <div className="flex flex-1 flex-col px-12 pb-8 pt-10">
          <header className="flex items-start justify-between gap-6">
            <div className="flex items-center gap-4">
              {l.logo_path ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/public/clinic-logo/${l.slug}`}
                  alt=""
                  className="h-16 w-16 rounded-2xl border border-line object-cover"
                />
              ) : (
                <span
                  className="flex h-16 w-16 items-center justify-center rounded-2xl text-2xl font-bold text-white"
                  style={{ background: "var(--bk)" }}
                >
                  {String(clinicName).slice(0, 1)}
                </span>
              )}
              <div>
                <h1 className="font-display text-xl font-bold">{clinicName}</h1>
                {address && <p className="text-[0.8125rem] text-ink-500">{address}</p>}
                {l.clinic_phone && (
                  <p className="text-[0.8125rem] text-ink-500 tnum" dir="ltr">
                    {formatPhone(l.clinic_phone)}
                  </p>
                )}
                {l.moh_license_no && (
                  <p className="text-[0.75rem] text-ink-500">
                    {L.facilityLicense}: <bdi className="tnum">{l.moh_license_no}</bdi>
                  </p>
                )}
              </div>
            </div>
            <div className="text-end">
              <div className="text-[0.8125rem] font-semibold uppercase tracking-widest text-ink-500">
                {L.titles[letterKind]}
              </div>
              <div className="font-display text-lg font-bold tnum" dir="ltr">
                {letterNumber(l.number)}
              </div>
              <div className="mt-1 text-[0.8125rem] text-ink-500">
                {L.date}: {fmtDate(l.created_at, l.timezone, locale)}
              </div>
            </div>
          </header>

          <h2 className="mt-10 text-center font-display text-2xl font-bold" style={{ color: "var(--bk)" }}>
            {L.titles[letterKind]}
            {letterKind === "referral" && l.urgent && (
              <span className="ms-3 rounded-full bg-[#b42318] px-3 py-0.5 align-middle text-[0.8125rem] font-bold text-white">
                {L.urgent}
              </span>
            )}
          </h2>

          {letterKind !== "sick_leave" && (
            <p className="mt-6 text-[0.9375rem]">
              <span className="font-semibold">{L.to}:</span> <bdi>{addressee}</bdi>
            </p>
          )}

          <section
            className="mt-5 grid grid-cols-4 gap-x-6 gap-y-3 rounded-xl border border-line px-5 py-4"
            style={{ borderColor: "color-mix(in srgb, var(--bk) 25%, transparent)" }}
          >
            {facts.map((f) => (
              <div key={f.label} className={`min-w-0 ${f.wide ? "col-span-2" : ""}`}>
                <div className="text-[0.75rem] font-semibold uppercase tracking-widest text-ink-500">{f.label}</div>
                <div className={`mt-1 text-[0.9375rem] font-semibold ${f.ltr ? "tnum" : ""}`}>
                  <bdi>{f.value}</bdi>
                </div>
              </div>
            ))}
          </section>

          {letterKind === "sick_leave" && (
            <section className="mt-8 space-y-4 text-[1rem] leading-8">
              <p>
                {fill(L.leave[gender], {
                  name: l.patient_name,
                  visit: visitDate,
                  days: daysPhrase(l.leave_days, locale),
                  from: fmtDateOnly(l.leave_from, locale),
                  to: fmtDateOnly(leaveUntil(l.leave_from, l.leave_days), locale),
                })}
              </p>
              {l.diagnosis && (
                <p>
                  <span className="font-semibold">{L.diagnosis}:</span> <bdi>{l.diagnosis}</bdi>
                </p>
              )}
              <p className="text-ink-700">{L.leaveIssued[gender]}</p>
            </section>
          )}

          {letterKind !== "sick_leave" && (
            <section className="mt-7 space-y-5 text-[0.9375rem] leading-7">
              {l.diagnosis && (
                <p>
                  <span className="font-semibold">{L.diagnosis}:</span> <bdi>{l.diagnosis}</bdi>
                </p>
              )}
              {l.body && (
                <div>
                  <div className="text-[0.75rem] font-semibold uppercase tracking-widest text-ink-500">
                    {letterKind === "referral" ? L.reason : L.report}
                  </div>
                  <p className="mt-1.5 whitespace-pre-wrap" dir="auto">
                    {l.body}
                  </p>
                </div>
              )}
              <p className="text-ink-700">{letterKind === "referral" ? L.referralClose : L.reportIssued[gender]}</p>
            </section>
          )}

          <div className="mt-auto flex items-end justify-end pt-12">
            <div className="w-64 text-center">
              {signature ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={signature} alt="" className="mx-auto h-20 max-w-full object-contain" />
              ) : (
                <div className="h-20" />
              )}
              <div className="border-t border-ink-300 pt-2 text-[0.875rem] font-semibold">{l.doctor_name}</div>
              {(l.doctor_license_no || l.doctor_syndicate_no) && (
                <div className="text-[0.75rem] text-ink-700">
                  {l.doctor_license_no && (
                    <span>
                      {L.licenseNo}: <bdi className="tnum">{l.doctor_license_no}</bdi>
                    </span>
                  )}
                  {l.doctor_license_no && l.doctor_syndicate_no && " · "}
                  {l.doctor_syndicate_no && (
                    <span>
                      {L.syndicateNo}: <bdi className="tnum">{l.doctor_syndicate_no}</bdi>
                    </span>
                  )}
                </div>
              )}
              <div className="text-[0.75rem] text-ink-500">{L.signature}</div>
            </div>
          </div>

          <div className="mt-8 flex justify-center border-t border-line pt-4">
            <PoweredBy label={L.poweredBy} showUrl hidden={!!l.white_label} />
          </div>
        </div>
      </div>
    </main>
  );
}

/**
 * Fills `{name}`-style tokens with bold, direction-isolated values: a Latin
 * name or a date inside an Arabic sentence must not drag the words around it.
 */
function fill(template: string, values: Record<string, string>): React.ReactNode {
  return template.split(/(\{\w+\})/g).map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part);
    if (!m || !(m[1] in values)) return <Fragment key={i}>{part}</Fragment>;
    return (
      <strong key={i} className="font-semibold">
        <bdi>{values[m[1]]}</bdi>
      </strong>
    );
  });
}
