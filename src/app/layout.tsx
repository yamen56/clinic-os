import type { Metadata, Viewport } from "next";
import "./globals.css";
import { getDict, getLocale, dirFor } from "@/lib/i18n";
import { I18nProvider } from "@/lib/i18n/client";
import { ToastProvider } from "@/components/ui/toast";

export const metadata: Metadata = {
  title: { default: "Makan Clinic Platform", template: "%s · Makan Clinic Platform" },
  description: "The operating system for your clinic",
  applicationName: "Makan Clinic Platform",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Makan Clinic Platform",
    statusBarStyle: "default",
  },
  icons: {
    icon: "/icons/icon-192.png",
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
