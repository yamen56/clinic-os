"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { fmtDateOnly, fmtMoney, monthLabel } from "@/lib/dates";
import { PageHeader, Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import type { DoctorEarnings, EarningsLine } from "@/lib/earnings";
import { ChevronLeft, ChevronRight, Wallet, AlertTriangle } from "lucide-react";

type Flagged = { invoiceId: string; number: string; doctorMemberId: string; earned: number };

export function EarningsClient({
  slug,
  currency,
  timezone,
  offset,
  hasCommission,
  myRate,
  self,
  detail,
  team,
  net,
  flagged,
  names,
  showTeam,
}: {
  slug: string;
  currency: string;
  timezone: string;
  offset: number;
  hasCommission: boolean;
  myRate: number | null;
  self: DoctorEarnings | null;
  detail: EarningsLine[];
  team: DoctorEarnings[];
  net: { gross: number; commission: number; afterCommission: number } | null;
  flagged: Flagged[];
  names: Record<string, string>;
  showTeam: boolean;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const money = (n: number) => fmtMoney(n, currency, locale);

  if (!hasCommission) {
    return (
      <>
        <PageHeader title={t.nav.earnings} />
        <Card className="p-5">
          <EmptyState
            icon={<Wallet className="h-6 w-6" />}
            title={t.earnings.noneTitle}
            body={t.earnings.noneBody}
          />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={t.nav.earnings}
        sub={t.earnings.sub}
        action={
          /* Stepping back through months, never forward past this one: there is
             nothing to show in a month that has not happened. */
          <div className="flex items-center gap-1">
            <button
              aria-label={t.earnings.previousMonth}
              onClick={() => router.push(`/c/${slug}/earnings?m=${offset - 1}`)}
              className="rounded-lg border border-line p-1.5 text-ink-500 hover:border-brand-400"
            >
              <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
            </button>
            <span className="min-w-36 text-center text-[13px] font-medium tabular-nums">
              {monthLabel(timezone, offset, locale)}
            </span>
            <button
              aria-label={t.earnings.nextMonth}
              disabled={offset >= 0}
              onClick={() => router.push(`/c/${slug}/earnings?m=${offset + 1}`)}
              className="rounded-lg border border-line p-1.5 text-ink-500 hover:border-brand-400 disabled:opacity-40"
            >
              <ChevronRight className="h-4 w-4 rtl:rotate-180" />
            </button>
          </div>
        }
      />

      <div className="grid gap-4">
        {self && (
          <Card className="p-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <Figure label={t.earnings.myShare} value={money(self.earned)} strong />
              <Figure label={t.invoices.produced} value={money(self.produced)} />
              <Figure
                label={t.earnings.myRate}
                value={myRate === null ? t.staff.commissionNone : `${myRate}%`}
              />
            </div>
            {/*
              Said plainly, because it is the question this screen will be asked
              about: the share is of the ex-tax net, so it is not a percentage of
              what the patient handed over.
            */}
            <p className="mt-4 border-t border-line pt-3 text-[12px] leading-relaxed text-ink-500">
              {t.earnings.exTaxNote}
            </p>
          </Card>
        )}

        {self && (
          <Card>
            <CardHeader title={t.earnings.breakdown} sub={t.earnings.breakdownSub} />
            {detail.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-ink-400">{t.earnings.nothingThisMonth}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-[11px] uppercase tracking-wide text-ink-400">
                      <th className="px-5 py-2 text-start font-semibold">{t.invoices.invoiceNo}</th>
                      <th className="px-5 py-2 text-start font-semibold">{t.common.date}</th>
                      <th className="px-5 py-2 text-end font-semibold">{t.invoices.produced}</th>
                      <th className="px-5 py-2 text-end font-semibold">{t.invoices.earned}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.map((l) => (
                      <tr key={l.invoiceId} className="border-b border-line last:border-0">
                        <td className="px-5 py-2.5">
                          <Link
                            href={`/c/${slug}/invoices/${l.invoiceId}`}
                            className="font-medium text-brand-700 hover:underline"
                          >
                            {l.number}
                          </Link>
                          {l.status === "void" && (
                            <span className="ms-2 rounded-full bg-sunken px-2 py-0.5 text-[11px] text-ink-500">
                              {t.invoices.statuses.void}
                            </span>
                          )}
                        </td>
                        <td className="px-5 py-2.5 text-ink-500">{fmtDateOnly(l.paidAt, locale)}</td>
                        <td className="px-5 py-2.5 text-end tabular-nums text-ink-500">
                          {money(l.produced)}
                        </td>
                        <td className="px-5 py-2.5 text-end font-medium tabular-nums">
                          {money(l.earned)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}

        {showTeam && net && (
          <Card className="p-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <Figure label={t.earnings.collected} value={money(net.gross)} />
              <Figure label={t.earnings.doctorsShare} value={money(net.commission)} />
              {/*
                "After doctor commission", never "net revenue": what was
                collected is tax-inclusive and the commission is computed
                ex-tax, so the difference is not net of anything tidy.
              */}
              <Figure label={t.earnings.afterCommission} value={money(net.afterCommission)} strong />
            </div>
          </Card>
        )}

        {showTeam && (
          <Card>
            <CardHeader title={t.earnings.payoutTitle} sub={t.earnings.payoutSub} />
            {team.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-ink-400">{t.earnings.nothingThisMonth}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-[11px] uppercase tracking-wide text-ink-400">
                      <th className="px-5 py-2 text-start font-semibold">{t.invoices.doctor}</th>
                      <th className="px-5 py-2 text-end font-semibold">{t.invoices.produced}</th>
                      <th className="px-5 py-2 text-end font-semibold">{t.invoices.earned}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {team.map((d) => (
                      <tr key={d.doctorMemberId} className="border-b border-line last:border-0">
                        <td className="px-5 py-2.5 font-medium">
                          {names[d.doctorMemberId] ?? "—"}
                        </td>
                        <td className="px-5 py-2.5 text-end tabular-nums text-ink-500">
                          {money(d.produced)}
                        </td>
                        <td className="px-5 py-2.5 text-end font-medium tabular-nums">
                          {money(d.earned)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}

        {/*
          Voided, and yet paid. Rare enough that nobody would go looking, and
          exactly the row somebody has to decide about: the doctor has been
          credited for money the clinic may or may not have given back, and only
          a person knows which.
        */}
        {showTeam && flagged.length > 0 && (
          <Card className="border-warning/40 p-5">
            <div className="mb-3 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-warning" />
              <h3 className="text-[14px] font-semibold">{t.earnings.voidedTitle}</h3>
            </div>
            <p className="mb-3 text-[12px] leading-relaxed text-ink-500">{t.earnings.voidedBody}</p>
            <ul className="grid gap-1.5">
              {flagged.map((f) => (
                <li key={`${f.invoiceId}-${f.doctorMemberId}`} className="flex items-center justify-between gap-3 text-[13px]">
                  <Link href={`/c/${slug}/invoices/${f.invoiceId}`} className="text-brand-700 hover:underline">
                    {f.number}
                  </Link>
                  <span className="text-ink-500">{names[f.doctorMemberId] ?? "—"}</span>
                  <span className="tabular-nums font-medium">{money(f.earned)}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-ink-400">{label}</div>
      <div className={`mt-1 tabular-nums ${strong ? "text-2xl font-bold text-ink-900" : "text-xl font-semibold text-ink-700"}`}>
        {value}
      </div>
    </div>
  );
}
