import type { NextConfig } from "next";

/**
 * Response headers, applied to every route.
 *
 * The app had none. That is survivable for a marketing site and not for this
 * one: the workspace holds medical records, and the patient-facing links carry
 * their authorisation in the URL, so both "who may frame this" and "who may see
 * where this request came from" are security questions here rather than
 * hygiene ones.
 *
 * The CSP is deliberately origin-shaped rather than nonce-shaped. Everything
 * this app loads is its own — fonts are self-hosted, there is no analytics tag
 * and no CDN — so `'self'` is not a compromise, it is the true answer, and it
 * is what stops an injected script from reaching a collector it controls. What
 * `'self'` cannot do is stop inline script, because Next's own bootstrap is
 * inline and removing `'unsafe-inline'` would need per-request nonces threaded
 * through middleware. That is a worthwhile next step and a much riskier change
 * than this one; the layers that do not depend on it are here now.
 */
function csp(): string {
  const dev = process.env.NODE_ENV !== "production";
  return [
    "default-src 'self'",
    // 'unsafe-eval' is React Refresh's, and only in development.
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
    // Tailwind's utilities are a stylesheet, but brand colour arrives as an
    // inline `style` attribute on the workspace shell.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "media-src 'self' blob:",
    // The signing page previews the consent PDF in an <object>, and the PDF
    // comes from our own API — see components/esign/signing-flow. 'none' here
    // would take the preview out of the patient flow.
    "object-src 'self'",
    "frame-src 'self' blob:",
    // SSE, the autosave endpoints, and nothing else.
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "worker-src 'self' blob:",
    // No page here is ever meant to be embedded. Clickjacking a workspace means
    // clickjacking "delete this patient".
    "frame-ancestors 'none'",
    "base-uri 'self'",
    // Sign-in and every autosave post to our own origin. An injected form that
    // posts a session elsewhere is the cheap half of an XSS to close.
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp() },
  // Older browsers ignore frame-ancestors; this is the same instruction again.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  /*
    The signing link and the invoice link ARE the credential — `/sign/<token>`
    is enough to open somebody's consent form. The browser default already
    withholds the path cross-origin, but this says so explicitly rather than
    depending on a default, and a clinic's own domain is same-origin anyway.
  */
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  /*
    The signature pad wants a pointer, the QR screen wants nothing. Hardware
    this app never asks for should not be askable by anything injected into it.
  */
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  /*
    Two years, subdomains included. Both hosts are HTTPS-only already, so this
    costs nothing and removes the first plaintext request — the one where a
    session cookie can still be stolen on a clinic's café wifi.
  */
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /*
    Deliberately NOT `output: "standalone"`. Its dependency tracing prunes files
    the Edge middleware adapter loads dynamically, and the container crashes at
    boot with a missing `async-storage/request-store`. A full node_modules costs
    image size and nothing else.
  */
  /*
    `next dev` and `next build` both write to the dist directory, and a build
    run while the dev server is live produces chunk errors that look like
    application bugs. Set NEXT_DIST_DIR to build into a scratch directory
    instead of stopping the dev server.
  */
  distDir: process.env.NEXT_DIST_DIR || ".next",
  /*
    `pdfjs-dist` and `mammoth` are read at runtime rather than bundled. Both
    reach for files relative to their own package — pdf.js for its standard font
    data, mammoth for its XML fixtures — and a bundled copy loses that path and
    fails at the first call, not at build time.
  */
  serverExternalPackages: ["pg", "bcryptjs", "pdfjs-dist", "mammoth"],
  outputFileTracingExcludes: { "*": [".pgdata/**", "storage/**"] },
  eslint: { ignoreDuringBuilds: true },

  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      /*
        The token pages, tightened one notch further.
        `no-referrer` because the URL itself is the secret: a patient who taps
        the clinic's Google Maps link from an invoice must not hand that link's
        token to Google, and `strict-origin-when-cross-origin` would.
      */
      {
        source: "/sign/:path*",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
      { source: "/inv/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
      { source: "/reset/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
      { source: "/invite/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
    ];
  },
};

export default nextConfig;
