"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { LanguageToggle } from "@/components/language-toggle";
import { InstallApp } from "@/components/pwa";
import { logoutAction } from "@/app/login/actions";
import { exitImpersonationAction } from "@/app/admin/actions";
import { Avatar } from "@/components/ui/misc";
import { clinicLogoUrl } from "@/lib/clinic-logo";
import { FINANCE_PREFIXES, firstFinanceHref } from "@/lib/finance";
import { BrandLockup } from "@/components/brand-mark";
import { NotificationPopups, useLiveNotifications, type InAppPrefs } from "@/components/live-notifications";
import type { CapabilityMap, MemberRole } from "@/lib/permissions";
import {
  LayoutDashboard,
  MessageCircle,
  CalendarDays,
  Users,
  Megaphone,
  FileSignature,
  Workflow,
  Sparkles,
  Hourglass,
  Cable,
  Wallet,
  Settings,
  MoreHorizontal,
  Bell,
  PenTool,
  UserRound,
  ChevronRight,
  LogOut,
  ShieldAlert,
  X,
} from "lucide-react";

type NavKey =
  | "dashboard"
  | "conversations"
  | "calendar"
  | "waitlist"
  | "devices"
  /* Invoices, Earnings and Expenses, which are one subject and are now one
     entry with tabs inside it. See lib/finance. */
  | "finance"
  | "patients"
  | "campaigns"
  | "documents"
  | "automations"
  | "aiAgent"
  | "settings";

const icons: Record<NavKey, React.ComponentType<{ className?: string; strokeWidth?: number }>> = {
  dashboard: LayoutDashboard,
  conversations: MessageCircle,
  calendar: CalendarDays,
  waitlist: Hourglass,
  devices: Cable,
  finance: Wallet,
  patients: Users,
  campaigns: Megaphone,
  documents: FileSignature,
  automations: Workflow,
  aiAgent: Sparkles,
  settings: Settings,
};

/** A count as a badge shows it: three characters at most. */
const fmtCount = (n: number) => (n > 99 ? "99+" : String(n));

