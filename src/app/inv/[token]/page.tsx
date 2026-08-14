import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { withSystem } from "@/lib/db";
import { fmtDate, fmtMoney } from "@/lib/dates";
import { PoweredBy, PrivacyLink } from "@/components/powered-by";

export const metadata: Metadata = { robots: { index: false } };

async function loadInvoice(token: string) {
  return withSystem(async (c) => {
    const inv = (
      await c.query(
        `select i.*, p.full_name as patient_name, p.phone_e164 as patient_phone,
                cl.name, cl.name_ar, cl.slug, cl.logo_path, cl.brand_color, cl.address, cl.address_ar,
                cl.phone_e164 as clinic_phone, cl.default_locale, cl.timezone,
                cl.invoice_footer, cl.payment_instructions, cl.invoice_tax_label
         from invoices i
         join patients p on p.id = i.patient_id
         join clinics cl on cl.id = i.clinic_id
         where i.public_token = $1`,
        [token]
      )
    ).rows[0];
    if (!inv) return null;
    const items = (
      await c.query(
        `select description, qty, unit_price, amount from invoice_items where invoice_id = $1 order by sort`,
        [inv.id]
      )
    ).rows;
    const payments = (
      await c.query(
        `select amount, method, paid_at from payments where invoice_id = $1 order by paid_at`,
        [inv.id]
      )
    ).rows;
    return { inv, items, payments };
  });
}

