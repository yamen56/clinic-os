import Link from "next/link";
import { Card, CardHeader } from "@/components/ui/card";
import type { Dict } from "@/lib/i18n/en";
import type { Need, Overview } from "@/lib/admin-overview";
import { fmtDateOnly, fmtMoney } from "@/lib/dates";
import { PLANS } from "@/lib/plans";
import { AlertTriangle, BellRing, CalendarClock, CheckCircle2, ChevronRight, CreditCard, MailWarning, MessageCircleOff, Users } from "lucide-react";

/** One line per thing to do, in the words of what to do about it. */
function needText(t: Dict, n: Need, locale: string): string {
  const date = n.at ? fmtDateOnly(n.at, locale) : "";
  return t.admin.needs[n.kind]
    .replace("{clinic}", n.clinic?.name ?? "")
    .replace("{title}", n.title ?? "")
    .replace("{date}", date)
    .replace("{n}", String(n.n ?? ""))
    .replace("{limit}", String(n.limit ?? ""));
}

const ICON: Record<Need["kind"], typeof AlertTriangle> = {
  alert: AlertTriangle,
  whatsapp: MessageCircleOff,
  past_due: CreditCard,
  paid_lapsed: CreditCard,
  trial_ending: CalendarClock,
  trial_over: CalendarClock,
  invite_pending: MailWarning,
  over_limit: Users,
  notice: BellRing,
};

const URGENT = new Set<Need["kind"]>(["alert", "whatsapp", "past_due", "trial_over"]);

export function OverviewView({ data, t, locale }: { data: Overview; t: Dict; locale: string }) {
  const f = data.figures;
  const figures: [string, string][] = [
    [t.admin.figLive, String(f.live)],
    [t.admin.figPaying, String(f.paying)],
    [t.admin.figTrial, String(f.onTrial)],
    [
      t.admin.figMonthly,
      f.monthly.length ? f.monthly.map((m) => fmtMoney(m.amount, m.currency, locale)).join(" · ") : "—",
    ],
  ];
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-admin-figures>
        {figures.map(([label, value]) => (
          <Card key={label} className="p-4">
            <div className="text-[0.75rem] text-ink-500">{label}</div>
            <div className="mt-0.5 text-xl font-semibold tnum text-ink-900">{value}</div>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title={t.admin.needsYou} sub={data.needs.length ? String(data.needs.length) : undefined} />
          {data.needs.length === 0 ? (
            <p className="flex items-center gap-2 px-5 pb-5 text-sm text-ink-500" data-all-clear>
              <CheckCircle2 className="h-4 w-4 text-brand-700" />
              {t.admin.allClear}
            </p>
          ) : (
            <ul className="divide-y divide-line" data-needs>
              {data.needs.map((n, i) => {
                const Icon = ICON[n.kind];
                return (
                  <li key={i}>
                    <Link
                      href={n.href}
                      data-need={n.kind}
                      className="flex items-start gap-3 px-5 py-3 transition-colors hover:bg-sunken"
                    >
                      <Icon className={`mt-0.5 h-4.5 w-4.5 shrink-0 ${URGENT.has(n.kind) ? "text-danger" : "text-ink-400"}`} />
                      <span className="min-w-0 flex-1 text-[0.8125rem] leading-relaxed text-ink-900">{needText(t, n, locale)}</span>
                      <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-ink-300 rtl:rotate-180" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card className="h-fit">
          <CardHeader title={t.admin.plansNav} />
          <ul className="grid gap-2 px-5 pb-5">
            {PLANS.map((p) => (
              <li key={p} className="flex items-center justify-between text-sm">
                <Link href={`/admin/clinics?plan=${p}`} className="text-ink-700 hover:text-ink-900">
                  {t.plans.names[p]}
                </Link>
                <span className="font-semibold tnum">{f.byPlan[p]}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
