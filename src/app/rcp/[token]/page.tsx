import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { withSystem } from "@/lib/db";
import { fmtDate, fmtDateOnly, fmtMoney } from "@/lib/dates";
import { PoweredBy, PrivacyLink } from "@/components/powered-by";

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * A receipt.
 *
 * An invoice demands and a receipt acknowledges, and until now this product only
 * had the first: a settled invoice was re-sent worded as a receipt, which is the
 * same document with a stamp on it. That is not what a patient hands an employer
 * or an insurer, and it says nothing about how the money actually arrived.
 *
 * So this page is about the *payments*, not the lines. It exists only once the
 * invoice is settled in full, and it names the invoice it settles rather than
 * restating it — there is one document describing what was charged, and this is
 * not it.
 *
 * Deliberately absent: anything about the doctor, and anything about the
 * revenue share. That split is between the clinic and the doctor.
 */
async function loadReceipt(token: string) {
  return withSystem(async (c) => {
    const inv = (
      await c.query(
        `select i.id, i.number, i.receipt_number, i.receipt_issued_at, i.currency,
                i.total, i.amount_paid, i.status, i.issue_date, i.created_at,
                p.full_name as patient_name, p.phone_e164 as patient_phone,
                cl.name, cl.name_ar, cl.slug, cl.logo_path, cl.brand_color,
                cl.address, cl.address_ar, cl.phone_e164 as clinic_phone,
                cl.default_locale, cl.timezone, cl.invoice_footer,
                es.tax_number as seller_tax_number
           from invoices i
           join patients p on p.id = i.patient_id
           join clinics cl on cl.id = i.clinic_id
           left join clinic_einvoice_settings es on es.clinic_id = i.clinic_id and es.enabled
          where i.receipt_token = $1`,
        [token]
      )
    ).rows[0];
    if (!inv) return null;
    const payments = (
      await c.query(
        `select amount, method, reference, paid_at from payments
          where invoice_id = $1 order by paid_at, id`,
        [inv.id]
      )
    ).rows;
    return { inv, payments };
  });
}

