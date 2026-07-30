import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { loadPrintDocument, CERT_LABELS, type PrintDocument, type PrintSigner } from "@/lib/esign/print-data";
import { verifyPrintKey } from "@/lib/esign/print-token";
import { DocumentBody } from "@/components/esign/document-body";

export const metadata: Metadata = { robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * The page the PDF is made of.
 *
 * Rendering with a real browser is the only approach that gets Arabic right —
 * letter shaping, ligatures, RTL flow and mixed Arabic/Latin runs all come free
 * from the same engine the app already uses on screen. Building these pages with
 * pdf-lib or react-pdf produces reversed, unjoined glyphs.
 *
 * Access is an HMAC over the document id, valid for minutes, so nothing here is
 * reachable by guessing a URL.
 */
export default async function DocumentPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ kind?: string; exp?: string; sig?: string }>;
}) {
  const { id } = await params;
  const { kind = "document", exp, sig } = await searchParams;
  if (!verifyPrintKey(id, kind, exp, sig)) notFound();

  const doc = await loadPrintDocument(id);
  if (!doc) notFound();

  if (kind === "overlay") return <OverlayPages doc={doc} />;

  const isAr = doc.language === "ar";
  const brand = doc.clinic.brandColor;

  return (
    <main
      dir={isAr ? "rtl" : "ltr"}
      className="doc-print bg-white"
      style={{ "--bk": brand } as React.CSSProperties}
    >
      <PrintStyles />
      {kind !== "certificate" && (
        <section className="sheet">
          {doc.status === "voided" && <VoidStamp label={CERT_LABELS[doc.language].voided} />}
          <BrandBand doc={doc} />
          <div className="sheet-inner">
            <DocumentBody html={doc.snapshot} />
            <SignatureBlocks doc={doc} />
          </div>
          {doc.clinic.invoiceFooter && <footer className="sheet-foot">{doc.clinic.invoiceFooter}</footer>}
        </section>
      )}
      <Certificate doc={doc} />
    </main>
  );
}

