"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/client";

export function SettingsNav({
  slug,
  canClinic,
  canStaff,
}: {
  slug: string;
  /** Clinic-wide configuration: profile, custom fields, templates, invoicing. */
  canClinic: boolean;
  canStaff: boolean;
}) {
  const { t } = useI18n();
  const pathname = usePathname();
  const base = `/c/${slug}/settings`;

  /*
    `usePathname` only changes once the new page has rendered, so highlighting
    from it alone leaves the old tab lit for the whole round trip and the click
    looks lost. Track the tab that was pressed and light it immediately; the
    real pathname takes back over as soon as it arrives.
  */
  const [pressed, setPressed] = useState<string | null>(null);
  useEffect(() => setPressed(null), [pathname]);
  const current = pressed ?? pathname;

  const items: { href: string; label: string; show?: boolean }[] = [
    { href: base, label: t.settings.profile },
    { href: `${base}/staff`, label: t.settings.staff, show: canStaff },
    { href: `${base}/services`, label: t.settings.services },
    { href: `${base}/hours`, label: t.settings.workingHours },
    { href: `${base}/fields`, label: t.fields.title, show: canClinic },
    { href: `${base}/tags`, label: t.tags.title },
    { href: `${base}/documents`, label: t.settings.documentTemplates },
    { href: `${base}/booking`, label: t.settings.bookingLinks },
    { href: `${base}/insurers`, label: t.insurers.title, show: canClinic },
    { href: `${base}/whatsapp`, label: t.settings.whatsapp },
    { href: `${base}/invoicing`, label: t.settings.invoiceSettings },
    // Personal, not clinic configuration — and it lives outside /settings so that
    // members without the settings capability can still reach it.
    { href: `/c/${slug}/signature`, label: t.settings.mySignature },
    { href: `/c/${slug}/notifications`, label: t.settings.notificationPrefs },
  ];

  return (
    <nav className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
      {items
        .filter((i) => i.show !== false)
        .map((i) => {
          const active = i.href === base ? current === base : current.startsWith(i.href);
          return (
            <Link
              key={i.href}
              href={i.href}
              prefetch
              onClick={() => setPressed(i.href)}
              aria-current={active ? "page" : undefined}
              className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-140 ease-out ${
                active ? "bg-brand-50 text-brand-800" : "text-ink-700 hover:bg-ink-900/4"
              }`}
            >
              {i.label}
            </Link>
          );
        })}
    </nav>
  );
}