export function Shell({
  clinic,
  role,
  isOwner,
  caps,
  userName,
  userId,
  memberId,
  hasPhoto,
  isImpersonating,
  unreadCount,
  notifications,
  pendingDocuments,
  hasEarnings,
  hasInsurers,
  devices,
  fullControl,
  announcements,
  children,
}: {
  clinic: {
    id: string;
    name: string;
    nameAr: string | null;
    slug: string;
    brandColor: string;
    logoPath: string | null;
  };
  role: MemberRole;
  isOwner: boolean;
  caps: CapabilityMap;
  userName: string;
  userId: string;
  /** Null when a super admin is impersonating: no membership, so no photo. */
  memberId: string | null;
  hasPhoto: boolean;
  isImpersonating: boolean;
  unreadCount: number;
  /** This person's own unread notifications, and what they asked the app to do with new ones. */
  notifications: { unread: number; serverNow: string; prefs: InAppPrefs };
  pendingDocuments: number;
  /** This person has a share agreed, or money already earned under one. */
  hasEarnings: boolean;
  /** The clinic deals with at least one insurance company, so Claims is a tab. */
  hasInsurers: boolean;
  /** A machine is connected, and how many of its results wait to be filed. */
  devices: { connected: boolean; waiting: number };
  /** `hasFullControl(access)` — an owner, or somebody on `full` access. */
  fullControl: boolean;
  announcements: { id: string; title: string; body: string }[];
  children: React.ReactNode;
}) {
  const { t, locale } = useI18n();
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const [hiddenAnnouncements, setHiddenAnnouncements] = useState<string[]>([]);
  const live = useLiveNotifications(clinic.slug, notifications);

  const base = `/c/${clinic.slug}`;

  /*
    The nav is the capability set, rendered. Nothing here reads a job title —
    a doctor who has been granted the inbox sees the inbox, and a receptionist
    whose owner took invoices away does not see invoices.

    The dashboard used to be the exception, kept for everybody because it was
    where the guards sent anyone who reached a screen they were not allowed. It
    is a capability like the rest now; what replaced the exception is
    `landingPathIn`, which works out a destination from the access rather than
    assuming one. See lib/permissions.
  */
  /*
    Order is the clinic's, not ours. The first four also become the phone's
    bottom bar (see mobileMain below), so this sequence decides what a
    receptionist can reach with one thumb — which is why it is worth being
    literal about rather than tidy.
  */
  /*
    Where the money section sits, and it is not the same answer for everybody.

    One entry now covers Invoices, Payments, Earnings and Expenses, and it
    points at whichever of them this member can actually open — so the href is
    per-person and `isActive` cannot be derived from it (see below).

    Its *position* is per-person too, which looks fussy and is not. The first
    four visible items become the phone's bottom bar. For reception and whoever
    runs the clinic this is a daily screen and belongs in the thumb bar, where
    Invoices already was. For a doctor it is a monthly errand — checking what
    they earned — and the four that matter to them are Dashboard, Patients,
    Calendar, Documents. Merging three entries into one would have quietly
    pushed Documents out of a doctor's reach, which is the exact trade the two
    comments that used to live here were written to prevent.
  */
  const financeHome = firstFinanceHref(clinic.slug, {
    caps,
    hasEarnings,
    fullControl,
    hasInsurers,
  });
  const finance: { key: NavKey; href: string; show: boolean; badge?: number } = {
    key: "finance",
    href: financeHome ?? `${base}/invoices`,
    show: !!financeHome,
  };

  const items: { key: NavKey; href: string; show: boolean; badge?: number }[] = [
    { key: "dashboard", href: base, show: caps.dashboard },
    { key: "patients", href: `${base}/patients`, show: caps.patients },
    { key: "calendar", href: `${base}/calendar`, show: caps.calendar },
    ...(caps.invoices ? [finance] : []),
    { key: "documents", href: `${base}/documents`, show: caps.documents, badge: pendingDocuments },
    { key: "waitlist", href: `${base}/waitlist`, show: caps.calendar },
    /* Only once the clinic has a machine (or a result is still waiting from
       one it unplugged): a clinic with none sets one up in Settings → Devices
       and should not carry an empty page in its nav. The badge is the inbox. */
    { key: "devices", href: `${base}/devices`, show: caps.patients && (devices.connected || devices.waiting > 0), badge: devices.waiting },
    ...(caps.invoices ? [] : [finance]),
    { key: "conversations", href: `${base}/conversations`, show: caps.conversations, badge: unreadCount },
    { key: "campaigns", href: `${base}/campaigns`, show: caps.campaigns },
    { key: "automations", href: `${base}/automations`, show: caps.automations },
    { key: "aiAgent", href: `${base}/ai`, show: caps.ai },
    { key: "settings", href: `${base}/settings`, show: caps.settings },
  ];
  const visible = items.filter((i) => i.show);
  const mobileMain = visible.slice(0, 4);
  const mobileMore = visible.slice(4);
  /*
    Something folded into the sheet wants attention — an unread chat, a
    document out for signature. Without this a receptionist whose inbox sits
    fifth had no way to know a patient had written until she opened the sheet.
  */
  const moreHasBadge = mobileMore.some((i) => !!i.badge);

  /*
    Derived from the section, not from the link. Finance points wherever this
    member's first tab is, so a doctor whose entry points at Earnings is still
    inside the section when they are on Expenses — matching on their own href
    would leave the entry unlit on two of its own tabs.
  */
  const isActive = (item: { key: NavKey; href: string }) => {
    if (item.key === "finance") {
      return FINANCE_PREFIXES.some((p) => pathname.startsWith(`${base}${p}`));
    }
    return item.href === base ? pathname === base : pathname.startsWith(item.href);
  };

  // Navigating away closes the sheet. The links close it themselves, but the
  // back button and in-page redirects don't go through them, and a sheet left
  // sitting over the screen it just opened reads as a stuck app.
  useEffect(() => setMoreOpen(false), [pathname]);

  const clinicDisplay = locale === "ar" ? clinic.nameAr || clinic.name : clinic.name;
  const logoSrc = clinicLogoUrl(clinic.slug, clinic.logoPath);
  const photoSrc = hasPhoto && memberId ? `/api/c/${clinic.slug}/staff/${memberId}/photo` : null;
  const roleLabel = isOwner ? t.staff.owner : t.staff.roles[role];
  const bellLabel = live.unread ? `${t.nav.notifications} (${live.unread})` : t.nav.notifications;

  return (
    <div className="min-h-dvh bg-canvas">
      {/* Desktop sidebar — night surface, the one dark region of the app chrome */}
      <aside className="fixed inset-y-0 start-0 z-40 hidden w-[248px] flex-col border-e border-white/6 bg-night md:flex">
        <div className="flex h-[88px] items-center justify-center border-b border-white/6">
          <BrandLockup />
        </div>
        <div className="flex items-center gap-2.5 px-4 py-3.5">
          {/* Their own logo once one is uploaded. The initials stay underneath
              rather than being swapped out, so a logo that fails to load leaves
              a marked circle rather than a hole. */}
          <Avatar name={clinic.name} size={30} color={clinic.brandColor} src={logoSrc} fit="contain" />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold leading-tight text-white">
              {clinicDisplay}
            </div>
            <div className="text-[11px] text-white/40">Clinicti</div>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 py-2">
          {visible.map(({ key, href, badge }) => {
            const Icon = icons[key];
            const active = isActive({ key, href });
            return (
              <Link
                key={key}
                href={href}
                prefetch
                aria-current={active ? "page" : undefined}
                className={`relative mb-0.5 flex h-10 items-center gap-2.5 rounded-ctl px-3 text-sm font-medium transition-colors duration-140 ease-out ${
                  active
                    /*
                      White, not brand-600. The brand is the navy of the sidebar
                      itself now, so an indicator tinted with it would be a bar
                      the same colour as the panel behind it — the active item
                      would simply stop being marked.
                    */
                    ? "bg-white/10 text-white before:absolute before:inset-y-2 before:start-0 before:w-0.5 before:rounded-full before:bg-white before:content-['']"
                    : "text-white/62 hover:bg-white/5 hover:text-white"
                }`}
              >
                <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
                <span className="flex-1">{t.nav[key]}</span>
                {!!badge && (
                  <span className="rounded-full bg-white/12 px-1.5 py-0.5 text-[11px] font-semibold text-white tnum">
                    {fmtCount(badge)}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-white/6 p-3">
          {/*
            The name and role get this row to themselves. They used to share it
            with the three icon buttons below, which left about ninety pixels
            for both — an ordinary Arabic full name was clipped mid-word and the
            role under it with it, and this row is the only place in the desktop
            shell either one is written.
          */}
          <div className="flex items-center gap-2.5 px-1">
            <Avatar name={userName} size={30} color="rgb(255 255 255 / 0.14)" src={photoSrc} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-white">{userName}</div>
              <div className="truncate text-[11px] text-white/40">{roleLabel}</div>
            </div>
          </div>
          <div className="mt-2 space-y-1 px-1">
            <InstallApp onDark />
          </div>
          {/* The controls ride on the language row instead, where there is
              room for all four and nothing has to be truncated to fit. */}
          <div className="mt-2 flex items-center gap-1 px-1">
            <LanguageToggle onDark />
            <div className="ms-auto flex items-center gap-0.5">
              {/* Reachable for doctors too, who never see /settings. */}
              <Link
                href={`${base}/profile`}
                className="rounded-ctl p-1.5 text-white/50 transition-colors hover:bg-white/5 hover:text-white"
                aria-label={t.profile.title}
                title={t.profile.title}
              >
                <UserRound className="h-4.5 w-4.5" strokeWidth={1.75} />
              </Link>
              <Link
                href={`${base}/notifications`}
                className={`relative rounded-ctl p-1.5 transition-colors hover:bg-white/5 hover:text-white ${
                  live.unread ? "text-white" : "text-white/50"
                }`}
                aria-label={bellLabel}
                title={t.nav.notifications}
                data-unread={live.unread}
              >
                <Bell className="h-4.5 w-4.5" strokeWidth={1.75} />
                {live.unread > 0 && (
                  <span className="absolute -end-1 -top-1 min-w-4 rounded-full bg-danger px-1 text-center text-[10px] font-semibold leading-4 text-white tnum">
                    {fmtCount(live.unread)}
                  </span>
                )}
              </Link>
              <form action={logoutAction}>
                <button
                  className="rounded-ctl p-1.5 text-white/50 transition-colors hover:bg-white/5 hover:text-white"
                  aria-label={t.auth.signOut}
                  title={t.auth.signOut}
                >
                  <LogOut className="h-4.5 w-4.5" strokeWidth={1.75} />
                </button>
              </form>
            </div>
          </div>
        </div>
      </aside>

      <div className="md:ms-[248px]">
        {/*
          The top of the screen: on a phone the app bar, on every size the
          impersonation warning.

          One sticky block rather than two sticky siblings — both pinned to the
          top, the second slid under the first as soon as the page scrolled.

          The status-bar inset lives here too. It is zero in a browser tab and
          only becomes real once the app is installed to a home screen, where
          the page runs behind the status bar and the first line of every
          screen would otherwise sit under the clock.
        */}
        <div className="sticky top-0 z-30 pt-[env(safe-area-inset-top)] max-md:bg-surface/90 max-md:backdrop-blur-md md:pt-0">
          {isImpersonating && (
            <div className="flex items-center justify-center gap-2 bg-danger px-4 py-2 text-center text-[13px] font-medium text-white">
              <ShieldAlert className="h-4 w-4 shrink-0" />
              {t.admin.impersonating}
              <form action={exitImpersonationAction}>
                <button className="underline underline-offset-2 hover:opacity-80">
                  {t.admin.exitImpersonation}
                </button>
              </form>
            </div>
          )}
          {/*
            The phone had no top bar at all: the screen opened on the page
            title, with nothing saying which clinic this was, and the bell lived
            inside the More sheet — an unread notification was a red dot on a
            button labelled "More". The clinic, the bell and the account are the
            three things every screen needs, so they get the one strip that is
            always there.

            A <header>, not a <nav>: the bottom bar is the phone's navigation,
            and the suites that measure it find it as `nav.fixed`.
          */}
          <header className="flex h-14 items-center gap-1 border-b border-line px-4 md:hidden">
            <Link
              href={visible[0]?.href ?? `${base}/profile`}
              className="me-auto flex min-w-0 touch-manipulation items-center gap-2.5"
            >
              <Avatar name={clinic.name} size={32} color={clinic.brandColor} src={logoSrc} fit="contain" />
              <span className="font-display truncate text-[15px] font-bold text-ink-900">
                {clinicDisplay}
              </span>
            </Link>
            <Link
              href={`${base}/notifications`}
              aria-label={bellLabel}
              className={`relative grid h-10 w-10 shrink-0 touch-manipulation place-items-center rounded-full transition-colors duration-140 ease-out active:bg-sunken ${
                live.unread ? "text-ink-900" : "text-ink-500"
              }`}
            >
              <Bell className="h-5 w-5" strokeWidth={1.75} />
              {live.unread > 0 && (
                <span className="absolute end-0.5 top-0.5 min-w-[18px] rounded-full bg-danger px-1 text-center text-[10px] font-semibold leading-[18px] text-white ring-2 ring-surface tnum">
                  {fmtCount(live.unread)}
                </span>
              )}
            </Link>
            <Link
              href={`${base}/profile`}
              aria-label={t.profile.title}
              className="grid h-10 w-10 shrink-0 touch-manipulation place-items-center rounded-full"
            >
              <Avatar name={userName} size={30} src={photoSrc} />
            </Link>
          </header>
        </div>
        {announcements
          .filter((a) => !hiddenAnnouncements.includes(a.id))
          .map((a) => (
            <div
              key={a.id}
              className="flex items-start gap-3 border-b border-brand-100 bg-brand-50 px-4 py-2.5 text-[13px] text-ink-900 md:px-8"
            >
              <Megaphone className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" strokeWidth={1.75} />
              <div className="min-w-0 flex-1">
                <span className="font-semibold">{a.title}</span>
                {a.body && <span className="ms-2 text-ink-700">{a.body}</span>}
              </div>
              <button
                onClick={() => {
                  setHiddenAnnouncements((xs) => [...xs, a.id]);
                  fetch("/api/me/dismiss-announcement", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ id: a.id }),
                  }).catch(() => {});
                }}
                aria-label={t.common.close}
                className="-m-1 shrink-0 rounded-full p-1 text-ink-500 transition-colors hover:bg-brand-100 hover:text-ink-900"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        <main className="mx-auto max-w-6xl px-4 pb-24 pt-4 md:px-8 md:pb-10 md:pt-6">{children}</main>
      </div>

      <NotificationPopups items={live.popups} onDismiss={live.dismiss} />

      {/* Mobile bottom nav */}
      {moreOpen && (
        <button
          type="button"
          aria-label={t.common.close}
          onClick={() => setMoreOpen(false)}
          className="fixed inset-0 z-30 bg-night/25 animate-fade-in md:hidden"
        />
      )}
      <nav className="fixed inset-x-0 bottom-0 z-40 md:hidden">
        {/*
          The sheet is rendered before the tab row deliberately. The bar is
          anchored to the bottom edge, so markup placed after the tabs grows
          downward off-screen and shunts the tabs up as it opens; placed before
          them it rises above the bar, which is where a menu opened from the
          bottom of the screen is expected to come from.

          The sections are tiles, four to a row, rather than a list. As a list
          the owner's sheet was taller than an ordinary handset could show and
          its last row — language and sign-out — sat half-cut against the tab
          bar. The scroll stays for the short phones where it genuinely cannot
          fit.
        */}
        {moreOpen && (
          <div className="max-h-[72dvh] overflow-y-auto rounded-t-[22px] border-t border-line bg-surface px-3 pb-2 pt-2 shadow-modal animate-fade-up">
            <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-ink-300" aria-hidden />
            {mobileMore.length > 0 && (
              <div className="mb-2 grid grid-cols-3 gap-1 min-[360px]:grid-cols-4">
                {mobileMore.map(({ key, href, badge }) => {
                  const Icon = icons[key];
                  const active = isActive({ key, href });
                  return (
                    <Link
                      key={key}
                      href={href}
                      onClick={() => setMoreOpen(false)}
                      aria-current={active ? "page" : undefined}
                      className="flex min-w-0 touch-manipulation flex-col items-center gap-1.5 rounded-xl px-1 py-2 text-center text-[11.5px] font-medium leading-tight text-ink-700 transition-colors duration-140 ease-out hover:bg-sunken active:bg-sunken"
                    >
                      <span
                        className={`relative grid h-11 w-11 place-items-center rounded-2xl ${
                          active ? "bg-brand-100 text-brand-700" : "bg-sunken text-ink-700"
                        }`}
                      >
                        <Icon className="h-5 w-5" strokeWidth={1.75} />
                        {!!badge && (
                          <span className="absolute -end-1.5 -top-1.5 min-w-[18px] rounded-full bg-brand-600 px-1 text-center text-[10px] font-semibold leading-[18px] text-white ring-2 ring-surface tnum">
                            {fmtCount(badge)}
                          </span>
                        )}
                      </span>
                      <span className="line-clamp-2 max-w-full [overflow-wrap:anywhere]">{t.nav[key]}</span>
                    </Link>
                  );
                })}
              </div>
            )}
            {/* The account, first and unmistakable among the rows: the top bar's
                avatar opens the same page, but here it is spelled out. */}
            <Link
              href={`${base}/profile`}
              onClick={() => setMoreOpen(false)}
              className="mb-1 flex touch-manipulation items-center gap-3 rounded-xl border border-line px-3 py-2.5 transition-colors duration-140 ease-out hover:bg-sunken active:bg-sunken"
            >
              <Avatar name={userName} size={34} src={photoSrc} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{userName}</span>
                <span className="block text-[12px] text-ink-500">{roleLabel}</span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-ink-300 rtl:rotate-180" />
            </Link>
            <Link
              href={`${base}/signature`}
              onClick={() => setMoreOpen(false)}
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-ink-700 transition-colors duration-140 ease-out hover:bg-sunken active:bg-sunken"
            >
              <PenTool className="h-[18px] w-[18px] shrink-0 text-ink-400" />
              {t.mySignature.title}
            </Link>
            <InstallApp />
            <div className="mt-1 flex items-center justify-between border-t border-line px-3 pt-3 pb-1">
              <LanguageToggle />
              <form action={logoutAction}>
                <button className="flex touch-manipulation items-center gap-2 py-1.5 text-sm text-ink-500">
                  <LogOut className="h-4 w-4" /> {t.auth.signOut}
                </button>
              </form>
            </div>
          </div>
        )}
        {/*
          The horizontal insets matter in landscape on a notched phone, where the
          cutout eats into the row and would otherwise sit on top of the first
          tab. They are physical (`pl`/`pr`), not logical: the notch is on the
          same side of the handset whichever way the text runs.

          The active tab is a filled pill behind its icon, not only a change of
          ink: grey on a slightly darker grey was the whole difference before,
          and in sunlight at a front desk the two were the same colour.
        */}
        <div className="grid auto-cols-fr grid-flow-col border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] backdrop-blur">
          {mobileMain.map(({ key, href, badge }) => {
            const Icon = icons[key];
            const active = isActive({ key, href });
            return (
              <Link
                key={key}
                href={href}
                aria-current={active ? "page" : undefined}
                className={`flex min-w-0 touch-manipulation flex-col items-center gap-0.5 pb-1.5 pt-2 text-[11px] transition-colors duration-140 ease-out ${
                  active ? "font-semibold text-ink-900" : "font-medium text-ink-500"
                }`}
              >
                <span
                  className={`relative grid h-7 w-14 place-items-center rounded-full transition-colors duration-140 ease-out ${
                    active ? "bg-brand-100 text-brand-700" : ""
                  }`}
                >
                  <Icon className="h-5 w-5" strokeWidth={active ? 2 : 1.75} />
                  {!!badge && (
                    <span className="absolute -top-0.5 start-[calc(50%+0.375rem)] min-w-4 rounded-full bg-brand-600 px-1 text-center text-[10px] font-semibold leading-4 text-white ring-2 ring-surface tnum">
                      {fmtCount(badge)}
                    </span>
                  )}
                </span>
                <span className="max-w-full truncate px-1">{t.nav[key]}</span>
              </Link>
            );
          })}
          {/*
            Always rendered, never conditional on the overflow being non-empty.
            The sheet is not only the nav's spill-over — it is the account, the
            signature, the language and the sign-out button, and on a phone it
            is the only route to most of them. Gating it on `mobileMore.length`
            meant a member with exactly four sections could not sign out, which
            was reachable before and is ordinary now that the dashboard can be
            taken away.
          */}
          <button
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
            className={`flex min-w-0 touch-manipulation flex-col items-center gap-0.5 pb-1.5 pt-2 text-[11px] transition-colors duration-140 ease-out ${
              moreOpen ? "font-semibold text-ink-900" : "font-medium text-ink-500"
            }`}
          >
            <span
              className={`relative grid h-7 w-14 place-items-center rounded-full transition-colors duration-140 ease-out ${
                moreOpen ? "bg-brand-100 text-brand-700" : ""
              }`}
            >
              <MoreHorizontal className="h-5 w-5" />
              {moreHasBadge && !moreOpen && (
                <span className="absolute top-0.5 start-[calc(50%+0.375rem)] h-2 w-2 rounded-full bg-brand-600 ring-2 ring-surface" />
              )}
            </span>
            <span className="max-w-full truncate px-1">{t.nav.more}</span>
          </button>
        </div>
      </nav>
    </div>
  );
}
