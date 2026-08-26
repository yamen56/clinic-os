import type { Metadata, Viewport } from "next";
import { appUrl } from "@/lib/urls";
import "./globals.css";
import { getDict, getLocale, dirFor } from "@/lib/i18n";
import { I18nProvider } from "@/lib/i18n/client";
import { ToastProvider } from "@/components/ui/toast";

export const metadata: Metadata = {
  /*
    Relative URLs in any child's metadata resolve against this, which is what
    makes a per-clinic canonical on a booking page come out absolute.
  */
  metadataBase: new URL(appUrl()),
  title: { default: "Clinicti", template: "%s · Clinicti" },
  description: "The operating system for your clinic",
  applicationName: "Clinicti",
  /*
    The app domain does not compete with clinicti.app.

    Nothing here is content: it is a login, and behind it a workspace. Left
    indexable, this domain would rank for the brand alongside the marketing
    site and split it — two results for one product, one of which is a sign-in
    form. So the default is noindex, and the single public surface that *is*
    worth finding (a clinic's booking page) opts back in for itself.

    Note this is the meta tag, not robots.txt, and the two are doing different
    jobs — see the comment in `robots.ts` for why /login stays crawlable.
  */
  robots: { index: false, follow: false },
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Clinicti",
    statusBarStyle: "default",
  },
  /*
    The tab gets `favicon.png`, not `icon-192`. They are the same mark on the
    same plate and differ in the one way that matters here: the favicon is drawn
    for a browser tab, which masks nothing, so it carries its own rounded
    corners. `icon-192` was standing in for it and arriving as a hard square.

    `apple-touch-icon` stays square on purpose — iOS rounds it itself and does
    not support transparency, so a radius baked in here would be double-rounded
    with black corners.
  */
  icons: {
    icon: "/icons/favicon.png",
    apple: "/icons/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  // Matches the sidebar/night surface so the status bar blends into the app
  // shell when installed to a home screen.
  themeColor: "#0b1220",
  width: "device-width",
  initialScale: 1,
  /*
    Deliberately no `maximumScale`. It was here to stop iOS zooming in when a
    form field is focused, but it buys that by disabling pinch-zoom for
    everyone, permanently — and staff read small print on phones. The zoom on
    focus is really a symptom: iOS only does it when the field's text is under
    16px, so the inputs set 16px on small screens and the browser leaves the
    page alone. Same result, without taking zoom away.
  */
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const dict = await getDict();
  return (
    <html lang={locale} dir={dirFor(locale)}>
      <body>
        {/*
          `beforeinstallprompt` fires once, during load, and is usually gone
          before React mounts. Catching it here parks it on `window` so the
          install button can still find it whenever it renders.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "window.addEventListener('beforeinstallprompt',function(e){" +
              "e.preventDefault();window.__installPrompt=e;" +
              "window.dispatchEvent(new Event('installpromptready'))});",
          }}
        />
        <I18nProvider dict={dict} locale={locale}>
          <ToastProvider>{children}</ToastProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
