import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { guardCap } from "@/lib/guard";
import { dictForClinic } from "@/lib/i18n";
import { PageHeader } from "@/components/ui/card";
import { SETTINGS_GROUPS, settingsItems } from "./settings-items";

/**
 * Settings, as a menu (Yamen, 2026-11-21: "to go to the team and staff I have
 * to read all of that — overwhelming, specially for people who don't have
 * experience in these types of software").
 *
 * An icon and a short name for every section, in a few groups, and nothing
 * else to read: one tap opens the section, and Back returns here. The clinic's
 * profile, which this page used to be, is /settings/profile.
 */
export default async function SettingsMenuPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardCap(slug, "settings");
  const t = await dictForClinic(access.clinic.vocabulary);
  const items = settingsItems(slug, t, access.caps, {
    einvoicing: access.clinic.features.einvoicing,
    dental: !!access.clinic.features.dental,
    face: !!access.clinic.features.aesthetic,
    devices: access.clinic.features.devices,
  });

  return (
    <>
      <PageHeader title={t.settings.title} />
      <nav className="flex flex-col gap-6" aria-label={t.settings.title} data-settings-menu>
        {SETTINGS_GROUPS.map((g) => {
          const inGroup = items.filter((i) => i.group === g);
          if (!inGroup.length) return null;
          return (
            <section key={g} data-settings-group={g}>
              <h2 className="mb-2 px-1 text-[0.75rem] font-semibold text-ink-500">{t.settings.groups[g]}</h2>
              <ul className="flex flex-col gap-2 sm:grid sm:grid-cols-2 xl:grid-cols-3">
                {inGroup.map((i) => {
                  const Icon = i.icon;
                  return (
                    <li key={i.href}>
                      <Link
                        href={i.href}
                        prefetch
                        className="flex min-h-14 items-center gap-3 rounded-card border border-line bg-surface px-4 py-2.5 shadow-card transition-[border-color,box-shadow] duration-140 ease-out hover:border-line-strong hover:shadow-pop"
                      >
                        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700 ring-1 ring-brand-100">
                          <Icon className="h-[1.125rem] w-[1.125rem]" strokeWidth={1.75} />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-900">{i.label}</span>
                        <ChevronRight className="h-4 w-4 shrink-0 text-ink-300 rtl:rotate-180" />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </nav>
    </>
  );
}
