"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { fmtDate } from "@/lib/dates";
import { PageHeader, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Badge, type StatusKey } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { createCampaignAction, previewAudienceAction } from "./actions";
import { MIN_INTERVAL_SECONDS, type CampaignAudience } from "./constants";
import { Megaphone, Plus, ChevronRight } from "lucide-react";

export type CampaignRow = {
  id: string;
  name: string;
  status: "draft" | "running" | "done" | "cancelled";
  interval_seconds: number;
  total_count: number;
  created_at: string;
  sent: number;
  failed: number;
  pending: number;
};

export const campaignStatusColor: Record<CampaignRow["status"], StatusKey> = {
  draft: "neutral",
  running: "brand",
  done: "completed",
  cancelled: "cancelled",
};

/** Whole minutes read better than seconds for a drip measured in hours. */
export function formatInterval(seconds: number, everyLabel: (n: string) => string): string {
  if (seconds % 3600 === 0) return everyLabel(`${seconds / 3600}h`);
  if (seconds % 60 === 0) return everyLabel(`${seconds / 60}m`);
  return everyLabel(`${seconds}s`);
}

/** Rough finish time, so the pacing choice is a decision and not a guess. */
export function estimateDuration(remaining: number, intervalSeconds: number): string {
  const total = Math.max(0, remaining - 1) * intervalSeconds;
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.round(total / 60)}m`;
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

const INTERVAL_CHOICES = [30, 60, 120, 300, 600, 1800, 3600];

export function CampaignsClient({
  slug,
  campaigns,
  allTags,
  tz,
}: {
  slug: string;
  campaigns: CampaignRow[];
  allTags: string[];
  tz: string;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [interval, setInterval] = useState(120);
  const [filters, setFilters] = useState({ tag: "", source: "", visit: "" });
  const [audience, setAudience] = useState<CampaignAudience | null>(null);
  const [err, setErr] = useState("");

  // Recount whenever the audience changes, so the number on the button is the
  // number that will actually be messaged.
  useEffect(() => {
    if (!open) return;
    let stale = false;
    setAudience(null);
    previewAudienceAction(slug, filters)
      .then((a) => !stale && setAudience(a))
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [open, slug, filters]);

  const submit = () =>
    start(async () => {
      setErr("");
      const r = await createCampaignAction(slug, {
        name,
        body,
        intervalSeconds: interval,
        filters,
      });
      if (r.error) {
        setErr((t.campaigns.errors as Record<string, string>)[r.error] ?? t.common.genericError);
        return;
      }
      setOpen(false);
      setName("");
      setBody("");
      router.push(`/c/${slug}/campaigns/${r.id}`);
    });

  const everyLabel = (v: string) => t.campaigns.every.replace("{v}", v);

  return (
    <>
      <PageHeader
        title={t.campaigns.title}
        sub={t.campaigns.subtitle}
        action={
          <Button onClick={() => setOpen(true)}>
            <Plus /> {t.campaigns.newCampaign}
          </Button>
        }
      />

      {campaigns.length === 0 ? (
        <EmptyState
          icon={<Megaphone />}
          title={t.campaigns.emptyTitle}
          body={t.campaigns.emptyBody}
          action={
            <Button onClick={() => setOpen(true)}>
              <Plus /> {t.campaigns.newCampaign}
            </Button>
          }
        />
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {campaigns.map((c) => {
              const done = c.sent + c.failed;
              const pct = c.total_count ? Math.round((done / c.total_count) * 100) : 0;
              return (
                <li key={c.id}>
                  <Link
                    href={`/c/${slug}/campaigns/${c.id}`}
                    className="flex items-center gap-4 px-5 py-3.5 hover:bg-sunken"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{c.name}</span>
                        <Badge status={campaignStatusColor[c.status]}>
                          {t.campaigns.statuses[c.status]}
                        </Badge>
                      </div>
                      <div className="mt-1 text-[13px] text-ink-500">
                        {formatInterval(c.interval_seconds, everyLabel)} ·{" "}
                        {fmtDate(c.created_at, tz, locale)}
                      </div>
                    </div>
                    <div className="w-32 shrink-0">
                      <div className="text-[13px] font-semibold tnum">
                        {done} / {c.total_count}
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-900/8">
                        <div
                          className="h-full rounded-full bg-brand-600 transition-[width] duration-220 ease-out"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 text-ink-400 rtl:rotate-180" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t.campaigns.newCampaign}
        wide
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t.common.cancel}
            </Button>
            <Button onClick={submit} loading={pending} disabled={!audience?.reachable}>
              {audience
                ? t.campaigns.reviewN.replace("{n}", String(audience.reachable))
                : t.common.loading}
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <Field label={t.campaigns.name} required>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus />
          </Field>

          <Field label={t.campaigns.message} hint={t.campaigns.messageHint} required>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              placeholder={t.campaigns.messagePlaceholder}
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t.patients.tags}>
              <Select
                value={filters.tag}
                onChange={(e) => setFilters({ ...filters, tag: e.target.value })}
              >
                <option value="">{t.patients.filters.allTags}</option>
                {allTags.map((tg) => (
                  <option key={tg} value={tg}>
                    {tg}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t.patients.source}>
              <Select
                value={filters.source}
                onChange={(e) => setFilters({ ...filters, source: e.target.value })}
              >
                <option value="">{t.patients.filters.allSources}</option>
                {["staff", "booking_link", "whatsapp", "ai_agent", "import"].map((s) => (
                  <option key={s} value={s}>
                    {(t.patients.sources as Record<string, string>)[s] ?? s}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t.patients.lastVisit}>
              <Select
                value={filters.visit}
                onChange={(e) => setFilters({ ...filters, visit: e.target.value })}
              >
                <option value="">{t.patients.filters.anyVisit}</option>
                <option value="30">{t.patients.filters.noVisit30}</option>
                <option value="90">{t.patients.filters.noVisit90}</option>
                <option value="180">{t.patients.filters.noVisit180}</option>
              </Select>
            </Field>
          </div>

          <Field label={t.campaigns.pacing} hint={t.campaigns.pacingHint}>
            <Select value={interval} onChange={(e) => setInterval(Number(e.target.value))}>
              {INTERVAL_CHOICES.filter((s) => s >= MIN_INTERVAL_SECONDS).map((s) => (
                <option key={s} value={s}>
                  {formatInterval(s, everyLabel)}
                </option>
              ))}
            </Select>
          </Field>

          <div className="rounded-ctl bg-sunken px-4 py-3 text-[13px] text-ink-700">
            {audience ? (
              <>
                <div className="font-semibold text-ink-900">
                  {t.campaigns.willReach
                    .replace("{n}", String(audience.reachable))
                    .replace("{total}", String(audience.total))}
                </div>
                {audience.reachable > 0 && (
                  <div className="mt-1">
                    {t.campaigns.estimated.replace(
                      "{d}",
                      estimateDuration(audience.reachable, interval)
                    )}
                  </div>
                )}
                {audience.sample.length > 0 && (
                  <div className="mt-1 truncate text-ink-500">{audience.sample.join(" · ")}…</div>
                )}
                {/*
                  Two reasons somebody in the filter is not in the send, and
                  they are not interchangeable. "No number" is a gap in the file
                  that reception can fill; "asked not to be messaged" is a
                  decision, and rolling it into the first would invite exactly
                  the wrong fix.
                */}
                {audience.total - audience.reachable - audience.muted > 0 && (
                  <div className="mt-1 text-ink-500">
                    {t.campaigns.noPhoneSkipped.replace(
                      "{n}",
                      String(audience.total - audience.reachable - audience.muted)
                    )}
                  </div>
                )}
                {audience.muted > 0 && (
                  <div className="mt-1 text-ink-500">
                    {t.campaigns.mutedSkipped.replace("{n}", String(audience.muted))}
                  </div>
                )}
              </>
            ) : (
              t.common.loading
            )}
          </div>

          {err && (
            <p className="rounded-ctl bg-danger-soft px-3 py-2 text-sm text-danger">{err}</p>
          )}
        </div>
      </Modal>
    </>
  );
}
