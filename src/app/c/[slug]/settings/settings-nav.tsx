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
  hasDental = false,
  hasFace = false,
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
  /** Treatment prices are the dental chart's: a clinic with the chart gets the tab. */
  hasDental?: boolean;
  /** Face treatment prices are the face chart's, likewise. */
  hasFace?: boolean;
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

  /*
    In groups, in the order a clinic meets them (Yamen, 2026-10-31: "setup is
    confusing"). Nineteen tabs in one column read as a list to search; under a
    few headings they read as a map. On a phone the strip stays one scrolling
    row and the headings stay out of it. Messaging also points at the words
    the clinic sends on its own and the AI receptionist, which live on their
    own pages and were nowhere to be found from here.
  */
  type Group = "clinic" | "services" | "patients" | "team" | "messaging" | "you";
  const items: { href: string; label: string; group: Group; show?: boolean }[] = [
    { href: base, label: t.settings.profile, group: "clinic" },
    { href: `${base}/hours`, label: t.settings.workingHours, group: "clinic" },
    { href: `${base}/rooms`, label: t.rooms.title, group: "clinic", show: caps["settings.services"] },
    { href: `${base}/devices`, label: t.devices.tab, group: "clinic", show: caps["settings.clinic"] },
    { href: `${base}/support-visits`, label: t.supportVisits.tab, group: "clinic", show: caps["settings.support_visits"] },
    { href: `${base}/services`, label: t.settings.services, group: "services", show: caps["settings.services"] },
    { href: `${base}/prices`, label: t.settings.treatmentPrices, group: "services", show: hasDental && caps["settings.services"] },
    { href: `${base}/labs`, label: t.settings.dentalLabs, group: "services", show: hasDental && caps["settings.services"] },
    { href: `${base}/face-prices`, label: t.settings.facePrices, group: "services", show: hasFace && caps["settings.services"] },
    { href: `${base}/face-packages`, label: t.settings.facePackages, group: "services", show: hasFace && caps["settings.services"] },
    { href: `${base}/insurers`, label: t.insurers.title, group: "services", show: caps["insurance.companies"] },
    { href: `${base}/invoicing`, label: t.settings.invoiceSettings, group: "services" },
    { href: `${base}/einvoicing`, label: t.einvoicing.title, group: "services", show: hasEinvoicing && caps["settings.clinic"] },
    { href: `${base}/fields`, label: t.fields.title, group: "patients", show: caps["settings.clinic"] },
    { href: `${base}/tags`, label: t.tags.title, group: "patients", show: caps["settings.tags"] },
    { href: `${base}/documents`, label: t.settings.documentTemplates, group: "patients" },
    { href: `${base}/staff`, label: t.settings.staff, group: "team", show: caps["settings.staff"] },
    { href: `${base}/whatsapp`, label: t.settings.whatsapp, group: "messaging", show: caps["settings.whatsapp"] },
    { href: `${base}/booking`, label: t.settings.bookingLinks, group: "messaging", show: caps["settings.booking"] },
    { href: `/c/${slug}/automations`, label: t.settings.groups.autoMessages, group: "messaging", show: caps.automations },
    { href: `/c/${slug}/ai`, label: t.nav.aiAgent, group: "messaging", show: caps.ai },
    // Personal, not clinic configuration — and it lives outside /settings so that
    // members without the settings capability can still reach it.
    { href: `/c/${slug}/signature`, label: t.settings.mySignature, group: "you" },
    { href: `/c/${slug}/notifications`, label: t.settings.notificationPrefs, group: "you" },
  ];
  const groups: Group[] = ["clinic", "services", "patients", "team", "messaging", "you"];
  const visible = items.filter((i) => i.show !== false);

  return (
    <nav className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
      {groups.map((g) => {
        const inGroup = visible.filter((i) => i.group === g);
        if (!inGroup.length) return null;
        return (
          <div key={g} className="flex shrink-0 gap-1 lg:mb-2 lg:flex-col" data-settings-group={g}>
            <div className="px-3 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-ink-400 max-lg:hidden">{t.settings.groups[g]}</div>
            {inGroup.map((i) => {
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
          </div>
        );
      })}
    </nav>
  );
}
