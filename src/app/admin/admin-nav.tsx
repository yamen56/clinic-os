"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import type { AdminCapabilityMap } from "@/lib/admin-permissions";

/**
 * The agency's sections (rebuilt 2026-11-27).
 *
 * The nav is the capability set, rendered — the same rule the clinic sidebar
 * follows. Overview and Clinics have no `show` because every admin has them:
 * a panel whose front page is hidden is not a limited admin, it is a broken
 * login, and it is also where `guardAdminCap` sends anyone who reaches a page
 * they don't have.
 *
 * Announcements and the Defaults library are one "Content" section with two
 * tabs (ContentTabs): both are what clinics are handed, and a content person
 * may hold either without the other.
 */
export function adminSections(caps: AdminCapabilityMap, t: ReturnType<typeof useI18n>["t"]) {
  const content = caps.announcements ? "/admin/announcements" : "/admin/defaults";
  return [
    { href: "/admin", label: t.admin.overview, exact: true, show: true },
    { href: "/admin/clinics", label: t.admin.clinics, show: true },
    { href: "/admin/plans", label: t.admin.plansNav, show: true },
    { href: "/admin/monitoring", label: t.admin.monitoring, show: caps.monitoring },
    { href: "/admin/analytics", label: t.admin.analytics, show: caps.analytics },
    {
      href: content,
      label: t.admin.content,
      match: ["/admin/announcements", "/admin/defaults"],
      show: caps.announcements || caps.defaults || caps.documents,
    },
    { href: "/admin/team", label: t.admin.team, show: caps.admins },
  ].filter((it) => it.show);
}

export function AdminNav({ caps, phone = false }: { caps: AdminCapabilityMap; phone?: boolean }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const items = adminSections(caps, t);
  const isActive = (it: (typeof items)[number]) =>
    it.exact ? pathname === it.href : (it.match ?? [it.href]).some((m) => pathname.startsWith(m));

  return (
    <nav
      className={
        phone
          ? "flex gap-1 overflow-x-auto px-4 pb-2 [scrollbar-width:none] md:hidden"
          : "hidden items-center gap-1 md:flex"
      }
      aria-label={t.admin.title}
    >
      {items.map((it) => (
        <Link
          key={it.href}
          href={it.href}
          prefetch
          data-admin-nav={it.href}
          className={`shrink-0 rounded-full px-3 py-1.5 text-[0.8125rem] font-medium transition-colors ${
            isActive(it) ? "bg-brand-100 text-brand-700" : "text-ink-500 hover:text-ink-900"
          }`}
        >
          {it.label}
        </Link>
      ))}
    </nav>
  );
}

/** The two tabs of Content, above Announcements and Defaults. */
export function ContentTabs({ caps }: { caps: AdminCapabilityMap }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const tabs = [
    { href: "/admin/announcements", label: t.admin.announcements, show: caps.announcements },
    { href: "/admin/defaults", label: t.admin.defaults, show: caps.defaults || caps.documents },
  ].filter((x) => x.show);
  if (tabs.length < 2) return null;
  return (
    <div className="mb-4 flex gap-1 border-b border-line">
      {tabs.map((x) => (
        <Link
          key={x.href}
          href={x.href}
          className={`-mb-px border-b-2 px-3 py-2 text-[0.8125rem] font-medium ${
            pathname.startsWith(x.href) ? "border-brand-600 text-ink-900" : "border-transparent text-ink-500 hover:text-ink-900"
          }`}
        >
          {x.label}
        </Link>
      ))}
    </div>
  );
}
