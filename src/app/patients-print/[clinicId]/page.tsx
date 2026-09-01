import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { withSystem } from "@/lib/db";
import { verifyPrintKeyFor } from "@/lib/print-token";
import { loadPatientExportBatch, MAX_EXPORT_RECORDS } from "@/lib/patient-export";
import { patientFilterSql, type PatientFilters } from "@/lib/patients";
import { fmtDate, fmtDateTime } from "@/lib/dates";
import { formatPhone } from "@/lib/phone";
import { dictFor } from "@/lib/i18n/client-dict";
import { PatientRecord, PrintStyles } from "../../patient-print/record";

export const metadata: Metadata = { robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const KINDS = ["patients"] as const;

/**
 * The whole clinic's records, as one document.
 *
 * The signature is over the *clinic* id rather than a patient's, because that
 * is exactly the authority being granted: everything this clinic holds. The
 * filters ride along unsigned on purpose — tampering with them can only ever
 * select a different subset of the clinic the key already opens in full, so
 * signing them would buy nothing and make the URL unwieldy.
 *
 * One Chromium pass over every record, not one render per patient. A per-file
 * render would be minutes of browser time and would sit on the lane e-signing
 * needs; this is a single page that happens to be long.
 */
export default async function PatientsPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ clinicId: string }>;
  searchParams: Promise<
    { exp?: string; sig?: string; kind?: string } & Record<string, string | undefined>
  >;
}) {
  const { clinicId } = await params;
  const sp = await searchParams;
  const { exp, sig, kind = "patients" } = sp;
  if (!verifyPrintKeyFor(clinicId, kind, exp, sig, KINDS)) notFound();

  const filters: PatientFilters = {
    q: sp.q,
    tag: sp.tag,
    source: sp.source,
    visit: sp.visit,
    optedOut: sp.optedOut,
  };

  const data = await withSystem(async (c) => {
    const exists = (await c.query(`select 1 from clinics where id = $1`, [clinicId])).rows[0];
    if (!exists) return null;

    const { where, values } = patientFilterSql(clinicId, filters);
    /*
      Alphabetical, and capped here as well as at the route. This page is the
      thing that actually does the work, so it is the thing that must not be
      talked into rendering a hundred thousand records.
    */
    const ids = (
      await c.query(
        `select p.id from patients p where ${where}
          order by p.full_name limit ${MAX_EXPORT_RECORDS}`,
        values
      )
    ).rows.map((r) => r.id as string);

    return loadPatientExportBatch(c, clinicId, ids);
  });
  if (!data) notFound();

  const isAr = data.clinic.locale === "ar";
  const t = dictFor(isAr ? "ar" : "en");
  const locale = isAr ? "ar" : "en";
  const tz = data.clinic.timezone;
  const clinicName = (isAr ? data.clinic.nameAr : null) || data.clinic.name;
  const address = (isAr ? data.clinic.addressAr : null) || data.clinic.address;

  /* What the reader is holding: which slice of the clinic, in words. A document
     that says "412 patients" without saying which 412 is not a record. */
  const applied: string[] = [];
  if (filters.q?.trim()) applied.push(`${t.common.search}: ${filters.q.trim()}`);
  if (filters.tag) applied.push(`${t.patients.tags}: ${filters.tag}`);
  if (filters.source)
    applied.push(
      `${t.patients.source}: ${(t.patients.sources as Record<string, string>)[filters.source] ?? filters.source}`
    );
  if (filters.visit) applied.push(`${t.patients.lastVisit}: ${filters.visit}+`);

  const header = (
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
        {t.patients.exportAllTitle}
        <div className="issued-at">{fmtDateTime(data.generatedAt, tz, locale)}</div>
      </div>
    </header>
  );

  return (
    <main
      dir={isAr ? "rtl" : "ltr"}
      className="rec"
      style={{ "--bk": data.clinic.brandColor } as React.CSSProperties}
    >
      <PrintStyles />
      <div className="band" />
      <div className="sheet-inner">
        <section className="cover">
          {header}
          <h1 className="cover-title">{t.patients.exportAllTitle}</h1>
          <p className="cover-sub">{clinicName}</p>

          <table className="cover-meta">
            <tbody>
              <tr>
                <th>{t.patients.exportAllCount}</th>
                <td>{data.records.length}</td>
              </tr>
              <tr>
                <th>{t.patients.exportAllGenerated}</th>
                <td>{fmtDateTime(data.generatedAt, tz, locale)}</td>
              </tr>
              <tr>
                <th>{t.patients.exportAllScope}</th>
                <td>{applied.length ? applied.join(" · ") : t.patients.exportAllScopeAll}</td>
              </tr>
            </tbody>
          </table>

          {/* An index, so a four-hundred-page document can be navigated by a
              person looking for one name. No page numbers: the renderer decides
              those, and a wrong number is worse than none. */}
          <table className="toc">
            <tbody>
              {data.records.map((r, i) => (
                <tr key={r.patient.id}>
                  <td className="num">{i + 1}</td>
                  <td>{r.patient.fullName}</td>
                  <td>
                    {r.patient.phone ? (
                      <span className="tel">{formatPhone(r.patient.phone)}</span>
                    ) : (
                      fmtDate(r.patient.createdAt, tz, locale)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {data.records.map((record) => (
          /* Its own sheet, with the clinic named again at the top: these get
             torn apart and filed separately, and a loose page that does not say
             whose record it is or which clinic wrote it is a liability. */
          <section className="patient-sheet" key={record.patient.id}>
            {header}
            <PatientRecord clinic={data.clinic} record={record} t={t} locale={locale} />
          </section>
        ))}

        <footer className="foot">
          {clinicName} · {t.patients.exportAllTitle} · {fmtDateTime(data.generatedAt, tz, locale)}
        </footer>
      </div>
    </main>
  );
}
