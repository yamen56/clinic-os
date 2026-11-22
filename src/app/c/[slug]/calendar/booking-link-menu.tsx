"use client";

import { Fragment } from "react";
import { useI18n } from "@/lib/i18n/client";
import { useToast } from "@/components/ui/toast";
import { Menu, MenuItem } from "@/components/ui/menu";
import { Copy, ExternalLink, Link2, Plus, Settings2, Share2 } from "lucide-react";

/**
 * The clinic's online booking link, from the Appointments page itself
 * (2026-11-22) — the desk sends it to a caller far more often than it edits it,
 * and it lived three screens away in Settings. Copy it, share it from the phone
 * (straight into WhatsApp), or open the page; the settings are one more tap.
 */
export function BookingLinkMenu({
  slug,
  links,
  canManage,
}: {
  slug: string;
  /** The active ones, oldest first — the clinic's main link leads. */
  links: { name: string; slug: string }[];
  canManage: boolean;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const C = t.calendar;
  const url = (s: string) => `${window.location.origin}/book/${s}`;
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  const copy = async (s: string) => {
    try {
      await navigator.clipboard.writeText(url(s));
      toast(C.bookingLinkCopied);
    } catch {
      toast(t.common.genericError, "error");
    }
  };

  return (
    <Menu
      label={C.bookingLink}
      align="end"
      buttonClassName="inline-flex h-9 touch-manipulation items-center gap-1.5 rounded-ctl border border-line-strong bg-surface px-2.5 text-[0.8125rem] font-semibold text-ink-700 transition-colors hover:bg-sunken max-sm:h-10 max-sm:w-10 max-sm:justify-center max-sm:px-0"
      trigger={() => (
        <>
          <Link2 className="h-4 w-4" />
          <span className="max-lg:hidden">{C.bookingLink}</span>
        </>
      )}
    >
      {(close) => (
        <div data-booking-link-menu>
          {links.length === 0 ? (
            canManage ? (
              <MenuItem icon={<Plus />} href={`/c/${slug}/settings/booking`}>
                {C.setUpBookingLink}
              </MenuItem>
            ) : (
              <p className="px-3 py-2 text-[0.8125rem] text-ink-500">{C.noBookingLink}</p>
            )
          ) : (
            links.map((l, i) => (
              <Fragment key={l.slug}>
                {links.length > 1 && (
                  <div
                    className={`px-3 pb-1 pt-2 text-[length:max(11px,0.6875rem)] font-semibold uppercase tracking-wide text-ink-400 ${i ? "border-t border-line" : ""}`}
                  >
                    {l.name}
                  </div>
                )}
                <MenuItem
                  icon={<Copy />}
                  hint={<span dir="ltr">/book/{l.slug}</span>}
                  onClick={() => {
                    close();
                    void copy(l.slug);
                  }}
                >
                  {C.copyBookingLink}
                </MenuItem>
                {canShare && (
                  <MenuItem
                    icon={<Share2 />}
                    onClick={() => {
                      close();
                      navigator.share({ title: l.name, url: url(l.slug) }).catch(() => {});
                    }}
                  >
                    {C.shareBookingLink}
                  </MenuItem>
                )}
                <MenuItem
                  icon={<ExternalLink />}
                  onClick={() => {
                    close();
                    window.open(url(l.slug), "_blank", "noopener");
                  }}
                >
                  {C.openBookingPage}
                </MenuItem>
              </Fragment>
            ))
          )}
          {links.length > 0 && canManage && (
            <div className="border-t border-line">
              <MenuItem icon={<Settings2 />} href={`/c/${slug}/settings/booking`}>
                {C.manageBookingLinks}
              </MenuItem>
            </div>
          )}
        </div>
      )}
    </Menu>
  );
}
