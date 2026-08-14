"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import type { AdminCapabilityMap } from "@/lib/admin-permissions";

export function AdminNav({ caps }: { caps: AdminCapabilityMap }) {
  const { t } = useI18n();
  const pathname = usePathname();

  /*
    The nav is the capability set, rendered — the same rule the clinic sidebar
    follows. Clinics has no `show` because every admin has it: a panel whose
    front page is hidden is not a limited admin, it is a broken login, and it is
    also where `guardAdminCap` sends anyone who reaches a page they don't have.
  */
  const items = [
    { href: "/admin", label: t.admin.clinics, exact: true, show: true },
    { href: "/admin/analytics", label: t.admin.analytics, show: caps.analytics },
    { href: "/admin/monitoring", label: t.admin.monitoring, show: caps.monitoring },
    { href: "/admin/documents", label: t.nav.documents, show: caps.documents },
    { href: "/admin/announcements", label: t.admin.announcements, show: caps.announcements },
    { href: "/admin/defaults", label: t.admin.defaults, show: caps.defaults },
    { href: "/admin/team", label: t.admin.team, show: caps.admins },
  ];

  return (
    <nav className="hidden items-center gap-1 md:flex">
      {items
        .filter((it) => it.show)
        .map((it) => {
          const active = it.exact ? pathname === it.href : pathname.startsWith(it.href);
          return (
            <Link
              key={it.href}
              href={it.href}
              prefetch
              className={`rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors ${
                active ? "bg-brand-100 text-brand-700" : "text-ink-500 hover:text-ink-900"
              }`}
            >
              {it.label}
            </Link>
          );
        })}
    </nav>
  );
}
