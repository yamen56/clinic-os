"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/client";
import { useRealtime } from "@/lib/use-realtime";
import { fmtDateTime } from "@/lib/dates";
import { PageHeader, Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, NumberInput, Toggle } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Spinner } from "@/components/ui/misc";
import { PushManager } from "@/components/push-manager";
import { saveNotificationPrefsAction } from "./actions";
import { InstallApp } from "@/components/pwa";
import { BellRing, CheckCheck, Smartphone } from "lucide-react";

type Notif = {
  id: string;
  kind: string;
  title: string;
  body: string;
  url: string | null;
  read_at: string | null;
  created_at: string;
  clinic_name: string | null;
};

const DEFAULT_PREFS: Record<string, boolean> = {
  doctor_reminder: true,
  daily_summary: true,
  new_booking: true,
  cancellation: true,
  unread_digest: true,
  day_end: true,
};

export function NotificationsClient({
  slug,
  tz,
  isDoctor,
  prefs: initialPrefs,
  reminderMinutes: initialReminder,
}: {
  slug: string;
  tz: string;
  isDoctor: boolean;
  prefs: Record<string, boolean>;
  reminderMinutes: number;
}) {
  const { t, locale } = useI18n();
  const [items, setItems] = useState<Notif[] | null>(null);
  const [prefs, setPrefs] = useState({ ...DEFAULT_PREFS, ...initialPrefs });
  const [reminder, setReminder] = useState(initialReminder);
  const [, start] = useTransition();

  const load = useCallback(async () => {
    const res = await fetch("/api/me/notifications");
    if (res.ok) setItems((await res.json()).notifications);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime(slug, ["notifications"], () => void load());

  const markAll = async () => {
    await fetch("/api/me/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
    void load();
  };

  const markOne = async (id: string) => {
    await fetch("/api/me/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setItems((xs) => xs?.map((x) => (x.id === id ? { ...x, read_at: new Date().toISOString() } : x)) ?? null);
  };

  const savePrefs = (next: Record<string, boolean>, mins = reminder) =>
    start(async () => {
      setPrefs(next);
      await saveNotificationPrefsAction(slug, next, mins);
    });

  const prefRows: { key: string; label: string; show: boolean }[] = [
    { key: "doctor_reminder", label: t.notifications.prefDoctorReminder, show: isDoctor },
    { key: "daily_summary", label: t.notifications.prefDailySummary, show: isDoctor },
    { key: "new_booking", label: t.notifications.prefNewBooking, show: !isDoctor },
    { key: "cancellation", label: t.notifications.prefCancellation, show: !isDoctor },
    { key: "unread_digest", label: t.notifications.prefUnreadDigest, show: !isDoctor },
    { key: "day_end", label: t.notifications.prefDayEnd, show: !isDoctor },
  ];

  const unread = items?.filter((n) => !n.read_at).length ?? 0;

  return (
    <>
      <PageHeader
        title={t.notifications.title}
        action={
          <div className="flex items-center gap-2">
            <PushManager compact />
            {unread > 0 && (
              <Button variant="outline" size="sm" onClick={markAll}>
                <CheckCheck className="h-4 w-4" />
                {t.notifications.markAllRead}
              </Button>
            )}
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
        <Card>
          {items === null ? (
            <Spinner />
          ) : items.length === 0 ? (
            <div className="p-5">
              <EmptyState
                icon={<BellRing />}
                title={t.notifications.empty}
                body={t.notifications.emptyBody}
              />
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {items.map((n) => {
                const inner = (
                  <div
                    className={`flex items-start gap-3 px-5 py-3.5 transition-colors ${
                      n.read_at ? "" : "bg-brand-50/40"
                    } ${n.url ? "hover:bg-sunken" : ""}`}
                  >
                    {!n.read_at && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand-600" />}
                    <div className={`min-w-0 flex-1 ${n.read_at ? "ps-5" : ""}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{n.title}</span>
                        <Badge status={n.kind.startsWith("whatsapp") || n.kind === "ai_escalation" ? "pending" : "brand"}>
                          {(t.notifications.kinds as Record<string, string>)[n.kind] ?? n.kind}
                        </Badge>
                      </div>
                      {/*
                        `whitespace-pre-line` because some bodies are a short
                        list rather than a sentence — a booking's intake answers
                        are one per line, and collapsing them ran the labels and
                        values together into something unreadable.
                      */}
                      {n.body && (
                        <p className="mt-0.5 whitespace-pre-line text-[13px] text-ink-500">{n.body}</p>
                      )}
                      <div className="mt-0.5 text-[12px] text-ink-400" suppressHydrationWarning>
                        {fmtDateTime(n.created_at, tz, locale)}
                      </div>
                    </div>
                  </div>
                );
                return (
                  <li key={n.id} onClick={() => !n.read_at && markOne(n.id)}>
                    {n.url ? <Link href={n.url}>{inner}</Link> : inner}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <div className="grid content-start gap-4">
          <Card>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  <Smartphone className="h-4 w-4 text-ink-400" />
                  {t.notifications.installPrompt}
                </span>
              }
              sub={t.notifications.installHint}
            />
            {/*
              The card has always been headed "install this on your phone" and
              then offered only the notifications switch. The install control
              now sits where the copy already promised it — and removes itself
              once there is nothing left to install.
            */}
            <div className="grid justify-items-start gap-3 px-5 py-4">
              <InstallApp presentation="button" />
              <PushManager />
            </div>
          </Card>

          <Card>
            <CardHeader title={t.notifications.preferences} />
            <ul className="grid gap-1 px-5 py-4">
              {prefRows
                .filter((r) => r.show)
                .map((r) => (
                  <li key={r.key} className="flex items-center justify-between gap-3 py-1.5">
                    <span className="text-[13px]">{r.label}</span>
                    <Toggle
                      checked={prefs[r.key] !== false}
                      onChange={(v) => savePrefs({ ...prefs, [r.key]: v })}
                      label={r.label}
                    />
                  </li>
                ))}
            </ul>
            {isDoctor && (
              <div className="border-t border-line px-5 py-4">
                <label className="mb-1.5 block text-[13px] font-medium text-ink-700">
                  {t.notifications.reminderMinutes}
                </label>
                <NumberInput
                  dir="ltr"
                  min={0}
                  max={1440}
                  value={reminder}
                  onChange={(v) => setReminder(v)}
                  onBlur={() => savePrefs(prefs, reminder)}
                />
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
