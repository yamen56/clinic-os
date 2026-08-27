"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { CalendarPlus, UserPlus, ReceiptText, MessagesSquare } from "lucide-react";

export type QuickAction = "appointment" | "patient" | "invoice" | "inbox";

/**
 * The four things a front desk does all day, one press away.
 *
 * Each button carries a keyboard accelerator because the people using this are
 * on a desktop with a patient in front of them, and reaching for the mouse to
 * start a booking is the slowest part of taking one.
 */
const SHORTCUTS: Record<QuickAction, { code: string; hint: string }> = {
  appointment: { code: "KeyA", hint: "A" },
  patient: { code: "KeyP", hint: "P" },
  invoice: { code: "KeyI", hint: "I" },
  inbox: { code: "KeyM", hint: "M" },
};

const ICONS: Record<QuickAction, React.ComponentType<{ className?: string }>> = {
  appointment: CalendarPlus,
  patient: UserPlus,
  invoice: ReceiptText,
  inbox: MessagesSquare,
};

/** Where each action goes. Outside the component so the effect below can depend
 *  on `slug` alone rather than on an object rebuilt every render. */
function hrefFor(slug: string, a: QuickAction): string {
  return {
    appointment: `/c/${slug}/calendar?new=1`,
    patient: `/c/${slug}/patients?new=1`,
    invoice: `/c/${slug}/invoices/new`,
    inbox: `/c/${slug}/conversations`,
  }[a];
}

export function QuickActions({ slug, actions }: { slug: string; actions: QuickAction[] }) {
  const { t } = useI18n();
  const router = useRouter();

  const label: Record<QuickAction, string> = {
    appointment: t.dashboard.newAppointment,
    patient: t.dashboard.newPatient,
    invoice: t.dashboard.newInvoice,
    inbox: t.dashboard.openInbox,
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      /*
        `e.code`, not `e.key`. `code` is the physical key; `key` is the
        character the current layout produces — so on an Arabic keyboard the A
        key reports "ش" and every shortcut in an Arabic-first product would be
        dead. This is the whole reason the map above stores KeyA rather than "a".
      */
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      // Never steal a keystroke from somebody typing. contentEditable covers the
      // rich-text editors in documents and notes.
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable)
      ) {
        return;
      }
      // A dialog owns the keyboard while it is open — Escape closes it, and a
      // stray "p" underneath it must not navigate the page out from under.
      if (document.querySelector('[role="dialog"]')) return;

      const hit = actions.find((a) => SHORTCUTS[a].code === e.code);
      if (!hit) return;
      e.preventDefault();
      router.push(hrefFor(slug, hit));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, router, slug]);

  return (
    <>
      {actions.map((a) => {
        const Icon = ICONS[a];
        return (
          <Link key={a} href={hrefFor(slug, a)}>
            <Button variant={a === "appointment" ? "primary" : "outline"} size="sm">
              <Icon className="h-4 w-4" />
              {label[a]}
              {/*
                The hint is desktop-only: a phone has no key to press, and the
                extra glyph is noise on the screen with the least room for it.
              */}
              <kbd className="ms-1 hidden rounded border border-current/25 px-1 text-[10px] font-semibold opacity-60 lg:inline">
                {SHORTCUTS[a].hint}
              </kbd>
            </Button>
          </Link>
        );
      })}
    </>
  );
}
