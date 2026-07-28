"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";

export function AdminNav() {
  const { t } = useI18n();
  const pathname = usePathname();
  const items = [
    { href: "/admin", label: t.admin.clinics, exact: true },
    { href: "/admin/monitoring", label: t.admin.monitoring },
    { href: "/admin/announcements", label: t.admin.announcements },
    { href: "/admin/defaults", label: t.admin.defaults },
  ];
  return (
    <nav className="hidden items-center gap-1 md:flex">
      {items.map((it) => {
        const active = it.exact ? pathname === it.href : pathname.startsWith(it.href);
        return (
          <Link
            key={it.href}
            href={it.href}
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
