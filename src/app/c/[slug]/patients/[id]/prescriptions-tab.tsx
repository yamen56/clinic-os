"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { useRealtime } from "@/lib/use-realtime";
import { fmtDate } from "@/lib/dates";
import { rxNumber, type PrescriptionRow } from "@/lib/prescriptions";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge, type StatusKey } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { resendPrescriptionAction } from "./prescription-actions";
import { FileText, Pill, Plus, Repeat, Send } from "lucide-react";

const STATUS_BADGE: Record<string, StatusKey> = {
  queued: "pending",
  sending: "pending",
  sent: "brand",
  delivered: "confirmed",
  read: "confirmed",
  failed: "danger",
};

/**
 * The patient's prescriptions, newest first.
 *
 * Each says where it got to on WhatsApp — sending, delivered, read — because
 * "did they get it?" is the question the desk is asked, and the answer should
 * not need the inbox. Repeat is the second-commonest thing a doctor does here:
 * the same course again, for a patient who is back with the same complaint.
 */
export function PrescriptionsTab({
  slug,
  rows,
  tz,
  canWrite,
  hasPhone,
  onNew,
  onRepeat,
  onUpdated,
}: {
  slug: string;
  rows: PrescriptionRow[];
  tz: string;
  canWrite: boolean;
  hasPhone: boolean;
  onNew: () => void;
  onRepeat: (row: PrescriptionRow) => void;
  onUpdated: (row: PrescriptionRow) => void;
}) {
  const { t, locale } = useI18n();
  const T = t.prescriptions;
  const { toast } = useToast();
  const [resending, setResending] = useState<string | null>(null);

  const inFlight = rows
    .filter((r) => r.message_id && (r.message_status === "queued" || r.message_status === "sending"))
    .map((r) => r.message_id as string);

  const resend = (row: PrescriptionRow) => {
    setResending(row.id);
    resendPrescriptionAction(slug, row.id)
      .then((r) => {
        if (r.row) onUpdated(r.row);
        if (r.error) toast(T.failed, "error");
        else if (r.warning === "no_phone") toast(T.savedNoPhone, "error");
        else if (r.warning === "wa_disconnected") toast(T.savedNotSent, "error");
        else if (r.warning) toast(T.pdfFailed, "error");
        else toast(T.resent);
      })
      .catch(() => toast(T.failed, "error"))
      .finally(() => setResending(null));
  };

  /*
    `@container`: the rows lay out by the width of this card, not of the
    screen. An iPad in portrait has the sidebar open and leaves the file about
    as narrow as a large phone, and a row that decided by viewport put three
    buttons beside the text there and squeezed the medicine names to a stub.
  */
  return (
    <Card className="@container">
      {inFlight.length > 0 && <DeliveryWatch slug={slug} messageIds={inFlight} />}
      {rows.length === 0 ? (
        <div className="p-5">
          <EmptyState
            icon={<Pill />}
            title={T.empty}
            body={canWrite ? T.emptyBody : undefined}
            action={
              canWrite ? (
                <Button onClick={onNew}>
                  <Plus className="h-4 w-4" />
                  {T.new}
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <>
          {canWrite && (
            <div className="flex border-b border-line px-4 py-3 @xl:justify-end @xl:px-5">
              <Button onClick={onNew} className="w-full @xl:w-auto">
                <Plus className="h-4 w-4" />
                {T.new}
              </Button>
            </div>
          )}
          <ul className="divide-y divide-line">
            {rows.map((r) => {
              const status = r.sent_at ? (r.message_status ?? "queued") : null;
              const actions = [
                canWrite && { key: "repeat", icon: <Repeat />, label: T.repeat, onClick: () => onRepeat(r) },
                { key: "pdf", icon: <FileText />, label: T.pdf, href: `/api/c/${slug}/prescriptions/${r.id}/pdf` },
                canWrite &&
                  hasPhone && {
                    key: "resend",
                    icon: <Send />,
                    label: T.resend,
                    onClick: () => resend(r),
                    busy: resending === r.id,
                    disabled: !!resending,
                  },
              ].filter(Boolean) as RowActionProps[];
              return (
                <li
                  key={r.id}
                  className="flex flex-col gap-3 px-4 py-3.5 @2xl:flex-row @2xl:items-center @2xl:gap-4 @xl:px-5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-sm font-semibold tnum" dir="ltr">
                        {rxNumber(r.number)}
                      </span>
                      <span className="text-[12px] text-ink-500" suppressHydrationWarning>
                        {fmtDate(r.created_at, tz, locale)}
                      </span>
                      {status ? (
                        <Badge status={STATUS_BADGE[status] ?? "neutral"}>
                          {(T.status as Record<string, string>)[status] ?? status}
                        </Badge>
                      ) : (
                        <Badge status="neutral">{T.notSent}</Badge>
                      )}
                    </div>
                    {/* Each name isolated: a Latin drug name in an Arabic list
                        must not pull its neighbours' separators around. */}
                    <div className="mt-1 truncate text-sm text-ink-900">
                      {r.items.map((it, i) => (
                        <span key={i}>
                          {i > 0 && <span className="text-ink-400"> · </span>}
                          <bdi>{it.name}</bdi>
                        </span>
                      ))}
                    </div>
                    <div className="mt-0.5 text-[12px] text-ink-500">
                      {r.doctor_name}
                      {r.by_other && r.author_name && ` · ${T.writtenBy.replace("{name}", r.author_name)}`}
                      {r.diagnosis && (
                        <>
                          {" · "}
                          <bdi>{r.diagnosis}</bdi>
                        </>
                      )}
                    </div>
                  </div>
                  {/*
                    Narrow, the actions are one row of equal cells under the
                    text, icon above label, so "إعادة الإرسال" fits a third of a
                    phone without being cut. Wide, they sit beside the text as
                    ordinary buttons.
                  */}
                  <div
                    className="grid gap-2 @2xl:flex @2xl:shrink-0"
                    style={{ gridTemplateColumns: `repeat(${actions.length}, minmax(0, 1fr))` }}
                  >
                    {actions.map(({ key, ...a }) => (
                      <RowAction key={key} {...a} />
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Card>
  );
}

type RowActionProps = {
  key: string;
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  href?: string;
  busy?: boolean;
  disabled?: boolean;
};

/**
 * One of a prescription's actions.
 *
 * Not the shared Button: that one has a fixed height and a single row, and
 * here the same control is a stacked cell on a phone and an inline button on
 * a desk. Styled to match it at the wide size.
 */
function RowAction({ icon, label, onClick, href, busy, disabled }: Omit<RowActionProps, "key">) {
  const cls = `relative flex min-w-0 touch-manipulation select-none flex-col items-center justify-center gap-1 rounded-ctl border border-line px-2 py-2 text-[12px] font-semibold text-ink-900 transition-colors duration-140 hover:bg-brand-100 active:translate-y-px disabled:pointer-events-none disabled:opacity-45 @2xl:h-9 @2xl:flex-row @2xl:gap-2 @2xl:px-3 @2xl:py-0 @2xl:text-[13px] [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0 ${
    busy ? "animate-pulse" : ""
  }`;
  const body = (
    <>
      {icon}
      {/* Wraps in its cell on the narrowest phones rather than losing its end:
          "إعادة الإرسال" cut to "إعادة الإ…" no longer says what it does. */}
      <span className="max-w-full text-center leading-tight @2xl:whitespace-nowrap">{label}</span>
    </>
  );
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={cls}>
        {body}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-busy={busy || undefined} className={cls}>
      {body}
    </button>
  );
}

/**
 * Refreshes the file when one of these messages changes.
 *
 * Mounted only while something is still on its way, so the file holds no
 * event stream open for prescriptions that were delivered last week.
 */
function DeliveryWatch({ slug, messageIds }: { slug: string; messageIds: string[] }) {
  const router = useRouter();
  useRealtime(slug, ["messages"], (e) => {
    if (!e || (e.id && messageIds.includes(e.id))) router.refresh();
  });
  return null;
}
