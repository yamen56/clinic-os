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
