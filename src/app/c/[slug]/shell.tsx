"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { LanguageToggle } from "@/components/language-toggle";
import { logoutAction } from "@/app/login/actions";
import { exitImpersonationAction } from "@/app/admin/actions";
import { Avatar } from "@/components/ui/misc";
import { BrandMark } from "@/components/brand-mark";
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
  Settings,
  MoreHorizontal,
  Bell,
  PenTool,
  LogOut,
  ShieldAlert,
  X,
} from "lucide-react";

type NavKey =
  | "dashboard"
  | "conversations"
  | "calendar"
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
  permissions,
  userName,
  userId,
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
  role: "owner" | "doctor" | "receptionist";
  permissions: Record<string, boolean>;
  userName: string;
  userId: string;
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
  const canAutomations = role === "owner" || permissions.automations === true;

  const items: { key: NavKey; href: string; show: boolean; badge?: number }[] = [
    { key: "dashboard", href: base, show: true },
    { key: "conversations", href: `${base}/conversations`, show: role !== "doctor", badge: unreadCount },
    { key: "calendar", href: `${base}/calendar`, show: true },
    { key: "patients", href: `${base}/patients`, show: true },
    { key: "campaigns", href: `${base}/campaigns`, show: canAutomations },
    // Doctors see Documents: countersigning is a doctor's job, unlike invoicing.
    { key: "documents", href: `${base}/documents`, show: true, badge: pendingDocuments },
    { key: "invoices", href: `${base}/invoices`, show: role !== "doctor" },
    { key: "automations", href: `${base}/automations`, show: canAutomations },
    { key: "aiAgent", href: `${base}/ai`, show: canAutomations },
    { key: "settings", href: `${base}/settings`, show: role !== "doctor" },
  ];
  const visible = items.filter((i) => i.show);
  const mobileMain = visible.slice(0, 4);
  const mobileMore = visible.slice(4);

  const isActive = (href: string) =>
    href === base ? pathname === base : pathname.startsWith(href);

  const clinicDisplay = locale === "ar" ? clinic.nameAr || clinic.name : clinic.name;

  return (
    <div className="min-h-dvh bg-paper">
      {/* Desktop sidebar — night surface, the one dark region of the app chrome */}
      <aside className="fixed inset-y-0 inset-inline-start-0 z-40 hidden w-[248px] flex-col border-e border-white/6 bg-night md:flex">
        <div className="flex h-[88px] items-center justify-center border-b border-white/6">
          <BrandMark size={64} />
        </div>
        <div className="flex items-center gap-2.5 px-4 py-3.5">
          <Avatar name={clinic.name} size={30} color={clinic.brandColor} />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold leading-tight text-white">
              {clinicDisplay}
            </div>
            <div className="text-[11px] text-white/40">Makan Clinic Platform</div>
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
                    ? "bg-[rgb(105_137_166/0.22)] text-white before:absolute before:inset-y-2 before:inset-inline-start-0 before:w-0.5 before:rounded-full before:bg-brand-600 before:content-['']"
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
            <Avatar name={userName} size={30} color="rgb(255 255 255 / 0.14)" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-white">{userName}</div>
              <div className="text-[11px] text-white/40">{role}</div>
            </div>
            {/* Reachable for doctors too, who never see /settings. */}
            <Link
              href={`${base}/signature`}
              className="rounded-ctl p-1.5 text-white/50 transition-colors hover:bg-white/5 hover:text-white"
              aria-label={t.mySignature.title}
              title={t.mySignature.title}
            >
              <PenTool className="h-4.5 w-4.5" strokeWidth={1.75} />
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
          <div className="mt-2 px-1">
            <LanguageToggle onDark />
          </div>
        </div>
      </aside>

      {/* Content */}
      <div className="md:ms-[248px]">
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
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        <div className="grid auto-cols-fr grid-flow-col">
          {mobileMain.map(({ key, href, badge }) => {
            const Icon = icons[key];
            const active = isActive(href);
            return (
              <Link
                key={key}
                href={href}
                className={`relative flex flex-col items-center gap-1 py-2.5 text-[10px] font-medium ${
                  active ? "text-brand-700" : "text-ink-500"
                }`}
              >
                <Icon className="h-5 w-5" />
                {t.nav[key]}
                {!!badge && (
                  <span className="absolute top-1 inset-inline-end-[calc(50%-1.4rem)] h-2 w-2 rounded-full bg-brand-600" />
                )}
              </Link>
            );
          })}
          {mobileMore.length > 0 && (
            <button
              onClick={() => setMoreOpen((v) => !v)}
              className={`flex flex-col items-center gap-1 py-2.5 text-[10px] font-medium ${
                moreOpen ? "text-brand-700" : "text-ink-500"
              }`}
            >
              <MoreHorizontal className="h-5 w-5" />
              {t.nav.more}
            </button>
          )}
        </div>
        {moreOpen && (
          <div className="border-t border-line bg-surface px-2 py-2 animate-fade-up">
            {mobileMore.map(({ key, href }) => {
              const Icon = icons[key];
              return (
                <Link
                  key={key}
                  href={href}
                  onClick={() => setMoreOpen(false)}
                  className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-ink-700 hover:bg-sunken"
                >
                  <Icon className="h-[18px] w-[18px] text-ink-400" />
                  {t.nav[key]}
                </Link>
              );
            })}
            <Link
              href={`${base}/notifications`}
              onClick={() => setMoreOpen(false)}
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-ink-700 hover:bg-sunken"
            >
              <Bell className="h-[18px] w-[18px] text-ink-400" />
              {t.nav.notifications}
            </Link>
            <Link
              href={`${base}/signature`}
              onClick={() => setMoreOpen(false)}
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-ink-700 hover:bg-sunken"
            >
              <PenTool className="h-[18px] w-[18px] text-ink-400" />
              {t.mySignature.title}
            </Link>
            <div className="flex items-center justify-between px-3 py-2.5">
              <LanguageToggle />
              <form action={logoutAction}>
                <button className="flex items-center gap-2 text-sm text-ink-500">
                  <LogOut className="h-4 w-4" /> {t.auth.signOut}
                </button>
              </form>
            </div>
          </div>
        )}
      </nav>
    </div>
  );
}