function BrandBand({ doc }: { doc: PrintDocument }) {
  const isAr = doc.language === "ar";
  const name = (isAr ? doc.clinic.nameAr : null) || doc.clinic.name;
  const address = (isAr ? doc.clinic.addressAr : null) || doc.clinic.address;
  return (
    <>
      <div className="band" />
      <header className="sheet-head">
        {doc.clinic.logoPath ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/public/clinic-logo/${doc.clinic.slug}`} alt="" className="logo" />
        ) : (
          <span className="logo logo-fallback">{name.slice(0, 1)}</span>
        )}
        <div>
          <div className="clinic-name">{name}</div>
          {address && <div className="clinic-meta">{address}</div>}
          {doc.clinic.phone && (
            <div className="clinic-meta" dir="ltr">
              {doc.clinic.phone}
            </div>
          )}
        </div>
      </header>
    </>
  );
}

function VoidStamp({ label }: { label: string }) {
  return <div className="void-stamp">{label}</div>;
}

/**
 * One block per signer, on the document itself.
 *
 * The image is the drawn stroke; the printed line underneath is what makes it
 * readable as a record rather than as decoration — who, in what capacity, when.
 */
function SignatureBlocks({ doc }: { doc: PrintDocument }) {
  const L = CERT_LABELS[doc.language];
  const isAr = doc.language === "ar";
  if (!doc.signers.length) return null;

  return (
    <section className="sig-grid">
      {doc.signers.map((s) => {
        const role = isAr ? s.roleLabelAr : s.roleLabel;
        return (
          <div key={s.id} className="sig-block">
            <div className="sig-area">
              {s.signatureDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={s.signatureDataUrl} alt="" className="sig-img" />
              ) : (
                <span className="sig-empty">
                  {s.status === "declined" ? L.declined : L.notSigned}
                </span>
              )}
            </div>
            <div className="sig-rule" />
            <div className="sig-name">{s.name || role}</div>
            <div className="sig-meta">
              {role}
              {s.relationship ? ` · ${s.relationship}` : ""}
            </div>
            {s.signedAtLocal && <div className="sig-meta">{s.signedAtLocal}</div>}
            {s.typedName && <div className="sig-meta">{L.typed}</div>}
            {s.witnessName && (
              <div className="sig-meta">
                {L.witness}: {s.witnessName}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

/**
 * The Certificate of Completion. Always the final page, never optional.
 * Times appear twice — UTC for a court, clinic-local for the clinic.
 */
function Certificate({ doc }: { doc: PrintDocument }) {
  const L = CERT_LABELS[doc.language];
  const isAr = doc.language === "ar";
  const methodLabel = (m: PrintSigner["method"]) =>
    m === "in_clinic" ? L.inClinic : m === "staff" ? L.staff : L.remote;

  return (
    <section className="sheet cert">
      <div className="band" />
      <div className="sheet-inner">
        <h1 className="cert-title">{L.title}</h1>
        <p className="cert-sub">{L.subtitle}</p>

        <table className="cert-summary">
          <tbody>
            <tr>
              <th>{L.document}</th>
              <td>{doc.title}</td>
            </tr>
            {doc.patientName && (
              <tr>
                <th>{isAr ? "المريض" : "Patient"}</th>
                <td>{doc.patientName}</td>
              </tr>
            )}
            <tr>
              <th>{L.docHash}</th>
              <td className="mono-cell" dir="ltr">
                {doc.hash || "—"}
              </td>
            </tr>
            <tr>
              <th>{L.created}</th>
              <td>{doc.createdAt}</td>
            </tr>
            {doc.completedAt && (
              <tr>
                <th>{L.completed}</th>
                <td>{doc.completedAt}</td>
              </tr>
            )}
            {doc.status === "voided" && (
              <tr>
                <th>{L.voidReason}</th>
                <td>{doc.voidReason ?? "—"}</td>
              </tr>
            )}
          </tbody>
        </table>

        <h2 className="cert-h2">{L.signers}</h2>
        <div className="cert-signers">
          {doc.signers.map((s) => (
            <div key={s.id} className="cert-signer">
              <div className="cert-signer-head">
                <span className="cert-signer-name">{s.name || "—"}</span>
                <span className="cert-signer-role">{isAr ? s.roleLabelAr : s.roleLabel}</span>
              </div>
              <table className="cert-rows">
                <tbody>
                  {s.phone && (
                    <tr>
                      <th>{L.phone}</th>
                      <td dir="ltr">{s.phone}</td>
                    </tr>
                  )}
                  {s.relationship && (
                    <tr>
                      <th>{L.guardianOf}</th>
                      <td>{s.relationship}</td>
                    </tr>
                  )}
                  <tr>
                    <th>{L.method}</th>
                    <td>{methodLabel(s.method)}</td>
                  </tr>
                  {s.openedAt && (
                    <tr>
                      <th>{L.opened}</th>
                      <td>{s.openedAt}</td>
                    </tr>
                  )}
                  {s.signedAtLocal ? (
                    <tr>
                      <th>{L.signedAt}</th>
                      <td>
                        {s.signedAtLocal}
                        <span className="cert-utc" dir="ltr">
                          {s.signedAtUtc}
                        </span>
                      </td>
                    </tr>
                  ) : (
                    <tr>
                      <th>{L.signedAt}</th>
                      <td>{s.status === "declined" ? L.declined : L.notSigned}</td>
                    </tr>
                  )}
                  {s.declineReason && (
                    <tr>
                      <th>{L.reason}</th>
                      <td>{s.declineReason}</td>
                    </tr>
                  )}
                  <tr>
                    <th>{L.ip}</th>
                    <td dir="ltr">{s.ip ?? "—"}</td>
                  </tr>
                  <tr>
                    <th>{L.device}</th>
                    <td dir="ltr">{s.device}</td>
                  </tr>
                  {s.witnessName && (
                    <tr>
                      <th>{L.witness}</th>
                      <td>{s.witnessName}</td>
                    </tr>
                  )}
                  {Object.entries(s.answers).map(([k, v]) => (
                    <tr key={k}>
                      <th>{k}</th>
                      <td>{String(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>

        <p className="cert-foot">
          {L.footer} {L.tzNote} {doc.timezone}.
        </p>
      </div>
    </section>
  );
}

/**
 * Transparent, page-sized layers for an uploaded PDF.
 *
 * The original file is never re-typeset; the values are drawn here, by the same
 * browser that gets Arabic right, and composited onto the untouched pages.
 */
function OverlayPages({ doc }: { doc: PrintDocument }) {
  const pages = Array.from({ length: doc.pageCount }, (_, i) => i + 1);
  return (
    <main dir="ltr" className="ov-root">
      <PrintStyles />
      {pages.map((p) => (
        <div key={p} className="ov-page" data-page={p}>
          {doc.placedFields
            .filter((f) => f.page === p)
            .map((f) => (
              <div
                key={f.id}
                className={`ov-field ov-${f.fieldType}`}
                style={{
                  left: `${f.x * 100}%`,
                  top: `${f.y * 100}%`,
                  width: `${f.width * 100}%`,
                  height: `${f.height * 100}%`,
                }}
              >
                {f.fieldType === "signature" || f.fieldType === "initials" ? (
                  f.signatureDataUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={f.signatureDataUrl} alt="" />
                  ) : null
                ) : f.fieldType === "checkbox" ? (
                  f.value ? (
                    <span className="ov-check">✓</span>
                  ) : null
                ) : (
                  <span className="ov-text" dir="auto">
                    {f.value ?? ""}
                  </span>
                )}
              </div>
            ))}
        </div>
      ))}
    </main>
  );
}

/**
 * Print CSS lives inline rather than in globals so that the page Chromium loads
 * is self-contained: one request, no cascade to wait on, nothing that can be
 * half-applied when the screenshot is taken.
 */
function PrintStyles() {
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `
@page { size: A4; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
.doc-print { color: #16181c; font-size: 12.5px; line-height: 1.75; }
.sheet { position: relative; width: 210mm; min-height: 297mm; margin: 0 auto; background: #fff;
         page-break-after: always; break-after: page; overflow: hidden; }
.sheet:last-child { page-break-after: auto; break-after: auto; }
.sheet-inner { padding: 16mm 18mm 20mm; }
.band { height: 8px; width: 100%; background: var(--bk); }
.sheet-head { display: flex; align-items: center; gap: 14px; padding: 10mm 18mm 0; }
.logo { width: 54px; height: 54px; border-radius: 14px; object-fit: cover; border: 1px solid #e3e6eb; }
.logo-fallback { display: flex; align-items: center; justify-content: center; background: var(--bk);
                 color: #fff; font-size: 24px; font-weight: 700; border: none; }
.clinic-name { font-family: var(--font-display), sans-serif; font-size: 17px; font-weight: 700; }
.clinic-meta { font-size: 11.5px; color: #7a828c; }
.sheet-foot { position: absolute; inset-inline: 18mm; bottom: 10mm; text-align: center;
              font-size: 10.5px; color: #9aa2ac; border-top: 1px solid #e3e6eb; padding-top: 6px; }

.doc-title { font-family: var(--font-display), sans-serif; font-size: 20px; font-weight: 700;
             margin: 0 0 14px; }
.doc-head { margin-bottom: 4px; }
.doc-clinic { font-weight: 700; font-size: 14px; }
.doc-clinic-meta { font-size: 11px; color: #7a828c; }
.doc-body p { margin: 0 0 9px; }
.doc-body ul, .doc-body ol { margin: 0 0 9px; padding-inline-start: 22px; }
.doc-body li { margin-bottom: 4px; }
.doc-body h1, .doc-body h2, .doc-body h3 { font-family: var(--font-display), sans-serif;
             font-weight: 700; margin: 16px 0 7px; font-size: 14px; }
.doc-body table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 12px; }
.doc-body th, .doc-body td { border: 1px solid #e3e6eb; padding: 6px 8px; text-align: start; }
.doc-body hr { border: none; border-top: 1px solid #e3e6eb; margin: 14px 0; }
.doc-missing { display: inline-block; min-width: 60px; border-bottom: 1px dotted #c24a4a;
               color: #c24a4a; }
.doc-extras { margin-top: 14px; }
.doc-extras table { width: 100%; border-collapse: collapse; font-size: 12px; }
.doc-extras th { text-align: start; width: 38%; color: #4b5159; font-weight: 600;
                 border-bottom: 1px solid #e3e6eb; padding: 5px 0; }
.doc-extras td { border-bottom: 1px solid #e3e6eb; padding: 5px 0; }

.sig-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10mm 12mm; margin-top: 14mm;
            page-break-inside: avoid; break-inside: avoid; }
.sig-block { page-break-inside: avoid; break-inside: avoid; }
.sig-area { height: 22mm; display: flex; align-items: flex-end; }
.sig-img { max-height: 22mm; max-width: 100%; object-fit: contain; }
.sig-empty { font-size: 11px; color: #9aa2ac; padding-bottom: 3px; }
.sig-rule { border-bottom: 1px solid #16181c; margin-bottom: 5px; }
.sig-name { font-weight: 700; font-size: 12.5px; }
.sig-meta { font-size: 10.5px; color: #7a828c; }

.void-stamp { position: absolute; top: 46%; inset-inline-start: 0; width: 100%; text-align: center;
              font-family: var(--font-display), sans-serif; font-size: 78px; font-weight: 800;
              color: rgba(194, 74, 74, 0.16); transform: rotate(-24deg); letter-spacing: 8px;
              pointer-events: none; z-index: 5; }

.cert-title { font-family: var(--font-display), sans-serif; font-size: 19px; font-weight: 700; margin: 0; }
.cert-sub { color: #7a828c; font-size: 11.5px; margin: 2px 0 14px; }
.cert-h2 { font-family: var(--font-display), sans-serif; font-size: 14px; font-weight: 700;
           margin: 16px 0 8px; }
.cert-summary { width: 100%; border-collapse: collapse; font-size: 11.5px; }
.cert-summary th { text-align: start; width: 34%; color: #4b5159; font-weight: 600;
                   padding: 5px 0; border-bottom: 1px solid #e3e6eb; vertical-align: top; }
.cert-summary td { padding: 5px 0; border-bottom: 1px solid #e3e6eb; }
.mono-cell { font-family: var(--font-mono), monospace; font-size: 10px; word-break: break-all; }
.cert-signers { display: grid; gap: 8px; }
.cert-signer { border: 1px solid #e3e6eb; border-radius: 8px; padding: 8px 10px;
               page-break-inside: avoid; break-inside: avoid; }
.cert-signer-head { display: flex; justify-content: space-between; align-items: baseline;
                    gap: 8px; margin-bottom: 4px; }
.cert-signer-name { font-weight: 700; font-size: 12.5px; }
.cert-signer-role { font-size: 10.5px; color: #fff; background: var(--bk);
                    border-radius: 999px; padding: 1px 8px; }
.cert-rows { width: 100%; border-collapse: collapse; font-size: 11px; }
.cert-rows th { text-align: start; width: 34%; color: #7a828c; font-weight: 500;
                padding: 2px 0; vertical-align: top; }
.cert-rows td { padding: 2px 0; }
.cert-utc { display: block; font-size: 9.5px; color: #9aa2ac; }
.cert-foot { margin-top: 14px; font-size: 10px; color: #9aa2ac; line-height: 1.6; }

/* Uploaded-PDF overlay layers: transparent, exactly one per page. */
.ov-root { margin: 0; background: transparent; }
.ov-page { position: relative; width: 794px; height: 1123px; background: transparent; }
.ov-field { position: absolute; display: flex; align-items: center; justify-content: flex-start;
            overflow: hidden; }
.ov-field img { max-width: 100%; max-height: 100%; object-fit: contain; }
.ov-text { font-size: 13px; color: #16181c; white-space: nowrap; }
.ov-check { font-size: 20px; color: #16181c; line-height: 1; }
`,
      }}
    />
  );
}
