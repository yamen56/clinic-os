import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { withSystem } from "@/lib/db";
import { verifyPrintKeyFor } from "@/lib/print-token";
import { loadPatientExport, type ExportedPatient } from "@/lib/patient-export";
import { fmtDate, fmtDateTime, fmtMoney } from "@/lib/dates";
import { formatPhone } from "@/lib/phone";
import { dictFor } from "@/lib/i18n/client-dict";

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
  const t = dictFor(isAr ? "ar" : "en");
  const locale = isAr ? "ar" : "en";
  const tz = data.clinic.timezone;
  const clinicName = (isAr ? data.clinic.nameAr : null) || data.clinic.name;
  const address = (isAr ? data.clinic.addressAr : null) || data.clinic.address;

  const row = (label: string, value: React.ReactNode) =>
    value ? (
      <tr key={label}>
        <th>{label}</th>
        <td>{value}</td>
      </tr>
    ) : null;

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

        <h1 className="name">{data.patient.fullName}</h1>

        <section className="block">
          <table className="kv">
            <tbody>
              {row(
                t.patients.phone,
                data.patient.phone ? <span className="tel">{formatPhone(data.patient.phone)}</span> : null
              )}
              {row(
                t.patients.secondaryPhone,
                data.patient.secondaryPhone ? (
                  <span className="tel">{formatPhone(data.patient.secondaryPhone)}</span>
                ) : null
              )}
              {row(
                t.patients.birthDate,
                data.patient.birthDate ? fmtDate(data.patient.birthDate, tz, locale) : null
              )}
              {row(
                t.patients.gender,
                data.patient.gender
                  ? ((t.patients as Record<string, unknown>)[data.patient.gender] as string) ??
                      data.patient.gender
                  : null
              )}
              {row(t.insurers.title, data.patient.insurer)}
              {row(t.patients.insuranceNoLabel, data.patient.insuranceNo)}
              {row(t.patients.tags, data.patient.tags.join("، ") || null)}
              {row(t.patients.since, fmtDate(data.patient.createdAt, tz, locale))}
              {data.patient.customFields.map((f) => row(f.label, f.value))}
            </tbody>
          </table>
        </section>

        <Section title={`${t.patients.tabs.notes} (${data.notes.length})`} empty={!data.notes.length} t={t}>
          {data.notes.map((n) => (
            <article key={n.id} className="note">
              <div className="note-head">
                {n.category && <span className="chip">{n.category}</span>}
                <span>{fmtDateTime(n.createdAt, tz, locale)}</span>
                {n.author && <span>· {n.author}</span>}
                {n.editedAt && <span className="muted">· {t.patients.notes.edited}</span>}
              </div>
              {/*
                A recording cannot be printed, so the record states that one
                exists rather than leaving a silent gap where a note should be.
              */}
              {n.hasAudio && (
                <div className="audio-note">
                  {t.patients.exportVoiceNote}
                  {n.audioSeconds ? ` (${n.audioSeconds}s)` : ""}
                </div>
              )}
              {n.body && <p className="note-body">{n.body}</p>}
            </article>
          ))}
        </Section>

        <Section
          title={`${t.patients.tabs.appointments} (${data.appointments.length})`}
          empty={!data.appointments.length}
          t={t}
        >
          <table className="grid">
            <tbody>
              {data.appointments.map((a) => (
                <tr key={a.id}>
                  <td className="nowrap">{fmtDateTime(a.startsAt, tz, locale)}</td>
                  <td>{a.service ?? "—"}</td>
                  <td>{a.doctor ?? "—"}</td>
                  <td className="nowrap">
                    {(t.calendar.statuses as Record<string, string>)[a.status] ?? a.status}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <Section
          title={`${t.patients.tabs.invoices} (${data.invoices.length})`}
          empty={!data.invoices.length}
          t={t}
        >
          <table className="grid">
            <tbody>
              {data.invoices.map((i) => (
                <tr key={i.id}>
                  <td className="nowrap">{i.number}</td>
                  <td className="nowrap">
                    {i.issueDate ? fmtDate(i.issueDate, tz, locale) : "—"}
                  </td>
                  <td className="nowrap">
                    {(t.invoices.statuses as Record<string, string>)[i.status] ?? i.status}
                  </td>
                  <td className="nowrap num">
                    {fmtMoney(i.total, data.clinic.currency, locale)}
                  </td>
                  <td className="nowrap num muted">
                    {fmtMoney(i.amountPaid, data.clinic.currency, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        {data.documents.length > 0 && (
          <Section title={`${t.patients.tabs.documents} (${data.documents.length})`} empty={false} t={t}>
            <table className="grid">
              <tbody>
                {data.documents.map((d) => (
                  <tr key={d.id}>
                    <td>{d.title}</td>
                    <td className="nowrap">{fmtDate(d.createdAt, tz, locale)}</td>
                    <td className="nowrap">
                      {(t.docs.statuses as Record<string, string>)[d.status] ?? d.status}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        )}

        {data.files.length > 0 && (
          <Section title={`${t.patients.tabs.files} (${data.files.length})`} empty={false} t={t}>
            {/* Named, not embedded: an X-ray is not something a text record can
                carry, and a list at least tells the reader what to ask for. */}
            <table className="grid">
              <tbody>
                {data.files.map((f) => (
                  <tr key={f.id}>
                    <td>{f.fileName}</td>
                    <td className="nowrap">{fmtDate(f.createdAt, tz, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        )}

        <footer className="foot">
          {clinicName} · {t.patients.exportTitle} · {fmtDateTime(data.generatedAt, tz, locale)}
        </footer>
      </div>
    </main>
  );
}

function Section({
  title,
  empty,
  t,
  children,
}: {
  title: string;
  empty: boolean;
  t: ReturnType<typeof dictFor>;
  children: React.ReactNode;
}) {
  return (
    <section className="block">
      <h2 className="sec">{title}</h2>
      {empty ? <p className="muted none">{t.common.none}</p> : children}
    </section>
  );
}

/**
 * Print CSS inline rather than in globals, so the page Chromium loads is
 * self-contained: one request, no cascade to wait on, nothing that can be
 * half-applied when the render is taken.
 */
function PrintStyles() {
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `
@page { size: A4; margin: 12mm 0; }
html, body { margin: 0; padding: 0; background: #fff; }
.rec { color: #16181c; font-size: 12px; line-height: 1.7; }
.band { height: 8px; width: 100%; background: var(--bk); }
.sheet-inner { padding: 8mm 16mm 0; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px;
        border-bottom: 1px solid #e3e6eb; padding-bottom: 8px; }
.clinic-name { font-family: var(--font-display), sans-serif; font-size: 16px; font-weight: 700; }
.clinic-meta { font-size: 11px; color: #7a828c; }
.issued { text-align: end; font-size: 11px; color: #4b5159; font-weight: 600; }
.issued-at { font-weight: 400; color: #7a828c; }
.name { font-family: var(--font-display), sans-serif; font-size: 22px; font-weight: 700;
        margin: 14px 0 4px; }

.block { margin-top: 14px; page-break-inside: auto; }
.sec { font-family: var(--font-display), sans-serif; font-size: 13px; font-weight: 700;
       margin: 0 0 6px; padding-bottom: 3px; border-bottom: 2px solid var(--bk);
       page-break-after: avoid; break-after: avoid; }
.muted { color: #7a828c; }
.none { font-size: 11.5px; margin: 2px 0; }

.kv { width: 100%; border-collapse: collapse; font-size: 12px; }
.kv th { text-align: start; width: 34%; color: #4b5159; font-weight: 600; vertical-align: top;
         border-bottom: 1px solid #eef0f3; padding: 4px 0; }
.kv td { border-bottom: 1px solid #eef0f3; padding: 4px 0; }

.grid { width: 100%; border-collapse: collapse; font-size: 11.5px; }
.grid td { border-bottom: 1px solid #eef0f3; padding: 5px 6px; text-align: start;
           vertical-align: top; }
.grid td:first-child { padding-inline-start: 0; }
.grid td:last-child { padding-inline-end: 0; }
.nowrap { white-space: nowrap; }
/* A phone number starts with "+", which is bidi-neutral: in an Arabic
   paragraph the surrounding text claims it and drags it to the far end, so
   +962 79 000 0000 is drawn ending in the plus and reads backwards. */
.tel { unicode-bidi: isolate; direction: ltr; }
.num { font-variant-numeric: tabular-nums; text-align: end; }

/* A note must not be split across a page when it can be helped — half a
   clinical entry at a page break is how a reader misses the other half. */
.note { page-break-inside: avoid; break-inside: avoid; margin-bottom: 9px;
        padding-bottom: 7px; border-bottom: 1px solid #eef0f3; }
.note:last-child { border-bottom: none; }
.note-head { font-size: 10.5px; color: #7a828c; display: flex; flex-wrap: wrap;
             align-items: center; gap: 5px; margin-bottom: 3px; }
.chip { background: #f1f3f6; color: #4b5159; border-radius: 999px; padding: 1px 7px;
        font-weight: 600; }
.note-body { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.audio-note { font-size: 11px; color: #4b5159; font-style: italic; margin-bottom: 2px; }

.foot { margin-top: 16px; padding: 6px 0 10mm; border-top: 1px solid #e3e6eb;
        text-align: center; font-size: 10px; color: #9aa2ac; }
`,
      }}
    />
  );
}
