"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";

export function SettingsNav({ slug, isOwner }: { slug: string; isOwner: boolean }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const base = `/c/${slug}/settings`;

  const items: { href: string; label: string; ownerOnly?: boolean }[] = [
    { href: base, label: t.settings.profile },
    { href: `${base}/staff`, label: t.settings.staff, ownerOnly: true },
    { href: `${base}/services`, label: t.settings.services },
    { href: `${base}/hours`, label: t.settings.workingHours },
    { href: `${base}/fields`, label: t.fields.title },
    { href: `${base}/booking`, label: t.settings.bookingLinks },
    { href: `${base}/whatsapp`, label: t.settings.whatsapp },
  ];

  return (
    <nav className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
      {items
        .filter((i) => !i.ownerOnly || isOwner)
        .map((i) => {
          const active = i.href === base ? pathname === base : pathname.startsWith(i.href);
          return (
            <Link
              key={i.href}
              href={i.href}
              className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                active ? "bg-brand-50 text-brand-800" : "text-ink-600 text-ink-700 hover:bg-ink-900/4"
              }`}
            >
              {i.label}
            </Link>
          );
        })}
    </nav>
  );
}
