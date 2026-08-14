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
import { BrandLockup } from "@/components/brand-mark";
import type { CapabilityMap, MemberRole } from "@/lib/permissions";
import {
  LayoutDashboard,
  MessageCircle,
  CalendarDays,
  Users,
  Megaphone,
  Receipt,
  FileSignature,
  Workflow,
  Sparkles,
  Hourglass,
  Settings,
  MoreHorizontal,
  Bell,
  PenTool,
  UserRound,
  ChevronLeft,
  LogOut,
  ShieldAlert,
  X,
} from "lucide-react";

type NavKey =
  | "dashboard"
  | "conversations"
  | "calendar"
  | "waitlist"
  | "patients"
  | "campaigns"
  | "documents"
  | "invoices"
  | "automations"
  | "aiAgent"
  | "settings";

const icons: Record<NavKey, React.ComponentType<{ className?: string; strokeWidth?: number }>> = {
  dashboard: LayoutDashboard,
  conversations: MessageCircle,
  calendar: CalendarDays,
  waitlist: Hourglass,
  patients: Users,
  campaigns: Megaphone,
  documents: FileSignature,
  invoices: Receipt,
  automations: Workflow,
  aiAgent: Sparkles,
  settings: Settings,
};

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
  pendingDocuments,
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
  pendingDocuments: number;
  announcements: { id: string; title: string; body: string }[];
  children: React.ReactNode;
}) {
  const { t, locale } = useI18n();
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const [hiddenAnnouncements, setHiddenAnnouncements] = useState<string[]>([]);

  const base = `/c/${clinic.slug}`;

  /*
    The nav is the capability set, rendered. Nothing here reads a job title —
    a doctor who has been granted the inbox sees the inbox, and a receptionist
    whose owner took invoices away does not see invoices. The dashboard is the
    one entry everybody keeps: it is where the guards send anyone who reaches a
    screen they are not allowed, so it can never be hidden.
  */
  /*
    Order is the clinic's, not ours. The first four also become the phone's
    bottom bar (see mobileMain below), so this sequence decides what a
    receptionist can reach with one thumb — which is why it is worth being
    literal about rather than tidy.
  */
  const items: { key: NavKey; href: string; show: boolean; badge?: number }[] = [
    { key: "dashboard", href: base, show: true },
    { key: "patients", href: `${base}/patients`, show: caps.patients },
    { key: "calendar", href: `${base}/calendar`, show: caps.calendar },
    { key: "invoices", href: `${base}/invoices`, show: caps.invoices },
    { key: "documents", href: `${base}/documents`, show: caps.documents, badge: pendingDocuments },
    { key: "waitlist", href: `${base}/waitlist`, show: caps.calendar },
    { key: "conversations", href: `${base}/conversations`, show: caps.conversations, badge: unreadCount },
    { key: "campaigns", href: `${base}/campaigns`, show: caps.campaigns },
    { key: "automations", href: `${base}/automations`, show: caps.automations },
    { key: "aiAgent", href: `${base}/ai`, show: caps.ai },
    { key: "settings", href: `${base}/settings`, show: caps.settings },
  ];
  const visible = items.filter((i) => i.show);
  const mobileMain = visible.slice(0, 4);
  const mobileMore = visible.slice(4);

  const isActive = (href: string) =>
    href === base ? pathname === base : pathname.startsWith(href);

  // Navigating away closes the sheet. The links close it themselves, but the
  // back button and in-page redirects don't go through them, and a sheet left
  // sitting over the screen it just opened reads as a stuck app.
  useEffect(() => setMoreOpen(false), [pathname]);

  const clinicDisplay = locale === "ar" ? clinic.nameAr || clinic.name : clinic.name;

  return (
    <div className="min-h-dvh bg-paper">
      {/* Desktop sidebar — night surface, the one dark region of the app chrome */}
      <aside className="fixed inset-y-0 start-0 z-40 hidden w-[248px] flex-col border-e border-white/6 bg-night md:flex">
        <div className="flex h-[88px] items-center justify-center border-b border-white/6">
          <BrandLockup />
        </div>
        <div className="flex items-center gap-2.5 px-4 py-3.5">
          <Avatar name={clinic.name} size={30} color={clinic.brandColor} />
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
            const active = isActive(href);
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
                    {badge > 99 ? "99+" : badge}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-white/6 p-3">
          <div className="flex items-center gap-2.5 px-1">
            <Avatar
              name={userName}
              size={30}
              color="rgb(255 255 255 / 0.14)"
              src={hasPhoto && memberId ? `/api/c/${clinic.slug}/staff/${memberId}/photo` : null}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-white">{userName}</div>
              <div className="text-[11px] text-white/40">
                {isOwner ? t.staff.owner : t.staff.roles[role]}
              </div>
            </div>
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
              className="rounded-ctl p-1.5 text-white/50 transition-colors hover:bg-white/5 hover:text-white"
              aria-label={t.nav.notifications}
            >
              <Bell className="h-4.5 w-4.5" strokeWidth={1.75} />
            </Link>
            <form action={logoutAction}>
              <button
                className="rounded-ctl p-1.5 text-white/50 transition-colors hover:bg-white/5 hover:text-white"
                aria-label={t.auth.signOut}
              >
                <LogOut className="h-4.5 w-4.5" strokeWidth={1.75} />
              </button>
            </form>
          </div>
          <div className="mt-2 space-y-1 px-1">
            <InstallApp onDark />
            <LanguageToggle onDark />
          </div>
        </div>
      </aside>

      {/*
        Content. The top inset is zero in a browser tab and only becomes real
        once the app is installed to a home screen, where the page runs behind
        the status bar and the first line of every screen would otherwise sit
        under the clock.
      */}
      <div className="pt-[env(safe-area-inset-top)] md:ms-[248px] md:pt-0">
        {isImpersonating && (
          <div className="sticky top-0 z-50 flex items-center justify-center gap-2 bg-danger px-4 py-2 text-center text-[13px] font-medium text-white">
            <ShieldAlert className="h-4 w-4 shrink-0" />
            {t.admin.impersonating}
            <form action={exitImpersonationAction}>
              <button className="underline underline-offset-2 hover:opacity-80">
                {t.admin.exitImpersonation}
              </button>
            </form>
          </div>
        )}
        {announcements
          .filter((a) => !hiddenAnnouncements.includes(a.id))
          .map((a) => (
            <div
              key={a.id}
              className="flex items-start justify-between gap-3 border-b border-line bg-brand-100 px-4 py-2.5 text-[13px] text-brand-800"
            >
              <div>
                <span className="font-semibold">{a.title}</span>
                {a.body && <span className="ms-2">{a.body}</span>}
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
                className="mt-0.5 shrink-0 text-brand-700 hover:text-brand-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        <main className="mx-auto max-w-6xl px-4 py-6 pb-24 md:px-8 md:pb-10">{children}</main>
      </div>

      {/* Mobile bottom nav */}
      {moreOpen && (
        <button
          type="button"
          aria-label={t.common.close}
          onClick={() => setMoreOpen(false)}
          className="fixed inset-0 z-30 bg-night/25 animate-fade-in md:hidden"
        />
      )}
      {/*
        The horizontal insets matter in landscape on a notched phone, where the
        cutout eats into the row and would otherwise sit on top of the first
        tab. They are physical (`pl`/`pr`), not logical: the notch is on the
        same side of the handset whichever way the text runs.
      */}
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] backdrop-blur md:hidden">
        {/*
          The sheet is rendered before the tab row deliberately. The bar is
          anchored to the bottom edge, so markup placed after the tabs grows
          downward off-screen and shunts the tabs up as it opens; placed before
          them it rises above the bar, which is where a menu opened from the
          bottom of the screen is expected to come from.

          72dvh clears the full owner menu — nine entries plus the footer come
          to ~440px, which overflowed a 62dvh cap on an ordinary handset and
          left the language and sign-out row sliced in half against the tab bar.
          The scroll stays for the short phones where it genuinely cannot fit.
        */}
        {moreOpen && (
          <div className="max-h-[72dvh] overflow-y-auto border-b border-line bg-surface px-2 py-2 animate-fade-up">
            {mobileMore.map(({ key, href, badge }) => {
              const Icon = icons[key];
              return (
                <Link
                  key={key}
                  href={href}
                  onClick={() => setMoreOpen(false)}
                  className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-ink-700 transition-colors duration-140 ease-out hover:bg-sunken active:bg-sunken"
                >
                  <Icon className="h-[18px] w-[18px] shrink-0 text-ink-400" />
                  <span className="flex-1">{t.nav[key]}</span>
                  {!!badge && (
                    <span className="rounded-full bg-brand-100 px-1.5 py-0.5 text-[11px] font-semibold text-brand-700 tnum">
                      {badge > 99 ? "99+" : badge}
                    </span>
                  )}
                </Link>
              );
            })}
            {/* The account, first and unmistakable: on a phone this sheet is
                the only route to it. */}
            <Link
              href={`${base}/profile`}
              onClick={() => setMoreOpen(false)}
              className="mb-1 flex touch-manipulation items-center gap-3 rounded-lg border border-line px-3 py-2.5 transition-colors duration-140 ease-out hover:bg-sunken active:bg-sunken"
            >
              <Avatar
                name={userName}
                size={34}
                src={hasPhoto && memberId ? `/api/c/${clinic.slug}/staff/${memberId}/photo` : null}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{userName}</span>
                <span className="block text-[12px] text-ink-500">
                  {isOwner ? t.staff.owner : t.staff.roles[role]}
                </span>
              </span>
              <ChevronLeft className="h-4 w-4 shrink-0 text-ink-300 rtl:rotate-180" />
            </Link>
            <Link
              href={`${base}/notifications`}
              onClick={() => setMoreOpen(false)}
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-ink-700 transition-colors duration-140 ease-out hover:bg-sunken active:bg-sunken"
            >
              <Bell className="h-[18px] w-[18px] shrink-0 text-ink-400" />
              {t.nav.notifications}
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
        <div className="grid auto-cols-fr grid-flow-col">
          {mobileMain.map(({ key, href, badge }) => {
            const Icon = icons[key];
            const active = isActive(href);
            return (
              <Link
                key={key}
                href={href}
                aria-current={active ? "page" : undefined}
                className={`relative flex touch-manipulation flex-col items-center gap-1 py-2.5 text-[10px] font-medium transition-colors duration-140 ease-out ${
                  active ? "text-brand-700" : "text-ink-500"
                }`}
              >
                <Icon className="h-5 w-5" />
                {t.nav[key]}
                {!!badge && (
                  <span className="absolute top-1 end-[calc(50%-1.4rem)] h-2 w-2 rounded-full bg-brand-600" />
                )}
              </Link>
            );
          })}
          {mobileMore.length > 0 && (
            <button
              onClick={() => setMoreOpen((v) => !v)}
              aria-expanded={moreOpen}
              className={`flex touch-manipulation flex-col items-center gap-1 py-2.5 text-[10px] font-medium transition-colors duration-140 ease-out ${
                moreOpen ? "text-brand-700" : "text-ink-500"
              }`}
            >
              <MoreHorizontal className="h-5 w-5" />
              {t.nav.more}
            </button>
          )}
        </div>
      </nav>
    </div>
  );
}
