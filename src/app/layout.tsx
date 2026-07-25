import type { Metadata, Viewport } from "next";
import "./globals.css";
import { getDict, getLocale, dirFor } from "@/lib/i18n";
import { I18nProvider } from "@/lib/i18n/client";
import { ToastProvider } from "@/components/ui/toast";

export const metadata: Metadata = {
  title: { default: "Clinic OS", template: "%s · Clinic OS" },
  description: "The operating system for your clinic",
  applicationName: "Clinic OS",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Clinic OS",
    statusBarStyle: "default",
  },
  icons: {
    icon: "/icons/icon-192.png",
    apple: "/icons/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#0f6e5c",
  width: "device-width",
  initialScale: 1,
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
