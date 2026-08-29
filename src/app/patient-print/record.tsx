import type { ExportedClinic, ExportedRecord } from "@/lib/patient-export";
import { fmtDate, fmtDateTime, fmtMoney } from "@/lib/dates";
import { formatPhone } from "@/lib/phone";
import { dictFor } from "@/lib/i18n/client-dict";

type Dict = ReturnType<typeof dictFor>;

/**
 * One patient's record as it appears on paper.
 *
 * Shared by the single-file export and the whole-clinic one on purpose. These
 * are the same document — a clinic handing over one file and a clinic handing
 * over four hundred should not be handing over two different things — and the
 * only way to keep that true over time is for there to be one component.
 */
export function PatientRecord({
  clinic,
  record,
  t,
  locale,
}: {
  clinic: ExportedClinic;
  record: ExportedRecord;
  t: Dict;
  locale: "ar" | "en";
}) {
  const tz = clinic.timezone;
  const { patient: p } = record;

  const row = (label: string, value: React.ReactNode) =>
    value ? (
      <tr key={label}>
        <th>{label}</th>
        <td>{value}</td>
      </tr>
    ) : null;

  return (
    <>
      <h1 className="name">{p.fullName}</h1>

      <section className="block">
        <table className="kv">
          <tbody>
            {row(t.patients.phone, p.phone ? <span className="tel">{formatPhone(p.phone)}</span> : null)}
            {row(
              t.patients.secondaryPhone,
              p.secondaryPhone ? <span className="tel">{formatPhone(p.secondaryPhone)}</span> : null
            )}
            {row(t.patients.birthDate, p.birthDate ? fmtDate(p.birthDate, tz, locale) : null)}
            {row(
              t.patients.gender,
              p.gender ? ((t.patients as Record<string, unknown>)[p.gender] as string) ?? p.gender : null
            )}
            {row(t.insurers.title, p.insurer)}
            {row(t.patients.insuranceNoLabel, p.insuranceNo)}
            {row(t.patients.tags, p.tags.join("، ") || null)}
            {row(t.patients.since, fmtDate(p.createdAt, tz, locale))}
            {p.customFields.map((f) => row(f.label, f.value))}
          </tbody>
        </table>
      </section>

      <Section title={`${t.patients.tabs.notes} (${record.notes.length})`} empty={!record.notes.length} t={t}>
        {record.notes.map((n) => (
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
        title={`${t.patients.tabs.appointments} (${record.appointments.length})`}
        empty={!record.appointments.length}
        t={t}
      >
        <table className="grid">
          <tbody>
            {record.appointments.map((a) => (
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
        title={`${t.patients.tabs.invoices} (${record.invoices.length})`}
        empty={!record.invoices.length}
        t={t}
      >
        <table className="grid">
          <tbody>
            {record.invoices.map((i) => (
              <tr key={i.id}>
                <td className="nowrap">{i.number}</td>
                <td className="nowrap">{i.issueDate ? fmtDate(i.issueDate, tz, locale) : "—"}</td>
                <td className="nowrap">
                  {(t.invoices.statuses as Record<string, string>)[i.status] ?? i.status}
                </td>
                <td className="nowrap num">{fmtMoney(i.total, clinic.currency, locale)}</td>
                <td className="nowrap num muted">{fmtMoney(i.amountPaid, clinic.currency, locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {record.documents.length > 0 && (
        <Section title={`${t.patients.tabs.documents} (${record.documents.length})`} empty={false} t={t}>
          <table className="grid">
            <tbody>
              {record.documents.map((d) => (
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

      {record.files.length > 0 && (
        <Section title={`${t.patients.tabs.files} (${record.files.length})`} empty={false} t={t}>
          {/* Named, not embedded: an X-ray is not something a text record can
              carry, and a list at least tells the reader what to ask for. */}
          <table className="grid">
            <tbody>
              {record.files.map((f) => (
                <tr key={f.id}>
                  <td>{f.fileName}</td>
                  <td className="nowrap">{fmtDate(f.createdAt, tz, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
    </>
  );
}

export function Section({
  title,
  empty,
  t,
  children,
}: {
  title: string;
  empty: boolean;
  t: Dict;
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
export function PrintStyles() {
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

/* ---- whole-clinic export ---- */
/* Each record starts its own sheet. A file that began halfway down the
   previous patient's last page would be unfilable. */
.patient-sheet { page-break-before: always; }
.cover { min-height: 60vh; }
.cover-title { font-family: var(--font-display), sans-serif; font-size: 26px; font-weight: 700;
               margin: 24px 0 4px; }
.cover-sub { font-size: 13px; color: #4b5159; }
.cover-meta { margin-top: 18px; font-size: 12px; }
.cover-meta th { text-align: start; width: 34%; color: #4b5159; font-weight: 600;
                 padding: 4px 0; border-bottom: 1px solid #eef0f3; }
.cover-meta td { padding: 4px 0; border-bottom: 1px solid #eef0f3; }
.toc { margin-top: 18px; font-size: 11.5px; border-collapse: collapse; width: 100%; }
.toc td { padding: 3px 6px; border-bottom: 1px solid #f2f4f7; }
.toc td:first-child { padding-inline-start: 0; width: 34px; color: #9aa2ac; }
.toc td:last-child { padding-inline-end: 0; text-align: end; color: #7a828c; white-space: nowrap; }
`,
      }}
    />
  );
}
