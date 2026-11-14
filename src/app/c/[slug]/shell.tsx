"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useRealtimeRefresh } from "@/lib/use-realtime";
import { useI18n } from "@/lib/i18n/client";
import { LanguageToggle } from "@/components/language-toggle";
import { InstallApp } from "@/components/pwa";
import { logoutAction } from "@/app/login/actions";
import { exitImpersonationAction } from "@/app/admin/actions";
import { Avatar } from "@/components/ui/misc";
import { clinicLogoUrl } from "@/lib/clinic-logo";
import { FINANCE_PREFIXES, firstFinanceHref } from "@/lib/finance";
import { BrandLockup, BrandMark } from "@/components/brand-mark";
import { ThemeScope, ThemeToggle } from "@/components/theme";
import { SIDEBAR_COOKIE, type SidebarPref } from "@/lib/theme";
import { NotificationPopups, useLiveNotifications, type InAppPrefs } from "@/components/live-notifications";
import { ArrivalAlerts } from "@/components/appointments/arrival-alerts";
import { BackLink, useBackHref } from "@/components/back-link";
import type { CapabilityMap, MemberRole } from "@/lib/permissions";
import { CommandPalette, keyIsFree, type PaletteAction, type PalettePage } from "@/components/command-palette";
import { hrefFor, useQuickShortcuts, type QuickAction } from "./quick-actions";
import {
  Search,
  LayoutDashboard,
  MessageCircle,
  CalendarDays,
  Users,
  Megaphone,
  FileSignature,
  Workflow,
  Sparkles,
  Cable,
  FlaskConical,
  Boxes,
  Wallet,
  Settings,
  MoreHorizontal,
  Bell,
  MessagesSquare,
  PenTool,
  UserRound,
  ChevronRight,
  ChevronLeft,
  LogOut,
  ShieldAlert,
  X,
} from "lucide-react";

