import { getDict } from "@/lib/i18n";
import { CloudOff } from "lucide-react";
import { RetryButton } from "./retry-button";

export default async function OfflinePage() {
  const t = await getDict();
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <CloudOff className="h-12 w-12 text-ink-300" />
      <h1 className="text-xl font-semibold">{t.notifications.offlineTitle}</h1>
      <p className="max-w-sm text-sm leading-6 text-ink-500">{t.notifications.offlineBody}</p>
      <RetryButton label={t.notifications.retry} />
    </main>
  );
}
