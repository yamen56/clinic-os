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
  // Prevents iOS zooming the page when a form field is focused.
  maximumScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const dict = await getDict();
  return (
    <html lang={locale} dir={dirFor(locale)}>
      <body>
        <I18nProvider dict={dict} locale={locale}>
          <ToastProvider>{children}</ToastProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
