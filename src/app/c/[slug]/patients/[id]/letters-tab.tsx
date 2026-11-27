"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { fmtDate, fmtDateOnly } from "@/lib/dates";
import { daysPhrase, letterNumber, type LetterRow } from "@/lib/medical-letters";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { resendLetterAction } from "./letter-actions";
import { DeliveryWatch, RowAction, STATUS_BADGE, type RowActionProps } from "./prescriptions-tab";
import { FileSignature, FileText, Plus, Repeat, Send } from "lucide-react";

/**
 * The patient's sick leaves, reports and referrals, newest first.
 *
 * Laid out like the prescriptions beside it — the same delivery badge, the
 * same row of actions — because the desk asks the same two questions of both:
 * did it reach them, and can you send it again.
 */
export function LettersTab({
  slug,
  rows,
  tz,
  canWrite,
  hasPhone,
  onNew,
  onAgain,
  onUpdated,
}: {
  slug: string;
  rows: LetterRow[];
  tz: string;
  canWrite: boolean;
  hasPhone: boolean;
  onNew: () => void;
  onAgain: (row: LetterRow) => void;
  onUpdated: (row: LetterRow) => void;
}) {
  const { t, locale } = useI18n();
  const T = t.letters;
  const P = t.prescriptions;
  const { toast } = useToast();
  const [resending, setResending] = useState<string | null>(null);

  const inFlight = rows
    .filter((r) => r.message_id && (r.message_status === "queued" || r.message_status === "sending"))
    .map((r) => r.message_id as string);

  const resend = (row: LetterRow) => {
    setResending(row.id);
    resendLetterAction(slug, row.id)
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
    <Card className="@container">
      {inFlight.length > 0 && <DeliveryWatch slug={slug} messageIds={inFlight} />}
      {rows.length === 0 ? (
        <div className="p-5">
          <EmptyState
            icon={<FileSignature />}
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
          <ul className="divide-y divide-line" data-letters-list>
            {rows.map((r) => {
              const status = r.sent_at ? (r.message_status ?? "queued") : null;
              const actions = [
                canWrite && { key: "again", icon: <Repeat />, label: T.again, onClick: () => onAgain(r) },
                { key: "pdf", icon: <FileText />, label: T.pdf, href: `/api/c/${slug}/letters/${r.id}/pdf` },
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
              const summary =
                r.kind === "sick_leave" && r.leave_days && r.leave_from
                  ? T.leaveSummary
                      .replace("{days}", daysPhrase(r.leave_days, locale === "en" ? "en" : "ar"))
                      .replace("{from}", fmtDateOnly(r.leave_from, locale))
                  : r.addressee || r.diagnosis || r.body.split("\n")[0];
              return (
                <li
                  key={r.id}
                  data-letter-row={r.kind}
                  className="flex flex-col gap-3 px-4 py-3.5 @2xl:flex-row @2xl:items-center @2xl:gap-4 @xl:px-5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-sm font-semibold">{T.kinds[r.kind]}</span>
                      <span className="text-[0.75rem] text-ink-500 tnum" dir="ltr">
                        {letterNumber(r.number)}
                      </span>
                      <span className="text-[0.75rem] text-ink-500" suppressHydrationWarning>
                        {fmtDate(r.created_at, tz, locale)}
                      </span>
                      {r.kind === "referral" && r.urgent && <Badge status="danger">{t.letters.sheet.urgent}</Badge>}
                      {status ? (
                        <Badge status={STATUS_BADGE[status] ?? "neutral"}>
                          {(P.status as Record<string, string>)[status] ?? status}
                        </Badge>
                      ) : (
                        <Badge status="neutral">{T.notSent}</Badge>
                      )}
                    </div>
                    {summary && (
                      <div className="mt-1 truncate text-sm text-ink-900">
                        <bdi>{summary}</bdi>
                      </div>
                    )}
                    <div className="mt-0.5 text-[0.75rem] text-ink-500">
                      {r.doctor_name}
                      {r.by_other && r.author_name && ` · ${T.writtenBy.replace("{name}", r.author_name)}`}
                    </div>
                  </div>
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
