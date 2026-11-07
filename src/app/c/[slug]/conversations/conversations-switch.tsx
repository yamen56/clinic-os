"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n/client";

/**
 * Patients or Team, at the top of the list pane. The patient inbox is WhatsApp
 * and the team chat is the staff, and the two sit side by side because the desk
 * works in both at once.
 */
export function ConversationsSwitch({ slug, active }: { slug: string; active: "patients" | "team" }) {
  const { t } = useI18n();
  const tab = (key: "patients" | "team", href: string, label: string) => (
    <Link
      href={href}
      aria-current={active === key ? "page" : undefined}
      className={`flex min-h-9 flex-1 items-center justify-center rounded-full px-3 text-[13px] font-semibold transition-colors ${
        active === key ? "bg-surface text-ink-900 shadow-card" : "text-ink-500 hover:text-ink-900"
      }`}
      data-conversations-tab={key}
    >
      {label}
    </Link>
  );
  return (
    <div className="flex min-w-0 flex-1 rounded-full bg-sunken p-0.5" data-conversations-switch>
      {tab("patients", `/c/${slug}/conversations`, t.team.patientsTab)}
      {tab("team", `/c/${slug}/conversations/team`, t.team.tab)}
    </div>
  );
}
