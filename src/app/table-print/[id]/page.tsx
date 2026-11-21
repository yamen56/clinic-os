import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { withSystem } from "@/lib/db";
import { isUuid } from "@/lib/uuid";
import { verifyPrintKeyFor } from "@/lib/print-token";
import type { ExportTable } from "@/lib/exports/table";

export const metadata: Metadata = { robots: { index: false, follow: false } };

/** Only the one kind; anything else is not this page's key. */
const KINDS = ["table"] as const;

/**
 * An export, as the PDF the worker prints (2026-11-21).
 *
 * Reached only by the worker's Chromium, with a five-minute key signed for this
 * one row (lib/exports/render). It draws what the export route already built
 * under the member's own access and parked in `export_renders` — it runs no
 * query of its own, so it cannot show more than the member could.
 *
 * A4 portrait, because that is what the worker prints: a wide table wraps in
 * its cells rather than running off the page, and the header row repeats on
 * every page.
 */
export default async function TablePrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ exp?: string; sig?: string }>;
}) {
  const { id } = await params;
  const { exp, sig } = await searchParams;
  if (!isUuid(id) || !verifyPrintKeyFor(id, "table", exp, sig, KINDS)) notFound();

  const t = await withSystem(async (c) => {
    const r = await c.query(`select payload from export_renders where id = $1`, [id]);
    return (r.rows[0]?.payload as ExportTable | undefined) ?? null;
  });
  if (!t) notFound();

  const ar = t.locale === "ar";
  const intl = ar ? "ar-JO-u-nu-latn" : "en-GB";
  const fmt = (v: string | number | null | undefined, kind?: string) => {
    if (v === null || v === undefined || v === "") return "";
    if (typeof v === "number") {
      return kind === "money"
        ? v.toLocaleString(intl, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : v.toLocaleString(intl);
    }
    return v;
  };
  const generated = new Date().toLocaleString(intl, { dateStyle: "medium", timeStyle: "short" });

  return (
    <main dir={ar ? "rtl" : "ltr"} lang={t.locale} className="tp">
      <style
        dangerouslySetInnerHTML={{
          __html: `
@page { size: A4; margin: 12mm 0; }
html, body { margin: 0; padding: 0; background: #fff; }
.tp { color: #16181c; padding: 0 12mm; font-size: 10px; line-height: 1.5; }
.tp-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px;
           border-bottom: 2px solid #0b1220; padding-bottom: 8px; margin-bottom: 10px; }
.tp-title { font-family: var(--font-display), sans-serif; font-size: 18px; font-weight: 700; margin: 0; }
.tp-sub { font-size: 11px; color: #4b5159; margin-top: 2px; }
.tp-meta { text-align: end; font-size: 10px; color: #7a828c; }
.tp-clinic { font-weight: 700; color: #16181c; font-size: 11px; }
.tp-sheet { margin-top: 14px; }
.tp-sheet h2 { font-family: var(--font-display), sans-serif; font-size: 12px; margin: 0 0 6px; }
table { width: 100%; border-collapse: collapse; }
thead { display: table-header-group; }
tr { page-break-inside: avoid; break-inside: avoid; }
th { text-align: start; font-weight: 600; color: #4b5159; background: #f3f5f8;
     border-bottom: 1px solid #c6cdd7; padding: 5px 6px; font-size: 9.5px; }
td { border-bottom: 1px solid #eef0f3; padding: 4px 6px; vertical-align: top; overflow-wrap: anywhere; }
td.n, th.n { text-align: end; white-space: nowrap; font-variant-numeric: tabular-nums; }
tr.total td { font-weight: 700; border-top: 1.5px solid #16181c; border-bottom: 0; }
.tp-empty { color: #7a828c; padding: 12px 0; }
.tp-count { color: #7a828c; font-size: 9.5px; margin-top: 4px; }
`,
        }}
      />
      <header className="tp-head">
        <div>
          <h1 className="tp-title">{t.title}</h1>
          {t.subtitle && <div className="tp-sub">{t.subtitle}</div>}
        </div>
        <div className="tp-meta">
          <div className="tp-clinic">{t.clinicName}</div>
          <div>{generated}</div>
        </div>
      </header>

      {t.sheets.map((s, i) => (
        <section key={i} className="tp-sheet">
          {t.sheets.length > 1 && <h2>{s.name}</h2>}
          {s.rows.length === 0 ? (
            <div className="tp-empty">—</div>
          ) : (
            <table>
              <thead>
                <tr>
                  {s.columns.map((c) => (
                    <th key={c.key} className={c.kind === "money" || c.kind === "number" ? "n" : undefined}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {s.rows.map((r, j) => (
                  <tr key={j}>
                    {s.columns.map((c) => (
                      <td key={c.key} className={c.kind === "money" || c.kind === "number" || c.kind === "date" ? "n" : undefined}>
                        {fmt(r[c.key], c.kind)}
                      </td>
                    ))}
                  </tr>
                ))}
                {s.totals && (
                  <tr className="total">
                    {s.columns.map((c) => (
                      <td key={c.key} className={c.kind === "money" || c.kind === "number" ? "n" : undefined}>
                        {fmt(s.totals![c.key], c.kind)}
                      </td>
                    ))}
                  </tr>
                )}
              </tbody>
            </table>
          )}
          <div className="tp-count">{s.rows.length.toLocaleString(intl)}</div>
        </section>
      ))}
    </main>
  );
}
