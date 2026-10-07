"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import type { CapabilityMap } from "@/lib/permissions";

export function SettingsNav({
  slug,
  caps,
  hasEinvoicing,
  fullControl,
}: {
  slug: string;
  /**
   * Each tab shows for the capability that opens it — the same one its page
   * guards on, so a tab is never a link into a redirect. `settings.clinic` is
   * the clinic-wide configuration: profile edits, custom fields, templates,
   * invoicing.
   */
  caps: CapabilityMap;
  /** The JoFotara tab only exists for a clinic licensed for it. */
  hasEinvoicing: boolean;
  /** The owner, or somebody handed the whole clinic. See the support-visits page. */
  fullControl: boolean;
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
    { href: `${base}/staff`, label: t.settings.staff, show: caps["settings.staff"] },
    { href: `${base}/services`, label: t.settings.services, show: caps["settings.services"] },
    { href: `${base}/hours`, label: t.settings.workingHours },
    { href: `${base}/fields`, label: t.fields.title, show: caps["settings.clinic"] },
    { href: `${base}/tags`, label: t.tags.title, show: caps["settings.tags"] },
    { href: `${base}/documents`, label: t.settings.documentTemplates },
    { href: `${base}/booking`, label: t.settings.bookingLinks, show: caps["settings.booking"] },
    { href: `${base}/insurers`, label: t.insurers.title, show: caps["insurance.companies"] },
    { href: `${base}/whatsapp`, label: t.settings.whatsapp, show: caps["settings.whatsapp"] },
    { href: `${base}/invoicing`, label: t.settings.invoiceSettings },
    { href: `${base}/einvoicing`, label: t.einvoicing.title, show: hasEinvoicing && caps["settings.clinic"] },
    { href: `${base}/support-visits`, label: t.supportVisits.tab, show: fullControl },
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
                active ? "bg-surface text-ink-900 shadow-card" : "text-ink-700 hover:bg-ink-900/4"
              }`}
            >
              {i.label}
            </Link>
          );
        })}
    </nav>
  );
}