type NavKey =
  | "dashboard"
  | "conversations"
  | "calendar"
  | "devices"
  | "labs"
  | "stock"
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
  devices: Cable,
  labs: FlaskConical,
  stock: Boxes,
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
  sidebar,
  isOwner,
  caps,
  userName,
  userId,
  memberId,
  hasPhoto,
  isImpersonating,
  unreadCount,
  teamUnread,
  notifications,
  pendingDocuments,
  hasEarnings,
  hasInsurers,
  devices,
  labs,
  stock,
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
    /** The clinic's timezone — a found patient's next visit is in the clinic's time. */
    tz: string;
  };
  role: MemberRole;
  /** The desktop sidebar as this person left it, from the cookie (see lib/theme). */
  sidebar: SidebarPref;
  isOwner: boolean;
  caps: CapabilityMap;
  userName: string;
  userId: string;
  /** Null when a super admin is impersonating: no membership, so no photo. */
  memberId: string | null;
  hasPhoto: boolean;
  isImpersonating: boolean;
  unreadCount: number;
  /** What this person has not read in the team chat. Null without a membership: no team to talk to. */
  teamUnread: number | null;
  /** This person's own unread notifications, and what they asked the app to do with new ones. */
  notifications: { unread: number; serverNow: string; prefs: InAppPrefs };
  pendingDocuments: number;
  /** This person has a share agreed, or money already earned under one. */
  hasEarnings: boolean;
  /** The clinic deals with at least one insurance company, so Claims is a tab. */
  hasInsurers: boolean;
  /** A machine is connected, and how many of its results wait to be filed. */
  devices: { connected: boolean; waiting: number };
  /** A dental clinic's labs: whether it keeps any, and how much work is back late. */
  labs: { kept: boolean; late: number };
  /** An aesthetic clinic's products and stock: whether it has the face chart, and how many products run low. */
  stock: { kept: boolean; low: number };
  /** `hasFullControl(access)` — an owner, or somebody on `full` access. */
  fullControl: boolean;
  announcements: { id: string; title: string; body: string }[];
  children: React.ReactNode;
}) {
  const { t, locale } = useI18n();
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const [sb, setSb] = useState<SidebarPref>(sidebar);
  /*
    The folded rail's labels. A tooltip cannot live inside the nav: the nav
    scrolls, and a scroller clips anything that pokes out of its side. So one
    fixed tooltip is positioned against the hovered item instead.
  */
  const [tip, setTip] = useState<{ label: string; y: number } | null>(null);
  const asideRef = useRef<HTMLElement>(null);
  const isMini = () => (asideRef.current?.offsetWidth ?? 248) < 120;
  const showTip = (e: React.SyntheticEvent<HTMLElement>, label: string) => {
    if (!isMini()) return;
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ label, y: r.top + r.height / 2 });
  };
  const hideTip = () => setTip(null);
  /*
    Flips what is on screen, not the stored word. On a tablet "auto" is
    showing the rail, so the first press has to open it — reading the width
    answers that where the preference alone cannot.
  */
  const toggleSidebar = () => {
    const next: SidebarPref = isMini() ? "expanded" : "collapsed";
    setSb(next);
    setTip(null);
    document.cookie = `${SIDEBAR_COOKIE}=${next}; path=/; max-age=${365 * 86400}; samesite=lax`;
  };
  const [hiddenAnnouncements, setHiddenAnnouncements] = useState<string[]>([]);
  /** The announcement shown in full on a phone, where they are cut to two lines. */
  const [openAnnouncement, setOpenAnnouncement] = useState<string | null>(null);
  const live = useLiveNotifications(clinic.slug, notifications);
  /*
    The team chat's count, kept live. Each person hears only of their own threads'
    counts (the events route filters by user), so this re-reads only when it changed.
  */
  const [team, setTeam] = useState(teamUnread);
  useRealtimeRefresh(clinic.slug, ["team_thread_members"], async () => {
    if (teamUnread === null) return;
    const r = await fetch(`/api/c/${clinic.slug}/team?count=1`, { cache: "no-store" });
    if (r.ok) setTeam(((await r.json()) as { unread: number }).unread);
  });
  const teamHref = `/c/${clinic.slug}/conversations/team`;

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
    /* Only once the clinic has a machine (or a result is still waiting from
       one it unplugged): a clinic with none sets one up in Settings → Devices
       and should not carry an empty page in its nav. The badge is the inbox. */
    { key: "devices", href: `${base}/devices`, show: caps.patients && (devices.connected || devices.waiting > 0), badge: devices.waiting },
    /* Once a dental clinic keeps a lab (Settings → Dental labs): what is out, back, and owed. The badge is work back late. */
    { key: "labs", href: `${base}/labs`, show: labs.kept && (caps["patients.charts"] || caps.invoices), badge: labs.late },
    /* The face chart's products and stock. The badge is what runs low. */
    { key: "stock", href: `${base}/stock`, show: stock.kept && caps.stock, badge: stock.low },
    ...(caps.invoices ? [] : [finance]),
    /* Patients' WhatsApp for whoever has it; the team chat for everybody on the staff. */
    {
      key: "conversations",
      href: caps.conversations ? `${base}/conversations` : teamHref,
      show: caps.conversations || team !== null,
      badge: (caps.conversations ? unreadCount : 0) + (team ?? 0),
    },
    { key: "campaigns", href: `${base}/campaigns`, show: caps.campaigns },
    { key: "automations", href: `${base}/automations`, show: caps.automations },
    { key: "aiAgent", href: `${base}/ai`, show: caps.ai },
    { key: "settings", href: `${base}/settings`, show: caps.settings },
  ];
  const visible = items.filter((i) => i.show);

  /*
    The search box and the four accelerators, on every screen. A patient found
    goes to their file, or — for somebody who may book but not open files — to
    a booking for them.
  */
  const quick: QuickAction[] = [
    ...(caps.calendar ? (["appointment"] as const) : []),
    ...(caps.patients ? (["patient"] as const) : []),
    ...(caps.invoices ? (["invoice"] as const) : []),
    ...(caps.conversations ? (["inbox"] as const) : []),
  ];
  useQuickShortcuts(clinic.slug, quick);
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // `code`, not `key`: on an Arabic layout K is "ن" and / is "ظ".
      const combo = (e.ctrlKey || e.metaKey) && !e.altKey && e.code === "KeyK";
      const slash = !e.ctrlKey && !e.metaKey && !e.altKey && e.code === "Slash" && keyIsFree();
      if (!combo && !slash) return;
      e.preventDefault();
      setSearchOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const canSearch = caps.patients || caps.calendar || caps.invoices || caps.conversations || caps.automations;
  const patientHref = caps.patients
    ? (id: string) => `${base}/patients/${id}`
    : caps.calendar
      ? (id: string) => `${base}/calendar?patient=${id}`
      : caps.invoices
        ? (id: string) => `${base}/invoices/new?patient=${id}`
        : null;
  const quickLabel: Record<QuickAction, string> = {
    appointment: t.dashboard.newAppointment,
    patient: t.dashboard.newPatient,
    invoice: t.dashboard.newInvoice,
    inbox: t.dashboard.openInbox,
  };
  const paletteActions: PaletteAction[] = quick.map((a) => ({ key: a, label: quickLabel[a], href: hrefFor(clinic.slug, a), icon: a }));
  const palettePages: PalettePage[] = visible.map((v) => ({ key: v.key, label: t.nav[v.key], href: v.href }));

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
  /*
    Where a tap is taking us, before the server has answered.

    A page here is rendered on the server, and on a phone on mobile data that
    is a second or two in which the screen used to show nothing at all: the old
    page stayed, the tapped tab stayed unlit, and the tap read as missed — so
    people tapped again (2026-11-14: "the loading screen in the phone view does
    not appear properly"). Now the tab lights the moment it is pressed and a
    thin line runs across the top until the page arrives.

    Taken from the click itself, in the capture phase — before next/link
    handles it and cancels the browser's own navigation — for any link to
    another page of this app. Cleared when the path changes, by Back, or after
    fifteen seconds whatever happens, so a navigation that never lands cannot
    leave the line running.
  */
  const [goingTo, setGoingTo] = useState<string | null>(null);
  const [showProgress, setShowProgress] = useState(false);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      if (/^\/api\//.test(url.pathname)) return;
      setGoingTo(url.pathname);
    };
    const onBack = () => setGoingTo(null);
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onBack);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onBack);
    };
  }, []);
  useEffect(() => {
    setGoingTo(null);
  }, [pathname]);
  useEffect(() => {
    if (!goingTo) {
      setShowProgress(false);
      return;
    }
    // Only for a wait worth showing: a page that is there at once gets no flicker.
    const show = setTimeout(() => setShowProgress(true), 120);
    const giveUp = setTimeout(() => setGoingTo(null), 15000);
    return () => {
      clearTimeout(show);
      clearTimeout(giveUp);
    };
  }, [goingTo]);

  const isActiveAt = (item: { key: NavKey; href: string }, path: string) => {
    if (item.key === "finance") {
      return FINANCE_PREFIXES.some((p) => path.startsWith(`${base}${p}`));
    }
    return item.href === base ? path === base : path.startsWith(item.href);
  };
  /* The tab being gone to is the lit one, from the moment it is tapped. */
  const isActive = (item: { key: NavKey; href: string }) => isActiveAt(item, goingTo ?? pathname);

  /*
    Back, on every page the nav does not lead to directly.

    A section's own page — the patient list, the calendar, a Finance or a
    Settings tab — is where the nav takes you, and a Back there would only
    point at whichever section you happened to open before. Everything opened
    from inside one gets it: a patient file, an invoice, a new invoice, a
    campaign, an automation, a document, a template, the import, and the
    pages reached from the avatar and the bell.

    It goes to the page this tab was on before (lib/nav-trail), so a patient
    opened from the calendar goes back to the calendar. With no such page — a
    link from a notification email, a reload — it goes up one level instead.
  */
  const sections: Record<string, string> = {
    patients: t.nav.patients,
    calendar: t.nav.calendar,
    devices: t.nav.devices,
    labs: t.nav.labs,
    stock: t.nav.stock,
    conversations: t.nav.conversations,
    campaigns: t.nav.campaigns,
    documents: t.nav.documents,
    automations: t.nav.automations,
    ai: t.nav.aiAgent,
    settings: t.nav.settings,
    invoices: t.nav.invoices,
    earnings: t.nav.earnings,
    expenses: t.nav.expenses,
    claims: t.claims.tab,
  };
  const segmentsOf = (href: string) => href.split(/[?#]/)[0].slice(base.length).split("/").filter(Boolean);
  const here = segmentsOf(pathname);
  const isInner =
    here.length > 0 &&
    !(here.length === 1 && here[0] in sections) &&
    !(here[0] === "settings" && here.length === 2) &&
    // The team chat is a tab of Conversations, not a page inside it.
    !(here[0] === "conversations" && here[1] === "team" && here.length === 2);
  const upHref = here.length > 1 ? `${base}/${here.slice(0, -1).join("/")}` : (visible[0]?.href ?? base);
  const backHref = useBackHref(upHref, base);
  /* Named when it is a section, so the link says where it goes; "Back" for a patient, an invoice. */
  const backLabel = (() => {
    const to = segmentsOf(backHref);
    if (to.length === 0) return t.nav.dashboard;
    if (to.length === 1 && sections[to[0]]) return sections[to[0]];
    if (to[0] === "settings" && to.length === 2) return t.nav.settings;
    return t.common.back;
  })();

  // Navigating away closes the sheet. The links close it themselves, but the
  // back button and in-page redirects don't go through them, and a sheet left
  // sitting over the screen it just opened reads as a stuck app.
  useEffect(() => {
    setMoreOpen(false);
    setTip(null);
  }, [pathname]);

  const clinicDisplay = locale === "ar" ? clinic.nameAr || clinic.name : clinic.name;
  const logoSrc = clinicLogoUrl(clinic.slug, clinic.logoPath);
  const photoSrc = hasPhoto && memberId ? `/api/c/${clinic.slug}/staff/${memberId}/photo` : null;
  const roleLabel = isOwner ? t.staff.owner : t.staff.roles[role];
  const bellLabel = live.unread ? `${t.nav.notifications} (${live.unread})` : t.nav.notifications;

  return (
    <div className="shell min-h-dvh bg-canvas" data-sidebar={sb}>
      <ThemeScope />
      {/* The page on its way (see `goingTo`): a line across the very top, under the phone's status bar. */}
      {showProgress && (
        <div
          className="nav-progress pointer-events-none fixed inset-x-0 z-[70] top-[env(safe-area-inset-top)]"
          role="progressbar"
          aria-label={t.common.loading}
          data-nav-progress
        />
      )}
      {/*
        Desktop sidebar — night surface, the one dark region of the app chrome,
        in both themes: the Clinicti mark is white and needs it.

        It folds to a 72px rail of icons (`sb-mini:` in globals.css): by the
        person's choice, or on its own on a tablet-width screen, where 248px of
        labels was a third of an iPad held upright. The labels stay in the DOM
        as screen-reader text, so a folded link is still named.
      */}
      <aside
        ref={asideRef}
        className="fixed inset-y-0 start-0 z-40 hidden w-(--sb) flex-col border-e border-white/6 bg-night transition-[width] duration-200 ease-out md:flex"
      >
        <div className="flex h-[88px] shrink-0 items-center justify-center overflow-hidden border-b border-white/6">
          <span className="sb-mini:hidden">
            <BrandLockup />
          </span>
          <span className="hidden sb-mini:block">
            <BrandMark size={34} />
          </span>
        </div>
        {/*
          The fold. On the panel's edge, where the eye goes looking for the
          thing that moves the edge, and never covering a nav item.
        */}
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label={t.nav.collapse}
          title={t.nav.collapse}
          aria-expanded
          data-sidebar-toggle
          className="absolute -end-3 top-[76px] z-10 grid h-6 w-6 touch-manipulation place-items-center rounded-full border border-white/12 bg-night text-white/60 shadow-pop transition-colors duration-140 ease-out hover:bg-white hover:text-night sb-mini:hidden"
        >
          <ChevronLeft className="h-3.5 w-3.5 rtl:rotate-180" strokeWidth={2.25} />
        </button>
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label={t.nav.expand}
          title={t.nav.expand}
          aria-expanded={false}
          data-sidebar-toggle
          className="absolute -end-3 top-[76px] z-10 hidden h-6 w-6 touch-manipulation place-items-center rounded-full border border-white/12 bg-night text-white/60 shadow-pop transition-colors duration-140 ease-out hover:bg-white hover:text-night sb-mini:grid"
        >
          <ChevronRight className="h-3.5 w-3.5 rtl:rotate-180" strokeWidth={2.25} />
        </button>
        <div
          className="flex items-center gap-2.5 px-4 py-3.5 sb-mini:justify-center sb-mini:px-0"
          title={clinicDisplay}
        >
          {/* Their own logo once one is uploaded. The initials stay underneath
              rather than being swapped out, so a logo that fails to load leaves
              a marked circle rather than a hole. */}
          <Avatar name={clinic.name} size={30} color={clinic.brandColor} src={logoSrc} fit="contain" />
          <div className="min-w-0 sb-mini:sr-only">
            <div className="truncate text-[13px] font-semibold leading-tight text-white">
              {clinicDisplay}
            </div>
            <div className="text-[11px] text-white/45">Clinicti</div>
          </div>
        </div>
        <div className="px-3 pb-1 sb-mini:px-0">
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="flex h-9 w-full items-center gap-2 rounded-ctl border border-white/10 bg-white/5 px-2.5 text-[13px] text-white/55 transition-colors duration-140 ease-out hover:bg-white/10 hover:text-white sb-mini:mx-auto sb-mini:w-9 sb-mini:justify-center sb-mini:px-0"
            aria-label={t.search.title}
            onMouseEnter={(e) => showTip(e, t.search.title)}
            onMouseLeave={hideTip}
            onFocus={(e) => showTip(e, t.search.title)}
            onBlur={hideTip}
            data-open-search
          >
            <Search className="h-4 w-4 shrink-0" strokeWidth={1.9} />
            <span className="flex-1 truncate text-start sb-mini:sr-only">{t.search.button}</span>
            <kbd className="rounded border border-white/15 px-1 text-[10px] font-semibold sb-mini:hidden">Ctrl K</kbd>
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-2 sb-mini:px-0" onScroll={hideTip}>
          {visible.map(({ key, href, badge }) => {
            const Icon = icons[key];
            const active = isActive({ key, href });
            return (
              <Link
                key={key}
                href={href}
                prefetch
                aria-current={active ? "page" : undefined}
                onMouseEnter={(e) => showTip(e, t.nav[key])}
                onMouseLeave={hideTip}
                onFocus={(e) => showTip(e, t.nav[key])}
                onBlur={hideTip}
                className={`relative mb-1 flex h-10 items-center gap-3 rounded-ctl px-3 text-sm font-medium transition-colors duration-140 ease-out sb-mini:mx-auto sb-mini:h-11 sb-mini:w-11 sb-mini:justify-center sb-mini:gap-0 sb-mini:px-0 ${
                  active
                    /*
                      A white pill with navy ink: the panel is the brand navy,
                      so "you are here" is said in the brand's other colour.
                      White at 10% was the old mark, and in a dim room it was
                      hard to tell from a hovered row.
                    */
                    ? "bg-white text-night shadow-[0_1px_2px_rgb(0_0_0/0.35)]"
                    : "text-white/65 hover:bg-white/6 hover:text-white"
                }`}
              >
                <Icon className="h-[18px] w-[18px] shrink-0" strokeWidth={active ? 2 : 1.75} />
                <span className="min-w-0 flex-1 truncate sb-mini:sr-only">{t.nav[key]}</span>
                {!!badge && (
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold tnum sb-mini:absolute sb-mini:-end-1 sb-mini:-top-1 sb-mini:min-w-[18px] sb-mini:px-1 sb-mini:py-0 sb-mini:text-center sb-mini:text-[10px] sb-mini:leading-[18px] sb-mini:ring-2 sb-mini:ring-night ${
                      active ? "bg-night text-white" : "bg-white/12 text-white sb-mini:bg-white sb-mini:text-night"
                    }`}
                  >
                    {fmtCount(badge)}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-white/6 p-3 sb-mini:px-0">
          {/*
            The name and role get this row to themselves. They used to share it
            with the three icon buttons below, which left about ninety pixels
            for both — an ordinary Arabic full name was clipped mid-word and the
            role under it with it, and this row is the only place in the desktop
            shell either one is written.
          */}
          <Link
            href={`${base}/profile`}
            className="-mx-1 flex items-center gap-2.5 rounded-ctl px-2 py-1 transition-colors duration-140 ease-out hover:bg-white/6 sb-mini:mx-auto sb-mini:w-fit sb-mini:justify-center sb-mini:p-1"
            onMouseEnter={(e) => showTip(e, `${userName} · ${roleLabel}`)}
            onMouseLeave={hideTip}
            onFocus={(e) => showTip(e, `${userName} · ${roleLabel}`)}
            onBlur={hideTip}
          >
            <Avatar name={userName} size={30} color="rgb(255 255 255 / 0.14)" src={photoSrc} />
            <div className="min-w-0 flex-1 sb-mini:sr-only">
              <div className="truncate text-[13px] font-medium text-white">{userName}</div>
              <div className="truncate text-[11px] text-white/45">{roleLabel}</div>
            </div>
          </Link>
          <div className="mt-2 space-y-1 px-1 sb-mini:hidden">
            <InstallApp onDark />
          </div>
          {/* The controls ride on the language row instead, where there is
              room for all of them and nothing has to be truncated to fit. On
              the rail they stack, one icon a row. */}
          <div className="mt-2 flex items-center gap-1 px-1 sb-mini:justify-center sb-mini:px-0">
            <span className="sb-mini:hidden">
              <LanguageToggle onDark />
            </span>
            <div className="ms-auto flex items-center gap-0.5 sb-mini:ms-0 sb-mini:grid sb-mini:grid-cols-2 sb-mini:gap-1">
              <ThemeToggle onDark onHint={showTip} onHintEnd={hideTip} />
              {/* Reachable for doctors too, who never see /settings. */}
              <Link
                href={`${base}/profile`}
                className="grid h-8 w-8 place-items-center rounded-ctl text-white/55 transition-colors hover:bg-white/8 hover:text-white sb-mini:hidden"
                aria-label={t.profile.title}
                onMouseEnter={(e) => showTip(e, t.profile.title)}
                onMouseLeave={hideTip}
                onFocus={(e) => showTip(e, t.profile.title)}
                onBlur={hideTip}
              >
                <UserRound className="h-4.5 w-4.5" strokeWidth={1.75} />
              </Link>
              <Link
                href={`${base}/notifications`}
                className={`relative grid h-8 w-8 place-items-center rounded-ctl transition-colors hover:bg-white/8 hover:text-white ${
                  live.unread ? "text-white" : "text-white/55"
                }`}
                aria-label={bellLabel}
                data-unread={live.unread}
                onMouseEnter={(e) => showTip(e, bellLabel)}
                onMouseLeave={hideTip}
                onFocus={(e) => showTip(e, bellLabel)}
                onBlur={hideTip}
              >
                <Bell className="h-4.5 w-4.5" strokeWidth={1.75} />
                {live.unread > 0 && (
                  <span className="absolute -end-1 -top-1 min-w-4 rounded-full bg-danger px-1 text-center text-[10px] font-semibold leading-4 text-white ring-2 ring-night tnum">
                    {fmtCount(live.unread)}
                  </span>
                )}
              </Link>
              <span className="hidden sb-mini:block">
                <LanguageToggle rail onHint={showTip} onHintEnd={hideTip} />
              </span>
              <form action={logoutAction}>
                <button
                  className="grid h-8 w-8 place-items-center rounded-ctl text-white/55 transition-colors hover:bg-white/8 hover:text-white"
                  aria-label={t.auth.signOut}
                  onMouseEnter={(e) => showTip(e, t.auth.signOut)}
                  onMouseLeave={hideTip}
                  onFocus={(e) => showTip(e, t.auth.signOut)}
                  onBlur={hideTip}
                >
                  <LogOut className="h-4.5 w-4.5" strokeWidth={1.75} />
                </button>
              </form>
            </div>
          </div>
        </div>
      </aside>
      {tip && (
        <div
          role="tooltip"
          className="pointer-events-none fixed start-[calc(var(--sb)+10px)] z-50 hidden -translate-y-1/2 whitespace-nowrap rounded-ctl bg-night px-2.5 py-1.5 text-[12.5px] font-medium text-white shadow-pop ring-1 ring-white/10 animate-fade-in md:block"
          style={{ top: tip.y }}
        >
          {tip.label}
        </div>
      )}

      <div className="transition-[margin] duration-200 ease-out md:ms-(--sb)">
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
            {/* Where a phone keeps Back: the top corner, pinned while the page scrolls. */}
            {isInner && <BackLink icon href={backHref} label={backLabel} />}
            <Link
              href={visible[0]?.href ?? `${base}/profile`}
              className="me-auto flex min-w-0 touch-manipulation items-center gap-2.5"
            >
              <Avatar name={clinic.name} size={32} color={clinic.brandColor} src={logoSrc} fit="contain" />
              <span className="font-display truncate text-[15px] font-bold text-ink-900">
                {clinicDisplay}
              </span>
            </Link>
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              aria-label={t.search.title}
              className="grid h-10 w-10 shrink-0 touch-manipulation place-items-center rounded-full text-ink-500 transition-colors duration-140 ease-out active:bg-sunken"
              data-open-search
            >
              <Search className="h-5 w-5" strokeWidth={1.75} />
            </button>
            {/* One tap to the team chat for everybody, doctors too: their bottom bar keeps its four. */}
            {team !== null && (
              <Link
                href={teamHref}
                aria-label={t.team.title}
                className={`relative grid h-10 w-10 shrink-0 touch-manipulation place-items-center rounded-full transition-colors duration-140 ease-out active:bg-sunken ${
                  team ? "text-ink-900" : "text-ink-500"
                }`}
                data-team-header
              >
                <MessagesSquare className="h-5 w-5" strokeWidth={1.75} />
                {team > 0 && (
                  <span className="absolute end-0.5 top-0.5 min-w-[18px] rounded-full bg-danger px-1 text-center text-[10px] font-semibold leading-[18px] text-white ring-2 ring-surface tnum">
                    {fmtCount(team)}
                  </span>
                )}
              </Link>
            )}
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
              className="flex items-center gap-3 border-b border-brand-100 bg-brand-50 px-4 py-2 text-[13px] text-ink-900 md:items-start md:px-8 md:py-2.5"
              data-announcement
            >
              <Megaphone className="h-4 w-4 shrink-0 text-brand-500 md:mt-0.5" strokeWidth={1.75} />
              {/*
                Two lines at most on a phone, and the whole text on a tap: two
                announcements at full length took a fifth of the screen before
                the page began.
              */}
              <button
                type="button"
                aria-expanded={openAnnouncement === a.id}
                onClick={() => setOpenAnnouncement((x) => (x === a.id ? null : a.id))}
                className={`min-w-0 flex-1 text-start ${openAnnouncement === a.id ? "" : "max-md:line-clamp-2"}`}
              >
                <span className="font-semibold">{a.title}</span>
                {a.body && <span className="ms-2 text-ink-700">{a.body}</span>}
              </button>
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
                className="-my-2 -me-2 grid h-10 w-10 shrink-0 touch-manipulation place-items-center rounded-full text-ink-500 transition-colors hover:bg-brand-100 hover:text-ink-900 md:-m-1 md:h-auto md:w-auto md:p-1"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        <main className="mx-auto max-w-6xl px-4 pb-24 pt-4 md:px-8 md:pb-10 md:pt-6">
          {/* From a tablet up there is no top bar, so Back sits over the page title. */}
          {isInner && (
            <div className="-ms-2 -mt-2 mb-2 max-md:hidden">
              <BackLink href={backHref} label={backLabel} />
            </div>
          )}
          {children}
        </main>
      </div>

      <NotificationPopups items={live.popups} onDismiss={live.dismiss} />
      <CommandPalette
        slug={clinic.slug}
        tz={clinic.tz}
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        canSearch={canSearch}
        patientHref={patientHref}
        actions={paletteActions}
        pages={palettePages}
      />
      {/* A doctor hears their patient arrive, on any screen. The waitlist used
          to sit here as a nav entry of its own; it is a tab of Appointments now. */}
      {role === "doctor" && caps.calendar && memberId && <ArrivalAlerts slug={clinic.slug} push={live.push} />}

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
                          <span className="absolute -end-1.5 -top-1.5 min-w-[18px] rounded-full bg-brand-600 px-1 text-center text-[10px] font-semibold leading-[18px] text-on-brand ring-2 ring-surface tnum">
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
            <div className="mt-1 flex items-center justify-between gap-2 border-t border-line px-3 pt-3 pb-1">
              <LanguageToggle />
              <ThemeToggle className="me-auto" />
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
        <div
          className="grid auto-cols-fr grid-flow-col border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] backdrop-blur"
          data-mobile-tabbar
        >
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
                    <span className="absolute -top-0.5 start-[calc(50%+0.375rem)] min-w-4 rounded-full bg-brand-600 px-1 text-center text-[10px] font-semibold leading-4 text-on-brand ring-2 ring-surface tnum">
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
