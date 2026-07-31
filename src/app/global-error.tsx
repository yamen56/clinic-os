"use client";

import { useEffect, useState } from "react";

/**
 * The last resort: an error thrown by the root layout itself.
 *
 * Next.js replaces the entire document when this renders — including the
 * `<html>` element and, with it, the stylesheet the root layout imported. So
 * everything here is inline: no Tailwind class would resolve, no component
 * import is safe to rely on, and the one screen that has to survive a broken
 * layout must not depend on anything that layout provides.
 *
 * `src/app/error.tsx` handles the ordinary case and looks like the rest of the
 * app. This one only appears when that boundary could not.
 */

const COPY = {
  ar: {
    title: "تعذّر الوصول إلى النظام",
    body: "غالباً ما تكون مشكلة مؤقتة تزول خلال لحظات. جرّب مرة أخرى، وإن استمرت فأبلغ الدعم الفني.",
    retry: "إعادة المحاولة",
    ref: "الرقم المرجعي",
  },
  en: {
    title: "We can't reach the system",
    body: "This is usually brief and clears on its own. Try again, and if it keeps happening let support know.",
    retry: "Try again",
    ref: "Reference",
  },
};

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  /*
    Arabic is the default the server would have chosen, so starting there means
    the markup React renders on the server matches what it hydrates. Reading the
    cookie during render instead would differ between the two and React would
    keep the server's copy — which is how this screen ended up stuck in Arabic
    for an English clinic the first time round.
  */
  const [lang, setLang] = useState<"ar" | "en">("ar");

  useEffect(() => {
    console.error("[global error]", error.digest ?? "", error.message);
    // The document is being replaced, so the `lang` the server set is gone.
    // The locale cookie is the same thing the server reads.
    if (/(^|;\s*)cos_locale=en(;|$)/.test(document.cookie)) setLang("en");
  }, [error]);

  const t = COPY[lang];

  return (
    <html lang={lang} dir={lang === "en" ? "ltr" : "rtl"}>
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          padding: "1.5rem",
          textAlign: "center",
          background: "#f7f8fa",
          color: "#111827",
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', 'Noto Sans Arabic', Arial, sans-serif",
        }}
      >
        <h1 style={{ fontSize: "1.25rem", fontWeight: 600, margin: 0 }}>{t.title}</h1>
        <p
          style={{
            maxWidth: "28rem",
            fontSize: "0.875rem",
            lineHeight: 1.6,
            color: "#6b7280",
            margin: 0,
          }}
        >
          {t.body}
        </p>
        <button
          onClick={reset}
          style={{
            appearance: "none",
            border: 0,
            borderRadius: "0.5rem",
            background: "#1e3a6b",
            color: "#fff",
            fontSize: "0.875rem",
            fontWeight: 600,
            padding: "0.55rem 1.1rem",
            cursor: "pointer",
          }}
        >
          {t.retry}
        </button>
        {error.digest && (
          <p dir="ltr" style={{ fontSize: "0.75rem", color: "#9ca3af", margin: 0 }}>
            {t.ref}: {error.digest}
          </p>
        )}
      </body>
    </html>
  );
}
