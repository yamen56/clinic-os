/**
 * The Clinicti credit that rides along on everything a patient is handed.
 *
 * Booking links, signed documents and invoices all leave the clinic and land in
 * someone else's inbox, and each one is the only place a patient ever sees the
 * software behind their clinic. This is that mark — deliberately quiet: a 12px
 * glyph and a line of grey small enough that it reads as a colophon rather than
 * an advert, but a real link, so anyone curious about it lands on clinicti.app.
 *
 * Not a client component and holds no state, so the same element works inside
 * the booking wizard, the signing chrome, the public invoice, and the pages
 * headless Chromium prints to PDF.
 */

export const CLINICTI_URL = "https://clinicti.app";
export const CLINICTI_PRIVACY_URL = "https://privacy.clinicti.app";

/**
 * The privacy notice, wherever someone is about to hand over their details.
 *
 * Separate from the credit rather than folded into it: the credit is vanity and
 * could be dropped tomorrow, this is the notice that has to be reachable from
 * every page that collects a name, a phone number or a signature. They happen
 * to share a footer, which is not the same as sharing a purpose.
 */
export function PrivacyLink({
  label,
  className = "",
  as = "link",
}: {
  label: string;
  className?: string;
  /** "text" prints the address instead of linking — for the kiosk, which offers no way out. */
  as?: "link" | "text";
}) {
  if (as === "text") {
    return (
      <span className={`text-[11px] leading-none text-ink-400 ${className}`}>
        {label} · privacy.clinicti.app
      </span>
    );
  }
  return (
    <a
      href={CLINICTI_PRIVACY_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={`text-[11px] leading-none text-ink-400 no-underline transition-colors hover:text-ink-600 ${className}`}
    >
      {label}
    </a>
  );
}

export function PoweredBy({
  label,
  showUrl = false,
  className = "",
}: {
  label: string;
  /**
   * Print surfaces spell the domain out. A link annotation survives into the
   * PDF and stays clickable on screen, but a printed sheet has no hover and no
   * cursor — on paper the address is the only thing that carries.
   */
  showUrl?: boolean;
  className?: string;
}) {
  return (
    <a
      href={CLINICTI_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1.5 text-[11px] leading-none text-ink-400 no-underline transition-colors hover:text-ink-600 ${className}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/assets/mark-light.png"
        alt=""
        width={12}
        height={12}
        /*
          The asset is a navy plate, so at this size it reads as a small dark
          square. Held at 70% so it sits with the grey text rather than becoming
          the darkest thing on an otherwise finished invoice.
        */
        className="h-3 w-3 shrink-0 rounded-[3px] opacity-70"
      />
      <span>{label}</span>
      {showUrl && <span className="text-ink-300">clinicti.app</span>}
    </a>
  );
}