export default async function PublicReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ print?: string }>;
}) {
  const { token } = await params;
  const { print } = await searchParams;
  const data = await loadReceipt(token);
  if (!data) notFound();
  const { inv, payments } = data;

  const isAr = inv.default_locale !== "en";
  const locale = isAr ? "ar" : "en";
  const clinicName = isAr ? inv.name_ar || inv.name : inv.name;
  const address = isAr ? inv.address_ar || inv.address : inv.address;
  const brand = inv.brand_color as string;
  const money = (n: number | string) => fmtMoney(n, inv.currency, locale);

  const L = isAr
    ? {
        receipt: "إيصال استلام", receivedFrom: "استُلم من", date: "التاريخ",
        forInvoice: "عن الفاتورة", method: "طريقة الدفع", amount: "المبلغ",
        reference: "المرجع", totalReceived: "إجمالي المستلم", invoiceTotal: "إجمالي الفاتورة",
        paidInFull: "مدفوعة بالكامل", taxNo: "الرقم الضريبي",
        thanks: "شكرًا لك.",
        notATaxInvoice: "هذا إيصال باستلام مبلغ، وليس فاتورة ضريبية. الفاتورة أعلاه هي المستند الضريبي.",
        methods: { cash: "نقدًا", cliq: "كليك", card: "بطاقة", transfer: "حوالة" } as Record<string, string>,
        poweredBy: "مدعوم من كلينيكتي", privacy: "سياسة الخصوصية",
      }
    : {
        receipt: "Receipt", receivedFrom: "Received from", date: "Date",
        forInvoice: "For invoice", method: "Method", amount: "Amount",
        reference: "Reference", totalReceived: "Total received", invoiceTotal: "Invoice total",
        paidInFull: "PAID IN FULL", taxNo: "Tax number",
        thanks: "Thank you.",
        notATaxInvoice:
          "This acknowledges money received. It is not a tax invoice — the invoice named above is the tax document.",
        methods: { cash: "Cash", cliq: "CliQ", card: "Card", transfer: "Transfer" } as Record<string, string>,
        poweredBy: "Powered by Clinicti", privacy: "Privacy Policy",
      };

  const received = payments.reduce((s: number, p: { amount: string }) => s + Number(p.amount), 0);
  const anyReference = payments.some((p: { reference: string }) => p.reference);

  return (
    <main
      dir={isAr ? "rtl" : "ltr"}
      className={print ? "bg-white" : "min-h-dvh bg-paper py-8"}
      style={{ "--bk": brand } as React.CSSProperties}
    >
      <div
        className={`relative mx-auto w-full max-w-[210mm] overflow-hidden bg-white ${
          print ? "" : "rounded-card border border-line shadow-card"
        }`}
      >
        <div className="h-2.5 w-full" style={{ background: "var(--bk)" }} />
        <div className="p-10">
          <header className="flex items-start justify-between gap-6">
            <div className="flex items-center gap-4">
              {inv.logo_path ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/public/clinic-logo/${inv.slug}`}
                  alt=""
                  className="h-16 w-16 rounded-2xl border border-line object-cover"
                />
              ) : (
                <span
                  className="flex h-16 w-16 items-center justify-center rounded-2xl text-2xl font-bold text-white"
                  style={{ background: "var(--bk)" }}
                >
                  {clinicName.slice(0, 1)}
                </span>
              )}
              <div>
                <h1 className="font-display text-xl font-bold">{clinicName}</h1>
                {inv.seller_tax_number && (
                  <p className="text-[13px] text-ink-500">
                    {L.taxNo}: <span className="tnum" dir="ltr">{inv.seller_tax_number}</span>
                  </p>
                )}
                {address && <p className="text-[13px] text-ink-500">{address}</p>}
                {inv.clinic_phone && (
                  <p className="text-[13px] text-ink-500 tnum" dir="ltr">
                    {inv.clinic_phone}
                  </p>
                )}
              </div>
            </div>
            <div className="text-end">
              <div className="text-[13px] font-semibold uppercase tracking-widest text-ink-500">
                {L.receipt}
              </div>
              <div className="font-display text-lg font-bold tnum" dir="ltr">
                {inv.receipt_number}
              </div>
              <div className="mt-1 text-[13px] text-ink-500">
                {L.date}:{" "}
                {inv.receipt_issued_at
                  ? fmtDate(inv.receipt_issued_at, inv.timezone, locale)
                  : fmtDateOnly(inv.issue_date ?? inv.created_at, locale)}
              </div>
              <span
                className="mt-2 inline-block rounded-full px-3 py-1 text-[12px] font-bold text-white"
                style={{ background: "var(--bk)" }}
              >
                {L.paidInFull}
              </span>
            </div>
          </header>

          <section className="mt-8 flex flex-wrap items-start justify-between gap-6">
            <div className="min-w-0">
              <div className="text-[12px] font-semibold uppercase tracking-widest text-ink-500">
                {L.receivedFrom}
              </div>
              <div className="mt-1 text-[15px] font-semibold">{inv.patient_name}</div>
              {inv.patient_phone && (
                <div className="text-[13px] text-ink-500 tnum" dir="ltr">
                  {inv.patient_phone}
                </div>
              )}
            </div>
            {/*
              The invoice this settles, named rather than restated. What was
              charged is described on one document, and this is not that
              document.
            */}
            <div className="text-end">
              <div className="text-[12px] font-semibold uppercase tracking-widest text-ink-500">
                {L.forInvoice}
              </div>
              <div className="mt-1 font-display text-[15px] font-semibold tnum" dir="ltr">
                {inv.number}
              </div>
            </div>
          </section>

          {/* How the money actually arrived — the thing an invoice cannot say. */}
          <section className="mt-8 overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="border-b-2" style={{ borderColor: "var(--bk)" }}>
                  <th className="py-2 text-start font-semibold">{L.date}</th>
                  <th className="py-2 text-start font-semibold">{L.method}</th>
                  {anyReference && <th className="py-2 text-start font-semibold">{L.reference}</th>}
                  <th className="py-2 text-end font-semibold">{L.amount}</th>
                </tr>
              </thead>
              <tbody>
                {payments.map(
                  (
                    p: { amount: string; method: string; reference: string; paid_at: string },
                    i: number
                  ) => (
                    <tr key={i} className="border-b border-line">
                      <td className="py-2.5">{fmtDate(p.paid_at, inv.timezone, locale)}</td>
                      <td className="py-2.5">{L.methods[p.method] ?? p.method}</td>
                      {anyReference && <td className="py-2.5 text-ink-500">{p.reference}</td>}
                      <td className="py-2.5 text-end tnum">{money(p.amount)}</td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </section>

          <section className="mt-6 flex justify-end">
            <div className="w-full max-w-xs">
              <div className="flex justify-between py-1 text-[13px] text-ink-500">
                <span>{L.invoiceTotal}</span>
                <span className="tnum">{money(inv.total)}</span>
              </div>
              <div
                className="mt-1 flex justify-between border-t-2 pt-2 text-[15px] font-bold"
                style={{ borderColor: "var(--bk)" }}
              >
                <span>{L.totalReceived}</span>
                <span className="tnum">{money(received)}</span>
              </div>
            </div>
          </section>

          <p className="mt-8 text-[13px] text-ink-500">{L.thanks}</p>
          {/*
            Said plainly, because a receipt that looks like an invoice is exactly
            how a clinic ends up with two documents claiming to be the tax record
            of one visit.
          */}
          <p className="mt-2 text-[12px] leading-relaxed text-ink-400">{L.notATaxInvoice}</p>

          {inv.invoice_footer && (
            <p className="mt-8 border-t border-line pt-4 text-center text-[12px] text-ink-400">
              {inv.invoice_footer}
            </p>
          )}

          <div className={`flex justify-center ${inv.invoice_footer ? "mt-3" : "mt-8 border-t border-line pt-4"}`}>
            <PoweredBy label={L.poweredBy} showUrl={!!print} />
            {!print && <PrivacyLink label={L.privacy} className="ms-3" />}
          </div>
        </div>
      </div>
    </main>
  );
}
