import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { withSystem } from "@/lib/db";
import { verifyPrintKeyFor } from "@/lib/print-token";
import { readFileBuffer } from "@/lib/storage";
import { fmtDate } from "@/lib/dates";
import { formatPhone } from "@/lib/phone";
import { dictFor } from "@/lib/i18n/client-dict";
import { itemDetail, rxNumber, type RxItem } from "@/lib/prescriptions";
import { PoweredBy } from "@/components/powered-by";

export const metadata: Metadata = { robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const KINDS = ["prescription"] as const;

/**
 * The page a prescription's PDF is made of.
 *
 * Rendered by the worker's Chromium, like every other PDF here, because a real
 * browser is the only thing that shapes Arabic and lays out a mixed
 * Arabic/Latin line correctly — and a prescription is exactly that: Arabic
 * instructions under medicine names written in Latin.
 *
 * Reachable only with a short-lived HMAC over the prescription id. The clinic,
 * the patient and the doctor are all read from the prescription itself, never
 * from the query string, so a key names one prescription and shows nothing
 * else.
 *
 * The language is the prescription's, chosen by whoever wrote it — not the
 * clinic's default and not the visitor's.
 */
export default async function PrescriptionPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ exp?: string; sig?: string; kind?: string }>;
}) {
  const { id } = await params;
  const { exp, sig, kind = "prescription" } = await searchParams;
  if (!verifyPrintKeyFor(id, kind, exp, sig, KINDS)) notFound();

  const rx = await withSystem(async (c) => {
    const r = await c.query(
      `select rx.number, rx.created_at, rx.locale, rx.diagnosis, rx.items, rx.doctor_name,
              p.full_name as patient_name,
              u.signature_png_path,
              cl.name, cl.name_ar, cl.slug, cl.logo_path, cl.brand_color, cl.address, cl.address_ar,
              cl.phone_e164 as clinic_phone, cl.timezone
         from prescriptions rx
         join patients p on p.id = rx.patient_id
         join clinics cl on cl.id = rx.clinic_id
         left join clinic_members m on m.id = rx.doctor_member_id
         left join users u on u.id = m.user_id
        where rx.id = $1`,
      [id]
    );
    return r.rows[0];
  });
  if (!rx) notFound();

  /*
    The doctor's own saved signature, inlined: Chromium arrives here with no
    session, so a route that served the image would need a key of its own. It
    is the same drawing the doctor applies when countersigning a document.
  */
  let signature: string | null = null;
  if (rx.signature_png_path) {
    const buf = await readFileBuffer(rx.signature_png_path as string).catch(() => null);
    if (buf) signature = `data:image/png;base64,${buf.toString("base64")}`;
  }

  const locale = rx.locale === "en" ? "en" : "ar";
  const isAr = locale === "ar";
  const L = dictFor(locale).prescriptions.sheet;
  const clinicName = (isAr ? rx.name_ar : null) || rx.name;
  const address = (isAr ? rx.address_ar : null) || rx.address;
  const items = (rx.items ?? []) as RxItem[];

  return (
    <main
      dir={isAr ? "rtl" : "ltr"}
      className="bg-white text-ink-900"
      style={{ "--bk": rx.brand_color } as React.CSSProperties}
    >
      <div className="mx-auto flex min-h-[285mm] w-full max-w-[210mm] flex-col bg-white">
        <div className="h-2.5 w-full" style={{ background: "var(--bk)" }} />
        <div className="flex flex-1 flex-col px-12 pb-8 pt-10">
          <header className="flex items-start justify-between gap-6">
            <div className="flex items-center gap-4">
              {rx.logo_path ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/public/clinic-logo/${rx.slug}`}
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
                {address && <p className="text-[13px] text-ink-500">{address}</p>}
                {rx.clinic_phone && (
                  <p className="text-[13px] text-ink-500 tnum" dir="ltr">
                    {formatPhone(rx.clinic_phone)}
                  </p>
                )}
              </div>
            </div>
            <div className="text-end">
              <div className="text-[13px] font-semibold uppercase tracking-widest text-ink-500">
                {L.title}
              </div>
              <div className="font-display text-lg font-bold tnum" dir="ltr">
                {rxNumber(rx.number)}
              </div>
              <div className="mt-1 text-[13px] text-ink-500">
                {L.date}: {fmtDate(rx.created_at, rx.timezone, locale)}
              </div>
            </div>
          </header>

          <section
            className="mt-8 grid grid-cols-2 gap-6 rounded-xl border border-line px-5 py-4"
            style={{ borderColor: "color-mix(in srgb, var(--bk) 25%, transparent)" }}
          >
            <div className="min-w-0">
              <div className="text-[12px] font-semibold uppercase tracking-widest text-ink-500">
                {L.patient}
              </div>
              <div className="mt-1 text-[15px] font-semibold">{rx.patient_name}</div>
            </div>
            <div className="min-w-0">
              <div className="text-[12px] font-semibold uppercase tracking-widest text-ink-500">
                {L.doctor}
              </div>
              <div className="mt-1 text-[15px] font-semibold">{rx.doctor_name}</div>
            </div>
          </section>

          {rx.diagnosis && (
            <section className="mt-5">
              <span className="text-[12px] font-semibold uppercase tracking-widest text-ink-500">
                {L.diagnosis}:
              </span>{" "}
              <span className="text-[15px]">
                <bdi>{rx.diagnosis}</bdi>
              </span>
            </section>
          )}

          <section className="mt-7">
            {/* ℞ is a symbol, not a word, so it reads the same in both
                languages and sits on the leading edge of either. */}
            <div className="font-display text-4xl font-bold leading-none" style={{ color: "var(--bk)" }} aria-hidden>
              ℞
            </div>
            <ol className="mt-4 space-y-4">
              {items.map((it, i) => {
                const detail = itemDetail(it);
                return (
                  <li key={i} className="flex gap-3 border-b border-line pb-4 last:border-b-0">
                    <span
                      className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-bold text-white tnum"
                      style={{ background: "var(--bk)" }}
                    >
                      {i + 1}
                    </span>
                    <div className="min-w-0">
                      {/* <bdi>: a Latin drug name inside an Arabic sentence
                          must not drag the strength to the wrong side. */}
                      <div className="text-[16px] font-semibold">
                        <bdi>{it.name}</bdi>
                      </div>
                      {detail && <div className="mt-0.5 text-[14px] text-ink-700">{detail}</div>}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>

          <div className="mt-auto flex items-end justify-end pt-12">
            <div className="w-64 text-center">
              {signature ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={signature} alt="" className="mx-auto h-20 max-w-full object-contain" />
              ) : (
                <div className="h-20" />
              )}
              <div className="border-t border-ink-300 pt-2 text-[14px] font-semibold">{rx.doctor_name}</div>
              <div className="text-[12px] text-ink-500">{L.signature}</div>
            </div>
          </div>

          <div className="mt-8 flex justify-center border-t border-line pt-4">
            <PoweredBy label={L.poweredBy} showUrl />
          </div>
        </div>
      </div>
    </main>
  );
}
