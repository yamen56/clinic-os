"use client";

import { useI18n } from "@/lib/i18n/client";
import { Card, CardHeader } from "@/components/ui/card";
import { CheckCheck, Check, AlertCircle, Clock, PhoneOff } from "lucide-react";

export type DeliveryStats = {
  total: number;
  delivered: number;
  read: number;
  sent: number;
  failed: number;
  no_account: number;
  pending: number;
  unreachable: number;
};

/**
 * The week in delivery terms.
 *
 * "Connected" is not the same as "arriving", and the difference is invisible
 * until someone asks why a patient never got their reminder. `sent` is the
 * honest middle: handed to WhatsApp, no receipt back yet.
 */
export function Deliverability({ stats: s }: { stats: DeliveryStats }) {
  const { t } = useI18n();
  const pct = s.total ? Math.round((s.delivered / s.total) * 100) : null;

  const rows = [
    { icon: <CheckCheck className="h-4 w-4 text-success" />, label: t.wa.delivered, n: s.delivered },
    { icon: <CheckCheck className="h-4 w-4 text-sky-500" />, label: t.wa.readCount, n: s.read },
    { icon: <Check className="h-4 w-4 text-ink-400" />, label: t.wa.awaitingReceipt, n: s.sent },
    { icon: <Clock className="h-4 w-4 text-ink-400" />, label: t.wa.inQueue, n: s.pending },
    { icon: <AlertCircle className="h-4 w-4 text-danger" />, label: t.wa.failedCount, n: s.failed },
    { icon: <PhoneOff className="h-4 w-4 text-danger" />, label: t.wa.noAccount, n: s.no_account },
  ];

  return (
    <Card>
      <CardHeader title={t.wa.deliverability} sub={t.wa.deliverabilitySub} />
      <div className="p-5 pt-0">
        {s.total === 0 ? (
          <p className="text-sm text-ink-500">{t.wa.noSendsYet}</p>
        ) : (
          <>
            <div className="mb-4 flex items-baseline gap-2">
              <span className="tnum text-3xl font-semibold text-ink-900">{pct}%</span>
              <span className="text-[13px] text-ink-500">
                {t.wa.deliveredOf.replace("{n}", String(s.total))}
              </span>
            </div>
            {/* A bar rather than a chart: one number, read at a glance. */}
            <div className="mb-4 h-1.5 overflow-hidden rounded-full bg-sunken">
              <div className="h-full rounded-full bg-success" style={{ width: `${pct ?? 0}%` }} />
            </div>
            <dl className="grid gap-2 sm:grid-cols-2">
              {rows.map((r) => (
                <div key={r.label} className="flex items-center gap-2 text-[13px]">
                  {r.icon}
                  <dt className="flex-1 text-ink-700">{r.label}</dt>
                  <dd className="tnum font-medium text-ink-900">{r.n}</dd>
                </div>
              ))}
            </dl>
          </>
        )}

        {s.unreachable > 0 && (
          <p className="mt-4 rounded-lg bg-sunken p-3 text-[13px] text-ink-700">
            {t.wa.unreachableNote.replace("{n}", String(s.unreachable))}
          </p>
        )}
      </div>
    </Card>
  );
}
