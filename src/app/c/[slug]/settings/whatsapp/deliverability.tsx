"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n/client";
import { Card, CardHeader } from "@/components/ui/card";
import { fmtDateTime } from "@/lib/dates";
import { formatPhone } from "@/lib/phone";
import { deliveryNote, deliveryText } from "@/lib/wa-delivery";
import { CheckCheck, Check, AlertCircle, Clock, PhoneOff, Ban, CircleDashed } from "lucide-react";

type Problem = {
  id: string;
  conversation_id: string;
  direction: string;
  status: string;
  error: string | null;
  created_at: string;
  sent_at: string | null;
  scheduled_at: string | null;
  delivered_at: string | null;
  sender_kind: string;
  name: string | null;
  phone_e164: string;
  identifier_kind: string;
};

export type DeliveryStats = {
  total: number;
  delivered: number;
  read: number;
  sent: number;
  failed: number;
  no_account: number;
  pending: number;
  cancelled: number;
  undelivered: number;
  unreachable: number;
  problems: Problem[];
};

/**
 * The week in delivery terms.
 *
 * "Connected" is not the same as "arriving", and the difference is invisible
 * until someone asks why a patient never got their reminder. `sent` is the
 * honest middle: handed to WhatsApp, no receipt back yet. Below the counts,
 * the messages that did not arrive, each with its reason.
 */
export function Deliverability({ stats: s, slug, tz }: { stats: DeliveryStats; slug: string; tz: string }) {
  const { t, locale } = useI18n();
  const pct = s.total ? Math.round((s.delivered / s.total) * 100) : null;

  const rows = [
    { icon: <CheckCheck className="h-4 w-4 text-success" />, label: t.wa.delivered, n: s.delivered },
    { icon: <CheckCheck className="h-4 w-4 text-sky-500" />, label: t.wa.readCount, n: s.read },
    { icon: <Check className="h-4 w-4 text-ink-400" />, label: t.wa.awaitingReceipt, n: s.sent },
    { icon: <CircleDashed className="h-4 w-4 text-warning" />, label: t.wa.undeliveredCount, n: s.undelivered },
    { icon: <Clock className="h-4 w-4 text-ink-400" />, label: t.wa.inQueue, n: s.pending },
    { icon: <AlertCircle className="h-4 w-4 text-danger" />, label: t.wa.failedCount, n: s.failed },
    { icon: <PhoneOff className="h-4 w-4 text-danger" />, label: t.wa.noAccount, n: s.no_account },
    { icon: <Ban className="h-4 w-4 text-danger" />, label: t.wa.cancelledCount, n: s.cancelled },
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

        {s.problems.length > 0 && (
          <div className="mt-5" data-delivery-problems>
            <h3 className="text-sm font-semibold text-ink-900">{t.wa.problemsTitle}</h3>
            <p className="mb-2 text-[12px] text-ink-500">{t.wa.problemsSub}</p>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {s.problems.map((p) => {
                const note = deliveryNote(p, { connected: true });
                const who =
                  p.name || (p.identifier_kind === "lid" ? t.conversations.whatsappUser : formatPhone(p.phone_e164));
                return (
                  <li key={p.id} className="flex flex-col gap-1 px-3 py-2.5 sm:flex-row sm:items-start sm:gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                        <span className="font-medium text-ink-900">{who}</span>
                        <span className="text-[12px] text-ink-400" suppressHydrationWarning>
                          {fmtDateTime(p.created_at, tz, locale)}
                        </span>
                        {p.sender_kind !== "staff" && (
                          <span className="text-[12px] text-ink-400">
                            {(t.conversations.sentBy as Record<string, string>)[p.sender_kind] ?? p.sender_kind}
                          </span>
                        )}
                      </div>
                      <p
                        className={`text-[12px] leading-snug ${note?.kind === "undelivered" ? "text-warning" : "text-danger"}`}
                        suppressHydrationWarning
                      >
                        {deliveryText(note, t.delivery, (at) => fmtDateTime(at, tz, locale))}
                      </p>
                    </div>
                    <Link
                      href={`/c/${slug}/conversations?open=${p.conversation_id}`}
                      className="shrink-0 text-[13px] font-medium text-brand-700 hover:underline"
                    >
                      {t.wa.openChat}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