export default async function PublicInvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ print?: string }>;
}) {
  const { token } = await params;
  const { print } = await searchParams;
  const data = await loadInvoice(token);
  if (!data) notFound();
  const { inv, items, payments } = data;

  const isAr = inv.default_locale !== "en";
  const locale = isAr ? "ar" : "en";
  const clinicName = isAr ? inv.name_ar || inv.name : inv.name;
  const address = isAr ? inv.address_ar || inv.address : inv.address;
  const due = Number(inv.total) - Number(inv.amount_paid);
  const brand = inv.brand_color as string;

  const L = isAr
    ? {
        invoice: "فاتورة", billTo: "فاتورة إلى", date: "التاريخ", item: "البند", qty: "الكمية",
        price: "السعر", amount: "المجموع", subtotal: "المجموع الفرعي", discount: "الخصم",
        total: "الإجمالي", paid: "المدفوع", due: "المستحق",
        payTitle: "تفاصيل الدفع", statusPaid: "مدفوعة", statusVoid: "ملغاة",
        poweredBy: "مدعوم من كلينيكتي", privacy: "سياسة الخصوصية",
      }
    : {
        invoice: "Invoice", billTo: "Billed to", date: "Date", item: "Item", qty: "Qty",
        price: "Price", amount: "Amount", subtotal: "Subtotal", discount: "Discount",
        total: "Total", paid: "Paid", due: "Balance due",
        payTitle: "Payment details", statusPaid: "PAID", statusVoid: "VOID",
        poweredBy: "Powered by Clinicti", privacy: "Privacy Policy",
      };

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
        {/* Header band */}
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
                {L.invoice}
              </div>
              <div className="font-display text-lg font-bold tnum" dir="ltr">
                {inv.number}
              </div>
              <div className="mt-1 text-[13px] text-ink-500">
                {L.date}: {fmtDate(inv.created_at, inv.timezone, locale)}
              </div>
              {inv.status === "paid" && (
                <span className="mt-2 inline-block rounded-full px-3 py-1 text-[12px] font-bold text-white" style={{ background: "var(--bk)" }}>
                  {L.statusPaid}
                </span>
              )}
              {inv.status === "void" && (
                <span className="mt-2 inline-block rounded-full bg-ink-400 px-3 py-1 text-[12px] font-bold text-white">
                  {L.statusVoid}
                </span>
              )}
            </div>
          </header>

          <section className="mt-8">
            <div className="text-[12px] font-semibold uppercase tracking-widest text-ink-500">
              {L.billTo}
            </div>
            <div className="mt-1 text-[15px] font-semibold">{inv.patient_name}</div>
            {inv.patient_phone && (
              <div className="text-[13px] text-ink-500 tnum" dir="ltr">
                {inv.patient_phone}
              </div>
            )}
          </section>

          <table className="mt-8 w-full border-collapse text-sm">
            <thead>
              <tr className="border-b-2 text-[12px] uppercase tracking-wide text-ink-500" style={{ borderColor: "var(--bk)" }}>
                <th className="py-2 text-start font-semibold">{L.item}</th>
                <th className="w-16 py-2 text-center font-semibold">{L.qty}</th>
                <th className="w-28 py-2 text-end font-semibold">{L.price}</th>
                <th className="w-28 py-2 text-end font-semibold">{L.amount}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i} className="border-b border-line">
                  <td className="py-2.5">{it.description}</td>
                  <td className="py-2.5 text-center tnum">{Number(it.qty)}</td>
                  <td className="py-2.5 text-end tnum">{fmtMoney(Number(it.unit_price), inv.currency, locale)}</td>
                  <td className="py-2.5 text-end tnum">{fmtMoney(Number(it.amount), inv.currency, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-4 flex justify-end">
            <div className="w-64 space-y-1.5 text-sm">
              <div className="flex justify-between text-ink-500">
                <span>{L.subtotal}</span>
                <span className="tnum">{fmtMoney(Number(inv.subtotal), inv.currency, locale)}</span>
              </div>
              {Number(inv.discount_amount) > 0 && (
                <div className="flex justify-between text-ink-500">
                  <span>{L.discount}</span>
                  <span className="tnum">−{fmtMoney(Number(inv.discount_amount), inv.currency, locale)}</span>
                </div>
              )}
              {Number(inv.tax_rate) > 0 && (
                <div className="flex justify-between text-ink-500">
                  <span>
                    {inv.invoice_tax_label || "Tax"} ({Number(inv.tax_rate)}%)
                  </span>
                  <span className="tnum">{fmtMoney(Number(inv.tax_amount), inv.currency, locale)}</span>
                </div>
              )}
              <div className="flex justify-between border-t-2 pt-2 font-display text-base font-bold" style={{ borderColor: "var(--bk)" }}>
                <span>{L.total}</span>
                <span className="tnum">{fmtMoney(Number(inv.total), inv.currency, locale)}</span>
              </div>
              {payments.length > 0 && (
                <>
                  <div className="flex justify-between text-ink-500">
                    <span>{L.paid}</span>
                    <span className="tnum">−{fmtMoney(Number(inv.amount_paid), inv.currency, locale)}</span>
                  </div>
                  <div className="flex justify-between font-semibold" style={{ color: due > 0 ? "var(--color-st-pending)" : "var(--bk)" }}>
                    <span>{L.due}</span>
                    <span className="tnum">{fmtMoney(due, inv.currency, locale)}</span>
                  </div>
                </>
              )}
            </div>
          </div>

          {inv.payment_instructions && inv.status !== "paid" && inv.status !== "void" && (
            <section className="mt-8 rounded-xl border border-line bg-subtle p-4">
              <div className="text-[12px] font-semibold uppercase tracking-widest text-ink-500">
                {L.payTitle}
              </div>
              <p className="mt-1 whitespace-pre-wrap text-[13px] leading-6">{inv.payment_instructions}</p>
            </section>
          )}

          {inv.notes && <p className="mt-6 text-[13px] text-ink-500">{inv.notes}</p>}
          {inv.invoice_footer && (
            <p className="mt-8 border-t border-line pt-4 text-center text-[12px] text-ink-400">
              {inv.invoice_footer}
            </p>
          )}

          {/*
            The credit sits below anything the clinic wrote itself, and carries
            its own hairline only when the clinic's footer did not already draw
            one — two rules stacked at the foot of an invoice look like a mistake.
          */}
          <div className={`flex justify-center ${inv.invoice_footer ? "mt-3" : "mt-8 border-t border-line pt-4"}`}>
            <PoweredBy label={L.poweredBy} showUrl={!!print} />
            {!print && <PrivacyLink label={L.privacy} className="ms-3" />}
          </div>
        </div>
      </div>
    </main>
  );
}
