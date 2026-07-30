"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { useRealtime } from "@/lib/use-realtime";
import { fmtDateTime } from "@/lib/dates";
import { formatPhone } from "@/lib/phone";
import { PageHeader, Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge, type StatusKey } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { startCampaignAction, stopCampaignAction, deleteCampaignAction } from "../actions";
import { campaignStatusColor, estimateDuration, formatInterval } from "../campaigns-client";
import { ArrowLeft, Play, Square, Trash2, AlertTriangle } from "lucide-react";

type Campaign = {
  id: string;
  name: string;
  body: string;
  status: "draft" | "running" | "done" | "cancelled";
  interval_seconds: number;
  total_count: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  next_send_at: string | null;
  created_by_name: string | null;
  message_window_start: string;
  message_window_end: string;
  daily_outbound_cap: number;
  wa_status: string;
};

type Recipient = {
  id: string;
  full_name: string;
  phone_e164: string;
  status: "pending" | "queued" | "sent" | "failed" | "cancelled";
  error: string | null;
  queued_at: string | null;
  sent_at: string | null;
};

const recipientStatus: Record<Recipient["status"], StatusKey> = {
  pending: "neutral",
  queued: "pending",
  sent: "confirmed",
  failed: "danger",
  cancelled: "cancelled",
};

