"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import type { CapabilityMap } from "@/lib/permissions";
import { PageHeader } from "@/components/ui/card";
import { FoldHints } from "@/components/ui/hints";
import { SETTINGS_GROUPS, settingsItems } from "./settings-items";

type Has = { einvoicing: boolean; dental: boolean; face: boolean; devices: boolean };

/**
 * Around every settings page but the menu itself.
 *
 * /settings is a menu now (2026-11-21): a page per section, reached by its icon
 * and name. A section's page is titled with its own name rather than
 * "Settings", and on a wide screen the same menu runs down the side, so moving
 * between sections is one click. Narrower than that the side menu goes and the
 * shell's Back returns to the menu.
 */
export function SettingsFrame({
  slug,
  caps,
  has,
  children,
}: {
  slug: string;
  /** Each item shows for the capability its page guards on. */
  caps: CapabilityMap;
  has: Has;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const pathname = usePathname();
  const base = `/c/${slug}/settings`;
  /*
    `usePathname` only changes once the new page has rendered, so highlighting
    from it alone leaves the old item lit for the whole round trip and the
    click looks lost. Light the pressed one at once; the real path takes over
    when it arrives.
  */
  const [pressed, setPressed] = useState<string | null>(null);
  useEffect(() => setPressed(null), [pathname]);

  if (pathname === base) return <>{children}</>;

  const items = settingsItems(slug, t, caps, has);
  const current = pressed ?? pathname;
  const here = items.find((i) => current === i.href || current.startsWith(`${i.href}/`));

  return (
    <>
      <PageHeader title={here?.label ?? t.settings.title} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <nav className="hidden lg:block" aria-label={t.settings.title}>
          {SETTINGS_GROUPS.map((g) => {
            const inGroup = items.filter((i) => i.group === g);
            if (!inGroup.length) return null;
            return (
              <div key={g} className="mb-3" data-settings-group={g}>
                <div className="px-3 pb-1 text-[length:max(11px,0.6875rem)] font-semibold text-ink-400">{t.settings.groups[g]}</div>
                {inGroup.map((i) => {
                  const active = i === here;
                  const Icon = i.icon;
                  return (
                    <Link
                      key={i.href}
                      href={i.href}
                      prefetch
                      onClick={() => setPressed(i.href)}
                      aria-current={active ? "page" : undefined}
                      className={`flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-[0.8125rem] font-medium transition-colors duration-140 ease-out ${
                        active ? "bg-segment text-ink-900 shadow-card" : "text-ink-700 hover:bg-ink-900/4"
                      }`}
                    >
                      <Icon className={`h-4 w-4 shrink-0 ${active ? "text-ink-900" : "text-ink-400"}`} strokeWidth={1.75} />
                      <span className="truncate">{i.label}</span>
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>
        {/* Every section explains itself behind a "?" rather than in sentences (components/ui/hints). */}
        <div className="min-w-0">
          <FoldHints>{children}</FoldHints>
        </div>
      </div>
    </>
  );
}
