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

  return (
    <Card>
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
            <div className="flex justify-end border-b border-line px-5 py-3">
              <Button size="sm" onClick={onNew}>
                <Plus className="h-4 w-4" />
                {T.new}
              </Button>
            </div>
          )}
          <ul className="divide-y divide-line">
            {rows.map((r) => {
              const status = r.sent_at ? (r.message_status ?? "queued") : null;
              return (
                <li key={r.id} className="flex flex-wrap items-start gap-3 px-5 py-3.5">
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
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    {canWrite && (
                      <Button variant="outline" size="sm" onClick={() => onRepeat(r)}>
                        <Repeat className="h-4 w-4" />
                        {T.repeat}
                      </Button>
                    )}
                    <a href={`/api/c/${slug}/prescriptions/${r.id}/pdf`} target="_blank" rel="noreferrer">
                      <Button variant="outline" size="sm" tabIndex={-1}>
                        <FileText className="h-4 w-4" />
                        {T.pdf}
                      </Button>
                    </a>
                    {canWrite && hasPhone && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => resend(r)}
                        loading={resending === r.id}
                        disabled={!!resending}
                      >
                        <Send className="h-4 w-4" />
                        {T.resend}
                      </Button>
                    )}
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