export function CampaignDetail({
  slug,
  campaign,
  recipients,
  tz,
}: {
  slug: string;
  campaign: Campaign;
  recipients: Recipient[];
  tz: string;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // The drip advances on the worker's clock, not on anything this page does.
  // Both tables emit, so progress follows the send instead of waiting for a
  // refresh the user has to think about.
  useRealtime(slug, ["campaigns", "campaign_recipients"], () => router.refresh());

  const counts = recipients.reduce(
    (acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }),
    {} as Record<Recipient["status"], number>
  );
  const sent = counts.sent ?? 0;
  const failed = counts.failed ?? 0;
  const remaining = (counts.pending ?? 0) + (counts.queued ?? 0);
  const settled = sent + failed;
  const pct = campaign.total_count ? Math.round((settled / campaign.total_count) * 100) : 0;
  const everyLabel = (v: string) => t.campaigns.every.replace("{v}", v);

  const run = (fn: () => Promise<{ error?: string }>, ok: string) =>
    start(async () => {
      const r = await fn();
      if (r.error) {
        toast((t.campaigns.errors as Record<string, string>)[r.error] ?? t.common.genericError, "error");
        return;
      }
      toast(ok);
      router.refresh();
    });

  return (
    <>
      <Link
        href={`/c/${slug}/campaigns`}
        className="mb-3 inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-500 hover:text-ink-900"
      >
        <ArrowLeft className="h-4 w-4 rtl:rotate-180" />
        {t.campaigns.title}
      </Link>

      <PageHeader
        title={campaign.name}
        sub={`${formatInterval(campaign.interval_seconds, everyLabel)} · ${t.campaigns.window} ${String(
          campaign.message_window_start
        ).slice(0, 5)}–${String(campaign.message_window_end).slice(0, 5)}`}
        action={
          <div className="flex items-center gap-2">
            <Badge status={campaignStatusColor[campaign.status]} dot>
              {t.campaigns.statuses[campaign.status]}
            </Badge>
            {campaign.status === "draft" && (
              <Button
                onClick={() =>
                  run(() => startCampaignAction(slug, campaign.id), t.campaigns.started)
                }
                loading={pending}
              >
                <Play /> {t.campaigns.startSending}
              </Button>
            )}
            {(campaign.status === "running" || campaign.status === "draft") && (
              <Button variant="danger" onClick={() => setConfirmStop(true)}>
                <Square /> {t.campaigns.stop}
              </Button>
            )}
            {campaign.status !== "running" && (
              <Button variant="ghost" size="iconMd" onClick={() => setConfirmDelete(true)} aria-label={t.common.delete}>
                <Trash2 />
              </Button>
            )}
          </div>
        }
      />

      {campaign.status === "running" && campaign.wa_status !== "connected" && (
        <div className="mb-4 flex items-center gap-2 rounded-ctl bg-danger-soft px-4 py-3 text-[13px] text-danger">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {t.campaigns.waOffline}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <div className="flex items-end justify-between">
            <div>
              <div className="eyebrow">{t.campaigns.progress}</div>
              <div className="font-display mt-1 text-[32px] font-bold leading-none tnum">
                {settled} <span className="text-ink-400">/ {campaign.total_count}</span>
              </div>
            </div>
            <div className="text-end text-[13px] text-ink-500">
              {campaign.status === "running" && remaining > 0 && (
                <div>
                  {t.campaigns.remainingTime.replace(
                    "{d}",
                    estimateDuration(remaining, campaign.interval_seconds)
                  )}
                </div>
              )}
              {campaign.finished_at && (
                <div>{fmtDateTime(campaign.finished_at, tz, locale)}</div>
              )}
            </div>
          </div>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-ink-900/8">
            <div
              className="h-full rounded-full bg-brand-600 transition-[width] duration-220 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-4 text-[13px]">
            <span className="text-ok">
              {t.campaigns.sentN.replace("{n}", String(sent))}
            </span>
            {failed > 0 && (
              <span className="text-danger">
                {t.campaigns.failedN.replace("{n}", String(failed))}
              </span>
            )}
            <span className="text-ink-500">
              {t.campaigns.remainingN.replace("{n}", String(remaining))}
            </span>
          </div>
        </Card>

        <Card className="p-5">
          <div className="eyebrow">{t.campaigns.message}</div>
          <p className="mt-2 whitespace-pre-wrap text-sm text-ink-700">{campaign.body}</p>
          {campaign.created_by_name && (
            <p className="mt-3 text-xs text-ink-500">
              {t.campaigns.createdBy.replace("{name}", campaign.created_by_name)}
            </p>
          )}
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader
          title={t.campaigns.recipients}
          sub={t.campaigns.recipientsSub.replace("{n}", String(campaign.total_count))}
        />
        <ul className="divide-y divide-line">
          {recipients.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-5 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{r.full_name}</div>
                <div className="text-[13px] text-ink-500" dir="ltr">
                  {formatPhone(r.phone_e164)}
                </div>
              </div>
              {r.error && (
                <span className="max-w-[40%] truncate text-xs text-danger" title={r.error}>
                  {r.error}
                </span>
              )}
              {r.sent_at && (
                <span className="hidden text-xs text-ink-500 sm:block">
                  {fmtDateTime(r.sent_at, tz, locale)}
                </span>
              )}
              <Badge status={recipientStatus[r.status]}>
                {t.campaigns.recipientStatuses[r.status]}
              </Badge>
            </li>
          ))}
        </ul>
      </Card>

      <ConfirmDialog
        open={confirmStop}
        onClose={() => setConfirmStop(false)}
        onConfirm={() => {
          setConfirmStop(false);
          run(() => stopCampaignAction(slug, campaign.id), t.campaigns.stopped);
        }}
        title={t.campaigns.stopTitle}
        body={t.campaigns.stopBody.replace("{n}", String(remaining))}
        confirmLabel={t.campaigns.stop}
        cancelLabel={t.common.cancel}
        loading={pending}
      />

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          start(async () => {
            const r = await deleteCampaignAction(slug, campaign.id);
            if (r.error) {
              toast(t.common.genericError, "error");
              return;
            }
            router.push(`/c/${slug}/campaigns`);
          });
        }}
        title={t.campaigns.deleteTitle}
        body={t.campaigns.deleteBody}
        confirmLabel={t.common.delete}
        cancelLabel={t.common.cancel}
        loading={pending}
      />
    </>
  );
}
