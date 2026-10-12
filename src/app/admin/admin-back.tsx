"use client";

import { usePathname } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { BackLink, useBackHref } from "@/components/back-link";

/**
 * Back for the admin panel's inner pages — one clinic, a new clinic. The tabs
 * in the header are its sections and get none; on a phone those tabs are
 * hidden, which made this the only way out of a clinic short of the logo.
 */
export function AdminBack() {
  const { t } = useI18n();
  const pathname = usePathname();
  const href = useBackHref("/admin", "/admin");

  const sections: Record<string, string> = {
    analytics: t.admin.analytics,
    monitoring: t.admin.monitoring,
    announcements: t.admin.announcements,
    defaults: t.admin.defaults,
    team: t.admin.team,
  };
  const here = pathname.split("/").filter(Boolean).slice(1);
  const isInner = here.length > 1 || (here.length === 1 && !(here[0] in sections));
  if (!isInner) return null;

  const to = href.split(/[?#]/)[0].split("/").filter(Boolean).slice(1);
  const label =
    to.length === 0 ? t.admin.clinics : to.length === 1 && sections[to[0]] ? sections[to[0]] : t.common.back;

  return (
    <div className="-mt-4 mb-2">
      <BackLink href={href} label={label} />
    </div>
  );
}
