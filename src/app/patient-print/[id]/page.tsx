import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { withSystem } from "@/lib/db";
import { verifyPrintKeyFor } from "@/lib/print-token";
import { loadPatientExport } from "@/lib/patient-export";
import { fmtDateTime } from "@/lib/dates";
import { formatPhone } from "@/lib/phone";
import { dictFor } from "@/lib/i18n/client-dict";
import { applyVocabulary } from "@/lib/i18n/vocab";
import { PatientRecord, PrintStyles } from "../record";

export const metadata: Metadata = { robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const KINDS = ["patient"] as const;

/**
 * The page the patient-record PDF is made of.
 *
 * A real browser renders it, which is the only way Arabic comes out right —
 * letter shaping, ligatures, RTL flow and mixed Arabic/Latin runs all come free
 * from the engine already drawing the app. Building this with pdf-lib produces
 * reversed, unjoined glyphs.
 *
 * Reachable only with a short-lived HMAC over the patient id, so the worker's
 * Chromium can open it without a session and nobody can reach a medical record
 * by guessing a URL. The clinic is read from the *patient*, never from the
 * query string — a signed key names one patient, and that patient's own clinic
 * is the only one whose data may appear.
 */
export default async function PatientPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ exp?: string; sig?: string; kind?: string }>;
}) {
  const { id } = await params;
  const { exp, sig, kind = "patient" } = await searchParams;
  if (!verifyPrintKeyFor(id, kind, exp, sig, KINDS)) notFound();

  const data = await withSystem(async (c) => {
    const owner = (
      await c.query(`select clinic_id from patients where id = $1 and merged_into is null`, [id])
    ).rows[0];
    if (!owner) return null;
    return loadPatientExport(c, owner.clinic_id as string, id);
  });
  if (!data) notFound();

  const isAr = data.clinic.locale === "ar";
  // The workspace's own wording, not just its language — see ExportedClinic.
  const t = applyVocabulary(dictFor(isAr ? "ar" : "en"), data.clinic.vocabulary, isAr ? "ar" : "en");
  const locale = isAr ? "ar" : "en";
  const tz = data.clinic.timezone;
  const clinicName = (isAr ? data.clinic.nameAr : null) || data.clinic.name;
  const address = (isAr ? data.clinic.addressAr : null) || data.clinic.address;

  return (
    <main
      dir={isAr ? "rtl" : "ltr"}
      className="rec"
      style={{ "--bk": data.clinic.brandColor } as React.CSSProperties}
    >
      <PrintStyles />
      <div className="band" />
      <div className="sheet-inner">
        <header className="head">
          <div>
            <div className="clinic-name">{clinicName}</div>
            <div className="clinic-meta">
              {address}
              {address && data.clinic.phone ? " · " : ""}
              {data.clinic.phone && <span className="tel">{formatPhone(data.clinic.phone)}</span>}
            </div>
          </div>
          <div className="issued">
            {t.patients.exportTitle}
            <div className="issued-at">{fmtDateTime(data.generatedAt, tz, locale)}</div>
          </div>
        </header>

        <PatientRecord clinic={data.clinic} record={data} t={t} locale={locale} />

        <footer className="foot">
          {clinicName} · {t.patients.exportTitle} · {fmtDateTime(data.generatedAt, tz, locale)}
        </footer>
      </div>
    </main>
  );
}
