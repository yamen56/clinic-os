"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/client";
import { useRealtimeRefresh } from "@/lib/use-realtime";
import { fmtDateTime } from "@/lib/dates";
import { PageHeader, Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { NumberInput, Select, Toggle } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Spinner, Tabs } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { PushManager } from "@/components/push-manager";
import { InstallApp } from "@/components/pwa";
import { IN_APP_PREFS_EVENT, type InAppPrefs } from "@/components/live-notifications";
import type { NotificationLevel, PrefGroup, PrefKey, QuietHours } from "@/lib/notification-kinds";
import { saveNotificationPrefsAction } from "./actions";
import { BellRing, CheckCheck, ChevronRight, Moon, Send, Smartphone } from "lucide-react";

type Notif = {
  id: string;
  kind: string;
  title: string;
  body: string;
  url: string | null;
  read_at: string | null;
  created_at: string;
  clinic_name: string | null;
  /** created_at at the database's precision, for paging. */
  cursor: string;
};

type Row = { key: PrefKey; group: PrefGroup; lockOff: boolean };

const GROUPS: PrefGroup[] = ["schedule", "summaries", "patients", "clinic"];

/** Half-hour steps are what people mean by a time to go quiet. */
const TIMES = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);

export function NotificationsClient({
  slug,
  tz,
  initialTab,
  rows,
  levels: initialLevels,
  quiet: initialQuiet,
  inApp: initialInApp,
  language: initialLanguage,
  showReminder,
  reminderMinutes: initialReminder,
  canManageAlerts,
}: {
  slug: string;
  tz: string;
  initialTab: "inbox" | "settings";
  rows: Row[];
  levels: Record<PrefKey, NotificationLevel>;
  quiet: QuietHours;
  inApp: InAppPrefs;
  language: "ar" | "en";
  showReminder: boolean;
  reminderMinutes: number;
  canManageAlerts: boolean;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState(initialTab);
  const [unread, setUnread] = useState<number | null>(null);

  const changeTab = (k: string) => {
    const next = k === "settings" ? "settings" : "inbox";
    setTab(next);
    // In the address too, so a refresh or a shared link lands on the same tab.
    window.history.replaceState(null, "", next === "settings" ? "?tab=settings" : window.location.pathname);
  };

  return (
    <>
      <PageHeader title={t.notifications.title} action={<PushManager compact />} />
      <div className="mb-4">
        <Tabs
          tabs={[
            { key: "inbox", label: t.notifications.tabInbox, count: unread ?? undefined },
            { key: "settings", label: t.notifications.tabSettings },
          ]}
          active={tab}
          onChange={changeTab}
        />
      </div>
      {/* Both stay mounted, so the inbox keeps its place and its live updates
          while somebody looks at the settings and comes back. */}
      <div hidden={tab !== "inbox"}>
        <Inbox slug={slug} tz={tz} onUnread={setUnread} />
      </div>
      <div hidden={tab !== "settings"}>
        <Settings
          slug={slug}
          rows={rows}
          initialLevels={initialLevels}
          initialQuiet={initialQuiet}
          initialInApp={initialInApp}
          initialLanguage={initialLanguage}
          showReminder={showReminder}
          initialReminder={initialReminder}
          canManageAlerts={canManageAlerts}
        />
      </div>
    </>
  );
}

function Inbox({ slug, tz, onUnread }: { slug: string; tz: string; onUnread: (n: number) => void }) {
  const { t, locale } = useI18n();
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [items, setItems] = useState<Notif[] | null>(null);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [unread, setUnread] = useState(0);

  useEffect(() => onUnread(unread), [unread, onUnread]);

  const query = useCallback(
    async (before?: string) => {
      const qs = new URLSearchParams();
      if (filter === "unread") qs.set("unread", "1");
      if (before) qs.set("before", before);
      const res = await fetch(`/api/me/notifications?${qs}`, { cache: "no-store" });
      if (!res.ok) return null;
      return (await res.json()) as { notifications: Notif[]; more: boolean; unread: number };
    },
    [filter]
  );

  /*
    The first page, merged into what is already loaded rather than replacing it:
    somebody who has scrolled back through "Show older" should not be thrown to
    the top every time a new one arrives.
  */
  const loaded = useRef(false);
  const load = useCallback(async () => {
    const data = await query();
    if (!data) return;
    setUnread(data.unread);
    if (!loaded.current) {
      loaded.current = true;
      setMore(data.more);
      setItems(data.notifications);
      return;
    }
    setItems((cur) => {
      if (!cur) return data.notifications;
      const fresh = new Map(data.notifications.map((n) => [n.id, n]));
      const older = cur.filter((n) => !fresh.has(n.id));
      // Nothing unread anywhere: whatever is loaded further down was read too.
      const settled = data.unread === 0 ? older.map((n) => ({ ...n, read_at: n.read_at ?? "read" })) : older;
      return [...data.notifications, ...settled.filter((n) => filter === "all" || !n.read_at)];
    });
  }, [query, filter]);

  useEffect(() => {
    loaded.current = false;
    setItems(null);
    void load();
    // `load` changes with the filter, which is exactly when to start over.
  }, [load]);

  useRealtimeRefresh(slug, ["notifications"], load);

  const loadMore = async () => {
    if (!items?.length) return;
    setLoadingMore(true);
    const data = await query(items[items.length - 1].cursor);
    setLoadingMore(false);
    if (!data) return;
    setMore(data.more);
    setItems((cur) => [...(cur ?? []), ...data.notifications.filter((n) => !cur?.some((x) => x.id === n.id))]);
  };

  const markAll = async () => {
    setItems((xs) => xs?.map((x) => ({ ...x, read_at: x.read_at ?? new Date().toISOString() })) ?? null);
    setUnread(0);
    await fetch("/api/me/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
  };

  const markOne = (id: string) => {
    setItems((xs) => xs?.map((x) => (x.id === id ? { ...x, read_at: new Date().toISOString() } : x)) ?? null);
    setUnread((n) => Math.max(0, n - 1));
    void fetch("/api/me/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
  };

  const chip = (key: "all" | "unread", label: string) => (
    <button
      type="button"
      onClick={() => setFilter(key)}
      aria-pressed={filter === key}
      className={`rounded-full border px-3 py-1 text-[13px] font-medium transition-colors duration-140 ${
        filter === key
          ? "border-brand-600 bg-brand-100 text-brand-700"
          : "border-line bg-surface text-ink-700 hover:border-line-strong"
      }`}
    >
      {label}
    </button>
  );

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
        <div className="flex gap-2">
          {chip("all", t.notifications.filterAll)}
          {chip("unread", t.notifications.filterUnread)}
        </div>
        {unread > 0 && (
          <Button variant="outline" size="sm" onClick={markAll}>
            <CheckCheck className="h-4 w-4" />
            {t.notifications.markAllRead}
          </Button>
        )}
      </div>
      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <div className="p-5">
          <EmptyState
            icon={<BellRing />}
            title={filter === "unread" ? t.notifications.caughtUp : t.notifications.empty}
            body={filter === "unread" ? t.notifications.caughtUpBody : t.notifications.emptyBody}
          />
        </div>
      ) : (
        <>
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
                      <Badge
                        status={
                          n.kind.startsWith("whatsapp") || n.kind === "ai_escalation" || n.kind === "document_integrity"
                            ? "pending"
                            : "brand"
                        }
                      >
                        {(t.notifications.kinds as Record<string, string>)[n.kind] ?? t.notifications.title}
                      </Badge>
                    </div>
                    {/*
                      `whitespace-pre-line` because some bodies are a short
                      list rather than a sentence — a booking's intake answers
                      are one per line, and collapsing them ran the labels and
                      values together into something unreadable.
                    */}
                    {n.body && <p className="mt-0.5 whitespace-pre-line text-[13px] text-ink-500">{n.body}</p>}
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
          {more && (
            <div className="border-t border-line px-5 py-3 text-center">
              <Button variant="ghost" size="sm" loading={loadingMore} onClick={loadMore}>
                {t.notifications.loadMore}
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function Settings({
  slug,
  rows,
  initialLevels,
  initialQuiet,
  initialInApp,
  initialLanguage,
  showReminder,
  initialReminder,
  canManageAlerts,
}: {
  slug: string;
  rows: Row[];
  initialLevels: Record<PrefKey, NotificationLevel>;
  initialQuiet: QuietHours;
  initialInApp: InAppPrefs;
  initialLanguage: "ar" | "en";
  showReminder: boolean;
  initialReminder: number;
  canManageAlerts: boolean;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [, start] = useTransition();
  /*
    Every control holds its own value and moves on the press; the save follows.
    Each one sends only itself, so two tabs changing different switches cannot
    overwrite each other with stale copies.
  */
  const [levels, setLevels] = useState(initialLevels);
  const [quiet, setQuiet] = useState(initialQuiet);
  const [inApp, setInApp] = useState(initialInApp);
  const [language, setLanguage] = useState(initialLanguage);
  const [reminder, setReminder] = useState(initialReminder);
  const [testing, setTesting] = useState(false);

  const save = (patch: Record<string, unknown>) =>
    start(async () => {
      const r = await saveNotificationPrefsAction(slug, patch);
      if (r.error) toast(t.common.genericError, "error");
    });

  const setLevel = (key: PrefKey, level: NotificationLevel) => {
    setLevels((cur) => ({ ...cur, [key]: level }));
    save({ levels: { [key]: level } });
  };

  const setQuietAnd = (next: QuietHours) => {
    setQuiet(next);
    save({ quiet: next });
  };

  const setInAppAnd = (patch: Partial<InAppPrefs>) => {
    setInApp((cur) => ({ ...cur, ...patch }));
    // The header's pop-ups follow at once, without a reload.
    window.dispatchEvent(new CustomEvent(IN_APP_PREFS_EVENT, { detail: patch }));
    save(patch);
  };

  const sendTest = async () => {
    setTesting(true);
    const res = await fetch("/api/me/notifications/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    }).catch(() => null);
    setTesting(false);
    if (res?.ok) toast(t.notifications.testSent, "info");
    else toast(t.common.genericError, "error");
  };

  const levelSelect = (r: Row) => (
    <Select
      value={levels[r.key]}
      onChange={(e) => setLevel(r.key, e.target.value as NotificationLevel)}
      aria-label={t.notifications.prefs[r.key].label}
      className="!h-9 !w-auto shrink-0"
    >
      <option value="push">{t.notifications.levels.push}</option>
      <option value="app">{t.notifications.levels.app}</option>
      {!r.lockOff && <option value="off">{t.notifications.levels.off}</option>}
    </Select>
  );

  const switchRow = (
    label: string,
    hint: string,
    checked: boolean,
    onChange: (v: boolean) => void,
    disabled?: boolean
  ) => (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-ink-900">{label}</div>
        <div className="text-[12px] text-ink-500">{hint}</div>
      </div>
      <Toggle checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </div>
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <Card>
        <CardHeader title={t.notifications.preferences} sub={t.notifications.preferencesHint} />
        {rows.length === 0 ? (
          <p className="px-5 py-4 text-[13px] text-ink-500">{t.notifications.nothingForYou}</p>
        ) : (
          GROUPS.map((g) => {
            const inGroup = rows.filter((r) => r.group === g);
            if (!inGroup.length) return null;
            return (
              <section key={g} className="border-b border-line px-5 py-3 last:border-b-0">
                <h4 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-ink-400">
                  {t.notifications.groups[g]}
                </h4>
                <ul className="divide-y divide-line/60">
                  {inGroup.map((r) => (
                    <li key={r.key} className="flex items-center justify-between gap-3 py-2.5" data-pref={r.key}>
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-ink-900">
                          {t.notifications.prefs[r.key].label}
                        </div>
                        <div className="text-[12px] text-ink-500">
                          {r.lockOff ? t.notifications.cantTurnOff : t.notifications.prefs[r.key].hint}
                        </div>
                      </div>
                      {levelSelect(r)}
                    </li>
                  ))}
                  {g === "schedule" && showReminder && (
                    <li className="flex items-center justify-between gap-3 py-2.5">
                      <label className="min-w-0 text-[13px] font-medium text-ink-900" htmlFor="reminder-minutes">
                        {t.notifications.reminderMinutes}
                      </label>
                      <NumberInput
                        id="reminder-minutes"
                        dir="ltr"
                        min={0}
                        max={1440}
                        value={reminder}
                        onChange={(v) => setReminder(v)}
                        onBlur={() => save({ reminderMinutes: Math.max(0, Math.min(1440, reminder)) })}
                        className="!h-9 !w-24 shrink-0"
                      />
                    </li>
                  )}
                </ul>
              </section>
            );
          })
        )}
        {canManageAlerts && (
          <Link
            href={`/c/${slug}/automations?tab=alerts`}
            className="flex items-center justify-between gap-3 border-t border-line px-5 py-3.5 transition-colors hover:bg-sunken"
          >
            <span className="min-w-0">
              <span className="block text-[13px] font-semibold text-brand-700">{t.notifications.teamAlerts}</span>
              <span className="block text-[12px] text-ink-500">{t.notifications.teamAlertsHint}</span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-ink-300 rtl:rotate-180" />
          </Link>
        )}
      </Card>

      <div className="grid content-start gap-4">
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <Smartphone className="h-4 w-4 text-ink-400" />
                {t.notifications.thisDevice}
              </span>
            }
            sub={t.notifications.thisDeviceHint}
          />
          {/*
            Install, turn on, and prove it works — in that order, in one place.
            The install control removes itself once there is nothing to install.
          */}
          <div className="grid justify-items-start gap-3 px-5 py-4">
            <InstallApp presentation="button" />
            <PushManager />
            <Button variant="outline" size="sm" loading={testing} onClick={sendTest}>
              <Send className="h-4 w-4" />
              {t.notifications.sendTest}
            </Button>
          </div>
        </Card>

        <Card>
          <CardHeader title={t.notifications.inApp} />
          <div className="px-5 py-2">
            {switchRow(t.notifications.popups, t.notifications.popupsHint, inApp.popups, (v) =>
              setInAppAnd({ popups: v })
            )}
            {switchRow(
              t.notifications.sound,
              t.notifications.soundHint,
              inApp.sound && inApp.popups,
              (v) => setInAppAnd({ sound: v }),
              !inApp.popups
            )}
          </div>
          <div className="border-t border-line px-5 py-3">
            <label className="flex items-center justify-between gap-3">
              <span className="text-[13px] font-medium text-ink-900">{t.notifications.language}</span>
              <Select
                value={language}
                onChange={(e) => {
                  const v = e.target.value === "en" ? "en" : "ar";
                  setLanguage(v);
                  save({ language: v });
                }}
                className="!h-9 !w-auto"
              >
                <option value="ar">العربية</option>
                <option value="en">English</option>
              </Select>
            </label>
          </div>
        </Card>

        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <Moon className="h-4 w-4 text-ink-400" />
                {t.notifications.quietHours}
              </span>
            }
            sub={t.notifications.quietHoursHint}
          />
          <div className="px-5 py-2">
            {switchRow(t.notifications.quietOn, `${quiet.from} – ${quiet.to}`, quiet.on, (v) =>
              setQuietAnd({ ...quiet, on: v })
            )}
            {quiet.on && (
              <>
                <div className="grid grid-cols-2 gap-3 py-2">
                  <label className="block">
                    <span className="mb-1 block text-[12px] font-semibold text-ink-700">{t.notifications.quietFrom}</span>
                    <Select
                      dir="ltr"
                      value={quiet.from}
                      onChange={(e) => setQuietAnd({ ...quiet, from: e.target.value })}
                      className="!h-9"
                    >
                      {TIMES.map((x) => (
                        <option key={x} value={x}>
                          {x}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[12px] font-semibold text-ink-700">{t.notifications.quietTo}</span>
                    <Select
                      dir="ltr"
                      value={quiet.to}
                      onChange={(e) => setQuietAnd({ ...quiet, to: e.target.value })}
                      className="!h-9"
                    >
                      {TIMES.map((x) => (
                        <option key={x} value={x}>
                          {x}
                        </option>
                      ))}
                    </Select>
                  </label>
                </div>
                {switchRow(t.notifications.quietUrgent, t.notifications.quietUrgentHint, quiet.urgent, (v) =>
                  setQuietAnd({ ...quiet, urgent: v })
                )}
              </>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
