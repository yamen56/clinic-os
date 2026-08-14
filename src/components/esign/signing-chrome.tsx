"use client";

import { dictFor, type Locale } from "@/lib/i18n/client-dict";
import { PoweredBy, PrivacyLink } from "@/components/powered-by";

/**
 * The shell every signing screen sits in, remote and in-clinic alike.
 *
 * It carries the clinic's logo and colour and nothing else — no navigation, no
 * language switch, and no link out except the Clinicti credit at the foot —
 * and that one only when `credit` is set to "link". On the clinic tablet the
 * absence of any link is a security property (the device is in a patient's
 * hands, and a browser is one tap away from the rest of the internet), so the
 * kiosk keeps the credit as plain text. On the patient's own phone there is
 * nothing to protect and the mark is worth having. Either way the chrome is
 * what makes a bare link feel like it came from the clinic, not from a vendor.
 */
export function SigningChrome({
  clinic,
  locale,
  children,
  footer,
  header,
  credit = "text",
}: {
  clinic: {
    name: string;
    slug: string;
    logoPath: string | null;
    brandColor: string;
  } | null;
  locale: Locale;
  children: React.ReactNode;
  footer?: React.ReactNode;
  header?: React.ReactNode;
  /** "link" opens clinicti.app; "text" is the kiosk-safe default. */
  credit?: "link" | "text";
}) {
  const t = dictFor(locale);
  const dir = locale === "ar" ? "rtl" : "ltr";

  return (
    <div
      dir={dir}
      lang={locale}
      className="flex min-h-dvh flex-col bg-paper"
      style={{ "--bk": clinic?.brandColor ?? "var(--color-brand-600)" } as React.CSSProperties}
    >
      <div className="h-1.5 w-full shrink-0" style={{ background: "var(--bk)" }} />
      <header className="flex shrink-0 items-center gap-3 px-4 py-3 sm:px-6">
        {clinic?.logoPath ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/public/clinic-logo/${clinic.slug}`}
            alt=""
            className="h-10 w-10 rounded-xl border border-line object-cover"
          />
        ) : (
          <span
            className="grid h-10 w-10 place-items-center rounded-xl text-base font-bold text-white"
            style={{ background: "var(--bk)" }}
          >
            {clinic?.name?.slice(0, 1) ?? "·"}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold">{clinic?.name ?? ""}</div>
        </div>
        {header}
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 pb-4 sm:px-6">{children}</main>

      {footer}

      <footer className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-2 px-4 pb-4 pt-2 text-center">
        {credit === "link" ? (
          <PoweredBy label={t.sign.poweredBy} />
        ) : (
          <span className="text-[11px] text-ink-400">{t.sign.poweredBy}</span>
        )}
        <PrivacyLink label={t.sign.privacy} as={credit === "link" ? "link" : "text"} />
      </footer>
    </div>
  );
}

/** "Step 2 of 3" plus a rail, always visible. */
export function StepIndicator({ step, locale }: { step: number; locale: Locale }) {
  const t = dictFor(locale);
  const labels = [t.sign.stepRead, t.sign.stepConfirm, t.sign.stepSign];
  return (
    <div className="mb-4">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-semibold text-ink-700">
          {t.sign.stepOf.replace("{n}", String(step)).replace("{total}", "3")}
        </span>
        <span className="text-[13px] text-ink-500">{labels[step - 1]}</span>
      </div>
      {/*
        Three separate bars rather than one filling bar: on a 3-step flow the
        segments read as "how many are left", which is the question the patient
        is actually asking.
      */}
      <div className="flex gap-1.5" role="progressbar" aria-valuenow={step} aria-valuemin={1} aria-valuemax={3}>
        {[1, 2, 3].map((n) => (
          <span
            key={n}
            className={`h-1 flex-1 rounded-full transition-colors duration-220 ${
              n <= step ? "" : "bg-line"
            }`}
            style={n <= step ? { background: "var(--bk)" } : undefined}
          />
        ))}
      </div>
    </div>
  );
}
