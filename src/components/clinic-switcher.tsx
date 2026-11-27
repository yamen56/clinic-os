"use client";

import { useEffect } from "react";
import { useI18n } from "@/lib/i18n/client";
import { Menu, MenuItem } from "@/components/ui/menu";
import { Avatar } from "@/components/ui/misc";
import { ChevronsUpDown, LayoutGrid } from "lucide-react";

export type OtherClinic = { slug: string; name: string; brandColor: string; logoSrc: string | null };

import { LAST_CLINIC_COOKIE } from "@/lib/last-clinic";

/**
 * One login, several clinics (2026-11-27): a doctor who works at two clinics,
 * or an owner with branches, moves between them from the clinic's own name,
 * without signing out or going back through the picker. Shown only to
 * somebody who has somewhere else to go.
 *
 * Also remembers this clinic as the last one used, so signing in next time
 * opens it rather than the picker.
 */
export function ClinicSwitcher({
  slug,
  others,
  tone,
}: {
  slug: string;
  others: OtherClinic[];
  /** `night` on the dark sidebar, `light` in the phone's header. */
  tone: "night" | "light";
}) {
  const { t } = useI18n();
  useEffect(() => {
    if (!others.length) return;
    document.cookie = `${LAST_CLINIC_COOKIE}=${encodeURIComponent(slug)}; path=/; max-age=31536000; samesite=lax`;
  }, [slug, others.length]);
  if (!others.length) return null;
  return (
    <Menu
      label={t.nav.switchClinic}
      align="start"
      buttonClassName={`grid h-8 w-8 shrink-0 touch-manipulation place-items-center rounded-md transition-colors ${
        tone === "night" ? "text-white/55 hover:bg-white/10 hover:text-white" : "text-ink-500 active:bg-sunken"
      }`}
      trigger={() => <ChevronsUpDown className="h-4 w-4" data-clinic-switcher />}
    >
      {() => (
        <>
          {others.map((c) => (
            <MenuItem
              key={c.slug}
              href={`/c/${c.slug}`}
              icon={<Avatar name={c.name} size={20} color={c.brandColor} src={c.logoSrc} fit="contain" />}
            >
              <span data-switch-to={c.slug}>{c.name}</span>
            </MenuItem>
          ))}
          <MenuItem href="/?pick=1" icon={<LayoutGrid />}>
            {t.nav.allClinics}
          </MenuItem>
        </>
      )}
    </Menu>
  );
}
